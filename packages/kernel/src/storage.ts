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
  InspectionTarget,
  JsonValue,
  LanguageProfile,
  ModelState,
  ProofId,
  RunId,
  ScceEvent,
  SemanticProof,
  SourceId,
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
}

export interface NgramModelRecord {
  id: string;
  streamId: string;
  languageHint: string;
  maxOrder: number;
  discount: number;
  modelJson: JsonValue;
  updatedAt: number;
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
}

export interface LanguagePatternRecord {
  id: string;
  profileId: string;
  patternKind: "segmentation" | "morphology" | "syntax" | "cadence" | "semantic_role";
  support: number;
  entropy: number;
  patternJson: JsonValue;
  evidenceIds: EvidenceId[];
  updatedAt: number;
}

export interface SemanticFrameRecord {
  id: string;
  frameJson: JsonValue;
  embedding: number[];
  evidenceIds: EvidenceId[];
  alpha: number;
  createdAt: number;
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

export interface EvidenceStore {
  putSourceVersion(source: SourceVersion): Promise<void>;
  putEvidenceSpan(span: EvidenceSpan): Promise<void>;
  putEvidenceSpans?(spans: readonly EvidenceSpan[]): Promise<void>;
  promoteEvidence(ids: EvidenceId[], reason: string): Promise<number>;
  getEvidence(id: EvidenceId): Promise<EvidenceSpan | null>;
  getEvidenceBatch(ids: EvidenceId[]): Promise<EvidenceSpan[]>;
  searchEvidence(query: EvidenceQuery): Promise<EvidenceSearchResult[]>;
  sourceVersionsForEvidence(ids: EvidenceId[]): Promise<SourceVersion[]>;
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
  listNgramModels(query?: { streamId?: string; languageHint?: string; profileIds?: readonly string[]; sourceVersionIds?: readonly string[]; sourceSystem?: string; limit?: number }): Promise<NgramModelRecord[]>;
  listNgramObservations(query?: { streamId?: string; languageHint?: string; profileIds?: readonly string[]; sourceVersionIds?: readonly string[]; sourceSystem?: string; limit?: number }): Promise<NgramObservation[]>;
  listLanguageUnits(query?: { profileId?: string; profileIds?: readonly string[]; script?: string; sourceSystem?: string; limit?: number }): Promise<LanguageUnitRecord[]>;
  listLanguagePatterns(query?: { profileId?: string; profileIds?: readonly string[]; sourceSystem?: string; limit?: number }): Promise<LanguagePatternRecord[]>;
  listSemanticFrames(query?: { profileIds?: readonly string[]; sourceVersionIds?: readonly string[]; sourceSystem?: string; surface?: string; limit?: number }): Promise<SemanticFrameRecord[]>;
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
  localization: LocalizationStore;
  flowCache: FlowCacheStore;
  selfRewrite: SelfRewriteStore;
  workspace: WorkspaceStore;
  dialogueMemory: DialogueMemoryStore;
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
  outlookReadCalendar?(input: { start: string; end: string }): Promise<JsonValue>;
  outlookCreateCalendarEvent?(input: { subject: string; start: string; end: string; attendees?: string[]; body?: string; approved?: boolean }): Promise<JsonValue>;
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

export const POSTGRES_SCHEMA_VERSION = 12;

export const POSTGRES_REQUIRED_TABLES = [
  "storage_meta",
  "events",
  "conversation_turns",
  "ingestion_checkpoints",
  "blobs",
  "sources",
  "source_versions",
  "evidence_spans",
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
  "benchmark_cases"
] as const;

export interface ScceKernelDeps {
  storage: ScceStorage;
  files: FileIngestPort;
  buildTest: BuildTestPort;
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
