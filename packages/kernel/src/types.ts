export type Brand<T, Name extends string> = T & { readonly __brand: Name };

export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };

export type EpisodeId = Brand<string, "EpisodeId">;
export type EventId = Brand<string, "EventId">;
export type EventTypeId = Brand<string, "EventTypeId">;
export type SourceId = Brand<string, "SourceId">;
export type SourceVersionId = Brand<string, "SourceVersionId">;
export type EvidenceId = Brand<string, "EvidenceId">;
export type ChunkId = Brand<string, "ChunkId">;
export type ContentHash = Brand<string, "ContentHash">;
export type FileContentId = Brand<string, "FileContentId">;
export type RawSpanId = Brand<string, "RawSpanId">;
export type ArtifactContentId = Brand<string, "ArtifactContentId">;
export type ToolOutputContentId = Brand<string, "ToolOutputContentId">;
export type TranscriptVersionId = Brand<string, "TranscriptVersionId">;
export type NodeId = Brand<string, "NodeId">;
export type EdgeId = Brand<string, "EdgeId">;
export type HyperedgeId = Brand<string, "HyperedgeId">;
export type RelationId = Brand<string, "RelationId">;
export type DimensionId = Brand<string, "DimensionId">;
export type PatternId = Brand<string, "PatternId">;
export type ShapeId = Brand<string, "ShapeId">;
export type ClaimId = Brand<string, "ClaimId">;
export type ProofId = Brand<string, "ProofId">;
export type ConstructId = Brand<string, "ConstructId">;
export type ValidationId = Brand<string, "ValidationId">;
export type EmissionId = Brand<string, "EmissionId">;
export type ArtifactId = Brand<string, "ArtifactId">;
export type RunId = Brand<string, "RunId">;
export type CapabilityCallId = Brand<string, "CapabilityCallId">;
export type ForecastStateId = Brand<string, "ForecastStateId">;
export type ForecastEnvelopeId = Brand<string, "ForecastEnvelopeId">;

export type EpistemicForce = "proved" | "observed" | "inferred" | "conjectured" | "invented" | "unknown";
export type RequestedAuthority = "factual" | "reasoned" | "creative" | "translation" | "program" | "action";
export type TruthState =
  | "truth.certified"
  | "truth.contradicted"
  | "truth.source_bound_only"
  | "truth.unsupported_prior_only"
  | "truth.insufficient_evidence"
  | "truth.ambiguous";
export type AssistantForceClass =
  | "certified_fact"
  | "source_grounded_answer"
  | "learned_corpus_answer"
  | "reasoned_answer"
  | "translation_answer"
  | "creative_answer"
  | "action_result"
  | "conjecture"
  | "insufficient_support";

export interface Clock {
  now(): number;
}

export interface Hasher {
  digestHex(input: string | Uint8Array): string;
}

export interface ScceEvent {
  id: EventId;
  episodeId: EpisodeId;
  typeId: EventTypeId;
  t: number;
  payload: JsonValue;
  parents: EventId[];
  hash: string;
}

export const EVENT_TYPES = [
  "OwnerAsked",
  "UserCorrected",
  "SourceObserved",
  "SourceVersionObserved",
  "SourceQuarantined",
  "SourcePromoted",
  "GraphUpdated",
  "LanguagePatternLearned",
  "SymbolPatternLearned",
  "FieldSeeded",
  "FieldActivated",
  "FieldPropagated",
  "PPFComputed",
  "CausalGraphDiscovered",
  "SemanticEntailmentChecked",
  "EvidenceLinked",
  "CandidateGenerated",
  "CandidateRejected",
  "CandidateSelected",
  "MouthSpoken",
  "CorrectionApplied",
  "ConstructGraphBuilt",
  "ValidationGraphBuilt",
  "EmissionGraphBuilt",
  "CapabilityPlanned",
  "CapabilityInvoked",
  "CapabilitySucceeded",
  "CapabilityFailed",
  "ActionPrepared",
  "ActionCommitted",
  "ActionRolledBack",
  "ProgramGraphBuilt",
  "FileGraphBuilt",
  "SourceEmitted",
  "BuildExecuted",
  "TestExecuted",
  "ForecastComputed",
  "LearningNeedDetected",
  "LearningPlanBuilt",
  "LearningPromoted",
  "SelfModelProjected",
  "FailureObserved",
  "EpisodeClosed"
] as const;

export type KnownEventType = (typeof EVENT_TYPES)[number];

export interface SourceVersion {
  sourceId: SourceId;
  sourceVersionId: SourceVersionId;
  namespace: string;
  canonicalUri: string;
  contentHash: ContentHash;
  mediaType: string;
  observedAt: number;
  byteLength: number;
  trust: number;
  metadata: JsonValue;
}

export interface EvidenceSpan {
  id: EvidenceId;
  sourceId: SourceId;
  sourceVersionId: SourceVersionId;
  chunkId: ChunkId;
  contentHash: ContentHash;
  mediaType: string;
  byteStart: number;
  byteEnd: number;
  charStart: number;
  charEnd: number;
  text: string;
  textPreview: string;
  languageHints: JsonValue;
  scriptHints: JsonValue;
  trustVector: JsonValue;
  provenance: JsonValue;
  features: string[];
  status: "quarantined" | "promoted";
  alpha: number;
  observedAt: number;
}

export interface GraphNode {
  id: NodeId;
  typeId: DimensionId;
  representation: JsonValue;
  alpha: number;
  evidenceIds: EvidenceId[];
  features: string[];
  createdAt: number;
  updatedAt: number;
  metadata: JsonValue;
}

export interface GraphEdge {
  id: EdgeId;
  source: NodeId;
  target: NodeId;
  relationId: RelationId;
  alpha: number;
  weight: number;
  temporalScope: { validFrom: number; validTo?: number };
  evidenceIds: EvidenceId[];
  createdAt: number;
  updatedAt: number;
  metadata: JsonValue;
}

export interface Hyperedge {
  id: HyperedgeId;
  relationId: RelationId;
  memberNodeIds: NodeId[];
  weightVector: JsonValue;
  temporalScope: JsonValue;
  provenanceRefs: string[];
  createdAt: number;
  updatedAt: number;
}

export interface GraphSnapshot {
  nodes: GraphNode[];
  edges: GraphEdge[];
  hyperedges: Hyperedge[];
}

export interface GraphSlice extends GraphSnapshot {
  bounded: true;
  query: GraphSliceQuery;
}

export interface GraphSliceQuery {
  seedNodeIds?: NodeId[];
  evidenceIds?: EvidenceId[];
  features?: string[];
  topicTerms?: string[];
  nodeTypes?: string[];
  radius?: number;
  limitNodes?: number;
  limitEdges?: number;
  allowLatestFallback?: boolean;
}

export interface TemporalGraphQuery extends GraphSliceQuery {
  at?: number;
  since?: number;
  until?: number;
}

export interface TemporalGraph extends GraphSlice {
  temporalQuery: TemporalGraphQuery;
}

export interface AlphaFactors {
  compatibility: number;
  provenance: number;
  temporalFit: number;
  modalityAgreement: number;
  recurrence: number;
  utility: number;
  contradictionPenalty: number;
}

export type AlphaRelationState = "sketch" | "virtual" | "visible" | "bonded" | "structural";

export interface AlphaRelation {
  id: string;
  source: string;
  target: string;
  relationId: string;
  factors: AlphaFactors;
  strength: number;
  state: AlphaRelationState;
  visible: boolean;
  bonded: boolean;
  evidenceIds: EvidenceId[];
}

export interface MatrixSnapshot {
  nodes: string[];
  values: number[][];
}

export interface AlphaNormalizationDiagnostics {
  schema: "scce.alpha_normalization.v1";
  mode: "empirical_quantiles" | "configured" | "degenerate_sample" | "empty_sample";
  method: "hyndman_fan_type_7" | "configured_legacy_threshold_transform" | "degenerate_anchor_interpolation" | "neutral_empty_sample_fallback";
  configuredAlpha: number | null;
  quantileProbabilities: readonly [number, number, number, number] | null;
  sample: {
    count: number;
    uniqueCount: number;
    minimum: number | null;
    median: number | null;
    maximum: number | null;
  };
}

export interface AlphaTrace {
  alpha: number;
  thresholds: { virtual: number; visible: number; bonded: number; structural: number };
  /** Present on traces produced by the runtime; optional for persisted v0 traces. */
  normalization?: AlphaNormalizationDiagnostics;
  relations: AlphaRelation[];
  adjacency: MatrixSnapshot;
  laplacian: MatrixSnapshot;
  normalizedLaplacian: MatrixSnapshot;
  surfaces: {
    pressure: number;
    drift: number;
    contradiction: number;
    bond: number;
    risk: number;
    actionability: number;
  };
  contradictionMass: number;
  bondedLeakage: number;
}

export interface FieldState {
  requestFeatures: string[];
  seeds: Array<{ nodeId: NodeId; feature: string; weight: number }>;
  active: Array<{ nodeId: NodeId; activation: number }>;
  ppf: Array<{ nodeId: NodeId; mass: number }>;
  ppfDiagnostics?: JsonValue;
  alphaTrace: AlphaTrace;
  greenPotential?: JsonValue;
  causalMass: Array<{ nodeId: NodeId; mass: number; reason: string }>;
}

export interface Claim {
  id: ClaimId;
  text: string;
  normalized: string;
  features: string[];
  polarity: number;
}

export type SemanticEntailmentVerdict = "entailed" | "contradicted" | "unknown" | "underdetermined";
export type SemanticObligationKind = "entity" | "predicate" | "role" | "quantity" | "temporal" | "symbol" | "negation" | "source_version" | "transform";
export type SemanticObligationStatus = "satisfied" | "contradicted" | "missing" | "underdetermined";

export interface SemanticObligationRecord {
  id: string;
  kind: SemanticObligationKind;
  status: SemanticObligationStatus;
  claimText: string;
  evidenceIds: EvidenceId[];
  sourceVersionIds: SourceVersionId[];
  support: number;
  contradiction: number;
  required: boolean;
  reason: string;
  metadata: JsonValue;
}

export interface SemanticEntailmentScores {
  structuralCoverage: number;
  roleCoverage: number;
  relationCompatibility: number;
  transformationSupport: number;
  causalMass: number;
  faithfulnessLCB: number;
  contradiction: number;
  stability: number;
}

export interface SemanticProofMapping {
  id: string;
  obligationId: string;
  kind: SemanticObligationKind;
  status: SemanticObligationStatus;
  claimText: string;
  relation: "exact" | "constraint" | "role_path" | "transform" | "candidate" | "missing";
  evidenceIds: EvidenceId[];
  sourceVersionIds: SourceVersionId[];
  support: number;
  contradiction: number;
  audit: JsonValue;
}

export interface SemanticTransformTrace {
  id: string;
  transformKind: "identity" | "constraint_preservation" | "role_path" | "supported_paraphrase" | "unresolved";
  source: string;
  target?: string;
  registered: boolean;
  support: number;
  evidenceIds: EvidenceId[];
  sourceVersionIds: SourceVersionId[];
  audit: JsonValue;
}

export interface SemanticCounterexampleTrace {
  id: string;
  kind: SemanticObligationKind | "alpha_contradiction";
  claimText: string;
  evidenceIds: EvidenceId[];
  sourceVersionIds: SourceVersionId[];
  contradiction: number;
  reason: string;
  audit: JsonValue;
}

export interface SemanticMissingObligationTrace {
  id: string;
  obligationId: string;
  kind: SemanticObligationKind;
  claimText: string;
  required: boolean;
  reason: string;
  evidenceIds: EvidenceId[];
  sourceVersionIds: SourceVersionId[];
  audit: JsonValue;
}

export interface SemanticEntailmentConfidence {
  verdict: SemanticEntailmentVerdict;
  support: number;
  contradiction: number;
  faithfulnessLcb: number;
  supportingEvidence: number;
  sourceVersions: string[];
  structuralCoverage: number;
  roleCoverage: number;
  relationCompatibility: number;
  transformationSupport: number;
  causalMass: number;
  stability: number;
  satisfiedObligations: number;
  requiredObligations: number;
}

export interface ProofGraphNode {
  id: string;
  kind: "claim" | "evidence" | "transform" | "field" | "contradiction" | "boundary" | "obligation" | "mapping" | "counterexample";
  label: string;
  metadata: JsonValue;
}

export interface ProofGraphEdge {
  source: string;
  target: string;
  relation: "supports" | "contradicts" | "transforms" | "activates" | "bounds" | "screens" | "requires" | "satisfies" | "missing" | "maps_to";
  weight: number;
  evidenceIds: EvidenceId[];
}

export interface SemanticProof {
  id: ProofId;
  claimId: ClaimId;
  verdict: EpistemicForce;
  confidence: JsonValue;
  proofGraph: { nodes: ProofGraphNode[]; edges: ProofGraphEdge[] };
  evidenceIds: EvidenceId[];
  transformIds: string[];
  scores: JsonValue;
  validatorVersion: string;
  createdAt: number;
}

export interface SemanticEntailmentResult {
  claim: Claim;
  verdict: SemanticEntailmentVerdict;
  semanticVerdict: SemanticEntailmentVerdict;
  truthState?: TruthState;
  force: EpistemicForce;
  support: number;
  contradiction: number;
  faithfulnessLcb: number;
  confidence: SemanticEntailmentConfidence;
  scores: SemanticEntailmentScores;
  obligations: SemanticObligationRecord[];
  mappings: SemanticProofMapping[];
  transforms: SemanticTransformTrace[];
  counterexamples: SemanticCounterexampleTrace[];
  missing: SemanticMissingObligationTrace[];
  proof: SemanticProof;
  evidenceIds: EvidenceId[];
  boundaries: string[];
}

export interface FileArtifact {
  artifactId: ArtifactId;
  path: string;
  mediaType: string;
  content: string;
  contentHash: ContentHash;
  role: "source" | "test" | "config" | "doc";
}

export interface ProgramGraph {
  id: string;
  language: string;
  packageManager: string;
  entrypoint: string;
  nodes: Array<{ id: string; kind: string; label: string; metadata: JsonValue }>;
  edges: Array<{ source: string; target: string; relation: string; weight: number }>;
  files: FileArtifact[];
  build: { command: string; args: string[]; cwd: string };
  test: { command: string; args: string[]; cwd: string };
  hydration?: ProgramHydrationContract;
}

export interface ProgramConstructIntent {
  artifactKindIds: string[];
  capabilityIds: string[];
  languageId?: string;
  runtimeTargetId?: string;
  packageManagerId?: string;
  entrypointPath?: string;
  inputMediaTypes?: string[];
  outputMediaTypes?: string[];
  constraints?: string[];
  provenanceEvidenceIds?: string[];
  metadata?: JsonValue;
}

export interface ProgramGraphRecord {
  programId: string;
  languageId: string;
  packageManagerId: string;
  entrypointPath: string;
  buildCommand: { command: string; args: string[]; cwd: string };
  testCommand: { command: string; args: string[]; cwd: string };
  nodeCount: number;
  edgeCount: number;
  fileCount: number;
  provenanceEvidenceIds: string[];
}

export interface ProgramFileRecord {
  programId: string;
  artifactId: ArtifactId;
  path: string;
  role: FileArtifact["role"];
  mediaType: string;
  contentHash: ContentHash;
  byteLength: number;
  imports: string[];
  exports: string[];
  symbols: string[];
  entrypoint: boolean;
  provenanceEvidenceIds: string[];
}

export interface ProgramSymbolRecord {
  programId: string;
  symbolId: string;
  filePath: string;
  symbolKind: string;
  exportKind: string;
  provenanceEvidenceIds: string[];
}

export interface ProgramDependencyRecord {
  programId: string;
  packageName: string;
  dependencyKind: string;
  importedBy: string[];
  evidenceIds: string[];
  missing: boolean;
  risk: number;
}

export interface ProgramValidationRecord {
  programId: string;
  validationId: string;
  command: { command: string; args: string[]; cwd: string };
  commandSource: string;
  expectedFiles: string[];
  staticChecks: string[];
  riskIds: string[];
  missingDependencies: string[];
  evidenceIds: string[];
}

export interface ArtifactEmissionRecord {
  programId: string;
  artifactId: ArtifactId;
  filePath: string;
  emissionKind: string;
  contentHash: ContentHash;
  sourcePlanId: string;
  provenanceEvidenceIds: string[];
}

export interface ProgramHydrationContract {
  schema: "scce.program.hydration.v1";
  program: ProgramGraphRecord;
  files: ProgramFileRecord[];
  symbols: ProgramSymbolRecord[];
  dependencies: ProgramDependencyRecord[];
  validations: ProgramValidationRecord[];
  emissions: ArtifactEmissionRecord[];
  diagnostics: string[];
  valid: boolean;
}

export interface ConstructGraph {
  id: ConstructId;
  episodeId: EpisodeId;
  forceVector: JsonValue;
  nodes: Array<{ id: string; kind: string; label: string; metadata: JsonValue }>;
  edges: Array<{ source: string; target: string; relation: string; weight: number }>;
  program?: ProgramGraph;
  artifacts: FileArtifact[];
}

export interface ValidationGraph {
  id: ValidationId;
  constructId: ConstructId;
  checks: Array<{ id: string; status: "passed" | "failed" | "warning"; score: number; message: string; evidenceIds: EvidenceId[] }>;
  pca?: JsonValue;
  passed: boolean;
}

export interface EmissionGraph {
  id: EmissionId;
  constructId: ConstructId;
  answer: string;
  epistemicForce: EpistemicForce;
  assistantForce?: AssistantForceClass;
  artifacts: FileArtifact[];
  evidenceIds: EvidenceId[];
  proofId: ProofId;
  pca?: JsonValue;
}

export interface Capability {
  id: string;
  label: string;
  kind: "filesystem" | "process" | "network" | "outlook" | "youtube" | "telephone";
  mutates: boolean;
  risk: number;
  requiresApproval: boolean;
  configured: boolean;
  metadata: JsonValue;
}

export interface CapabilityPlan {
  id: CapabilityCallId;
  episodeId: EpisodeId;
  capabilityId: string;
  phase: "read" | "prepare" | "commit";
  status: "planned" | "invoked" | "succeeded" | "failed" | "rolled_back";
  input: JsonValue;
  result?: JsonValue;
  riskVector: JsonValue;
  permission: JsonValue;
  createdAt: number;
  completedAt?: number;
}

export interface BuildTestResult {
  build: { code: number | null; stdout: string; stderr: string; durationMs: number };
  test: { code: number | null; stdout: string; stderr: string; durationMs: number };
  repairAttempted: boolean;
  repairApplied: boolean;
  passed: boolean;
  artifacts: FileArtifact[];
}

export interface ForecastState {
  id: ForecastStateId;
  episodeId?: EpisodeId;
  t: number;
  stateVector: number[];
  alphaSurface: AlphaTrace["surfaces"];
  spectrum: MatrixSnapshot;
}

export interface ForecastEnvelope {
  id: ForecastEnvelopeId;
  sourceStateId: ForecastStateId;
  horizon: number;
  mean: number[];
  covariance: number[][];
  interval: Array<{ mean: number; low: number; high: number }>;
  audit?: JsonValue;
  createdAt: number;
}

export interface LanguageProfile {
  id: string;
  sourceVersionId: SourceVersionId;
  discoveredNames?: Array<{ surface: string; evidenceRefs: string[]; confidence: number }>;
  scripts: Array<{ script: string; mass: number }>;
  symbolShapes: Array<{ shape: string; count: number }>;
  charNgrams: Array<{ ngram: string; count: number }>;
  direction: "ltr" | "rtl" | "mixed" | "unknown";
  entropy: number;
  competenceVector?: LanguageCompetenceVector;
  createdAt: number;
  updatedAt?: number;
  kneserNey?: JsonValue;
  ngramProfile?: JsonValue;
}

export interface LanguageCompetenceVector {
  scriptRecognition: number;
  segmentationQuality: number;
  lexicalCoverage: number;
  phraseFluency: number;
  syntacticCoverage: number;
  semanticFrameCoverage: number;
  translationAlignment: number;
  entailmentReliability: number;
  generationReliability: number;
  correctionStability: number;
  localizationReliability: number;
}

/**
 * Historical persisted shape. Despite the name, current records are weighted
 * feature-frequency sketches rather than fitted latent-variable concepts.
 * @deprecated Use WeightedFeatureSketch for newly produced records.
 */
export interface LatentConcept {
  id: string;
  features: string[];
  basis: number[];
  varianceShare: number;
}

/**
 * Bounded weighted feature-frequency sketch with a deterministic hash
 * projection. It is not a fitted latent-variable model or an eigenspace.
 */
export interface WeightedFeatureSketch extends LatentConcept {
  projection: number[];
  supportShare: number;
  projectionVariance: number;
  method: "weighted_feature_frequency_hash_projection.v1";
  /** @deprecated Persistence compatibility alias for projection. */
  basis: number[];
  /** @deprecated Persistence compatibility alias for supportShare; not explained variance. */
  varianceShare: number;
}

export interface ModelState {
  languageProfiles: LanguageProfile[];
  /** @deprecated Historical persistence key; values are WeightedFeatureSketch records. */
  latentConcepts: LatentConcept[];
  learnedProgramPatterns: JsonValue[];
  learningGoals: string[];
  trainingSteps: number;
}

export interface PolicyProfile {
  allowMutation: boolean;
  requireTwoPhaseCommit: boolean;
  dryRunByDefault: boolean;
  maxNetworkRequests: number;
  maxToolCalls: number;
  maxSpendCents: number;
  alphaRiskCeiling: number;
  encryptSecretsAtRest: boolean;
}

export interface FunctionalSelfState {
  currentGoals: string[];
  memoryState: { nodes: number; edges: number; evidence: number; sourceVersions: number; proofs: number };
  knownLimits: string[];
  uncertainty: number;
  capabilities: string[];
  activePolicies: string[];
  recentFailures: string[];
  commitments: string[];
  permissions: string[];
  learningGoals: string[];
  fcs: number;
  dci: number;
}

export type RuntimeScoreKind =
  | "feature"
  | "guard"
  | "fallback"
  | "estimator"
  | "calibrated_probability"
  | "algebraic_invariant"
  | "provisional_heuristic";

export interface RuntimeScoreTrace {
  id: string;
  kind: RuntimeScoreKind;
  value: number;
  range: readonly [number, number];
  meaning: string;
  inputs: readonly string[];
  provenance: readonly string[];
  calibrated: boolean;
  calibrationId?: string;
  failureModes: readonly string[];
}

export type RuntimeEvidenceForce = "direct" | "inferred" | "prior" | "analogy" | "conjecture" | "creative" | "unknown";
export type RuntimeCalibrationStatus = "calibrated" | "partial" | "uncalibrated";

export interface RuntimeTruthState {
  symbolicState?: TruthState;
  beliefLower: number;
  plausibilityUpper: number;
  supportMass: number;
  contradictionMass: number;
  uncertaintyMass: number;
  validityInterval: { start: number | null; end: number | null } | null;
  evidenceForce: RuntimeEvidenceForce;
  freshness: number;
  sourceDiversity: number;
}

export interface RuntimeAnswerBasis {
  schema: "scce.runtime.answer_basis.v1";
  basisClassId: string;
  certificationId: string;
  evidenceForce: RuntimeEvidenceForce;
  truthState?: TruthState;
  supportMass: number;
  contradictionMass: number;
  uncertaintyMass: number;
  sourceEvidenceCount: number;
  certifiesSourceClaim: boolean;
  fakeEvidenceForbidden: true;
  reasonIds: string[];
}

export interface RuntimeGuardFlags {
  requireEvidence: boolean;
  blockCertifiedFact: boolean;
  allowInference: boolean;
  allowCreative: boolean;
  exposeContradiction: boolean;
  sourceBacked: boolean;
  missingEvidence: boolean;
  contradictionPresent: boolean;
  preservationChecked: boolean;
  unsupportedContentBlocked: boolean;
}

export interface RuntimeCalibrationSummary {
  taskClass: string;
  rawScore: number;
  calibrationStatus: RuntimeCalibrationStatus;
  calibrationId?: string;
  reliabilityBucket?: string;
}

export type RetrievalRole =
  | "support"
  | "contradiction"
  | "definition"
  | "example"
  | "counterexample"
  | "source_context"
  | "code_symbol"
  | "test_evidence";

export interface RuntimeRetrievalRoleTrace {
  evidenceId?: EvidenceId;
  nodeId?: NodeId;
  role: RetrievalRole;
  score: number;
  scoreTraces: RuntimeScoreTrace[];
  reason: string;
}

export interface TurnResult {
  episodeId: EpisodeId;
  answer: string;
  epistemicForce: EpistemicForce;
  assistantForce?: AssistantForceClass;
  requestedAuthority?: RequestedAuthority;
  requestedAuthorityDecision?: JsonValue;
  requirementField?: JsonValue;
  operatorActivations?: JsonValue;
  cognitiveProposals?: JsonValue;
  answerRevision?: JsonValue;
  evidence: EvidenceSpan[];
  field: FieldState;
  entailment: SemanticEntailmentResult;
  constructGraph: ConstructGraph;
  validationGraph: ValidationGraph;
  emissionGraph: EmissionGraph;
  forecast: ForecastEnvelope;
  learningNeeds: string[];
  candidateField?: JsonValue;
  judge?: JsonValue;
  actionGraph?: JsonValue;
  selfState?: FunctionalSelfState;
  selfDistillation?: JsonValue;
  functionalConsciousness?: JsonValue;
  functionalCognition?: JsonValue;
  runtimeCoherence?: JsonValue;
  discourseObject?: JsonValue;
  proofCarryingAnswer?: JsonValue;
  pface?: JsonValue;
  languageAcquisition?: JsonValue;
  translation?: JsonValue;
  mouth?: JsonValue;
  corrections?: JsonValue;
  brain?: JsonValue;
  learningLoop?: JsonValue;
  evaluationTrace?: JsonValue;
  timing?: TurnTiming;
  buildTest?: BuildTestResult;
  scoreTraces: RuntimeScoreTrace[];
  calibrationStatus: RuntimeCalibrationStatus;
  calibration?: RuntimeCalibrationSummary;
  truthState: RuntimeTruthState;
  answerBasis?: RuntimeAnswerBasis;
  evidenceForce: RuntimeEvidenceForce;
  guardFlags: RuntimeGuardFlags;
  retrievalRoles?: RuntimeRetrievalRoleTrace[];
  events: ScceEvent[];
}

export interface TurnTiming {
  schema: "scce.turn_timing.v1";
  totalMs: number;
  seedMs?: number;
  graphSliceMs?: number;
  proofMs?: number;
  candidateMs?: number;
  planningMs?: number;
  mouthMs?: number;
  validationMs?: number;
  forecastMs?: number;
  maintenanceMs?: number;
  persistenceMode: "foreground" | "deferred";
  budgetsMs: {
    graphSlice: number;
    proof: number;
    mouth: number;
    total: number;
  };
  budgetExceeded: string[];
}

export interface IngestInput {
  path?: string;
  uri?: string;
  namespace?: string;
  content?: string | Uint8Array;
  mediaType?: string;
  metadata?: JsonValue;
}

export interface IngestResult {
  episodeId: EpisodeId;
  files: number;
  sources: number;
  evidence: number;
  graphNodes: number;
  graphEdges: number;
  languageProfiles: number;
  typedObservations: Record<string, number>;
  observationRoutes: Record<string, number>;
  skipped: Array<{ path: string; reason: string }>;
  events: ScceEvent[];
}

export interface TrainInput {
  config: {
    learningGoals?: string[];
    programPatterns?: JsonValue[];
    promotion?: { minTrust?: number; namespaces?: string[] };
    policy?: Partial<PolicyProfile>;
    metadata?: JsonValue;
  };
}

export interface TrainResult {
  episodeId: EpisodeId;
  promotedEvidence: number;
  /** Honest name for the records produced by the feature-frequency learner. */
  featureSketches?: number;
  /** @deprecated Compatibility count; identical to featureSketches. */
  latentConcepts: number;
  languageProfiles: number;
  learningGoals: string[];
  events: ScceEvent[];
}

export type InspectionTarget =
  | "last"
  | "graph"
  | "ingestion"
  | "codebase"
  | "model"
  | "self"
  | "snapshot"
  | "proofs"
  | "brain"
  | "language"
  | "graph-priors"
  | "language-memory"
  | "localization"
  | "corrections"
  | "math-spine"
  | { kind: "episode"; episodeId: EpisodeId }
  | { kind: "brain-import"; importRunId: string }
  | { kind: "event"; eventId: EventId };

export interface InspectionResult {
  kind: string;
  value: JsonValue;
}

export interface EpisodeReplay {
  episodeId: EpisodeId;
  events: ScceEvent[];
  ledgerHash: string;
  selectedCandidate?: JsonValue;
  entailment?: JsonValue;
  constructGraph?: JsonValue;
  validationGraph?: JsonValue;
  emissionGraph?: JsonValue;
  mouth?: JsonValue;
  corrections?: JsonValue;
  finalOutput?: string;
}

export interface BenchmarkTask {
  id: string;
  input: string;
  caseType?: "SmokeCase" | "FactualEvidenceCase" | "ContradictionCase" | "SemanticEntailmentCase" | "TranslationCase" | "ProgramArtifactCase" | "LearningAcquisitionCase";
  criteria?: JsonValue;
  expectedEvidence?: string[];
  expectedArtifacts?: string[];
}

export interface BenchmarkInput {
  config?: { tasks?: BenchmarkTask[]; metadata?: JsonValue };
  tasks?: BenchmarkTask[];
}

export interface BenchmarkResult {
  runId: RunId;
  tasks: Array<{
    id: string;
    score: number;
    correctness: number;
    evidenceEntailment: number;
    toolSuccess: number;
    codeBuildTest: number;
    learningImprovement: number;
    multilingual: number;
    efficiency: number;
    auditability: number;
    notes: string[];
  }>;
  score: number;
  events: ScceEvent[];
  note: string;
}

export interface OwnerInput {
  text: string;
  metadata?: JsonValue;
  requestedAuthority?: RequestedAuthority;
}

export interface RuntimeWarmupInput {
  graph?: boolean;
  language?: boolean;
  brain?: boolean;
  profile?: boolean;
  corrections?: boolean;
  languageLimit?: number;
}

export interface RuntimeWarmupResult {
  schema: "scce.runtime_warmup.v1";
  totalMs: number;
  graph?: {
    loaded: boolean;
    nodes: number;
    edges: number;
    hyperedges: number;
    evidence: number;
    bytes: number;
  };
  language?: {
    loaded: boolean;
    models: number;
    observations: number;
    units: number;
    patterns: number;
    semanticFrames: number;
  };
  brain?: {
    loaded: boolean;
  };
  profile?: {
    loaded: boolean;
  };
  corrections?: {
    loaded: boolean;
    rules: number;
  };
  failures: string[];
}

export interface ScceKernel {
  warmup(input?: RuntimeWarmupInput): Promise<RuntimeWarmupResult>;
  turn(input: OwnerInput): Promise<TurnResult>;
  ingest(input: IngestInput): Promise<IngestResult>;
  train(input: TrainInput): Promise<TrainResult>;
  replay(episodeId: EpisodeId): Promise<EpisodeReplay>;
  inspect(target: InspectionTarget): Promise<InspectionResult>;
  benchmark(input: BenchmarkInput): Promise<BenchmarkResult>;
}
