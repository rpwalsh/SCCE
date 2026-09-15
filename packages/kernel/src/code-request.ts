// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
import { splitPriorUnits, normalizePriorKey } from "./kernel-answer-primitives.js";
import { canonicalStringify, createHasher, toJsonValue } from "./primitives.js";
import { parseStatefulBehaviorScenarios } from "./stateful-behavior-scenarios.js";
import type { ExplicitTurnRequirement } from "./turn-requirements.js";
import { COGNITIVE_OPERATOR_IDS, type ActivatedOperator, type TurnRequirementField } from "./turn-requirements.js";
import type { JsonValue, ProgramBehaviorRequirement, ProgramStatefulBehaviorRequirement } from "./types.js";
import { calibrated } from "./calibrations/prod-calibrations.js";
import type { CalibrationKey } from "./calibrations/public-calibrations.js";

/**
 * Formal language identity, not natural-language vocabulary: these are the
 * names programs are written in, the same way a document title names a source.
 * Distinctive names identify a language on sight; short aliases ("go", "c",
 * "js") are ordinary words in prose and only count once other code structure
 * corroborates them.
 */
const DISTINCTIVE_LANGUAGE_IDS: ReadonlyMap<string, string> = new Map([
  ["typescript", "typescript"], ["javascript", "javascript"], ["python", "python"],
  ["rust", "rust"], ["golang", "go"], ["java", "java"], ["kotlin", "kotlin"],
  ["swift", "swift"], ["csharp", "csharp"], ["ruby", "ruby"], ["php", "php"],
  ["bash", "shell"], ["shell", "shell"], ["sql", "sql"], ["cpp", "cpp"], ["c++", "cpp"]
]);

const ALIAS_LANGUAGE_IDS: ReadonlyMap<string, string> = new Map([
  ["ts", "typescript"], ["tsx", "typescript"], ["js", "javascript"], ["jsx", "javascript"],
  ["py", "python"], ["rs", "rust"], ["go", "go"], ["c", "c"], ["cs", "csharp"],
  ["rb", "ruby"], ["sh", "shell"], ["kt", "kotlin"]
]);

/** Extension to formal language, for a path named in a request. */
const CODE_EXTENSION_LANGUAGES: ReadonlyMap<string, string> = new Map([
  ["ts", "typescript"], ["tsx", "typescript"], ["mts", "typescript"], ["cts", "typescript"],
  ["js", "javascript"], ["jsx", "javascript"], ["mjs", "javascript"], ["cjs", "javascript"],
  ["py", "python"], ["rs", "rust"], ["go", "go"], ["java", "java"], ["kt", "kotlin"],
  ["swift", "swift"], ["c", "c"], ["h", "c"], ["cc", "cpp"], ["cpp", "cpp"], ["hpp", "cpp"],
  ["cs", "csharp"], ["rb", "ruby"], ["php", "php"], ["sh", "shell"], ["sql", "sql"]
]);

/**
 * The formal language a path is written in, by extension.
 *
 * One table serves both directions: recognising the language a request names, and labelling the corpus a file
 * trains into. A second table would drift, and a corpus filed under a language the request cannot name is a
 * corpus the generator can never reach.
 */
export function codeLanguageForPath(value: string): string | undefined {
  const extension = /\.([\p{L}\p{N}]{1,4})$/u.exec(value.trim())?.[1]?.toLocaleLowerCase();
  return extension ? CODE_EXTENSION_LANGUAGES.get(extension) : undefined;
}

export interface CodeRequestSignal {
  /** The formal language the request names or implies, when one is identifiable. */
  language?: string;
  /** Bounded structural evidence that this request concerns executable artifacts. */
  demand: number;
  /** Paths the request names, in request order. */
  paths: string[];
  signals: string[];
  /** Typed, request-local structural observations used by routing and later learning. */
  observations: CodeStructureObservation[];
  behaviorRequirements: ProgramBehaviorRequirement[];
  statefulBehaviorRequirements: ProgramStatefulBehaviorRequirement[];
}

export type CodeStructureObservationKind =
  | "fenced_block"
  | "formal_language"
  | "language_alias"
  | "code_path"
  | "identifier_shape"
  | "call_shape"
  | "code_punctuation"
  | "owner_behavior_example"
  | "owner_stateful_behavior_example";

export interface CodeStructureObservation {
  kind: CodeStructureObservationKind;
  /** Structural detector that produced this observation; no natural-language label is implied. */
  detectorId: `code.detector.${CodeStructureObservationKind}`;
}

/**
 * Demand is calibrated from typed structural observations after detection.
 * A trained model can replace this bootstrap map without changing detectors
 * or treating any request language as part of the code ontology.
 */
export type CodeRequestDemandModel = Readonly<Record<CodeStructureObservationKind, number>>;

const CODE_REQUEST_DEMAND_CALIBRATION_KEYS: Readonly<Record<CodeStructureObservationKind, CalibrationKey>> = Object.freeze({
  fenced_block: "code_request.demand.fenced_block",
  formal_language: "code_request.demand.formal_language",
  language_alias: "code_request.demand.language_alias",
  code_path: "code_request.demand.code_path",
  identifier_shape: "code_request.demand.identifier_shape",
  call_shape: "code_request.demand.call_shape",
  code_punctuation: "code_request.demand.code_punctuation",
  owner_behavior_example: "code_request.demand.owner_behavior_example",
  owner_stateful_behavior_example: "code_request.demand.owner_stateful_behavior_example"
});

export const CODE_REQUEST_BOOTSTRAP_DEMAND_MODEL: CodeRequestDemandModel = Object.freeze({
  fenced_block: calibrated(CODE_REQUEST_DEMAND_CALIBRATION_KEYS.fenced_block),
  formal_language: calibrated(CODE_REQUEST_DEMAND_CALIBRATION_KEYS.formal_language),
  language_alias: calibrated(CODE_REQUEST_DEMAND_CALIBRATION_KEYS.language_alias),
  code_path: calibrated(CODE_REQUEST_DEMAND_CALIBRATION_KEYS.code_path),
  identifier_shape: calibrated(CODE_REQUEST_DEMAND_CALIBRATION_KEYS.identifier_shape),
  call_shape: calibrated(CODE_REQUEST_DEMAND_CALIBRATION_KEYS.call_shape),
  code_punctuation: calibrated(CODE_REQUEST_DEMAND_CALIBRATION_KEYS.code_punctuation),
  owner_behavior_example: calibrated(CODE_REQUEST_DEMAND_CALIBRATION_KEYS.owner_behavior_example),
  owner_stateful_behavior_example: calibrated(CODE_REQUEST_DEMAND_CALIBRATION_KEYS.owner_stateful_behavior_example)
});

function activeCodeRequestDemandModel(): CodeRequestDemandModel {
  return {
    fenced_block: calibrated(CODE_REQUEST_DEMAND_CALIBRATION_KEYS.fenced_block),
    formal_language: calibrated(CODE_REQUEST_DEMAND_CALIBRATION_KEYS.formal_language),
    language_alias: calibrated(CODE_REQUEST_DEMAND_CALIBRATION_KEYS.language_alias),
    code_path: calibrated(CODE_REQUEST_DEMAND_CALIBRATION_KEYS.code_path),
    identifier_shape: calibrated(CODE_REQUEST_DEMAND_CALIBRATION_KEYS.identifier_shape),
    call_shape: calibrated(CODE_REQUEST_DEMAND_CALIBRATION_KEYS.call_shape),
    code_punctuation: calibrated(CODE_REQUEST_DEMAND_CALIBRATION_KEYS.code_punctuation),
    owner_behavior_example: calibrated(CODE_REQUEST_DEMAND_CALIBRATION_KEYS.owner_behavior_example),
    owner_stateful_behavior_example: calibrated(CODE_REQUEST_DEMAND_CALIBRATION_KEYS.owner_stateful_behavior_example)
  };
}

export interface CodeRequestSignalOptions {
  demandModel?: CodeRequestDemandModel;
}

export function codeRequestDemand(
  observations: readonly CodeStructureObservation[],
  demandModel?: CodeRequestDemandModel
): number {
  const activeModel = demandModel ?? activeCodeRequestDemandModel();
  return Math.min(1, observations.reduce((sum, observation) => sum + activeModel[observation.kind], 0));
}

const FENCE = /```/u;
const CAMEL_OR_SNAKE = /\b\p{Ll}[\p{L}\p{N}]*(?:\p{Lu}[\p{L}\p{N}]*|_[\p{L}\p{N}]+)/u;
const CALL_SHAPE = /[\p{L}\p{N}_$]\([^)]*\)/u;
const CODE_PUNCTUATION = /=>|::|\{\s*\}|<\p{Lu}[\p{L}\p{N}]*>/u;
const PATH_SHAPE = /(?:[\p{L}\p{N}_$.@-]+\/)+[\p{L}\p{N}_$.-]+\.([\p{L}\p{N}]{1,4})\b|\b[\p{L}\p{N}_$-]+\.([\p{L}\p{N}]{1,4})\b/gu;

/**
 * Structural, language-neutral evidence that a request is about code: fenced
 * blocks, a named formal language, identifier and call shapes, and paths with
 * code extensions. No natural-language vocabulary is consulted, so this holds
 * for a request written in any language. Pure.
 */
export function codeRequestSignal(requestText: string, options: CodeRequestSignalOptions = {}): CodeRequestSignal {
  const text = requestText ?? "";
  const signals: string[] = [];
  const observations: CodeStructureObservation[] = [];
  let language: string | undefined;
  let distinctiveLanguage = false;

  const observe = (kind: CodeStructureObservationKind): void => {
    observations.push({ kind, detectorId: `code.detector.${kind}` });
    signals.push(`code.signal.${kind}`);
  };

  const fenced = FENCE.test(text);
  if (fenced) observe("fenced_block");

  const requestUnits = splitPriorUnits(normalizePriorKey(text)).map(unit => unit.replace(/^[^\p{L}\p{N}+#]+|[^\p{L}\p{N}+#]+$/gu, ""));
  for (const unit of requestUnits) {
    const distinctive = DISTINCTIVE_LANGUAGE_IDS.get(unit);
    if (distinctive) { language ??= distinctive; distinctiveLanguage = true; observe("formal_language"); break; }
  }
  if (!distinctiveLanguage) {
    for (const unit of requestUnits) {
      const alias = ALIAS_LANGUAGE_IDS.get(unit);
      if (alias) { language ??= alias; observe("language_alias"); break; }
    }
  }

  const paths: string[] = [];
  for (const match of text.matchAll(PATH_SHAPE)) {
    const extension = String(match[1] ?? match[2] ?? "").toLocaleLowerCase();
    const extensionLanguage = CODE_EXTENSION_LANGUAGES.get(extension);
    if (!extensionLanguage) continue;
    const path = match[0];
    if (!paths.includes(path)) paths.push(path);
    language ??= extensionLanguage;
  }
  if (paths.length) observe("code_path");

  const identifierShape = CAMEL_OR_SNAKE.test(text);
  const callShape = CALL_SHAPE.test(text);
  const codePunctuation = CODE_PUNCTUATION.test(text);
  if (identifierShape) observe("identifier_shape");
  if (callShape) observe("call_shape");
  if (codePunctuation) observe("code_punctuation");

  const statefulBehaviorRequirements = explicitStatefulBehaviorRequirements(text);
  // An ordered scenario owns its final observation. Do not additionally turn
  // that observation into a scalar lookup obligation.
  const behaviorRequirements = statefulBehaviorRequirements.length ? [] : explicitCallResultRequirements(text);
  if (behaviorRequirements.length) {
    observe("owner_behavior_example");
  }
  if (statefulBehaviorRequirements.length) {
    observe("owner_stateful_behavior_example");
  }

  return { ...(language ? { language } : {}), demand: codeRequestDemand(observations, options.demandModel), paths: paths.slice(0, 8), signals, observations, behaviorRequirements, statefulBehaviorRequirements };
}

/**
 * One structural signal is never enough: a named language is corroborated by
 * code shape, an alias only by a fenced block or a path. This is what keeps an
 * ordinary sentence containing "go" or "c" out of the artifact lane.
 */
export function codeRequestRecognized(signal: CodeRequestSignal): boolean {
  const has = (id: string) => signal.signals.includes(id);
  if (has("code.signal.code_path")) return true;
  if (has("code.signal.owner_behavior_example")) return true;
  if (has("code.signal.owner_stateful_behavior_example")) return true;
  if (has("code.signal.fenced_block") && signal.language !== undefined) return true;
  if (has("code.signal.formal_language")) return true;
  return has("code.signal.language_alias") && codeRequestCorroborated(signal);
}

/** Code shape around the language name: an artifact is being written, not discussed. Pure. */
export function codeRequestCorroborated(signal: CodeRequestSignal): boolean {
  return signal.observations.some(observation => observation.kind !== "formal_language" && observation.kind !== "language_alias");
}

function explicitStatefulBehaviorRequirements(requestText: string): ProgramStatefulBehaviorRequirement[] {
  const corpus = parseStatefulBehaviorScenarios(requestText);
  if (!corpus) return [];
  const hasher = createHasher();
  return corpus.scenarios.map(scenario => {
    const identity = {
      requestHash: corpus.requestHash,
      invocations: scenario.invocations.map(invocation => ({
        callableId: invocation.callableId,
        arguments: invocation.arguments.map(value => toJsonValue(value)),
        sourceSpan: invocation.sourceSpan
      })),
      expectedResult: toJsonValue(scenario.assertion.result),
      verificationRole: scenario.verificationRole,
      relationSurface: scenario.assertion.relationSurface,
      sourceSpan: scenario.sourceSpan
    };
    return {
      id: `owner.program.stateful_requirement.${hasher.digestHex(canonicalStringify(identity)).slice(0, 40)}`,
      ...identity
    };
  });
}

/**
 * Extracts only explicit code-shaped call/result examples. The separator is
 * preserved from the owner surface; no natural-language relation word is read.
 */
function explicitCallResultRequirements(requestText: string, scanChars = 8192, limit = 16): ProgramBehaviorRequirement[] {
  const text = requestText.slice(0, scanChars);
  const hasher = createHasher();
  const requestHash = `sha256:${hasher.digestHex(requestText)}`;
  const requirements: ProgramBehaviorRequirement[] = [];
  const declaredCallables = declaredCallableIds(text);
  let cursor = 0;
  while (cursor < text.length && requirements.length < limit) {
    const identifier = readIdentifier(text, cursor);
    if (!identifier) {
      cursor += 1;
      continue;
    }
    const callStart = cursor;
    cursor = skipWhitespace(text, identifier.end);
    if (text[cursor] !== "(") continue;
    const call = readBalancedJson(text, cursor, "(", ")");
    if (!call) continue;
    cursor = skipWhitespace(text, call.end);
    let relationSurface = ["===", "=>", "==", "="].find(operator => text.startsWith(operator, cursor));
    let relationEnd = relationSurface ? cursor + relationSurface.length : cursor;
    if (!relationSurface && declaredCallables.has(identifier.value)) {
      const relation = readIdentifier(text, cursor);
      if (relation) {
        const afterRelation = skipWhitespace(text, relation.end);
        if (afterRelation > relation.end) {
          relationSurface = relation.value;
          relationEnd = relation.end;
        }
      }
    }
    if (!relationSurface) continue;
    const resultStart = skipWhitespace(text, relationEnd);
    const result = readJsonValue(text, resultStart);
    if (!result) continue;
    let args: JsonValue[];
    try {
      const parsed = JSON.parse(`[${call.inner}]`) as unknown;
      if (!Array.isArray(parsed)) continue;
      args = parsed as JsonValue[];
    } catch {
      continue;
    }
    const identity = {
      requestHash,
      callableId: identifier.value,
      arguments: args,
      expectedResult: result.value,
      relationSurface,
      sourceSpan: { charStart: callStart, charEnd: result.end }
    };
    requirements.push({
      id: `owner.program.requirement.${hasher.digestHex(canonicalStringify(identity)).slice(0, 40)}`,
      verificationRole: "fit",
      ...identity
    });
    cursor = result.end;
  }
  const byCallable = new Map<string, number[]>();
  requirements.forEach((requirement, index) => byCallable.set(requirement.callableId, [...(byCallable.get(requirement.callableId) ?? []), index]));
  const heldOut = new Set([...byCallable.values()].filter(indices => indices.length >= 4).map(indices => indices.at(-1)!));
  return requirements.map((requirement, index) => ({
    ...requirement,
    verificationRole: heldOut.has(index) ? "held_out" : "fit"
  }));
}

/**
 * A repeated callable declaration licenses one opaque relation unit between a
 * concrete call and its JSON result. This admits source-language surfaces such
 * as `f(x); f(1) <relation> 2` without assigning an English meaning to the
 * relation unit.
 */
function declaredCallableIds(text: string): Set<string> {
  const result = new Set<string>();
  let cursor = 0;
  while (cursor < text.length) {
    const identifier = readIdentifier(text, cursor);
    if (!identifier) { cursor += 1; continue; }
    cursor = skipWhitespace(text, identifier.end);
    if (text[cursor] !== "(") continue;
    const call = readBalancedJson(text, cursor, "(", ")");
    if (!call) continue;
    cursor = call.end;
    const parameters = call.inner.split(",").map(value => value.trim()).filter(Boolean);
    if (parameters.length > 0 && parameters.every(value => readIdentifier(value, 0)?.end === value.length)) {
      result.add(identifier.value);
    }
  }
  return result;
}

function readIdentifier(text: string, start: number): { value: string; end: number } | undefined {
  if (!/^[$_\p{L}]$/u.test(text[start] ?? "")) return undefined;
  let end = start + 1;
  while (/^[$_\p{L}\p{N}]$/u.test(text[end] ?? "")) end += 1;
  return { value: text.slice(start, end), end };
}

function skipWhitespace(text: string, start: number): number {
  let cursor = start;
  while (cursor < text.length && /\s/u.test(text[cursor]!)) cursor += 1;
  return cursor;
}

function readBalancedJson(text: string, start: number, open: string, close: string): { inner: string; end: number } | undefined {
  if (text[start] !== open) return undefined;
  let depth = 0;
  let quote = "";
  let escaped = false;
  for (let cursor = start; cursor < text.length; cursor += 1) {
    const char = text[cursor]!;
    if (quote) {
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === quote) quote = "";
      continue;
    }
    if (char === '"') { quote = char; continue; }
    if (char === open) depth += 1;
    else if (char === close && --depth === 0) return { inner: text.slice(start + 1, cursor), end: cursor + 1 };
  }
  return undefined;
}

function readJsonValue(text: string, start: number): { value: JsonValue; end: number } | undefined {
  const first = text[start];
  if (!first) return undefined;
  let end = start;
  if (first === '"') {
    let escaped = false;
    for (end = start + 1; end < text.length; end += 1) {
      const char = text[end]!;
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === '"') { end += 1; break; }
    }
  } else if (first === "[" || first === "{") {
    const balanced = readBalancedJson(text, start, first, first === "[" ? "]" : "}");
    if (!balanced) return undefined;
    end = balanced.end;
  } else {
    const match = /^(?:-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?|true|false|null)\b/u.exec(text.slice(start));
    if (!match) return undefined;
    end = start + match[0].length;
  }
  try {
    return { value: JSON.parse(text.slice(start, end)) as JsonValue, end };
  } catch {
    return undefined;
  }
}

/**
 * Converts recognized code structure into the same explicit requirement shape a
 * structured authority uses, so routing stays one learned projection rather
 * than a second router.
 */
export function codeRequestRequirements(requestText: string, signal: CodeRequestSignal): ExplicitTurnRequirement[] {
  if (!codeRequestRecognized(signal)) return [];
  const charEnd = [...requestText].length;
  const values: Array<[ExplicitTurnRequirement["dimension"], number]> = [
    // Corroborated code shape asks for an artifact outright; a bare language name only tilts the projection, which still weighs the learned field.
    ["executableArtifactDemand", codeRequestCorroborated(signal) ? 0.92 : 0.58],
    ["formatConstraintStrength", 0.72],
    ["externalTruthAuthority", 0.2]
  ];
  return values.map(([dimension, value]) => ({
    id: `requirement.code_request.${dimension}.v1`,
    dimension,
    value,
    confidence: Math.min(1, 0.6 + signal.demand * 0.4),
    polarity: "required" as const,
    status: "explicit" as const,
    span: { charStart: 0, charEnd },
    semanticRoleId: "role.request.code.v1",
    learnedFrameOrPatternId: "pattern.code_request.structure.v1",
    sourceActivationId: "activation.structure.code_request.v1",
      trace: toJsonValue({ source: "kernel.code_request.structure", signals: signal.signals, observations: signal.observations, language: signal.language ?? null, paths: signal.paths })
  }));
}

/**
 * Project structural code observations into the shared requirement field.
 *
 * This is the live path. It intentionally does not call `codeRequestRecognized`:
 * that predicate remains a compatibility helper for callers that need the old
 * detector result, while serving decisions are made only after the observation
 * has crossed the requirement and operator projections.
 */
export function codeRequestObservedRequirements(requestText: string, signal: CodeRequestSignal): ExplicitTurnRequirement[] {
  const hasBehavior = signal.behaviorRequirements.length > 0 || signal.statefulBehaviorRequirements.length > 0;
  const hasPath = signal.paths.length > 0;
  const hasFencedArtifact = signal.observations.some(observation => observation.kind === "fenced_block");
  const hasCorroboratedShape = codeRequestCorroborated(signal);
  // A formal-language observation alone is ambiguous prose. A path, fenced
  // artifact, explicit behavior, or corroborated structure is enough to enter
  // the learned requirement projection.
  if (!hasPath && !hasFencedArtifact && !hasBehavior && !hasCorroboratedShape) return [];
  const charEnd = [...requestText].length;
  const values: Array<[ExplicitTurnRequirement["dimension"], number]> = [
    // Structural corroboration admits the projection; its strength still
    // comes from the calibrated observation demand rather than this detector.
    ["executableArtifactDemand", Math.min(1, 0.5 + signal.demand * 0.85)],
    ["formatConstraintStrength", 0.72],
    ["externalTruthAuthority", 0.2]
  ];
  return values.map(([dimension, value]) => ({
    id: `requirement.code_observation.${dimension}.v1`,
    dimension,
    value,
    confidence: Math.min(1, 0.6 + signal.demand * 0.4),
    polarity: "required" as const,
    status: "inferred" as const,
    span: { charStart: 0, charEnd },
    semanticRoleId: "role.request.code_observation.v1",
    learnedFrameOrPatternId: "code.observation.requirement.v1",
    sourceActivationId: signal.observations.map(observation => observation.detectorId).join("|") || "code.observation.none.v1",
    trace: toJsonValue({
      source: "code_structure_observation",
      demand: signal.demand,
      observations: signal.observations
    })
  }));
}

/** Resolve a language for the mouth only after the shared typed route admits it. */
export function codeLanguageForRequirementState(input: {
  signal: CodeRequestSignal;
  requirementField: Pick<TurnRequirementField, "executableArtifactDemand">;
  operators: readonly Pick<ActivatedOperator, "operatorId" | "active">[];
}): string | undefined {
  if (!input.signal.language || input.requirementField.executableArtifactDemand < 0.5) return undefined;
  if (!input.operators.some(operator => operator.operatorId === COGNITIVE_OPERATOR_IDS.programPlanning && operator.active)) return undefined;
  const corroborated = input.signal.observations.some(observation =>
    observation.kind !== "formal_language" && observation.kind !== "language_alias");
  return corroborated ? input.signal.language : undefined;
}
