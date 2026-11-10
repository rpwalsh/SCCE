// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
import type { DurableCreativeEventConstruction } from "./language-construction-memory.js";
import { canonicalStringify, clamp01, toJsonValue } from "./primitives.js";
import { segmentUnicodeSurfaceV2, type LexicalSegment } from "./unicode-segmentation-v2.js";
import type { LanguagePatternRecord } from "./storage.js";
import { CREATIVE_SOURCE_UTTERANCE_RECIPE_ID, CREATIVE_SOURCE_REFERENCE_UTTERANCE_RECIPE_ID, CREATIVE_SOURCE_SURFACE_ACQUISITION_RECIPE_ID } from "./language-training-recipe.js";
import type { OwnedSourceReferenceBindings } from "./source-reference-bindings.js";
import type { EvidenceId, Hasher, JsonValue } from "./types.js";
import { induceLearnedConstructions, type AlignedSurfaceExample, type LearnedConstruction } from "./language-construction.js";
import { createLearnedSurfaceInterpreter, type LearnedSurfaceInterpreter, type InterpretedSurfaceRole } from "./learned-surface-interpretation.js";
import { CREATIVE_SOURCE_CORRESPONDENCE_RECIPE, createCreativeSourceCorrespondenceVerifier, type CreativeSurfaceRoleBinding, type CreativeSourceCorrespondence, type CreativeSourceCorrespondenceContext, type CreativeSourceCorrespondenceVerifier } from "./creative-source-correspondence.js";

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
  /** Retained source declaration, never an authority inferred from observing a reply. */
  sourceAuthority?: "creative" | "unknown";
  requestFrameId: string;
  requestCompilerId: string;
  lexicalKeys: string[];
  requestRoleIds: string[];
  support: number;
  acceptedSupport: number;
  rejectedSupport: number;
  observedSupport?: number;
  exampleTextHashes: string[];
  requestRoleExamples?: AlignedSurfaceExample[];
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

interface SourceObservedRequestAuthority {
  authority: "creative";
  qualification: "source_observed";
  modelId: string;
  requestFrameId: string;
  sourceActivationIds: readonly string[];
}

const observedRequestAuthorities = new WeakMap<CreativeRequestFrame, { observation: SourceObservedRequestAuthority; frameMaterial: string }>();

/** Only the source-verified request compiler can supply an observed authority. */
export function sourceObservedRequestAuthority(frame: CreativeRequestFrame | undefined): SourceObservedRequestAuthority | undefined {
  const owned = frame ? observedRequestAuthorities.get(frame) : undefined;
  return owned && canonicalStringify(frame) === owned.frameMaterial ? owned.observation : undefined;
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
interface CreativeEventCompatibilityModelIdentity {
  schema: typeof CREATIVE_EVENT_COMPATIBILITY_MODEL_SCHEMA;
  id: string;
  version: string;
  requestCompilerId: string;
  eventCompilerId: string;
  eventCompatibilities: CreativeEventCompatibility[];
  roleCompatibilities: CreativeEventRoleCompatibility[];
  requestFrameAnchors?: CreativeRequestFrameAnchor[];
}

export type CreativeEventCompatibilityModel = CreativeEventCompatibilityModelIdentity & ({
  reliability: "calibrated" | "uncalibrated";
  calibrationId: string;
  minimumAdmissiblePosterior: number;
  minimumRolePosterior: number;
  sourceObservations?: never;
} | {
  reliability: "source_observed";
  sourceObservations: CreativeSourceCorrespondence[];
  sourceReferencePatternIds?: readonly string[];
  sourceReferenceBindings?: readonly OwnedSourceReferenceBindings[];
  surfaceBindingRecipe?: typeof CREATIVE_SOURCE_SURFACE_ACQUISITION_RECIPE_ID;
  sourceSurfaceBindings?: ReadonlyMap<string, readonly CreativeSurfaceRoleBinding[]>;
  calibrationId?: never;
  minimumAdmissiblePosterior?: never;
  minimumRolePosterior?: never;
});

interface CreativeCompatibilityIdentity {
  modelId: string;
  modelVersion: string;
  sourceActivationIds: string[];
}
export type CreativeEventCompatibilityDecision = CreativeCompatibilityIdentity & ({
  qualification?: "calibrated";
  calibrationId: string;
  posterior: number;
  threshold: number;
} | { qualification: "source_observed"; observationIds: string[]; support: number });

export type CreativeRoleCompatibilityDecision = { posterior: number; threshold: number; qualification?: "calibrated" }
  | { qualification: "source_observed"; observationIds: string[]; support: number };

export interface CreativeEventCompatibilityCorpusRoleBinding {
  requestRoleId: string;
  eventRoleId: "scce.role.patient" | "scce.role.complement";
  accepted: boolean;
  requestSpan?: { charStart: number; charEnd: number };
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

const verifiedObservedModels = new WeakSet<CreativeEventCompatibilityModel>();

export function normalizeCreativeEventCompatibilityModels(
  models: readonly CreativeEventCompatibilityModel[]
): CreativeEventCompatibilityModel[] {
  return models
    .filter(validCreativeEventCompatibilityModel)
    .map(model => {
      const normalized: CreativeEventCompatibilityModel = {
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
      };
      if (verifiedObservedModels.has(model)) verifiedObservedModels.add(normalized);
      return normalized;
    })
    .sort((left, right) => (
      left.requestCompilerId.localeCompare(right.requestCompilerId)
      || left.eventCompilerId.localeCompare(right.eventCompilerId)
      || left.id.localeCompare(right.id)
      || left.version.localeCompare(right.version)
    ));
}

export function scopeCreativeEventCompatibilityModels(models: readonly CreativeEventCompatibilityModel[], eventIds: ReadonlySet<string>): CreativeEventCompatibilityModel[] {
  return normalizeCreativeEventCompatibilityModels(models.flatMap<CreativeEventCompatibilityModel>(model => {
    if (model.reliability !== "source_observed") return [model];
    const sourceObservations = model.sourceObservations?.filter(row => eventIds.has(row.eventId)) ?? [];
    const scoped = { ...model, sourceObservations, requestFrameAnchors: model.requestFrameAnchors?.filter(anchor => sourceAnchorOwned(anchor, sourceObservations)) };
    if (verifiedObservedModels.has(model)) verifiedObservedModels.add(scoped);
    return [scoped];
  }));
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
  if (!model) {
    const observed = models.find(candidate => candidate.reliability === "source_observed" && verifiedObservedModels.has(candidate)
      && candidate.requestCompilerId === frame.compilerId && candidate.eventCompilerId === event.compilerId
      && (candidate.sourceObservations ?? []).some(row => observedFrameMatches(frame, row) && row.eventId === event.id));
    const rows = observed?.sourceObservations?.filter(row => observedFrameMatches(frame, row) && row.eventId === event.id) ?? [];
    return observed && rows.length ? { modelId: observed.id, modelVersion: observed.version, qualification: "source_observed",
      observationIds: rows.map(row => row.id), support: rows.length, sourceActivationIds: [...new Set(rows.map(row => row.requestFrameId))] } : undefined;
  }
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
    calibrationId: model.calibrationId!,
    posterior: selected.posterior,
    threshold: model.minimumAdmissiblePosterior!,
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
    ? { posterior: selected.posterior, threshold: model.minimumRolePosterior! }
    : undefined;
}

export function creativeEventRoleDecision(models: readonly CreativeEventCompatibilityModel[], frame: CreativeRequestFrame,
  requestRoleId: string, eventRoleId: "scce.role.patient" | "scce.role.complement", event: DurableCreativeEventConstruction): CreativeRoleCompatibilityDecision | undefined {
  if (models.some(model => model.reliability === "calibrated" && model.requestCompilerId === frame.compilerId)) {
    return creativeEventRolePosterior(models, frame, requestRoleId, eventRoleId);
  }
  const rows = models.filter(model => model.reliability === "source_observed" && verifiedObservedModels.has(model) && model.requestCompilerId === frame.compilerId && model.eventCompilerId === event.compilerId)
    .flatMap(model => model.sourceObservations ?? []).filter(row => observedFrameMatches(frame, row) && row.eventId === event.id
      && row.bindings.some(binding => binding.requestRoleId === requestRoleId && binding.eventRoleId === eventRoleId));
  return rows.length ? { qualification: "source_observed", observationIds: rows.map(row => row.id), support: rows.length } : undefined;
}

function observedFrameMatches(frame: CreativeRequestFrame, row: CreativeSourceCorrespondence): boolean {
  return row.requestFrameId === frame.id || frame.sourceActivationIds.includes(row.requestFrameId);
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
      requestFrameAnchors: compileRequestFrameAnchors(examples, input.evidenceIds, input.makeId)
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
  patterns: readonly LanguagePatternRecord[], context?: CreativeSourceCorrespondenceContext
): CreativeEventCompatibilityModel[] {
  let sourceVerification: CreativeSourceCorrespondenceVerifier | undefined;
  const models = patterns.flatMap(pattern => {
    const value = pattern.patternJson;
    if (!isRecord(value) || value.schema !== CREATIVE_EVENT_COMPATIBILITY_MODEL_SCHEMA) return [];
    if (value.reliability === "source_observed" && context) sourceVerification ??= createCreativeSourceCorrespondenceVerifier(context);
    const model = compatibilityModelFromRecord(value, pattern.evidenceIds, context, sourceVerification);
    if (model?.reliability === "source_observed" && pattern.id !== model.id) return [];
    if (model?.reliability === "source_observed" && model.sourceObservations?.some(row => !sourceVerification?.eventHasProfile(row.eventId, pattern.profileId))) return [];
    if (model?.reliability === "source_observed" && model.sourceReferenceBindings?.some(reference => reference.profileId !== pattern.profileId)) return [];
    return model ? [model] : [];
  });
  return normalizeCreativeEventCompatibilityModels(models);
}

export function isCreativeEventCompatibilityPattern(pattern: LanguagePatternRecord): boolean {
  return isRecord(pattern.patternJson)
    && pattern.patternJson.schema === CREATIVE_EVENT_COMPATIBILITY_MODEL_SCHEMA;
}

/** Template matches select source records to read; only normal source hydration can license their meaning. */
export function creativeRequestSourcePrerequisites(input: {
  requestText: string; patterns: readonly LanguagePatternRecord[]; hasher: Hasher;
}): Array<{ modelPattern: LanguagePatternRecord; profileId: string; patternIds: string[] }> {
  const interpreter = createLearnedSurfaceInterpreter(input.requestText, true);
  return input.patterns.flatMap(pattern => {
    const value = pattern.patternJson;
    if (!isRecord(value) || value.schema !== CREATIVE_EVENT_COMPATIBILITY_MODEL_SCHEMA || value.reliability !== "source_observed") return [];
    const prerequisites = value.sourceUtterancePrerequisites;
    if (!isRecord(prerequisites) || ![CREATIVE_SOURCE_UTTERANCE_RECIPE_ID, CREATIVE_SOURCE_REFERENCE_UTTERANCE_RECIPE_ID, CREATIVE_SOURCE_SURFACE_ACQUISITION_RECIPE_ID].includes(prerequisites.recipe as typeof CREATIVE_SOURCE_UTTERANCE_RECIPE_ID)
      || !Array.isArray(prerequisites.requests)) return [];
    const anchors = Array.isArray(value.requestFrameAnchors) ? value.requestFrameAnchors.flatMap(anchor => requestFrameAnchorFromUnknown(anchor, pattern.evidenceIds)) : [];
    const matching = new Set(anchors.filter(anchor => interpretedRequestRoles(anchor, interpreter, input.hasher)).map(anchor => anchor.requestFrameId));
    const patternIds = [...new Set(prerequisites.requests.flatMap(request => isRecord(request) && matching.has(stringValue(request.requestFrameId))
      ? stringArray(request.patternIds) : []))].sort();
    return patternIds.length ? [{ modelPattern: pattern, profileId: pattern.profileId, patternIds }] : [];
  });
}

export function compileCreativeRequestFrameFromCompatibilityModels(input: {
  requestText: string;
  models: readonly CreativeEventCompatibilityModel[];
  hasher: Hasher;
}): CreativeRequestFrame | undefined {
  const requestText = input.requestText;
  if (!requestText.trim() || !input.models.length) return undefined;
  const interpreter = createLearnedSurfaceInterpreter(requestText, true);
  const candidates = input.models
    .filter(model => model.reliability === "calibrated" || (model.reliability === "source_observed" && verifiedObservedModels.has(model) && model.sourceObservations?.length))
    .flatMap(model => (model.requestFrameAnchors ?? []).flatMap(anchor => {
      const posterior = maxPosteriorForRequestFrame(model, anchor.requestFrameId);
      if (model.reliability === "calibrated" && posterior < model.minimumAdmissiblePosterior!) return [];
      const roles = interpretedRequestRoles(anchor, interpreter, input.hasher);
      if (!roles) return [];
      const allowedRoles = new Set(model.reliability === "source_observed"
        ? model.sourceObservations?.filter(row => row.requestFrameId === anchor.requestFrameId).flatMap(row => row.bindings.map(binding => binding.requestRoleId))
        : model.roleCompatibilities.filter(row => row.requestFrameId === anchor.requestFrameId && row.posterior >= model.minimumRolePosterior!).map(row => row.requestRoleId));
      if (roles.some(role => !allowedRoles.has(role.roleId))) return [];
      return [{ model, anchor, posterior, roles }];
    }))
    .sort((left, right) => (
      Number(right.model.reliability === "calibrated") - Number(left.model.reliability === "calibrated")
      || right.posterior - left.posterior
      || right.anchor.acceptedSupport - left.anchor.acceptedSupport
      || left.anchor.requestFrameId.localeCompare(right.anchor.requestFrameId)
    ));
  const selected = candidates[0];
  if (!selected) return undefined;
  const roleIds = selected.roles.map(role => role.roleId);
  const frameSeed = {
    schema: CREATIVE_REQUEST_FRAME_SCHEMA,
    requestCompilerId: selected.model.requestCompilerId,
    requestFrameId: selected.anchor.requestFrameId,
    requestHash: input.hasher.digestHex(requestText),
    roleIds,
    argumentSpans: selected.roles.map(row => ({
      roleId: row.roleId,
      textHash: input.hasher.digestHex(row.surface),
      start: row.startCodePoint,
      end: row.endCodePoint
    }))
  };
  const id = `creative.request.frame.${input.hasher.digestHex(JSON.stringify(frameSeed))}`;
  const frame: CreativeRequestFrame = {
    schema: CREATIVE_REQUEST_FRAME_SCHEMA,
    id,
    compilerId: selected.model.requestCompilerId,
    focus: {
      id: `${id}.focus`,
      roleId: "scce.request.role.focus",
      span: exactRequestSpan(requestText, requestText, 0, [...requestText].length)
    },
    arguments: selected.roles.map((row, index) => ({
      id: `${id}.argument.${index}`,
      roleId: row.roleId,
      span: exactRequestSpan(
        requestText,
        row.surface,
        row.startCodePoint,
        row.endCodePoint
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
  if (selected.model.reliability === "source_observed" && selected.anchor.sourceAuthority === "creative") observedRequestAuthorities.set(frame, {
    frameMaterial: canonicalStringify(frame), observation: Object.freeze({
      authority: "creative", qualification: "source_observed", modelId: selected.model.id,
      requestFrameId: selected.anchor.requestFrameId, sourceActivationIds: Object.freeze([...frame.sourceActivationIds])
    })
  });
  return frame;
}

function compileRequestFrameAnchors(
  examples: readonly CreativeEventCompatibilityCorpusExample[],
  evidenceIds: readonly EvidenceId[],
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
    const requestRoleExamples = compileRequestRoleExamples(rows, evidenceIds, makeId);
    return {
      requestFrameId,
      requestCompilerId: first.requestCompilerId,
      lexicalKeys,
      requestRoleIds,
      support: rows.length,
      acceptedSupport,
      rejectedSupport,
      exampleTextHashes,
      ...(requestRoleExamples.length ? { requestRoleExamples } : {})
    };
  })
    .filter(validRequestFrameAnchor)
    .sort((left, right) => (
      right.acceptedSupport - left.acceptedSupport
      || right.support - left.support
      || left.requestFrameId.localeCompare(right.requestFrameId)
    ));
}

function compileRequestRoleExamples(
  rows: readonly CreativeEventCompatibilityCorpusExample[],
  evidenceIds: readonly EvidenceId[],
  makeId: (representation: JsonValue) => string
): AlignedSurfaceExample[] {
  if (!evidenceIds.length) return [];
  const examples = new Map<string, AlignedSurfaceExample>();
  for (const row of rows) {
    if (!row.accepted || row.requestText !== row.requestText.normalize("NFC")) continue;
    const points = [...row.requestText];
    const bindings = (row.roleBindings ?? []).filter(binding => binding.accepted);
    if (bindings.some(binding => !validRoleRange(binding.requestSpan, points.length))) continue;
    const roleSpans = bindings.map(binding => ({
      roleId: binding.requestRoleId, occurrenceId: binding.requestRoleId,
      start: binding.requestSpan!.charStart, end: binding.requestSpan!.charEnd,
      surface: points.slice(binding.requestSpan!.charStart, binding.requestSpan!.charEnd).join(""),
      evidenceIds: [...evidenceIds]
    }));
    const id = makeId(toJsonValue({ schema: "scce.creative_request_role_example.v1", requestFrameId: row.requestFrameId,
      surface: row.requestText, roleSpans }));
    examples.set(id, { id, profileKey: row.requestCompilerId, surface: row.requestText, evidenceIds: [...evidenceIds], roleSpans });
  }
  return [...examples.values()];
}

const requestConstructionMemo = new WeakMap<CreativeRequestFrameAnchor, readonly LearnedConstruction[]>();

function interpretedRequestRoles(anchor: CreativeRequestFrameAnchor, interpreter: LearnedSurfaceInterpreter, hasher: Hasher): InterpretedSurfaceRole[] | undefined {
  let constructions = requestConstructionMemo.get(anchor);
  if (!constructions) {
    constructions = induceLearnedConstructions({ examples: anchor.requestRoleExamples ?? [], hasher }).constructions;
    requestConstructionMemo.set(anchor, constructions);
  }
  const interpretations = new Map<string, InterpretedSurfaceRole[]>();
  for (const construction of constructions) {
    const roles = interpreter.interpret(construction);
    if (!roles || roles.some(role => !role.surface.trim())
      || !anchor.requestRoleIds.every(id => roles.filter(role => role.roleId === id).length === 1)) continue;
    const key = JSON.stringify(roles.map(role => [role.roleId, role.startCodePoint, role.endCodePoint]));
    interpretations.set(key, roles);
  }
  return interpretations.size === 1 ? interpretations.values().next().value : undefined;
}

function validRoleRange(value: { charStart: number; charEnd: number } | undefined, length: number): boolean {
  return value !== undefined && Number.isSafeInteger(value.charStart) && Number.isSafeInteger(value.charEnd)
    && value.charStart >= 0 && value.charEnd > value.charStart && value.charEnd <= length;
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

function maxPosteriorForRequestFrame(
  model: CreativeEventCompatibilityModel,
  requestFrameId: string
): number {
  return Math.max(0, ...model.eventCompatibilities
    .filter(row => row.requestFrameId === requestFrameId)
    .map(row => row.posterior));
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
  value: Record<string, unknown>, evidenceIds: readonly EvidenceId[], context?: CreativeSourceCorrespondenceContext, sourceVerification?: CreativeSourceCorrespondenceVerifier
): CreativeEventCompatibilityModel | undefined {
  const eventCompatibilities = Array.isArray(value.eventCompatibilities)
    ? value.eventCompatibilities.flatMap(eventCompatibilityFromUnknown)
    : [];
  const roleCompatibilities = Array.isArray(value.roleCompatibilities)
    ? value.roleCompatibilities.flatMap(roleCompatibilityFromUnknown)
    : [];
  let requestFrameAnchors = Array.isArray(value.requestFrameAnchors)
    ? value.requestFrameAnchors.flatMap(anchor => requestFrameAnchorFromUnknown(anchor, evidenceIds))
    : [];
  const sourceObserved = value.reliability === "source_observed";
  if (!sourceObserved && value.sourceObservations !== undefined) return undefined;
  if (sourceObserved && (!context || value.version !== CREATIVE_SOURCE_CORRESPONDENCE_RECIPE || value.requestCompilerId !== CREATIVE_SOURCE_CORRESPONDENCE_RECIPE
    || value.id !== `creative.observed.compatibility.${context.hasher.digestHex(canonicalStringify(toJsonValue({
      schema: value.schema, version: value.version, requestCompilerId: value.requestCompilerId, eventCompilerId: value.eventCompilerId,
      reliability: value.reliability, eventCompatibilities: value.eventCompatibilities, roleCompatibilities: value.roleCompatibilities,
      sourceObservations: value.sourceObservations, requestFrameAnchors: value.requestFrameAnchors,
      ...(value.surfaceBindingRecipe !== undefined ? { surfaceBindingRecipe: value.surfaceBindingRecipe } : {}),
      ...(value.sourceReferencePatternIds !== undefined ? { sourceReferencePatternIds: value.sourceReferencePatternIds } : {})
    })))}`)) return undefined;
  if (sourceObserved && (value.calibrationId !== undefined || value.minimumAdmissiblePosterior !== undefined || value.minimumRolePosterior !== undefined
    || value.surfaceBindingRecipe !== undefined && value.surfaceBindingRecipe !== CREATIVE_SOURCE_SURFACE_ACQUISITION_RECIPE_ID
    || !Array.isArray(value.eventCompatibilities) || value.eventCompatibilities.length !== 0 || !Array.isArray(value.roleCompatibilities) || value.roleCompatibilities.length !== 0)) return undefined;
  const sourceObservations = sourceObserved && context && Array.isArray(value.sourceObservations)
    ? value.sourceObservations.filter((row): row is CreativeSourceCorrespondence => sourceVerification?.verify(row as CreativeSourceCorrespondence, evidenceIds) === true) : [];
  if (sourceObserved) requestFrameAnchors = requestFrameAnchors.filter(anchor => anchor.requestCompilerId === value.requestCompilerId && sourceAnchorOwned(anchor, sourceObservations));
  const identity: CreativeEventCompatibilityModelIdentity = {
    schema: CREATIVE_EVENT_COMPATIBILITY_MODEL_SCHEMA,
    id: stringValue(value.id),
    version: stringValue(value.version),
    requestCompilerId: stringValue(value.requestCompilerId),
    eventCompilerId: stringValue(value.eventCompilerId),
    eventCompatibilities,
    roleCompatibilities,
    ...(requestFrameAnchors.length ? { requestFrameAnchors } : {})
  };
  const sourceReferencePatternIds = stringArray(value.sourceReferencePatternIds);
  const model: CreativeEventCompatibilityModel = sourceObserved ? { ...identity, reliability: "source_observed", sourceObservations,
    ...(value.surfaceBindingRecipe === CREATIVE_SOURCE_SURFACE_ACQUISITION_RECIPE_ID && context
      ? { surfaceBindingRecipe: CREATIVE_SOURCE_SURFACE_ACQUISITION_RECIPE_ID,
        sourceSurfaceBindings: sourceVerification!.acquireSurfaceBindings(sourceObservations) } : {}),
    ...(sourceReferencePatternIds.length ? { sourceReferencePatternIds,
      sourceReferenceBindings: context?.referenceBindings?.filter(reference => sourceReferencePatternIds.includes(reference.id)) ?? [] } : {}) }
    : { ...identity, reliability: value.reliability === "calibrated" ? "calibrated" : "uncalibrated", calibrationId: stringValue(value.calibrationId),
      minimumAdmissiblePosterior: numberValue(value.minimumAdmissiblePosterior), minimumRolePosterior: numberValue(value.minimumRolePosterior) };
  if (sourceObserved) verifiedObservedModels.add(model);
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

function requestFrameAnchorFromUnknown(value: unknown, evidenceIds: readonly EvidenceId[]): CreativeRequestFrameAnchor[] {
  if (!isRecord(value)) return [];
  const row: CreativeRequestFrameAnchor = {
    requestFrameId: stringValue(value.requestFrameId),
    ...(value.sourceAuthority === "creative" || value.sourceAuthority === "unknown" ? {sourceAuthority:value.sourceAuthority}:{}),
    requestCompilerId: stringValue(value.requestCompilerId),
    lexicalKeys: stringArray(value.lexicalKeys).sort(),
    requestRoleIds: stringArray(value.requestRoleIds).sort(),
    support: numberValue(value.support),
    acceptedSupport: numberValue(value.acceptedSupport),
    rejectedSupport: numberValue(value.rejectedSupport),
    ...(typeof value.observedSupport === "number" ? { observedSupport: value.observedSupport } : {}),
    exampleTextHashes: stringArray(value.exampleTextHashes).slice(0, 16),
    ...(Array.isArray(value.requestRoleExamples) ? {
      requestRoleExamples: value.requestRoleExamples.flatMap(example => requestRoleExampleFromUnknown(example, evidenceIds))
    } : {})
  };
  return validRequestFrameAnchor(row) ? [row] : [];
}

function requestRoleExampleFromUnknown(value: unknown, evidenceIds: readonly EvidenceId[]): AlignedSurfaceExample[] {
  if (!isRecord(value) || !stringValue(value.id) || !stringValue(value.profileKey)
    || typeof value.surface !== "string" || value.surface !== value.surface.normalize("NFC")
    || !Array.isArray(value.roleSpans)) return [];
  const owned = new Set<string>(evidenceIds);
  const owners = stringArray(value.evidenceIds);
  if (!owners.length || owners.some(id => !owned.has(id))) return [];
  const points = [...value.surface];
  const roles: AlignedSurfaceExample["roleSpans"][number][] = [];
  for (const raw of value.roleSpans) {
    if (!isRecord(raw) || !stringValue(raw.roleId) || !stringValue(raw.occurrenceId)
      || typeof raw.start !== "number" || typeof raw.end !== "number" || typeof raw.surface !== "string"
      || !validRoleRange({ charStart: raw.start, charEnd: raw.end }, points.length)
      || points.slice(raw.start, raw.end).join("") !== raw.surface) return [];
    const roleOwners = stringArray(raw.evidenceIds);
    if (!roleOwners.length || roleOwners.some(id => !owners.includes(id))) return [];
    roles.push({ roleId: stringValue(raw.roleId), occurrenceId: stringValue(raw.occurrenceId), start: raw.start, end: raw.end,
      surface: raw.surface, evidenceIds: roleOwners });
  }
  return [{ id: value.id as string, profileKey: value.profileKey as string, surface: value.surface, evidenceIds: owners, roleSpans: roles }];
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
    accepted: value.accepted,
    ...(isRecord(value.requestSpan) && typeof value.requestSpan.charStart === "number" && typeof value.requestSpan.charEnd === "number"
      ? { requestSpan: { charStart: value.requestSpan.charStart, charEnd: value.requestSpan.charEnd } } : {})
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
    )
    && (model.reliability === "source_observed"
      ? verifiedObservedModels.has(model) && Boolean(model.sourceObservations?.length && model.requestFrameAnchors?.length) && model.calibrationId === undefined
        && model.minimumAdmissiblePosterior === undefined && model.minimumRolePosterior === undefined
        && model.eventCompatibilities.length === 0 && model.roleCompatibilities.length === 0
      : Boolean(model.calibrationId) && (model.reliability === "calibrated" || model.reliability === "uncalibrated")
        && unitInterval(model.minimumAdmissiblePosterior!) && unitInterval(model.minimumRolePosterior!))
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
    && (row.observedSupport === undefined || (Number.isSafeInteger(row.observedSupport) && row.observedSupport >= 0))
    && row.acceptedSupport + row.rejectedSupport + (row.observedSupport ?? 0) === row.support
    && Array.isArray(row.exampleTextHashes);
}

function sourceAnchorOwned(anchor: CreativeRequestFrameAnchor, observations: readonly CreativeSourceCorrespondence[]): boolean {
  const rows = observations.filter(row => row.requestFrameId === anchor.requestFrameId);
  const examples = anchor.requestRoleExamples ?? [];
  return rows.length > 0 && rows.every(row=>row.request.sourceAuthority===anchor.sourceAuthority)
    && (anchor.sourceAuthority === "creative" || anchor.sourceAuthority === "unknown")
    && examples.length > 0 && examples.every(example => rows.some(row => row.request.surface === example.surface
    && example.evidenceIds.includes(row.request.evidenceId)) && example.profileKey === anchor.requestCompilerId
    && example.roleSpans.every(role => rows.some(row => row.request.surface === example.surface
      && row.bindings.some(binding => binding.requestRoleId === role.roleId && binding.requestStart === role.start && binding.requestEnd === role.end))));
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
