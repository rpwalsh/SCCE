// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
import type { AlignmentCalibrationObservation, AlignmentPromotionObservation, GraphEdge, GraphNode, Hyperedge } from "@scce/kernel";
import { ingestStageTracer } from "./ingest-stage-trace-sink.js";
import { blobContentHash } from "./postgres.js";
import { prepareCorpusSourceGraphProjection, SOURCE_ENTITY_GRAPH_COMPONENT_RECIPE_ID } from "./corpus-source-graph-projection.js";
import { SOURCE_CODE_FUNCTION_COMPILER_RECIPE_ID } from "./source-code-function-learning.js";
import {
  createClock,
  canonicalStringify,
  createEventFactory,
  createEvidenceExtractor,
  putSpanBlobs,
  createHasher,
  createIdFactory,
  createLanguageAcquisitionEngine,
  createLanguageMemoryRuntime,
  inductionCharBudget,
  sourceInductionBatches,
  evidenceSourceFamilyId,
  languageProfileCompatibility,
  LANGUAGE_TRAINING_BATCH_RECIPE_ID,
  INDUCED_LANGUAGE_MEMORY_COMPONENT_RECIPE_ID,
  SOURCE_CONSTRUCTION_BINDINGS_COMPONENT_RECIPE_ID,
  LANGUAGE_CONSTRUCTION_ACTIVE_PROJECTION_RECIPE_ID,
  LANGUAGE_CONSTRUCTION_PATTERN_SCHEMA,
  SOURCE_CODE_FUNCTION_PATTERN_SCHEMA,
  SOURCE_CODE_FUNCTION_PROJECTION_RECIPE_ID,
  sourceCodeFunctionConstructionId,
  createSourceAdmissionController,
  compileLanguageTrainingBatch,
  prepareLanguageTrainingInduction,
  SOURCE_CONSTRUCTION_CONTEXT_RECIPE_ID,
  preparedLanguageInductionProducts,
  sourceLanguageInductionDocuments,
  sourceLanguageTrainingStreamId,
  stampSourceLanguageCompilation,
  prepareLanguageTrainingSegmentation,
  observePreparedLanguageTrainingSegmentation,
  attachSourceDerivedLanguageAliases,
  CORPUS_SOURCE_SYSTEM_IDS,
  CORPUS_ROLE_IDS,
  canonicalCorpusSourceSystemId,
  corpusNgramSettings,
  createCorpusRegistry,
  corpusRoleIdForSourceSystem,
  corpusSourceAlias,
  type CorpusRegistryOverride,
  joinInformationLabels,
  normalizeInformationLabel,
  toJsonValue,
  type Clock,
  type CompiledLanguageTrainingBatch,
  type PreparedConstructionInduction,
  type PooledLanguageProfileBinding,
  type SourceLanguageFamilyRange,
  type CreativeEventConstructionCompiler,
  type EvidenceSpan,
  type IdFactory,
  type InformationLabel,
  type GraphSnapshot,
  type JsonValue,
  type LanguagePatternRecord,
  type LanguageProfile,
  type LanguageInductionDocument,
  type LanguageUnitRecord,
  type NgramModelRecord,
  type NgramObservation,
  type ScceStorage,
  type SemanticFrameRecord,
  type SourceAdmissionContext,
  type SourceAdmissionDecision,
  type SourceTrust,
  type SourceVersion,
  type SourceVersionId,
  type SourceId,
  type ContentHash,
  type IngestionCheckpoint,
  type SourceBoundLanguageConstructionTrainingSet,
  type QuarantineSource,
  type ScceEvent,
  type PreparedLanguageTrainingSegmentation
} from "@scce/kernel";

export interface LanguageCorpusTrainingInput {
  storage: ScceStorage;
  sourceSystem: string;
  streamUri: string;
  text: string;
  sourceUri?: string;
  sourceVersionId?: SourceVersionId;
  evidence?: readonly EvidenceSpan[];
  profile?: LanguageProfile;
  mediaType?: string;
  namespace?: string;
  createdAt?: number;
  maxEvidenceChunkBytes?: number;
  ngramMaxOrder?: number;
  ngramMaxCountersPerOrder?: number;
  ngramVocabularyLimit?: number;
  /** Registry overrides, so a corpus can state its own n-gram limits instead of inheriting the defaults. */
  corpusRegistry?: readonly CorpusRegistryOverride[];
  /** How this lane declares its material to the admission controller. Defaults to the corpus's own declaration. */
  sourceAdmission?: SourceAdmissionContext;
  /** Where this material came from. Defaults to the corpus's own declaration; never inferred from the text. */
  sourceKind?: string;
  corpusMetadata?: JsonValue;
  /** Acquisition occurrence witness; retained on source versions without retraining identical material. */
  acquisitionProvenance?: JsonValue;
  languageAliases?: readonly string[];
  constructionSets?: readonly SourceBoundLanguageConstructionTrainingSet[];
  /** Canonical source URI scope when the replay checkpoint has a separate control URI. */
  constructionPoolUriPrefix?: string;
  creativeEventCompiler?: CreativeEventConstructionCompiler;
  /** Source versions this text came from; their promoted evidence is what the batch's graph slice is read from. */
  graphSnapshotSourceVersionIds?: readonly string[];
  /** Pure source-evidenced projection prepared by the caller and persisted in the same commit transaction. */
  graphSnapshotAdditions?: GraphSnapshot;
  /** Character ranges of the concatenated text and the source family each belongs to. */
  sourceFamilyRanges?: readonly SourceLanguageFamilyRange[];
  preparedInduction?: PreparedConstructionInduction;
  profileBinding?: PooledLanguageProfileBinding;
  /** Alignment evidence carried from earlier batches: a construction is promoted on what the corpus shows, not one document. */
  alignmentPromotionObservations?: readonly AlignmentPromotionObservation[];
  alignmentCalibrationObservations?: readonly AlignmentCalibrationObservation[];
  languageOnly?: boolean;
  /**
   * Skip writing n-gram observations and models. For text whose n-gram
   * mass is ALREADY in the store (stored-corpus construction training
   * re-runs the language lane over previously-ingested articles),
   * re-inserting hundreds of thousands of observation rows per MB both
   * dominates wall time and double-counts the corpus. Constructions,
   * units, patterns, and frames still train and persist. With both source
   * and profile persistence disabled, only construction learning is emitted;
   * the existing canonical compilation remains intact.
   */
  skipNgramPersistence?: boolean;
  /**
   * Skip the raw n-gram OBSERVATIONS while still writing the compiled models.
   *
   * The two are the same information in two forms, and nothing reads the raw one. Its only consumers are a
   * diagnostic summary and a hydration fallback for a scope with no persisted model -- and the comment on that
   * fallback records it returning 0 rows in 48 of 48 measured executions. Nothing learns from them either:
   * training reads evidence spans, which persist regardless.
   *
   * Writing them is what makes a corpus ingest decay. The ids are per shard, so the rows never collapse:
   * measured on a clean scce5 after 4,762 articles, 19,382,688 rows and 27GB, ~460,000 new rows per shard
   * inserted into a primary key that grew with every shard before it. Throughput went from 1,217 sources an
   * hour on the empty brain to 348 five hours later, and ngram.insert was 281s a shard at 93% database wait.
   */
  skipNgramObservationPersistence?: boolean;
  persistSource?: boolean;
  /** Replay may read an owned profile without rewriting its derived aliases. */
  persistProfile?: boolean;
  /** Raw bytes from which `text` was cleaned or projected into a model-text derivative. */
  originalSource?: CorpusOriginalSource;
  episodeId?: ReturnType<IdFactory["episodeId"]>;
  idFactory?: IdFactory;
  clock?: Clock;
  informationLabel?: InformationLabel;
  /**
   * Optional durable item fence used by file-backed corpus producers. The
   * checkpoint identity is stable for this source item; its stored semantic
   * binding includes this content identity and every training option, so a
   * changed file or recipe fails closed instead of silently reusing the old
   * learned result. Direct prepare/commit callers leave this unset.
   */
  corpusCheckpoint?: CorpusTrainingCheckpoint;
}

export interface CorpusTrainingCheckpoint {
  rootUri: string;
  itemUri: string;
  contentHash?: string;
  byteLength?: number;
  /** Transform declaration bound to the raw bytes for this durable item fence. */
  transformId?: string;
  /** Canonical URI of the raw source version when it differs from the derivative URI. */
  originalSourceUri?: string;
}

export interface CorpusOriginalSource {
  bytes: Uint8Array;
  sourceUri: string;
  transformId: string;
  kind?: "redacted-text" | "extracted-text";
  originalCoordinateSpace?: "source-bytes" | "extracted-text-utf8";
}

export class CorpusCheckpointConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CorpusCheckpointConflictError";
  }
}

export interface LanguageCorpusTrainingReport {
  schema: "scce.languageCorpusTrainingReport.v1";
  /** Source-derived provenance label retained for storage/query compatibility. */
  sourceSystem: string;
  /** Opaque deterministic identity used by cognition and internal joins. */
  sourceSystemId: string;
  streamUri: string;
  /** Exact raw source version when a derivative projection was trained; otherwise equals sourceVersionId. */
  originalSourceVersionId: string;
  sourceVersionId: string;
  /** Durable artifact identities written by this document transaction; used by source-brain completion validation. */
  artifacts: { languageProfileId: string; evidenceIds: string[]; ngramModelIds: string[] };
  /** Hash of the exact source bytes when a source-byte binding was supplied, otherwise the trained text bytes. */
  sourceContentHash: string;
  /** Exact source-byte count for the same content binding. */
  sourceByteLength: number;
  languageProfiles: number;
  evidence: number;
  ngramObservations: number;
  ngramModels: number;
  languageUnits: number;
  languagePatterns: number;
  semanticFrames: number;
  /** What the admission controller decided for this source version, or `unmeasured` when it had no declaration. */
  admission: { disposition: SourceAdmissionDecision["disposition"] | "unmeasured" | "not_applicable"; reasons: string[] };
  /** This batch's own alignment observations, so a caller can carry them into the next batch. */
  alignmentPromotionObservations: AlignmentPromotionObservation[];
  alignmentCalibrationObservations: AlignmentCalibrationObservation[];
  constructionCandidates: number;
  languageConstructions: number;
  compilerRecipe?: string;
  sourceCodeFunctionPatterns?: number;
  graphSnapshotDigest?: string;
  constructionAcquisition?: { sourceObserved: number; documentHeldOutQualified: number; rejectedQualification: number };
  graphSurfaceAlignments: number;
  rejectedLanguageConstructions: number;
  eventId: string;
  warnings: string[];
}

/** An opaque process-local preparation token; learned payloads remain private until the atomic commit. */
export interface PreparedLanguageCorpusTraining {
  readonly sourceVersionId: SourceVersionId;
  readonly inputBinding: string;
  readonly graphSnapshotDigest: string;
}

interface PreparedLanguageCorpusPayload {
  projectedGraph?: GraphSnapshot;
  relationObservations?: Awaited<ReturnType<NonNullable<ScceStorage["relationObservations"]>["list"]>>;
  sourceSystem: string;
  sourceSystemId: string;
  sourceId: SourceId;
  sourceUri: string;
  namespace: string;
  sourceVersionId: SourceVersionId;
  text: string;
  bytes: Uint8Array;
  originalBytes?: Uint8Array;
  mediaType: string;
  source?: SourceVersion;
  originalSource?: SourceVersion;
  quarantine?: QuarantineSource;
  profile: LanguageProfile;
  evidence: EvidenceSpan[];
  metadata: JsonValue;
  informationLabel: InformationLabel;
  admission: LanguageCorpusTrainingReport["admission"];
  createdAt: number;
  segmentation?: PreparedLanguageTrainingSegmentation;
  graphSnapshotDigest: string;
  constructionPoolEvidence: EvidenceSpan[];
  constructionPoolProfiles: LanguageProfile[];
  compiledBatch: CompiledLanguageTrainingBatch;
  observations: NgramObservation[];
  models: NgramModelRecord[];
  units: LanguageUnitRecord[];
  patterns: LanguagePatternRecord[];
  frames: SemanticFrameRecord[];
  constructionWarnings: string[];
  languageConstructions: number;
  learned: ScceEvent;
}

const preparations = new WeakMap<PreparedLanguageCorpusTraining, {
  storage: ScceStorage;
  // The payload is needed for retry after a rolled-back commit, but retaining it after a successful
  // transaction keeps the full compiled batch alive while callers continue with alignment/promotion work.
  payload?: PreparedLanguageCorpusPayload;
  committed: boolean;
}>();

const CORPUS_CHECKPOINT_SCHEMA = "scce.corpusTrainingCheckpoint.v1";
export const LANGUAGE_CORPUS_TRAINING_RECIPE_ID = "scce.language_corpus_training.v3" as const;
export const LANGUAGE_CODE_CORPUS_TRAINING_RECIPE_ID = "scce.language_corpus_training.v5" as const;
const LANGUAGE_CORPUS_SOURCE_EVIDENCE_RECIPE_ID = "scce.language_corpus_source_evidence.v1" as const;

export function languageCorpusTrainingRecipeId(sourceSystem: string): string {
  return canonicalCorpusSourceSystemId(sourceSystem) === CORPUS_SOURCE_SYSTEM_IDS.ossCode
    ? LANGUAGE_CODE_CORPUS_TRAINING_RECIPE_ID : LANGUAGE_CORPUS_TRAINING_RECIPE_ID;
}

function corpusCheckpointId(input: LanguageCorpusTrainingInput): string | undefined {
  const checkpoint = input.corpusCheckpoint;
  if (!checkpoint) return undefined;
  // Checkpoint identity must remain stable across process retries even when a
  // caller supplies a run-seeded IdFactory for the learned artifacts.
  const ids = createIdFactory({
    clock: createClock(),
    hasher: createHasher(),
    namespace: "corpus-training-checkpoint",
    deterministicReplay: true
  });
  return ids.semanticId("corpus_training_checkpoint", {
    compilerRecipe: languageCorpusTrainingRecipeId(input.sourceSystem),
    sourceSystem: canonicalCorpusSourceSystemId(input.sourceSystem),
    rootUri: checkpoint.rootUri,
    itemUri: checkpoint.itemUri,
    ...(sourceEvidenceRecipeId(input) ? { sourceEvidenceRecipe: sourceEvidenceRecipeId(input) } : {})
  });
}

function sourceEvidenceRecipeId(input: LanguageCorpusTrainingInput): typeof LANGUAGE_CORPUS_SOURCE_EVIDENCE_RECIPE_ID | undefined {
  return input.persistSource !== false && !input.evidence?.length ? LANGUAGE_CORPUS_SOURCE_EVIDENCE_RECIPE_ID : undefined;
}

function checkpointContentHash(value: string | undefined): ContentHash | undefined {
  if (!value) return undefined;
  return (value.startsWith("sha256_") ? value : `sha256_${value}`) as ContentHash;
}

function validateOriginalSourceBinding(input: LanguageCorpusTrainingInput): void {
  const original = input.originalSource;
  const checkpoint = input.corpusCheckpoint;
  if (original && !original.transformId.trim()) throw new Error("corpus original source requires a non-empty transformId");
  if (!original || !checkpoint) return;
  const originalHash = blobContentHash(original.bytes);
  const checkpointHash = checkpointContentHash(checkpoint.contentHash);
  if (checkpointHash && checkpointHash !== originalHash) {
    throw new CorpusCheckpointConflictError(`corpus checkpoint raw content hash does not match original source for ${checkpoint.itemUri}`);
  }
  if (checkpoint.byteLength !== undefined && checkpoint.byteLength !== original.bytes.byteLength) {
    throw new CorpusCheckpointConflictError(`corpus checkpoint byte length does not match original source for ${checkpoint.itemUri}`);
  }
  if (checkpoint.transformId !== undefined && checkpoint.transformId !== original.transformId) {
    throw new CorpusCheckpointConflictError(`corpus checkpoint transform does not match original source for ${checkpoint.itemUri}`);
  }
  if (checkpoint.originalSourceUri !== undefined && checkpoint.originalSourceUri !== original.sourceUri) {
    throw new CorpusCheckpointConflictError(`corpus checkpoint source URI does not match original source for ${checkpoint.itemUri}`);
  }
}

function checkpointMetadata(input: LanguageCorpusTrainingInput, binding: string, report?: LanguageCorpusTrainingReport): JsonValue {
  const checkpoint = input.corpusCheckpoint!;
  return toJsonValue({
    schema: CORPUS_CHECKPOINT_SCHEMA,
    compilerRecipe: languageCorpusTrainingRecipeId(input.sourceSystem),
    batchRecipe: LANGUAGE_TRAINING_BATCH_RECIPE_ID,
    componentRecipes: corpusComponentRecipes(input),
    binding,
    sourceSystem: canonicalCorpusSourceSystemId(input.sourceSystem),
    rootUri: checkpoint.rootUri,
    itemUri: checkpoint.itemUri,
    contentHash: checkpoint.contentHash ?? null,
    byteLength: checkpoint.byteLength ?? null,
    transformId: checkpoint.transformId ?? null,
    originalSourceUri: checkpoint.originalSourceUri ?? null,
    ...(report ? { report } : {})
  });
}

function checkpointRecord(input: LanguageCorpusTrainingInput, binding: string, report?: LanguageCorpusTrainingReport): IngestionCheckpoint {
  const checkpoint = input.corpusCheckpoint!;
  const id = corpusCheckpointId(input)!;
  return {
    id,
    rootUri: checkpoint.rootUri,
    itemUri: checkpoint.itemUri,
    phase: report ? "stored" : "extracting",
    status: report ? "complete" : "running",
    offsetBytes: Math.max(0, Math.floor(checkpoint.byteLength ?? 0)),
    contentHash: checkpointContentHash(checkpoint.contentHash),
    byteLength: checkpoint.byteLength,
    updatedAt: Date.now(),
    metadata: checkpointMetadata(input, binding, report)
  };
}

function corpusComponentRecipes(input: LanguageCorpusTrainingInput): Record<string, string> {
  const naturalSource = !input.languageOnly && corpusRoleIdForSourceSystem(input.sourceSystem) !== CORPUS_ROLE_IDS.softwareSymbolic;
  const graphProjectionEnabled = naturalSource && input.persistSource !== false && createCorpusRegistry(input.corpusRegistry ?? []).some(row =>
    row.sourceSystemId === canonicalCorpusSourceSystemId(input.sourceSystem) && row.enabled && row.graphEvidenceEligible);
  const hasGraphDependency = Boolean(input.graphSnapshotAdditions?.hyperedges.length || input.graphSnapshotSourceVersionIds?.length || graphProjectionEnabled);
  const components: Record<string, string> = naturalSource
    ? { inducedLanguageMemory: INDUCED_LANGUAGE_MEMORY_COMPONENT_RECIPE_ID,
      sourceConstructionProjection: LANGUAGE_CONSTRUCTION_ACTIVE_PROJECTION_RECIPE_ID,
      ...(hasGraphDependency ? { sourceConstructionBindings: SOURCE_CONSTRUCTION_BINDINGS_COMPONENT_RECIPE_ID } : {}) } : {};
  if (!input.languageOnly && needsConstructionContext(input)) components.constructionContext = SOURCE_CONSTRUCTION_CONTEXT_RECIPE_ID;
  if (canonicalCorpusSourceSystemId(input.sourceSystem) === CORPUS_SOURCE_SYSTEM_IDS.ossCode) {
    components.sourceCodeFunctions = SOURCE_CODE_FUNCTION_PROJECTION_RECIPE_ID;
    components.sourceCodeFunctionCompiler = SOURCE_CODE_FUNCTION_COMPILER_RECIPE_ID;
    const contractInputHash = jsonRecord(input.corpusMetadata).sourceOwnedTestContractInputHash;
    components.sourceOwnedTestContracts = `scce.source_owned_test_contract_compiler.v1:${typeof contractInputHash === "string" ? contractInputHash : "absent"}`;
  }
  if (graphProjectionEnabled) {
    components.sourceEntityGraph = SOURCE_ENTITY_GRAPH_COMPONENT_RECIPE_ID;
  }
  return components;
}

function checkpointReport(row: IngestionCheckpoint, binding: string, compilerRecipe: string, componentRecipes: Record<string, string>): LanguageCorpusTrainingReport | undefined {
  if (row.status !== "complete") return undefined;
  const metadata = jsonRecord(row.metadata);
  if (metadata.schema !== CORPUS_CHECKPOINT_SCHEMA || metadata.binding !== binding
    || metadata.compilerRecipe !== compilerRecipe
    || metadata.batchRecipe !== LANGUAGE_TRAINING_BATCH_RECIPE_ID) {
    throw new CorpusCheckpointConflictError(`corpus checkpoint binding mismatch for ${row.itemUri}; refusing replay`);
  }
  const report = metadata.report;
  if (!report || typeof report !== "object" || Array.isArray(report) || (report as Record<string, JsonValue>).schema !== "scce.languageCorpusTrainingReport.v1") {
    throw new CorpusCheckpointConflictError(`corpus checkpoint ${row.id} is complete but has no valid training report`);
  }
  return canonicalStringify(metadata.componentRecipes ?? {}) === canonicalStringify(componentRecipes)
    ? report as unknown as LanguageCorpusTrainingReport : undefined;
}

async function prepareCorpusCheckpoint(input: LanguageCorpusTrainingInput, binding: string): Promise<LanguageCorpusTrainingReport | undefined> {
  const id = corpusCheckpointId(input);
  if (!id) return undefined;
  const existing = await input.storage.ingestion.get(id);
  if (existing) {
    if (existing.rootUri !== input.corpusCheckpoint!.rootUri || existing.itemUri !== input.corpusCheckpoint!.itemUri) {
      throw new CorpusCheckpointConflictError(`corpus checkpoint identity mismatch for ${id}; refusing replay`);
    }
    const metadata = jsonRecord(existing.metadata);
    if (metadata.schema !== CORPUS_CHECKPOINT_SCHEMA || metadata.binding !== binding
      || metadata.compilerRecipe !== languageCorpusTrainingRecipeId(input.sourceSystem)
      || metadata.batchRecipe !== LANGUAGE_TRAINING_BATCH_RECIPE_ID) {
      throw new CorpusCheckpointConflictError(`corpus checkpoint binding mismatch for ${existing.itemUri}; refusing replay`);
    }
    const report = checkpointReport(existing, binding, languageCorpusTrainingRecipeId(input.sourceSystem), corpusComponentRecipes(input));
    if (report) return report;
  }
  await input.storage.ingestion.put(checkpointRecord(input, binding));
  return undefined;
}

/**
 * Reconcile an error raised after a durable transaction committed. A lost
 * COMMIT acknowledgement must not be reported as a skipped source when the
 * terminal checkpoint is already present.
 */
export async function readCompletedCorpusCheckpoint(input: LanguageCorpusTrainingInput): Promise<LanguageCorpusTrainingReport | undefined> {
  const id = corpusCheckpointId(input);
  if (!id) return undefined;
  const existing = await input.storage.ingestion.get(id);
  return existing?.status === "complete"
    ? checkpointReport(existing, checkpointBinding(input), languageCorpusTrainingRecipeId(input.sourceSystem), corpusComponentRecipes(input))
    : undefined;
}

function preparationInputSnapshot(input: LanguageCorpusTrainingInput): LanguageCorpusTrainingInput {
  // Detach caller-owned semantic inputs before compilation. The output contains the compiled batch and can be
  // very large; cloning that output doubled peak memory, while these bounded input snapshots preserve the same
  // isolation and input-binding checks without retaining a second copy of learned rows.
  const clone = <T>(value: T): T => value === undefined ? value : structuredClone(value);
  return {
    ...input,
    evidence: clone(input.evidence),
    profile: clone(input.profile),
    corpusRegistry: clone(input.corpusRegistry),
    sourceAdmission: clone(input.sourceAdmission),
    corpusMetadata: clone(input.corpusMetadata),
    acquisitionProvenance: clone(input.acquisitionProvenance),
    languageAliases: clone(input.languageAliases),
    constructionSets: clone(input.constructionSets),
    graphSnapshotSourceVersionIds: clone(input.graphSnapshotSourceVersionIds),
    graphSnapshotAdditions: clone(input.graphSnapshotAdditions),
    sourceFamilyRanges: clone(input.sourceFamilyRanges),
    alignmentPromotionObservations: clone(input.alignmentPromotionObservations),
    alignmentCalibrationObservations: clone(input.alignmentCalibrationObservations),
    informationLabel: clone(input.informationLabel),
    originalSource: input.originalSource ? {
      ...input.originalSource,
      bytes: new Uint8Array(input.originalSource.bytes)
    } : undefined
  };
}

function needsConstructionContext(input: LanguageCorpusTrainingInput): boolean {
  return corpusRoleIdForSourceSystem(input.sourceSystem) !== CORPUS_ROLE_IDS.softwareSymbolic || Boolean(input.constructionSets?.length) || Boolean(input.graphSnapshotAdditions);
}

function checkpointBinding(input: LanguageCorpusTrainingInput): string {
  const { acquisitionProvenance: _acquisition, ...material } = input;
  if (canonicalCorpusSourceSystemId(input.sourceSystem) === CORPUS_SOURCE_SYSTEM_IDS.ossCode) {
    const { codeFunctionConstructions: _derived, sourceOwnedTestContracts: _derivedContracts, sourceOwnedTestContractInputHash: _contractInputHash, ...sourceMetadata } = jsonRecord(input.corpusMetadata);
    return trainingInputBinding({ ...material, corpusMetadata: sourceMetadata });
  }
  return trainingInputBinding(material);
}

function trainingInputBinding(input: LanguageCorpusTrainingInput): string {
  // These service objects are used only in preparation; actual output IDs/times are captured in the payload.
  const { storage: _storage, clock: _clock, idFactory: _ids, creativeEventCompiler: _compiler, ...semantic } = input;
  // Bind the exact raw source without copying the bytes into checkpoint metadata. The transform and digest are
  // durable semantic inputs, while the bytes themselves remain in the canonical blob store.
  if (input.originalSource) {
    semantic.originalSource = {
      sourceUri: input.originalSource.sourceUri,
      transformId: input.originalSource.transformId,
      kind: input.originalSource.kind ?? "extracted-text",
      originalCoordinateSpace: input.originalSource.originalCoordinateSpace ?? "source-bytes",
      contentHash: blobContentHash(input.originalSource.bytes),
      byteLength: input.originalSource.bytes.byteLength
    } as unknown as typeof semantic.originalSource;
  }
  const semanticBinding = {
    ...semantic,
    ...(input.creativeEventCompiler ? { creativeEventCompilerId: input.creativeEventCompiler.id } : {})
  };
  return createHasher().digestHex(canonicalStringify(toJsonValue({
    compilerRecipe: languageCorpusTrainingRecipeId(input.sourceSystem),
    batchRecipe: LANGUAGE_TRAINING_BATCH_RECIPE_ID,
    ...(sourceEvidenceRecipeId(input) ? { sourceEvidenceRecipe: sourceEvidenceRecipeId(input) } : {}),
    input: semanticBinding
  })));
}

function graphSnapshotDigest(snapshot: Awaited<ReturnType<typeof graphSnapshotForEvidence>>): string {
  const ordered = <T extends { id: unknown }>(rows: readonly T[]) => [...rows].sort((a, b) => String(a.id).localeCompare(String(b.id)));
  return createHasher().digestHex(canonicalStringify(toJsonValue(snapshot ? {
    nodes: ordered(snapshot.nodes), edges: ordered(snapshot.edges), hyperedges: ordered(snapshot.hyperedges)
  } : null)));
}

function trainingGraphSnapshot(stored: GraphSnapshot | undefined, additions: GraphSnapshot | undefined, evidence: readonly EvidenceSpan[]): GraphSnapshot | undefined {
  if (!additions) return stored;
  const admitted = new Set(evidence.filter(span => span.status === "promoted").map(span => String(span.id)));
  const exact = (ids: readonly unknown[]) => ids.every(id => admitted.has(String(id)));
  if (additions.nodes.some(row => !exact(row.evidenceIds)) || additions.edges.some(row => !exact(row.evidenceIds))
    || additions.hyperedges.some(row => !row.evidenceIds.length || !exact(row.evidenceIds)
      || typeof jsonRecord(row.modality).extractionChannel !== "string"
      || row.participantPorts.some(port => !exact(port.evidenceIds)))) throw new Error("language training projected graph is not owned by the admitted source evidence");
  const merge = <T extends { id: unknown }>(left: readonly T[], right: readonly T[]) => [...new Map([...left, ...right].map(row => [String(row.id), row] as const)).values()]
    .sort((left, right) => String(left.id).localeCompare(String(right.id)));
  const graph = { nodes: merge(stored?.nodes ?? [], additions.nodes), edges: merge(stored?.edges ?? [], additions.edges),
    hyperedges: merge(stored?.hyperedges ?? [], additions.hyperedges) };
  return graph.hyperedges.length ? graph : undefined;
}

function evidenceDependencyDigest(evidence: readonly EvidenceSpan[]): string {
  return createHasher().digestHex(canonicalStringify(toJsonValue([...evidence].sort((a, b) => String(a.id).localeCompare(String(b.id))))));
}

async function durableConstructionPoolEvidence(input: {
  input: LanguageCorpusTrainingInput;
  evidence: readonly EvidenceSpan[];
  sourceSystem: string;
  informationLabel: InformationLabel;
  profile: LanguageProfile;
}): Promise<{
  evidence: EvidenceSpan[];
  documents: LanguageInductionDocument[];
  profiles: LanguageProfile[];
  languageCompatibility: Array<{ sourceVersionId: string; profileId?: string; status: "compatible" | "incompatible" | "unmeasured"; basis: string; score?: number }>;
}> {
  // The canonical evidence store is the bounded replay pool; no process-local corpus accumulates.
  const rootUri = input.input.constructionPoolUriPrefix ?? input.input.corpusCheckpoint?.rootUri;
  const list = input.input.storage.evidence.listEvidenceBackedSourceVersions;
  const result = { evidence: [] as EvidenceSpan[], documents: [] as LanguageInductionDocument[], profiles: [] as LanguageProfile[], languageCompatibility: [] as Array<{ sourceVersionId: string; profileId?: string; status: "compatible" | "incompatible" | "unmeasured"; basis: string; score?: number }> };
  if (!rootUri || !list || !input.evidence.some(span => span.status === "promoted")) return result;
  const budget = inductionCharBudget();
  const versions = await list.call(input.input.storage.evidence, {
    sourceSystem: input.sourceSystem,
    includeUriPrefixes: [rootUri],
    limit: budget
  });
  const current = new Set(input.evidence.map(span => String(span.sourceVersionId)));
  const currentSources = new Set(input.evidence.map(span => String(span.sourceId)));
  const canonicalUris = new Set<string>([input.input.sourceUri ?? input.input.streamUri]);
  const label = canonicalStringify(toJsonValue(input.informationLabel));
  const hasher = createHasher();
  let used = 0;
  for (const version of [...versions].sort((a, b) => a.canonicalUri.localeCompare(b.canonicalUri) || String(a.sourceVersionId).localeCompare(String(b.sourceVersionId)))) {
    if (current.has(String(version.sourceVersionId)) || canonicalUris.has(version.canonicalUri)
      || !version.canonicalUri.startsWith(rootUri) || version.byteLength <= 0
      || used >= budget || version.promotedSpanCount <= 0) continue;
    const profiles = (await input.input.storage.model.listLanguageProfiles({ sourceVersionIds: [version.sourceVersionId], limit: 2 }))
      .filter(profile => profile.sourceVersionId === version.sourceVersionId);
    if (profiles.length !== 1) {
      result.languageCompatibility.push({ sourceVersionId: String(version.sourceVersionId), status: "unmeasured", basis: "source_profile_absent_or_ambiguous" });
      continue;
    }
    const priorProfile = profiles[0]!;
    const compatibility = languageProfileCompatibility(input.profile, priorProfile);
    result.languageCompatibility.push({ sourceVersionId: String(version.sourceVersionId), profileId: priorProfile.id, ...compatibility });
    if (compatibility.status !== "compatible") continue;
    const found = await input.input.storage.evidence.searchEvidence({ sourceVersionId: version.sourceVersionId, status: "promoted", limit: 1,
      sourceSampleSeed: hasher.digestHex(canonicalStringify([SOURCE_CONSTRUCTION_CONTEXT_RECIPE_ID, version.sourceVersionId])) });
    const spans = found.map(row => row.span).sort((a, b) => a.charStart - b.charStart || String(a.id).localeCompare(String(b.id)));
    if (spans.length !== 1 || spans.some(span => span.status !== "promoted" || currentSources.has(String(span.sourceId))
      || span.sourceVersionId !== version.sourceVersionId
      || jsonRecord(span.provenance).sourceSystem !== input.sourceSystem
      || canonicalStringify(toJsonValue(span.informationLabel ?? null)) !== label)) continue;
    const owners = await input.input.storage.evidence.sourceVersionsForEvidence(spans.map(span => span.id));
    if (owners.length !== 1 || owners[0]!.sourceVersionId !== version.sourceVersionId || owners[0]!.canonicalUri !== version.canonicalUri
      || owners[0]!.byteLength !== version.byteLength || owners[0]!.contentHash !== version.contentHash
      || spans.some(span => span.sourceId !== owners[0]!.sourceId || span.byteStart < 0 || span.byteEnd > owners[0]!.byteLength)) continue;
    if (input.sourceSystem === corpusSourceAlias(CORPUS_SOURCE_SYSTEM_IDS.ossCode)) {
      const declared = (spans: readonly EvidenceSpan[]) => new Set(spans.map(span => jsonRecord(span.provenance).formalLanguage)
        .filter((value): value is string => typeof value === "string" && Boolean(value)));
      const currentLanguages = declared(input.evidence);
      const priorLanguages = declared(spans);
      if (currentLanguages.size !== 1 || priorLanguages.size !== 1 || !priorLanguages.has([...currentLanguages][0]!)) {
        result.languageCompatibility[result.languageCompatibility.length - 1] = { sourceVersionId: String(version.sourceVersionId), profileId: priorProfile.id,
          status: currentLanguages.size === 1 && priorLanguages.size === 1 ? "incompatible" : "unmeasured", basis: "declared_formal_language" };
        continue;
      }
    }
    const candidates = spans.flatMap(span => [...sourceInductionBatches([{ id: String(span.id), text: span.text,
      sourceVersionId: span.sourceVersionId, sourceFamilyId: evidenceSourceFamilyId(span), evidenceIds: [span.id] }], hasher)]
      .flatMap(batch => batch.documents).map(document => ({ span, document, bytes: Buffer.byteLength(document.text), rank: hasher.digestHex(document.id) })))
      .filter(candidate => candidate.document.text.trim() && candidate.bytes <= budget - used)
      .sort((left, right) => left.rank.localeCompare(right.rank) || left.document.id.localeCompare(right.document.id));
    const selected = candidates[0];
    if (!selected) continue;
    canonicalUris.add(version.canonicalUri);
    used += selected.bytes;
    result.evidence.push(structuredClone(selected.span));
    result.documents.push(structuredClone(selected.document));
    result.profiles.push(structuredClone(priorProfile));
  }
  return result;
}

/** The promoted spans those source versions own, which is what the graph was projected from. Impure: reads storage. */
async function promotedEvidenceIdsForSourceVersions(
  storage: LanguageCorpusTrainingInput["storage"],
  sourceVersionIds: readonly string[]
): Promise<EvidenceSpan["id"][]> {
  const ids: EvidenceSpan["id"][] = [];
  if (typeof storage.evidence?.searchEvidence !== "function") return ids;
  for (const sourceVersionId of sourceVersionIds.slice(0, TRAINING_SNAPSHOT_SOURCES)) {
      const found = await storage.evidence.searchEvidence({
        sourceVersionId: sourceVersionId as EvidenceSpan["sourceVersionId"],
        status: "promoted",
        limit: TRAINING_SNAPSHOT_EVIDENCE
      });
      for (const item of found) ids.push(item.span.id);
    if (ids.length >= TRAINING_SNAPSHOT_EVIDENCE) break;
  }
  return [...new Set(ids)].slice(0, TRAINING_SNAPSHOT_EVIDENCE);
}

/** This batch's evidence as a graph snapshot, bounded so training stays inside its heap budget. Impure: reads storage. */
async function graphSnapshotForEvidence(
  storage: LanguageCorpusTrainingInput["storage"],
  evidence: readonly EvidenceSpan[],
  sourceVersionIds?: readonly string[]
): Promise<{ nodes: GraphNode[]; edges: GraphEdge[]; hyperedges: Hyperedge[] } | undefined> {
  // A lane that re-chunks stored text mints new spans, and the graph was projected from the original ingestion's
  // spans, so their ids never meet. When the caller names the source versions the text came from, the slice is
  // read from those versions' own promoted evidence instead.
  const evidenceIds = sourceVersionIds?.length
    ? await promotedEvidenceIdsForSourceVersions(storage, sourceVersionIds)
    : [...new Set(evidence.map(span => span.id))].slice(0, TRAINING_SNAPSHOT_EVIDENCE);
  if (!evidenceIds.length || typeof storage.graph?.getSlice !== "function") return undefined;
    const slice = await storage.graph.getSlice({
      evidenceIds,
      limitNodes: TRAINING_SNAPSHOT_NODES,
      limitEdges: TRAINING_SNAPSHOT_EDGES
    });
    // Constructions align surfaces to promoted structured relations, never to chunk feature bags.
    const hyperedges = slice.hyperedges.filter(edge => {
      const modality = edge.modality;
      return typeof modality === "object" && modality !== null && !Array.isArray(modality)
        && typeof (modality as Record<string, unknown>).extractionChannel === "string";
    });
    if (!hyperedges.length) return undefined;
    // Storage adapters may return caller-owned objects. Keep the bounded snapshot detached so
    // compilation cannot retain or mutate the adapter's graph slice after this read.
    return {
      nodes: structuredClone(slice.nodes),
      edges: structuredClone(slice.edges),
      hyperedges: structuredClone(hyperedges)
    };
}

/** The compact Kneser-Ney summary's most-continued symbols, narrowed for a page signature. Mirrors the wiki path. */
function trainerProfileTopContinuation(kneserNey: unknown): Array<[string, number]> {
  const top = (kneserNey as { topContinuation?: unknown } | undefined)?.topContinuation;
  if (!Array.isArray(top)) return [];
  return top
    .filter((pair): pair is [string, number] => Array.isArray(pair) && typeof pair[0] === "string" && typeof pair[1] === "number")
    .map(pair => [pair[0], pair[1]]);
}

const TRAINING_SNAPSHOT_EVIDENCE = 64;
const TRAINING_SNAPSHOT_SOURCES = 8;
const TRAINING_SNAPSHOT_NODES = 512;
const TRAINING_SNAPSHOT_EDGES = 1024;

export async function trainLanguageCorpusText(input: LanguageCorpusTrainingInput): Promise<LanguageCorpusTrainingReport> {
  // Both source-owning and aggregate callers get an atomic learned write. CPU compilation precedes it.
  validateOriginalSourceBinding(input);
  if (input.corpusCheckpoint) {
    const replay = await prepareCorpusCheckpoint(input, checkpointBinding(input));
    if (replay) return replay;
  }
  const prepared = await prepareLanguageCorpusTraining(input);
  return commitLanguageCorpusTraining(input, prepared);
}

export async function prepareLanguageCorpusTraining(input: LanguageCorpusTrainingInput): Promise<PreparedLanguageCorpusTraining> {
  validateOriginalSourceBinding(input);
  const inputBinding = trainingInputBinding(input);
  const payload = await prepareLanguageCorpusTrainingInternal(preparationInputSnapshot(input));
  if (trainingInputBinding(input) !== inputBinding) throw new Error("language training input changed during preparation");
  const token = Object.freeze({ sourceVersionId: payload.sourceVersionId, inputBinding, graphSnapshotDigest: payload.graphSnapshotDigest });
  preparations.set(token, { storage: input.storage, payload, committed: false });
  return token;
}

export async function commitLanguageCorpusTraining(
  input: LanguageCorpusTrainingInput,
  prepared: PreparedLanguageCorpusTraining
): Promise<LanguageCorpusTrainingReport> {
  validateOriginalSourceBinding(input);
  if (input.corpusCheckpoint) {
    const replay = await prepareCorpusCheckpoint(input, checkpointBinding(input));
    if (replay) return replay;
  }
  const held = preparations.get(prepared);
  if (!held || held.storage !== input.storage) throw new Error("unrecognized language training preparation or storage");
  if (held.committed) throw new Error("language training preparation already committed or in progress");
  if (trainingInputBinding(input) !== prepared.inputBinding) throw new Error("language training input changed before commit");
  held.committed = true;
  try {
    const payload = held.payload;
    if (!payload) throw new Error("prepared language training payload was released before commit");
    const result = await input.storage.transaction(async () => {
      const snapshot = needsConstructionContext(input)
        ? trainingGraphSnapshot(trainingGraphSnapshot(await graphSnapshotForEvidence(input.storage, payload.evidence, input.graphSnapshotSourceVersionIds), input.graphSnapshotAdditions, payload.evidence), payload.projectedGraph, payload.evidence) : undefined;
      if (graphSnapshotDigest(snapshot) !== prepared.graphSnapshotDigest) throw new Error("language training graph dependencies changed before commit; prepare again");
      if (payload.constructionPoolEvidence.length) {
        const current = await input.storage.evidence.getEvidenceBatch(payload.constructionPoolEvidence.map(span => span.id));
        if (evidenceDependencyDigest(current) !== evidenceDependencyDigest(payload.constructionPoolEvidence)) throw new Error("language training construction evidence changed before commit; prepare again");
        const profiles = await input.storage.model.listLanguageProfiles({ sourceVersionIds: payload.constructionPoolProfiles.map(profile => profile.sourceVersionId), limit: payload.constructionPoolProfiles.length + 1 });
        if (canonicalStringify(toJsonValue(profiles.sort((a, b) => a.id.localeCompare(b.id)))) !== canonicalStringify(toJsonValue([...payload.constructionPoolProfiles].sort((a, b) => a.id.localeCompare(b.id))))) throw new Error("language training construction language profiles changed before commit; prepare again");
      }
      if (trainingInputBinding(input) !== prepared.inputBinding) throw new Error("language training input changed during commit validation");
      const report = await commitLanguageCorpusTrainingInternal(input, payload);
      if (input.corpusCheckpoint) {
        await input.storage.ingestion.put(checkpointRecord(input, checkpointBinding(input), report));
      }
      return report;
    });
    // Keep only the committed tombstone so a second use still reports "already committed" without retaining
    // the cloned observations/models/compiled alignment payload through the caller's subsequent work.
    held.payload = undefined;
    return result;
  } catch (error) { held.committed = false; throw error; }
}

/** The source version this text is stored under, so a later pass can find its evidence without re-training it. */
export function corpusSourceVersionIdFor(input: { sourceUri: string; text: string }): SourceVersionId {
  const hasher = createHasher();
  const text = input.text.replace(/\u0000/g, " ").normalize("NFC");
  return createIdFactory({ clock: createClock(), hasher })
    .sourceVersionId(`${input.sourceUri}${hasher.digestHex(Buffer.from(text, "utf8"))}`);
}

async function prepareLanguageCorpusTrainingInternal(input: LanguageCorpusTrainingInput): Promise<PreparedLanguageCorpusPayload> {
  const clock = input.clock ?? createClock();
  const hasher = createHasher();
  const sourceSystemId = canonicalCorpusSourceSystemId(input.sourceSystem);
  // Per-corpus n-gram limits, from the registry that carries them, whenever the caller did not state its own.
  //
  // The registry has held maxOrder, maxCountersPerOrder and vocabularyLimit per source system since it was
  // written and `corpusNgramSettings` is the accessor for them; nothing called it, so every corpus trained on
  // whatever global default sat downstream regardless of what the registry said about it. An explicit argument
  // still wins, so no existing caller changes behaviour.
  const registryNgram = corpusNgramSettings(createCorpusRegistry(input.corpusRegistry ?? []), sourceSystemId);
  const sourceInformationLabel = normalizeInformationLabel(
    input.informationLabel ?? verifiedPublicCorpusLabel(sourceSystemId)
  );
  const sourceSystem = corpusSourceAlias(input.sourceSystem);
  const ids = input.idFactory ?? createIdFactory({ clock, hasher, namespace: `corpus-${hasher.digestHex(sourceSystemId).slice(0, 12)}` });
  const events = createEventFactory({ idFactory: ids, clock, hasher });
  const language = createLanguageAcquisitionEngine({ idFactory: ids });
  const languageMemory = createLanguageMemoryRuntime({ idFactory: ids, hasher });
  const sourceUri = input.sourceUri ?? input.streamUri;
  const namespace = input.namespace ?? `corpus:${sourceSystemId}`;
  const createdAt = input.createdAt ?? clock.now();
  const text = input.text.replace(/\u0000/g, " ").normalize("NFC");
  const bytes = Buffer.from(text, "utf8");
  const sourceVersionId = input.sourceVersionId ?? corpusSourceVersionIdFor({ sourceUri, text });
  const sourceId = ids.sourceId(namespace, sourceUri);
  const originalSpec = input.originalSource;
  if (originalSpec && !originalSpec.transformId.trim()) throw new Error("corpus original source requires a non-empty transformId");
  // preparationInputSnapshot already detached caller-owned bytes; retain that one copy through the atomic commit
  // instead of cloning a second full raw document beside the compiled batch.
  const originalBytes = originalSpec?.bytes;
  const originalSourceUri = originalSpec?.sourceUri ?? sourceUri;
  const originalSourceId = originalSpec ? ids.sourceId(namespace, originalSourceUri) : undefined;
  const originalContentHash = originalBytes ? blobContentHash(originalBytes) : undefined;
  const originalSourceVersionId = originalSpec && originalSourceId && originalContentHash
    ? ids.sourceVersionId(canonicalStringify({
      contract: "scce.corpus-source-version.v1",
      sourceId: originalSourceId,
      contentHash: originalContentHash,
      role: "original"
    }))
    : undefined;
  let profile: LanguageProfile = {
    ...(input.profile ?? language.acquire({ sourceVersionId, text, createdAt })),
    informationLabel: sourceInformationLabel
  };
  const { codeFunctionConstructions: sourceCodeFunctions, sourceOwnedTestContracts: derivedAssertionContracts,
    sourceOwnedTestContractInputHash: _contractInputHash, ...sourceMetadata } = jsonRecord(input.corpusMetadata);
  const metadata = toJsonValue({
    ...sourceMetadata,
    ...(input.languageAliases?.length ? { languageAliases: [...input.languageAliases] } : {}),
    sourceSystem,
    sourceSystemId,
    sourceUri,
    streamUri: input.streamUri,
    provenanceClass: "learned_language_prior"
  });
  // Every learned row carried the shard's whole page list (7 kB on a 6-byte unit); it lives once, on the learned event.
  const { sourceVersionIds: _shardPages, ...rowMetadataRecord } = jsonRecord(metadata);
  const rowMetadata = toJsonValue(rowMetadataRecord);

  let evidence = [...(input.evidence ?? [])];
  let source: SourceVersion | undefined;
  let originalSource: SourceVersion | undefined;
  let quarantine: QuarantineSource | undefined;
  let admission: LanguageCorpusTrainingReport["admission"] = { disposition: "not_applicable", reasons: ["this lane persists no source version of its own"] };
  if (!evidence.length && input.persistSource !== false) {
    const extractor = createEvidenceExtractor({ idFactory: ids, hasher });
    const mediaType = input.mediaType ?? "text/plain";
    // Source-version and evidence rows are FK-bound to canonical blob hashes.
    // Persist those blobs before inserting either referencing record.
    const contentHash = blobContentHash(bytes);
    source = {
      sourceId,
      sourceVersionId,
      namespace,
      canonicalUri: sourceUri,
      contentHash,
      mediaType,
      observedAt: createdAt,
      byteLength: bytes.byteLength,
      sourceTrust: corpusSourceTrust(sourceSystemId),
      informationLabel: sourceInformationLabel,
      metadata: toJsonValue({ ...jsonRecord(metadata), ...(input.acquisitionProvenance ? { acquisitionProvenance: input.acquisitionProvenance } : {}) }),
      ...(originalSpec && originalSourceVersionId ? {
        role: "evidence-derivative" as const,
        derivation: {
          kind: originalSpec.kind ?? "extracted-text" as const,
          transformId: originalSpec.transformId,
          derivedFromSourceVersionId: originalSourceVersionId,
          originalCoordinateSpace: originalSpec.originalCoordinateSpace ?? "source-bytes" as const,
          redactionMap: []
        }
      } : {})
    };
    if (originalSpec && originalSourceId && originalSourceVersionId && originalContentHash && originalBytes) {
      originalSource = {
        sourceId: originalSourceId,
        sourceVersionId: originalSourceVersionId,
        namespace,
        canonicalUri: originalSourceUri,
        contentHash: originalContentHash,
        mediaType,
        observedAt: createdAt,
        byteLength: originalBytes.byteLength,
        sourceTrust: corpusSourceTrust(sourceSystemId),
        informationLabel: sourceInformationLabel,
        metadata: toJsonValue({ ...jsonRecord(metadata), sourceUri: originalSourceUri,
          ...(input.acquisitionProvenance ? { acquisitionProvenance: input.acquisitionProvenance } : {}) }),
        role: "original"
      };
    }
    const extracted = extractor.extract({
      sourceId,
      sourceVersionId,
      namespace,
      uri: sourceUri,
      mediaType,
      text,
      languageProfile: profile,
      sourceTrust: source.sourceTrust,
      observedAt: createdAt,
      maxChunkBytes: input.maxEvidenceChunkBytes ?? 64 * 1024,
      metadata,
      exactSourceText: true
    });
    // Law 1: the corpus lanes stamped `promoted` outright and never consulted the controller, so 1,154 live source
    // versions carry a promotion nobody decided. A corpus with no declaration is `unmeasured`, which is neither.
    const context = input.sourceAdmission ?? corpusAdmissionContext(sourceSystemId);
    const decision = context
      ? createSourceAdmissionController().decide({
        source,
        evidence: extracted.spans,
        context,
        // Diagnostic trust is otherwise computed from defaults, which is an unmeasured value deciding an admission.
        metadata: toJsonValue({ ...jsonRecord(metadata), diagnostics: extractorDiagnostics(input.text, text) })
      })
      : undefined;
    const audit = decision?.audit ?? toJsonValue({
      sourceVersionId, namespace, sourceSystemId,
      disposition: "unmeasured",
      reasons: [`no admission context is declared for corpus source system ${sourceSystem}`]
    });
    admission = {
      disposition: decision?.disposition ?? "unmeasured",
      reasons: decision?.reasons ?? [`no admission context is declared for corpus source system ${sourceSystem}`]
    };
    quarantine = {
      id: `${sourceVersionId}:admission`,
      sourceId,
      sourceVersionId,
      uri: sourceUri,
      contentHash,
      mediaType,
      fetchedAt: createdAt,
      trustVector: audit,
      permissionVector: toJsonValue({
        disposition: admission.disposition,
        sourceAdmission: context ? toJsonValue({ ...context }) : null,
        activeInfluence: decision ? toJsonValue({ ...decision.activeInfluence }) : null,
        safetyRails: decision?.safetyRails ?? []
      }),
      decision: admission.disposition === "reject" ? "rejected" : admission.disposition === "promote" ? "promoted" : "pending",
      decisionJson: audit
    };
    if (admission.disposition === "reject") {
      throw new Error(`corpus source rejected at admission: ${admission.reasons.join("; ")}`);
    }
    const actionByEvidence = new Map((decision?.evidenceActions ?? []).map(action => [action.evidenceId, action]));
    evidence = stampEvidence(extracted.spans, {
      sourceSystem,
      sourceSystemId,
      metadata,
      sourceKind: input.sourceKind ?? corpusSourceKind(sourceSystemId),
      status: admission.disposition === "promote" ? "promoted" : "quarantined",
      audit,
      actionByEvidence
    })
      .map(span => ({ ...span, informationLabel: sourceInformationLabel }))
      .map(span => withSourceFamily(span, input.sourceFamilyRanges));
  }

  if (evidence.some(span => !span.informationLabel)) {
    throw new Error("language corpus evidence requires information labels");
  }
  const informationLabel = joinInformationLabels(
    [sourceInformationLabel, ...evidence.map(span => span.informationLabel!)],
    { explicitMergeAuthority: false }
  );
  evidence = evidence.map(span => ({ ...span, informationLabel }));
  profile = attachSourceDerivedLanguageAliases({ profile, metadata, evidence });
  profile = { ...profile, informationLabel };
  // Identity discovery counts documents. A document-owning training call (a book, a source file, a dialogue
  // transcript -- anything that persists its own source) is one document and joins the closed-class population,
  // exactly as a wiki page does. The wiki SHARD trainer passes persistSource=false: its pages already have
  // signatures from the ingestor, and a shard is an aggregate, not a document, so it must not be counted again.
  // The construction lane compiles nothing without the graph its surfaces align to: alignment lattices are
  // built only when the batch carries hyperedges, so with no snapshot every run produced zero reversible
  // constructions and the mouth had no learned sentence shapes to speak with. The snapshot is this batch's own
  // evidence, read back from the graph the same evidence was projected into.
  const trainTrace = ingestStageTracer();
  const inductionDocuments = sourceLanguageInductionDocuments(evidence);
  const naturalInduction = !input.languageOnly && corpusRoleIdForSourceSystem(sourceSystem) !== CORPUS_ROLE_IDS.softwareSymbolic;
  const constructionPool = input.languageOnly || !needsConstructionContext(input)
    ? { evidence: [] as EvidenceSpan[], documents: [] as LanguageInductionDocument[], profiles: [] as LanguageProfile[], languageCompatibility: [] }
    : await durableConstructionPoolEvidence({ input, evidence, sourceSystem, informationLabel, profile });
  const constructionPoolEvidence = constructionPool.evidence;
  const preparedInduction = naturalInduction ? prepareLanguageTrainingInduction({ evidence,
    constructionEvidence: [...evidence, ...constructionPoolEvidence], constructionContextDocuments: constructionPool.documents,
    hasher, prepared: input.preparedInduction }).prepared : undefined;
  const inducedProducts = preparedInduction ? preparedLanguageInductionProducts({ documents: inductionDocuments, hasher, prepared: preparedInduction }) : undefined;
  const graphEligible = createCorpusRegistry(input.corpusRegistry ?? []).some(row => row.sourceSystemId === sourceSystemId && row.enabled && row.graphEvidenceEligible);
  const sourceProjection = source && input.persistSource !== false && graphEligible && naturalInduction
    ? await prepareCorpusSourceGraphProjection({ storage: input.storage, sourceId, sourceVersionId, uri: sourceUri, mediaType: input.mediaType ?? "text/plain",
      text, metadata, evidence, models: inducedProducts?.models, informationLabel, ids, hasher, observedAt: createdAt }) : undefined;
  const snapshotSpan = trainTrace.span("train.graph-snapshot");
  const batchGraphSnapshot = needsConstructionContext(input)
    ? trainingGraphSnapshot(trainingGraphSnapshot(await graphSnapshotForEvidence(input.storage, evidence, input.graphSnapshotSourceVersionIds), input.graphSnapshotAdditions, evidence), sourceProjection?.graph, evidence) : undefined;
  snapshotSpan.end({
    nodes: batchGraphSnapshot?.nodes.length ?? 0,
    edges: batchGraphSnapshot?.edges.length ?? 0,
    hyperedges: batchGraphSnapshot?.hyperedges.length ?? 0,
    evidence: evidence.length
  });

  // Pure CPU compilation runs before the write transaction in the ordinary and Wikipedia callers.
  const compileSpan = trainTrace.span("train.compile");
  const existingSources = !source && evidence.length > 0 && evidence.every(span => span.sourceVersionId === sourceVersionId)
    ? await input.storage.evidence.sourceVersionsForEvidence(evidence.map(span => span.id)) : [];
  const canonicalSource = source ?? (existingSources.length === 1 && existingSources[0]!.sourceVersionId === sourceVersionId ? existingSources[0] : undefined);
  if (canonicalSource && canonicalSource.contentHash !== blobContentHash(bytes)) throw new Error("canonical corpus learning projection differs from its owned source blob");
  const constructionOnly = input.skipNgramPersistence === true && input.persistSource === false && input.persistProfile === false;
  const compiledBatch = compileLanguageTrainingBatch({
    runtime: languageMemory,
    hasher,
    batch: {
      streamId: sourceLanguageTrainingStreamId({ sourceId: canonicalSource?.sourceId ?? sourceId, sourceVersionId, sourceSystem, hasher }),
      ...(batchGraphSnapshot ? { graphSnapshot: batchGraphSnapshot } : {}),
      sourceSystem,
      profile,
      sourceVersionId,
      ...(canonicalSource ? { canonicalSource: { sourceId: canonicalSource.sourceId, contentHash: canonicalSource.contentHash } } : {}),
      text,
      evidence,
      ...(preparedInduction ? { preparedInduction } : {}),
      ...(input.profileBinding ? { profileBinding: input.profileBinding } : {}),
      ...(constructionPoolEvidence.length ? { constructionEvidence: [...evidence, ...constructionPoolEvidence] } : {}),
      constructionContextDocuments: constructionPool.documents,
      createdAt,
      maxOrder: input.ngramMaxOrder ?? registryNgram.maxOrder,
      maxCountersPerOrder: input.ngramMaxCountersPerOrder ?? registryNgram.maxCountersPerOrder,
      vocabularyLimit: input.ngramVocabularyLimit ?? registryNgram.vocabularyLimit,
      retainNgramObservations: !(input.skipNgramPersistence || input.skipNgramObservationPersistence),
      ...(constructionOnly ? { artifactScope: "construction_only" as const } : {}),
      constructionSets: input.constructionSets,
      ...(input.languageOnly ? { languageOnly: true } : {}),
      ...(input.alignmentPromotionObservations?.length ? { alignmentPromotionObservations: input.alignmentPromotionObservations } : {}),
      ...(input.alignmentCalibrationObservations?.length ? { alignmentCalibrationObservations: input.alignmentCalibrationObservations } : {})
    }
  });
  compileSpan.end({
    observations: compiledBatch.observations.length,
    models: compiledBatch.models.length,
    units: compiledBatch.units.length,
    patterns: compiledBatch.patterns.length,
    semanticFrames: compiledBatch.semanticFrames.length,
    alignmentSupports: compiledBatch.sparseAlignmentCandidateSupports.length
  });
  const observations = input.skipNgramPersistence || input.skipNgramObservationPersistence
    ? []
    : compiledBatch.observations.map(item => ({ ...stampObservation(item, sourceSystem, sourceSystemId, metadata), informationLabel }));
  let models = input.skipNgramPersistence
    ? []
    : compiledBatch.models.map(item => ({ ...stampModel(item, sourceSystem, sourceSystemId, rowMetadata), informationLabel }));
  let units = compiledBatch.units.map(item => ({ ...stampUnit(item, sourceSystem, sourceSystemId, rowMetadata), informationLabel }));
  const compiledConstructionPatterns: LanguagePatternRecord[] = [...compiledBatch.constructionPatterns];
  const constructionWarnings: string[] = [...compiledBatch.warnings];
  if (input.creativeEventCompiler && !input.languageOnly && corpusRoleIdForSourceSystem(sourceSystem) !== CORPUS_ROLE_IDS.softwareSymbolic) {
    const creativeEventCompilation = input.creativeEventCompiler.compile({
      profileId: profile.id,
      evidence,
      hasher,
      updatedAt: createdAt,
      ...(compiledBatch.preparedInduction ? { preparedInduction: compiledBatch.preparedInduction } : {})
    });
    if (creativeEventCompilation.status === "compiled") {
      // The compiler is an adapter-owned service and may return a mutable pattern object. Detach just this
      // small result; cloning the entire compiled batch here was the memory-retention regression this path avoids.
      compiledConstructionPatterns.push(structuredClone(creativeEventCompilation.pattern));
    } else if (creativeEventCompilation.issues.some(issue =>
      issue.code !== "surface.construction_memory.reject.induction")) {
      constructionWarnings.push(...creativeEventCompilation.issues.map(issue => issue.code));
    }
  }
  let patterns = [
    ...compiledBatch.patterns.filter(pattern => !compiledConstructionPatterns.some(item => item.id === pattern.id)),
    ...compiledConstructionPatterns,
    ...compactSourceCodeFunctionPatterns({ constructions: sourceCodeFunctions, metadata, sourceSystem, profileId: profile.id, sourceVersionId,
      originalSourceVersionId: originalSourceVersionId ?? sourceVersionId, text: originalBytes ? Buffer.from(originalBytes).toString("utf8") : input.text,
      evidence, hasher, updatedAt: createdAt }),
    ...sourceOwnedAssertionPatterns({ contracts: derivedAssertionContracts, metadata, sourceSystem, profileId: profile.id, sourceVersionId,
      originalSourceVersionId: originalSourceVersionId ?? sourceVersionId, evidence, hasher, updatedAt: createdAt })
  ]
    .map(item => ({ ...stampPattern(item, sourceSystem, sourceSystemId, rowMetadata), informationLabel }));
  let frames = compiledBatch.semanticFrames.map(item => ({ ...stampFrame(item, sourceSystem, sourceSystemId, rowMetadata), informationLabel }));

  if (canonicalSource && models.length) {
    const receipts = models.map(model => jsonRecord(jsonRecord(model.modelJson).sourceCompilation));
    const chunks = receipts.map(receipt => jsonRecord(receipt.chunk)).sort((left, right) => Number(left.index) - Number(right.index))
      .map(chunk => text.slice(Number(chunk.start), Number(chunk.end)));
    const stamped = stampSourceLanguageCompilation({ owner: { sourceId: canonicalSource.sourceId, sourceVersionId, contentHash: canonicalSource.contentHash },
      profileId: profile.id, sourceSystem, streamId: sourceLanguageTrainingStreamId({ sourceId: canonicalSource.sourceId, sourceVersionId, sourceSystem, hasher }),
      text, chunks, models, options: receipts[0]!.options as unknown as Parameters<typeof stampSourceLanguageCompilation>[0]["options"],
      artifacts: { units, patterns, semanticFrames: frames }, hasher });
    models = stamped.models.map(row => ({ ...row, informationLabel }));
    units = stamped.units.map(row => ({ ...row, informationLabel }));
    patterns = stamped.patterns.map(row => ({ ...row, informationLabel }));
    frames = stamped.semanticFrames.map(row => ({ ...row, informationLabel }));
  }
  const activeImportVersionValue = jsonRecord(input.corpusMetadata).activeImportVersion;
  const segmentation = constructionOnly ? undefined : prepareLanguageTrainingSegmentation({
    batch: { text, createdAt },
    tenantId: informationLabel.tenantId,
    corpusRole: corpusRoleIdForSourceSystem(sourceSystemId),
    activeImportVersion: typeof activeImportVersionValue === "string" ? activeImportVersionValue : sourceSystemId,
    hasher
  });

  const learned = events.create({
    episodeId: input.episodeId ?? ids.episodeId(),
    typeId: "SymbolPatternLearned",
    payload: {
      ...jsonRecord(compiledBatch.audit),
      sourceSystem,
      sourceSystemId,
      streamUri: input.streamUri,
      sourceUri,
      sourceVersionId,
      evidence: evidence.length,
      constructionCandidates: compiledBatch.constructionCandidates,
      languageConstructions: compiledConstructionPatterns.length,
      sourceCodeFunctionPatterns: patterns.filter(pattern => pattern.patternKind === "source_code_function").length,
      // The audit already carries every summary under graphSurfaceAlignment; this key was a second full copy (49% of the event).
      graphSurfaceAlignments: compiledBatch.graphSurfaceAlignmentSummaries.length,
      rejectedLanguageConstructions: compiledBatch.rejectedConstructionCandidates,
      constructionPromotion: compiledBatch.constructionPromotion as unknown as JsonValue,
      constructionPool: {
        sourceSystem,
        rootUri: input.corpusCheckpoint?.rootUri ?? null,
        sourceUriPrefix: input.constructionPoolUriPrefix ?? input.corpusCheckpoint?.rootUri ?? null,
        evidenceIds: constructionPoolEvidence.map(span => String(span.id)),
        sourceVersionIds: [...new Set(constructionPoolEvidence.map(span => String(span.sourceVersionId)))].sort(),
        utf16Length: constructionPool.documents.reduce((sum, document) => sum + document.text.length, 0),
        byteLength: constructionPool.documents.reduce((sum, document) => sum + Buffer.byteLength(document.text), 0),
        windows: constructionPool.documents.map(document => ({ documentId: document.id, sourceVersionId: document.sourceVersionId,
          evidenceIds: document.evidenceIds, ...document.sourceWindow })),
        charBudget: inductionCharBudget(),
        languageCompatibility: constructionPool.languageCompatibility
      },
      compilerRecipe: languageCorpusTrainingRecipeId(sourceSystem),
      graphProjection: { mode: input.graphSnapshotAdditions ? "stored_graph_plus_source_projection" : "stored_graph_snapshot", dependencyDigest: graphSnapshotDigest(batchGraphSnapshot) },
      corpusMetadata: metadata,
      ...(input.acquisitionProvenance ? { acquisitionProvenance: input.acquisitionProvenance } : {})
    }
  });
  return {
    sourceSystem,
    projectedGraph: sourceProjection?.graph,
    relationObservations: sourceProjection?.observations,
    sourceSystemId,
    sourceId,
    sourceUri,
    namespace,
    sourceVersionId,
    text,
    bytes,
    originalBytes,
    mediaType: input.mediaType ?? "text/plain",
    source,
    originalSource,
    quarantine,
    profile,
    evidence,
    metadata,
    informationLabel,
    admission,
    createdAt,
    segmentation,
    graphSnapshotDigest: graphSnapshotDigest(batchGraphSnapshot),
    constructionPoolEvidence,
    constructionPoolProfiles: constructionPool.profiles,
    compiledBatch,
    observations,
    models,
    units,
    patterns,
    frames,
    constructionWarnings,
    languageConstructions: compiledConstructionPatterns.length,
    learned
  };
}

function sourceOwnedAssertionPatterns(input: {
  contracts: JsonValue | undefined; metadata: JsonValue; sourceSystem: string; profileId: string; sourceVersionId: SourceVersionId;
  originalSourceVersionId: SourceVersionId; evidence: readonly EvidenceSpan[]; hasher: ReturnType<typeof createHasher>; updatedAt: number;
}): LanguagePatternRecord[] {
  if (input.sourceSystem !== "oss_code") return [];
  const metadata = jsonRecord(input.metadata);
  const contracts = input.contracts;
  const evidenceIds = input.evidence.filter(span => span.status === "promoted" && span.sourceVersionId === input.sourceVersionId).map(span => span.id);
  if (!Array.isArray(contracts) || !evidenceIds.length) return [];
  const patterns: LanguagePatternRecord[] = [];
  for (const value of contracts) {
    const row = jsonRecord(value);
    if (row.schema !== "scce.source_owned_test_contract.v1" || row.sourceVersionId !== input.sourceVersionId
      || row.sourceHash !== metadata.sourceHash || typeof row.sourcePath !== "string" || typeof row.formalLanguage !== "string"
      || typeof row.repositoryFamily !== "string" || typeof row.targetSymbolId !== "string" || !Array.isArray(row.cases) || row.cases.length < 2) continue;
    const material = { ...row, sourceSystem: input.sourceSystem };
    const id = `source.code.assertion.pattern.${input.hasher.digestHex(canonicalStringify({ profileId: input.profileId, sourceVersionId: input.sourceVersionId, material })).slice(0, 40)}`;
    patterns.push({ id, profileId: input.profileId, patternKind: "source_code_assertion_contract", support: row.cases.length, entropy: 0,
      patternJson: material, evidenceIds, updatedAt: input.updatedAt });
  }
  return patterns;
}

function compactSourceCodeFunctionPatterns(input: {
  constructions: JsonValue | undefined;
  metadata: JsonValue;
  sourceSystem: string;
  profileId: string;
  sourceVersionId: SourceVersionId;
  originalSourceVersionId: SourceVersionId;
  text: string;
  evidence: readonly EvidenceSpan[];
  hasher: ReturnType<typeof createHasher>;
  updatedAt: number;
}): LanguagePatternRecord[] {
  if (input.sourceSystem !== "oss_code" || !Array.isArray(input.constructions)) return [];
  const metadata = jsonRecord(input.metadata);
  const sourceHash = metadata.sourceHash;
  const formalLanguage = metadata.formalLanguage;
  const evidenceIds = input.evidence.filter(span => span.status === "promoted" && span.sourceVersionId === input.sourceVersionId).map(span => span.id);
  if (!evidenceIds.length || typeof sourceHash !== "string" || typeof formalLanguage !== "string"
    || sourceHash.replace(/^sha256_/u, "") !== input.hasher.digestHex(input.text)) return [];
  const patterns = new Map<string, LanguagePatternRecord>();
  for (const value of input.constructions) {
    const row = jsonRecord(value);
    const { id, ...material } = row;
    if (row.schema !== "scce.source_code_function_construction.v1" || row.sourceHash !== sourceHash || row.languageId !== formalLanguage
      || typeof id !== "string" || id !== sourceCodeFunctionConstructionId(material as unknown as Parameters<typeof sourceCodeFunctionConstructionId>[0])
      || typeof row.sourceStart !== "number" || typeof row.sourceEnd !== "number" || !Number.isSafeInteger(row.sourceStart) || !Number.isSafeInteger(row.sourceEnd)
      || row.sourceStart < 0 || row.sourceEnd <= row.sourceStart || row.sourceEnd > input.text.length
      || input.text.slice(row.sourceStart, row.sourceEnd) !== row.sourceText || !Array.isArray(row.parameters)) continue;
    const patternId = `source.code.function.pattern.${input.hasher.digestHex(canonicalStringify({ constructionId: id, profileId: input.profileId, sourceVersionId: input.sourceVersionId }))}`;
    patterns.set(patternId, { id: patternId, profileId: input.profileId, patternKind: "source_code_function", support: 1, entropy: 0,
      patternJson: { schema: "scce.source_code_function_pattern.v1", sourceSystem: input.sourceSystem, sourceHash, formalLanguage,
        parameterCount: row.parameters.length, sourceVersionId: input.sourceVersionId, originalSourceVersionId: input.originalSourceVersionId, codeFunctionConstructions: [value] },
      evidenceIds, updatedAt: input.updatedAt });
  }
  return [...patterns.values()].sort((a, b) => a.id.localeCompare(b.id));
}

async function commitLanguageCorpusTrainingInternal(input: LanguageCorpusTrainingInput, prepared: PreparedLanguageCorpusPayload): Promise<LanguageCorpusTrainingReport> {
  if (prepared.source && prepared.quarantine) {
    if (prepared.originalSource && prepared.originalBytes) {
      const persistedOriginalHash = await input.storage.blobs.put(prepared.originalBytes, prepared.originalSource.mediaType);
      if (persistedOriginalHash !== prepared.originalSource.contentHash) throw new Error("language training original source blob hash mismatch");
      await input.storage.evidence.putSourceVersion(prepared.originalSource);
    }
    const persistedHash = await input.storage.blobs.put(prepared.bytes, prepared.mediaType);
    if (persistedHash !== prepared.source.contentHash) throw new Error("language training source blob hash mismatch");
    await input.storage.quarantine.put(prepared.quarantine);
    await putSpanBlobs(input.storage.blobs, prepared.evidence, prepared.mediaType);
    await input.storage.evidence.putSourceVersion(prepared.source);
    if (input.storage.evidence.putEvidenceSpans) await input.storage.evidence.putEvidenceSpans(prepared.evidence);
    else for (const span of prepared.evidence) await input.storage.evidence.putEvidenceSpan(span);
  }

  if (input.persistProfile !== false) await input.storage.model.putLanguageProfile(prepared.profile);
  if (prepared.relationObservations?.length && input.storage.relationObservations) await input.storage.relationObservations.put(prepared.relationObservations);
  if (prepared.projectedGraph) {
    const graph = prepared.projectedGraph;
    if (input.storage.graph.upsertNodes) await input.storage.graph.upsertNodes(graph.nodes); else for (const row of graph.nodes) await input.storage.graph.upsertNode(row);
    if (input.storage.graph.upsertEdges) await input.storage.graph.upsertEdges(graph.edges); else for (const row of graph.edges) await input.storage.graph.upsertEdge(row);
    if (input.storage.graph.upsertHyperedges) await input.storage.graph.upsertHyperedges(graph.hyperedges); else for (const row of graph.hyperedges) await input.storage.graph.upsertHyperedge(row);
  }
  if (input.persistSource !== false && input.storage.languageIdentities?.putProfileSignatures) {
    await input.storage.languageIdentities.putProfileSignatures({
      informationLabel: prepared.informationLabel,
      rows: [{
        id: prepared.profile.id,
        sourceVersionId: prepared.sourceVersionId,
        sourceSystem: input.sourceSystem,
        sourceUri: input.sourceUri ?? "",
        scripts: (prepared.profile.scripts ?? []).map(row => ({ script: row.script, mass: row.mass })),
        direction: prepared.profile.direction,
        topContinuation: trainerProfileTopContinuation(prepared.profile.kneserNey)
      }]
    });
  }

  const trainTrace = ingestStageTracer();
  const segmentationSpan = trainTrace.span("train.segmentation");
  if (prepared.segmentation) {
    await observePreparedLanguageTrainingSegmentation({ storage: input.storage, prepared: prepared.segmentation });
  }
  segmentationSpan.end();

  const persistSpan = trainTrace.span("train.persist");
  await input.storage.languageMemory.putNgramObservationsBatch(prepared.observations);
  if (input.storage.languageMemory.putNgramModels) await input.storage.languageMemory.putNgramModels(prepared.models);
  else for (const model of prepared.models) await input.storage.languageMemory.putNgramModel(model);
  if (input.storage.languageMemory.putLanguageUnits) await input.storage.languageMemory.putLanguageUnits(prepared.units);
  else for (const unit of prepared.units) await input.storage.languageMemory.putLanguageUnit(unit);
  const componentRecipes = corpusComponentRecipes(input);
  const patternProjectionRecipe = componentRecipes.sourceCodeFunctions ?? componentRecipes.sourceConstructionProjection;
  const patternSchema = componentRecipes.sourceCodeFunctions ? SOURCE_CODE_FUNCTION_PATTERN_SCHEMA : LANGUAGE_CONSTRUCTION_PATTERN_SCHEMA;
  if (patternProjectionRecipe && input.storage.languageMemory.replaceLanguagePatternProjection) {
    await input.storage.languageMemory.replaceLanguagePatternProjection({
      patterns: prepared.patterns,
      projection: {
        profileId: String(prepared.profile.id),
        sourceId: prepared.sourceId,
        sourceVersionId: prepared.sourceVersionId,
        sourceSystem: prepared.sourceSystem,
        patternSchema,
        componentRecipe: patternProjectionRecipe,
        patternIds: prepared.patterns.filter(pattern => jsonRecord(pattern.patternJson).schema === patternSchema).map(pattern => pattern.id).sort(),
        informationLabel: prepared.informationLabel
      }
    });
  } else if (input.storage.languageMemory.putLanguagePatterns) await input.storage.languageMemory.putLanguagePatterns(prepared.patterns);
  else for (const pattern of prepared.patterns) await input.storage.languageMemory.putLanguagePattern(pattern);
  if (canonicalCorpusSourceSystemId(input.sourceSystem) === CORPUS_SOURCE_SYSTEM_IDS.ossCode
    && input.storage.languageMemory.replaceLanguagePatternProjection) {
    const assertionPatterns = prepared.patterns.filter(pattern => pattern.patternKind === "source_code_assertion_contract");
    await input.storage.languageMemory.replaceLanguagePatternProjection({
      patterns: assertionPatterns,
      projection: {
        profileId: String(prepared.profile.id), sourceId: prepared.sourceId, sourceVersionId: prepared.sourceVersionId,
        sourceSystem: prepared.sourceSystem, patternSchema: "scce.source_owned_test_contract.v1",
        componentRecipe: "scce.source_owned_test_contract_projection.v1",
        patternIds: assertionPatterns.map(pattern => pattern.id).sort(), informationLabel: prepared.informationLabel
      }
    });
  }
  if (input.storage.languageMemory.putSemanticFrames) await input.storage.languageMemory.putSemanticFrames(prepared.frames);
  else for (const frame of prepared.frames) await input.storage.languageMemory.putSemanticFrame(frame);
  await input.storage.events.append(prepared.learned);
  persistSpan.end({
    observations: prepared.observations.length,
    models: prepared.models.length,
    units: prepared.units.length,
    patterns: prepared.patterns.length,
    frames: prepared.frames.length
  });

  return {
    schema: "scce.languageCorpusTrainingReport.v1",
    sourceSystem: prepared.sourceSystem,
    sourceSystemId: prepared.sourceSystemId,
    streamUri: input.streamUri,
    originalSourceVersionId: String(prepared.originalSource?.sourceVersionId ?? prepared.sourceVersionId),
    sourceVersionId: prepared.sourceVersionId,
    artifacts: {
      languageProfileId: String(prepared.profile.id),
      evidenceIds: prepared.evidence.map(span => String(span.id)),
      ngramModelIds: prepared.models.map(model => String(model.id))
    },
    sourceContentHash: prepared.originalSource?.contentHash ?? prepared.source?.contentHash ?? createHasher().digestHex(Buffer.from(prepared.text, "utf8")),
    sourceByteLength: prepared.originalSource?.byteLength ?? prepared.source?.byteLength ?? Buffer.byteLength(prepared.text, "utf8"),
    languageProfiles: 1,
    evidence: prepared.evidence.length,
    ngramObservations: prepared.observations.length,
    ngramModels: prepared.models.length,
    languageUnits: prepared.units.length,
    languagePatterns: prepared.patterns.length,
    semanticFrames: prepared.frames.length,
    admission: prepared.admission,
    alignmentPromotionObservations: [...prepared.compiledBatch.alignmentHeldoutEvaluation.promotionObservations],
    alignmentCalibrationObservations: [...prepared.compiledBatch.alignmentHeldoutEvaluation.calibrationObservations],
    constructionCandidates: prepared.compiledBatch.constructionCandidates,
    languageConstructions: prepared.languageConstructions,
    compilerRecipe: languageCorpusTrainingRecipeId(prepared.sourceSystem),
    sourceCodeFunctionPatterns: prepared.patterns.filter(pattern => pattern.patternKind === "source_code_function").length,
    graphSnapshotDigest: prepared.graphSnapshotDigest,
    constructionAcquisition: {
      sourceObserved: prepared.compiledBatch.constructionPromotion.sourceObservedInducedConstructionSets,
      documentHeldOutQualified: prepared.compiledBatch.constructionPromotion.promotedInducedConstructionSets,
      rejectedQualification: prepared.compiledBatch.constructionPromotion.rejectedInducedConstructionSets
    },
    graphSurfaceAlignments: prepared.compiledBatch.graphSurfaceAlignmentSummaries.length,
    rejectedLanguageConstructions: prepared.compiledBatch.rejectedConstructionCandidates,
    eventId: String(prepared.learned.id),
    warnings: [...new Set(prepared.constructionWarnings)].sort()
  };
}

/** Independence is measured over source families, so a span keeps the family of the document it came from
 *  rather than the batch that happened to carry it. Pure. */
function withSourceFamily(
  span: EvidenceSpan,
  ranges: readonly { start: number; end: number; sourceFamilyId: string }[] | undefined
): EvidenceSpan {
  if (!ranges?.length) return span;
  const found = ranges.find(range => span.charStart >= range.start && span.charStart < range.end);
  if (!found) return span;
  const provenance = span.provenance && typeof span.provenance === "object" && !Array.isArray(span.provenance)
    ? span.provenance as Record<string, JsonValue>
    : {};
  return { ...span, provenance: { ...provenance, sourceFamilyId: found.sourceFamilyId } };
}

/** What each corpus declares itself to be at admission; the same declaration the registry already carries, in the
 *  controller's vocabulary. An undeclared corpus returns undefined, which is `unmeasured`, not a promotion. Pure. */
function corpusAdmissionContext(sourceSystemId: string): SourceAdmissionContext | undefined {
  if (sourceSystemId === CORPUS_SOURCE_SYSTEM_IDS.wikipedia
    || sourceSystemId === CORPUS_SOURCE_SYSTEM_IDS.gutenberg
    || sourceSystemId === CORPUS_SOURCE_SYSTEM_IDS.ossDocs
    || sourceSystemId === CORPUS_SOURCE_SYSTEM_IDS.ossCode) {
    return { sourceClass: "trusted_corpus", intendedUse: "learned_prior", promotionAuthority: "training" };
  }
  if (sourceSystemId === CORPUS_SOURCE_SYSTEM_IDS.dialogue
    || sourceSystemId === CORPUS_SOURCE_SYSTEM_IDS.corrections
    || sourceSystemId === CORPUS_SOURCE_SYSTEM_IDS.workspace) {
    return { sourceClass: "owner_local", intendedUse: "learned_prior", promotionAuthority: "owner" };
  }
  return undefined;
}

/** Where a corpus's material came from, in the vocabulary ingestion-lanes already declares. Pure. */
function corpusSourceKind(sourceSystemId: string): string {
  if (sourceSystemId === CORPUS_SOURCE_SYSTEM_IDS.wikipedia) return "wikimedia_dump";
  if (sourceSystemId === CORPUS_SOURCE_SYSTEM_IDS.gutenberg) return "gutenberg_mirror";
  if (sourceSystemId === CORPUS_SOURCE_SYSTEM_IDS.ossDocs || sourceSystemId === CORPUS_SOURCE_SYSTEM_IDS.ossCode) return "developer_intelligence";
  if (sourceSystemId === CORPUS_SOURCE_SYSTEM_IDS.dialogue) return "local_corpus";
  if (sourceSystemId === CORPUS_SOURCE_SYSTEM_IDS.workspace) return "local_engineering_corpus";
  return "unknown";
}

/** The extractor facts this lane can actually measure, so diagnostic trust is not computed from defaults. Pure. */
function extractorDiagnostics(rawText: string, normalizedText: string): JsonValue {
  let nulCount = 0;
  for (let index = 0; index < rawText.length; index += 1) if (rawText.charCodeAt(index) === 0) nulCount += 1;
  return toJsonValue({
    charLength: [...normalizedText].length,
    // One extractor ran over this text; this is a count of what happened, not a tuned parameter.
    parserCount: 1,
    binaryRatio: rawText.length ? nulCount / rawText.length : 0,
    missingPreconditions: [],
    warnings: []
  });
}

function stampEvidence(spans: readonly EvidenceSpan[], stamp: {
  sourceSystem: string;
  sourceSystemId: string;
  metadata: JsonValue;
  sourceKind: string;
  status: EvidenceSpan["status"];
  audit: JsonValue;
  actionByEvidence: Map<string, { action: string; alpha: number }>;
}): EvidenceSpan[] {
  const { sourceSystem, sourceSystemId, metadata, sourceKind, status, audit } = stamp;
  return spans.map(span => {
    const action = stamp.actionByEvidence.get(String(span.id));
    return {
      ...span,
      status,
      alpha: action?.action === "lower-alpha" ? Math.min(span.alpha, action.alpha) : span.alpha,
      // Source kind names where the material came from. Every lane through this trainer used to say
      // construction_training, so a repository file arrived labelled as derived training residue.
      provenance: toJsonValue({ ...jsonRecord(span.provenance), ...jsonRecord(metadata), sourceSystem, sourceSystemId, sourceKind, forceClass: "direct_evidence" }),
      trustVector: toJsonValue({ ...jsonRecord(span.trustVector), sourceSystem, sourceSystemId, forceClass: "direct_evidence", sourceTrust: corpusSourceTrust(sourceSystemId), admission: audit, action: action?.action ?? "quarantine" })
    };
  });
}

function stampObservation(observation: NgramObservation, sourceSystem: string, sourceSystemId: string, metadata: JsonValue): NgramObservation {
  const observationMetadata = jsonRecord(observation.metadata);
  const corpusMetadata = jsonRecord(metadata);
  return {
    ...observation,
    metadata: toJsonValue({
      ...(observationMetadata.profileId !== undefined ? { profileId: observationMetadata.profileId } : {}),
      sourceSystem,
      sourceSystemId,
      provenanceClass: corpusMetadata.provenanceClass ?? "learned_language_prior",
      forceClass: "learned_language_prior",
      ...(observationMetadata.error !== undefined ? { error: observationMetadata.error } : {}),
      ...(observationMetadata.approximate !== undefined ? { approximate: observationMetadata.approximate } : {})
    })
  };
}

function stampModel(model: NgramModelRecord, sourceSystem: string, sourceSystemId: string, metadata: JsonValue): NgramModelRecord {
  return { ...model, modelJson: toJsonValue({ ...jsonRecord(model.modelJson), ...jsonRecord(metadata), sourceSystem, sourceSystemId, forceClass: "learned_language_prior" }) };
}

function stampUnit(unit: LanguageUnitRecord, sourceSystem: string, sourceSystemId: string, metadata: JsonValue): LanguageUnitRecord {
  return { ...unit, metadata: toJsonValue({ ...jsonRecord(unit.metadata), ...jsonRecord(metadata), sourceSystem, sourceSystemId, forceClass: "learned_language_prior" }) };
}

/** The provenance every persisted pattern carries, which is also what the role-scoped hydration query matches on. */
export function stampPattern(pattern: LanguagePatternRecord, sourceSystem: string, sourceSystemId: string, metadata: JsonValue): LanguagePatternRecord {
  return { ...pattern, patternJson: toJsonValue({ ...jsonRecord(pattern.patternJson), ...jsonRecord(metadata), sourceSystem, sourceSystemId, forceClass: "learned_language_prior" }) };
}

function stampFrame(frame: SemanticFrameRecord, sourceSystem: string, sourceSystemId: string, metadata: JsonValue): SemanticFrameRecord {
  return { ...frame, frameJson: toJsonValue({ ...jsonRecord(frame.frameJson), ...jsonRecord(metadata), sourceSystem, sourceSystemId, forceClass: "learned_language_prior" }) };
}

function corpusSourceTrust(sourceSystem: string): SourceTrust {
  if (sourceSystem === CORPUS_SOURCE_SYSTEM_IDS.wikipedia) return {
    identity: 0.98, integrity: 1, parserReliability: 0.92, directness: 0.84,
    authority: 0.88, freshness: 0.68, independenceGroup: "wikimedia:wikipedia",
    accessScope: "public", licenseStatus: "licensed"
  };
  if (sourceSystem === CORPUS_SOURCE_SYSTEM_IDS.workspace) return {
    identity: 1, integrity: 1, parserReliability: 0.94, directness: 1,
    authority: 1, freshness: 0.98, independenceGroup: "owner:workspace",
    accessScope: "owner_private", licenseStatus: "owner_authorized"
  };
  if (sourceSystem === CORPUS_SOURCE_SYSTEM_IDS.corrections) return {
    identity: 1, integrity: 1, parserReliability: 1, directness: 1,
    authority: 1, freshness: 1, independenceGroup: "owner:corrections",
    accessScope: "owner_private", licenseStatus: "owner_authorized"
  };
  // Human-authored dialogue: direct and owner-authorized like corrections, but never a factual authority.
  if (sourceSystem === CORPUS_SOURCE_SYSTEM_IDS.dialogue) return {
    identity: 1, integrity: 1, parserReliability: 1, directness: 1,
    authority: 0, freshness: 1, independenceGroup: "owner:dialogue",
    accessScope: "owner_private", licenseStatus: "owner_authorized"
  };
  if (sourceSystem === CORPUS_SOURCE_SYSTEM_IDS.ossDocs) return {
    identity: 0.9, integrity: 1, parserReliability: 0.9, directness: 0.82,
    authority: 0.76, freshness: 0.72, independenceGroup: "corpus:oss-docs",
    accessScope: "public", licenseStatus: "licensed"
  };
  if (sourceSystem === CORPUS_SOURCE_SYSTEM_IDS.ossCode) return {
    identity: 0.9, integrity: 1, parserReliability: 0.94, directness: 0.9,
    authority: 0.72, freshness: 0.72, independenceGroup: "corpus:oss-code",
    accessScope: "public", licenseStatus: "licensed"
  };
  if (sourceSystem === CORPUS_SOURCE_SYSTEM_IDS.gutenberg) return {
    identity: 0.96, integrity: 1, parserReliability: 0.88, directness: 0.72,
    authority: 0.7, freshness: 0.2, independenceGroup: "corpus:gutenberg",
    accessScope: "public", licenseStatus: "public_domain"
  };
  return {
    identity: 0.5, integrity: 1, parserReliability: 0.7, directness: 0.5,
    authority: 0.4, freshness: 0.5, independenceGroup: `corpus:${sourceSystem}`,
    accessScope: "unknown", licenseStatus: "unknown"
  };
}

function verifiedPublicCorpusLabel(sourceSystem: string): InformationLabel {
  if (sourceSystem !== CORPUS_SOURCE_SYSTEM_IDS.wikipedia && sourceSystem !== CORPUS_SOURCE_SYSTEM_IDS.gutenberg) {
    throw new Error(`language corpus ${sourceSystem} requires an explicit information label`);
  }
  return {
    tenantId: "scce.public.corpus",
    principals: [],
    compartments: [],
    exportClass: "public",
    mergePolicy: "same_owner"
  };
}

function jsonRecord(value: JsonValue | undefined): Record<string, JsonValue> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return value as Record<string, JsonValue>;
}
