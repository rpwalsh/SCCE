// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
import path from "node:path";
import { ingestStageTracer } from "./ingest-stage-trace-sink.js";
import { existsSync } from "node:fs";
import { freemem, totalmem, tmpdir } from "node:os";
import {
  canonicalStringify,
  createClock,
  createEventFactory,
  createEvidenceExtractor,
  putSpanBlobs,
  createHasher,
  createIdFactory,
  createLanguageAcquisitionEngine,
  languageAliasSurfacesFromMetadata,
  createSourceAdmissionController,
  createSourceGraphBuilder,
  createTypedIngestProjector,
  prepareConstructionInduction,
  prepareConstructionInductionFromCorpus,
  prepareConstructionInductionAsync,
  preparedLanguageInductionProducts,
  sourceLanguageInductionDocuments,
  observedEntitySurfacesFromInducedLanguageModel,
  preparePooledLanguageProfileBinding,
  projectSourceOwnedText,
  compileRelationPromotionModel,
  relationPromotionNeedsPriors,
  compileOpaqueRoleModel,
  compileRoleSurfaceOrderModel,
  graphFromStructuredSemanticCandidates,
  relationObservationsFromCandidates,
  toJsonValue,
  validateBrainManifestContract,
  compileBrainReplayManifest,
  validationDisposition,
  type BrainLifecycleRecord,
  type BrainManifestContract,
  type BrainValidationReport,
  type BrainShardProvenanceClass,
  type Clock,
  type ContentHash,
  type EvidenceSpan,
  type GraphEdge,
  type GraphNode,
  type Hasher,
  type IdFactory,
  type IngestedSourceFile,
  type IngestionCheckpoint,
  type InformationLabel,
  type JsonValue,
  type ScceStorage,
  type SourceVersion,
  type SourceVersionId,
  type SourceOwnedTextProjection,
  type StructuredSemanticCandidate
} from "@scce/kernel";
import { evidenceSourceFamilyId } from "@scce/kernel";
import type { SourceLanguageFamilyRange } from "@scce/kernel";
import { effectiveNgramShardChars, type ScceRuntimeConfig } from "./config.js";
import { prepareLanguageCorpusTraining, commitLanguageCorpusTraining, languageCorpusTrainingRecipeId, type LanguageCorpusTrainingInput } from "./language-corpus-trainer.js";
import { blobContentHash } from "./postgres.js";
import { corpusArchiveIdentity } from "./canonical-evidence-text.js";
import { detectWikipediaIndexPath, resolveWikipediaCorpusTarget, spanProvenanceMetadata, streamWikipediaMultistream, wikipediaLanguageSurface, wikipediaRootUri, type ResolvedWikipediaCorpus, type WikipediaArchiveDescriptor, type WikipediaArchiveReference, type WikipediaLanguageSurface, type WikipediaLanguageSurfaceMapping } from "./wikipedia.js";
import { createWikipediaInputManifest, wikipediaInputSourcesStillMatch, type WikipediaInputManifest } from "./wikipedia-input-manifest.js";
import { WIKIPEDIA_LANGUAGE_SURFACE_TRANSFORM, WIKIPEDIA_SURFACE_TRANSFORM } from "./wikipedia-markup.js";
import { ingestionCodeIdentity } from "./ingestion-code-identity.js";
import { runSourceInductionExecution, type SourceInductionExecutionReceipt } from "./source-induction-execution.js";
import { prepareLanguageTrainingSegmentationInput, languageTrainingSegmentationLoader, type PreparedLanguageTrainingSegmentation } from "./language-training-segmentation.js";
import { finalizeWikipediaCandidatePublication, type WikipediaPublicationEvidence } from "./wikipedia-publication-finalization.js";

/** The compact Kneser-Ney summary's most-continued symbols, narrowed out of the profile's JSON shape. */
function profileTopContinuation(kneserNey: unknown): Array<[string, number]> {
  const top = (kneserNey as { topContinuation?: unknown } | undefined)?.topContinuation;
  if (!Array.isArray(top)) return [];
  return top
    .filter((pair): pair is [string, number] => Array.isArray(pair) && typeof pair[0] === "string" && typeof pair[1] === "number")
    .map(pair => [pair[0], pair[1]]);
}

const WIKIPEDIA_INFORMATION_LABEL: InformationLabel = {
  tenantId: "scce.public.corpus",
  principals: [],
  compartments: [],
  exportClass: "public",
  mergePolicy: "same_owner"
};

export interface WikipediaV3IngestOptions {
  acquireOnly?: boolean;
  signal?: AbortSignal;
  dumpPath: string;
  indexPath?: string;
  maxPages?: number;
  maxBlocks?: number;
  /** Drain the verified open language journal without reading another page. */
  finishPending?: boolean;
  resume?: boolean;
  fresh?: boolean;
  startOffset?: number;
  memorySafetyBoundMb?: number;
  heapCheckpointMb?: number;
  stopFile?: string;
  onStatus?: (status: WikipediaV3IngestStatus) => Promise<void> | void;
}

export interface WikipediaV3IngestResult {
  lastSourceInductionExecutions?: WikipediaSourceInductionExecutions;
  languageMode?: "acquisition_only" | "local_bootstrap" | "corpus_snapshot";
  episodeId: string;
  inputManifestId?: string;
  rootUri: string;
  dumpPath: string;
  indexPath?: string;
  resumedFromOffset: number;
  blocks: number;
  pages: number;
  sources: number;
  truncatedPages: number;
  truncatedCharacters: number;
  evidence: number;
  graphNodes: number;
  graphEdges: number;
  graphHyperedges: number;
  languageProfiles: number;
  ngramObservations: number;
  ngramModels: number;
  languageUnits: number;
  languagePatterns: number;
  semanticFrames: number;
  relationCandidates: number;
  promotedRelations: number;
  lastCheckpointOffset: number;
  heapMiB: number;
  rssMiB: number;
  stoppedByHeapSafetyBound: boolean;
  stoppedByOwner: boolean;
  stopReason?: string;
  skipped: Array<{ path: string; reason: string }>;
  warnings: string[];
}

interface WikipediaLanguageShardSample {
  uri: string;
  title?: string;
  sourceVersionId: SourceVersionId;
  text: string;
  languageProjection?: WikipediaLanguageSurfaceMapping[];
  evidence: EvidenceSpan[];
  createdAt: number;
  languageAliases: string[];
  semanticCandidates: StructuredSemanticCandidate[];
  sourceReference?: WikipediaLanguageSourceReference;
}

interface WikipediaLanguageSourceReference {
  contentHash: ContentHash;
  byteLength: number;
  originalSourceVersionId: SourceVersionId;
  originalContentHash: ContentHash;
  originalByteLength: number;
}

/** Only reconstruction identities and already-derived cognitive metadata belong in the durable journal. */
interface WikipediaLanguageShardSampleReference {
  uri: string;
  title?: string;
  sourceVersionId: SourceVersionId;
  sourceReference: WikipediaLanguageSourceReference;
  textContentHash: ContentHash;
  textChars: number;
  projectionHash: ContentHash;
  evidence: Array<Pick<EvidenceSpan, "id" | "contentHash" | "byteStart" | "byteEnd" | "charStart" | "charEnd"> & { snapshotHash: ContentHash }>;
  createdAt: number;
  languageAliases: string[];
  semanticCandidates: StructuredSemanticCandidate[];
}

interface WikipediaLanguageBatchJournal {
  readonly version: 1 | 2;
  readonly state: "open" | "idle";
  readonly blockOffset: number;
  readonly blockOrdinal: number;
  readonly blockComplete: boolean;
  readonly lastProcessedPageOrdinal: number;
  readonly processedPageCount: number;
  readonly pendingSamples: WikipediaLanguageShardSample[];
  readonly pendingChars: number;
  readonly shardUri: string;
  readonly languageTrainingDocumentCount: number;
  readonly languageSkippedDocumentCount: number;
  readonly progressCounts: WikipediaLanguageProgressCounts;
}

interface WikipediaCompilerTransitionReceipt {
  readonly version: 1;
  readonly boundaryKind: "complete-boundary" | "verified-midblock";
  readonly inputManifestId: string;
  readonly fromCompilerIdentity: string;
  readonly toCompilerIdentity: string;
  readonly fromJournalHash: ContentHash;
  readonly blockOffset: number;
  readonly blockEnd: number;
  readonly blockOrdinal: number;
  readonly lastProcessedPageOrdinal: number;
  readonly processedPageCount: number;
  readonly skippedPageCount: number;
  readonly verifiedPrefixHash: ContentHash;
}

interface StoredWikipediaLanguageBatchJournal {
  readonly journal: WikipediaLanguageBatchJournal;
  readonly journalHash: ContentHash;
  readonly compilerIdentity?: string;
  readonly compilerTransitions: readonly WikipediaCompilerTransitionReceipt[];
}

interface WikipediaLanguageProgressCounts {
  pages: number;
  sources: number;
  truncatedPages: number;
  truncatedCharacters: number;
  evidence: number;
  graphNodes: number;
  graphEdges: number;
  graphHyperedges: number;
  languageProfiles: number;
  ngramObservations: number;
  ngramModels: number;
  languageUnits: number;
  languagePatterns: number;
  semanticFrames: number;
  relationCandidates: number;
  promotedRelations: number;
  lastCheckpointOffset: number;
}

interface WikipediaPageImport {
  sources: number;
  truncatedPages?: number;
  truncatedCharacters?: number;
  evidence: number;
  graphNodes: number;
  graphEdges: number;
  graphHyperedges: number;
  languageProfiles: number;
  ngramObservations: number;
  ngramModels: number;
  languageUnits: number;
  languagePatterns: number;
  semanticFrames: number;
  relationCandidates: number;
  promotedRelations: number;
  languageSample?: WikipediaLanguageShardSample;
  warnings: string[];
}

export interface WikipediaSourceInductionExecutions {
  shardUri: string;
  prewarm?: SourceInductionExecutionReceipt;
  training?: SourceInductionExecutionReceipt;
}

interface WikipediaLanguageShardImport {
  sourceInductionExecutions?: WikipediaSourceInductionExecutions;
  languageProfiles: number;
  ngramObservations: number;
  ngramModels: number;
  languageUnits: number;
  languagePatterns: number;
  semanticFrames: number;
  relationCandidates: number;
  promotedRelations: number;
  graphHyperedges: number;
  warnings: string[];
}

export interface WikipediaV3IngestStatus {
  schema: "scce.wikipediaV3FirehoseStatus.v1";
  pid: number;
  state: "starting" | "running" | "stopping" | "stopped" | "completed" | "failed";
  stage?: "source" | "preparing-language" | "language-profile" | "language-induction" | "language-profile-binding" | "compiling-language" | "committing-language";
  pendingLanguagePages?: number;
  pendingLanguageChars?: number;
  committedLanguageDocuments?: number;
  episodeId: string;
  rootUri: string;
  dumpPath: string;
  indexPath?: string;
  resumedFromOffset: number;
  blocks: number;
  pages: number;
  sources: number;
  truncatedPages: number;
  truncatedCharacters: number;
  evidence: number;
  graphNodes: number;
  graphEdges: number;
  graphHyperedges: number;
  ngramObservations: number;
  ngramModels: number;
  languageUnits: number;
  languagePatterns: number;
  semanticFrames: number;
  relationCandidates: number;
  promotedRelations: number;
  lastCheckpointOffset: number;
  heapMiB: number;
  rssMiB: number;
  startedAt: number;
  updatedAt: number;
  finishedAt?: number;
  stoppedByHeapSafetyBound: boolean;
  stoppedByOwner: boolean;
  fullTrainingRequested: boolean;
  fullTrainingComplete: boolean;
  stopReason?: string;
  warnings: string[];
}

export interface WikipediaV3IngestorOptions {
  storage: ScceStorage;
  config: ScceRuntimeConfig;
  idFactory?: IdFactory;
  hasher?: Hasher;
  clock?: Clock;
  /** Independent evaluator evidence. Absence is persisted as pending and never advances READY. */
  publicationEvidence?: (candidate: {
    manifest: BrainManifestContract;
    result: WikipediaV3IngestResult;
  }) => Promise<WikipediaPublicationEvidence | undefined> | WikipediaPublicationEvidence | undefined;
}

export function createWikipediaV3Ingestor(options: WikipediaV3IngestorOptions): WikipediaV3Ingestor {
  return new WikipediaV3Ingestor(options);
}

/** Blob identity deduplicates bytes; a source version additionally owns provenance and a coordinate role. */
export function wikipediaSourceVersionIdentities(file: IngestedSourceFile, ids: Pick<IdFactory, "sourceId" | "sourceVersionId">) {
  const sourceId = ids.sourceId(file.namespace, file.uri);
  const originalVersionId = ids.sourceVersionId(canonicalStringify({
    contract: "scce.wikipedia-source-version.v1", sourceId,
    revisionId: objectOrEmpty(file.metadata).revisionId ?? null,
    contentHash: blobContentHash(file.bytes), role: "original"
  }));
  const derivative = file.evidenceDerivative;
  const evidenceVersionId = derivative ? ids.sourceVersionId(canonicalStringify({
    contract: "scce.wikipedia-source-version.v1", sourceId, originalVersionId,
    contentHash: blobContentHash(derivative.bytes), role: "evidence-derivative",
    transformId: derivative.transformId, originalCoordinateSpace: derivative.originalCoordinateSpace,
    redactionMap: derivative.redactionMap
  })) : originalVersionId;
  return { sourceId, originalVersionId, evidenceVersionId };
}

class WikipediaOwnerStop extends Error {}

export class WikipediaV3Ingestor {
  private readonly storage: ScceStorage;
  private readonly config: ScceRuntimeConfig;
  private readonly clock: Clock;
  private readonly hasher: Hasher;
  private readonly ids: IdFactory;
  private readonly events;
  private readonly evidenceExtractor;
  private readonly admission;
  private readonly language;
  private readonly graphBuilder;
  private readonly typedIngest;
  private readonly publicationEvidence?: WikipediaV3IngestorOptions["publicationEvidence"];

  constructor(options: WikipediaV3IngestorOptions) {
    this.storage = options.storage;
    this.config = options.config;
    this.clock = options.clock ?? createClock();
    this.hasher = options.hasher ?? createHasher();
    this.ids = options.idFactory ?? createIdFactory({ clock: this.clock, hasher: this.hasher, namespace: "wiki-v3-ingestor" });
    this.events = createEventFactory({ idFactory: this.ids, clock: this.clock, hasher: this.hasher });
    this.evidenceExtractor = createEvidenceExtractor({ idFactory: this.ids, hasher: this.hasher });
    this.admission = createSourceAdmissionController();
    this.language = createLanguageAcquisitionEngine({ idFactory: this.ids });
    this.graphBuilder = createSourceGraphBuilder({ idFactory: this.ids });
    this.typedIngest = createTypedIngestProjector({ idFactory: this.ids, hasher: this.hasher });
    this.publicationEvidence = options.publicationEvidence;
  }

  async ingest(input: WikipediaV3IngestOptions): Promise<WikipediaV3IngestResult> {
    if (input.acquireOnly && input.finishPending) throw new Error("--acquire-only cannot finish a pending language-training journal; use stored corpus replay after consolidation");
    if (input.finishPending && (input.fresh || input.resume === false || input.startOffset !== undefined)) {
      throw new Error("Wikipedia --finish-pending requires stored resume; fresh, --no-resume, and --start-offset are incompatible");
    }
    const target = path.resolve(input.dumpPath);
    const resolved = resolveWikipediaCorpusTarget(this.config, target);
    if (!resolved) throw new Error(`not a configured Wikipedia multistream dump: ${target}`);
    const corpus: ResolvedWikipediaCorpus = {
      ...resolved,
      indexPath: input.indexPath ? path.resolve(input.indexPath) : resolved.indexPath ?? await detectWikipediaIndexPath(resolved.dumpPath),
      maxPagesPerRun: input.maxPages ?? resolved.maxPagesPerRun,
      maxBlocksPerRun: input.maxBlocks ?? resolved.maxBlocksPerRun,
      memorySafetyBoundMb: input.memorySafetyBoundMb ?? resolved.memorySafetyBoundMb
    };
    const rootUri = wikipediaRootUri(corpus);
    const wikiConfig = this.config.runtime.corpora?.wikipedia;
    const segmentationSelection = input.acquireOnly ? undefined
      : await prepareLanguageTrainingSegmentationInput(this.storage, this.config.runtime.corpusSegmentation);
    const inputManifest = await createWikipediaInputManifest({
      dumpPath: corpus.dumpPath, indexPath: corpus.indexPath,
      cacheDir: path.join(this.config.runtime.tempRoot ?? tmpdir(), "wikipedia-input-identities"),
      normalizationIdentity: WIKIPEDIA_SURFACE_TRANSFORM,
      compilerIdentity: await ingestionCodeIdentity(),
      semanticConfig: {
        namespace: corpus.namespace, wikiCode: corpus.wikiCode, allowedNamespaces: [...corpus.allowedNamespaces].sort((a, b) => a - b),
        skipRedirects: corpus.skipRedirects, maxArticleChars: corpus.maxArticleChars,
        maxChunkBytes: this.config.runtime.maxChunkBytes ?? null,
        languageTrainingRecipeId: languageCorpusTrainingRecipeId("wikipedia"),
        segmentation: input.acquireOnly ? { mode: "acquisition_only" } : segmentationSelection!.identity,
        ngramShardChars: effectiveNgramShardChars(wikiConfig?.ngramShardChars),
        ngramMaxOrder: wikiConfig?.ngramMaxOrder ?? 4,
        ngramMaxCountersPerOrder: wikiConfig?.ngramMaxCountersPerOrder ?? 128,
        ngramVocabularyLimit: wikiConfig?.ngramVocabularyLimit ?? 8192,
        languageTrainingDocumentLimit: wikiConfig?.languageTrainingDocumentLimit ?? 0,
        alignmentLatticesPerShard: wikiConfig?.alignmentLatticesPerShard ?? 48
      }
    });
    corpus.remoteSource = inputManifest.inputs.remoteDump;
    // Wikipedia remains in its pinned multistream archive. Adapters must persist archive/range
    // references; silently falling back to expanded article copies defeats this ingestion path.
    if (corpus.remoteSource) throw new Error("retained Wikipedia ingestion requires a local dump; remote archive reconstruction is not implemented");
    if (!this.storage.blobs.putArchiveReferences || !this.storage.blobs.putRanges) {
      throw new Error("Wikipedia ingestion requires archive-reference and byte-range blob storage");
    }
    if (!Number.isSafeInteger(corpus.maxBlockBytes) || corpus.maxBlockBytes < 1 || corpus.maxBlockBytes > 192 * 1024 * 1024) {
      throw new Error("retained Wikipedia archive decoding requires maxBlockBytes within 192 MiB");
    }
    const archive: WikipediaArchiveDescriptor = {
      schema: "scce.wikipedia_archive.v1", manifest: inputManifest, python: corpus.python,
      maxBlockBytes: corpus.maxBlockBytes, maxArticleChars: corpus.maxArticleChars
    };
    const shardCharBudget = effectiveNgramShardChars(wikiConfig?.ngramShardChars);
    const assertInputUnchanged = async (): Promise<void> => {
      if (!await wikipediaInputSourcesStillMatch(inputManifest)) throw new Error("Wikipedia input changed during ingestion; no further checkpoint or activation is permitted");
    };
    await assertInputUnchanged();
    const resumeCheckpoint = await this.resumeCheckpoint(rootUri, inputManifest.identity);
    const languageBatchJournalId = wikipediaLanguageBatchJournalId(rootUri, inputManifest.identity, this.ids);
    const useStoredResume = input.startOffset === undefined && !input.fresh && input.resume !== false;
    const languageBatchJournalCheckpoint = await this.storage.ingestion.get(languageBatchJournalId) ?? null;
    const storedLanguageBatchState = await readWikipediaLanguageBatchJournal(languageBatchJournalCheckpoint, inputManifest.identity, shardCharBudget,
      inputManifest.semantics.compilerIdentity, this.storage);
    const storedLanguageBatchJournal = storedLanguageBatchState?.journal;
    const compilerTransition = storedLanguageBatchState && languageBatchJournalCheckpoint
      ? await verifyWikipediaMidblockCompilerTransition({
        stored: storedLanguageBatchState,
        currentCompilerIdentity: inputManifest.semantics.compilerIdentity,
        inputManifestId: inputManifest.identity,
        rootUri,
        corpus,
        storage: this.storage
      })
      : undefined;
    const compilerTransitions = [
      ...(storedLanguageBatchState?.compilerTransitions ?? []),
      ...(compilerTransition ? [compilerTransition] : [])
    ];
    // The verified transition is durable before the new executable can process a page. A crash or
    // lost acknowledgement therefore cannot leave new-compiler page effects behind an old attestation.
    if (compilerTransition && languageBatchJournalCheckpoint) {
      const transitionedCheckpoint: IngestionCheckpoint = {
        ...languageBatchJournalCheckpoint,
        metadata: toJsonValue({
          ...objectOrEmpty(languageBatchJournalCheckpoint.metadata),
          compilerIdentity: inputManifest.semantics.compilerIdentity,
          compilerTransitions
        }) ?? {},
        updatedAt: nowMs()
      };
      await this.storage.transaction(async () => {
        await assertInputUnchanged();
        if (await ingestionCodeIdentity() !== inputManifest.semantics.compilerIdentity) {
          throw new Error("Wikipedia compiler changed while its midblock transition was being verified; retry with one stable executable");
        }
        const compareAndPut = this.storage.ingestion.compareAndPut;
        if (!compareAndPut) throw new Error("Wikipedia compiler transition requires atomic checkpoint compare-and-put storage support");
        const replaced = await compareAndPut.call(this.storage.ingestion, transitionedCheckpoint, languageBatchJournalCheckpoint);
        if (!replaced) throw new Error("Wikipedia compiler transition lost a concurrent journal update; retry from the new durable cursor");
      });
    }
    const languageBatchJournal = storedLanguageBatchJournal?.state === "open" ? storedLanguageBatchJournal : undefined;
    if (input.finishPending && !storedLanguageBatchJournal) {
      throw new Error("Wikipedia --finish-pending requires a stored language batch journal for this verified input");
    }
    const resumeJournal = useStoredResume ? storedLanguageBatchJournal : undefined;
    if (storedLanguageBatchJournal && !useStoredResume) {
      throw new Error("Wikipedia language batch journal exists; refusing fresh or explicit-offset replay that could duplicate learned contributions");
    }
    const resumedFromOffset = input.startOffset !== undefined ? Math.max(0, Math.floor(input.startOffset))
      : useStoredResume ? resumeJournal?.blockOffset ?? resumeCheckpoint?.offsetBytes ?? 0 : 0;
    const resumeAfterBlock = useStoredResume && (resumeJournal === undefined ? resumeCheckpoint !== undefined : resumeJournal.blockComplete);
    const resumedBlockOrdinal = resumeJournal?.blockOrdinal
      ?? (useStoredResume && resumeCheckpoint ? Number(objectOrEmpty(resumeCheckpoint.metadata).blockOrdinal) : 0);
    if (!Number.isSafeInteger(resumedBlockOrdinal) || resumedBlockOrdinal < 0 || (useStoredResume && resumedFromOffset > 0 && resumedBlockOrdinal < 1)) {
      throw new Error("Wikipedia resume cursor has no valid absolute block ordinal");
    }
    const episodeId = this.ids.episodeId();
    const startedAt = nowMs();
    await this.storage.events.append(this.events.create({
      episodeId,
      typeId: "OwnerAsked",
      payload: { command: "ingest.wikipedia.v3", dumpPath: corpus.dumpPath, indexPath: corpus.indexPath ?? null, inputManifest: toJsonValue(inputManifest), resumedFromOffset, memorySafetyBoundMb: corpus.memorySafetyBoundMb, finishPending: input.finishPending === true, acquireOnly: input.acquireOnly === true,
        compilerTransition: toJsonValue(compilerTransition ?? null) }
    }));

    const result: WikipediaV3IngestResult = {
      languageMode: input.acquireOnly ? "acquisition_only" : segmentationSelection!.identity.mode,
      episodeId: String(episodeId),
      inputManifestId: inputManifest.identity,
      rootUri,
      dumpPath: corpus.dumpPath,
      indexPath: corpus.indexPath,
      resumedFromOffset,
      blocks: 0,
      pages: 0,
      sources: 0,
      truncatedPages: 0,
      truncatedCharacters: 0,
      evidence: 0,
      graphNodes: 0,
      graphEdges: 0,
      graphHyperedges: 0,
      languageProfiles: 0,
      ngramObservations: 0,
      ngramModels: 0,
      languageUnits: 0,
      languagePatterns: 0,
      semanticFrames: 0,
      relationCandidates: 0,
      promotedRelations: 0,
      lastCheckpointOffset: resumedFromOffset,
      heapMiB: heapMiB(),
      rssMiB: rssMiB(),
      stoppedByHeapSafetyBound: false,
      stoppedByOwner: false,
      skipped: [],
      warnings: []
    };
    const fullTrainingRequested = !input.finishPending && corpus.maxBlocksPerRun === 0 && input.maxPages === undefined;
    let stopReason: string | undefined;
    let streamReachedEnd = false;
    let trainingStage: WikipediaV3IngestStatus["stage"] = "source";
    let stoppedBeforeEnd = false;
    let lastStatusAt = 0;
    let activeLanguageShardUri = languageBatchJournal?.shardUri ?? rootUri;
    let languageShardSamples: WikipediaLanguageShardSample[] = languageBatchJournal?.pendingSamples ?? [];
    if (input.acquireOnly && languageShardSamples.length) throw new Error("Acquisition-only journal cannot contain pending language training");
    let languageShardChars = languageBatchJournal?.pendingChars ?? 0;
    const pendingBlockCheckpoints: IngestionCheckpoint[] = [];
    let currentBlockOffset = languageBatchJournal?.blockOffset ?? resumedFromOffset;
    let currentBlockOrdinal = resumedBlockOrdinal;
    let currentBlockComplete = languageBatchJournal?.blockComplete ?? false;
    let lastProcessedPageOrdinal = languageBatchJournal?.lastProcessedPageOrdinal ?? 0;
    let processedPageCount = languageBatchJournal?.processedPageCount ?? 0;
    const resumedLanguageTrainingDocuments = useStoredResume
      ? resumeJournal?.languageTrainingDocumentCount
        ?? Number(objectOrEmpty(resumeCheckpoint?.metadata ?? null).languageTrainingDocumentCount ?? 0)
      : 0;
    let languageTrainedDocuments = Number.isSafeInteger(resumedLanguageTrainingDocuments) && resumedLanguageTrainingDocuments > 0 ? resumedLanguageTrainingDocuments : 0;
    let languageSkippedDocuments = resumeJournal?.languageSkippedDocumentCount ?? 0;
    const committedProgressCounts = resumeJournal?.progressCounts ?? zeroWikipediaLanguageProgressCounts();
    // 0 or absent trains every document. Past the limit, pages still become evidence, graph and a page
    // signature -- the cheap ~9% -- and only shard training stops.
    const languageTrainingDocumentLimit = Math.max(0, this.config.runtime.corpora?.wikipedia?.languageTrainingDocumentLimit ?? 0);
    const putLanguageBatchJournal = async (state: "open" | "idle", pendingSamples = languageShardSamples, pendingChars = languageShardChars): Promise<void> => {
      const pendingReferences: WikipediaLanguageShardSampleReference[] = [];
      if (state === "open") {
        // Serialization never reads the corpus on the normal write path. Existing v1 journals gain
        // source identities once, through the same access-controlled source-version store.
        for (const sample of pendingSamples) pendingReferences.push(await referenceWikipediaLanguageSample(sample, this.storage));
      }
      const journal = {
        version: 2,
        state,
        blockOffset: currentBlockOffset,
        blockOrdinal: currentBlockOrdinal,
        blockComplete: currentBlockComplete,
        lastProcessedPageOrdinal,
        processedPageCount,
        pendingSamples: pendingReferences,
        pendingChars: state === "open" ? pendingChars : 0,
        shardUri: activeLanguageShardUri,
        languageTrainingDocumentCount: languageTrainedDocuments,
        languageSkippedDocumentCount: languageSkippedDocuments,
        progressCounts: committedProgressCounts
      };
      await this.storage.ingestion.put({
        id: languageBatchJournalId,
        rootUri,
        itemUri: `${rootUri}/language-batch`,
        phase: "stored",
        status: "complete",
        offsetBytes: currentBlockOffset,
        updatedAt: nowMs(),
        metadata: toJsonValue({ inputManifestId: inputManifest.identity, compilerIdentity: inputManifest.semantics.compilerIdentity, compilerTransitions, languageBatch: journal }) ?? {}
      });
    };
    const applyLanguageShardImport = (imported: WikipediaLanguageShardImport): void => {
      if (imported.sourceInductionExecutions) result.lastSourceInductionExecutions = imported.sourceInductionExecutions;
      result.languageProfiles += imported.languageProfiles;
      result.ngramObservations += imported.ngramObservations;
      result.ngramModels += imported.ngramModels;
      result.languageUnits += imported.languageUnits;
      result.languagePatterns += imported.languagePatterns;
      result.semanticFrames += imported.semanticFrames;
      result.relationCandidates += imported.relationCandidates;
      result.promotedRelations += imported.promotedRelations;
      result.graphHyperedges += imported.graphHyperedges;
      result.warnings.push(...imported.warnings);
    };
    // A block boundary is permission to flush, not a reason to. Flushing on every one trained each model on a
    // block of this dump -- about five pages, 114KB -- while boundedLanguageShard declares a 1,200,000
    // character budget, so models got a tenth of the text the code intends them to have. Text per model is the
    // strongest lever measured on this corpus (200,000 symbols: 7.08 nats/token; 800,000: 5.73), so the shard
    // now accumulates across blocks until the budget is reached. Only overflow, a training limit, or actual
    // EOF or an explicit finish-pending request forces a partial batch. Ordinary bounded stops persist the buffer
    // and cursor without changing batch membership.
    const flushLanguageShard = async (shardUri: string, force = false): Promise<void> => {
      if (languageShardSamples.length && !force && languageShardChars < shardCharBudget) return;
      if (!languageShardSamples.length && !pendingBlockCheckpoints.length) return;
      const samples = languageShardSamples;
      // Resume may advance only when the language artifacts for these blocks are durable.
      // Keep the samples and checkpoints pending if compilation or any persistence write fails.
      const commitProgress = async (trained?: WikipediaLanguageShardImport): Promise<void> => {
        await assertInputUnchanged();
        if (trained) addWikipediaLanguageProgress(committedProgressCounts, trained);
        for (const checkpoint of pendingBlockCheckpoints) {
          checkpoint.metadata = toJsonValue({ ...objectOrEmpty(checkpoint.metadata), languageTrainingDocumentCount: languageTrainedDocuments });
          await this.storage.ingestion.put(checkpoint);
          committedProgressCounts.lastCheckpointOffset = Math.max(committedProgressCounts.lastCheckpointOffset, checkpoint.offsetBytes);
        }
        await putLanguageBatchJournal("open", [], 0);
      };
      // The shard owns one transaction around learned writes and progress. Its preparation happens before
      // that transaction; an empty shard has only progress to commit.
      const imported = samples.length
        ? await this.ingestLanguageShard(samples, shardUri, episodeId, inputManifest, commitProgress, {
          ownerStopReason: () => { const decision = stopDecision(input, result); return decision?.kind === "owner" ? decision.reason : undefined; },
          onPhase: async stage => { trainingStage = stage; await emitStatus("running"); },
          segmentation: segmentationSelection
        })
        : await this.storage.transaction(async () => { await commitProgress(); return undefined; });
      for (const checkpoint of pendingBlockCheckpoints) {
        result.lastCheckpointOffset = Math.max(result.lastCheckpointOffset, checkpoint.offsetBytes);
      }
      languageShardSamples = [];
      languageShardChars = 0;
      pendingBlockCheckpoints.length = 0;
      if (imported) applyLanguageShardImport(imported);
      trainingStage = "source";
    };
    const emitStatus = async (state: WikipediaV3IngestStatus["state"], finishedAt?: number): Promise<void> => {
      result.heapMiB = heapMiB();
      result.rssMiB = rssMiB();
      await input.onStatus?.({
        schema: "scce.wikipediaV3FirehoseStatus.v1",
        pid: typeof process !== "undefined" ? process.pid : 0,
        state,
        stage: trainingStage,
        pendingLanguagePages: languageShardSamples.length,
        pendingLanguageChars: languageShardChars,
        committedLanguageDocuments: languageTrainedDocuments - languageShardSamples.length,
        episodeId: String(episodeId),
        rootUri,
        dumpPath: corpus.dumpPath,
        indexPath: corpus.indexPath,
        resumedFromOffset,
        blocks: result.blocks,
        pages: result.pages,
        sources: result.sources,
        truncatedPages: result.truncatedPages,
        truncatedCharacters: result.truncatedCharacters,
        evidence: result.evidence,
        graphNodes: result.graphNodes,
        graphEdges: result.graphEdges,
        graphHyperedges: result.graphHyperedges,
        ngramObservations: result.ngramObservations,
        ngramModels: result.ngramModels,
        languageUnits: result.languageUnits,
        languagePatterns: result.languagePatterns,
        semanticFrames: result.semanticFrames,
        relationCandidates: result.relationCandidates,
        promotedRelations: result.promotedRelations,
        lastCheckpointOffset: result.lastCheckpointOffset,
        heapMiB: result.heapMiB,
        rssMiB: result.rssMiB,
        startedAt,
        updatedAt: nowMs(),
        finishedAt,
        stoppedByHeapSafetyBound: result.stoppedByHeapSafetyBound,
        stoppedByOwner: result.stoppedByOwner,
        fullTrainingRequested,
        fullTrainingComplete: fullTrainingRequested && streamReachedEnd && languageSkippedDocuments === 0 && (committedProgressCounts.truncatedPages ?? 0) === 0 && !result.stoppedByHeapSafetyBound && !result.stoppedByOwner,
        stopReason,
        warnings: result.warnings.slice(-64)
      });
    };
    await emitStatus("starting");

    try {
      let stream: ReturnType<typeof streamWikipediaMultistream> | undefined;
      if (input.finishPending) {
        // This operation deliberately does not open the dump stream. The journal's cursor,
        // manifest identity, and owner/heap fences remain authoritative for the next resume.
        stopReason = "finish-pending";
        stoppedBeforeEnd = true;
        const stop = stopDecision(input, result);
        if (stop) {
          stopReason = stop.reason;
          result.stoppedByHeapSafetyBound = stop.kind === "heap";
          result.stoppedByOwner = stop.kind === "owner";
          await emitStatus("stopping");
        } else {
          await flushLanguageShard(activeLanguageShardUri, true);
        }
      } else {
        const replaySkippedPages = languageBatchJournal && !languageBatchJournal.blockComplete ? languageBatchJournal.processedPageCount : 0;
        const streamCorpus = replaySkippedPages > 0 && corpus.maxPagesPerRun > 0
          ? { ...corpus, maxPagesPerRun: corpus.maxPagesPerRun + replaySkippedPages }
          : corpus;
        stream = streamWikipediaMultistream(streamCorpus, {
          resumeOffset: resumedFromOffset,
          resumeBlockOrdinal: resumedBlockOrdinal || undefined,
          resumeAfterBlock: resumeAfterBlock,
          discoverIndex: false,
          signal: input.signal
        });
      }
      if (stream) for await (const item of stream) {
        item.checkpoint.metadata = toJsonValue({ ...objectOrEmpty(item.checkpoint.metadata), inputManifestId: inputManifest.identity,
          compilerIdentity: inputManifest.semantics.compilerIdentity });
        const blockComplete = item.type === "checkpoint" && isBlockCheckpoint(item.checkpoint) && item.checkpoint.phase === "stored" && item.checkpoint.status === "complete";
        const streamComplete = item.type === "checkpoint" && !isBlockCheckpoint(item.checkpoint) && item.checkpoint.phase === "stored" && item.checkpoint.status === "complete";
        if (blockComplete) pendingBlockCheckpoints.push(item.checkpoint);
        else if (!streamComplete && item.type === "checkpoint") await this.storage.ingestion.put(item.checkpoint);
        if (item.type === "checkpoint") {
          const blockCheckpoint = isBlockCheckpoint(item.checkpoint);
          if (blockCheckpoint && item.checkpoint.phase === "extracting" && item.checkpoint.status === "running") {
            await flushLanguageShard(activeLanguageShardUri);
            activeLanguageShardUri = item.checkpoint.itemUri;
            const blockOffset = item.checkpoint.offsetBytes;
            currentBlockOrdinal = Number(objectOrEmpty(item.checkpoint.metadata).blockOrdinal);
            if (!(languageBatchJournal && !languageBatchJournal.blockComplete && languageBatchJournal.blockOffset === blockOffset)) {
              currentBlockOffset = blockOffset;
              currentBlockComplete = false;
              lastProcessedPageOrdinal = 0;
              processedPageCount = 0;
            }
          }
          if (blockCheckpoint && item.checkpoint.phase === "stored" && item.checkpoint.status === "complete") {
            currentBlockOffset = item.checkpoint.offsetBytes;
            currentBlockComplete = true;
            await flushLanguageShard(item.checkpoint.itemUri);
            result.blocks++;
          } else if (!blockCheckpoint && item.checkpoint.phase === "stored" && item.checkpoint.status === "complete") {
            const completion = objectOrEmpty(item.checkpoint.metadata);
            streamReachedEnd = completion.reachedEnd === true;
            if (streamReachedEnd) currentBlockComplete = true;
            if (!streamReachedEnd) stoppedBeforeEnd = true;
            if (typeof completion.stoppedAt === "string") stopReason = completion.stoppedAt;
            if (!stoppedBeforeEnd || !languageShardSamples.length) {
              await flushLanguageShard(activeLanguageShardUri, true);
              await assertInputUnchanged();
              await this.storage.ingestion.put(item.checkpoint);
            }
          }
          const now = nowMs();
          if (now - lastStatusAt > 5000) {
            lastStatusAt = now;
            await emitStatus("running");
          }
          const stop = stopDecision(input, result);
          if (stop) {
            stopReason = stop.reason;
            result.stoppedByHeapSafetyBound = stop.kind === "heap";
            result.stoppedByOwner = stop.kind === "owner";
            stoppedBeforeEnd = true;
            await emitStatus("stopping");
            break;
          }
          continue;
        }
        if (item.type === "skipped") {
          result.skipped.push(item.skipped);
          continue;
        }
        const pageMetadata = objectOrEmpty(item.checkpoint.metadata);
        const pageBlockOffset = Number(pageMetadata.blockOffset ?? item.checkpoint.offsetBytes);
        // The stream-wide ordinal restarts when seeking to a compressed block. Only its block-local
        // ordinal is a stable cursor across runs that start at different offsets.
        const pageOrdinal = Number(pageMetadata.blockPageOrdinal);
        if (!Number.isSafeInteger(pageOrdinal) || pageOrdinal < 1) throw new Error("Wikipedia page has no valid block-local cursor");
        if (pageBlockOffset === currentBlockOffset && pageOrdinal > 0 && pageOrdinal <= lastProcessedPageOrdinal) continue;
        const imported = await this.ingestPage(item.file, item.checkpoint, episodeId, archive);
        result.pages++;
        result.sources += imported.sources;
        result.truncatedPages += imported.truncatedPages ?? 0;
        result.truncatedCharacters += imported.truncatedCharacters ?? 0;
        result.evidence += imported.evidence;
        result.graphNodes += imported.graphNodes;
        result.graphEdges += imported.graphEdges;
        result.graphHyperedges += imported.graphHyperedges;
        result.languageProfiles += imported.languageProfiles;
        result.ngramObservations += imported.ngramObservations;
        result.ngramModels += imported.ngramModels;
        result.languageUnits += imported.languageUnits;
        result.languagePatterns += imported.languagePatterns;
        result.semanticFrames += imported.semanticFrames;
        result.relationCandidates += imported.relationCandidates;
        result.promotedRelations += imported.promotedRelations;
        if (imported.languageSample && !input.acquireOnly) {
          // Flushed BEFORE the page is added, not after the budget is passed. boundedLanguageShard is a
          // bounded prefix rather than a splitter, so a shard offered more than its budget loses the overflow:
          // flushing only at block boundaries offered 4,023,980 characters across 2 shards and lost 1,623,980
          // of them, 40.4% of the corpus. Flushing first means a shard is never offered more than it can hold,
          // which is lossless for every page while ngramShardChars >= maxArticleChars.
          const trainingOpen = !languageTrainingDocumentLimit || languageTrainedDocuments < languageTrainingDocumentLimit;
          if (trainingOpen) {
            const sampleChars = (imported.languageSample.title?.length ?? 0) + 1 + imported.languageSample.text.length;
            if (languageShardSamples.length && languageShardChars + sampleChars + 2 > shardCharBudget) {
              await flushLanguageShard(activeLanguageShardUri, true);
            }
            languageShardSamples.push(imported.languageSample);
            languageShardChars += sampleChars + (languageShardSamples.length > 1 ? 2 : 0);
            languageTrainedDocuments += 1;
          } else {
            languageSkippedDocuments++;
          }
        }
        // Overflow flushes the preceding batch before this page joins it. Advance only after the current
        // sample is buffered, so a committed batch can never checkpoint an untrained overflow page.
        currentBlockOffset = pageBlockOffset;
        currentBlockComplete = false;
        lastProcessedPageOrdinal = pageOrdinal;
        processedPageCount += 1;
        addWikipediaPageProgress(committedProgressCounts, imported);
        if (languageTrainingDocumentLimit && languageTrainedDocuments >= languageTrainingDocumentLimit) {
          await flushLanguageShard(activeLanguageShardUri, true);
        }
        result.warnings.push(...imported.warnings);
        const now = nowMs();
        if (now - lastStatusAt > 5000) {
          lastStatusAt = now;
          await emitStatus("running");
        }
        const stop = stopDecision(input, result);
        if (stop) {
          stopReason = stop.reason;
          result.stoppedByHeapSafetyBound = stop.kind === "heap";
          result.stoppedByOwner = stop.kind === "owner";
          stoppedBeforeEnd = true;
          await emitStatus("stopping");
          break;
        }
      }
      if (stoppedBeforeEnd) {
        // Preserve the cursor and cumulative counts even when the page was omitted from
        // language training or the current shard is empty. A bounded run must never fall
        // back to the last block checkpoint and replay already durable page effects.
        if (!languageShardSamples.length && pendingBlockCheckpoints.length) {
          await flushLanguageShard(activeLanguageShardUri, true);
        }
        const drainedBoundary = (input.finishPending || input.acquireOnly) && !result.stoppedByOwner && !result.stoppedByHeapSafetyBound
          && currentBlockComplete && languageShardSamples.length === 0 && languageShardChars === 0;
        await this.storage.transaction(async () => { await assertInputUnchanged(); await putLanguageBatchJournal(drainedBoundary ? "idle" : "open"); });
      } else {
        await flushLanguageShard(activeLanguageShardUri, true);
        await this.storage.transaction(async () => { await assertInputUnchanged(); await putLanguageBatchJournal("idle"); });
      }
      await assertInputUnchanged();
    } catch (error) {
      stopReason = messageOf(error);
      if (error instanceof WikipediaOwnerStop) {
        result.stoppedByOwner = true;
        stoppedBeforeEnd = true;
        streamReachedEnd = false;
        await emitStatus("stopping");
        await this.storage.transaction(async () => { await assertInputUnchanged(); await putLanguageBatchJournal("open"); });
      } else {
        await emitStatus("failed", nowMs()).catch(() => undefined);
        throw error;
      }
    }
    result.stopReason = stopReason;
    if (result.truncatedPages) result.warnings.push(`${result.truncatedPages} page(s) omit ${result.truncatedCharacters} normalized UTF-16 units beyond maxArticleChars; full raw source bytes remain in the retained archive`);
    if (languageSkippedDocuments) result.warnings.push(`${languageSkippedDocuments} page(s) were not language-trained because languageTrainingDocumentLimit was reached`);

    // An EOF-only resume can finish a journaled batch without importing a new page. It still
    // needs to publish the cumulative candidate manifest, otherwise the durable lifecycle stops
    // at the earlier partial run. Empty corpora with no prior checkpoint remain unregistered.
    const manifestResult = wikipediaResultWithProgress(result, committedProgressCounts);
    if (!input.acquireOnly && (manifestResult.sources > 0 || (streamReachedEnd && (resumeCheckpoint !== undefined || languageBatchJournalCheckpoint !== null)))) {
      await this.registerActiveWikipediaImport({ result: manifestResult, rootUri, corpus, importedAt: nowMs(), fullTrainingComplete: fullTrainingRequested && streamReachedEnd && languageSkippedDocuments === 0 && (committedProgressCounts.truncatedPages ?? 0) === 0 && !result.stoppedByHeapSafetyBound && !result.stoppedByOwner });
    }
    await this.storage.events.append(this.events.create({
      episodeId,
      typeId: "EpisodeClosed",
      payload: {
        output: `wiki ingested ${result.pages} pages, ${result.evidence} evidence spans, ${result.ngramObservations} n-gram observations`,
        rootUri,
        stoppedByHeapSafetyBound: result.stoppedByHeapSafetyBound,
        stoppedByOwner: result.stoppedByOwner,
        stopReason: stopReason ?? null,
        counts: toJsonValue(result)
      }
    }));
    await emitStatus(result.stoppedByHeapSafetyBound || result.stoppedByOwner ? "stopped" : "completed", nowMs());
    return result;
  }

  private async registerActiveWikipediaImport(input: { result: WikipediaV3IngestResult; rootUri: string; corpus: ResolvedWikipediaCorpus; importedAt: number; fullTrainingComplete: boolean }): Promise<void> {
    const result = input.result;
    const versionSeed = {
      inputManifestId: result.inputManifestId ?? null,
      rootUri: input.rootUri,
      dumpPath: input.corpus.dumpPath,
      indexPath: input.corpus.indexPath ?? null,
      lastCheckpointOffset: result.lastCheckpointOffset,
      pages: result.pages,
      sources: result.sources,
      evidence: result.evidence,
      graphNodes: result.graphNodes,
      graphEdges: result.graphEdges,
      graphHyperedges: result.graphHyperedges,
      languageProfiles: result.languageProfiles,
      ngramObservations: result.ngramObservations,
      languageUnits: result.languageUnits,
      languagePatterns: result.languagePatterns,
      semanticFrames: result.semanticFrames,
      relationCandidates: result.relationCandidates,
      promotedRelations: result.promotedRelations,
      ngramModels: result.ngramModels,
    };
    const operationalMetadata = {
      resumedFromOffset: result.resumedFromOffset,
      stoppedByHeapSafetyBound: result.stoppedByHeapSafetyBound,
      stoppedByOwner: result.stoppedByOwner,
      stopReason: result.stopReason ?? null
    };
    // Canonical, not `JSON.stringify`: the brain's identity must not depend on the order this object's keys happened
    // to be written in, so two runs that assemble the same counts in a different order hash to the same brain.
    const brainVersion = `wikipedia:${this.hasher.digestHex(canonicalStringify(versionSeed)).slice(0, 32)}`;
    const importRunId = String(this.ids.semanticId("wiki_import_run", versionSeed));
    const base = {
      importRunId,
      brainVersion,
      rootPath: input.corpus.dumpPath,
      sourcePath: input.corpus.dumpPath,
      fileHash: undefined,
      shardHash: this.hasher.digestHex(canonicalStringify(versionSeed)),
      sourceVersionId: undefined,
      evidenceIds: [],
      nodeIds: [],
      warnings: result.warnings.slice(0, 64),
      importedAt: input.importedAt
    };
    const metadata = {
      sourceSystem: "wikipedia",
      rootUri: input.rootUri,
      dumpPath: input.corpus.dumpPath,
      indexPath: input.corpus.indexPath ?? null,
      brainVersion,
      importRunId,
      resumable: true
    };
    const manifestHash = this.hasher.digestHex(JSON.stringify(versionSeed));
    const manifest: BrainManifestContract = {
      schema: "scce.brainManifestContract.v1",
      importRunId,
      brainVersion,
      rootPath: input.corpus.dumpPath,
      manifestHash,
      sourceId: input.rootUri,
      sourceSchema: "scce.wikipediaV3Import.v1",
      runtimeContractVersion: 1,
      content: {
        graphShardCount: result.graphNodes > 0 ? 1 : 0,
        languageShardCount: result.languageUnits + result.languagePatterns + result.ngramModels > 0 ? 1 : 0,
        ngramStateCount: result.ngramModels,
        priorSectionCount: 3
      },
      replayManifest: compileBrainReplayManifest({
        sourceSchema: "scce.wikipediaV3Import.v1",
        sourceManifestHash: manifestHash,
        componentIds: [
          `source-count:${result.sources}`,
          `evidence-count:${result.evidence}`,
          `graph-node-count:${result.graphNodes}`,
          `graph-edge-count:${result.graphEdges}`,
          `language-unit-count:${result.languageUnits}`,
          `language-pattern-count:${result.languagePatterns}`,
          `ngram-model-count:${result.ngramModels}`,
          `checkpoint-offset:${result.lastCheckpointOffset}`
        ],
        content: {
          graphShardCount: result.graphNodes > 0 ? 1 : 0,
          languageShardCount: result.languageUnits + result.languagePatterns + result.ngramModels > 0 ? 1 : 0,
          ngramStateCount: result.ngramModels,
          priorSectionCount: 3
        },
        configuration: toJsonValue({ versionSeed }),
        hasher: this.hasher
      }),
      metadata: toJsonValue({ sourceSystem: "wikipedia", rootUri: input.rootUri, result: { ...versionSeed, ...operationalMetadata } }),
      createdAt: input.importedAt
    };
    let lifecycle = await this.ensureWikipediaLifecycle(manifest, input.importedAt);
    if (lifecycle.state === "ACTIVE") return;
    if (lifecycle.state === "READY") {
      await this.deferWikipediaActivation(result);
      return;
    }
    await this.storage.brainImports.putLedger({
      ...base,
      id: String(this.ids.semanticId("wiki_import_ledger", { importRunId, sectionId: "direct-evidence" })),
      sectionId: "direct-evidence",
      sectionKind: "wiki_stream",
      forceClass: "direct_evidence",
      rowCounts: { source_versions: result.sources, evidence_spans: result.evidence },
      metadata: toJsonValue({ ...metadata, forceClass: "direct_evidence" })
    });
    await this.storage.brainImports.putLedger({
      ...base,
      id: String(this.ids.semanticId("wiki_import_ledger", { importRunId, sectionId: "language-priors" })),
      sectionId: "language-priors",
      sectionKind: "wiki_stream",
      forceClass: "learned_language_prior",
      rowCounts: {
        language_profiles: result.languageProfiles,
        ngram_observations: result.ngramObservations,
        ngram_models: result.ngramModels,
        language_units: result.languageUnits,
        language_patterns: result.languagePatterns,
        semantic_frames: result.semanticFrames
      },
      metadata: toJsonValue({ ...metadata, forceClass: "learned_language_prior" })
    });
    await this.storage.brainImports.putLedger({
      ...base,
      id: String(this.ids.semanticId("wiki_import_ledger", { importRunId, sectionId: "graph-priors" })),
      sectionId: "graph-priors",
      sectionKind: "wiki_stream",
      forceClass: "learned_concept_prior",
      rowCounts: { graph_nodes: result.graphNodes, graph_edges: result.graphEdges },
      metadata: toJsonValue({ ...metadata, forceClass: "learned_concept_prior" })
    });
    if (!wikipediaImportCanActivate(result)) {
      if (lifecycle.state === "IMPORTING") {
        await this.storage.brainImports.transitionLifecycle({
          importRunId,
          expectedState: "IMPORTING",
          toState: "STOPPED",
          updatedAt: input.importedAt,
          reason: result.stopReason ?? "Wikipedia import stopped before validation"
        });
      }
      return;
    }
    await this.storage.brainImports.putLedger({
      ...base,
      id: String(this.ids.semanticId("wiki_import_ledger", { importRunId, sectionId: "__import_complete__", manifestHash })),
      sectionId: "__import_complete__",
      sectionKind: "manifest",
      forceClass: "learned_concept_prior",
      fileHash: manifestHash,
      rowCounts: {},
      warnings: [],
      metadata: toJsonValue({ complete: true, stopped: false, manifestHash, sourceSystem: "wikipedia" })
    });
    if (lifecycle.state === "IMPORTING") {
      lifecycle = await this.storage.brainImports.transitionLifecycle({
        importRunId,
        expectedState: "IMPORTING",
        toState: "VALIDATING",
        updatedAt: input.importedAt,
        reason: "Wikipedia completion sentinel written; validation started"
      });
    }
    if (lifecycle.state === "VALIDATING") {
      const checks = [
        ...validateBrainManifestContract(manifest),
        { id: "wikipedia.sources", passed: result.sources > 0, severity: "error" as const, message: "Wikipedia import contains source versions" },
        { id: "wikipedia.not_stopped", passed: wikipediaImportCanActivate(result), severity: "error" as const, message: "Wikipedia import reached its declared batch boundary without an owner or heap stop" }
      ];
      const validation: BrainValidationReport = {
        schema: "scce.brainValidationReport.v1",
        importRunId,
        brainVersion,
        manifestHash,
        validatorVersion: "wikipedia-v3-import-lifecycle.v1",
        disposition: validationDisposition(checks),
        checks,
        validatedAt: input.importedAt
      };
      if (validation.disposition !== "PASSED") {
        await this.storage.brainImports.transitionLifecycle({ importRunId, expectedState: "VALIDATING", toState: "FAILED", updatedAt: input.importedAt, reason: "Wikipedia brain validation failed", validation });
        throw new Error(`Wikipedia brain validation failed for ${importRunId}`);
      }
      const evidence = await this.publicationEvidence?.({ manifest, result });
      const publication = await finalizeWikipediaCandidatePublication({
        storage: this.storage,
        lifecycle,
        ...(evidence === undefined ? {} : { evidence }),
        validatedAt: input.importedAt,
        hasher: this.hasher
      });
      lifecycle = publication.lifecycle;
      if (!publication.pending && !publication.qualification.qualified) {
        throw new Error(`Wikipedia publication qualification failed for ${importRunId}: ${publication.qualification.rejection.checkId}`);
      }
    }
    await this.deferWikipediaActivation(result);
  }

  private async deferWikipediaActivation(result: WikipediaV3IngestResult): Promise<void> {
    const active = await this.storage.brainImports.active();
    result.warnings.push(`Wikipedia candidate awaits artifact, replay, learned-speech, calibration and runtime qualification${active.activeBrainVersion ? `; ${active.activeBrainVersion} stays active` : ""}`);
  }

  private async ensureWikipediaLifecycle(manifest: BrainManifestContract, updatedAt: number): Promise<BrainLifecycleRecord> {
    let lifecycle = await this.storage.brainImports.getLifecycle(manifest.importRunId);
    if (!lifecycle) {
      await this.storage.brainImports.putLifecycle({
        importRunId: manifest.importRunId,
        brainVersion: manifest.brainVersion,
        rootPath: manifest.rootPath,
        state: "CREATED",
        manifest,
        revision: 0,
        createdAt: updatedAt,
        updatedAt
      });
      lifecycle = await this.storage.brainImports.getLifecycle(manifest.importRunId);
    }
    if (!lifecycle) throw new Error(`Wikipedia brain lifecycle creation failed for ${manifest.importRunId}`);
    if (lifecycle.brainVersion !== manifest.brainVersion || lifecycle.manifest.manifestHash !== manifest.manifestHash) throw new Error(`Wikipedia brain lifecycle identity conflict for ${manifest.importRunId}`);
    if (lifecycle.state === "CREATED" || lifecycle.state === "STOPPED" || lifecycle.state === "FAILED") {
      lifecycle = await this.storage.brainImports.transitionLifecycle({
        importRunId: manifest.importRunId,
        expectedState: lifecycle.state,
        toState: "IMPORTING",
        updatedAt,
        reason: lifecycle.state === "CREATED" ? "Wikipedia import registration started" : "Wikipedia import registration resumed"
      });
    }
    if (lifecycle.state === "QUARANTINED" || lifecycle.state === "INCOMPATIBLE") throw new Error(`Wikipedia brain import ${manifest.importRunId} is ${lifecycle.state}`);
    return lifecycle;
  }

  /**
   * Prior observations, read only when they could change a verdict this batch is responsible for. The check is
   * one indexed aggregate over the batch's own seeds; the read it guards is the whole table.
   */
  private async priorRelationObservations(
    candidates: readonly StructuredSemanticCandidate[]
  ): Promise<Awaited<ReturnType<NonNullable<ScceStorage["relationObservations"]>["list"]>>> {
    const store = this.storage.relationObservations;
    if (!store) return [];
    const batch = relationObservationsFromCandidates(candidates);
    if (!batch.length) return [];
    // Without the aggregate there is nothing to decide on, so read as before rather than guess.
    if (!store.sourceFamilyCountsForSeeds) return store.list({});
    const familyCountsOnFile = await store
      .sourceFamilyCountsForSeeds([...new Set(batch.map(row => row.relationSeedId))]);
    if (!relationPromotionNeedsPriors({ batch, familyCountsOnFile })) return [];
    return store.list({});
  }

  private async resumeCheckpoint(rootUri: string, inputManifestId: string): Promise<IngestionCheckpoint | undefined> {
    const latest = await this.storage.ingestion.list({ rootUri, limit: 1 });
    const checkpoints = await this.storage.ingestion.list({ rootUri, status: "complete", phase: "stored", itemUriPrefix: `${rootUri}/block/`, orderBy: "offsetBytes", limit: 1 });
    for (const row of [...latest, ...checkpoints]) {
      if (objectOrEmpty(row.metadata).inputManifestId !== inputManifestId) {
        throw new Error("Wikipedia resume input identity differs or is missing; legacy manifests require an empty candidate schema and a fresh run; source bytes, normalization, or semantic configuration must match");
      }
    }
    return checkpoints[0];
  }

  private async ingestPage(file: IngestedSourceFile, checkpoint: IngestionCheckpoint, episodeId: ReturnType<IdFactory["episodeId"]>, archive: WikipediaArchiveDescriptor): Promise<WikipediaPageImport> {
    return this.ingestPageTraced(file, checkpoint, episodeId, archive);
  }

  private async ingestPageTraced(file: IngestedSourceFile, checkpoint: IngestionCheckpoint, episodeId: ReturnType<IdFactory["episodeId"]>, archive: WikipediaArchiveDescriptor): Promise<WikipediaPageImport> {
    // page.transaction measured 1.9s mean at 23% CPU with nothing inside it named, so three quarters of a page
    // was unattributed. These stages account for it.
    const pageTrace = ingestStageTracer();
    const pageStage = <T>(name: string, work: () => T): T => {
      const span = pageTrace.span(name);
      try { return work(); } finally { span.end(); }
    };
    const now = this.clock.now();
    const warnings: string[] = [];
    const normalization = objectOrEmpty(objectOrEmpty(file.metadata).normalization ?? null);
    const truncatedCharacters = Math.max(0, Number(normalization.truncatedChars) || 0);
    const truncatedPages = truncatedCharacters > 0 ? 1 : 0;
    const originalFile = file;
    const derivative = file.evidenceDerivative;
    const archiveMetadata = objectOrEmpty(originalFile.metadata);
    const blockOffset = archiveMetadata.blockOffset;
    const blockEnd = archiveMetadata.blockCompressedEnd;
    const pageId = archiveMetadata.pageId;
    const revisionId = archiveMetadata.revisionId;
    if (typeof blockOffset !== "number" || !Number.isSafeInteger(blockOffset) || blockOffset < 0
      || typeof blockEnd !== "number" || !Number.isSafeInteger(blockEnd) || blockEnd <= blockOffset
      || blockEnd > archive.manifest.inputs.dump.byteLength
      || typeof pageId !== "string" || !/^\d+$/u.test(pageId)
      || typeof revisionId !== "string" || !/^\d+$/u.test(revisionId)) {
      throw new Error(`Wikipedia page has no valid retained archive location: ${file.uri}`);
    }
    const originalReference: WikipediaArchiveReference = {
      schema: "scce.wikipedia_archive_page.v1", blockOffset, blockEnd, pageId, revisionId,
      representation: "original", transformId: `${WIKIPEDIA_SURFACE_TRANSFORM}+redact-secrets`
    };
    const originalContentHash = blobContentHash(originalFile.bytes);
    const { sourceId, originalVersionId, evidenceVersionId: sourceVersionId } = wikipediaSourceVersionIdentities(file, this.ids);
    if (derivative) {
      if (!Buffer.from(derivative.text, "utf8").equals(Buffer.from(derivative.bytes))) throw new Error(`Wikipedia derivative bytes do not encode text: ${file.uri}`);
      if (derivative.transformId !== originalReference.transformId) throw new Error(`Wikipedia derivative transform cannot be reconstructed from its archive: ${file.uri}`);
      file = { ...file, bytes: derivative.bytes, text: derivative.text, mediaType: "text/plain; charset=utf-8" };
    }
    const declaredLanguageSurface = objectOrEmpty(normalization.languageSurface ?? null);
    const projectedLanguageSurface = wikipediaLanguageSurface(originalFile.text, undefined, file.text);
    const declaredLanguageTransform = stringValue(declaredLanguageSurface.transformId);
    if (declaredLanguageTransform && declaredLanguageTransform !== projectedLanguageSurface.transformId) {
      throw new Error(`Wikipedia language-surface transform mismatch for ${file.uri}: expected ${declaredLanguageTransform}, got ${projectedLanguageSurface.transformId}`);
    }
    const languageText = projectedLanguageSurface.text;
    // Derived, not stored yet: everything this method computes comes from the page's bytes alone, so the whole
    // derivation runs before the first write. That ordering is what shortens the transaction's write span, and
    // it is the seam a worker thread needs -- compute is pure, only the writes below need the database.
    const contentHash = blobContentHash(file.bytes);
    const metadata = toJsonValue({ ...objectOrEmpty(wikiMetadata(file.metadata)), sourceFamilyId: "wikimedia:wikipedia" });
    const source: SourceVersion = {
      sourceId,
      sourceVersionId,
      namespace: file.namespace,
      canonicalUri: file.uri,
      contentHash,
      mediaType: file.mediaType,
      observedAt: now,
      byteLength: file.bytes.byteLength,
      sourceTrust: {
        identity: 0.98,
        integrity: 1,
        parserReliability: 0.92,
        directness: 0.84,
        authority: 0.88,
        freshness: 0.68,
        independenceGroup: "wikimedia:wikipedia",
        accessScope: "public",
        licenseStatus: "licensed"
      },
      informationLabel: WIKIPEDIA_INFORMATION_LABEL,
      metadata,
      role: derivative ? "evidence-derivative" : "original",
      ...(derivative ? { derivation: {
        kind: derivative.kind, transformId: derivative.transformId,
        derivedFromSourceVersionId: originalVersionId,
        originalCoordinateSpace: derivative.originalCoordinateSpace, redactionMap: derivative.redactionMap
      } } : {})
    };
    const profile = {
      ...pageStage("page.language-profile", () => this.language.acquire({ sourceVersionId, text: languageText, createdAt: now })),
      informationLabel: WIKIPEDIA_INFORMATION_LABEL
    };
    const extractSpan = pageTrace.span("page.evidence-extract");
    const extracted = this.evidenceExtractor.extract({
      sourceId,
      sourceVersionId,
      namespace: file.namespace,
      uri: file.uri,
      mediaType: file.mediaType,
      text: file.text,
      languageProfile: profile,
      sourceTrust: source.sourceTrust,
      observedAt: now,
      maxChunkBytes: this.config.runtime.maxChunkBytes,
      metadata,
      sourceVersionDerivation: source.derivation,
      exactSourceText: true
    });
    extractSpan.end({ spans: 0 });
    const admissionSpan = pageTrace.span("page.admission");
    const decision = this.admission.decide({
      source,
      evidence: extracted.spans,
      context: {
        sourceClass: "trusted_corpus",
        intendedUse: "direct_evidence",
        promotionAuthority: "training"
      },
      metadata
    });
    // Writes begin here, in the order they were always in: the event ledger is a hash chain, so their
    // sequence is load-bearing and must never follow computation-completion order.
    admissionSpan.end();
    // Both graph producers are pure derivations. Finish them before opening the write transaction.
    const admittedSpans = stampEvidence(extracted.spans, metadata, WIKIPEDIA_INFORMATION_LABEL);
    const typedProjection = decision.disposition === "promote" ? pageStage("page.typed-project", () =>
      this.typedIngest.project({ sourceId, sourceVersionId, uri: file.uri, mediaType: file.mediaType, text: languageText, metadata, evidence: admittedSpans, observedAt: now })) : undefined;
    const builtGraph = decision.disposition === "promote" ? pageStage("page.graph-build", () =>
      this.graphBuilder.build({ sourceVersionId, uri: file.uri, mediaType: file.mediaType, languageProfile: profile, evidence: admittedSpans, observedAt: now })) : undefined;
    return this.storage.transaction(async () => {
    const transactionSpan = pageTrace.span("page.transaction");
    try {
    const sourceSpan = pageTrace.span("page.source-persist");
    const putArchiveReferences = this.storage.blobs.putArchiveReferences;
    if (!putArchiveReferences) throw new Error("Wikipedia archive-reference blob storage became unavailable");
    await putArchiveReferences.call(this.storage.blobs, {
      archiveId: corpusArchiveIdentity(archive),
      archive: toJsonValue(archive),
      items: [
        { contentHash: originalContentHash, mediaType: originalFile.mediaType, byteLength: originalFile.bytes.byteLength,
          reference: toJsonValue(originalReference) },
        ...(derivative ? [{ contentHash, mediaType: file.mediaType, byteLength: file.bytes.byteLength,
          reference: toJsonValue({ ...originalReference, representation: "evidence" }) }] : [])
      ]
    });
    if (derivative) {
      await this.storage.evidence.putSourceVersion({ ...source, sourceVersionId: originalVersionId,
        contentHash: originalContentHash, byteLength: originalFile.bytes.byteLength, mediaType: originalFile.mediaType,
        role: "original", derivation: undefined });
    }
    await this.storage.evidence.putSourceVersion(source);
    await this.storage.events.append(this.events.create({ episodeId, typeId: "SourceObserved", payload: { sourceId, uri: file.uri, namespace: file.namespace, sourceSystem: "wikipedia" } }));
    if (derivative) await this.storage.events.append(this.events.create({ episodeId, typeId: "SourceVersionObserved", payload: {
      sourceVersionId: originalVersionId, contentHash: originalContentHash, byteLength: originalFile.bytes.byteLength, role: "original"
    } }));
    await this.storage.events.append(this.events.create({ episodeId, typeId: "SourceVersionObserved", payload: {
      sourceVersionId, contentHash, byteLength: file.bytes.byteLength, role: source.role, derivation: toJsonValue(source.derivation ?? null)
    } }));
    // The page's own profile is computed for extraction and then discarded. Its signature is what identity
    // discovery counts documents with, so it is kept: a shard may hold any amount of text without shrinking
    // the population the closed class is measured over. The profile itself still does not become a durable
    // turn-time surface profile -- only trained shards do.
    if (this.storage.languageIdentities?.putProfileSignatures) {
      await this.storage.languageIdentities.putProfileSignatures({ informationLabel: WIKIPEDIA_INFORMATION_LABEL, rows: [{
        id: profile.id,
        sourceVersionId,
        sourceSystem: "wikipedia",
        sourceUri: file.uri,
        scripts: profile.scripts.map(row => ({ script: row.script, mass: row.mass })),
        direction: profile.direction,
        topContinuation: profileTopContinuation(profile.kneserNey)
      }] });
    }
    sourceSpan.end({ bytes: file.bytes.length });
    const quarantineSpan = pageTrace.span("page.quarantine-record");
    await this.storage.quarantine.put({
      id: `${sourceVersionId}:wiki-admission`,
      sourceId,
      sourceVersionId,
      uri: file.uri,
      contentHash,
      mediaType: file.mediaType,
      fetchedAt: now,
      trustVector: decision.audit,
      permissionVector: toJsonValue({
        disposition: decision.disposition,
        sourceAdmission: decision.context,
        activeInfluence: decision.activeInfluence,
        lane: "wiki_stream"
      }),
      decision: decision.disposition === "reject"
        ? "rejected"
        : decision.disposition === "promote"
          ? "promoted"
          : "pending",
      decisionJson: decision.audit
    });
    if (decision.disposition === "reject") {
    await this.storage.ingestion.put({ ...checkpoint, phase: "skipped", status: "complete", reason: "admission-rejected", updatedAt: now });
      return zeroPage({ warnings: decision.reasons, truncatedPages, truncatedCharacters });
    }
    if (decision.disposition !== "promote") {
      const actionByEvidence = new Map(decision.evidenceActions.map(action => [action.evidenceId, action]));
      const quarantinedSpans = extracted.spans.map(span => {
        const action = actionByEvidence.get(String(span.id));
        return {
          ...span,
          informationLabel: WIKIPEDIA_INFORMATION_LABEL,
          alpha: action?.action === "lower-alpha" ? Math.min(span.alpha, action.alpha) : span.alpha,
          status: "quarantined" as const,
          trustVector: {
            ...objectOrEmpty(span.trustVector),
            admission: decision.audit,
            action: action?.action ?? "quarantine"
          }
        };
      });
      await putSpanBlobs(this.storage.blobs, quarantinedSpans, file.mediaType, { contentHash, bytes: file.bytes });
      if (this.storage.evidence.putEvidenceSpans) await this.storage.evidence.putEvidenceSpans(quarantinedSpans);
      else for (const span of quarantinedSpans) await this.storage.evidence.putEvidenceSpan(span);
      await this.storage.ingestion.put({
        ...checkpoint,
        phase: "stored",
        status: "complete",
        reason: "admission-quarantined",
        updatedAt: now,
        metadata: {
          ...objectOrEmpty(wikiMetadata(checkpoint.metadata)),
          admission: decision.audit,
          activeInfluence: decision.activeInfluence
        }
      });
      return zeroPage({ warnings: decision.reasons, truncatedPages, truncatedCharacters });
    }

    if (!typedProjection || !builtGraph) throw new Error("Wikipedia promoted page is missing its derived graph");
    const evidenceSpan = pageTrace.span("page.evidence-persist");
    await putSpanBlobs(this.storage.blobs, admittedSpans, file.mediaType, { contentHash, bytes: file.bytes });
    if (this.storage.evidence.putEvidenceSpans) await this.storage.evidence.putEvidenceSpans(admittedSpans);
    else for (const span of admittedSpans) await this.storage.evidence.putEvidenceSpan(span);

    let graphNodes = 0;
    let graphEdges = 0;
    evidenceSpan.end({ spans: admittedSpans.length });
    const typedNodes = stampGraphNodes(typedProjection.graphNodes, WIKIPEDIA_INFORMATION_LABEL);
    const typedEdges = stampGraphEdges(typedProjection.graphEdges, WIKIPEDIA_INFORMATION_LABEL);
    const typedHyperedges = typedProjection.graphHyperedges.map(hyperedge => ({
      ...hyperedge,
      informationLabel: WIKIPEDIA_INFORMATION_LABEL
    }));
    // Split three ways: this call writes 21 nodes and 27 edges in 3,909ms while the next writes 231 nodes and
    // 260 edges in 1,278ms -- thirty times the cost per row, same tables, same transaction. A fixed cost lives
    // in one of these three and the aggregate span could not say which.
    const graphSpan = pageTrace.span("page.graph-persist");
    const nodeSpan = pageTrace.span("page.graph-nodes");
    if (this.storage.graph.upsertNodes) await this.storage.graph.upsertNodes(typedNodes);
    else for (const node of typedNodes) await this.storage.graph.upsertNode(node);
    nodeSpan.end({ nodes: typedNodes.length });
    const edgeSpan = pageTrace.span("page.graph-edges");
    if (this.storage.graph.upsertEdges) await this.storage.graph.upsertEdges(typedEdges);
    else for (const edge of typedEdges) await this.storage.graph.upsertEdge(edge);
    edgeSpan.end({ edges: typedEdges.length });
    const hyperSpan = pageTrace.span("page.graph-hyperedges");
    if (this.storage.graph.upsertHyperedges) await this.storage.graph.upsertHyperedges(typedHyperedges);
    else for (const hyperedge of typedHyperedges) await this.storage.graph.upsertHyperedge(hyperedge);
    hyperSpan.end({ hyperedges: typedHyperedges.length });
    graphSpan.end({ nodes: typedNodes.length, edges: typedEdges.length, hyperedges: typedHyperedges.length });
    graphNodes += typedProjection.graphNodes.length;
    graphEdges += typedProjection.graphEdges.length;
    let graphHyperedges = typedProjection.graphHyperedges.length;
    const builtNodes = stampGraphNodes(builtGraph.nodes, WIKIPEDIA_INFORMATION_LABEL);
    const builtEdges = stampGraphEdges(builtGraph.edges, WIKIPEDIA_INFORMATION_LABEL);
    const builtGraphSpan = pageTrace.span("page.graph-persist-built");
    if (this.storage.graph.upsertNodes) await this.storage.graph.upsertNodes(builtNodes);
    else for (const node of builtNodes) await this.storage.graph.upsertNode(node);
    if (this.storage.graph.upsertEdges) await this.storage.graph.upsertEdges(builtEdges);
    else for (const edge of builtEdges) await this.storage.graph.upsertEdge(edge);
    const builtHyperedges = builtGraph.hyperedges.map(hyperedge => ({ ...hyperedge, informationLabel: WIKIPEDIA_INFORMATION_LABEL }));
    if (this.storage.graph.upsertHyperedges) await this.storage.graph.upsertHyperedges(builtHyperedges);
    else for (const hyperedge of builtHyperedges) await this.storage.graph.upsertHyperedge(hyperedge);
    builtGraphSpan.end({ nodes: builtNodes.length, edges: builtEdges.length, hyperedges: builtHyperedges.length });
    graphNodes += builtGraph.nodes.length;
    graphEdges += builtGraph.edges.length;
    graphHyperedges += builtGraph.hyperedges.length;

    const checkpointSpan = pageTrace.span("page.checkpoint");
    await this.storage.ingestion.put({
      ...checkpoint,
      phase: "stored",
      status: "complete",
      offsetBytes: checkpoint.offsetBytes,
      contentHash,
      byteLength: file.bytes.byteLength,
      updatedAt: now,
      metadata: {
        ...objectOrEmpty(wikiMetadata(checkpoint.metadata)),
        typedIngest: typedProjection.diagnostics,
        languageMemory: { deferredToShard: true, sourceSystem: "wikipedia" },
        sourceSystem: "wikipedia"
      }
    });
    checkpointSpan.end();
    const eventSpan = pageTrace.span("page.events");
    await this.storage.events.append(this.events.create({ episodeId, typeId: "EvidenceLinked", payload: { sourceVersionId, evidence: admittedSpans.length, sourceSystem: "wikipedia" } }));
    await this.storage.events.append(this.events.create({ episodeId, typeId: "GraphUpdated", payload: { sourceVersionId, typed: typedProjection.diagnostics, built: builtGraph.diagnostics } }));
    eventSpan.end();

    return {
      sources: derivative ? 2 : 1,
      truncatedPages,
      truncatedCharacters,
      evidence: admittedSpans.length,
      graphNodes,
      graphEdges,
      graphHyperedges,
      // Page profiles are transient extraction aids. Only bounded, trained
      // language-shard profiles become durable turn-time surface profiles.
      languageProfiles: 0,
      ngramObservations: 0,
      ngramModels: 0,
      languageUnits: 0,
      languagePatterns: 0,
      semanticFrames: 0,
      relationCandidates: 0,
      promotedRelations: 0,
      languageSample: {
        uri: file.uri,
        title: stringValue(objectOrEmpty(metadata).title),
        sourceVersionId,
        text: languageText,
        languageProjection: projectedLanguageSurface.mappings,
        evidence: admittedSpans,
        createdAt: now,
        languageAliases: languageAliasSurfacesFromMetadata(metadata),
        semanticCandidates: typedProjection.semanticCandidates,
        sourceReference: { contentHash, byteLength: file.bytes.byteLength, originalSourceVersionId: originalVersionId,
          originalContentHash, originalByteLength: originalFile.bytes.byteLength }
      },
      warnings
    };
    } finally { transactionSpan.end({ bytes: originalFile.bytes.length }); }
    });
  }

  private async ingestLanguageShard(samples: readonly WikipediaLanguageShardSample[], shardUri: string, episodeId: ReturnType<IdFactory["episodeId"]>, inputManifest: WikipediaInputManifest, commitProgress: (trained?: WikipediaLanguageShardImport) => Promise<void>, control: {
    segmentation?: PreparedLanguageTrainingSegmentation;
    ownerStopReason?: () => string | undefined;
    onPhase?: (stage: NonNullable<WikipediaV3IngestStatus["stage"]>) => Promise<void>;
  } = {}): Promise<WikipediaLanguageShardImport> {
    if (!samples.length) return zeroLanguageShard({ warnings: [] });
    const initialStop = control.ownerStopReason?.();
    if (initialStop) throw new WikipediaOwnerStop(initialStop);
    await control.onPhase?.("preparing-language");
    const createdAt = samples.reduce((max, sample) => Math.max(max, sample.createdAt), 0) || this.clock.now();
    const segmentation = await prepareLanguageTrainingSegmentationInput(this.storage, this.config.runtime.corpusSegmentation);
    if (control.segmentation && canonicalStringify(control.segmentation.identity) !== canonicalStringify(segmentation.identity)) throw new Error("Wikipedia segmentation snapshot changed; restart with the new compiler manifest");
    const corpusLoader = await languageTrainingSegmentationLoader(this.storage, this.config.runtime.corpusSegmentation, segmentation);
    // How much text one model is trained on is the strongest lever measured on this corpus, and it is a memory
    // bound rather than a modelling choice, so it is configurable with the measured-safe value as the default.
    const shardChars = effectiveNgramShardChars(this.config.runtime.corpora?.wikipedia?.ngramShardChars);
    const boundedShard = boundedLanguageShard(samples, shardChars, 2048);
    if (boundedShard.droppedChars || boundedShard.droppedSamples) {
      throw new Error(`Wikipedia language shard exceeds its character budget by ${boundedShard.droppedChars}; refusing incomplete training and checkpoint advancement (the budget must include titles and separators)`);
    }
    const text = boundedShard.text;
    const shardWarnings: string[] = [];
    const sourceVersionId = this.ids.sourceVersionId(`${shardUri}\u001f${text}`);
    const trace = ingestStageTracer();
    await control.onPhase?.("language-profile");
    const profileSpan = trace.span("language.profile");
    const profile = {
      ...this.language.acquire({ sourceVersionId, text, createdAt }),
      informationLabel: WIKIPEDIA_INFORMATION_LABEL
    };
    profileSpan.end({ pages: samples.length, chars: text.length });
    const evidence = boundedShard.evidence;
    const textProjection = wikipediaLanguageTextProjection(samples);
    await control.onPhase?.("language-induction");
    const inductionSpan = trace.span("language.induction");
    const documents = wikipediaLanguageInductionDocuments(evidence, textProjection);
    const workerInduction = this.config.runtime.sourceInductionExecution
      ? await runSourceInductionExecution({ policy: this.config.runtime.sourceInductionExecution,
        run: execution => prepareConstructionInductionAsync({ documents, hasher: this.hasher, execution,
          ...(corpusLoader ? { corpusLoader } : {}) }) }) : undefined;
    const preparedInduction = workerInduction ? workerInduction.result : corpusLoader
      ? await prepareConstructionInductionFromCorpus({ documents, hasher: this.hasher, corpusLoader })
      : prepareConstructionInduction({ documents, hasher: this.hasher });
    const inducedProducts = preparedLanguageInductionProducts({ documents, hasher: this.hasher, prepared: preparedInduction });
    inductionSpan.end({ documents: documents.length });
    await control.onPhase?.("language-profile-binding");
    const bindingSpan = trace.span("language.profile-binding");
    const profileBinding = preparePooledLanguageProfileBinding({ profile, sourceVersionId, text, evidence,
      parentSourceVersionIds: boundedShard.sourceFamilyRanges.map(range => String(range.sourceVersionId)), sourceFamilyRanges: boundedShard.sourceFamilyRanges,
      hasher: this.hasher, ...(textProjection ? { textProjection } : {}) });
    bindingSpan.end({ evidence: evidence.length });
    const ngramMaxOrder = this.config.runtime.corpora?.wikipedia?.ngramMaxOrder ?? 4;
    const ngramMaxCounters = this.config.runtime.corpora?.wikipedia?.ngramMaxCountersPerOrder ?? 128;
    const vocabularyLimit = this.config.runtime.corpora?.wikipedia?.ngramVocabularyLimit ?? 8192;
    const trainSpan = trace.span("language.train");
    const trainingInput: LanguageCorpusTrainingInput = {
      corpusSegmentation: this.config.runtime.corpusSegmentation,
      sourceInductionExecution: this.config.runtime.sourceInductionExecution,
      preparedCorpusSegmentation: segmentation,
      storage: this.storage,
      sourceSystem: "wikipedia",
      streamUri: shardUri,
      sourceUri: shardUri,
      sourceVersionId,
      text,
      evidence,
      profile,
      preparedInduction,
      inductionDocuments: documents,
      ...(textProjection ? { textProjection } : {}),
      profileBinding,
      sourceFamilyRanges: boundedShard.sourceFamilyRanges,
      informationLabel: WIKIPEDIA_INFORMATION_LABEL,
      languageAliases: [...new Set(samples.flatMap(sample => sample.languageAliases))].sort(),
      createdAt,
      ngramMaxOrder,
      ngramMaxCountersPerOrder: ngramMaxCounters,
      ngramVocabularyLimit: vocabularyLimit,
      corpusMetadata: {
        inputManifestId: inputManifest.identity,
        shardUri,
        pages: samples.length,
        sourceVersionIds: samples.map(sample => String(sample.sourceVersionId))
      },
      persistSource: false,
      // Compiled models carry the same order counts; the translation compiler consumes these models too.
      skipNgramObservationPersistence: true,
      episodeId
    };
    const entityConstructions = inducedProducts.models.flatMap(model => model.graphBoundConstructions);
    const semanticCandidates = samples.flatMap(sample => {
      const current = sample.evidence[0];
      if (!current) return sample.semanticCandidates;
      const projected = this.typedIngest.project({ sourceId: current.sourceId, sourceVersionId: sample.sourceVersionId,
        uri: sample.uri, mediaType: current.mediaType, text: sample.text, metadata: toJsonValue({ title: sample.title ?? "", sourceFamilyId: evidenceSourceFamilyId(current) }),
        evidence: sample.evidence, observedAt: sample.createdAt,
        entityConstructions,
        entitySurfaces: inducedProducts.models.flatMap(model => observedEntitySurfacesFromInducedLanguageModel(model, sample.evidence.map(span => String(span.id)))) });
      return [...sample.semanticCandidates.filter(candidate => candidate.channel !== "weak_free_surface"), ...projected.semanticCandidates.filter(candidate => candidate.channel === "weak_free_surface")];
    });
    // Independence is corpus-wide: sources seen in earlier runs count, or a shard at a time never promotes.
    //
    // But reading them is only worth it when they can change a verdict. A seed's independent-source count is a
    // count of FAMILIES, so it cannot exceed the number of families the corpus holds; below the gate's threshold
    // every seed is unscorable and refused whatever the priors say. Measured on the live ingest: one family
    // (wikimedia:wikipedia), 172k observations re-read and all 171,836 seeds re-decided per block, for a set of
    // refusals that was fixed before the read began -- throughput fell from 576 to 85 sources an hour as the
    // table grew. One aggregate now decides whether the read can matter.
    const priorSpan = trace.span("relation.prior-load");
    const priorRelationObservations = await this.priorRelationObservations(semanticCandidates);
    priorSpan.end({ candidates: semanticCandidates.length, priors: priorRelationObservations.length });
    const promoteSpan = trace.span("relation.promote");
    const relationPromotionModel = compileRelationPromotionModel({
      candidates: semanticCandidates,
      priorObservations: priorRelationObservations.map(row => ({
        candidateId: row.candidateId,
        relationSeedId: row.relationSeedId,
        channel: row.channel as StructuredSemanticCandidate["channel"],
        sourceId: row.sourceId,
        sourceFamilyId: row.sourceFamilyId,
        signature: row.signature
      })),
      hasher: this.hasher
    });
    promoteSpan.end({
      decisions: relationPromotionModel.decisions.length,
      promotedDecisions: relationPromotionModel.decisions.filter(decision => decision.promoted).length
    });
    const roleModelsSpan = trace.span("relation.role-models");
    const opaqueRoleModel = compileOpaqueRoleModel({
      candidates: semanticCandidates,
      promotionModel: relationPromotionModel,
      hasher: this.hasher
    });
    const roleSurfaceOrderModel = compileRoleSurfaceOrderModel({
      candidates: semanticCandidates,
      promotionModel: relationPromotionModel,
      opaqueRoleModel,
      hasher: this.hasher
    });
    roleModelsSpan.end({ assignments: opaqueRoleModel.assignments.length });
    const graphProjectionSpan = trace.span("relation.graph-project");
    const promotedGraph = semanticCandidates.length ? graphFromStructuredSemanticCandidates({
        candidates: semanticCandidates,
        observedAt: createdAt,
        ids: this.ids,
        hasher: this.hasher,
        relationPromotionModel,
        opaqueRoleModel
      }) : { nodes: [], edges: [], hyperedges: [] };
    graphProjectionSpan.end({ nodes: promotedGraph.nodes.length, edges: promotedGraph.edges.length, hyperedges: promotedGraph.hyperedges.length });
    const projectedGraph = {
      nodes: stampGraphNodes(promotedGraph.nodes, WIKIPEDIA_INFORMATION_LABEL),
      edges: stampGraphEdges(promotedGraph.edges, WIKIPEDIA_INFORMATION_LABEL),
      hyperedges: promotedGraph.hyperedges.map(hyperedge => ({ ...hyperedge, informationLabel: WIKIPEDIA_INFORMATION_LABEL }))
    };
    trainingInput.graphSnapshotAdditions = projectedGraph;
    await control.onPhase?.("compiling-language");
    const prepared = await prepareLanguageCorpusTraining(trainingInput);
    trainSpan.end({ evidence: evidence.length, pages: samples.length, textBytes: Buffer.byteLength(text, "utf8") });
    const preparedStop = control.ownerStopReason?.();
    if (preparedStop) throw new WikipediaOwnerStop(preparedStop);
    await control.onPhase?.("committing-language");
    return this.storage.transaction(async () => {
    const commitStop = control.ownerStopReason?.();
    if (commitStop) throw new WikipediaOwnerStop(commitStop);
    if (!await wikipediaInputSourcesStillMatch(inputManifest)) throw new Error("Wikipedia input changed during language preparation");
    const observeSpan = trace.span("relation.observe");
    if (this.storage.relationObservations && semanticCandidates.length) {
      await this.storage.relationObservations.put(
        relationObservationsFromCandidates(semanticCandidates).map(row => ({ ...row, observedAt: createdAt }))
      );
    }
    observeSpan.end({ candidates: semanticCandidates.length });
    const trained = await commitLanguageCorpusTraining(trainingInput, prepared);
    if (promotedGraph.hyperedges.length) {
      const graphPersistSpan = trace.span("relation.graph-persist");
      const { nodes: promotedNodes, edges: promotedEdges, hyperedges: promotedHyperedges } = projectedGraph;
      if (this.storage.graph.upsertNodes) await this.storage.graph.upsertNodes(promotedNodes);
      else for (const node of promotedNodes) await this.storage.graph.upsertNode(node);
      if (this.storage.graph.upsertEdges) await this.storage.graph.upsertEdges(promotedEdges);
      else for (const edge of promotedEdges) await this.storage.graph.upsertEdge(edge);
      if (this.storage.graph.upsertHyperedges) await this.storage.graph.upsertHyperedges(promotedHyperedges);
      else for (const hyperedge of promotedHyperedges) await this.storage.graph.upsertHyperedge(hyperedge);
      graphPersistSpan.end({ hyperedges: promotedHyperedges.length });
      await this.storage.events.append(this.events.create({
        episodeId,
        typeId: "RelationPromotionCompiled",
        payload: toJsonValue({
          shardUri,
          modelId: relationPromotionModel.id,
          opaqueRoleModelId: opaqueRoleModel.id,
          roleSurfaceOrderModelId: roleSurfaceOrderModel.id,
          candidateCount: semanticCandidates.length,
          decisions: relationPromotionModel.decisions.map(decision => ({
            relationSeedId: decision.relationSeedId,
            promoted: decision.promoted,
            gainNats: decision.descriptionLength.gainNats,
            recoveryGain: decision.recovery.gain,
            reasons: decision.reasons
          }))
        })
      }));
    } else if (semanticCandidates.length) {
      trace.mark("relation.alignment.skip.no-promoted-hyperedges", {
        candidates: semanticCandidates.length,
        promotionDecisions: relationPromotionModel.decisions.length,
        promotedRelations: relationPromotionModel.decisions.filter(decision => decision.promoted).length
      });
    }
    const importedLanguageShard: WikipediaLanguageShardImport = {
      ...(workerInduction?.receipt || trained.sourceInductionExecution ? { sourceInductionExecutions: {
        shardUri,
        ...(workerInduction?.receipt ? { prewarm: workerInduction.receipt } : {}),
        ...(trained.sourceInductionExecution ? { training: trained.sourceInductionExecution } : {})
      } } : {}),
      languageProfiles: trained.languageProfiles,
      ngramObservations: trained.ngramObservations,
      ngramModels: trained.ngramModels,
      languageUnits: trained.languageUnits,
      languagePatterns: trained.languagePatterns,
      semanticFrames: trained.semanticFrames,
      relationCandidates: semanticCandidates.length,
      promotedRelations: relationPromotionModel.decisions.filter(decision => decision.promoted).length,
      graphHyperedges: relationPromotionModel.decisions.filter(decision => decision.promoted).length
        ? semanticCandidates.filter(candidate =>
          relationPromotionModel.decisions.some(decision =>
            decision.promoted && decision.relationSeedId === candidate.relationSeedId)).length
        : 0,
      warnings: [...shardWarnings, ...trained.warnings]
    };
    for (const phase of ["prewarm", "training"] as const) {
      const receipt = importedLanguageShard.sourceInductionExecutions?.[phase];
      if (receipt) trace.mark(`language.source-induction-execution.${phase}`, { workersStarted: receipt.workersStarted,
        preparedBatches: receipt.preparedBatches, inducedBatches: receipt.inducedBatches, peakNodeRssBytes: receipt.peakNodeRssBytes });
    }
    await commitProgress(importedLanguageShard);
    return importedLanguageShard;
    });
  }
}

/**
 * Plan item 245: the resume contract, as a pure function over real
 * checkpoint records so it is directly testable without a multi-gigabyte
 * dump. A run resumes only from *verified* offsets: a checkpoint counts
 * only if the caller already filtered it to `status: "complete"` AND it
 * reached `phase: "stored"` (bytes durably written, not merely extracted)
 * AND it is a block checkpoint. Anything else -- a half-written block, a
 * failed block, a page-level checkpoint -- contributes nothing, so an
 * interrupted run re-reads from the last fully-durable block boundary
 * rather than skipping past partially-ingested bytes.
 */
export function verifiedResumeOffset(checkpoints: readonly IngestionCheckpoint[]): number {
  let offset = 0;
  for (const checkpoint of checkpoints) {
    if (checkpoint.status !== "complete") continue;
    if (!checkpoint.itemUri.includes("/block/")) continue;
    if (checkpoint.phase !== "stored") continue;
    offset = Math.max(offset, checkpoint.offsetBytes);
  }
  return offset;
}

function wikipediaLanguageBatchJournalId(rootUri: string, inputManifestId: string, ids: Pick<IdFactory, "semanticId">): string {
  return ids.semanticId("wikipedia_language_batch_journal", { rootUri, inputManifestId });
}

async function readWikipediaLanguageBatchJournal(checkpoint: IngestionCheckpoint | null, inputManifestId: string, shardCharBudget: number, compilerIdentity: string, storage: ScceStorage): Promise<StoredWikipediaLanguageBatchJournal | undefined> {
  if (!checkpoint) return undefined;
  const metadata = objectOrEmpty(checkpoint.metadata);
  if (metadata.inputManifestId !== inputManifestId) throw new Error("Wikipedia language batch journal input identity differs or is missing");
  const raw = metadata.languageBatch;
  if (raw === undefined || raw === null) return undefined;
  if (typeof raw !== "object" || Array.isArray(raw)) throw new Error("Wikipedia language batch journal is malformed");
  const value = raw as Record<string, unknown>;
  // v1 contains bounded inline samples and remains readable with its original compiler attestation.
  // Every subsequent write emits v2 identities, so an old open batch is never silently discarded.
  if ((value.version !== 1 && value.version !== 2) || (value.state !== "open" && value.state !== "idle")) throw new Error("Wikipedia language batch journal version or state is invalid");
  const blockOffset = typeof value.blockOffset === "number" ? value.blockOffset : NaN;
  const blockOrdinal = typeof value.blockOrdinal === "number" ? value.blockOrdinal : NaN;
  const lastProcessedPageOrdinal = typeof value.lastProcessedPageOrdinal === "number" ? value.lastProcessedPageOrdinal : NaN;
  const processedPageCount = typeof value.processedPageCount === "number" ? value.processedPageCount : NaN;
  const pendingChars = typeof value.pendingChars === "number" ? value.pendingChars : NaN;
  const languageTrainingDocumentCount = typeof value.languageTrainingDocumentCount === "number" ? value.languageTrainingDocumentCount : NaN;
  const languageSkippedDocumentCount = typeof value.languageSkippedDocumentCount === "number" ? value.languageSkippedDocumentCount : NaN;
  const progress = value.progressCounts;
  const progressCounts = typeof progress === "object" && progress !== null && !Array.isArray(progress)
    ? progress as Record<string, unknown> : {};
  const progressKeys: Array<keyof WikipediaLanguageProgressCounts> = [
    "pages", "sources", "evidence", "graphNodes", "graphEdges", "graphHyperedges", "languageProfiles",
    "ngramObservations", "ngramModels", "languageUnits", "languagePatterns", "semanticFrames", "truncatedPages", "truncatedCharacters",
    "relationCandidates", "promotedRelations", "lastCheckpointOffset"
  ];
  if (!Number.isSafeInteger(blockOffset) || !Number.isSafeInteger(blockOrdinal) || !Number.isSafeInteger(lastProcessedPageOrdinal) || !Number.isSafeInteger(processedPageCount)
    || !Number.isSafeInteger(pendingChars) || !Number.isSafeInteger(languageTrainingDocumentCount)
    || !Number.isSafeInteger(languageSkippedDocumentCount)
    || progressKeys.some(key => typeof progressCounts[key] !== "number" || !Number.isSafeInteger(progressCounts[key]))
    || typeof value.blockComplete !== "boolean" || typeof value.shardUri !== "string" || !Array.isArray(value.pendingSamples)) {
    throw new Error("Wikipedia language batch journal fields are invalid");
  }
  if (blockOffset < 0 || blockOrdinal < 0 || (blockOffset > 0 && blockOrdinal < 1) || lastProcessedPageOrdinal < 0 || processedPageCount < 0 || pendingChars < 0
    || pendingChars > shardCharBudget || languageTrainingDocumentCount < 0
    || languageSkippedDocumentCount < 0
    || progressKeys.some(key => Number(progressCounts[key]) < 0)
    || (value.state === "idle" && (pendingChars !== 0 || value.pendingSamples.length !== 0 || value.blockComplete !== true))
    || (processedPageCount === 0) !== (lastProcessedPageOrdinal === 0)
    || languageTrainingDocumentCount < value.pendingSamples.length
    || !value.pendingSamples.every(value.version === 1 ? isWikipediaLanguageShardSample : isWikipediaLanguageShardSampleReference)) {
    throw new Error("Wikipedia language batch journal cursor, budget, or sample payload is invalid");
  }
  const declaredChars = value.version === 1
    ? languageShardCharsForSamples(value.pendingSamples as WikipediaLanguageShardSample[])
    : (value.pendingSamples as WikipediaLanguageShardSampleReference[])
      .reduce((total, sample, index) => total + (sample.title?.length ?? 0) + 1 + sample.textChars + (index > 0 ? 2 : 0), 0);
  if (declaredChars !== pendingChars) throw new Error("Wikipedia language batch journal character count is invalid");
  // Pending language payload remains owned by the executable that assembled it. A drained
  // midblock cursor can cross an executable change only after the caller replays and proves
  // its already-committed prefix byte-for-byte; this reader deliberately cannot waive that proof.
  const payloadFreeBoundary = value.pendingSamples.length === 0 && pendingChars === 0 && value.blockComplete === true;
  const payloadFreeMidblock = value.pendingSamples.length === 0 && pendingChars === 0 && value.blockComplete === false;
  if (value.state === "open" && !payloadFreeBoundary && !payloadFreeMidblock && metadata.compilerIdentity !== compilerIdentity) {
    throw new Error("Wikipedia open language batch compiler attestation differs or is missing; finish pending work with its original compiler before upgrading, or use an empty candidate schema for a fresh run");
  }
  let pendingSamples: WikipediaLanguageShardSample[];
  if (value.version === 1) {
    pendingSamples = value.pendingSamples as WikipediaLanguageShardSample[];
  } else {
    const references = value.pendingSamples as WikipediaLanguageShardSampleReference[];
    pendingSamples = [];
    // One article at a time keeps cold restoration bounded by the existing pending-shard budget,
    // plus one decoder block; no corpus-wide materialization or cognitive refitting occurs here.
    for (const reference of references) pendingSamples.push(await hydrateWikipediaLanguageSample(reference, storage));
  }
  if (languageShardCharsForSamples(pendingSamples) !== pendingChars) throw new Error("Wikipedia language batch journal character count is invalid");
  const compilerTransitions = readWikipediaCompilerTransitions(metadata.compilerTransitions);
  if (compilerTransitions.some(receipt => receipt.inputManifestId !== inputManifestId)
    || (compilerTransitions.length > 0 && compilerTransitions.at(-1)!.toCompilerIdentity !== metadata.compilerIdentity)) {
    throw new Error("Wikipedia compiler transition history does not bind the active journal");
  }
  return {
    journal: {
      ...(value as unknown as WikipediaLanguageBatchJournal),
      pendingSamples,
      languageSkippedDocumentCount,
      progressCounts: progressCounts as unknown as WikipediaLanguageProgressCounts
    },
    journalHash: wikipediaJournalHash(value),
    ...(typeof metadata.compilerIdentity === "string" ? { compilerIdentity: metadata.compilerIdentity } : {}),
    compilerTransitions
  };
}

function readWikipediaCompilerTransitions(value: unknown): readonly WikipediaCompilerTransitionReceipt[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || !value.every(isWikipediaCompilerTransitionReceipt)) {
    throw new Error("Wikipedia compiler transition history is malformed");
  }
  for (let index = 1; index < value.length; index++) {
    if (value[index - 1]!.toCompilerIdentity !== value[index]!.fromCompilerIdentity) {
      throw new Error("Wikipedia compiler transition history is discontinuous");
    }
  }
  return value;
}

function isWikipediaCompilerTransitionReceipt(value: unknown): value is WikipediaCompilerTransitionReceipt {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const row = value as Record<string, unknown>;
  return row.version === 1
    && (row.boundaryKind === "complete-boundary" || row.boundaryKind === "verified-midblock")
    && typeof row.inputManifestId === "string" && /^sha256:[0-9a-f]{64}$/u.test(row.inputManifestId)
    && typeof row.fromCompilerIdentity === "string" && row.fromCompilerIdentity.length > 0
    && typeof row.toCompilerIdentity === "string" && row.toCompilerIdentity.length > 0
    && typeof row.fromJournalHash === "string" && /^sha256_[0-9a-f]{64}$/u.test(row.fromJournalHash)
    && Number.isSafeInteger(row.blockOffset) && Number(row.blockOffset) >= 0
    && Number.isSafeInteger(row.blockEnd) && Number(row.blockEnd) > Number(row.blockOffset)
    && Number.isSafeInteger(row.blockOrdinal) && Number(row.blockOrdinal) >= 0
    && Number.isSafeInteger(row.lastProcessedPageOrdinal) && Number(row.lastProcessedPageOrdinal) >= 0
    && Number.isSafeInteger(row.processedPageCount) && Number(row.processedPageCount) >= 0
    && Number.isSafeInteger(row.skippedPageCount) && Number(row.skippedPageCount) >= 0
    && typeof row.verifiedPrefixHash === "string" && /^sha256_[0-9a-f]{64}$/u.test(row.verifiedPrefixHash);
}

async function verifyWikipediaMidblockCompilerTransition(input: {
  stored: StoredWikipediaLanguageBatchJournal;
  currentCompilerIdentity: string;
  inputManifestId: string;
  rootUri: string;
  corpus: ResolvedWikipediaCorpus;
  storage: ScceStorage;
}): Promise<WikipediaCompilerTransitionReceipt | undefined> {
  const journal = input.stored.journal;
  if (input.stored.compilerIdentity === input.currentCompilerIdentity) return undefined;
  if (!input.stored.compilerIdentity || journal.pendingSamples.length > 0 || journal.pendingChars > 0) {
    throw new Error("Wikipedia open language batch compiler attestation differs or is missing; finish pending work with its original compiler before upgrading, or use an empty candidate schema for a fresh run");
  }
  const durableRows = await input.storage.ingestion.list({
    rootUri: input.rootUri,
    limit: Math.max(512, journal.lastProcessedPageOrdinal + journal.processedPageCount + 64)
  });
  const storedBlockCheckpoint = durableRows.find(row => row.itemUri === `${input.rootUri}/block/${journal.blockOffset}`
    && (journal.blockComplete || row.phase === "extracting" && row.status === "running"));
  const storedBlockMetadata = objectOrEmpty(storedBlockCheckpoint?.metadata ?? null);
  const storedBlockEnd = Number(storedBlockMetadata.compressedEnd);
  if (!storedBlockCheckpoint
    || storedBlockMetadata.inputManifestId !== input.inputManifestId
    || Number(storedBlockMetadata.blockOffset) !== journal.blockOffset
    || Number(storedBlockMetadata.blockOrdinal) !== journal.blockOrdinal
    || !Number.isSafeInteger(storedBlockEnd) || storedBlockEnd <= journal.blockOffset) {
    throw new Error("Wikipedia midblock compiler transition cannot prove its durable block boundary");
  }
  if (journal.blockComplete) {
    return {
      version: 1,
      boundaryKind: "complete-boundary",
      inputManifestId: input.inputManifestId,
      fromCompilerIdentity: input.stored.compilerIdentity,
      toCompilerIdentity: input.currentCompilerIdentity,
      fromJournalHash: input.stored.journalHash,
      blockOffset: journal.blockOffset,
      blockEnd: storedBlockEnd,
      blockOrdinal: journal.blockOrdinal,
      lastProcessedPageOrdinal: journal.lastProcessedPageOrdinal,
      processedPageCount: journal.processedPageCount,
      skippedPageCount: Math.max(0, journal.lastProcessedPageOrdinal - journal.processedPageCount),
      verifiedPrefixHash: blobContentHash(Buffer.from(canonicalStringify({
        schema: "scce.wikipedia_compiler_transition_complete_boundary.v1",
        inputManifestId: input.inputManifestId,
        fromJournalHash: input.stored.journalHash,
        blockOffset: journal.blockOffset,
        blockEnd: storedBlockEnd,
        blockOrdinal: journal.blockOrdinal
      }), "utf8"))
    };
  }
  const skippedPageCount = journal.lastProcessedPageOrdinal - journal.processedPageCount;
  const rootReceipt = durableRows.find(row => row.itemUri === input.corpus.dumpPath
    && row.phase === "stored" && row.status === "complete" && row.offsetBytes === journal.blockOffset);
  const rootMetadata = objectOrEmpty(rootReceipt?.metadata ?? null);
  if (!rootReceipt || skippedPageCount < 0
    || rootMetadata.inputManifestId !== input.inputManifestId
    || Number(rootMetadata.emitted) !== journal.processedPageCount
    || Number(rootMetadata.skipped) !== skippedPageCount
    || Number(rootMetadata.pageOrdinal) !== journal.lastProcessedPageOrdinal
    || rootMetadata.reachedEnd !== false || typeof rootMetadata.stoppedAt !== "string") {
    throw new Error("Wikipedia midblock compiler transition cannot prove its exact root stream receipt");
  }
  const prefixRows = durableRows.filter(row => {
    const metadata = objectOrEmpty(row.metadata);
    const ordinal = Number(metadata.blockPageOrdinal);
    return row.status === "complete"
      && metadata.inputManifestId === input.inputManifestId
      && Number(metadata.blockOffset) === journal.blockOffset
      && Number.isSafeInteger(ordinal) && ordinal >= 1 && ordinal <= journal.lastProcessedPageOrdinal;
  }).sort((left, right) => Number(objectOrEmpty(left.metadata).blockPageOrdinal) - Number(objectOrEmpty(right.metadata).blockPageOrdinal));

  if (prefixRows.length !== journal.processedPageCount) {
    throw new Error("Wikipedia midblock compiler transition cannot prove its durable cursor prefix; resume with the original compiler");
  }
  const durableByOrdinal = new Map<number, IngestionCheckpoint>();
  for (const row of prefixRows) {
    const ordinal = Number(objectOrEmpty(row.metadata).blockPageOrdinal);
    if (durableByOrdinal.has(ordinal)) throw new Error("Wikipedia midblock compiler transition has duplicate durable page ordinals");
    durableByOrdinal.set(ordinal, row);
  }

  const replayed: Array<{ ordinal: number; uri: string; pageId: string; revisionId: string; contentHash: ContentHash; byteLength: number }> = [];
  let reachedBlockBoundary = false;
  let replayedBlockEnd: number | undefined;
  const replayCorpus: ResolvedWikipediaCorpus = {
    ...input.corpus,
    maxPagesPerRun: Number.MAX_SAFE_INTEGER,
    maxBlocksPerRun: 1
  };
  for await (const item of streamWikipediaMultistream(replayCorpus, {
    resumeOffset: journal.blockOffset,
    resumeBlockOrdinal: journal.blockOrdinal || undefined,
    resumeAfterBlock: false,
    discoverIndex: false
  })) {
    if (item.type === "checkpoint") {
      if (isBlockCheckpoint(item.checkpoint) && item.checkpoint.offsetBytes === journal.blockOffset) {
        const blockMetadata = objectOrEmpty(item.checkpoint.metadata);
        const blockEnd = Number(blockMetadata.compressedEnd);
        if (Number(blockMetadata.blockOrdinal) !== journal.blockOrdinal || blockEnd !== storedBlockEnd) {
          throw new Error("Wikipedia midblock compiler transition replay changed its indexed block boundary");
        }
        replayedBlockEnd = blockEnd;
        if (item.checkpoint.phase === "stored" && item.checkpoint.status === "complete") reachedBlockBoundary = true;
      }
      continue;
    }
    if (item.type !== "file") continue;
    const metadata = objectOrEmpty(item.checkpoint.metadata);
    const ordinal = Number(metadata.blockPageOrdinal);
    if (Number(metadata.blockOffset) !== journal.blockOffset || !Number.isSafeInteger(ordinal)
      || ordinal < 1 || ordinal > journal.lastProcessedPageOrdinal) continue;
    const durable = durableByOrdinal.get(ordinal);
    if (!durable) throw new Error("Wikipedia midblock compiler transition replay emitted a page absent from the durable cursor prefix");
    if (typeof durable.contentHash !== "string" || !/^sha256_[0-9a-f]{64}$/u.test(durable.contentHash)
      || !Number.isSafeInteger(durable.byteLength) || Number(durable.byteLength) < 0) {
      throw new Error("Wikipedia midblock compiler transition durable page digest is invalid");
    }
    const durableContentHash = durable.contentHash as ContentHash;
    const durableByteLength = durable.byteLength as number;
    const durableMetadata = objectOrEmpty(durable.metadata);
    const representations = [
      { contentHash: item.checkpoint.contentHash, byteLength: item.checkpoint.byteLength },
      ...(item.file.evidenceDerivative ? [{
        contentHash: blobContentHash(item.file.evidenceDerivative.bytes),
        byteLength: item.file.evidenceDerivative.bytes.byteLength
      }] : [])
    ];
    const bytesMatch = representations.some(candidate => candidate.contentHash === durable.contentHash
      && candidate.byteLength === durable.byteLength);
    if (!bytesMatch || durable.itemUri !== item.checkpoint.itemUri
      || durableMetadata.pageId !== metadata.pageId || durableMetadata.revisionId !== metadata.revisionId
      || durableMetadata.title !== metadata.title) {
      throw new Error("Wikipedia midblock compiler transition replay differs from its durable cursor prefix");
    }
    replayed.push({
      ordinal,
      uri: durable.itemUri,
      pageId: String(metadata.pageId),
      revisionId: String(metadata.revisionId),
      contentHash: durableContentHash,
      byteLength: durableByteLength
    });
  }
  if (!reachedBlockBoundary || replayedBlockEnd !== storedBlockEnd
    || journal.lastProcessedPageOrdinal - replayed.length !== skippedPageCount
    || replayed.length !== journal.processedPageCount
    || replayed.some((row, index) => row.ordinal !== Number(objectOrEmpty(prefixRows[index]!.metadata).blockPageOrdinal))) {
    throw new Error("Wikipedia midblock compiler transition replay did not reproduce its complete durable cursor prefix");
  }
  return {
    version: 1,
    boundaryKind: "verified-midblock",
    inputManifestId: input.inputManifestId,
    fromCompilerIdentity: input.stored.compilerIdentity,
    toCompilerIdentity: input.currentCompilerIdentity,
    fromJournalHash: input.stored.journalHash,
    blockOffset: journal.blockOffset,
    blockEnd: storedBlockEnd,
    blockOrdinal: journal.blockOrdinal,
    lastProcessedPageOrdinal: journal.lastProcessedPageOrdinal,
    processedPageCount: journal.processedPageCount,
    skippedPageCount,
    verifiedPrefixHash: blobContentHash(Buffer.from(canonicalStringify({
      schema: "scce.wikipedia_compiler_transition_prefix.v1",
      inputManifestId: input.inputManifestId,
      blockOffset: journal.blockOffset,
      blockEnd: storedBlockEnd,
      blockOrdinal: journal.blockOrdinal,
      lastProcessedPageOrdinal: journal.lastProcessedPageOrdinal,
      processedPageCount: journal.processedPageCount,
      skippedPageCount,
      pages: replayed
    }), "utf8"))
  };
}

function wikipediaJournalHash(value: unknown): ContentHash {
  return blobContentHash(Buffer.from(canonicalStringify(value), "utf8"));
}

function wikipediaJournalEvidence(span: EvidenceSpan): EvidenceSpan {
  // Public reads resolve this convenience field; ingestion snapshots predate that read boundary.
  const { sourceIdentity: _sourceIdentity, ...snapshot } = span;
  return snapshot;
}

async function wikipediaJournalSources(sourceVersionId: SourceVersionId, storage: ScceStorage): Promise<{ source: SourceVersion; original: SourceVersion; reference: WikipediaLanguageSourceReference }> {
  const load = storage.evidence.sourceVersionById;
  if (!load) throw new Error("Wikipedia journal restoration requires access-controlled source-version reads");
  const source = await load.call(storage.evidence, sourceVersionId);
  if (!source || source.sourceVersionId !== sourceVersionId) throw new Error("Wikipedia journal source version is unavailable");
  const originalSourceVersionId = source.derivation?.derivedFromSourceVersionId ?? source.sourceVersionId;
  const original = originalSourceVersionId === source.sourceVersionId ? source : await load.call(storage.evidence, originalSourceVersionId);
  if (!original || original.sourceVersionId !== originalSourceVersionId || original.sourceId !== source.sourceId
    || original.canonicalUri !== source.canonicalUri || original.derivation) throw new Error("Wikipedia journal original source identity is invalid");
  return { source, original, reference: { contentHash: source.contentHash, byteLength: source.byteLength,
    originalSourceVersionId, originalContentHash: original.contentHash, originalByteLength: original.byteLength } };
}

async function referenceWikipediaLanguageSample(sample: WikipediaLanguageShardSample, storage: ScceStorage): Promise<WikipediaLanguageShardSampleReference> {
  const sourceReference = sample.sourceReference ?? (await wikipediaJournalSources(sample.sourceVersionId, storage)).reference;
  return {
    uri: sample.uri, ...(sample.title !== undefined ? { title: sample.title } : {}), sourceVersionId: sample.sourceVersionId,
    sourceReference, textContentHash: blobContentHash(Buffer.from(sample.text, "utf8")), textChars: sample.text.length,
    projectionHash: wikipediaJournalHash(sample.languageProjection ?? []),
    evidence: sample.evidence.map(span => ({ id: span.id, contentHash: span.contentHash, byteStart: span.byteStart, byteEnd: span.byteEnd,
      charStart: span.charStart, charEnd: span.charEnd, snapshotHash: wikipediaJournalHash(wikipediaJournalEvidence(span)) })),
    createdAt: sample.createdAt, languageAliases: sample.languageAliases, semanticCandidates: sample.semanticCandidates
  };
}

async function hydrateWikipediaLanguageSample(reference: WikipediaLanguageShardSampleReference, storage: ScceStorage): Promise<WikipediaLanguageShardSample> {
  const { source, original, reference: currentSourceReference } = await wikipediaJournalSources(reference.sourceVersionId, storage);
  if (source.canonicalUri !== reference.uri || canonicalStringify(currentSourceReference) !== canonicalStringify(reference.sourceReference)) {
    throw new Error("Wikipedia journal source reference changed");
  }
  const sourceBytes = Buffer.from(await storage.blobs.get(source.contentHash));
  if (sourceBytes.byteLength !== source.byteLength || blobContentHash(sourceBytes) !== source.contentHash) throw new Error("Wikipedia journal evidence-source bytes changed");
  const originalBytes = original.sourceVersionId === source.sourceVersionId ? sourceBytes : Buffer.from(await storage.blobs.get(original.contentHash));
  if (originalBytes.byteLength !== original.byteLength || blobContentHash(originalBytes) !== original.contentHash) throw new Error("Wikipedia journal original-source bytes changed");
  const decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
  const projection = wikipediaLanguageSurface(decoder.decode(originalBytes), undefined, decoder.decode(sourceBytes));
  if (projection.text.length !== reference.textChars || blobContentHash(Buffer.from(projection.text, "utf8")) !== reference.textContentHash
    || wikipediaJournalHash(projection.mappings) !== reference.projectionHash) throw new Error("Wikipedia journal language text or projection changed");
  const loaded = await storage.evidence.getEvidenceBatch(reference.evidence.map(span => span.id));
  const byId = new Map(loaded.map(span => [span.id, span]));
  if (loaded.length !== reference.evidence.length || byId.size !== reference.evidence.length) throw new Error("Wikipedia journal evidence is unavailable or duplicated");
  const evidence = reference.evidence.map(expected => {
    const stored = byId.get(expected.id);
    if (!stored || stored.sourceVersionId !== source.sourceVersionId || stored.sourceId !== source.sourceId
      || stored.contentHash !== expected.contentHash || stored.byteStart !== expected.byteStart || stored.byteEnd !== expected.byteEnd
      || stored.charStart !== expected.charStart || stored.charEnd !== expected.charEnd
      || stored.byteEnd > sourceBytes.byteLength || !sourceBytes.subarray(stored.byteStart, stored.byteEnd).equals(Buffer.from(stored.text, "utf8"))) {
      throw new Error("Wikipedia journal evidence identity or byte range changed");
    }
    const snapshot = wikipediaJournalEvidence(stored);
    if (wikipediaJournalHash(snapshot) !== expected.snapshotHash) throw new Error("Wikipedia journal evidence snapshot changed");
    return snapshot;
  });
  return { uri: reference.uri, ...(reference.title !== undefined ? { title: reference.title } : {}), sourceVersionId: reference.sourceVersionId,
    text: projection.text, languageProjection: projection.mappings, evidence, createdAt: reference.createdAt,
    languageAliases: reference.languageAliases, semanticCandidates: reference.semanticCandidates, sourceReference: reference.sourceReference };
}

function isWikipediaLanguageShardSampleReference(value: unknown): value is WikipediaLanguageShardSampleReference {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const sample = value as Record<string, unknown>;
  const source = sample.sourceReference;
  if (!isWikipediaLanguageSampleMetadata(sample) || typeof source !== "object" || source === null || Array.isArray(source)) return false;
  const sourceReference = source as Record<string, unknown>;
  const isHash = (hash: unknown): boolean => typeof hash === "string" && /^sha256_[0-9a-f]{64}$/u.test(hash);
  const isLength = (length: unknown): boolean => typeof length === "number" && Number.isSafeInteger(length) && length >= 0;
  return isHash(sample.textContentHash) && isHash(sample.projectionHash) && isLength(sample.textChars)
    && isHash(sourceReference.contentHash) && isHash(sourceReference.originalContentHash)
    && isLength(sourceReference.byteLength) && isLength(sourceReference.originalByteLength)
    && Number(sourceReference.byteLength) <= 192 * 1024 * 1024 && Number(sourceReference.originalByteLength) <= 192 * 1024 * 1024
    && typeof sourceReference.originalSourceVersionId === "string" && sourceReference.originalSourceVersionId.length > 0
    && Array.isArray(sample.evidence) && sample.evidence.every(value => {
      if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
      const span = value as Record<string, unknown>;
      return typeof span.id === "string" && span.id.length > 0 && isHash(span.contentHash) && isHash(span.snapshotHash)
        && ["byteStart", "byteEnd", "charStart", "charEnd"].every(key => isLength(span[key]))
        && Number(span.byteEnd) > Number(span.byteStart) && Number(span.charEnd) > Number(span.charStart)
        && Number(span.byteEnd) <= Number(sourceReference.byteLength);
    });
}

function isWikipediaLanguageSampleMetadata(sample: Record<string, unknown>): boolean {
  return typeof sample.uri === "string" && sample.uri.length > 0
    && (sample.title === undefined || typeof sample.title === "string")
    && typeof sample.sourceVersionId === "string" && sample.sourceVersionId.length > 0
    && typeof sample.createdAt === "number" && Number.isFinite(sample.createdAt)
    && Array.isArray(sample.languageAliases) && sample.languageAliases.every(item => typeof item === "string")
    && Array.isArray(sample.semanticCandidates) && sample.semanticCandidates.every(item => typeof item === "object" && item !== null && !Array.isArray(item));
}

function isWikipediaLanguageShardSample(value: unknown): value is WikipediaLanguageShardSample {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const sample = value as Record<string, unknown>;
  return isWikipediaLanguageSampleMetadata(sample)
    && typeof sample.text === "string"
    && (sample.languageProjection === undefined || Array.isArray(sample.languageProjection) && sample.languageProjection.every(item => {
      if (typeof item !== "object" || item === null || Array.isArray(item)) return false;
      const mapping = item as Record<string, unknown>;
      return mapping.role === "gallery-filename" && typeof mapping.replacement === "string"
        && ["sourceCharStart", "sourceCharEnd", "evidenceUtf16Start", "evidenceUtf16End", "evidenceCodePointStart", "evidenceCodePointEnd"]
          .every(key => Number.isSafeInteger(mapping[key]) && Number(mapping[key]) >= 0);
    }))
    && Array.isArray(sample.evidence) && sample.evidence.every(item => typeof item === "object" && item !== null && !Array.isArray(item));
}

function languageShardCharsForSamples(samples: readonly WikipediaLanguageShardSample[]): number {
  return samples.reduce((total, sample, index) => total + (sample.title?.length ?? 0) + 1 + sample.text.length + (index > 0 ? 2 : 0), 0);
}

function zeroPage(input: { warnings: string[]; truncatedPages?: number; truncatedCharacters?: number }): WikipediaPageImport {
  return {
    sources: 0,
    truncatedPages: input.truncatedPages ?? 0,
    truncatedCharacters: input.truncatedCharacters ?? 0,
    evidence: 0,
    graphNodes: 0,
    graphEdges: 0,
    graphHyperedges: 0,
    languageProfiles: 0,
    ngramObservations: 0,
    ngramModels: 0,
    languageUnits: 0,
    languagePatterns: 0,
    semanticFrames: 0,
    relationCandidates: 0,
    promotedRelations: 0,
    warnings: input.warnings
  };
}

function zeroLanguageShard(input: { warnings: string[] }): WikipediaLanguageShardImport {
  return {
    languageProfiles: 0,
    ngramObservations: 0,
    ngramModels: 0,
    languageUnits: 0,
    languagePatterns: 0,
    semanticFrames: 0,
    relationCandidates: 0,
    promotedRelations: 0,
    graphHyperedges: 0,
    warnings: input.warnings
  };
}

/**
 * Builds one shard's text from whole samples. It is a bounded prefix, not a splitter: material past the budget
 * cannot be carried into the next shard, so it reports what it could not hold rather than discarding it
 * quietly. The caller's job is to never offer more than the budget -- which is guaranteed as long as
 * ngramShardChars >= maxArticleChars, since no page can then exceed a whole shard. `dropped` is therefore
 * evidence of a misconfiguration, and the ingest warns on it instead of losing corpus in silence.
 */
export function boundedLanguageShard(
  samples: readonly WikipediaLanguageShardSample[],
  maxChars: number,
  maxEvidence: number
): { text: string; evidence: EvidenceSpan[]; sourceFamilyRanges: SourceLanguageFamilyRange[]; droppedChars: number; droppedSamples: number } {
  const parts: string[] = [];
  const evidence: EvidenceSpan[] = [];
  const sourceFamilyRanges: SourceLanguageFamilyRange[] = [];
  const seenEvidence = new Set<string>();
  let droppedChars = 0;
  let droppedSamples = 0;
  let remaining = Math.max(0, maxChars);
  let outputLength = 0;
  for (const sample of samples) {
    if (remaining <= 0) {
      droppedSamples += 1;
      droppedChars += (sample.title ? sample.title.length + 1 : 0) + sample.text.length;
      continue;
    }
    const titlePrefix = sample.title ? `${sample.title}\n` : "";
    const text = `${titlePrefix}${sample.text}`;
    if (!text) continue;
    if (parts.length && remaining < 2) {
      droppedSamples += 1;
      droppedChars += text.length;
      continue;
    }
    if (parts.length) {
      parts.push("\n\n");
      remaining -= 2;
      outputLength += 2;
    }
    let consumed = Math.min(text.length, remaining);
    // A shard budget counts UTF-16 units, while evidence charEnd counts codepoints.
    if (consumed < text.length && /[\uD800-\uDBFF]/u.test(text.charAt(consumed - 1))) consumed--;
    const consumedPageChars = Math.max(0, consumed - titlePrefix.length);
    if (consumedPageChars > 0) sourceFamilyRanges.push({ start: outputLength + titlePrefix.length, end: outputLength + titlePrefix.length + consumedPageChars,
      sourceVersionId: sample.sourceVersionId, sourceFamilyId: sample.evidence[0] ? evidenceSourceFamilyId(sample.evidence[0]) : "wikimedia:wikipedia" });
    const consumedPageCodepoints = [...sample.text.slice(0, consumedPageChars)].length;
    for (const span of sample.evidence) {
      if (evidence.length >= maxEvidence) break;
      if (span.charEnd > consumedPageCodepoints) continue;
      const key = String(span.id);
      if (seenEvidence.has(key)) continue;
      seenEvidence.add(key);
      evidence.push(span);
    }
    if (text.length <= remaining) {
      parts.push(text);
      remaining -= text.length;
      outputLength += text.length;
      continue;
    }
    parts.push(text.slice(0, consumed));
    outputLength += consumed;
    droppedChars += text.length - consumed;
    droppedSamples += 1;
    remaining = 0;
  }
  return { text: parts.join(""), evidence, sourceFamilyRanges, droppedChars, droppedSamples };
}

export function stampEvidence(spans: EvidenceSpan[], metadata: JsonValue, informationLabel: InformationLabel): EvidenceSpan[] {
  const sourceFeatures = sourceAnchorFeaturesFromMetadata(metadata);
  // Measured: the page's link list and structure rode on every span twice, 14 kB of provenance beside 2 kB of text.
  const pageIdentity = spanProvenanceMetadata(metadata) as Record<string, JsonValue>;
  return spans.map(span => {
    const provenance = objectOrEmpty(span.provenance);
    return {
    ...span,
    informationLabel,
    features: [...new Set([...sourceFeatures, ...span.features])].slice(0, 720),
    status: "promoted",
    provenance: {
      ...provenance,
      ...pageIdentity,
      metadata: spanProvenanceMetadata(provenance.metadata ?? metadata) as JsonValue,
      sourceSystem: "wikipedia",
      forceClass: "direct_evidence" satisfies BrainShardProvenanceClass
    },
    trustVector: {
      ...objectOrEmpty(span.trustVector),
      sourceSystem: "wikipedia",
      forceClass: "direct_evidence"
    }
  };
  });
}

export function wikipediaLanguageTextProjection(samples: ReadonlyArray<{
  sourceVersionId: SourceVersionId;
  languageProjection?: readonly WikipediaLanguageSurfaceMapping[];
}>): SourceOwnedTextProjection | undefined {
  const ranges = samples.flatMap(sample => (sample.languageProjection ?? []).map(mapping => ({
    sourceVersionId: sample.sourceVersionId,
    startCodePoint: mapping.evidenceCodePointStart,
    endCodePoint: mapping.evidenceCodePointEnd,
    startUtf16: mapping.evidenceUtf16Start,
    endUtf16: mapping.evidenceUtf16End,
    replacement: mapping.replacement
  })));
  return ranges.length ? { transformId: WIKIPEDIA_LANGUAGE_SURFACE_TRANSFORM, ranges } : undefined;
}

/** Canonical spans stay persisted and graph-visible; only their induction documents receive the declared role projection. */
export function wikipediaLanguageInductionDocuments(
  evidence: readonly EvidenceSpan[],
  projection?: SourceOwnedTextProjection
) {
  const parents = new Map(evidence.map(span => [String(span.id), span]));
  return sourceLanguageInductionDocuments(evidence).map(document => {
    const parent = parents.get(document.id)!;
    return { ...document, text: projectSourceOwnedText({ text: parent.text, sourceVersionId: parent.sourceVersionId,
      sourceCodePointStart: parent.charStart, projection }) };
  });
}

function sourceAnchorFeaturesFromMetadata(metadata: JsonValue): string[] {
  const record = objectOrEmpty(metadata);
  const surfaces = [
    stringValue(record.title),
    stringValue(record.uri),
    stringValue(record.canonicalUri),
    stringValue(record.sourceUri)
  ].filter((value): value is string => Boolean(value));
  const features: string[] = [];
  for (const surface of surfaces) {
    const units = sourceAnchorUnits(surface);
    for (const unit of units) features.push(`sym:${unit}`);
    for (let index = 0; index < units.length - 1; index++) features.push(`bi:${units[index]}|${units[index + 1]}`);
    for (let index = 0; index < units.length - 2; index++) features.push(`tri:${units[index]}|${units[index + 1]}|${units[index + 2]}`);
  }
  return [...new Set(features)].slice(0, 96);
}

function sourceAnchorUnits(surface: string): string[] {
  return (surface.normalize("NFC").toLocaleLowerCase().match(/[\p{Letter}\p{Number}_]+/gu) ?? [])
    .filter(unit => unit.length >= 2)
    .slice(0, 24);
}

function stampGraphNodes(nodes: GraphNode[], informationLabel: InformationLabel): GraphNode[] {
  return nodes.map(node => ({
    ...node,
    informationLabel,
    features: [...new Set(["wikipedia", "wiki-stream", ...node.features])],
    metadata: { ...objectOrEmpty(node.metadata), sourceSystem: "wikipedia", forceClass: "learned_concept_prior" }
  }));
}

function stampGraphEdges(edges: GraphEdge[], informationLabel: InformationLabel): GraphEdge[] {
  return edges.map(edge => ({
    ...edge,
    informationLabel,
    metadata: { ...objectOrEmpty(edge.metadata), sourceSystem: "wikipedia", forceClass: "learned_concept_prior" }
  }));
}

function wikiMetadata(value: JsonValue): JsonValue {
  return { ...objectOrEmpty(value), sourceSystem: "wikipedia", sourceKind: "wikimedia_dump", ingestionLane: "wiki_stream" };
}

function isBlockCheckpoint(checkpoint: IngestionCheckpoint): boolean {
  return checkpoint.itemUri.includes("/block/");
}

function stopDecision(input: WikipediaV3IngestOptions, result: WikipediaV3IngestResult): { kind: "heap" | "owner"; reason: string } | undefined {
  if (input.signal?.aborted) return { kind: "owner", reason: "owner-abort" };
  if (input.stopFile && existsSync(input.stopFile)) return { kind: "owner", reason: `owner stop file present at ${input.stopFile}` };
  const heapLimit = input.heapCheckpointMb;
  const current = heapMiB();
  const rss = rssMiB();
  result.heapMiB = current;
  result.rssMiB = rss;
  if (heapLimit && heapLimit > 0 && current >= heapLimit) {
    return { kind: "heap", reason: `heap safety checkpoint (${current} MiB >= ${heapLimit} MiB)` };
  }
  // Resident set, not heap. A clean scce5 run died inside train.compile at 598 MiB of heap and 4,390 MiB of
  // RSS: lattice building grows resident memory far faster than the V8 heap, so a heap-only checkpoint cannot
  // see it coming and the supervisor loses the child instead of restarting it. memorySafetyBoundMb was already
  // declared, validated, plumbed through and written into every checkpoint -- and compared against nothing.
  const rssLimit = residentSafetyBoundMiB(input.memorySafetyBoundMb);
  if (rssLimit > 0 && rss >= rssLimit) {
    return { kind: "heap", reason: `resident safety checkpoint (${rss} MiB >= ${rssLimit} MiB)` };
  }
  return undefined;
}

/**
 * The declared bound, capped by the machine it is running on.
 *
 * A configured bound larger than physical memory silently disables the check, which is how an 8,192 MiB bound
 * came to be set on a 15,921 MiB machine that also hosts the database this ingest writes to. The cap is the
 * memory actually present minus what is already resident elsewhere, read at the moment of the decision rather
 * than assumed, so the bound tracks the machine instead of a number someone once typed.
 */
export function residentSafetyBoundMiBForTest(declaredMb: number | undefined): number {
  return residentSafetyBoundMiB(declaredMb);
}

/** Measured on scce6_trained32: these two keys were 6,036 of 6,036 MB persisted per 32 articles and nothing reads them back. */
export function alignmentEventPayloadFor(payload: Record<string, unknown>, retainProvenance: boolean): Record<string, unknown> {
  if (retainProvenance) return { ...payload, alignmentProvenanceRetained: true };
  const { alignmentAlternativeSets, transportEvidenceAllocations, ...rest } = payload;
  return {
    ...rest,
    alignmentAlternativeSetCount: Array.isArray(alignmentAlternativeSets) ? alignmentAlternativeSets.length : 0,
    transportEvidenceAllocationCount: Array.isArray(transportEvidenceAllocations) ? transportEvidenceAllocations.length : 0,
    alignmentProvenanceRetained: false
  };
}

function residentSafetyBoundMiB(declaredMb: number | undefined): number {
  if (!declaredMb || declaredMb <= 0) return 0;
  const totalMiB = Math.round(totalmem() / 1024 / 1024);
  const freeMiB = Math.round(freemem() / 1024 / 1024);
  const rss = rssMiB();
  // What this process could grow into before the machine has nothing left: its own resident set plus whatever
  // is still free. Below that, the declared bound stands.
  const reachableMiB = rss + freeMiB;
  return Math.max(512, Math.min(declaredMb, reachableMiB, totalMiB));
}

export function wikipediaImportCanActivate(result: Pick<WikipediaV3IngestResult, "sources" | "stoppedByHeapSafetyBound" | "stoppedByOwner">): boolean {
  return result.sources > 0 && !result.stoppedByHeapSafetyBound && !result.stoppedByOwner;
}

function heapMiB(): number {
  return Math.round(process.memoryUsage().heapUsed / 1024 / 1024);
}

function rssMiB(): number {
  return Math.round(process.memoryUsage().rss / 1024 / 1024);
}

function nowMs(): number {
  return Date.now();
}

function objectOrEmpty(value: JsonValue): Record<string, JsonValue> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, JsonValue> : {};
}

function zeroWikipediaLanguageProgressCounts(): WikipediaLanguageProgressCounts {
  return {
    pages: 0, sources: 0, truncatedPages: 0, truncatedCharacters: 0, evidence: 0, graphNodes: 0, graphEdges: 0, graphHyperedges: 0,
    languageProfiles: 0, ngramObservations: 0, ngramModels: 0, languageUnits: 0,
    languagePatterns: 0, semanticFrames: 0, relationCandidates: 0, promotedRelations: 0,
    lastCheckpointOffset: 0
  };
}

function wikipediaProgressCountsFromResult(result: WikipediaV3IngestResult): WikipediaLanguageProgressCounts {
  return {
    pages: result.pages, sources: result.sources, truncatedPages: result.truncatedPages, truncatedCharacters: result.truncatedCharacters, evidence: result.evidence, graphNodes: result.graphNodes,
    graphEdges: result.graphEdges, graphHyperedges: result.graphHyperedges, languageProfiles: result.languageProfiles,
    ngramObservations: result.ngramObservations, ngramModels: result.ngramModels, languageUnits: result.languageUnits,
    languagePatterns: result.languagePatterns, semanticFrames: result.semanticFrames,
    relationCandidates: result.relationCandidates, promotedRelations: result.promotedRelations,
    lastCheckpointOffset: result.lastCheckpointOffset
  };
}

function addWikipediaPageProgress(counts: WikipediaLanguageProgressCounts, imported: WikipediaPageImport): void {
  counts.pages += 1;
  counts.sources += imported.sources;
  counts.truncatedPages += imported.truncatedPages ?? 0;
  counts.truncatedCharacters += imported.truncatedCharacters ?? 0;
  counts.evidence += imported.evidence;
  counts.graphNodes += imported.graphNodes;
  counts.graphEdges += imported.graphEdges;
  counts.graphHyperedges += imported.graphHyperedges;
  counts.languageProfiles += imported.languageProfiles;
  counts.ngramObservations += imported.ngramObservations;
  counts.ngramModels += imported.ngramModels;
  counts.languageUnits += imported.languageUnits;
  counts.languagePatterns += imported.languagePatterns;
  counts.semanticFrames += imported.semanticFrames;
  counts.relationCandidates += imported.relationCandidates;
  counts.promotedRelations += imported.promotedRelations;
}

function addWikipediaLanguageProgress(counts: WikipediaLanguageProgressCounts, imported: WikipediaLanguageShardImport): void {
  counts.languageProfiles += imported.languageProfiles;
  counts.ngramObservations += imported.ngramObservations;
  counts.ngramModels += imported.ngramModels;
  counts.languageUnits += imported.languageUnits;
  counts.languagePatterns += imported.languagePatterns;
  counts.semanticFrames += imported.semanticFrames;
  counts.relationCandidates += imported.relationCandidates;
  counts.promotedRelations += imported.promotedRelations;
  counts.graphHyperedges += imported.graphHyperedges;
}

function wikipediaResultWithProgress(result: WikipediaV3IngestResult, counts: WikipediaLanguageProgressCounts): WikipediaV3IngestResult {
  return {
    ...result,
    pages: counts.pages, sources: counts.sources, truncatedPages: counts.truncatedPages, truncatedCharacters: counts.truncatedCharacters, evidence: counts.evidence,
    graphNodes: counts.graphNodes, graphEdges: counts.graphEdges, graphHyperedges: counts.graphHyperedges,
    languageProfiles: counts.languageProfiles, ngramObservations: counts.ngramObservations,
    ngramModels: counts.ngramModels, languageUnits: counts.languageUnits,
    languagePatterns: counts.languagePatterns, semanticFrames: counts.semanticFrames,
    relationCandidates: counts.relationCandidates, promotedRelations: counts.promotedRelations,
    lastCheckpointOffset: counts.lastCheckpointOffset
  };
}

function stringValue(value: JsonValue | undefined): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
