// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
import { canonicalDigestHex } from "./canonical-json-digest.js";
import { codeSurfaceTokens } from "./code-surface.js";
import { CORPUS_ROLE_IDS, corpusRoleIdForSourceSystem, corpusSourceAlias } from "./corpus-registry.js";
import type { IdFactory } from "./ids.js";
import { learnedScriptIdForCharacter } from "./language.js";
import { clamp01, featureSet, stableVector, symbolizeData, toJsonValue } from "./primitives.js";
import type { LanguageUnitRecord, SemanticFrameRecord } from "./storage.js";
import { buildNgramSurfaceProjection } from "./surface-lattice.js";
import { LANGUAGE_TRAINING_CHUNK_UTF16_LIMIT } from "./language-training-recipe.js";
import type { EvidenceSpan, Hasher, JsonValue, LanguageProfile, SourceVersionId } from "./types.js";
import { containsSourceRoleProjectionBlank, isSourceRoleProjectionBlankCodePoint } from "./unicode-segmentation.js";

export const SOURCE_LANGUAGE_ARTIFACT_DERIVATION_SCHEMA = "scce.source_language_artifact_derivation.v1" as const;

export interface SourceLanguageArtifactCompilerOptions {
  maxOrder: number;
  maxCountersPerOrder: number;
  vocabularyLimit: number;
  retainObservations: boolean;
  retainSemanticFrames: boolean;
}

export interface SourceLanguageArtifactDerivationLimits {
  maxSourceUtf16Units: number;
  maxSourceUtf8Bytes: number;
  maxEvidenceSpans: number;
  maxEvidenceUtf8Bytes: number;
  maxArtifactJsonUtf8Bytes: number;
}

/**
 * These are safety ceilings, not truncation policies. Production source
 * chunking is expected to stay far below them; exceeding one rejects replay
 * rather than silently deriving a different artifact set.
 */
export const DEFAULT_SOURCE_LANGUAGE_ARTIFACT_DERIVATION_LIMITS: Readonly<SourceLanguageArtifactDerivationLimits> = Object.freeze({
  maxSourceUtf16Units: LANGUAGE_TRAINING_CHUNK_UTF16_LIMIT,
  maxSourceUtf8Bytes: LANGUAGE_TRAINING_CHUNK_UTF16_LIMIT * 4,
  maxEvidenceSpans: 16_384,
  maxEvidenceUtf8Bytes: 256 * 1024 * 1024,
  maxArtifactJsonUtf8Bytes: 128 * 1024 * 1024
});

export const MAX_SOURCE_LANGUAGE_COUNTERS_PER_ORDER = LANGUAGE_TRAINING_CHUNK_UTF16_LIMIT;
export const MAX_SOURCE_LANGUAGE_VOCABULARY = LANGUAGE_TRAINING_CHUNK_UTF16_LIMIT;

export interface SourceLanguageArtifactDerivationReceipt {
  schema: typeof SOURCE_LANGUAGE_ARTIFACT_DERIVATION_SCHEMA;
  streamIdHash: string;
  sourceVersionIdHash: string;
  sourceSystem: string | null;
  sourceTextHash: string;
  sourceUtf8Bytes: number;
  profileDependencyDigest: string;
  evidenceDependencyDigest: string;
  evidenceCount: number;
  createdAt: number;
  compilerOptions: SourceLanguageArtifactCompilerOptions;
  /** Digest of all replay inputs that can affect the derived rows. */
  dependencyId: string;
  /** IDs, order, scalar fields and PostgreSQL-visible Float32 vector values. */
  artifactStorageDigest: string;
  derivationId: string;
}

type SourceLanguageArtifactDerivationDependency = Omit<SourceLanguageArtifactDerivationReceipt,
  "dependencyId" | "artifactStorageDigest" | "derivationId"> & { dependencyId: string };

export interface SourceLanguageArtifactDerivationMeasurement {
  /** Decoded UTF-8 bytes read from the canonical source string. */
  sourceUtf8Bytes: number;
  /** Decoded UTF-8 bytes present in evidence text and preview strings. */
  evidenceUtf8Bytes: number;
  /** Exact UTF-8 JSON bytes of the materialized unit and frame rows. */
  artifactJsonUtf8Bytes: number;
  surfaceSymbols: number;
  graphemes: number;
  units: number;
  semanticFrames: number;
  vectorScalars: number;
  /**
   * A deterministic implementation-cost counter, suitable for before/after
   * comparison without wall-clock noise. It is not a latency claim.
   */
  reconstructionWorkUnits: number;
}

export interface SourceLanguageArtifactProjection {
  sourceSystem?: string;
  formalCode: boolean;
  symbols: string[];
  graphemes: string[];
  surfaceLatticeId?: string;
  surfaceLatticeSchema?: string;
  sourceTextHash: string;
}

export interface SourceLanguageArtifactDerivation {
  units: LanguageUnitRecord[];
  semanticFrames: SemanticFrameRecord[];
  projection: SourceLanguageArtifactProjection;
  receipt: SourceLanguageArtifactDerivationReceipt;
  measurement: SourceLanguageArtifactDerivationMeasurement;
}

export interface SourceLanguageArtifactDerivationInput {
  streamId: string;
  sourceSystem?: string;
  profile: LanguageProfile;
  sourceVersionId: SourceVersionId;
  text: string;
  evidence: readonly EvidenceSpan[];
  createdAt: number;
  compilerOptions: SourceLanguageArtifactCompilerOptions;
  idFactory: IdFactory;
  hasher: Hasher;
  limits?: Partial<SourceLanguageArtifactDerivationLimits>;
  /** A durable receipt supplied during replay. Its version, integrity and dependencies are checked before returning. */
  expectedReceipt?: SourceLanguageArtifactDerivationReceipt;
}

export function normalizeSourceLanguageArtifactCompilerOptions(input: {
  maxOrder?: number;
  maxCountersPerOrder?: number;
  vocabularyLimit?: number;
  retainObservations?: boolean;
  retainSemanticFrames?: boolean;
}): SourceLanguageArtifactCompilerOptions {
  const maxOrder = Math.max(1, Math.min(6, input.maxOrder ?? 6));
  const maxCountersPerOrder = Math.max(32, input.maxCountersPerOrder ?? 50_000);
  const vocabularyLimit = input.vocabularyLimit ?? 24_000;
  if (!Number.isSafeInteger(maxOrder) || !Number.isSafeInteger(maxCountersPerOrder)
    || maxCountersPerOrder > MAX_SOURCE_LANGUAGE_COUNTERS_PER_ORDER
    || !Number.isSafeInteger(vocabularyLimit) || vocabularyLimit < 1 || vocabularyLimit > MAX_SOURCE_LANGUAGE_VOCABULARY) {
    throw new Error("source language artifact compiler options must be positive bounded integers");
  }
  return {
    maxOrder,
    maxCountersPerOrder,
    vocabularyLimit,
    retainObservations: input.retainObservations !== false,
    retainSemanticFrames: input.retainSemanticFrames !== false
  };
}

/**
 * Pure replay primitive for the source-derived unit rows and semantic-frame
 * rows produced by ngram-memory. The receipt binds every value used by this
 * derivation, while raw string hashes keep NUL distinct from space.
 */
export function deriveSourceLanguageArtifacts(input: SourceLanguageArtifactDerivationInput): SourceLanguageArtifactDerivation {
  validateCompilerOptions(input.compilerOptions);
  const limits = derivationLimits(input.limits);
  if (input.evidence.length > limits.maxEvidenceSpans) throw new Error("source language artifact replay exceeds the evidence-span limit");
  if (input.text.length > limits.maxSourceUtf16Units) throw new Error("source language artifact replay exceeds the source-UTF16 limit");
  const sourceUtf8Bytes = utf8Bytes(input.text);
  if (sourceUtf8Bytes > limits.maxSourceUtf8Bytes) throw new Error("source language artifact replay exceeds the source-byte limit");
  let evidenceUtf8Bytes = 0;
  for (const span of input.evidence) {
    evidenceUtf8Bytes += utf8Bytes(span.text)
      + (typeof span.textPreview === "string" ? utf8Bytes(span.textPreview) : 0);
    if (evidenceUtf8Bytes > limits.maxEvidenceUtf8Bytes) throw new Error("source language artifact replay exceeds the evidence-byte limit");
  }

  const sourceSystem = input.sourceSystem ? corpusSourceAlias(input.sourceSystem) : undefined;
  const dependency = sourceLanguageArtifactDerivationDependency({
    ...input,
    sourceSystem,
    sourceUtf8Bytes
  });
  // Reject a stale/tampered replay contract before paying the lattice, vector
  // or row-materialization cost.
  if (input.expectedReceipt) validateExpectedDerivationDependency(input.expectedReceipt, dependency, input.hasher);
  const formalCode = Boolean(sourceSystem && corpusRoleIdForSourceSystem(sourceSystem) === CORPUS_ROLE_IDS.softwareSymbolic);
  const lattice = formalCode ? undefined : buildNgramSurfaceProjection({
    documentId: input.streamId,
    text: input.text,
    sourceVersionId: input.sourceVersionId,
    evidenceIds: input.evidence.map(span => span.id),
    hasher: input.hasher
  });
  // Source-role projection blanks preserve coordinates but have no linguistic
  // identity. Exclude a whole surface when the supplementary marker joined a
  // neighboring grapheme. NUL remains untouched for legacy source fidelity.
  const canonicalSymbols = (lattice?.canonicalSurfaces ?? []).filter(isLearnableSurface);
  const spacedSymbols = formalCode ? [] : symbolizeData(input.text).filter(isLearnableSurface);
  const symbols = formalCode
    ? codeSurfaceTokens(input.text).filter(isLearnableSurface)
    : sequenceSpeaksInWords(canonicalSymbols) || !sequenceSpeaksInWords(spacedSymbols)
      ? canonicalSymbols
      : spacedSymbols;
  const graphemes = (lattice?.graphemes ?? []).filter(isLearnableSurface);
  const evidenceIds = input.evidence.map(span => span.id);
  const alpha = input.evidence.length
    ? input.evidence.reduce((sum, span) => sum + span.alpha, 0) / input.evidence.length
    : 0.35;
  const units = formalCode ? [] : compileLanguageUnits({
    profile: input.profile,
    sourceVersionId: input.sourceVersionId,
    sourceSystem,
    symbols,
    graphemes,
    evidenceIds,
    alpha,
    idFactory: input.idFactory,
    hasher: input.hasher
  });
  const semanticFrames = formalCode || !input.compilerOptions.retainSemanticFrames
    ? []
    : input.evidence.slice(0, 512).map((span, index) => semanticFrameForSpan(
      span,
      index,
      input.profile.id,
      input.idFactory,
      input.hasher,
      input.createdAt,
      sourceSystem
    ));
  const projection: SourceLanguageArtifactProjection = {
    ...(sourceSystem ? { sourceSystem } : {}),
    formalCode,
    symbols,
    graphemes,
    ...(lattice ? { surfaceLatticeId: lattice.latticeId, surfaceLatticeSchema: lattice.latticeSchema } : {}),
    sourceTextHash: lattice?.textHash ?? input.hasher.digestHex(input.text)
  };
  const artifactJsonUtf8Bytes = exactJsonUtf8Bytes({ units, semanticFrames });
  if (artifactJsonUtf8Bytes > limits.maxArtifactJsonUtf8Bytes) throw new Error("source language artifact replay exceeds the artifact-byte limit");
  const receipt = sourceLanguageArtifactDerivationReceipt(
    dependency,
    sourceLanguageArtifactFloat32StorageDigest({ units, semanticFrames, hasher: input.hasher }),
    input.hasher
  );
  if (input.expectedReceipt) validateSourceLanguageArtifactDerivationReceipt(input.expectedReceipt, receipt, input.hasher);
  const vectorScalars = units.reduce((sum, unit) => sum + unit.competenceVector.length, 0)
    + semanticFrames.reduce((sum, frame) => sum + frame.embedding.length, 0);
  return {
    units,
    semanticFrames,
    projection,
    receipt,
    measurement: {
      sourceUtf8Bytes,
      evidenceUtf8Bytes,
      artifactJsonUtf8Bytes,
      surfaceSymbols: symbols.length,
      graphemes: graphemes.length,
      units: units.length,
      semanticFrames: semanticFrames.length,
      vectorScalars,
      reconstructionWorkUnits: sourceUtf8Bytes + evidenceUtf8Bytes + symbols.length + graphemes.length + units.length + semanticFrames.length + vectorScalars
    }
  };
}

export function validateSourceLanguageArtifactDerivationReceipt(
  expected: SourceLanguageArtifactDerivationReceipt,
  actual: SourceLanguageArtifactDerivationReceipt,
  hasher: Hasher
): void {
  validateReceiptIntegrity(expected, hasher);
  validateReceiptIntegrity(actual, hasher);
  if (expected.dependencyId !== actual.dependencyId) throw new Error("source language artifact derivation dependencies changed");
  if (expected.artifactStorageDigest !== actual.artifactStorageDigest) throw new Error("source language artifact derivation artifacts changed");
  if (expected.derivationId !== actual.derivationId) throw new Error("source language artifact derivation receipt changed");
}

/** Digest the values PostgreSQL can read back, including vector Float32 rounding. */
export function sourceLanguageArtifactFloat32StorageDigest(input: {
  units: readonly LanguageUnitRecord[];
  semanticFrames: readonly SemanticFrameRecord[];
  hasher: Hasher;
}): string {
  return canonicalDigestHex({
    units: input.units.map(unit => ({ ...unit, competenceVector: float32Vector(unit.competenceVector) })),
    semanticFrames: input.semanticFrames.map(frame => ({ ...frame, embedding: float32Vector(frame.embedding) }))
  }, input.hasher);
}

const UNIT_DERIVED_METADATA_KEYS = new Set(["profileEntropy", "sourceSystem", "shape"]);
const FRAME_DERIVED_BODY_KEYS = new Set([
  "sourceVersionId",
  "profileId",
  "sourceSystem",
  "evidenceId",
  "index",
  "textHash",
  "preview",
  "symbolCount",
  "featureSample",
  "roleSignature"
]);

export interface SourceDerivedJsonSeparation {
  derived: JsonValue;
  /** Unknown or durability-owned fields (for example sourceCompilationId), kept outside replay-owned material. */
  envelope: JsonValue;
}

export function separateSourceDerivedLanguageUnitMetadata(metadata: JsonValue): SourceDerivedJsonSeparation {
  return separateDerivedJson(metadata, UNIT_DERIVED_METADATA_KEYS);
}

export function separateSourceDerivedSemanticFrameBody(frameJson: JsonValue): SourceDerivedJsonSeparation {
  return separateDerivedJson(frameJson, FRAME_DERIVED_BODY_KEYS);
}

export function mergeSourceDerivedLanguageUnitMetadata(separation: SourceDerivedJsonSeparation): JsonValue {
  return mergeDerivedJson(separation, UNIT_DERIVED_METADATA_KEYS);
}

export function mergeSourceDerivedSemanticFrameBody(separation: SourceDerivedJsonSeparation): JsonValue {
  return mergeDerivedJson(separation, FRAME_DERIVED_BODY_KEYS);
}

function compileLanguageUnits(input: {
  profile: LanguageProfile;
  sourceVersionId: SourceVersionId;
  sourceSystem?: string;
  symbols: string[];
  graphemes: string[];
  evidenceIds: EvidenceSpan["id"][];
  alpha: number;
  idFactory: IdFactory;
  hasher: Hasher;
}): LanguageUnitRecord[] {
  const symbolCounts = count(input.symbols);
  const symbolUnits = [...symbolCounts.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, 96)
    .map(([text, occurrences]) => unit(input, "symbol", text, featureSet(text, 64), clamp01(input.alpha * Math.log2(occurrences + 1) / 8)));
  const graphemeCounts = count(input.graphemes);
  const graphemeUnits = [...graphemeCounts.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, 32)
    .map(([text, occurrences]) => unit(input, "grapheme", text, [`grapheme:${text}`, `shape:${shapeOf(text)}`], clamp01(input.alpha * Math.log2(occurrences + 1) / 8)));
  const phraseUnits = phraseCandidates(input.symbols).slice(0, 48)
    .map(phrase => unit(input, "phrase", phrase.text, featureSet(phrase.text, 96), clamp01(input.alpha * phrase.score)));
  const syntaxUnits = syntaxSignatures(input.symbols).slice(0, 24)
    .map(signature => unit(input, "syntax_pattern", signature.text, [`syntax:${signature.text}`], clamp01(input.alpha * signature.score)));
  return [...symbolUnits, ...graphemeUnits, ...phraseUnits, ...syntaxUnits];
}

function unit(input: {
  profile: LanguageProfile;
  sourceVersionId: SourceVersionId;
  sourceSystem?: string;
  evidenceIds: EvidenceSpan["id"][];
  idFactory: IdFactory;
  hasher: Hasher;
}, unitKind: LanguageUnitRecord["unitKind"], text: string, features: string[], alpha: number): LanguageUnitRecord {
  return {
    id: input.idFactory.semanticId("language_unit", { profileId: input.profile.id, unitKind, text }),
    profileId: input.profile.id,
    sourceVersionId: input.sourceVersionId,
    script: scriptHint(text),
    unitKind,
    text,
    features,
    competenceVector: stableVector(features, input.hasher, 16),
    alpha,
    evidenceIds: input.evidenceIds.slice(0, 24),
    metadata: toJsonValue({ profileEntropy: input.profile.entropy, ...(input.sourceSystem ? { sourceSystem: input.sourceSystem } : {}), shape: shapeOf(text) })
  };
}

function semanticFrameForSpan(
  span: EvidenceSpan,
  index: number,
  profileId: string,
  idFactory: IdFactory,
  hasher: Hasher,
  createdAt: number,
  sourceSystem?: string
): SemanticFrameRecord {
  const symbols = symbolizeData(span.text).slice(0, 256);
  const features = featureSet(span.text, 256);
  const roles = syntaxSignatures(symbols).slice(0, 16);
  const frameJson = toJsonValue({
    sourceVersionId: span.sourceVersionId,
    profileId,
    ...(sourceSystem ? { sourceSystem } : {}),
    evidenceId: span.id,
    index,
    textHash: hasher.digestHex(span.text),
    preview: span.textPreview,
    symbolCount: symbols.length,
    featureSample: features.slice(0, 64),
    roleSignature: roles
  });
  return {
    id: idFactory.semanticId("semantic_frame", { profileId, evidenceId: span.id, hash: hasher.digestHex(span.text) }),
    frameJson,
    embedding: stableVector(features, hasher, 64),
    evidenceIds: [span.id],
    alpha: span.alpha,
    createdAt
  };
}

function sourceLanguageArtifactDerivationDependency(input: SourceLanguageArtifactDerivationInput & {
  sourceSystem?: string;
  sourceUtf8Bytes: number;
}): SourceLanguageArtifactDerivationDependency {
  const profileDependencyDigest = canonicalDigestHex({
    idHash: input.hasher.digestHex(input.profile.id),
    entropy: input.profile.entropy
  }, input.hasher);
  const evidenceDependencyDigest = canonicalDigestHex(input.evidence.map((span, index) => {
    const textPreview = typeof span.textPreview === "string" ? span.textPreview : undefined;
    return {
      index,
      idHash: input.hasher.digestHex(String(span.id)),
      sourceVersionIdHash: input.hasher.digestHex(String(span.sourceVersionId)),
      textHash: input.hasher.digestHex(span.text),
      textUtf8Bytes: utf8Bytes(span.text),
      textPreviewHash: textPreview === undefined ? null : input.hasher.digestHex(textPreview),
      textPreviewUtf8Bytes: textPreview === undefined ? 0 : utf8Bytes(textPreview),
      alpha: span.alpha
    };
  }), input.hasher);
  const body: Omit<SourceLanguageArtifactDerivationDependency, "dependencyId"> = {
    schema: SOURCE_LANGUAGE_ARTIFACT_DERIVATION_SCHEMA,
    streamIdHash: input.hasher.digestHex(input.streamId),
    sourceVersionIdHash: input.hasher.digestHex(String(input.sourceVersionId)),
    sourceSystem: input.sourceSystem ?? null,
    sourceTextHash: input.hasher.digestHex(input.text),
    sourceUtf8Bytes: input.sourceUtf8Bytes,
    profileDependencyDigest,
    evidenceDependencyDigest,
    evidenceCount: input.evidence.length,
    createdAt: input.createdAt,
    compilerOptions: { ...input.compilerOptions }
  };
  return { ...body, dependencyId: canonicalDigestHex(body, input.hasher) };
}

function sourceLanguageArtifactDerivationReceipt(
  dependency: SourceLanguageArtifactDerivationDependency,
  artifactStorageDigest: string,
  hasher: Hasher
): SourceLanguageArtifactDerivationReceipt {
  const body = { ...dependency, artifactStorageDigest };
  return { ...body, derivationId: canonicalDigestHex(body, hasher) };
}

function validateExpectedDerivationDependency(
  expected: SourceLanguageArtifactDerivationReceipt,
  actual: SourceLanguageArtifactDerivationDependency,
  hasher: Hasher
): void {
  validateReceiptIntegrity(expected, hasher);
  if (expected.dependencyId !== actual.dependencyId) throw new Error("source language artifact derivation dependencies changed");
}

function validateReceiptIntegrity(receipt: SourceLanguageArtifactDerivationReceipt, hasher: Hasher): void {
  if (receipt.schema !== SOURCE_LANGUAGE_ARTIFACT_DERIVATION_SCHEMA) {
    throw new Error(`unsupported source language artifact derivation version: ${String(receipt.schema)}`);
  }
  const { derivationId, ...body } = receipt;
  if (derivationId !== canonicalDigestHex(body, hasher)) throw new Error("source language artifact derivation receipt was changed");
  const { dependencyId, artifactStorageDigest: _artifactStorageDigest, ...dependencyBody } = body;
  if (dependencyId !== canonicalDigestHex(dependencyBody, hasher)) throw new Error("source language artifact derivation dependency receipt was changed");
}

function validateCompilerOptions(options: SourceLanguageArtifactCompilerOptions): void {
  if (!Number.isSafeInteger(options.maxOrder) || options.maxOrder < 1 || options.maxOrder > 6
    || !Number.isSafeInteger(options.maxCountersPerOrder) || options.maxCountersPerOrder < 32
    || options.maxCountersPerOrder > MAX_SOURCE_LANGUAGE_COUNTERS_PER_ORDER
    || !Number.isSafeInteger(options.vocabularyLimit) || options.vocabularyLimit < 1
    || options.vocabularyLimit > MAX_SOURCE_LANGUAGE_VOCABULARY
    || typeof options.retainObservations !== "boolean" || typeof options.retainSemanticFrames !== "boolean") {
    throw new Error("source language artifact derivation requires exact normalized compiler options");
  }
}

function derivationLimits(overrides: Partial<SourceLanguageArtifactDerivationLimits> | undefined): SourceLanguageArtifactDerivationLimits {
  const limits = { ...DEFAULT_SOURCE_LANGUAGE_ARTIFACT_DERIVATION_LIMITS, ...overrides };
  for (const [name, value] of Object.entries(limits)) {
    const hardMaximum = DEFAULT_SOURCE_LANGUAGE_ARTIFACT_DERIVATION_LIMITS[name as keyof SourceLanguageArtifactDerivationLimits];
    if (!Number.isSafeInteger(value) || value < 0 || value > hardMaximum) {
      throw new Error(`source language artifact ${name} must be a nonnegative integer no greater than ${hardMaximum}`);
    }
  }
  return limits;
}

function separateDerivedJson(value: JsonValue, known: ReadonlySet<string>): SourceDerivedJsonSeparation {
  if (!isJsonObject(value)) return { derived: {}, envelope: value };
  const derived: Record<string, JsonValue> = {};
  const envelope: Record<string, JsonValue> = {};
  for (const [key, field] of Object.entries(value)) (known.has(key) ? derived : envelope)[key] = field;
  return { derived, envelope };
}

function mergeDerivedJson(separation: SourceDerivedJsonSeparation, known: ReadonlySet<string>): JsonValue {
  if (!isJsonObject(separation.derived)) throw new Error("source-derived JSON body must be an object");
  if (!isJsonObject(separation.envelope)) {
    if (Object.keys(separation.derived).length === 0) return separation.envelope;
    throw new Error("source-derived JSON envelope must be an object when a derived body exists");
  }
  for (const key of Object.keys(separation.envelope)) {
    if (known.has(key) || Object.prototype.hasOwnProperty.call(separation.derived, key)) {
      throw new Error(`source-derived JSON envelope cannot override ${key}`);
    }
  }
  return { ...separation.derived, ...separation.envelope };
}

function isJsonObject(value: JsonValue): value is Record<string, JsonValue> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** True when a sampled majority of symbols carry more than one code point. */
function sequenceSpeaksInWords(symbols: readonly string[]): boolean {
  const sample = symbols.slice(0, 2048).filter(symbol => symbol.trim());
  if (!sample.length) return false;
  const multiPoint = sample.filter(symbol => [...symbol].length > 1).length;
  return multiPoint / sample.length >= 0.5;
}

function phraseCandidates(symbols: readonly string[]): Array<{ text: string; score: number }> {
  const grams = new Map<string, number>();
  for (let n = 2; n <= 6; n++) {
    for (let i = 0; i <= symbols.length - n; i++) {
      const gram = symbols.slice(i, i + n).join(" ");
      grams.set(gram, (grams.get(gram) ?? 0) + 1);
    }
  }
  const total = Math.max(1, symbols.length);
  return [...grams.entries()]
    .filter(([, occurrences]) => occurrences > 1)
    .sort((a, b) => b[1] - a[1] || b[0].length - a[0].length)
    .map(([text, occurrences]) => ({ text, score: clamp01(Math.log2(occurrences + 1) / Math.log2(total + 1)) }));
}

function syntaxSignatures(symbols: readonly string[]): Array<{ text: string; score: number }> {
  const windows = new Map<string, number>();
  const shapes = symbols.map(shapeOf);
  for (let n = 2; n <= 8; n++) {
    for (let i = 0; i <= shapes.length - n; i++) {
      const signature = shapes.slice(i, i + n).join(" ");
      windows.set(signature, (windows.get(signature) ?? 0) + 1);
    }
  }
  const total = Math.max(1, shapes.length);
  return [...windows.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([text, occurrences]) => ({ text, score: clamp01(Math.log2(occurrences + 1) / Math.log2(total + 1)) }));
}

function count(values: readonly string[]): Map<string, number> {
  const out = new Map<string, number>();
  for (const value of values) out.set(value, (out.get(value) ?? 0) + 1);
  return out;
}

function shapeOf(text: string): string {
  return [...text]
    .filter(char => !isSourceRoleProjectionBlankCodePoint(char))
    .map(char => /\p{Letter}/u.test(char) ? "L" : /\p{Number}/u.test(char) ? "N" : /\p{Punctuation}/u.test(char) ? "P" : /\p{Symbol}/u.test(char) ? "S" : "O")
    .join("");
}

function scriptHint(text: string): string {
  const chars = [...text].filter(char => !/\s/u.test(char) && !isSourceRoleProjectionBlankCodePoint(char));
  const counts = new Map<string, number>();
  for (const char of chars) {
    const script = learnedScriptIdForCharacter(char);
    counts.set(script, (counts.get(script) ?? 0) + 1);
  }
  return [...counts.entries()]
    .sort((left, right) => right[1] - left[1] || compareCodePoint(left[0], right[0]))[0]?.[0] ?? "script:Zxxx";
}

function isLearnableSurface(surface: string): boolean {
  return !containsSourceRoleProjectionBlank(surface);
}

function float32Vector(values: readonly number[]): number[] {
  return Array.from(Float32Array.from(values));
}

function compareCodePoint(left: string, right: string): number {
  const a = [...left];
  const b = [...right];
  for (let index = 0; index < Math.min(a.length, b.length); index++) {
    const x = a[index]!.codePointAt(0)!;
    const y = b[index]!.codePointAt(0)!;
    if (x !== y) return x < y ? -1 : 1;
  }
  return a.length - b.length;
}

function utf8Bytes(text: string): number {
  return new TextEncoder().encode(text).byteLength;
}

/** Exact JSON.stringify UTF-8 size without materializing the complete artifact payload. */
function exactJsonUtf8Bytes(value: unknown): number {
  if (value === null) return 4;
  if (typeof value === "string") return utf8Bytes(JSON.stringify(value));
  if (typeof value === "number") return Number.isFinite(value) ? String(value).length : 4;
  if (typeof value === "boolean") return value ? 4 : 5;
  if (Array.isArray(value)) {
    let bytes = 2;
    for (let index = 0; index < value.length; index++) bytes += (index ? 1 : 0) + exactJsonUtf8Bytes(value[index] ?? null);
    return bytes;
  }
  if (typeof value === "object") {
    let bytes = 2;
    let fields = 0;
    for (const [key, field] of Object.entries(value)) {
      if (field === undefined || typeof field === "function" || typeof field === "symbol") continue;
      bytes += (fields++ ? 1 : 0) + utf8Bytes(JSON.stringify(key)) + 1 + exactJsonUtf8Bytes(field);
    }
    return bytes;
  }
  return 4;
}
