import type { DurableCreativeEventConstruction } from "./language-construction-memory.js";
import { clamp01, toJsonValue } from "./primitives.js";
import { segmentUnicodeSurfaceV2, type LexicalSegment } from "./unicode-segmentation-v2.js";
import type { LanguagePatternRecord } from "./storage.js";
import type { EvidenceId, Hasher, JsonValue } from "./types.js";

export const CREATIVE_REQUEST_FRAME_SCHEMA = "scce.creative_request_frame.v1" as const;
export const CREATIVE_EVENT_COMPATIBILITY_MODEL_SCHEMA =
  "scce.creative_event_compatibility_model.v1" as const;
export const CREATIVE_EVENT_COMPATIBILITY_CORPUS_SCHEMA =
  "scce.creative_event_compatibility_corpus.v1" as const;

export interface CreativeRequestSpan {
  text: string;
  charStart: number;
  charEnd: number;
  byteStart: number;
  byteEnd: number;
}

export interface CreativeRequestRole {
  id: string;
  roleId: string;
  span: CreativeRequestSpan;
}

export interface CreativeRequestFrameAnchor {
  requestFrameId: string;
  requestCompilerId: string;
  lexicalKeys: string[];
  requestRoleIds: string[];
  support: number;
  acceptedSupport: number;
  rejectedSupport: number;
  exampleTextHashes: string[];
}

/**
 * Language adapters compile request surfaces into this source-neutral frame.
 * The cognitive planner treats every ID as opaque and never interprets labels.
 */
export interface CreativeRequestFrame {
  schema: typeof CREATIVE_REQUEST_FRAME_SCHEMA;
  id: string;
  compilerId: string;
  focus: CreativeRequestRole;
  arguments: CreativeRequestRole[];
  explicitRelationId?: string;
  sourceActivationIds: string[];
}

export interface CreativeEventCompatibility {
  requestFrameId: string;
  eventRelationId: string;
  eventConstructionId?: string;
  eventArgumentFrameId?: string;
  posterior: number;
  support: number;
  sourceActivationIds: string[];
}

export interface CreativeEventRoleCompatibility {
  requestFrameId: string;
  requestRoleId: string;
  eventRoleId: "scce.role.patient" | "scce.role.complement";
  posterior: number;
  support: number;
  sourceActivationIds: string[];
}

/**
 * The posterior rows and thresholds are learned, versioned state. They may be
 * produced by any transparent estimator; runtime admission does not inspect
 * source-language words or infer missing rows.
 */
export interface CreativeEventCompatibilityModel {
  schema: typeof CREATIVE_EVENT_COMPATIBILITY_MODEL_SCHEMA;
  id: string;
  version: string;
  requestCompilerId: string;
  eventCompilerId: string;
  calibrationId: string;
  reliability: "calibrated" | "uncalibrated";
  minimumAdmissiblePosterior: number;
  minimumRolePosterior: number;
  eventCompatibilities: CreativeEventCompatibility[];
  roleCompatibilities: CreativeEventRoleCompatibility[];
  requestFrameAnchors?: CreativeRequestFrameAnchor[];
}

export interface CreativeEventCompatibilityDecision {
  modelId: string;
  modelVersion: string;
  calibrationId: string;
  posterior: number;
  threshold: number;
  sourceActivationIds: string[];
}

export interface CreativeEventCompatibilityCorpusRoleBinding {
  requestRoleId: string;
  eventRoleId: "scce.role.patient" | "scce.role.complement";
  accepted: boolean;
}

export interface CreativeEventCompatibilityCorpusExample {
  requestText: string;
  requestFrameId: string;
  requestCompilerId: string;
  eventCompilerId: string;
  eventRelationId: string;
  eventConstructionId?: string;
  eventArgumentFrameId?: string;
  partition: "train" | "calibration";
  accepted: boolean;
  roleBindings?: CreativeEventCompatibilityCorpusRoleBinding[];
}

export interface CreativeEventCompatibilityCorpus {
  schema: typeof CREATIVE_EVENT_COMPATIBILITY_CORPUS_SCHEMA;
  calibrationId: string;
  minimumAdmissiblePosterior: number;
  minimumRolePosterior: number;
  minimumTrainingSupport: number;
  minimumCalibrationSupport: number;
  examples: CreativeEventCompatibilityCorpusExample[];
}

export interface CompileCreativeEventCompatibilityCorpusInput {
  corpus: CreativeEventCompatibilityCorpus;
  profileId: string;
  evidenceIds: readonly EvidenceId[];
  updatedAt: number;
  makeId(representation: JsonValue): string;
}

export function normalizeCreativeEventCompatibilityModels(
  models: readonly CreativeEventCompatibilityModel[]
): CreativeEventCompatibilityModel[] {
  return models
    .filter(validCreativeEventCompatibilityModel)
    .map(model => ({
      ...model,
      eventCompatibilities: [...model.eventCompatibilities]
        .filter(validEventCompatibility)
        .sort((left, right) => (
          left.requestFrameId.localeCompare(right.requestFrameId)
          || left.eventRelationId.localeCompare(right.eventRelationId)
          || (left.eventConstructionId ?? "").localeCompare(right.eventConstructionId ?? "")
          || (left.eventArgumentFrameId ?? "").localeCompare(right.eventArgumentFrameId ?? "")
        )),
      roleCompatibilities: [...model.roleCompatibilities]
        .filter(validRoleCompatibility)
        .sort((left, right) => (
          left.requestFrameId.localeCompare(right.requestFrameId)
          || left.requestRoleId.localeCompare(right.requestRoleId)
          || left.eventRoleId.localeCompare(right.eventRoleId)
        )),
      requestFrameAnchors: [...(model.requestFrameAnchors ?? [])]
        .filter(validRequestFrameAnchor)
        .sort((left, right) => (
          left.requestFrameId.localeCompare(right.requestFrameId)
          || right.acceptedSupport - left.acceptedSupport
          || right.support - left.support
        ))
    }))
    .sort((left, right) => (
      left.requestCompilerId.localeCompare(right.requestCompilerId)
      || left.eventCompilerId.localeCompare(right.eventCompilerId)
      || left.id.localeCompare(right.id)
      || left.version.localeCompare(right.version)
    ));
}

export function creativeEventCompatibilityDecision(
  models: readonly CreativeEventCompatibilityModel[],
  frame: CreativeRequestFrame,
  event: DurableCreativeEventConstruction
): CreativeEventCompatibilityDecision | undefined {
  const model = models.find(candidate => (
    candidate.reliability === "calibrated"
    && candidate.requestCompilerId === frame.compilerId
    && candidate.eventCompilerId === event.compilerId
  ));
  if (!model) return undefined;
  const candidates = model.eventCompatibilities
    .filter(row => (
      (row.requestFrameId === frame.id || frame.sourceActivationIds.includes(row.requestFrameId))
      && row.eventRelationId === event.relationId
      && (!row.eventConstructionId || row.eventConstructionId === event.constructionId)
      && (!row.eventArgumentFrameId || row.eventArgumentFrameId === event.argumentFrame.id)
    ))
    .sort((left, right) => (
      compatibilitySpecificity(right) - compatibilitySpecificity(left)
      || right.posterior - left.posterior
      || right.support - left.support
    ));
  const selected = candidates[0];
  if (!selected) return undefined;
  return {
    modelId: model.id,
    modelVersion: model.version,
    calibrationId: model.calibrationId,
    posterior: selected.posterior,
    threshold: model.minimumAdmissiblePosterior,
    sourceActivationIds: [...selected.sourceActivationIds]
  };
}

export function creativeEventRolePosterior(
  models: readonly CreativeEventCompatibilityModel[],
  frame: CreativeRequestFrame,
  requestRoleId: string,
  eventRoleId: "scce.role.patient" | "scce.role.complement"
): { posterior: number; threshold: number } | undefined {
  const model = models.find(candidate => (
    candidate.reliability === "calibrated"
    && candidate.requestCompilerId === frame.compilerId
  ));
  if (!model) return undefined;
  const selected = model.roleCompatibilities
    .filter(row => (
      (row.requestFrameId === frame.id || frame.sourceActivationIds.includes(row.requestFrameId))
      && row.requestRoleId === requestRoleId
      && row.eventRoleId === eventRoleId
    ))
    .sort((left, right) => right.posterior - left.posterior || right.support - left.support)[0];
  return selected
    ? { posterior: selected.posterior, threshold: model.minimumRolePosterior }
    : undefined;
}

export function parseCreativeEventCompatibilityCorpus(
  text: string
): CreativeEventCompatibilityCorpus | undefined {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return undefined;
  }
  if (!isRecord(value)
    || value.schema !== CREATIVE_EVENT_COMPATIBILITY_CORPUS_SCHEMA
    || typeof value.calibrationId !== "string"
    || !value.calibrationId
    || !unitIntervalNumber(value.minimumAdmissiblePosterior)
    || !unitIntervalNumber(value.minimumRolePosterior)
    || !positiveSafeInteger(value.minimumTrainingSupport)
    || !positiveSafeInteger(value.minimumCalibrationSupport)
    || !Array.isArray(value.examples)) return undefined;
  const examples = value.examples
    .slice(0, 100_000)
    .flatMap(parseCompatibilityCorpusExample);
  if (!examples.length) return undefined;
  return {
    schema: CREATIVE_EVENT_COMPATIBILITY_CORPUS_SCHEMA,
    calibrationId: value.calibrationId,
    minimumAdmissiblePosterior: value.minimumAdmissiblePosterior,
    minimumRolePosterior: value.minimumRolePosterior,
    minimumTrainingSupport: value.minimumTrainingSupport,
    minimumCalibrationSupport: value.minimumCalibrationSupport,
    examples
  };
}

export function creativeEventCompatibilityCorpusLanguageText(
  corpus: CreativeEventCompatibilityCorpus
): string {
  return corpus.examples.map(example => example.requestText).join("\n");
}

export function compileCreativeEventCompatibilityCorpus(
  input: CompileCreativeEventCompatibilityCorpusInput
): { patterns: LanguagePatternRecord[]; audit: JsonValue } {
  const byCompiler = new Map<string, CreativeEventCompatibilityCorpusExample[]>();
  for (const example of input.corpus.examples) {
    const key = `${example.requestCompilerId}\u0001${example.eventCompilerId}`;
    const rows = byCompiler.get(key) ?? [];
    rows.push(example);
    byCompiler.set(key, rows);
  }
  const evidenceIds = [...new Set(input.evidenceIds.map(String))]
    .sort()
    .slice(0, 64) as EvidenceId[];
  const patterns: LanguagePatternRecord[] = [];
  for (const examples of byCompiler.values()) {
    const first = examples[0]!;
    const eventCompatibilities = compileEventRows(input.corpus, examples);
    const roleCompatibilities = compileRoleRows(input.corpus, examples);
    if (!eventCompatibilities.length) continue;
    const model: CreativeEventCompatibilityModel = {
      schema: CREATIVE_EVENT_COMPATIBILITY_MODEL_SCHEMA,
      id: "",
      version: `compatibility.${input.updatedAt}`,
      requestCompilerId: first.requestCompilerId,
      eventCompilerId: first.eventCompilerId,
      calibrationId: input.corpus.calibrationId,
      reliability: "calibrated",
      minimumAdmissiblePosterior: input.corpus.minimumAdmissiblePosterior,
      minimumRolePosterior: input.corpus.minimumRolePosterior,
      eventCompatibilities,
      roleCompatibilities,
      requestFrameAnchors: compileRequestFrameAnchors(examples, input.makeId)
    };
    const modelJson = toJsonValue({ ...model, id: undefined });
    model.id = input.makeId(modelJson);
    const patternJson = toJsonValue(model);
    patterns.push({
      id: input.makeId(patternJson),
      profileId: input.profileId,
      patternKind: "semantic_role",
      support: clamp01(
        examples.filter(example => example.partition === "calibration").length
        / Math.max(1, input.corpus.minimumCalibrationSupport * 8)
      ),
      entropy: compatibilityOutcomeEntropy(examples),
      patternJson,
      evidenceIds,
      updatedAt: input.updatedAt
    });
  }
  patterns.sort((left, right) => left.id.localeCompare(right.id));
  return {
    patterns,
    audit: toJsonValue({
      schema: "scce.creative_event_compatibility_learning_report.v1",
      corpusSchema: input.corpus.schema,
      calibrationId: input.corpus.calibrationId,
      examples: input.corpus.examples.length,
      persistedModels: patterns.length,
      evidenceIds
    })
  };
}

export function creativeEventCompatibilityModelsFromPatterns(
  patterns: readonly LanguagePatternRecord[]
): CreativeEventCompatibilityModel[] {
  const models = patterns.flatMap(pattern => {
    const value = pattern.patternJson;
    if (!isRecord(value) || value.schema !== CREATIVE_EVENT_COMPATIBILITY_MODEL_SCHEMA) return [];
    const model = compatibilityModelFromRecord(value);
    return model ? [model] : [];
  });
  return normalizeCreativeEventCompatibilityModels(models);
}

export function isCreativeEventCompatibilityPattern(pattern: LanguagePatternRecord): boolean {
  return isRecord(pattern.patternJson)
    && pattern.patternJson.schema === CREATIVE_EVENT_COMPATIBILITY_MODEL_SCHEMA;
}

export function compileCreativeRequestFrameFromCompatibilityModels(input: {
  requestText: string;
  models: readonly CreativeEventCompatibilityModel[];
  hasher: Hasher;
  minimumLexicalFit?: number;
}): CreativeRequestFrame | undefined {
  const requestText = input.requestText;
  if (!requestText.trim()) return undefined;
  const requestSegments = requestLexicalSegments(requestText);
  const requestKeys = new Set(requestSegments.map(segment => segment.normalized).filter(Boolean));
  if (!requestKeys.size) return undefined;
  const minimumLexicalFit = clamp01(input.minimumLexicalFit ?? 0.08);
  const candidates = input.models
    .filter(model => model.reliability === "calibrated")
    .flatMap(model => (model.requestFrameAnchors ?? []).map(anchor => {
      const lexicalFit = lexicalKeyFit(requestKeys, anchor.lexicalKeys);
      const posterior = maxPosteriorForRequestFrame(model, anchor.requestFrameId);
      const roleSupport = roleSupportForRequestFrame(model, anchor.requestFrameId);
      const supportFit = clamp01(Math.log2(1 + anchor.support) / 8);
      return {
        model,
        anchor,
        lexicalFit,
        posterior,
        roleSupport,
        score: clamp01(0.52 * lexicalFit + 0.34 * posterior + 0.14 * supportFit)
      };
    }))
    .filter(row => row.lexicalFit >= minimumLexicalFit && row.posterior >= row.model.minimumAdmissiblePosterior)
    .sort((left, right) => (
      right.score - left.score
      || right.lexicalFit - left.lexicalFit
      || right.posterior - left.posterior
      || right.anchor.acceptedSupport - left.anchor.acceptedSupport
      || left.anchor.requestFrameId.localeCompare(right.anchor.requestFrameId)
    ));
  const selected = candidates[0];
  if (!selected) return undefined;
  const roleIds = selected.anchor.requestRoleIds.length
    ? selected.anchor.requestRoleIds
    : [...new Set(selected.model.roleCompatibilities
      .filter(row => row.requestFrameId === selected.anchor.requestFrameId)
      .map(row => row.requestRoleId)
      .filter(Boolean))]
      .sort();
  const argumentSegments = selectArgumentSegmentsForRoles(requestSegments, roleIds);
  const frameSeed = {
    schema: CREATIVE_REQUEST_FRAME_SCHEMA,
    requestCompilerId: selected.model.requestCompilerId,
    requestFrameId: selected.anchor.requestFrameId,
    requestHash: input.hasher.digestHex(requestText),
    roleIds,
    argumentSpans: argumentSegments.map(row => ({
      roleId: row.roleId,
      textHash: input.hasher.digestHex(row.segment.surface),
      start: row.segment.codePointStart,
      end: row.segment.codePointEnd
    }))
  };
  const id = `creative.request.frame.${input.hasher.digestHex(JSON.stringify(frameSeed))}`;
  return {
    schema: CREATIVE_REQUEST_FRAME_SCHEMA,
    id,
    compilerId: selected.model.requestCompilerId,
    focus: {
      id: `${id}.focus`,
      roleId: "scce.request.role.focus",
      span: exactRequestSpan(requestText, requestText, 0, [...requestText].length)
    },
    arguments: argumentSegments.map((row, index) => ({
      id: `${id}.argument.${index}`,
      roleId: row.roleId,
      span: exactRequestSpan(
        requestText,
        row.segment.surface,
        row.segment.codePointStart,
        row.segment.codePointEnd
      )
    })),
    explicitRelationId: selected.model.eventCompatibilities
      .filter(row => row.requestFrameId === selected.anchor.requestFrameId)
      .sort((left, right) => right.posterior - left.posterior || right.support - left.support)[0]?.eventRelationId,
    sourceActivationIds: [
      selected.anchor.requestFrameId,
      ...selected.anchor.exampleTextHashes.slice(0, 8),
      ...selected.model.eventCompatibilities
        .filter(row => row.requestFrameId === selected.anchor.requestFrameId)
        .flatMap(row => row.sourceActivationIds)
        .slice(0, 16)
    ].filter((value, index, array) => Boolean(value) && array.indexOf(value) === index)
  };
}

function compileRequestFrameAnchors(
  examples: readonly CreativeEventCompatibilityCorpusExample[],
  makeId: (representation: JsonValue) => string
): CreativeRequestFrameAnchor[] {
  const byFrame = groupExamples(examples, example => example.requestFrameId);
  return [...byFrame.entries()].map(([requestFrameId, rows]) => {
    const first = rows[0]!;
    const lexicalKeys = [...new Set(rows.flatMap(row => requestLexicalKeys(row.requestText)))].sort();
    const requestRoleIds = [...new Set(rows.flatMap(row =>
      (row.roleBindings ?? [])
        .filter(binding => binding.accepted)
        .map(binding => binding.requestRoleId)
    ))].sort();
    const acceptedSupport = rows.filter(row => row.accepted).length;
    const rejectedSupport = rows.length - acceptedSupport;
    const exampleTextHashes = [...new Set(rows
      .map(row => makeId(toJsonValue({
        schema: "scce.creative_request_frame_anchor_text.v1",
        requestFrameId,
        requestText: row.requestText
      })))
      .filter(Boolean))]
      .sort()
      .slice(0, 16);
    return {
      requestFrameId,
      requestCompilerId: first.requestCompilerId,
      lexicalKeys,
      requestRoleIds,
      support: rows.length,
      acceptedSupport,
      rejectedSupport,
      exampleTextHashes
    };
  })
    .filter(validRequestFrameAnchor)
    .sort((left, right) => (
      right.acceptedSupport - left.acceptedSupport
      || right.support - left.support
      || left.requestFrameId.localeCompare(right.requestFrameId)
    ));
}

function requestLexicalSegments(text: string): LexicalSegment[] {
  return segmentUnicodeSurfaceV2(text).lexicalSegments
    .filter(segment => segment.normalized && segment.surface.trim());
}

function requestLexicalKeys(text: string): string[] {
  return [...new Set(requestLexicalSegments(text)
    .map(segment => segment.normalized)
    .filter(Boolean))]
    .sort();
}

function lexicalKeyFit(requestKeys: ReadonlySet<string>, anchorKeys: readonly string[]): number {
  const anchor = new Set(anchorKeys.filter(Boolean));
  if (!requestKeys.size || !anchor.size) return 0;
  let intersection = 0;
  for (const key of requestKeys) if (anchor.has(key)) intersection++;
  return clamp01(intersection / Math.sqrt(requestKeys.size * anchor.size));
}

function maxPosteriorForRequestFrame(
  model: CreativeEventCompatibilityModel,
  requestFrameId: string
): number {
  return Math.max(0, ...model.eventCompatibilities
    .filter(row => row.requestFrameId === requestFrameId)
    .map(row => row.posterior));
}

function roleSupportForRequestFrame(
  model: CreativeEventCompatibilityModel,
  requestFrameId: string
): number {
  return model.roleCompatibilities
    .filter(row => row.requestFrameId === requestFrameId)
    .reduce((sum, row) => sum + row.support, 0);
}

function selectArgumentSegmentsForRoles(
  segments: readonly LexicalSegment[],
  roleIds: readonly string[]
): Array<{ roleId: string; segment: LexicalSegment }> {
  if (!roleIds.length) return [];
  const usable = [...segments]
    .filter(segment => segment.surface.trim() && segment.normalized)
    .sort((left, right) => (
      right.normalized.length - left.normalized.length
      || right.surface.length - left.surface.length
      || right.codePointStart - left.codePointStart
    ));
  const selected: Array<{ roleId: string; segment: LexicalSegment }> = [];
  const used = new Set<string>();
  for (const roleId of roleIds.slice(0, 8)) {
    const segment = usable.find(candidate => {
      const key = `${candidate.codePointStart}:${candidate.codePointEnd}`;
      return !used.has(key);
    });
    if (!segment) break;
    used.add(`${segment.codePointStart}:${segment.codePointEnd}`);
    selected.push({ roleId, segment });
  }
  return selected.sort((left, right) => left.segment.codePointStart - right.segment.codePointStart);
}

function exactRequestSpan(
  requestText: string,
  text: string,
  charStart: number,
  charEnd: number
): CreativeRequestSpan {
  const points = [...requestText];
  const prefix = points.slice(0, charStart).join("");
  const surface = points.slice(charStart, charEnd).join("");
  const spanText = surface === text ? text : surface;
  const encoder = new TextEncoder();
  return {
    text: spanText,
    charStart,
    charEnd,
    byteStart: encoder.encode(prefix).byteLength,
    byteEnd: encoder.encode(prefix + spanText).byteLength
  };
}

function compileEventRows(
  corpus: CreativeEventCompatibilityCorpus,
  examples: readonly CreativeEventCompatibilityCorpusExample[]
): CreativeEventCompatibility[] {
  const groups = groupExamples(examples, example => [
    example.requestFrameId,
    example.eventRelationId,
    example.eventConstructionId ?? "",
    example.eventArgumentFrameId ?? ""
  ].join("\u0001"));
  return [...groups.values()].flatMap(rows => {
    const training = rows.filter(row => row.partition === "train");
    const calibration = rows.filter(row => row.partition === "calibration");
    if (training.length < corpus.minimumTrainingSupport
      || calibration.length < corpus.minimumCalibrationSupport) return [];
    const first = rows[0]!;
    return [{
      requestFrameId: first.requestFrameId,
      eventRelationId: first.eventRelationId,
      ...(first.eventConstructionId ? { eventConstructionId: first.eventConstructionId } : {}),
      ...(first.eventArgumentFrameId ? { eventArgumentFrameId: first.eventArgumentFrameId } : {}),
      posterior: calibration.filter(row => row.accepted).length / calibration.length,
      support: training.length + calibration.length,
      sourceActivationIds: [first.requestFrameId]
    }];
  }).sort((left, right) => (
    left.requestFrameId.localeCompare(right.requestFrameId)
    || left.eventRelationId.localeCompare(right.eventRelationId)
  ));
}

function compileRoleRows(
  corpus: CreativeEventCompatibilityCorpus,
  examples: readonly CreativeEventCompatibilityCorpusExample[]
): CreativeEventRoleCompatibility[] {
  const observations = examples.flatMap(example => (
    (example.roleBindings ?? []).map(binding => ({ example, binding }))
  ));
  const groups = new Map<string, typeof observations>();
  for (const observation of observations) {
    const key = [
      observation.example.requestFrameId,
      observation.binding.requestRoleId,
      observation.binding.eventRoleId
    ].join("\u0001");
    const rows = groups.get(key) ?? [];
    rows.push(observation);
    groups.set(key, rows);
  }
  return [...groups.values()].flatMap(rows => {
    const training = rows.filter(row => row.example.partition === "train");
    const calibration = rows.filter(row => row.example.partition === "calibration");
    if (training.length < corpus.minimumTrainingSupport
      || calibration.length < corpus.minimumCalibrationSupport) return [];
    const first = rows[0]!;
    return [{
      requestFrameId: first.example.requestFrameId,
      requestRoleId: first.binding.requestRoleId,
      eventRoleId: first.binding.eventRoleId,
      posterior: calibration.filter(row => row.binding.accepted).length / calibration.length,
      support: training.length + calibration.length,
      sourceActivationIds: [first.example.requestFrameId]
    }];
  });
}

function groupExamples(
  examples: readonly CreativeEventCompatibilityCorpusExample[],
  keyFor: (example: CreativeEventCompatibilityCorpusExample) => string
): Map<string, CreativeEventCompatibilityCorpusExample[]> {
  const groups = new Map<string, CreativeEventCompatibilityCorpusExample[]>();
  for (const example of examples) {
    const key = keyFor(example);
    const rows = groups.get(key) ?? [];
    rows.push(example);
    groups.set(key, rows);
  }
  return groups;
}

function compatibilityOutcomeEntropy(
  examples: readonly CreativeEventCompatibilityCorpusExample[]
): number {
  const accepted = examples.filter(example => example.accepted).length;
  const rejected = examples.length - accepted;
  if (!accepted || !rejected) return 0;
  const positive = accepted / examples.length;
  const negative = rejected / examples.length;
  return -positive * Math.log2(positive) - negative * Math.log2(negative);
}

function compatibilityModelFromRecord(
  value: Record<string, unknown>
): CreativeEventCompatibilityModel | undefined {
  const eventCompatibilities = Array.isArray(value.eventCompatibilities)
    ? value.eventCompatibilities.flatMap(eventCompatibilityFromUnknown)
    : [];
  const roleCompatibilities = Array.isArray(value.roleCompatibilities)
    ? value.roleCompatibilities.flatMap(roleCompatibilityFromUnknown)
    : [];
  const requestFrameAnchors = Array.isArray(value.requestFrameAnchors)
    ? value.requestFrameAnchors.flatMap(requestFrameAnchorFromUnknown)
    : [];
  const model: CreativeEventCompatibilityModel = {
    schema: CREATIVE_EVENT_COMPATIBILITY_MODEL_SCHEMA,
    id: stringValue(value.id),
    version: stringValue(value.version),
    requestCompilerId: stringValue(value.requestCompilerId),
    eventCompilerId: stringValue(value.eventCompilerId),
    calibrationId: stringValue(value.calibrationId),
    reliability: value.reliability === "calibrated" ? "calibrated" : "uncalibrated",
    minimumAdmissiblePosterior: numberValue(value.minimumAdmissiblePosterior),
    minimumRolePosterior: numberValue(value.minimumRolePosterior),
    eventCompatibilities,
    roleCompatibilities,
    ...(requestFrameAnchors.length ? { requestFrameAnchors } : {})
  };
  return validCreativeEventCompatibilityModel(model) ? model : undefined;
}

function eventCompatibilityFromUnknown(value: unknown): CreativeEventCompatibility[] {
  if (!isRecord(value)) return [];
  const row: CreativeEventCompatibility = {
    requestFrameId: stringValue(value.requestFrameId),
    eventRelationId: stringValue(value.eventRelationId),
    ...(stringValue(value.eventConstructionId)
      ? { eventConstructionId: stringValue(value.eventConstructionId) }
      : {}),
    ...(stringValue(value.eventArgumentFrameId)
      ? { eventArgumentFrameId: stringValue(value.eventArgumentFrameId) }
      : {}),
    posterior: numberValue(value.posterior),
    support: numberValue(value.support),
    sourceActivationIds: stringArray(value.sourceActivationIds)
  };
  return validEventCompatibility(row) ? [row] : [];
}

function roleCompatibilityFromUnknown(value: unknown): CreativeEventRoleCompatibility[] {
  if (!isRecord(value)) return [];
  const eventRoleId = value.eventRoleId;
  if (eventRoleId !== "scce.role.patient" && eventRoleId !== "scce.role.complement") return [];
  const row: CreativeEventRoleCompatibility = {
    requestFrameId: stringValue(value.requestFrameId),
    requestRoleId: stringValue(value.requestRoleId),
    eventRoleId,
    posterior: numberValue(value.posterior),
    support: numberValue(value.support),
    sourceActivationIds: stringArray(value.sourceActivationIds)
  };
  return validRoleCompatibility(row) ? [row] : [];
}

function requestFrameAnchorFromUnknown(value: unknown): CreativeRequestFrameAnchor[] {
  if (!isRecord(value)) return [];
  const row: CreativeRequestFrameAnchor = {
    requestFrameId: stringValue(value.requestFrameId),
    requestCompilerId: stringValue(value.requestCompilerId),
    lexicalKeys: stringArray(value.lexicalKeys).sort(),
    requestRoleIds: stringArray(value.requestRoleIds).sort(),
    support: numberValue(value.support),
    acceptedSupport: numberValue(value.acceptedSupport),
    rejectedSupport: numberValue(value.rejectedSupport),
    exampleTextHashes: stringArray(value.exampleTextHashes).slice(0, 16)
  };
  return validRequestFrameAnchor(row) ? [row] : [];
}

function parseCompatibilityCorpusExample(
  value: unknown
): CreativeEventCompatibilityCorpusExample[] {
  if (!isRecord(value)
    || typeof value.requestText !== "string"
    || !value.requestText.trim()
    || !stringValue(value.requestFrameId)
    || !stringValue(value.requestCompilerId)
    || !stringValue(value.eventCompilerId)
    || !stringValue(value.eventRelationId)
    || (value.partition !== "train" && value.partition !== "calibration")
    || typeof value.accepted !== "boolean") return [];
  const roleBindings = Array.isArray(value.roleBindings)
    ? value.roleBindings.flatMap(roleBindingFromUnknown)
    : [];
  return [{
    requestText: value.requestText,
    requestFrameId: stringValue(value.requestFrameId),
    requestCompilerId: stringValue(value.requestCompilerId),
    eventCompilerId: stringValue(value.eventCompilerId),
    eventRelationId: stringValue(value.eventRelationId),
    ...(stringValue(value.eventConstructionId)
      ? { eventConstructionId: stringValue(value.eventConstructionId) }
      : {}),
    ...(stringValue(value.eventArgumentFrameId)
      ? { eventArgumentFrameId: stringValue(value.eventArgumentFrameId) }
      : {}),
    partition: value.partition,
    accepted: value.accepted,
    ...(roleBindings.length ? { roleBindings } : {})
  }];
}

function roleBindingFromUnknown(value: unknown): CreativeEventCompatibilityCorpusRoleBinding[] {
  if (!isRecord(value)
    || !stringValue(value.requestRoleId)
    || (value.eventRoleId !== "scce.role.patient" && value.eventRoleId !== "scce.role.complement")
    || typeof value.accepted !== "boolean") return [];
  return [{
    requestRoleId: stringValue(value.requestRoleId),
    eventRoleId: value.eventRoleId,
    accepted: value.accepted
  }];
}

function compatibilitySpecificity(row: CreativeEventCompatibility): number {
  return Number(Boolean(row.eventConstructionId)) + Number(Boolean(row.eventArgumentFrameId));
}

function validCreativeEventCompatibilityModel(
  model: CreativeEventCompatibilityModel
): boolean {
  return model.schema === CREATIVE_EVENT_COMPATIBILITY_MODEL_SCHEMA
    && Boolean(
      model.id
      && model.version
      && model.requestCompilerId
      && model.eventCompilerId
      && model.calibrationId
    )
    && (model.reliability === "calibrated" || model.reliability === "uncalibrated")
    && unitInterval(model.minimumAdmissiblePosterior)
    && unitInterval(model.minimumRolePosterior)
    && Array.isArray(model.eventCompatibilities)
    && Array.isArray(model.roleCompatibilities);
}

function validRequestFrameAnchor(row: CreativeRequestFrameAnchor): boolean {
  return Boolean(row.requestFrameId && row.requestCompilerId)
    && Array.isArray(row.lexicalKeys)
    && row.lexicalKeys.length > 0
    && row.lexicalKeys.every(key => typeof key === "string" && Boolean(key))
    && Array.isArray(row.requestRoleIds)
    && row.requestRoleIds.every(id => typeof id === "string" && Boolean(id))
    && Number.isSafeInteger(row.support)
    && row.support > 0
    && Number.isSafeInteger(row.acceptedSupport)
    && row.acceptedSupport >= 0
    && Number.isSafeInteger(row.rejectedSupport)
    && row.rejectedSupport >= 0
    && row.acceptedSupport + row.rejectedSupport === row.support
    && Array.isArray(row.exampleTextHashes);
}

function validEventCompatibility(row: CreativeEventCompatibility): boolean {
  return Boolean(row.requestFrameId && row.eventRelationId)
    && unitInterval(row.posterior)
    && Number.isSafeInteger(row.support)
    && row.support > 0
    && Array.isArray(row.sourceActivationIds);
}

function validRoleCompatibility(row: CreativeEventRoleCompatibility): boolean {
  return Boolean(row.requestFrameId && row.requestRoleId)
    && (row.eventRoleId === "scce.role.patient" || row.eventRoleId === "scce.role.complement")
    && unitInterval(row.posterior)
    && Number.isSafeInteger(row.support)
    && row.support > 0
    && Array.isArray(row.sourceActivationIds);
}

function unitInterval(value: number): boolean {
  return Number.isFinite(value) && value >= 0 && value <= 1;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function stringValue(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function numberValue(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : Number.NaN;
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? [...new Set(value.filter((item): item is string => typeof item === "string" && Boolean(item)))]
    : [];
}

function unitIntervalNumber(value: unknown): value is number {
  return typeof value === "number" && unitInterval(value);
}

function positiveSafeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}