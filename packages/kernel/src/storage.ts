import type {
  AlphaTrace,
  BenchmarkInput,
  BenchmarkResult,
  BuildTestResult,
  CapabilityPlan,
  ConstructGraph,
  ContentHash,
  EmissionGraph,
  EpisodeId,
  EventId,
  EvidenceId,
  EvidenceSpan,
  ForecastEnvelope,
  ForecastState,
  GraphEdge,
  GraphNode,
  GraphSlice,
  GraphSliceQuery,
  Hyperedge,
  InformationLabel,
  InspectionTarget,
  JsonValue,
  LanguageProfile,
  ModelState,
  ProofId,
  RunId,
  ScceEvent,
  SemanticProof,
  SourceId,
  SourceRedactionInterval,
  SourceVersion,
  SourceVersionId,
  TemporalGraph,
  TemporalGraphQuery,
  ValidationGraph
} from "./types.js";
import type { EvaluationConditionConfig } from "./evaluation-flags.js";
import type { BrainShardProvenanceClass } from "./brain-shards.js";
import type { CorpusRegistryEntry } from "./corpus-registry.js";
import type { CalibrationObservationRecord } from "./calibration-spine.js";
import type { RelationPotentialModel } from "./relation-potential.js";
import type { DurableExecutiveEpisode } from "./executive-journal.js";
import type { TranslationSeed } from "./language-induction.js";
import type { TranslationConstruction } from "./translation.js";

export interface EventRangeQuery {
  episodeId?: EpisodeId;
  typeId?: string;
  afterT?: number;
  beforeT?: number;
  limit?: number;
}

export interface EvidenceQuery {
  text?: string;
  sourceId?: SourceId;
  sourceVersionId?: SourceVersionId;
  features?: string[];
  /**
   * Cognitive retrieval is promoted-only by default. Quarantined evidence is
   * available only to explicit admission/training inspection.
   */
  status?: "promoted" | "quarantined" | "any";
  limit?: number;
}

export interface EvidenceSearchResult {
  span: EvidenceSpan;
  score: number;
  reason: string;
}

export interface NgramObservation {
  id: string;
  streamId: string;
  languageHint: string;
  order: number;
  history: string[];
  symbol: string;
  count: number;
  fieldWeight: number;
  sourceVersionId?: SourceVersionId;
  evidenceId?: EvidenceId;
  observedAt: number;
  metadata: JsonValue;
  informationLabel?: InformationLabel;
}

export interface NgramModelRecord {
  id: string;
  streamId: string;
  languageHint: string;
  maxOrder: number;
  discount: number;
  modelJson: JsonValue;
  updatedAt: number;
  informationLabel?: InformationLabel;
}

export interface LanguageUnitRecord {
  id: string;
  profileId: string;
  sourceVersionId: SourceVersionId;
  script: string;
  unitKind: "grapheme" | "symbol" | "phrase" | "morpheme" | "syntax_pattern" | "semantic_frame";
  text: string;
  features: string[];
  competenceVector: number[];
  alpha: number;
  evidenceIds: EvidenceId[];
  metadata: JsonValue;
  informationLabel?: InformationLabel;
}

export interface LanguagePatternRecord {
  id: string;
  profileId: string;
  patternKind: "segmentation" | "morphology" | "syntax" | "cadence" | "discourse" | "narrative" | "semantic_role";
  support: number;
  entropy: number;
  patternJson: JsonValue;
  evidenceIds: EvidenceId[];
  updatedAt: number;
  informationLabel?: InformationLabel;
}

export interface SemanticFrameRecord {
  id: string;
  frameJson: JsonValue;
  embedding: number[];
  evidenceIds: EvidenceId[];
  alpha: number;
  createdAt: number;
  informationLabel?: InformationLabel;
}

export interface TranslationAlignmentRecord {
  id: string;
  sourceFrameId: string;
  targetFrameId: string;
  sourceLanguage: string;
  targetLanguage: string;
  force: "direct" | "approximate" | "gloss" | "unknown";
  lossVector: JsonValue;
  alignmentJson: JsonValue;
  evidenceIds: EvidenceId[];
  updatedAt: number;
  informationLabel?: InformationLabel;
}

export interface BrainImportLedgerRecord {
  id: string;
  importRunId: string;
  brainVersion: string;
  rootPath: string;
  sectionId: string;
  sectionKind: "manifest" | "brain_bundle" | "graph_shard" | "language_profile" | "ngram_state" | "direct_evidence" | "profile_excerpt_evidence" | "primitives" | "templates" | "mouth" | "ngram_shard" | "wiki_stream" | "unknown";
  forceClass: BrainShardProvenanceClass;
  sourcePath?: string;
  fileHash?: string;
  shardHash?: string;
  sourceVersionId?: SourceVersionId;
  evidenceIds: EvidenceId[];
  nodeIds: string[];
  rowCounts: Record<string, number>;
  warnings: string[];
  metadata: JsonValue;
  importedAt: number;
}

export interface BrainImportSummary {
  activeBrainVersion?: string;
  activeImportRunIds: string[];
  importedLanguagePriorCount: number;
  importedGraphPriorCount: number;
  importedDirectEvidenceCount: number;
  profileExcerptEvidenceCount: number;
  importedLearnedPriorCount: number;
  importedProgramPriorCount: number;
  unknownPriorCount: number;
  runs: Array<{ importRunId: string; brainVersion: string; rootPath: string; importedAt: number; rows: number; forceClasses: Record<string, number>; rowCounts: Record<string, number>; warnings: string[] }>;
}

export type WorkspaceIngestionStatus = "pending" | "ingested" | "skipped" | "changed" | "missing" | "failed";

export interface WorkspaceRecord {
  id: string;
  rootPath: string;
  rootUri: string;
  corpusId: string;
  status: "active" | "archived";
  createdAt: number;
  updatedAt: number;
  metadata: JsonValue;
}

export interface WorkspaceSourceFileRecord {
  workspaceId: string;
  corpusId: string;
  path: string;
  absolutePath: string;
  mediaType: string;
  contentHash?: ContentHash;
  modifiedTime: number;
  byteLength: number;
  ingestionStatus: WorkspaceIngestionStatus;
  importBatchId?: string;
  sourceVersionId?: SourceVersionId;
  evidenceIds: EvidenceId[];
  symbolIds: string[];
  conceptIds: string[];
  warnings: string[];
  errors: string[];
  metadata: JsonValue;
  updatedAt: number;
}

export interface WorkspaceReportRecord {
  id: string;
  workspaceId: string;
  corpusId: string;
  reportKind: "summary" | "map" | "symbols" | "gaps" | "contradictions" | "tasks" | "brief" | "patch_plan" | "handoff" | "review" | "answer";
  title: string;
  body: string;
  data: JsonValue;
  sourceRefs: JsonValue;
  createdAt: number;
}

export interface InteractionStateRecord {
  id: string;
  conversationId: string;
  turnId: string;
  stateJson: JsonValue;
  featureRefs: string[];
  signalRefs: string[];
  createdAt: number;
}

export interface InteractionStateCompareAndSet {
  stateSchema: string;
  expectedStateId: string | null;
  expectedTurnIndex: number | null;
  nextStateId: string;
  nextTurnIndex: number;
}

export interface InteractionStateCompareAndSetResult {
  stored: boolean;
  currentStateId: string | null;
  currentTurnIndex: number | null;
  reason: "stored" | "state_conflict" | "turn_not_monotonic";
}

export interface DialoguePolicyDecisionRecord {
  id: string;
  conversationId: string;
  turnId: string;
  decisionJson: JsonValue;
  selectedActionIds: string[];
  scoreTraceRefs: string[];
  createdAt: number;
}

export interface ConversationOutcomeRecord {
  id: string;
  conversationId: string;
  turnId: string;
  promptHash: string;
  answerGraphHash?: string;
  responseHash: string;
  accepted?: boolean;
  rejected?: boolean;
  corrected?: boolean;
  correctionText?: string;
  requestedConstraintRefs: readonly string[];
  satisfiedConstraintRefs: readonly string[];
  failedConstraintRefs: readonly string[];
  scoreTraceRefs: readonly string[];
  createdAt: string;
}

export interface UserCorrectionRecord {
  id: string;
  conversationId: string;
  turnId: string;
  promptHash: string;
  responseHash: string;
  correctionText: string;
  rejectedSurfaceHash?: string;
  acceptedSurfaceHash?: string;
  preferenceDeltaJson: JsonValue;
  createdAt: number;
}

export interface StylePreferenceSnapshot {
  id: string;
  conversationId: string;
  profileHash: string;
  profileJson: JsonValue;
  sourceOutcomeIds: string[];
  createdAt: number;
}

export interface ResponseCandidateRecord {
  id: string;
  conversationId: string;
  turnId: string;
  candidateId: string;
  policyDecisionId: string;
  answerGraphHash?: string;
  responseHash: string;
  responseText: string;
  criticScore: number;
  scoreTraceRefs: string[];
  createdAt: number;
}

export interface TargetProfilePatternRecord {
  id: string;
  targetProfileId: string;
  patternFamilyId: string;
  patternJson: JsonValue;
  evidenceIds: EvidenceId[];
  alpha: number;
  createdAt: number;
  updatedAt: number;
}

export type CorrectionRuleKind =
  | "surface_note"
  | "preferred_surface"
  | "style_shift"
  | "register_shift"
  | "meter_constraint"
  | "translation_preference"
  | "terminology_preference"
  | "verbosity_preference"
  | "semantic_error"
  | "pronunciation_or_transliteration"
  | "script_preference";

export interface CorrectionRuleRecord {
  id: string;
  episodeId: EpisodeId;
  ruleKind: CorrectionRuleKind;
  scope: string;
  pattern: string;
  replacement?: string;
  weight: number;
  contextJson: JsonValue;
  provenanceJson: JsonValue;
  createdAt: number;
  updatedAt: number;
}

export interface LocaleBundleRecord {
  id: string;
  sourceLocale: string;
  targetLanguageId: string;
  targetScriptId?: string;
  status: "draft" | "promoted" | "rejected";
  force: "direct" | "approximate" | "gloss" | "unknown";
  messagesJson: JsonValue;
  missingTermsJson: JsonValue;
  evidenceIds: EvidenceId[];
  translationAlignmentIds: string[];
  createdAt: number;
  updatedAt: number;
}

export interface AlignmentCorpusRecord {
  id: string;
  sourceLanguage: string;
  targetLanguage: string;
  corpusType: "parallel_sentences" | "comparable_documents" | "dictionary" | "locale_bundle" | "aligned_wikipedia" | "user_corrections" | "mixed";
  corpusName?: string;
  sentencePairs: number;
  docPairs: number;
  alignmentCoverage: number;
  anchorsFound: number;
  confidence: number;
  sourceVersionId?: SourceVersionId;
  evidenceIds: EvidenceId[];
  metadata: JsonValue;
  createdAt: number;
  updatedAt: number;
}

export interface AlignmentObservation {
  id: string;
  sourceLanguage: string;
  targetLanguage: string;
  sourceSymbol: string;
  targetSymbol: string;
  alignmentBasis: "lexical_overlap" | "positional_window" | "semantic_similarity" | "anchor_shared" | "external_resource" | "user_correction";
  score: number;
  context: { sourceLeft: string[]; sourceRight: string[]; targetLeft: string[]; targetRight: string[] };
  cooccurrenceCount: number;
  pmiScore: number;
  diceScore: number;
  corpusId: string;
  sourceVersionId?: SourceVersionId;
  evidenceIds: EvidenceId[];
  observedAt: number;
}

export interface LexicalAlignmentModel {
  id: string;
  sourceLanguage: string;
  targetLanguage: string;
  alignmentVersion: number;
  lexicalTable: Record<string, Record<string, number>>;
  reverseTable: Record<string, Record<string, number>>;
  alignmentCounts: { totalPairs: number; uniqueSourceTerms: number; uniqueTargetTerms: number };
  perplexity: number;
  trainingCorpora: string[];
  updatedAt: number;
}

export interface PhraseAlignmentModel {
  id: string;
  sourceLanguage: string;
  targetLanguage: string;
  alignmentVersion: number;
  phraseTable: Array<{
    sourcePhrase: string;
    targetPhrase: string;
    forwardProb: number;
    reverseProb: number;
    lexicalWeights: { forward: number; reverse: number };
    diceScore: number;
    pmiScore: number;
    cooccurrenceCount: number;
    evidenceCount: number;
  }>;
  topPhraseCoverage: number;
  trainingCorpora: string[];
  updatedAt: number;
}

export interface UserCorrectionAlignmentRecord {
  id: string;
  sourceLanguage: string;
  targetLanguage: string;
  sourceText: string;
  previousOutput: string;
  correctedOutput: string;
  sourceProfileId: string;
  targetProfileId: string;
  protectedTerms: string[];
  changedTerms: Array<{ original: string; corrected: string; reason: string }>;
  alignmentDelta: JsonValue;
  alpha: number;
  episodeId: EpisodeId;
  evidenceIds: EvidenceId[];
  createdAt: number;
}

export interface RoundTripValidationRecord {
  id: string;
  originalLanguage: string;
  sourceLanguage: string;
  targetLanguage: string;
  originalText: string;
  sourceTranslation: string;
  targetTranslation: string;
  backTranslation: string;
  semanticSimilarity: number;
  entityPreservation: number;
  numberPreservation: number;
  lossVector: JsonValue;
  passed: boolean;
  issues: string[];
  translationAlignmentId?: string;
  evidenceIds: EvidenceId[];
  createdAt: number;
}

export interface QuarantineSource {
  id: string;
  sourceId: SourceId;
  sourceVersionId: SourceVersionId;
  uri: string;
  contentHash: ContentHash;
  mediaType: string;
  fetchedAt: number;
  trustVector: JsonValue;
  permissionVector: JsonValue;
  licenseHint?: string;
  decision: "pending" | "promoted" | "rejected";
  decisionJson?: JsonValue;
}

export interface IngestedSourceFile {
  uri: string;
  namespace: string;
  mediaType: string;
  bytes: Uint8Array;
  text: string;
  metadata: JsonValue;
  evidenceDerivative?: {
    bytes: Uint8Array;
    text: string;
    kind: "redacted-text" | "extracted-text";
    transformId: string;
    originalCoordinateSpace: "source-bytes" | "extracted-text-utf8";
    redactionMap: SourceRedactionInterval[];
  };
}

export interface IngestionCheckpoint {
  id: string;
  rootUri: string;
  itemUri: string;
  phase: "discovered" | "extracting" | "extracted" | "stored" | "skipped" | "failed";
  status: "pending" | "running" | "complete" | "failed";
  offsetBytes: number;
  contentHash?: ContentHash;
  byteLength?: number;
  reason?: string;
  updatedAt: number;
  metadata: JsonValue;
}

export interface PpfCacheRecord {
  id: string;
  graphHash: string;
  beta: number;
  personalizationJson: JsonValue;
  massJson: JsonValue;
  diagnosticsJson: JsonValue;
  createdAt: number;
}

export interface AlphaTraceRecord {
  id: string;
  graphHash: string;
  alpha: number;
  traceJson: JsonValue;
  createdAt: number;
}

export interface SelfRewriteEpisodeRecord {
  id: string;
  episodeId: EpisodeId;
  target: string;
  programGraphJson: JsonValue;
  improvementJson: JsonValue;
  status: "proposed" | "approved" | "emitted" | "rejected";
  createdAt: number;
}

export interface SelfRewritePatchRecord {
  id: string;
  rewriteEpisodeId: string;
  filePath: string;
  beforeHash?: string;
  afterHash: string;
  patchJson: JsonValue;
  scoreJson: JsonValue;
  createdAt: number;
}

export interface PromotionDecision {
  decision: "promoted" | "rejected";
  decidedAt: number;
  reason: string;
  reviewer?: string;
  metadata?: JsonValue;
}

export interface ConversationTurnRecord {
  id: string;
  sessionId: string;
  episodeId: EpisodeId;
  turnIndex: number;
  roleId: string;
  text: string;
  evidenceIds: EvidenceId[];
  metadata: JsonValue;
  createdAt: number;
}

export interface ConversationTurnQuery {
  sessionId: string;
  beforeTurnIndex?: number;
  limit?: number;
}

export interface EventLedger {
  append(event: ScceEvent): Promise<void>;
  appendBatch(events: ScceEvent[]): Promise<void>;
  readEpisode(episodeId: EpisodeId): Promise<ScceEvent[]>;
  /**
   * Batched, payload-free event skeletons for many episodes at once.
   * Exists because per-turn history induction (induced-reasoning and
   * procedural-skill runtimes) was issuing one readEpisode per past
   * consolidated episode -- 242 queries and 6.9s of a single warm turn's
   * database time, measured -- while consuming ONLY id/episodeId/typeId
   * and never the payloads it forced Postgres to detoast. Optional so
   * fixture stores stay valid; callers fall back to readEpisode.
   */
  readEpisodeEventSkeletons?(episodeIds: readonly EpisodeId[]): Promise<Array<{ id: string; episodeId: string; typeId: string }>>;
  readRange(input: EventRangeQuery): Promise<ScceEvent[]>;
  latestLedgerHash(): Promise<string>;
}

export interface GraphStore {
  upsertNode(node: GraphNode): Promise<void>;
  upsertNodes?(nodes: readonly GraphNode[]): Promise<void>;
  upsertEdge(edge: GraphEdge): Promise<void>;
  upsertEdges?(edges: readonly GraphEdge[]): Promise<void>;
  upsertHyperedge(edge: Hyperedge): Promise<void>;
  upsertHyperedges?(edges: readonly Hyperedge[]): Promise<void>;
  getSlice(query: GraphSliceQuery): Promise<GraphSlice>;
  getTemporalSlice(query: TemporalGraphQuery): Promise<TemporalGraph>;
  materializeAlphaGraph(query: GraphSliceQuery): Promise<AlphaTrace>;
}

export interface WordingRealizerFact {
  subject: string;
  predicate: string;
  object: string;
  evidenceIds: readonly string[];
}

export interface EvidenceVisualSearchResult {
  span: EvidenceSpan;
  score: number;
  regions: readonly (readonly number[])[];
}

export interface WordingRealizerRequest {
  requestText: string;
  facts: readonly WordingRealizerFact[];
  targetLanguage: string;
  targetScript: string;
  maxSentences: number;
  /** Closed-class vocabulary of the active language (derived, never hardcoded) a wording realizer may use besides fact tokens. */
  closedClassWords?: readonly string[];
  /** An invention may say more than the facts; it is labelled invented, never sourced. */
  invention?: boolean;
}

/** See ScceKernelDeps.wordingRealizer for the doctrine this port lives under. */
export interface WordingRealizerPort {
  id: string;
  realize(request: WordingRealizerRequest): Promise<readonly string[]> | readonly string[];
}

export interface EvidenceStore {
  putSourceVersion(source: SourceVersion): Promise<void>;
  putEvidenceSpan(span: EvidenceSpan): Promise<void>;
  putEvidenceSpans?(spans: readonly EvidenceSpan[]): Promise<void>;
  promoteEvidence(ids: EvidenceId[], reason: string): Promise<number>;
  getEvidence(id: EvidenceId): Promise<EvidenceSpan | null>;
  getEvidenceBatch(ids: EvidenceId[]): Promise<EvidenceSpan[]>;
  searchEvidence(query: EvidenceQuery): Promise<EvidenceSearchResult[]>;
  sourceVersionsForEvidence(ids: EvidenceId[]): Promise<SourceVersion[]>;
  /**
   * Resolve source versions whose stored content hash matches one of the
   * given hashes. Powers sealed-corpus evaluation: the harness derives the
   * allowlist of source versions the runtime may answer from directly from
   * the manifest's document bytes, so "sealed" is enforced by identity of
   * content, never by trusting document ids or paths. Optional so
   * fixture-backed stores that never seal remain valid.
   */
  sourceVersionsByContentHashes?(hashes: readonly ContentHash[]): Promise<SourceVersion[]>;
  /**
   * Visual evidence attributes (Phase 3): a whole-image/page vector and per-region
   * vectors stored ON the evidence span, so provenance lives once on the node.
   * Optional: stores without pgvector or without a visual model never implement it.
   */
  putEvidenceVisual?(input: { evidenceId: EvidenceId; embedding: readonly number[]; regions: readonly (readonly number[])[]; model: string }): Promise<void>;
  /** Cosine prefilter over whole-image vectors; callers rerank with MaxSim over `regions`. */
  searchEvidenceByVisual?(input: { embedding: readonly number[]; limit: number }): Promise<EvidenceVisualSearchResult[]>;
  /**
   * Enumerate source versions that promoted evidence actually draws on,
   * ordered by evidence alpha (the sources the runtime leans on first).
   * Powers stored-corpus construction training: re-running the language
   * lane over text already in the blob store, so the generation inventory
   * can be built from the same corpus retrieval already trusts, without
   * re-ingesting anything.
   */
  listEvidenceBackedSourceVersions?(query?: {
    excludeUriPrefixes?: readonly string[];
    minByteLength?: number;
    maxByteLength?: number;
    limit?: number;
  }): Promise<Array<{
    sourceVersionId: SourceVersionId;
    contentHash: ContentHash;
    canonicalUri: string;
    byteLength: number;
    maxAlpha: number;
    promotedSpanCount: number;
  }>>;
}

export interface ConversationStore {
  putTurn(record: ConversationTurnRecord): Promise<void>;
  listTurns(query: ConversationTurnQuery): Promise<ConversationTurnRecord[]>;
}

export interface BlobStore {
  put(content: Uint8Array, mediaType: string): Promise<ContentHash>;
  get(hash: ContentHash): Promise<Uint8Array>;
  exists(hash: ContentHash): Promise<boolean>;
}

export interface QuarantineStore {
  put(source: QuarantineSource): Promise<void>;
  get(id: string): Promise<QuarantineSource | null>;
  listPending(query?: { sourceId?: SourceId; limit?: number }): Promise<QuarantineSource[]>;
  markDecision(id: string, decision: PromotionDecision): Promise<void>;
}

export interface IngestionCheckpointStore {
  put(checkpoint: IngestionCheckpoint): Promise<void>;
  get(id: string): Promise<IngestionCheckpoint | null>;
  list(query?: { rootUri?: string; status?: IngestionCheckpoint["status"]; limit?: number }): Promise<IngestionCheckpoint[]>;
}

export interface ProofStore {
  putProof(proof: SemanticProof): Promise<void>;
  getProof(id: ProofId): Promise<SemanticProof | null>;
  findProofsForClaim(claimId: string): Promise<SemanticProof[]>;
}

export interface ConstructStore {
  putConstruct(graph: ConstructGraph): Promise<void>;
  putValidation(graph: ValidationGraph): Promise<void>;
  putEmission(graph: EmissionGraph): Promise<void>;
  putBuildTest(episodeId: EpisodeId, constructId: string, result: BuildTestResult): Promise<void>;
  getConstruct(id: string): Promise<ConstructGraph | null>;
}

export interface CapabilityAuditStore {
  putPlan(plan: CapabilityPlan): Promise<void>;
  listByEpisode(episodeId: EpisodeId): Promise<CapabilityPlan[]>;
}

export interface ForecastStore {
  putState(state: ForecastState): Promise<void>;
  putForecast(forecast: ForecastEnvelope): Promise<void>;
  getSeries(query: { since?: number; until?: number; limit?: number }): Promise<ForecastState[]>;
}

export interface BenchmarkStore {
  putRun(run: { id: RunId; config: JsonValue; startedAt: number; completedAt?: number; summary?: JsonValue }): Promise<void>;
  putCase(result: { id: string; runId: RunId; case: JsonValue; result: JsonValue; score: JsonValue }): Promise<void>;
  summarize(query?: { runId?: RunId; since?: number }): Promise<{ runs: number; cases: number; meanScore: number }>;
}

export interface ModelStore {
  readModel(): Promise<ModelState>;
  writeModel(model: ModelState): Promise<void>;
  putLanguageProfile(profile: LanguageProfile): Promise<void>;
  putLanguageProfiles?(profiles: readonly LanguageProfile[]): Promise<void>;
  listLanguageProfiles(query?: number | LanguageProfileQuery): Promise<LanguageProfile[]>;
}

export interface LanguageProfileQuery {
  /** Required finite turn-time bound. Legacy numeric callers remain supported. */
  limit: number;
  /** Retain only profiles that own at least one durable language-memory artifact. */
  referencedByLanguageMemory?: boolean;
  /**
   * Exact source-derived language aliases. Adapters must resolve these through
   * durable alias ownership rather than scanning recent profile JSON.
   */
  sourceDerivedAliases?: readonly string[];
  /**
   * Normalized surface trigrams used to retrieve bounded profile candidates
   * from the full durable corpus instead of only the newest profile window.
   */
  surfaceNgrams?: readonly string[];
}

export interface LanguageMemoryStore {
  putNgramObservation(observation: NgramObservation): Promise<void>;
  putNgramObservationsBatch(observations: readonly NgramObservation[]): Promise<void>;
  putNgramModel(model: NgramModelRecord): Promise<void>;
  putNgramModels?(models: readonly NgramModelRecord[]): Promise<void>;
  putLanguageUnit(unit: LanguageUnitRecord): Promise<void>;
  putLanguageUnits?(units: readonly LanguageUnitRecord[]): Promise<void>;
  putLanguagePattern(pattern: LanguagePatternRecord): Promise<void>;
  putLanguagePatterns?(patterns: readonly LanguagePatternRecord[]): Promise<void>;
  putSemanticFrame(frame: SemanticFrameRecord): Promise<void>;
  putSemanticFrames?(frames: readonly SemanticFrameRecord[]): Promise<void>;
  putTranslationAlignment(alignment: TranslationAlignmentRecord): Promise<void>;
  /**
   * `maxTotalJsonBytes` on the model/unit listings is a cumulative byte
   * budget over the records' stored JSON, enforced adapter-side in the
   * same relevance order the listing already uses: records load until the
   * budget is exhausted and the tail is skipped deterministically. A
   * count limit alone does not bound memory -- whole-novel training grew
   * single n-gram models to tens of MB, and 64 "records" of them OOMed a
   * 4GB server heap at warmup (verified live).
   */
  listNgramModels(query?: { streamId?: string; languageHint?: string; profileIds?: readonly string[]; sourceSystem?: string; limit?: number; maxTotalJsonBytes?: number }): Promise<NgramModelRecord[]>;
  listNgramObservations(query?: { streamId?: string; languageHint?: string; profileIds?: readonly string[]; sourceSystem?: string; limit?: number }): Promise<NgramObservation[]>;
  listLanguageUnits(query?: { profileId?: string; profileIds?: readonly string[]; script?: string; sourceSystem?: string; limit?: number; maxTotalJsonBytes?: number }): Promise<LanguageUnitRecord[]>;
  listLanguagePatterns(query?: { profileId?: string; profileIds?: readonly string[]; sourceSystem?: string; limit?: number }): Promise<LanguagePatternRecord[]>;
  listSemanticFrames(query?: { profileIds?: readonly string[]; sourceSystem?: string; surface?: string; limit?: number }): Promise<SemanticFrameRecord[]>;
  listTranslationAlignments(query?: { sourceLanguage?: string; targetLanguage?: string; limit?: number }): Promise<TranslationAlignmentRecord[]>;
}

export interface BrainImportStore {
  putLedger(record: BrainImportLedgerRecord): Promise<void>;
  listLedger(query?: { importRunId?: string; forceClass?: BrainShardProvenanceClass; limit?: number }): Promise<BrainImportLedgerRecord[]>;
  summarize(query?: { importRunId?: string; limit?: number }): Promise<BrainImportSummary>;
  putLifecycle(record: import("./brain-lifecycle.js").BrainLifecycleRecord): Promise<void>;
  getLifecycle(importRunId: string): Promise<import("./brain-lifecycle.js").BrainLifecycleRecord | null>;
  listLifecycle(query?: { state?: import("./brain-lifecycle.js").BrainLifecycleState; limit?: number }): Promise<import("./brain-lifecycle.js").BrainLifecycleRecord[]>;
  transitionLifecycle(input: import("./brain-lifecycle.js").BrainLifecycleTransition): Promise<import("./brain-lifecycle.js").BrainLifecycleRecord>;
  activateReady(input: { brainVersion: string; importRunId: string; updatedAt: number }): Promise<{ activeBrainVersion: string; activeImportRunIds: string[] }>;
  active(): Promise<{ activeBrainVersion?: string; activeImportRunIds: string[] }>;
}

export interface CorrectionMemoryStore {
  putRule(rule: CorrectionRuleRecord): Promise<void>;
  listRules(query?: { ruleKind?: CorrectionRuleKind; scope?: string; limit?: number }): Promise<CorrectionRuleRecord[]>;
}

/** Plan items 219-220. Storage-schema shape for a real, durable, provenance-aware user-model claim -- kept flat and JSON-safe, matching `CorrectionRuleRecord`'s own convention (the business-logic type lives in `user-model-store.ts`; this file never imports it, matching this module's existing dependency direction). */
export type UserModelClaimKind = "preference" | "expertise" | "terminology" | "boundary";
export type UserModelClaimSource = "explicit_instruction" | "demonstrated_behavior" | "inferred";

export interface UserModelClaimRecord {
  id: string;
  /** Real tenant/conversation isolation boundary -- every claim belongs to exactly one conversation and `listClaims` requires it, so one conversation's corrections/preferences can never leak into an unrelated one's `TurnResult.userModelStore`. */
  conversationId: string;
  kind: UserModelClaimKind;
  subject: string;
  value: string;
  source: UserModelClaimSource;
  scope: string;
  confidence: number;
  observedAt: number;
  evidenceIds: EvidenceId[];
  supersedesClaimId?: string;
}

export interface UserModelClaimStore {
  putClaim(claim: UserModelClaimRecord): Promise<void>;
  /** `conversationId` is required (not optional) so a caller can never accidentally issue an unscoped, cross-conversation query. */
  listClaims(query: { conversationId: string; subject?: string; scope?: string; limit?: number }): Promise<UserModelClaimRecord[]>;
}

/** Plan items 217-218. Storage-schema shape for a real, durable task-resumption snapshot. `snapshotJson` carries the full real snapshot (`task-resumption-snapshot.ts`'s `TaskResumptionSnapshot` -- already fully JSON-safe); `id`/`goalId`/`capturedAt` are pulled out as real indexed columns for real querying, the same split `ppf_cache`/`alpha_traces` already use for their own JSON-payload-plus-indexed-columns records. */
export interface TaskResumptionSnapshotRecord {
  id: string;
  goalId: string;
  snapshotJson: JsonValue;
  capturedAt: number;
}

export interface TaskResumptionSnapshotStore {
  putSnapshot(record: TaskResumptionSnapshotRecord): Promise<void>;
  getLatestSnapshot(goalId: string): Promise<TaskResumptionSnapshotRecord | null>;
}

/**
 * Plan item 121: durable corpus-wide translation-seed store, so a request
 * whose own admitted evidence is sparse can still benefit from real
 * bilingual correspondence previously induced (and never re-derives from
 * scratch on every call). Keyed by (targetLanguage, sourceSymbol) --
 * `sourceLanguage` on `putSeeds` is recorded per row for inspectability but
 * is not part of the lookup key, since the caller's own request text is
 * this corpus's dominant source language in practice and requiring it
 * up front would need inferring it before `translation.ts`'s `plan()` (the
 * one place that already resolves it) has run. `putSeeds` only ever raises
 * the durably-held score for a key, never lowers it with a weaker
 * request-scoped induction.
 */
export interface TranslationSeedStore {
  putSeeds(input: { sourceLanguage: string; targetLanguage: string; seeds: readonly TranslationSeed[]; observedAt: number }): Promise<void>;
  listSeeds(targetLanguage: string, limit?: number): Promise<TranslationSeed[]>;
}

/**
 * Plan item 127: durable corpus-wide translation-construction store --
 * real multi-symbol correspondences (see `TranslationConstruction`) that
 * generalize to a *different* sentence binding the same two source
 * symbols in a new context, without needing that later request's own
 * target evidence to re-derive the correspondence from scratch. Same
 * keying/upsert discipline as `TranslationSeedStore`.
 */
export interface TranslationConstructionStore {
  putConstructions(input: { targetLanguage: string; constructions: readonly TranslationConstruction[]; observedAt: number }): Promise<void>;
  listConstructions(targetLanguage: string, limit?: number): Promise<TranslationConstruction[]>;
}

/** Plan items 221-228. Storage-schema shape for a real, durable document-generation session -- `sessionJson` carries the full real `DocumentGenerationSession` (already fully JSON-safe), keyed by a real, caller-chosen, stable `id` so a multi-turn document-writing project never requires the caller to resend the whole plan on every turn. */
export interface DocumentGenerationSessionRecord {
  id: string;
  /** Real tenant/conversation isolation boundary -- storage keys on `(conversationId, id)`, not `id` alone, so a caller-chosen `sessionId` in one conversation can never collide with, be read by, or be overwritten by a different conversation guessing or reusing the same id. */
  conversationId: string;
  sessionJson: JsonValue;
  updatedAt: number;
}

export interface DocumentGenerationSessionCompareAndSetResult {
  stored: boolean;
  /** The real `updatedAt` currently on the stored row, or `null` if no row exists for this (conversationId, id) at all -- lets the caller distinguish "someone else's concurrent write already landed" from "this session was deleted/never started." */
  currentUpdatedAt: number | null;
}

export interface DocumentGenerationSessionStore {
  putSession(record: DocumentGenerationSessionRecord): Promise<void>;
  /** `conversationId` is required and part of the lookup key -- a session belonging to a different conversation is indistinguishable from one that never existed, never leaked via a different error/result shape. */
  getSession(id: string, conversationId: string): Promise<DocumentGenerationSessionRecord | null>;
  /**
   * Real optimistic-concurrency write: succeeds only if the row's current
   * `updatedAt` still equals `expectedUpdatedAt` (or the row does not yet
   * exist, when `expectedUpdatedAt` is `null`). Prevents the real
   * lost-update race in `complete_section`: read session -> mutate in
   * memory -> write, where two concurrent completions against the same
   * session would otherwise let whichever write lands last silently
   * discard the other's real completion.
   */
  compareAndPutSession(record: DocumentGenerationSessionRecord, expectedUpdatedAt: number | null): Promise<DocumentGenerationSessionCompareAndSetResult>;
}

export interface LocalizationStore {
  putBundle(bundle: LocaleBundleRecord): Promise<void>;
  listBundles(query?: { targetLanguageId?: string; status?: LocaleBundleRecord["status"]; limit?: number }): Promise<LocaleBundleRecord[]>;
  promoteBundle(id: string, promotedAt: number): Promise<void>;
}

export interface FlowCacheStore {
  putPpf(record: PpfCacheRecord): Promise<void>;
  getPpf(id: string): Promise<PpfCacheRecord | null>;
  putAlphaTrace(record: AlphaTraceRecord): Promise<void>;
  listAlphaTraces(query?: { graphHash?: string; limit?: number }): Promise<AlphaTraceRecord[]>;
}

export interface SelfRewriteStore {
  putEpisode(record: SelfRewriteEpisodeRecord): Promise<void>;
  putPatch(record: SelfRewritePatchRecord): Promise<void>;
  listEpisodes(query?: { status?: SelfRewriteEpisodeRecord["status"]; limit?: number }): Promise<SelfRewriteEpisodeRecord[]>;
  listPatches(rewriteEpisodeId: string): Promise<SelfRewritePatchRecord[]>;
}

export interface WorkspaceStore {
  putWorkspace(record: WorkspaceRecord): Promise<void>;
  getWorkspace(id: string): Promise<WorkspaceRecord | null>;
  latestWorkspace(): Promise<WorkspaceRecord | null>;
  putSourceFile(record: WorkspaceSourceFileRecord): Promise<void>;
  listSourceFiles(query?: { workspaceId?: string; corpusId?: string; status?: WorkspaceIngestionStatus; limit?: number }): Promise<WorkspaceSourceFileRecord[]>;
  putReport(record: WorkspaceReportRecord): Promise<void>;
  listReports(query?: { workspaceId?: string; reportKind?: WorkspaceReportRecord["reportKind"]; limit?: number }): Promise<WorkspaceReportRecord[]>;
}

export interface DialogueMemoryStore {
  putInteractionState(record: InteractionStateRecord): Promise<void>;
  compareAndPutInteractionState(record: InteractionStateRecord, condition: InteractionStateCompareAndSet): Promise<InteractionStateCompareAndSetResult>;
  putPolicyDecision(record: DialoguePolicyDecisionRecord): Promise<void>;
  putConversationOutcome(record: ConversationOutcomeRecord): Promise<void>;
  putUserCorrection(record: UserCorrectionRecord): Promise<void>;
  putStyleSnapshot(record: StylePreferenceSnapshot): Promise<void>;
  putResponseCandidate(record: ResponseCandidateRecord): Promise<void>;
  putTargetProfilePattern(record: TargetProfilePatternRecord): Promise<void>;
  putCalibrationObservation(record: CalibrationObservationRecord): Promise<void>;
  listInteractionStates(query?: { conversationId?: string; turnId?: string; limit?: number }): Promise<InteractionStateRecord[]>;
  listPolicyDecisions(query?: { conversationId?: string; turnId?: string; limit?: number }): Promise<DialoguePolicyDecisionRecord[]>;
  listResponseCandidates(query?: { conversationId?: string; turnId?: string; policyDecisionId?: string; limit?: number }): Promise<ResponseCandidateRecord[]>;
  listConversationOutcomes(query?: { conversationId?: string; turnId?: string; limit?: number }): Promise<ConversationOutcomeRecord[]>;
  listStyleSnapshots(query?: { conversationId?: string; limit?: number }): Promise<StylePreferenceSnapshot[]>;
  listTargetProfilePatterns(query?: { targetProfileId?: string; patternFamilyId?: string; limit?: number }): Promise<TargetProfilePatternRecord[]>;
  listCalibrationObservations(query?: { calibrationId?: string; subsystemId?: string; taskClass?: string; sourceRecordId?: string; limit?: number }): Promise<CalibrationObservationRecord[]>;
}

export interface StorageAdmin {
  init(): Promise<void>;
  migrate(): Promise<void>;
  verify(): Promise<{ ok: boolean; tables: string[]; errors: string[] }>;
  /**
   * Run one logical storage mutation against a single atomic durable
   * transaction. Nested calls participate in the existing transaction.
   */
  transaction<T>(operation: () => Promise<T>): Promise<T>;
  status?(): Promise<JsonValue>;
  resetLocalDevOnly?(input: { confirmLocalDevOnly: boolean }): Promise<JsonValue>;
  stats(): Promise<JsonValue>;
  close(): Promise<void>;
}

export interface ScceStorage extends StorageAdmin {
  events: EventLedger;
  conversation: ConversationStore;
  ingestion: IngestionCheckpointStore;
  graph: GraphStore;
  evidence: EvidenceStore;
  blobs: BlobStore;
  quarantine: QuarantineStore;
  proofs: ProofStore;
  constructs: ConstructStore;
  capabilities: CapabilityAuditStore;
  forecasts: ForecastStore;
  benchmarks: BenchmarkStore;
  model: ModelStore;
  languageMemory: LanguageMemoryStore;
  brainImports: BrainImportStore;
  corrections: CorrectionMemoryStore;
  userModelClaims: UserModelClaimStore;
  taskResumption: TaskResumptionSnapshotStore;
  documentGeneration: DocumentGenerationSessionStore;
  localization: LocalizationStore;
  flowCache: FlowCacheStore;
  selfRewrite: SelfRewriteStore;
  workspace: WorkspaceStore;
  dialogueMemory: DialogueMemoryStore;
  /**
   * Optional: durable, versioned policy-evaluation history feeding
   * `functionalCognitionEngine.project()`'s policyPopulation. Optional
   * (unlike the other stores above) so existing in-memory/test storage
   * doubles that don't exercise EFC do not need to implement it; the real
   * Postgres adapter always provides it. Absent or empty keeps EFC
   * honestly unavailable rather than defaulting to a permissive fallback.
   */
  policyEvolution?: PolicyEvolutionStore;
  /**
   * Optional: durable FTRL reranker model lifecycle store (Part A finding
   * 9). Optional for the same reason as `policyEvolution` -- existing
   * fixture-built storage doubles need no changes; absent means retrieval
   * ranking stays BM25-only, never a silent fallback to an unvalidated
   * model.
   */
  sparseRanking?: import("./sparse-ranking-lifecycle.js").SparseRankingModelStore;
  /**
   * Optional: durable, replayable pairwise-comparison log backing the
   * FTRL held-out evaluation gate (Part A finding 9, stage 6). Separate
   * from `sparseRanking` for the same reason `sparseRankingComparisons`
   * is separate on `ScceKernelDeps` -- see that field's doc comment.
   */
  sparseRankingComparisons?: import("./sparse-ranking-comparison-log.js").SparseRankingComparisonLogStore;
  /**
   * Optional: durable corpus-wide translation-seed store (plan item 121).
   * Optional for the same reason as `policyEvolution` -- existing
   * fixture-built storage doubles need no changes; absent means
   * `translation.ts` falls back to its existing per-request-only seed
   * induction, never a silent fabricated seed.
   */
  translationSeeds?: TranslationSeedStore;
  /**
   * Optional: durable corpus-wide translation-construction store (plan
   * item 127). Optional for the same reason as `translationSeeds`; absent
   * means `translation.ts` falls back to per-request-only construction
   * extraction, never a silent fabricated construction.
   */
  translationConstructions?: TranslationConstructionStore;
  /**
   * Optional: durable per-language-cluster segmentation v2 boundary-signal
   * aggregate store (Part B step 2). Optional for the same reason as the
   * other stores above; absent means no corpus-derived spacing-convention
   * aggregate exists yet for any script and callers must fall back to the
   * static `scriptUsesSpaceSeparatedWords()` classification.
   */
  segmentationAggregates?: import("./segmentation-aggregate.js").SegmentationAggregateStore;
  /**
   * Optional: durable full induction-model persistence (Part B step 3).
   * Optional for the same reason as the other stores above; this store is
   * archival. Runtime activation still requires projected language-memory
   * records, not merely a stored JSON checkpoint.
   */
  inducedLanguageModels?: import("./language-induction-persistence.js").InducedLanguageModelStore;
  /**
   * Durable learned segmentation populations selected by document-disjoint
   * MDL. Unlike the obsolete spacing aggregate, records retain the complete
   * sufficient statistics, estimators, assignments, and selection trace.
   */
  segmentationPopulations?: import("./segmentation-population-persistence.js").SegmentationPopulationModelStore;
}

export interface PolicyEvolutionStore {
  putEvaluation(evaluation: import("./policy-evolution.js").PolicyEvaluation): Promise<void>;
  listGenomes(query?: {
    objectiveSchemaId?: string;
    limit?: number;
  }): Promise<import("./policy-evolution.js").DurablePolicyGenome[]>;
}

export interface FileIngestPort {
  streamPath(pathOrUri: string, options?: { metadata?: JsonValue }): AsyncIterable<
    | { type: "checkpoint"; checkpoint: IngestionCheckpoint }
    | { type: "file"; file: IngestedSourceFile; checkpoint: IngestionCheckpoint }
    | { type: "skipped"; skipped: { path: string; reason: string }; checkpoint: IngestionCheckpoint }
  >;
}

export interface BuildTestPort {
  executeProgram(input: { episodeId: EpisodeId; construct: ConstructGraph }): Promise<BuildTestResult>;
}

export interface ConnectorPort {
  fetch(uri: string): Promise<{ uri: string; mediaType: string; bytes: Uint8Array; metadata: JsonValue }>;
  search(query: string, limit: number): Promise<Array<{ uri: string; title: string; snippet: string; metadata: JsonValue }>>;
  outlookSearch?(query: string, limit?: number): Promise<JsonValue>;
  outlookReadMessage?(messageId: string): Promise<JsonValue>;
  outlookCreateDraft?(input: { to: string[]; subject: string; body: string; cc?: string[]; approved?: boolean }): Promise<JsonValue>;
  outlookSendDraft?(messageId: string, approved?: boolean): Promise<JsonValue>;
  outlookDeleteDraft?(messageId: string, approved?: boolean): Promise<JsonValue>;
  outlookReadCalendar?(input: { start: string; end: string }): Promise<JsonValue>;
  outlookCreateCalendarEvent?(input: { subject: string; start: string; end: string; attendees?: string[]; body?: string; approved?: boolean }): Promise<JsonValue>;
  outlookDeleteCalendarEvent?(eventId: string, approved?: boolean): Promise<JsonValue>;
  outlookReadContacts?(query?: string): Promise<JsonValue>;
  youtubeSearch?(query: string, limit?: number): Promise<JsonValue>;
  youtubeVideo?(videoId: string): Promise<JsonValue>;
  youtubeChannel?(channelId: string): Promise<JsonValue>;
  youtubeComments?(videoId: string, limit?: number): Promise<JsonValue>;
  telephoneCall?(to: string, twiml: string, approved?: boolean): Promise<JsonValue>;
  audit?(): JsonValue;
}

export interface KernelRuntimePorts {
  storage: ScceStorage;
  files: FileIngestPort;
  buildTest: BuildTestPort;
  connectors?: ConnectorPort;
  approvals?: ApprovalPort;
}

// Base (merge-base 5f5d1f2) was 21. Main independently bumped to 22 for
// sparse_ranking_comparisons (plan item 32); the codex branch
// independently bumped to 23 for its own new tables. Both are real,
// distinct structural additions from the same base, so the merged
// schema is one past the higher of the two, not either original value.
export const POSTGRES_SCHEMA_VERSION = 24;

export const POSTGRES_REQUIRED_TABLES = [
  "storage_meta",
  "events",
  "conversation_turns",
  "ingestion_checkpoints",
  "blobs",
  "sources",
  "source_versions",
  "evidence_spans",
  "evidence_anchor_index",
  "graph_nodes",
  "graph_edges",
  "graph_hyperedges",
  "quarantine_sources",
  "semantic_proofs",
  "construct_graphs",
  "validation_graphs",
  "emission_graphs",
  "program_builds",
  "capability_calls",
  "forecast_states",
  "forecast_envelopes",
  "learning_needs",
  "language_profiles",
  "language_profile_aliases",
  "ngram_observations",
  "ngram_models",
  "language_units",
  "language_patterns",
  "semantic_frames",
  "translation_alignments",
  "scce2_import_ledger",
  "brain_import_lifecycle",
  "correction_rules",
  "locale_bundles",
  "ppf_cache",
  "alpha_traces",
  "self_rewrite_episodes",
  "self_rewrite_patches",
  "workspaces",
  "workspace_source_files",
  "workspace_reports",
  "interaction_state_records",
  "dialogue_policy_decision_records",
  "conversation_outcome_records",
  "user_correction_records",
  "style_preference_snapshots",
  "response_candidate_records",
  "target_profile_patterns",
  "calibration_observations",
  "model_state",
  "benchmark_runs",
  "benchmark_cases",
  "policy_evaluations",
  "policy_genomes",
  "executive_episode",
  "executive_command",
  "executive_event",
  "sparse_ranking_models",
  "sparse_ranking_active_model",
  "sparse_ranking_comparisons",
  "segmentation_aggregates",
  "induced_language_models",
  "segmentation_population_models",
  "user_model_claims",
  "task_resumption_snapshots",
  "document_generation_sessions",
  "translation_seeds",
  "translation_constructions"
] as const;

export interface ScceKernelDeps {
  storage: ScceStorage;
  files: FileIngestPort;
  buildTest: BuildTestPort;
  governance?: import("./governance-observation.js").GovernanceProbe;
  connectors?: ConnectorPort;
  approvals?: ApprovalPort;
  clock?: import("./types.js").Clock;
  idFactory?: import("./ids.js").IdFactory;
  namespace?: string;
  runSeed?: string;
  deterministicReplay?: boolean;
  maxChunkBytes?: number;
  policy?: Partial<import("./types.js").PolicyProfile>;
  corpusRegistry?: readonly CorpusRegistryEntry[];
  /** Optional offline-trained, frozen relation-potential inference model. */
  relationPotentialModel?: RelationPotentialModel;
  /**
   * Optional, sealed evaluation condition applied at production turn
   * component boundaries. It is intentionally injected rather than read from
   * ambient process state so a turn cannot silently change conditions.
   */
  evaluationCondition?: EvaluationConditionConfig;
  evaluationRunId?: string;
  informationAccess?: import("./types.js").InformationAccessContext;
  sourceInformationLabel?: import("./types.js").InformationLabel;
  /**
   * Rollout boundary for functional-cognition-authorized capability
   * execution. FC/EFC are always computed and audited from real turn data
   * regardless of this flag. When false or absent (the safe default), the
   * gate handed to candidate admission, tool-cognition planning, and the
   * learning-acquisition gate has fc/efc forced false even if the computed
   * report says otherwise, so a real FC/EFC result cannot itself widen
   * execution authority until this is explicitly enabled (intended once a
   * durable executive dispatcher exists to receive authorized capability
   * execution).
   */
  functionalCognitionAuthorizeCapabilities?: boolean;
  /**
   * The wording realizer port: an optional, compact, corpus-trained
   * learned function that chooses WORDING for facts the evidence layer
   * already licensed. Its outputs enter the mouth's candidate pool
   * subject to every existing gate (admissibility, structural
   * completeness, argument integrity, entailment, citation binding); its
   * failure mode is awkward wording, never a new assertion.
   *
   * Admissibility conditions, stated here rather than in a separate
   * document so they cannot drift from the code they govern:
   *   1. Wording-only authority. Facts arrive already evidence-licensed;
   *      the realizer never contributes a claim, only phrasing.
   *   2. Corpus-bound training -- no knowledge from outside the corpus.
   *   3. Small and task-specific, not a general model.
   *   4. CPU-local inference; no hosted inference endpoint.
   *   5. Per-language cluster routing rather than one global model.
   *
   * Foundation-model and LLM-style runtimes remain banned as the seat of
   * knowledge or claim authority; this port must never be backed by one.
   * `tools/no-hidden-model-check.mjs` enforces that statically, failing
   * the build on the known hosted/local model packages and endpoints.
   *
   * Unset by default: absent a port, `generate()` in
   * language-memory-runtime remains the only realization engine.
   */
  wordingRealizer?: WordingRealizerPort;
  /** Adapter-provided text->visual-space query embedding (Phase 3); absent when the visual model is off. The kernel stays model-free. */
  visualQueryEmbedder?: (text: string) => Promise<readonly number[] | undefined>;
  /**
   * When true, the deferred (unauthorized) functional-cognition self-
   * projection runs in a short-lived child process with its own hard
   * `--max-old-space-size` heap cap (functional-cognition-offload.ts)
   * instead of this process's own heap -- real isolation against a slow
   * turn's `graph` growing the caller's memory unbounded. Real OS process
   * spawn cost, worth it for a long-lived server absorbing continuous real
   * traffic; not worth it (and actively harmful) for short-lived kernels
   * created rapid-fire, e.g. one per unit test -- hundreds of real child
   * process spawns within a single long-lived test-runner worker process
   * reproduced a genuine "JavaScript heap out of memory" crash across the
   * full suite. Defaults to false (the safe, cheap in-process computation,
   * same as before this flag existed) precisely so anything that builds
   * ScceKernelDeps by hand -- every test fixture -- gets that safe default
   * automatically; only the real adapter-backed runtime composition root
   * (adapters-node's runtime.ts, used by both the live server and the CLI)
   * opts in explicitly.
   */
  functionalCognitionOffloadProcess?: boolean;
  /**
   * Durable executive coordinator. When present, capability execution that
   * has a bounded dispatcher executor (currently: local build/test) is
   * routed through the executive state machine (prepare -> dispatch ->
   * receipt -> outcome) instead of invoked directly, so it is durably
   * attested with a goal/task/attempt/receipt/outcome/learning-record trail.
   * When absent, execution falls back to the pre-existing direct invocation
   * path unchanged -- this keeps the field optional so the dozens of
   * existing fixture-built ScceKernelDeps objects that predate the
   * dispatcher keep working without modification.
   */
  executive?: DurableExecutiveEpisode;
  /**
   * Durable FTRL model lifecycle store for shadow-mode retrieval reranking
   * (Part A finding 9, stage 2). When present, `runtime-graph-retrieval.ts`
   * computes an FTRL shadow ranking alongside BM25 for the active checkpoint
   * of `graph.node_rank.v1` and traces the comparison -- it never changes
   * which candidates a turn actually uses. When absent, no shadow ranking is
   * computed; this keeps every pre-existing `ScceKernelDeps` fixture valid.
   */
  sparseRankingModels?: import("./sparse-ranking-lifecycle.js").SparseRankingModelStore;
  /**
   * Durable, replayable log of real pairwise comparisons (Part A finding
   * 9, stage 6's prerequisite): separate from `sparseRankingModels`
   * because a held-out evaluation needs individual examples to replay
   * against a temporal split, not just the FTRL model's current online
   * weights. When absent, no comparison examples are recorded and
   * `evaluateFtrlHeldOut` has nothing to evaluate -- this keeps every
   * pre-existing `ScceKernelDeps` fixture valid.
   */
  sparseRankingComparisons?: import("./sparse-ranking-comparison-log.js").SparseRankingComparisonLogStore;
  /**
   * Explicit opt-in required before the ingestion runtime will recognize and
   * compile `scce.request_requirement_corpus.v1` source text into production
   * authority/response-form patterns. This corpus format is a hand-authored
   * English intent-routing bootstrap (see examples/bootstrap/request-requirements),
   * not organically observed language evidence, and its categories/phrasings/
   * layouts are manually supplied -- the opposite of "hardcode the learner,
   * not English." When false or absent (the safe default), matching source
   * text is ingested as ordinary language/document evidence and the corpus's
   * schema is never inspected, so it cannot silently become production
   * request-routing control just by being pointed at generic ingestion.
   */
  allowSyntheticRequestRequirementBootstrap?: boolean;
}

export interface ApprovalPort {
  isApproved(input: { capabilityId: string; input: JsonValue }): boolean;
  observePending(plan: CapabilityPlan): Promise<void> | void;
  policyPatch?(): Partial<import("./types.js").PolicyProfile>;
}

export type ReplayProjection = {
  target: InspectionTarget;
  events: ScceEvent[];
  value: JsonValue;
};

export type BenchmarkExecutor = (input: BenchmarkInput) => Promise<BenchmarkResult>;
export type EventLookup = (eventId: EventId) => Promise<ScceEvent | null>;
