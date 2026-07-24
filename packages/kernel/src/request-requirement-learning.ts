import { clamp01, toJsonValue } from "./primitives.js";
import {
  authorityRequirementCoefficients,
  REQUESTED_AUTHORITY_IDS
} from "./request-authority.js";
import type { LanguagePatternRecord } from "./storage.js";
import {
  TURN_REQUIREMENT_DIMENSIONS,
  normalizeResponseFormSurfaceLayout,
  type ResponseFormSurfaceLayout,
  type TurnRequirementDimension
} from "./turn-requirements.js";
import type { EvidenceId, JsonValue, RequestedAuthority, SourceVersionId } from "./types.js";
import { unicodeLexicalSegments } from "./unicode-segmentation.js";

export const REQUEST_REQUIREMENT_CORPUS_SCHEMA = "scce.request_requirement_corpus.v1";

export interface RequestRequirementCorpusExample {
  text: string;
  authority: RequestedAuthority;
  requirements?: Partial<Record<TurnRequirementDimension, number>>;
  /**
   * Corpus-owned, language-neutral response-form identity. The runtime treats
   * this as an opaque ID; any human-readable label remains source metadata.
   */
  responseFormId?: string;
  responseFormSourceLabel?: string;
  responseExtent?: {
    unitSurface: string;
    quantity: number;
    wordsPerUnit: number;
  };
}

export interface RequestRequirementCorpus {
  schema: typeof REQUEST_REQUIREMENT_CORPUS_SCHEMA;
  language: string;
  corpusRevision?: string;
  responseFormProfiles?: RequestRequirementResponseFormProfile[];
  examples: RequestRequirementCorpusExample[];
}

export interface RequestRequirementResponseFormProfile {
  id: string;
  sourceLabel?: string;
  surfaceLayout: ResponseFormSurfaceLayout;
}

export interface CompileRequestRequirementCorpusInput {
  corpus: RequestRequirementCorpus;
  profileId: string;
  sourceVersionId: SourceVersionId;
  evidenceIds: readonly EvidenceId[];
  sourceSystem: string;
  updatedAt: number;
  makeId(representation: JsonValue): string;
}

export interface CompiledRequestRequirementCorpus {
  patterns: LanguagePatternRecord[];
  audit: JsonValue;
}

interface FeatureObservation {
  key: string;
  surface: string;
  anchor: "start" | "any" | "end";
}

interface FeatureCounts {
  observation: FeatureObservation;
  examples: number;
  byAuthority: Record<RequestedAuthority, number>;
  requirementTotals: Partial<Record<TurnRequirementDimension, number>>;
  responseFormExamples: number;
  responseFormCounts: Record<string, number>;
  responseFormSourceLabels: Record<string, Record<string, number>>;
  responseExtent?: {
    unitSurface: string;
    wordsPerUnitTotal: number;
    examples: number;
  };
}

export function parseRequestRequirementCorpus(text: string): RequestRequirementCorpus | undefined {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return undefined;
  }
  if (!isRecord(value) || value.schema !== REQUEST_REQUIREMENT_CORPUS_SCHEMA || !Array.isArray(value.examples)) return undefined;
  const language = typeof value.language === "string" && value.language.trim() ? value.language.trim() : "und";
  const corpusRevision = typeof value.corpusRevision === "string"
    && value.corpusRevision.trim()
    && [...value.corpusRevision.trim()].length <= 128
    ? value.corpusRevision.trim()
    : undefined;
  const responseFormProfiles = parseResponseFormProfiles(value.responseFormProfiles);
  const examples: RequestRequirementCorpusExample[] = [];
  for (const row of value.examples.slice(0, 10_000)) {
    if (!isRecord(row) || typeof row.text !== "string" || !isRequestedAuthority(row.authority)) continue;
    const surface = row.text.trim();
    if (!surface || [...surface].length > 20_000) continue;
    examples.push({
      text: surface,
      authority: row.authority,
      ...(isRecord(row.requirements) ? { requirements: requirementVector(row.requirements) } : {}),
      ...(responseFormId(row.responseFormId) ? {
        responseFormId: responseFormId(row.responseFormId),
        ...(sourceLabel(row.responseFormSourceLabel) ? {
          responseFormSourceLabel: sourceLabel(row.responseFormSourceLabel)
        } : {})
      } : {}),
      ...(responseExtentAnnotation(row.responseExtent) ? { responseExtent: responseExtentAnnotation(row.responseExtent) } : {})
    });
  }
  if (!examples.length) return undefined;
  return {
    schema: REQUEST_REQUIREMENT_CORPUS_SCHEMA,
    language,
    ...(corpusRevision ? { corpusRevision } : {}),
    ...(responseFormProfiles.length ? { responseFormProfiles } : {}),
    examples
  };
}

export function requestRequirementCorpusLanguageText(corpus: RequestRequirementCorpus): string {
  return corpus.examples.map(example => example.text).join("\n");
}

export function isRequestRequirementPattern(pattern: LanguagePatternRecord): boolean {
  const value = pattern.patternJson;
  return Boolean(
    value
    && typeof value === "object"
    && !Array.isArray(value)
    && value.schema === "scce.request_requirement_pattern.v1"
  );
}

/**
 * Compiles source-backed request examples into sparse, inspectable patterns.
 * Topic words survive only when they recur with a stable authority label.
 */
export function compileRequestRequirementCorpus(
  input: CompileRequestRequirementCorpusInput
): CompiledRequestRequirementCorpus {
  const classTotals = authorityRecord(0);
  const featureCounts = new Map<string, FeatureCounts>();
  for (const example of input.corpus.examples) {
    classTotals[example.authority] += 1;
    for (const observation of uniqueFeatures(requestFeatures(example.text))) {
      const counts = featureCounts.get(observation.key) ?? {
        observation,
        examples: 0,
        byAuthority: authorityRecord(0),
        requirementTotals: {},
        responseFormExamples: 0,
        responseFormCounts: {},
        responseFormSourceLabels: {}
      };
      counts.examples += 1;
      counts.byAuthority[example.authority] += 1;
      const prototype = {
        ...authorityRequirementCoefficients(example.authority),
        ...(example.requirements ?? {})
      };
      for (const dimension of TURN_REQUIREMENT_DIMENSIONS) {
        const value = prototype[dimension];
        if (value === undefined || !Number.isFinite(value)) continue;
        counts.requirementTotals[dimension] = (counts.requirementTotals[dimension] ?? 0) + value;
      }
      if (example.responseFormId) {
        counts.responseFormExamples += 1;
        counts.responseFormCounts[example.responseFormId] = (counts.responseFormCounts[example.responseFormId] ?? 0) + 1;
        if (example.responseFormSourceLabel) {
          const labels = counts.responseFormSourceLabels[example.responseFormId] ?? {};
          labels[example.responseFormSourceLabel] = (labels[example.responseFormSourceLabel] ?? 0) + 1;
          counts.responseFormSourceLabels[example.responseFormId] = labels;
        }
      }
      const extent = example.responseExtent;
      if (extent && featureContainsUnitSurface(observation, extent.unitSurface)) {
        const previous = counts.responseExtent;
        if (!previous || previous.unitSurface === normalizedUnitSurface(extent.unitSurface)) {
          counts.responseExtent = {
            unitSurface: normalizedUnitSurface(extent.unitSurface),
            wordsPerUnitTotal: (previous?.wordsPerUnitTotal ?? 0) + extent.wordsPerUnit,
            examples: (previous?.examples ?? 0) + 1
          };
        }
      }
      featureCounts.set(observation.key, counts);
    }
  }

  const evidenceIds = [...new Set(input.evidenceIds.map(String))]
    .sort()
    .slice(0, 64) as EvidenceId[];
  const patterns = [...featureCounts.values()].flatMap(counts => {
    const ranked = REQUESTED_AUTHORITY_IDS
      .map(authority => ({ authority, count: counts.byAuthority[authority] }))
      .sort((left, right) => right.count - left.count || left.authority.localeCompare(right.authority));
    const winner = ranked[0];
    const runnerUp = ranked[1];
    if (!winner || winner.count < 2) return [];
    const posterior = winner.count / Math.max(1, counts.examples);
    const margin = (winner.count - (runnerUp?.count ?? 0)) / Math.max(1, counts.examples);
    if (posterior < 0.68 || margin < 0.34) return [];
    const classCoverage = winner.count / Math.max(1, classTotals[winner.authority]);
    const reliability = clamp01(0.45 * posterior + 0.35 * margin + 0.20 * Math.min(1, winner.count / 8));
    const activationScale = 0.72 + 0.58 * reliability;
    const requirementCoefficients: Partial<Record<TurnRequirementDimension, number>> = {};
    for (const dimension of TURN_REQUIREMENT_DIMENSIONS) {
      const total = counts.requirementTotals[dimension];
      if (total !== undefined) requirementCoefficients[dimension] = (total / counts.examples) * activationScale;
    }
    const responseForm = compiledResponseForm(counts, input.corpus.responseFormProfiles);
    const patternJson = toJsonValue({
      schema: "scce.request_requirement_pattern.v1",
      surface: counts.observation.surface,
      anchor: counts.observation.anchor,
      matchMode: "unicode_token_ngram",
      semanticRoleId: "role.request.requirement.v1",
      learnedFrameOrPatternId: counts.observation.key,
      requirementCoefficients,
      authorityMass: counts.byAuthority,
      selectedAuthority: winner.authority,
      posterior,
      margin,
      exampleSupport: counts.examples,
      ...(responseForm ? { responseForm } : {}),
      ...(counts.responseExtent && counts.responseExtent.examples >= 2 ? {
        responseExtent: {
          unitSurface: counts.responseExtent.unitSurface,
          wordsPerUnit: counts.responseExtent.wordsPerUnitTotal / counts.responseExtent.examples,
          exampleSupport: counts.responseExtent.examples,
          quantitySource: "adjacent_request_number"
        }
      } : {}),
      sourceSystem: input.sourceSystem,
      sourceVersionId: input.sourceVersionId,
      provenanceClass: "learned_language_prior"
    });
    return [{
      id: input.makeId(patternJson),
      profileId: input.profileId,
      patternKind: "semantic_role" as const,
      support: clamp01(0.58 + 0.28 * reliability + 0.14 * Math.min(1, classCoverage * 4)),
      entropy: normalizedEntropy(counts.byAuthority, counts.examples),
      patternJson,
      evidenceIds,
      updatedAt: input.updatedAt
    }];
  }).sort((left, right) =>
    right.support - left.support
    || left.entropy - right.entropy
    || left.id.localeCompare(right.id)
  ).slice(0, 2048);

  return {
    patterns,
    audit: toJsonValue({
      schema: "scce.request_requirement_learning_report.v1",
      corpusSchema: input.corpus.schema,
      corpusRevision: input.corpus.corpusRevision ?? null,
      language: input.corpus.language,
      examples: input.corpus.examples.length,
      featureCandidates: featureCounts.size,
      learnedPatterns: patterns.length,
      classTotals,
      responseFormTotals: responseFormRecord(input.corpus.examples),
      responseFormAnnotatedExamples: input.corpus.examples.filter(example => example.responseFormId).length,
      responseFormProfileIds: (input.corpus.responseFormProfiles ?? []).map(profile => profile.id),
      sourceVersionId: input.sourceVersionId,
      evidenceIds,
      sourceSystem: input.sourceSystem,
      transparentSparsePatterns: true,
      hiddenWeights: false
    })
  };
}

function compiledResponseForm(
  counts: FeatureCounts,
  profiles: readonly RequestRequirementResponseFormProfile[] | undefined
): {
  id: string;
  posterior: number;
  margin: number;
  exampleSupport: number;
  annotatedExamples: number;
  sourceLabel?: string;
  surfaceLayout?: ResponseFormSurfaceLayout;
} | undefined {
  if (counts.responseFormExamples < 2) return undefined;
  const ranked = Object.entries(counts.responseFormCounts)
    .map(([id, count]) => ({ id, count }))
    .sort((left, right) => right.count - left.count || left.id.localeCompare(right.id));
  const winner = ranked[0];
  const runnerUp = ranked[1];
  if (!winner || winner.count < 2) return undefined;
  const noFormCount = Math.max(0, counts.examples - counts.responseFormExamples);
  const competingCount = Math.max(runnerUp?.count ?? 0, noFormCount);
  const posterior = winner.count / counts.examples;
  const margin = (winner.count - competingCount) / counts.examples;
  if (posterior < 0.68 || margin < 0.34) return undefined;
  const sourceLabel = Object.entries(counts.responseFormSourceLabels[winner.id] ?? {})
    .sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]))[0]?.[0];
  const profile = profiles?.find(candidate => candidate.id === winner.id);
  return {
    id: winner.id,
    posterior,
    margin,
    exampleSupport: winner.count,
    annotatedExamples: counts.responseFormExamples,
    ...(sourceLabel || profile?.sourceLabel ? { sourceLabel: sourceLabel ?? profile?.sourceLabel } : {}),
    ...(profile?.surfaceLayout ? { surfaceLayout: profile.surfaceLayout } : {})
  };
}

function parseResponseFormProfiles(value: unknown): RequestRequirementResponseFormProfile[] {
  if (!Array.isArray(value)) return [];
  const byId = new Map<string, RequestRequirementResponseFormProfile>();
  for (const row of value.slice(0, 256)) {
    if (!isRecord(row)) continue;
    const id = responseFormId(row.id);
    const layout = responseFormSurfaceLayoutAnnotation(row.surfaceLayout);
    if (!id || !layout || byId.has(id)) continue;
    const label = sourceLabel(row.sourceLabel);
    byId.set(id, {
      id,
      ...(label ? { sourceLabel: label } : {}),
      surfaceLayout: layout
    });
  }
  return [...byId.values()].sort((left, right) => left.id.localeCompare(right.id));
}

function responseFormSurfaceLayoutAnnotation(value: unknown): ResponseFormSurfaceLayout | undefined {
  if (!isRecord(value) || typeof value.sentencesPerBlock !== "number") return undefined;
  return normalizeResponseFormSurfaceLayout({
    sentencesPerBlock: value.sentencesPerBlock,
    ...(typeof value.wordsPerLine === "number" ? { wordsPerLine: value.wordsPerLine } : {}),
    ...(value.orderedBlocks === true ? { orderedBlocks: true } : {}),
    ...(value.subjectCuePerBlock === true ? { subjectCuePerBlock: true } : {}),
    ...(value.subjectSignature === true ? { subjectSignature: true } : {})
  });
}

function requestFeatures(text: string): FeatureObservation[] {
  const tokens = unicodeTokens(text);
  if (!tokens.length) return [];
  const rows: FeatureObservation[] = [];
  const add = (surfaceTokens: readonly string[], anchor: FeatureObservation["anchor"]) => {
    if (!surfaceTokens.length) return;
    const surface = surfaceTokens.join(" ");
    rows.push({ key: `${anchor}:${surface}`, surface, anchor });
  };
  for (let width = 1; width <= Math.min(3, tokens.length); width++) {
    add(tokens.slice(0, width), "start");
    add(tokens.slice(tokens.length - width), "end");
  }
  for (let width = 1; width <= 3; width++) {
    for (let index = 0; index + width <= tokens.length; index++) add(tokens.slice(index, index + width), "any");
  }
  return rows;
}

function uniqueFeatures(rows: readonly FeatureObservation[]): FeatureObservation[] {
  const byKey = new Map<string, FeatureObservation>();
  for (const row of rows) if (!byKey.has(row.key)) byKey.set(row.key, row);
  return [...byKey.values()];
}

function unicodeTokens(text: string): string[] {
  return unicodeLexicalSegments(text)
    .map(segment => segment.normalized)
    .map(token => token.trim())
    .filter(Boolean)
    .slice(0, 512);
}

function normalizedEntropy(counts: Record<RequestedAuthority, number>, total: number): number {
  if (total <= 1) return 0;
  let entropy = 0;
  let occupied = 0;
  for (const count of Object.values(counts)) {
    if (count <= 0) continue;
    occupied += 1;
    const probability = count / total;
    entropy -= probability * Math.log(probability);
  }
  return occupied <= 1 ? 0 : clamp01(entropy / Math.log(REQUESTED_AUTHORITY_IDS.length));
}

function authorityRecord(value: number): Record<RequestedAuthority, number> {
  return Object.fromEntries(REQUESTED_AUTHORITY_IDS.map(authority => [authority, value])) as Record<RequestedAuthority, number>;
}

function requirementVector(value: Record<string, unknown>): Partial<Record<TurnRequirementDimension, number>> {
  const out: Partial<Record<TurnRequirementDimension, number>> = {};
  for (const dimension of TURN_REQUIREMENT_DIMENSIONS) {
    const coefficient = value[dimension];
    if (typeof coefficient === "number" && Number.isFinite(coefficient)) out[dimension] = coefficient;
  }
  return out;
}

function responseExtentAnnotation(value: unknown): RequestRequirementCorpusExample["responseExtent"] | undefined {
  if (!isRecord(value)) return undefined;
  const unitSurface = typeof value.unitSurface === "string" ? normalizedUnitSurface(value.unitSurface) : "";
  const quantity = typeof value.quantity === "number" ? value.quantity : Number.NaN;
  const wordsPerUnit = typeof value.wordsPerUnit === "number" ? value.wordsPerUnit : Number.NaN;
  if (!unitSurface || !Number.isFinite(quantity) || quantity <= 0 || !Number.isFinite(wordsPerUnit) || wordsPerUnit <= 0) return undefined;
  return { unitSurface, quantity, wordsPerUnit };
}

function responseFormRecord(
  examples: readonly RequestRequirementCorpusExample[]
): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const example of examples) {
    if (!example.responseFormId) continue;
    counts[example.responseFormId] = (counts[example.responseFormId] ?? 0) + 1;
  }
  return Object.fromEntries(Object.entries(counts).sort(([left], [right]) => left.localeCompare(right)));
}

function responseFormId(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const id = value.trim();
  return /^[A-Za-z0-9][A-Za-z0-9._:-]{2,127}$/u.test(id) ? id : undefined;
}

function sourceLabel(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const label = value.normalize("NFKC").trim();
  return label && [...label].length <= 256 ? label : undefined;
}

function featureContainsUnitSurface(observation: FeatureObservation, unitSurface: string): boolean {
  const unit = normalizedUnitSurface(unitSurface);
  return unicodeTokens(observation.surface).includes(unit);
}

function normalizedUnitSurface(value: string): string {
  return unicodeTokens(value)[0] ?? "";
}

function isRequestedAuthority(value: unknown): value is RequestedAuthority {
  return typeof value === "string" && (REQUESTED_AUTHORITY_IDS as readonly string[]).includes(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
