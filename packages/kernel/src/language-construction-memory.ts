import {
  induceLearnedConstructions,
  type AlignedSurfaceExample,
  type LearnedConstruction,
  type LearnedFormClass
} from "./language-construction.js";
import { canonicalStringify } from "./primitives.js";
import type { LanguagePatternRecord } from "./storage.js";
import type { EvidenceSpan, Hasher, JsonValue } from "./types.js";

export const LANGUAGE_CONSTRUCTION_PATTERN_SCHEMA = "scce.language_construction_pattern.v1" as const;

export const LANGUAGE_CONSTRUCTION_MEMORY_REJECTION_IDS = {
  input: "surface.construction_memory.reject.input",
  ownership: "surface.construction_memory.reject.ownership",
  evidence: "surface.construction_memory.reject.evidence",
  coordinates: "surface.construction_memory.reject.coordinates",
  induction: "surface.construction_memory.reject.induction",
  identity: "surface.construction_memory.reject.identity",
  digest: "surface.construction_memory.reject.digest",
  member: "surface.construction_memory.reject.member",
  duplicate: "surface.construction_memory.reject.duplicate"
} as const;

export type LanguageConstructionMemoryRejectionId =
  typeof LANGUAGE_CONSTRUCTION_MEMORY_REJECTION_IDS[keyof typeof LANGUAGE_CONSTRUCTION_MEMORY_REJECTION_IDS];

/**
 * A role alignment supplied by a typed corpus extractor. Coordinates are
 * Unicode code-point offsets relative to the example surface.
 */
export interface SourceBoundConstructionRoleSpan {
  slotIndex: number;
  occurrenceIndex?: number;
  startCodePoint: number;
  endCodePoint: number;
}

export interface SourceBoundConstructionNullRole {
  slotIndex: number;
  occurrenceIndex?: number;
}

/**
 * A source-bound corpus observation. Raw text alone is deliberately
 * insufficient: a typed upstream extractor must provide the semantic slot
 * alignment and exact evidence range.
 */
export interface SourceBoundConstructionObservation {
  sourceVersionId: string;
  evidenceId: string;
  surfaceStartCodePoint: number;
  surfaceEndCodePoint: number;
  roles: readonly SourceBoundConstructionRoleSpan[];
  nullRoles?: readonly SourceBoundConstructionNullRole[];
}

export interface SourceBoundLanguageConstructionTrainingSet {
  bindingId: string;
  observations: readonly SourceBoundConstructionObservation[];
}

export interface DurableSourceConstructionExample {
  id: string;
  bindingId: string;
  sourceProfileId: string;
  targetProfileId: string;
  sourceVersionId: string;
  evidenceId: string;
  evidenceContentHash: string;
  evidenceCharStart: number;
  evidenceCharEnd: number;
  surfaceStartCodePoint: number;
  surfaceEndCodePoint: number;
  surface: string;
  surfaceDigest: string;
  roles: Array<{
    slotIndex: number;
    occurrenceIndex: number;
    roleId: string;
    occurrenceId: string;
    startCodePoint: number;
    endCodePoint: number;
    surface: string;
  }>;
  nullRoles: Array<{
    slotIndex: number;
    occurrenceIndex: number;
    roleId: string;
    occurrenceId: string;
  }>;
}

export interface DurableLanguageConstructionBundleContent {
  schema: typeof LANGUAGE_CONSTRUCTION_PATTERN_SCHEMA;
  bindingId: string;
  sourceProfileId: string;
  targetProfileId: string;
  sourceVersionIds: string[];
  evidenceIds: string[];
  evidenceContentHashes: string[];
  sourceExamples: DurableSourceConstructionExample[];
  constructions: LearnedConstruction[];
  formClasses: LearnedFormClass[];
}

export interface DurableLanguageConstructionBundle extends DurableLanguageConstructionBundleContent {
  id: string;
  contentDigest: string;
}

export interface LanguageConstructionMemoryIssue {
  code: LanguageConstructionMemoryRejectionId;
  patternId?: string;
  profileId?: string;
  evidenceId?: string;
  sourceVersionId?: string;
}

export type LanguageConstructionPatternCompilation =
  | {
      status: "compiled";
      pattern: LanguagePatternRecord;
      bundle: DurableLanguageConstructionBundle;
    }
  | {
      status: "rejected";
      issues: readonly LanguageConstructionMemoryIssue[];
    };

export interface HydratedLanguageConstructions {
  bundles: DurableLanguageConstructionBundle[];
  constructions: LearnedConstruction[];
  formClasses: LearnedFormClass[];
  rejected: LanguageConstructionMemoryIssue[];
}

export function languageConstructionRoleId(
  hasher: Hasher,
  bindingId: string,
  slotIndex: number
): string {
  return stableId(hasher, "surface.construction.role", [bindingId, checkedIndex(slotIndex)]);
}

export function languageConstructionOccurrenceId(
  hasher: Hasher,
  bindingId: string,
  slotIndex: number,
  occurrenceIndex = 0
): string {
  return stableId(hasher, "surface.construction.occurrence", [
    bindingId,
    checkedIndex(slotIndex),
    checkedIndex(occurrenceIndex)
  ]);
}

export function compileLanguageConstructionPattern(input: {
  bindingId: string;
  profileId: string;
  observations: readonly SourceBoundConstructionObservation[];
  evidence: readonly EvidenceSpan[];
  hasher: Hasher;
  updatedAt: number;
}): LanguageConstructionPatternCompilation {
  if (!nonempty(input.bindingId)
    || !nonempty(input.profileId)
    || !Number.isFinite(input.updatedAt)
    || input.observations.length === 0
    || input.observations.length > 256) {
    return rejected(LANGUAGE_CONSTRUCTION_MEMORY_REJECTION_IDS.input);
  }

  const evidenceById = uniqueEvidenceById(input.evidence);
  if (!evidenceById || evidenceById.size === 0) {
    return rejected(LANGUAGE_CONSTRUCTION_MEMORY_REJECTION_IDS.evidence);
  }

  const durableExamples: DurableSourceConstructionExample[] = [];
  const alignedExamples: AlignedSurfaceExample[] = [];
  for (const observation of input.observations) {
    const prepared = prepareObservation({ ...input, observation, evidenceById });
    if ("issue" in prepared) return { status: "rejected", issues: [prepared.issue] };
    durableExamples.push(prepared.durable);
    alignedExamples.push(prepared.aligned);
  }

  const duplicateExampleId = firstDuplicate(durableExamples.map(example => example.id));
  if (duplicateExampleId) return rejected(LANGUAGE_CONSTRUCTION_MEMORY_REJECTION_IDS.duplicate);

  const induction = induceLearnedConstructions({ examples: alignedExamples, hasher: input.hasher });
  if (induction.rejected.length > 0 || induction.constructions.length === 0) {
    return rejected(LANGUAGE_CONSTRUCTION_MEMORY_REJECTION_IDS.induction);
  }
  if (induction.constructions.some(item => item.profileKey !== input.profileId)
    || induction.formClasses.some(item => item.profileKey !== input.profileId)) {
    return rejected(LANGUAGE_CONSTRUCTION_MEMORY_REJECTION_IDS.ownership);
  }

  const sourceExamples = durableExamples.sort(compareDurableExamples);
  const evidenceIds = uniqueSorted(sourceExamples.map(item => item.evidenceId));
  const sourceVersionIds = uniqueSorted(sourceExamples.map(item => item.sourceVersionId));
  const evidenceContentHashes = uniqueSorted(sourceExamples.map(item => item.evidenceContentHash));
  const content: DurableLanguageConstructionBundleContent = {
    schema: LANGUAGE_CONSTRUCTION_PATTERN_SCHEMA,
    bindingId: input.bindingId,
    sourceProfileId: input.profileId,
    targetProfileId: input.profileId,
    sourceVersionIds,
    evidenceIds,
    evidenceContentHashes,
    sourceExamples,
    constructions: [...induction.constructions],
    formClasses: [...induction.formClasses]
  };
  const contentDigest = input.hasher.digestHex(canonicalStringify(content));
  const id = `surface.construction.bundle.${contentDigest}`;
  const bundle: DurableLanguageConstructionBundle = { id, contentDigest, ...content };
  const support = minimumSupport(bundle.constructions.map(item => item.support));
  const pattern: LanguagePatternRecord = {
    id,
    profileId: input.profileId,
    patternKind: "semantic_role",
    support,
    entropy: 0,
    patternJson: {
      schema: LANGUAGE_CONSTRUCTION_PATTERN_SCHEMA,
      contentDigest,
      bundle: bundle as unknown as JsonValue
    },
    evidenceIds: evidenceIds as EvidenceSpan["id"][],
    updatedAt: input.updatedAt
  };
  return { status: "compiled", pattern, bundle };
}

export function hydrateLanguageConstructionPatterns(input: {
  patterns: readonly LanguagePatternRecord[];
  evidence: readonly EvidenceSpan[];
  hasher?: Hasher;
}): HydratedLanguageConstructions {
  const constructionPatterns = input.patterns
    .filter(isLanguageConstructionPattern)
    .sort((left, right) => compareText(left.id, right.id));
  const rejectedIssues: LanguageConstructionMemoryIssue[] = [];
  if (!input.hasher) {
    return {
      bundles: [],
      constructions: [],
      formClasses: [],
      rejected: constructionPatterns.map(pattern => ({
        code: LANGUAGE_CONSTRUCTION_MEMORY_REJECTION_IDS.digest,
        patternId: pattern.id,
        profileId: pattern.profileId
      }))
    };
  }

  const duplicatePatternIds = duplicateValues(constructionPatterns.map(pattern => pattern.id));
  const evidenceById = uniqueEvidenceById(input.evidence);
  const bundles: DurableLanguageConstructionBundle[] = [];
  for (const pattern of constructionPatterns) {
    if (duplicatePatternIds.has(pattern.id)) {
      rejectedIssues.push({ code: LANGUAGE_CONSTRUCTION_MEMORY_REJECTION_IDS.duplicate, patternId: pattern.id, profileId: pattern.profileId });
      continue;
    }
    if (!evidenceById) {
      rejectedIssues.push({ code: LANGUAGE_CONSTRUCTION_MEMORY_REJECTION_IDS.evidence, patternId: pattern.id, profileId: pattern.profileId });
      continue;
    }
    const verified = verifyPersistedPattern(pattern, evidenceById, input.hasher);
    if ("issue" in verified) rejectedIssues.push(verified.issue);
    else bundles.push(verified.bundle);
  }

  const uniqueBundles = bundles.sort((left, right) => compareText(left.id, right.id));
  return {
    bundles: uniqueBundles,
    constructions: uniqueBundles.flatMap(bundle => bundle.constructions),
    formClasses: uniqueBundles.flatMap(bundle => bundle.formClasses),
    rejected: rejectedIssues.sort(compareIssues)
  };
}

export function isLanguageConstructionPattern(pattern: LanguagePatternRecord): boolean {
  const row = recordOf(pattern.patternJson);
  return row.schema === LANGUAGE_CONSTRUCTION_PATTERN_SCHEMA;
}

function prepareObservation(input: {
  bindingId: string;
  profileId: string;
  observation: SourceBoundConstructionObservation;
  evidenceById: ReadonlyMap<string, EvidenceSpan>;
  hasher: Hasher;
}): { durable: DurableSourceConstructionExample; aligned: AlignedSurfaceExample } | { issue: LanguageConstructionMemoryIssue } {
  const observation = input.observation;
  if (!nonempty(observation.sourceVersionId)
    || !nonempty(observation.evidenceId)
    || observation.roles.length + (observation.nullRoles?.length ?? 0) === 0
    || observation.roles.length > 64
    || (observation.nullRoles?.length ?? 0) > 64) {
    return { issue: { code: LANGUAGE_CONSTRUCTION_MEMORY_REJECTION_IDS.input } };
  }
  const evidence = input.evidenceById.get(observation.evidenceId);
  if (!evidence || evidence.status !== "promoted") {
    return { issue: { code: LANGUAGE_CONSTRUCTION_MEMORY_REJECTION_IDS.evidence, evidenceId: observation.evidenceId } };
  }
  if (String(evidence.sourceVersionId) !== observation.sourceVersionId) {
    return {
      issue: {
        code: LANGUAGE_CONSTRUCTION_MEMORY_REJECTION_IDS.ownership,
        evidenceId: observation.evidenceId,
        sourceVersionId: observation.sourceVersionId
      }
    };
  }
  const evidencePoints = [...evidence.text];
  if (!validRange(observation.surfaceStartCodePoint, observation.surfaceEndCodePoint, evidencePoints.length)
    || evidence.charEnd - evidence.charStart !== evidencePoints.length) {
    return { issue: { code: LANGUAGE_CONSTRUCTION_MEMORY_REJECTION_IDS.coordinates, evidenceId: observation.evidenceId } };
  }
  const surface = evidencePoints
    .slice(observation.surfaceStartCodePoint, observation.surfaceEndCodePoint)
    .join("");
  if (!surface || surface !== surface.normalize("NFC")) {
    return { issue: { code: LANGUAGE_CONSTRUCTION_MEMORY_REJECTION_IDS.coordinates, evidenceId: observation.evidenceId } };
  }
  const surfacePoints = [...surface];
  const roleKeys = new Set<string>();
  const durableRoles: DurableSourceConstructionExample["roles"] = [];
  for (const role of observation.roles) {
    const occurrenceIndex = role.occurrenceIndex ?? 0;
    if (!validIndex(role.slotIndex)
      || !validIndex(occurrenceIndex)
      || !validRange(role.startCodePoint, role.endCodePoint, surfacePoints.length)
      || role.startCodePoint === role.endCodePoint) {
      return { issue: { code: LANGUAGE_CONSTRUCTION_MEMORY_REJECTION_IDS.coordinates, evidenceId: observation.evidenceId } };
    }
    const key = `${role.slotIndex}\u0001${occurrenceIndex}`;
    if (roleKeys.has(key)) return { issue: { code: LANGUAGE_CONSTRUCTION_MEMORY_REJECTION_IDS.duplicate, evidenceId: observation.evidenceId } };
    roleKeys.add(key);
    durableRoles.push({
      slotIndex: role.slotIndex,
      occurrenceIndex,
      roleId: languageConstructionRoleId(input.hasher, input.bindingId, role.slotIndex),
      occurrenceId: languageConstructionOccurrenceId(input.hasher, input.bindingId, role.slotIndex, occurrenceIndex),
      startCodePoint: role.startCodePoint,
      endCodePoint: role.endCodePoint,
      surface: surfacePoints.slice(role.startCodePoint, role.endCodePoint).join("")
    });
  }
  const durableNullRoles: DurableSourceConstructionExample["nullRoles"] = [];
  for (const role of observation.nullRoles ?? []) {
    const occurrenceIndex = role.occurrenceIndex ?? 0;
    if (!validIndex(role.slotIndex) || !validIndex(occurrenceIndex)) {
      return { issue: { code: LANGUAGE_CONSTRUCTION_MEMORY_REJECTION_IDS.coordinates, evidenceId: observation.evidenceId } };
    }
    const key = `${role.slotIndex}\u0001${occurrenceIndex}`;
    if (roleKeys.has(key)) return { issue: { code: LANGUAGE_CONSTRUCTION_MEMORY_REJECTION_IDS.duplicate, evidenceId: observation.evidenceId } };
    roleKeys.add(key);
    durableNullRoles.push({
      slotIndex: role.slotIndex,
      occurrenceIndex,
      roleId: languageConstructionRoleId(input.hasher, input.bindingId, role.slotIndex),
      occurrenceId: languageConstructionOccurrenceId(input.hasher, input.bindingId, role.slotIndex, occurrenceIndex)
    });
  }
  durableRoles.sort(compareDurableRoles);
  durableNullRoles.sort(compareDurableNullRoles);
  const sourceVersionId = String(evidence.sourceVersionId);
  const evidenceId = String(evidence.id);
  const evidenceContentHash = String(evidence.contentHash);
  const surfaceDigest = input.hasher.digestHex(surface);
  const id = stableId(input.hasher, "surface.construction.example", [
    input.bindingId,
    input.profileId,
    sourceVersionId,
    evidenceId,
    evidenceContentHash,
    evidence.charStart,
    evidence.charEnd,
    observation.surfaceStartCodePoint,
    observation.surfaceEndCodePoint,
    surfaceDigest,
    durableRoles,
    durableNullRoles
  ]);
  const durable: DurableSourceConstructionExample = {
    id,
    bindingId: input.bindingId,
    sourceProfileId: input.profileId,
    targetProfileId: input.profileId,
    sourceVersionId,
    evidenceId,
    evidenceContentHash,
    evidenceCharStart: evidence.charStart,
    evidenceCharEnd: evidence.charEnd,
    surfaceStartCodePoint: observation.surfaceStartCodePoint,
    surfaceEndCodePoint: observation.surfaceEndCodePoint,
    surface,
    surfaceDigest,
    roles: durableRoles,
    nullRoles: durableNullRoles
  };
  const aligned: AlignedSurfaceExample = {
    id,
    profileKey: input.profileId,
    surface,
    evidenceIds: [evidenceId],
    roleSpans: durableRoles.map(role => ({
      roleId: role.roleId,
      occurrenceId: role.occurrenceId,
      start: utf16OffsetAtCodePoint(surface, role.startCodePoint),
      end: utf16OffsetAtCodePoint(surface, role.endCodePoint),
      surface: role.surface,
      evidenceIds: [evidenceId]
    })),
    nullRoleOccurrences: durableNullRoles.map(role => ({
      roleId: role.roleId,
      occurrenceId: role.occurrenceId,
      evidenceIds: [evidenceId]
    }))
  };
  return { durable, aligned };
}

function verifyPersistedPattern(
  pattern: LanguagePatternRecord,
  evidenceById: ReadonlyMap<string, EvidenceSpan>,
  hasher: Hasher
): { bundle: DurableLanguageConstructionBundle } | { issue: LanguageConstructionMemoryIssue } {
  const row = recordOf(pattern.patternJson);
  const rawBundle = recordOf(row.bundle);
  if (row.schema !== LANGUAGE_CONSTRUCTION_PATTERN_SCHEMA
    || rawBundle.schema !== LANGUAGE_CONSTRUCTION_PATTERN_SCHEMA) {
    return issue(pattern, LANGUAGE_CONSTRUCTION_MEMORY_REJECTION_IDS.input);
  }
  const bindingId = stringOf(rawBundle.bindingId);
  const sourceProfileId = stringOf(rawBundle.sourceProfileId);
  const targetProfileId = stringOf(rawBundle.targetProfileId);
  if (!bindingId || !sourceProfileId || !targetProfileId
    || sourceProfileId !== targetProfileId
    || pattern.profileId !== targetProfileId) {
    return issue(pattern, LANGUAGE_CONSTRUCTION_MEMORY_REJECTION_IDS.ownership);
  }
  const sourceExamples = arrayOfRecords(rawBundle.sourceExamples);
  if (sourceExamples.length === 0 || sourceExamples.length > 256) {
    return issue(pattern, LANGUAGE_CONSTRUCTION_MEMORY_REJECTION_IDS.member);
  }
  const observations: SourceBoundConstructionObservation[] = [];
  for (const raw of sourceExamples) {
    const parsed = observationFromPersistedExample(raw, {
      bindingId,
      sourceProfileId,
      targetProfileId,
      evidenceById
    });
    if ("code" in parsed) return { issue: { ...parsed, patternId: pattern.id, profileId: pattern.profileId } };
    observations.push(parsed.observation);
  }
  const evidenceIds = uniqueSorted(observations.map(item => item.evidenceId));
  const evidence = evidenceIds.map(id => evidenceById.get(id)).filter((item): item is EvidenceSpan => Boolean(item));
  if (evidence.length !== evidenceIds.length) return issue(pattern, LANGUAGE_CONSTRUCTION_MEMORY_REJECTION_IDS.evidence);
  const recompiled = compileLanguageConstructionPattern({
    bindingId,
    profileId: targetProfileId,
    observations,
    evidence,
    hasher,
    updatedAt: pattern.updatedAt
  });
  if (recompiled.status !== "compiled") return issue(pattern, LANGUAGE_CONSTRUCTION_MEMORY_REJECTION_IDS.member);
  const expectedRow = recordOf(recompiled.pattern.patternJson);
  if (stringOf(row.contentDigest) !== recompiled.bundle.contentDigest
    || pattern.id !== recompiled.pattern.id
    || pattern.patternKind !== recompiled.pattern.patternKind
    || pattern.profileId !== recompiled.pattern.profileId
    || pattern.support !== recompiled.pattern.support
    || pattern.entropy !== recompiled.pattern.entropy
    || !sameStrings(pattern.evidenceIds.map(String), recompiled.pattern.evidenceIds.map(String))) {
    return issue(pattern, pattern.id !== recompiled.pattern.id
      ? LANGUAGE_CONSTRUCTION_MEMORY_REJECTION_IDS.identity
      : LANGUAGE_CONSTRUCTION_MEMORY_REJECTION_IDS.digest);
  }
  if (canonicalStringify(rawBundle) !== canonicalStringify(recordOf(expectedRow.bundle))) {
    return issue(pattern, LANGUAGE_CONSTRUCTION_MEMORY_REJECTION_IDS.member);
  }
  return { bundle: recompiled.bundle };
}

function observationFromPersistedExample(
  raw: Record<string, JsonValue>,
  ownership: {
    bindingId: string;
    sourceProfileId: string;
    targetProfileId: string;
    evidenceById: ReadonlyMap<string, EvidenceSpan>;
  }
): { observation: SourceBoundConstructionObservation } | LanguageConstructionMemoryIssue {
  const evidenceId = stringOf(raw.evidenceId);
  const sourceVersionId = stringOf(raw.sourceVersionId);
  if (!evidenceId || !sourceVersionId
    || stringOf(raw.bindingId) !== ownership.bindingId
    || stringOf(raw.sourceProfileId) !== ownership.sourceProfileId
    || stringOf(raw.targetProfileId) !== ownership.targetProfileId) {
    return { code: LANGUAGE_CONSTRUCTION_MEMORY_REJECTION_IDS.ownership, evidenceId, sourceVersionId };
  }
  const evidence = ownership.evidenceById.get(evidenceId);
  if (!evidence
    || String(evidence.sourceVersionId) !== sourceVersionId
    || String(evidence.contentHash) !== stringOf(raw.evidenceContentHash)
    || evidence.charStart !== numberOf(raw.evidenceCharStart)
    || evidence.charEnd !== numberOf(raw.evidenceCharEnd)) {
    return { code: LANGUAGE_CONSTRUCTION_MEMORY_REJECTION_IDS.evidence, evidenceId, sourceVersionId };
  }
  const roles = arrayOfRecords(raw.roles).map(role => ({
    slotIndex: numberOf(role.slotIndex),
    occurrenceIndex: numberOf(role.occurrenceIndex),
    startCodePoint: numberOf(role.startCodePoint),
    endCodePoint: numberOf(role.endCodePoint)
  }));
  const nullRoles = arrayOfRecords(raw.nullRoles).map(role => ({
    slotIndex: numberOf(role.slotIndex),
    occurrenceIndex: numberOf(role.occurrenceIndex)
  }));
  const observation: SourceBoundConstructionObservation = {
    sourceVersionId,
    evidenceId,
    surfaceStartCodePoint: numberOf(raw.surfaceStartCodePoint),
    surfaceEndCodePoint: numberOf(raw.surfaceEndCodePoint),
    roles,
    nullRoles
  };
  const points = [...evidence.text];
  const surface = points.slice(observation.surfaceStartCodePoint, observation.surfaceEndCodePoint).join("");
  if (surface !== stringOf(raw.surface)
    || stringOf(raw.surfaceDigest) === undefined
    || roles.some((role, index) => {
      const roleRaw = arrayOfRecords(raw.roles)[index];
      return !roleRaw
        || surface.slice(
          utf16OffsetAtCodePoint(surface, role.startCodePoint),
          utf16OffsetAtCodePoint(surface, role.endCodePoint)
        ) !== stringOf(roleRaw.surface);
    })) {
    return { code: LANGUAGE_CONSTRUCTION_MEMORY_REJECTION_IDS.coordinates, evidenceId, sourceVersionId };
  }
  return { observation };
}

function rejected(code: LanguageConstructionMemoryRejectionId): LanguageConstructionPatternCompilation {
  return { status: "rejected", issues: [{ code }] };
}

function issue(
  pattern: LanguagePatternRecord,
  code: LanguageConstructionMemoryRejectionId
): { issue: LanguageConstructionMemoryIssue } {
  return { issue: { code, patternId: pattern.id, profileId: pattern.profileId } };
}

function stableId(hasher: Hasher, prefix: string, value: unknown): string {
  return `${prefix}.${hasher.digestHex(canonicalStringify([prefix, value]))}`;
}

function checkedIndex(value: number): number {
  if (!validIndex(value)) throw new Error("invalid surface construction index");
  return value;
}

function validIndex(value: number): boolean {
  return Number.isSafeInteger(value) && value >= 0 && value <= 4096;
}

function validRange(start: number, end: number, length: number): boolean {
  return Number.isSafeInteger(start)
    && Number.isSafeInteger(end)
    && start >= 0
    && end >= start
    && end <= length;
}

function utf16OffsetAtCodePoint(surface: string, offset: number): number {
  return [...surface].slice(0, offset).join("").length;
}

function uniqueEvidenceById(evidence: readonly EvidenceSpan[]): Map<string, EvidenceSpan> | undefined {
  const out = new Map<string, EvidenceSpan>();
  for (const span of evidence) {
    const id = String(span.id);
    if (out.has(id)) return undefined;
    out.set(id, span);
  }
  return out;
}

function minimumSupport(values: readonly number[]): number {
  return values.length ? Math.min(...values) : 0;
}

function firstDuplicate(values: readonly string[]): string | undefined {
  const seen = new Set<string>();
  for (const value of values) {
    if (seen.has(value)) return value;
    seen.add(value);
  }
  return undefined;
}

function duplicateValues(values: readonly string[]): Set<string> {
  const seen = new Set<string>();
  const duplicates = new Set<string>();
  for (const value of values) {
    if (seen.has(value)) duplicates.add(value);
    seen.add(value);
  }
  return duplicates;
}

function uniqueSorted(values: readonly string[]): string[] {
  return [...new Set(values)].sort(compareText);
}

function sameStrings(left: readonly string[], right: readonly string[]): boolean {
  const a = uniqueSorted(left);
  const b = uniqueSorted(right);
  return a.length === b.length && a.every((value, index) => value === b[index]);
}

function recordOf(value: JsonValue | undefined): Record<string, JsonValue> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, JsonValue>
    : {};
}

function arrayOfRecords(value: JsonValue | undefined): Array<Record<string, JsonValue>> {
  return Array.isArray(value)
    ? value.filter((item): item is Record<string, JsonValue> => Boolean(item && typeof item === "object" && !Array.isArray(item)))
    : [];
}

function stringOf(value: JsonValue | undefined): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function numberOf(value: JsonValue | undefined): number {
  return typeof value === "number" && Number.isFinite(value) ? value : Number.NaN;
}

function nonempty(value: string): boolean {
  return value.length > 0 && value.trim().length > 0 && !value.includes("\u0000");
}

function compareDurableExamples(left: DurableSourceConstructionExample, right: DurableSourceConstructionExample): number {
  return compareText(left.id, right.id);
}

function compareDurableRoles(
  left: DurableSourceConstructionExample["roles"][number],
  right: DurableSourceConstructionExample["roles"][number]
): number {
  return left.slotIndex - right.slotIndex
    || left.occurrenceIndex - right.occurrenceIndex
    || left.startCodePoint - right.startCodePoint
    || compareText(left.occurrenceId, right.occurrenceId);
}

function compareDurableNullRoles(
  left: DurableSourceConstructionExample["nullRoles"][number],
  right: DurableSourceConstructionExample["nullRoles"][number]
): number {
  return left.slotIndex - right.slotIndex
    || left.occurrenceIndex - right.occurrenceIndex
    || compareText(left.occurrenceId, right.occurrenceId);
}

function compareIssues(left: LanguageConstructionMemoryIssue, right: LanguageConstructionMemoryIssue): number {
  return compareText(left.patternId ?? "", right.patternId ?? "")
    || compareText(left.code, right.code)
    || compareText(left.evidenceId ?? "", right.evidenceId ?? "");
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
