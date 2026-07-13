import type {
  BenchmarkInput,
  BenchmarkResult,
  BuildTestResult,
  CapabilityPlan,
  ConstructGraph,
  ContentHash,
  EpistemicForce,
  EpisodeId,
  EvidenceSpan,
  GraphEdge,
  GraphNode,
  GraphSlice,
  GraphSnapshot,
  IngestInput,
  IngestResult,
  InspectionResult,
  InspectionTarget,
  JsonValue,
  LanguageProfile,
  OwnerInput,
  PolicyProfile,
  RequestedAuthority,
  RuntimeWarmupInput,
  RuntimeWarmupResult,
  ScceEvent,
  ScceKernel,
  SourceVersion,
  TrainInput,
  TrainResult,
  TurnResult
} from "./types.js";
import type { IngestedSourceFile, IngestionCheckpoint, ScceKernelDeps, SemanticFrameRecord } from "./storage.js";
import { createClock, createHasher, featureSet, mean, redactSecrets, sourceTextSurface, toJsonValue, weightedJaccard } from "./primitives.js";
import { createIdFactory, type IdFactory } from "./ids.js";
import { createEventFactory, extractReplayValue } from "./events.js";
import { createEvidenceExtractor } from "./evidence.js";
import { createSourceGraphBuilder } from "./graphbuild.js";
import { createSourceAdmissionController } from "./admission.js";
import { createLanguageAcquisitionEngine } from "./language.js";
import { createMultilingualAcquisitionEngine } from "./multilingual-acquisition.js";
import { createLanguageMemoryRuntime } from "./language-memory-runtime.js";
import { createTranslationEngine, type TranslationPlan } from "./translation.js";
import {
  createTypedTemporalWalkEngine,
  expandPowerWalkSeedAnchors,
  type PowerWalkResult,
  type PowerWalkSeedAnchor
} from "./powerwalk.js";
import { createWeightedFeatureSketchLearner } from "./latent.js";
import { createLearningController } from "./learning.js";
import { createAlphaFieldEngine } from "./field.js";
import { createSemanticEntailmentEngine } from "./entailment.js";
import { createCcrEngine } from "./ccr.js";
import { createProofCarryingAnswer } from "./proof-carrying-answer.js";
import { createCandidateEngine, type CandidateSurface } from "./candidate.js";
import { createJudge, type JudgeDecision } from "./judge.js";
import { createActionGraphBuilder } from "./action-graph.js";
import { createLearningLoop, type LearningLoopPlan, type LearningSourcePlan } from "./learning-loop.js";
import { createFunctionalCognitionEngine } from "./functional-cognition.js";
import { createFunctionalConsciousnessScore, createSpectralSelfDistillation } from "./self-distillation.js";
import { createFunctionalSelfModel } from "./self.js";
import { createPfaceEstimator } from "./causal-estimation.js";
import { analyzeGraph } from "./graph-analytics.js";
import { createEmissionEngine, createProgramGraphBuilder, createValidationGraphBuilder } from "./program.js";
import { createPredictionLayer, inventionConstructNode, type InventionConstruct } from "./prediction.js";
import { DEFAULT_POLICY, createActionPlanner, createCapabilityRegistry } from "./safety.js";
import { createAlphaFieldPersistence } from "./alpha-field-persistence.js";
import { createConstructSubstratePlanner } from "./construct-substrate.js";
import { createCounterfactualCognition } from "./counterfactual-cognition.js";
import { createSafetyRailEngine } from "./safety-rail-engine.js";
import { createSemanticMemoryIndex } from "./semantic-memory-index.js";
import { hybridRecall } from "./retrieval.js";
import { launchContractForTurn, retrievalRoleTracesFromHybridRecall } from "./launch-contract.js";
import { createSemanticProofSystem, type SemanticProofResult } from "./semantic-proof-system.js";
import { createAutonomousToolCognition } from "./tool-cognition.js";
import { createTrainingOrchestrator } from "./training-orchestrator.js";
import { createRuntimeOrchestrator } from "./runtime-orchestrator.js";
import { decideRuntimeCoherence } from "./runtime-coherence.js";
import { discourseObjectStateFromMetadata } from "./discourse-state.js";
import { createConnectorGovernance, defaultConnectorConfigs } from "./connector-governance.js";
import { composeEvidenceGroundedAnswer } from "./answer-emitter.js";
import { assistantForceDecision } from "./assistant-force.js";
import { createBenchmarkScorer } from "./benchmarks.js";
import { createTypedIngestProjector } from "./typed-ingest.js";
import { createCorrectionMemory } from "./correction-memory.js";
import { createDeterministicMouth, createMouth, type SpokenOutput } from "./mouth.js";
import { traceEvent } from "./debug/trace.js";
import { resolveDetailProfileId } from "./control-plane-profiles.js";
import { createWalshSpineReport, walshSpineReportToJson } from "./walsh-spine.js";
import { formatSurfaceMessage, localeFromMetadata, validationMessageKey } from "./localization.js";
import { collapseSurfaceWhitespace, ensureSurfaceSentence as ensureUnicodeSurfaceSentence, hasUncasedNonLatinLetter, hasUppercaseLetter, splitSurfaceSentences, surfaceWords } from "./surface-linguistics.js";
import { sourceCodeFileFactsFromJson, sourceRepositoryFactsFromJson } from "./source-code-graph.js";
import { graphEdgePriorClass, graphNodePriorClass, isLearnedPriorClass } from "./proof-boundary.js";
import { scoreGraphEdgeQuality, type GraphEdgeQuality } from "./graph-edge-quality.js";
import {
  buildQuestionCognitiveFabric,
  normalizeRawGraphEdgeToCognitiveEdges,
  type CognitiveEdge,
  type QuestionCognitiveFabric,
  type QuestionEdgeFit
} from "./question-cognitive-edge.js";
import { planQuestionSlots, type QuestionSlotAssignment, type QuestionSlotPlan } from "./question-slot-planner.js";
import { createCorpusRegistry, languageMemoryHydrationPlan } from "./corpus-registry.js";
import { CALIBRATION_TASK_CLASS_IDS, buildCalibrationModelSet, loadCalibrationModelSet, type CalibrationModelSet } from "./calibration-spine.js";
import {
  ANSWER_ROLE_GROUPS,
  ANSWER_ROLE_IDS,
  ANSWER_SLOT_IDS,
  GRAPH_QUALITY_CLASS_IDS,
  GRAPH_SLOT_IDS,
  QUESTION_EDGE_DECISION_IDS,
  RELATION_ROLE_IDS,
  isBackgroundAnswerRoleId,
  isBridgeAnswerRoleId,
  type QuestionEdgeDecisionId
} from "./question-routing-ids.js";
import { assertValidEvaluationCondition, EVALUATION_COMPONENT_IDS, type EvaluationComponentId } from "./evaluation-flags.js";
import { createEvaluationTrace, executeEvaluationComponent, type EvaluationTraceRecorder } from "./evaluation-trace.js";
import type { HybridRetrievalResult, RetrievalQuery } from "./semantic-memory-index.js";
import type { RetrievalPlan } from "./retrieval.js";
import type { CcrResult } from "./ccr.js";
import type { LanguageMemoryRuntimeState } from "./language-memory-runtime.js";
import { planInventions } from "./invention-planner.js";
import { updateDialogueState, type DialogueState } from "./dialogue-pragmatics.js";
import {
  activateCognitiveOperators,
  COGNITIVE_OPERATOR_IDS,
  deriveTurnRequirementField,
  TURN_REQUIREMENT_DIMENSIONS,
  type ActivatedOperator,
  type CognitiveOperatorId,
  type ExplicitTurnRequirement,
  type TurnRequirementField
} from "./turn-requirements.js";
import { planCognitiveProposals, type CognitiveActionPlan, type CognitiveProposal } from "./cognitive-planner.js";
import {
  createAnswerRevisionCoordinator,
  type RevisionAnswerVersion,
  type RevisionValidationResults
} from "./answer-revision.js";

type RuntimeGraphSliceValue = { graph: GraphSlice; evidence: EvidenceSpan[] };

const LOCAL_ANSWER_KIND_IDS = {
  evidenceBoundary: "ans.kind.6f2a4b81",
  collection: "ans.kind.3be50f92",
  temporalCounterexample: "ans.kind.7f1c2a90"
} as const;

const LOCAL_ANSWER_SLOT_IDS = {
  sentence: "ans.slot.0f3a7c61",
  memberList: "ans.slot.91db4a63",
  subject: "ans.slot.4c2d07a9",
  requestHead: "ans.slot.1a678d0b",
  requestPredicate: "ans.slot.42f8e39c",
  conceptEvidence: "ans.slot.b5d1c337",
  counterexampleEvidence: "ans.slot.f9a41e0d"
} as const;

const LOCAL_ANSWER_RELATION_IDS = {
  sourceQuote: "rel.1f7c4a92",
  polarityReject: "rel.8d64be21",
  member: "rel.91db4a63",
  temporalCounterexample: "rel.7f1c2a90"
} as const;

interface LocalEvidenceAnswerPlan {
  planId: string;
  kindId: string;
  evidence: EvidenceSpan[];
  slotSurfaces: Record<string, string | string[]>;
  maxSentences: number;
  audit: JsonValue;
}

interface LocalEvidenceAnswerCandidate {
  answer: string;
  evidence: EvidenceSpan[];
  audit: JsonValue;
  plan: LocalEvidenceAnswerPlan;
}

const EXPLANATORY_CONTRACT_SLOT_IDS = {
  important: "qr.ec.93d70a4b",
  significance: "qr.ec.2f6b8c01",
  background: "qr.ec.7a41d9e3",
  boundary: "qr.ec.b0e54c28",
  subject: "qr.ec.11c6a7d5",
  role: "qr.ec.d4b08f61",
  primary: "qr.ec.5e31c0a9",
  context: "qr.ec.0a79f2d6",
  contextDomain: "qr.ec.8c16b4e0",
  definition: "qr.ec.f72a0d13",
  memberSet: "qr.ec.43e9b5a2",
  source: "qr.ec.a6d50e91",
  target: "qr.ec.9b27d4f8",
  effect: "qr.ec.6f01a8c3",
  request: "qr.ec.28d3e7b0"
} as const;

interface GraphSliceCacheEntry {
  loadedAt: number;
  accessedAt: number;
  hits: number;
  bytes: number;
  source: "hot-neighborhood" | "postgres";
  value: RuntimeGraphSliceValue;
}

interface HotGraphNeighborhood {
  key: string;
  loadedAt: number;
  bytes: number;
  value: RuntimeGraphSliceValue;
  nodeById: Map<string, GraphNode>;
  edgeById: Map<string, GraphEdge>;
  hyperedgeById: Map<string, GraphSlice["hyperedges"][number]>;
  edgeByNodeId: Map<string, GraphEdge[]>;
  hyperedgeByNodeId: Map<string, GraphSlice["hyperedges"][number][]>;
  featureNodeIds: Map<string, Set<string>>;
  evidenceById: Map<string, EvidenceSpan>;
  evidenceNodeIds: Map<string, Set<string>>;
  evidenceEdgeIds: Map<string, Set<string>>;
  evidenceHyperedgeIds: Map<string, Set<string>>;
  sourceAnchorEvidenceIds: Map<string, Set<string>>;
}

export function createScceKernel(deps: ScceKernelDeps): ScceKernel {
  if (deps.evaluationCondition) assertValidEvaluationCondition(deps.evaluationCondition);
  const clock = deps.clock ?? createClock();
  const hasher = createHasher();
  const idFactory = deps.idFactory ?? createIdFactory({ clock, hasher, namespace: deps.namespace, runSeed: deps.runSeed, deterministicReplay: deps.deterministicReplay });
  const eventFactory = createEventFactory({ idFactory, clock, hasher });
  const evidenceExtractor = createEvidenceExtractor({ idFactory, hasher });
  const graphBuilder = createSourceGraphBuilder({ idFactory });
  const admission = createSourceAdmissionController();
  const language = createLanguageAcquisitionEngine({ idFactory });
  const multilingual = createMultilingualAcquisitionEngine({ hashText: text => hasher.digestHex(text) });
  const languageMemoryRuntime = createLanguageMemoryRuntime({ idFactory, hasher });
  const translationEngine = createTranslationEngine({ idFactory, hasher });
  const powerWalk = createTypedTemporalWalkEngine({ hasher });
  const featureSketchLearner = createWeightedFeatureSketchLearner({ hasher });
  const learning = createLearningController();
  const fieldEngine = createAlphaFieldEngine({ relationPotentialModel: deps.relationPotentialModel });
  const entailment = createSemanticEntailmentEngine({ idFactory, hasher });
  const ccr = createCcrEngine();
  const pca = createProofCarryingAnswer();
  const candidates = createCandidateEngine();
  const judge = createJudge();
  const answerRevision = createAnswerRevisionCoordinator();
  const actionGraphBuilder = createActionGraphBuilder({ hasher });
  const learningLoop = createLearningLoop();
  const functionalCognitionEngine = createFunctionalCognitionEngine();
  const ssd = createSpectralSelfDistillation();
  const fcs = createFunctionalConsciousnessScore();
  const pface = createPfaceEstimator();
  const programBuilder = createProgramGraphBuilder({ idFactory, hasher });
  const validationBuilder = createValidationGraphBuilder({ idFactory });
  const emissionEngine = createEmissionEngine({ idFactory });
  const prediction = createPredictionLayer({ idFactory });
  const alphaPersistence = createAlphaFieldPersistence({ hasher });
  const constructSubstrate = createConstructSubstratePlanner({ idFactory, hasher });
  const counterfactual = createCounterfactualCognition({ hasher });
  const connectorGovernance = createConnectorGovernance({ hasher, now: () => clock.now() });
  const safetyRails = createSafetyRailEngine({ hasher });
  const semanticMemory = createSemanticMemoryIndex({ hasher });
  const semanticProofSystem = createSemanticProofSystem({ hasher });
  const toolCognition = createAutonomousToolCognition({ hasher, now: () => clock.now() });
  const trainingOrchestrator = createTrainingOrchestrator({ hasher, now: () => clock.now() });
  const runtimeOrchestrator = createRuntimeOrchestrator({ hasher });
  const typedIngest = createTypedIngestProjector({ idFactory, hasher });
  const correctionMemory = createCorrectionMemory({ idFactory, hasher });
  const mouth = createMouth({ languageMemory: languageMemoryRuntime, correctionMemory, hashText: text => hasher.digestHex(text) });
  const deterministicMouth = createDeterministicMouth({ hashText: text => hasher.digestHex(text) });
  const policy: PolicyProfile = { ...DEFAULT_POLICY, ...(deps.policy ?? {}) };
  const corpusRegistry = createCorpusRegistry(deps.corpusRegistry ?? []);
  let lastEpisodeId: EpisodeId | undefined;
  let lastOutput = "";
  let lastTurnTiming: TurnResult["timing"] | undefined;
  let lastField: TurnResult["field"] | undefined;
  const failures: string[] = [];
  let bufferedEvents: ScceEvent[] | undefined;
  const surfaceLanguageMemoryCache = new Map<string, { limit: number; loadedAt: number; value: Awaited<ReturnType<typeof hydrateSurfaceLanguageMemory>> }>();
  const graphSliceCacheMaxEntries = positiveRuntimeInt("SCCE_GRAPH_SLICE_CACHE_ENTRIES", 128);
  const graphSliceCacheMaxBytes = positiveRuntimeInt("SCCE_GRAPH_SLICE_CACHE_MB", 256) * 1024 * 1024;
  const hotNeighborhoodEnabled = runtimeFlag("SCCE_HOT_NEIGHBORHOOD", true);
  const hotNeighborhoodNodeLimit = positiveRuntimeInt("SCCE_HOT_NEIGHBORHOOD_NODES", 3000);
  const hotNeighborhoodEdgeLimit = positiveRuntimeInt("SCCE_HOT_NEIGHBORHOOD_EDGES", 6000);
  const hotNeighborhoodEvidenceLimit = positiveRuntimeInt("SCCE_HOT_NEIGHBORHOOD_EVIDENCE", 3000);
  const hotNeighborhoodPostingCap = positiveRuntimeInt("SCCE_HOT_NEIGHBORHOOD_POSTING_CAP", 512);
  const sourceAnchorHotNodeLimit = positiveRuntimeInt("SCCE_SOURCE_ANCHOR_HOT_NODES", 64);
  const sourceAnchorHotEdgeLimit = positiveRuntimeInt("SCCE_SOURCE_ANCHOR_HOT_EDGES", 128);
  const turnProofEvidenceLimit = positiveRuntimeInt("SCCE_TURN_PROOF_EVIDENCE", 2);
  const activeBrainMarkerCacheMs = positiveRuntimeInt("SCCE_ACTIVE_BRAIN_MARKER_CACHE_MS", 300_000);
  const surfaceLanguageMemoryCacheMs = positiveRuntimeInt("SCCE_SURFACE_LANGUAGE_CACHE_MS", 600_000);
  const calibrationModelCacheMs = positiveRuntimeInt("SCCE_CALIBRATION_MODEL_CACHE_MS", 120_000);
  const graphSliceCache = new Map<string, GraphSliceCacheEntry>();
  let graphSliceCacheBytes = 0;
  let runtimeCacheEpoch = 0;
  let requireDurableGraphLookup = false;
  let hotNeighborhood: HotGraphNeighborhood | undefined;
  let hotNeighborhoodLoad: Promise<HotGraphNeighborhood | undefined> | undefined;
  let activeBrainMarkerCache: { loadedAt: number; value: JsonValue } | undefined;
  let surfaceProfileCache: { loadedAt: number; value: LanguageProfile | undefined } | undefined;
  let calibrationModelCache: { loadedAt: number; value: CalibrationModelSet } | undefined;
  let correctionRuleCache: { loadedAt: number; value: Awaited<ReturnType<typeof deps.storage.corrections.listRules>> } | undefined;

  function kernelTrace(event: Parameters<typeof traceEvent>[1]): void {
    traceEvent((globalThis as any).__sccTrace, event);
  }

  async function append(event: ScceEvent): Promise<ScceEvent> {
    if (bufferedEvents) {
      bufferedEvents.push(event);
      return event;
    }
    await deps.storage.events.append(event);
    return event;
  }

  async function appendBatch(events: ScceEvent[]): Promise<ScceEvent[]> {
    await deps.storage.events.appendBatch(events);
    return events;
  }

  function invalidateRuntimeCaches(): void {
    runtimeCacheEpoch++;
    requireDurableGraphLookup = true;
    graphSliceCache.clear();
    graphSliceCacheBytes = 0;
    hotNeighborhood = undefined;
    hotNeighborhoodLoad = undefined;
    surfaceLanguageMemoryCache.clear();
    activeBrainMarkerCache = undefined;
    surfaceProfileCache = undefined;
    calibrationModelCache = undefined;
  }

  async function withBufferedEventWrites<T>(run: () => Promise<T>): Promise<T> {
    if (bufferedEvents) return run();
    const buffer: ScceEvent[] = [];
    bufferedEvents = buffer;
    try {
      const result = await run();
      if (buffer.length) await deps.storage.events.appendBatch(buffer);
      return result;
    } catch (error) {
      if (buffer.length) await deps.storage.events.appendBatch(buffer).catch(writeError => failures.push(`event batch persistence failed: ${writeError instanceof Error ? writeError.message : String(writeError)}`));
      throw error;
    } finally {
      bufferedEvents = undefined;
    }
  }

  async function languageMemorySummary(limit = 36): Promise<JsonValue> {
    const models = await deps.storage.languageMemory.listNgramModels({ limit });
    const observations = await deps.storage.languageMemory.listNgramObservations({ limit: 10000 });
    const units = await deps.storage.languageMemory.listLanguageUnits({ limit: 2048 });
    const patterns = await deps.storage.languageMemory.listLanguagePatterns({ limit: 512 });
    const state = languageMemoryRuntime.hydrate({ models, observations, units, patterns });
    return toJsonValue({
      modelRecords: models.length,
      usableModels: state.models.length,
      maxOrder: state.maxOrder,
      observedSymbolCount: state.observedSymbolCount,
      vocabularySize: state.vocabularySize,
      importedLanguagePriorCount: state.importedLanguagePriorCount,
      streamIds: state.streamIds.slice(0, 24),
      languageHints: state.languageHints.slice(0, 24),
      profile: languageMemoryRuntime.profile({ state }),
      audit: state.audit
    });
  }

  async function activeBrainMarker(): Promise<JsonValue> {
    const now = clock.now();
    if (activeBrainMarkerCache && now - activeBrainMarkerCache.loadedAt < activeBrainMarkerCacheMs) return activeBrainMarkerCache.value;
    const summary = await deps.storage.brainImports.summarize({ limit: 2000 });
    const value = toJsonValue({
      activeBrainVersion: summary.activeBrainVersion ?? null,
      activeImportRunIds: summary.activeImportRunIds,
      importedLanguagePriorCount: summary.importedLanguagePriorCount,
      importedGraphPriorCount: summary.importedGraphPriorCount,
      importedDirectEvidenceCount: summary.importedDirectEvidenceCount,
      profileExcerptEvidenceCount: summary.profileExcerptEvidenceCount,
      importedLearnedPriorCount: summary.importedLearnedPriorCount,
      importedProgramPriorCount: summary.importedProgramPriorCount,
      unknownPriorCount: summary.unknownPriorCount,
      runs: summary.runs.slice(0, 24).map(run => ({
        importRunId: run.importRunId,
        brainVersion: run.brainVersion,
        rows: run.rows,
        forceClasses: run.forceClasses,
        rowCounts: run.rowCounts,
        warnings: run.warnings.slice(0, 24)
      })),
      forceClassExplanation: {
        direct_evidence: "exact source URI, version identity, and span preserved; may certify factual proof when promoted",
        profile_excerpt_evidence: "SCCE2 profile-contained excerpt only; may prove the profile contained text, not the original external factual claim",
        learned_language_prior: "language prior for scoring, suggestion, and Mouth realization; not factual proof",
        learned_concept_prior: "graph prior for alpha and PPF activation; not factual proof",
        learned_program_prior: "program-language prior; not factual proof",
        unknown_prior: "imported material with unsupported or uncertain semantics; not factual proof"
      }
    });
    activeBrainMarkerCache = { loadedAt: now, value };
    return value;
  }

  async function hydrateSurfaceLanguageMemory(limit = 36, languageHint?: string) {
    const boundedLimit = Math.max(1, Math.min(64, Math.floor(limit)));
    const corpusPlan = languageMemoryHydrationPlan(corpusRegistry, {
      ngramModels: Math.max(12, boundedLimit * Math.max(1, corpusRegistry.length)),
      ngramObservations: Math.max(1200, boundedLimit * 320),
      languageUnits: Math.max(512, boundedLimit * 128),
      languagePatterns: Math.max(256, boundedLimit * 64),
      semanticFrames: Math.max(512, boundedLimit * 96)
    });
    const corpusQueries = corpusPlan.flatMap(item => item.querySourceSystems.map(sourceSystem => ({ ...item, sourceSystem })));
    const [modelsBySource, observationsBySource, unitsBySource, patternsBySource, semanticFramesBySource] = await Promise.all([
      Promise.all(corpusQueries.map(item => deps.storage.languageMemory.listNgramModels({ sourceSystem: item.sourceSystem, limit: Math.min(limit, item.limits.ngramModels) }))),
      Promise.all(corpusQueries.map(item => deps.storage.languageMemory.listNgramObservations({ sourceSystem: item.sourceSystem, languageHint, limit: item.limits.ngramObservations }))),
      Promise.all(corpusQueries.map(item => deps.storage.languageMemory.listLanguageUnits({ sourceSystem: item.sourceSystem, script: scriptFromLanguageHint(languageHint), limit: item.limits.languageUnits }))),
      Promise.all(corpusQueries.map(item => deps.storage.languageMemory.listLanguagePatterns({ sourceSystem: item.sourceSystem, limit: item.limits.languagePatterns }))),
      Promise.all(corpusQueries.map(item => deps.storage.languageMemory.listSemanticFrames({ sourceSystem: item.sourceSystem, limit: item.limits.semanticFrames })))
    ]);
    const hintedModelsBySource = languageHint
      ? await Promise.all(corpusQueries.map(item => deps.storage.languageMemory.listNgramModels({ sourceSystem: item.sourceSystem, languageHint, limit: Math.min(limit, item.limits.ngramModels) })))
      : [];
    const hintedModels = hintedModelsBySource.flat();
    const allowGeneralModelFallback = !languageHint || scriptFromLanguageHint(languageHint) === "script:Latn";
    const models = uniqueRecordsById(allowGeneralModelFallback ? [...hintedModels, ...modelsBySource.flat()] : hintedModels, Math.max(boundedLimit, corpusPlan.reduce((sum, item) => sum + item.limits.ngramModels, 0)));
    const observations = uniqueRecordsById(observationsBySource.flat(), Math.max(1200, boundedLimit * 320));
    const units = uniqueRecordsById(unitsBySource.flat(), Math.max(512, boundedLimit * 128));
    const patterns = uniqueRecordsById(patternsBySource.flat(), Math.max(256, boundedLimit * 64));
    const semanticFrames = uniqueRecordsById(semanticFramesBySource.flat(), Math.max(512, boundedLimit * 96));
    const active = await deps.storage.brainImports.active();
    const state = languageMemoryRuntime.hydrateFromImportedBrain({ importRunId: active.activeImportRunIds[0], models, observations, units, patterns, semanticFrames });
    return { models, observations, units, patterns, semanticFrames, state, active, corpusPlan };
  }

  function uniqueRecordsById<T extends { id: string }>(records: readonly T[], limit: number): T[] {
    const byId = new Map<string, T>();
    for (const record of records) if (!byId.has(record.id)) byId.set(record.id, record);
    return [...byId.values()].slice(0, limit);
  }

  function languageHintForSurface(text: string): string | undefined {
    const chars = [...text.normalize("NFC")].filter(char => !/\s/u.test(char));
    if (!chars.length) return undefined;
    const scripts = new Map<string, number>();
    for (const char of chars) scripts.set(scriptOfSurfaceChar(char), (scripts.get(scriptOfSurfaceChar(char)) ?? 0) + 1);
    const top = [...scripts.entries()].sort((a, b) => b[1] - a[1])[0];
    if (!top) return undefined;
    const [script, count] = top;
    if (script === "script:Zxxx" || count / Math.max(1, chars.length) < 0.25) return undefined;
    const direction = directionForScript(script);
    return `script:${script};direction:${direction}`;
  }

  function scriptFromLanguageHint(languageHint: string | undefined): string | undefined {
    if (!languageHint) return undefined;
    const match = languageHint.match(/script:(script:[A-Za-z0-9_:-]+)/);
    return match?.[1];
  }

  function scriptOfSurfaceChar(char: string): string {
    if (/\p{Script=Latin}/u.test(char)) return "script:Latn";
    if (/\p{Script=Hangul}/u.test(char)) return "script:Hang";
    if (/\p{Script=Arabic}/u.test(char)) return "script:Arab";
    if (/\p{Script=Hebrew}/u.test(char)) return "script:Hebr";
    if (/\p{Script=Han}/u.test(char)) return "script:Hani";
    if (/\p{Script=Hiragana}/u.test(char)) return "script:Hira";
    if (/\p{Script=Katakana}/u.test(char)) return "script:Kana";
    if (/\p{Script=Cyrillic}/u.test(char)) return "script:Cyrl";
    if (/\p{Script=Devanagari}/u.test(char)) return "script:Deva";
    if (/\p{Script=Thai}/u.test(char)) return "script:Thai";
    if (/\p{Script=Greek}/u.test(char)) return "script:Greek";
    if (/\p{Number}/u.test(char)) return "script:Zyyy:number";
    return "script:Zxxx";
  }

  function directionForScript(script: string): string {
    return script === "script:Arab" || script === "script:Hebr" ? "rtl" : "ltr";
  }

  async function hydrateSurfaceLanguageMemoryCached(limit = 36, languageHint?: string) {
    const now = clock.now();
    const cacheKey = languageHint ?? "language:any";
    const cached = surfaceLanguageMemoryCache.get(cacheKey);
    if (cached && cached.limit >= limit && now - cached.loadedAt < surfaceLanguageMemoryCacheMs) {
      return cached.value;
    }
    const value = await hydrateSurfaceLanguageMemory(limit, languageHint);
    surfaceLanguageMemoryCache.set(cacheKey, { limit, loadedAt: now, value });
    return value;
  }

  async function surfaceLanguageProfileCached(): Promise<LanguageProfile | undefined> {
    const now = clock.now();
    if (surfaceProfileCache && now - surfaceProfileCache.loadedAt < 60_000) return surfaceProfileCache.value;
    const value = (await deps.storage.model.listLanguageProfiles(1))[0];
    surfaceProfileCache = { loadedAt: now, value };
    return value;
  }

  async function correctionRulesCached() {
    const now = clock.now();
    if (correctionRuleCache && now - correctionRuleCache.loadedAt < 30_000) return correctionRuleCache.value;
    const value = await deps.storage.corrections.listRules({ limit: 96 });
    correctionRuleCache = { loadedAt: now, value };
    return value;
  }

  async function calibrationModelsCached(): Promise<CalibrationModelSet> {
    const now = clock.now();
    if (calibrationModelCache && now - calibrationModelCache.loadedAt < calibrationModelCacheMs) return calibrationModelCache.value;
    if (!deps.storage.dialogueMemory?.listCalibrationObservations) {
      const value = buildCalibrationModelSet({ observations: [], createdAt: now });
      calibrationModelCache = { loadedAt: now, value };
      return value;
    }
    const value = await loadCalibrationModelSet({
      store: deps.storage.dialogueMemory,
      limit: 5000,
      minPoints: 2,
      createdAt: now
    });
    calibrationModelCache = { loadedAt: now, value };
    return value;
  }

  function trainingPromotionEvidenceIds(plan: { promotion: readonly { evidenceId: string; promote: boolean }[] }): EvidenceSpan["id"][] {
    return [...new Set(plan.promotion.filter(item => item.promote).map(item => item.evidenceId))]
      .map(id => id as EvidenceSpan["id"]);
  }

  function trainingPromotionReason(
    input: TrainInput,
    plan: { promotion: { reasons: Array<{ sourceVersionId: string; action: string; score: number }> } },
    trainingPlan: { id: string; promotion: readonly { evidenceId: string; promote: boolean; score: number }[] }
  ): string {
    const selected = trainingPlan.promotion
      .filter(item => item.promote)
      .slice(0, 24)
      .map(item => `${item.evidenceId}:${item.score.toFixed(3)}`)
      .join("|");
    const sourcePlan = plan.promotion.reasons
      .slice(0, 12)
      .map(item => `${item.sourceVersionId}:${item.action}:${item.score.toFixed(3)}`)
      .join("|");
    return `training promotion minTrust=${input.config.promotion?.minTrust ?? 0.5}; trainingPlan=${trainingPlan.id}; selected=${selected}; sourcePlan=${sourcePlan}`;
  }

  async function persistTrainingLanguageMemory(
    evidence: readonly EvidenceSpan[],
    existingProfiles: readonly LanguageProfile[],
    trainingPlanId: string
  ): Promise<{ profiles: LanguageProfile[]; audit: JsonValue }> {
    if (!evidence.length) {
      return { profiles: [...existingProfiles], audit: toJsonValue({ source: "kernel.train.language_memory", skipped: "no promoted evidence selected", observations: 0, models: 0, units: 0, patterns: 0, semanticFrames: 0, profilesCreated: 0 }) };
    }
    const profiles = [...existingProfiles];
    const profileBySourceVersion = new Map(profiles.map(profile => [String(profile.sourceVersionId), profile]));
    const groups = new Map<string, EvidenceSpan[]>();
    for (const span of evidence) groups.set(String(span.sourceVersionId), [...(groups.get(String(span.sourceVersionId)) ?? []), span]);
    let observations = 0;
    let models = 0;
    let units = 0;
    let patterns = 0;
    let semanticFrames = 0;
    let profilesCreated = 0;
    for (const spans of groups.values()) {
      const first = spans[0];
      if (!first) continue;
      const sourceVersionId = first.sourceVersionId;
      const text = spans.map(span => span.text).join("\n");
      let profile = profileBySourceVersion.get(String(sourceVersionId));
      if (!profile) {
        profile = language.acquire({ sourceVersionId, text, createdAt: clock.now() });
        await deps.storage.model.putLanguageProfile(profile);
        profiles.push(profile);
        profileBySourceVersion.set(String(sourceVersionId), profile);
        profilesCreated++;
      }
      const memory = languageMemoryRuntime.train({
        streamId: `training:${trainingPlanId}:${String(sourceVersionId)}`,
        profile,
        sourceVersionId,
        text,
        evidence: spans,
        createdAt: clock.now(),
        maxOrder: 6,
        maxCountersPerOrder: 12000,
        vocabularyLimit: 24000
      });
      await deps.storage.languageMemory.putNgramObservationsBatch(memory.observations);
      for (const model of memory.models) await deps.storage.languageMemory.putNgramModel(model);
      for (const unit of memory.units) await deps.storage.languageMemory.putLanguageUnit(unit);
      for (const pattern of memory.patterns) await deps.storage.languageMemory.putLanguagePattern(pattern);
      for (const frame of memory.semanticFrames) await deps.storage.languageMemory.putSemanticFrame(frame);
      observations += memory.observations.length;
      models += memory.models.length;
      units += memory.units.length;
      patterns += memory.patterns.length;
      semanticFrames += memory.semanticFrames.length;
    }
    return {
      profiles,
      audit: toJsonValue({
        source: "kernel.train.language_memory",
        evidenceSpans: evidence.length,
        sourceVersions: groups.size,
        profilesCreated,
        observations,
        models,
        units,
        patterns,
        semanticFrames
      })
    };
  }

  async function persistAlphaRecord(alphaRecord: ReturnType<typeof alphaPersistence.record>, field: TurnResult["field"]): Promise<void> {
    await deps.storage.flowCache.putPpf({
      id: alphaRecord.cacheKey,
      graphHash: alphaRecord.graphFingerprint.id,
      beta: 0.85,
      personalizationJson: toJsonValue(alphaRecord.seed),
      massJson: toJsonValue(alphaRecord.ppf),
      diagnosticsJson: alphaRecord.diagnostics.audit,
      createdAt: alphaRecord.createdAt
    });
    await deps.storage.flowCache.putAlphaTrace({
      id: `${alphaRecord.cacheKey}:trace`,
      graphHash: alphaRecord.graphFingerprint.id,
      alpha: field.alphaTrace.alpha,
      traceJson: toJsonValue(field.alphaTrace),
      createdAt: alphaRecord.createdAt
    });
  }

  function alphaRecordFromField(input: { graph: GraphSnapshot; requestText: string; requestFeatures: string[]; field: TurnResult["field"]; createdAt: number }): ReturnType<typeof alphaPersistence.record> {
    const graphFingerprint = alphaPersistence.fingerprint(input.graph);
    const seed = alphaPersistence.seedVector({ graph: input.graph, requestFeatures: input.requestFeatures, prior: input.field });
    const requestHash = hasher.digestHex(input.requestText);
    const fieldHash = hasher.digestHex(JSON.stringify({ ppf: input.field.ppf, active: input.field.active, surfaces: input.field.alphaTrace.surfaces }));
    const cacheKey = `alpha_cache_${hasher.digestHex(JSON.stringify({ graph: graphFingerprint.id, requestHash, seedHash: seed.seedHash, fieldHash })).slice(0, 32)}`;
    return {
      cacheKey,
      graphFingerprint,
      requestHash,
      fieldHash,
      seed,
      ppf: input.field.ppf,
      alphaTrace: input.field.alphaTrace,
      diagnostics: {
        dominantEigenvalue: 0,
        spectralGap: 0,
        residual: kernelNumber(jsonRecord(input.field.ppfDiagnostics).residual),
        iterations: kernelNumber(jsonRecord(input.field.ppfDiagnostics).iterations),
        stationary: input.field.ppf,
        conductance: 0,
        irreducibilityScore: 0,
        aperiodicityScore: 0,
        audit: toJsonValue({ source: "fieldEngine.activate", duplicatePfDiagnosticsSkipped: true, fieldDiagnostics: input.field.ppfDiagnostics ?? null })
      },
      createdAt: input.createdAt,
      expiresAt: input.createdAt + 15 * 60 * 1000,
      invalidation: []
    };
  }

  function cachedGraphSlice(cacheKey: string): RuntimeGraphSliceValue | undefined {
    const cached = graphSliceCache.get(cacheKey);
    if (!cached) return undefined;
    cached.accessedAt = clock.now();
    cached.hits++;
    return cached.value;
  }

  function cacheGraphSlice(cacheKey: string, value: RuntimeGraphSliceValue, source: GraphSliceCacheEntry["source"]): RuntimeGraphSliceValue {
    const bytes = estimateRuntimeGraphSliceBytes(value);
    if (bytes > graphSliceCacheMaxBytes) return value;
    const now = clock.now();
    const previous = graphSliceCache.get(cacheKey);
    if (previous) graphSliceCacheBytes -= previous.bytes;
    graphSliceCache.set(cacheKey, { loadedAt: now, accessedAt: now, hits: previous?.hits ?? 0, bytes, source, value });
    graphSliceCacheBytes += bytes;
    evictGraphSliceCache();
    return value;
  }

  function evictGraphSliceCache(): void {
    while (graphSliceCache.size > graphSliceCacheMaxEntries || graphSliceCacheBytes > graphSliceCacheMaxBytes) {
      const victim = [...graphSliceCache.entries()]
        .sort((left, right) => left[1].accessedAt - right[1].accessedAt || left[1].hits - right[1].hits)[0];
      if (!victim) return;
      graphSliceCache.delete(victim[0]);
      graphSliceCacheBytes -= victim[1].bytes;
    }
  }

  async function graphForText(text: string, options: { allowSemanticFrameEvidence?: boolean } = {}) {
    const features = graphRetrievalFeatures(text);
    const topicTerms = graphTopicTermsForText(text);
    const allowSemanticFrameEvidence = options.allowSemanticFrameEvidence !== false;
    const cacheKey = hasher.digestHex(JSON.stringify({ features, topicTerms, allowSemanticFrameEvidence })).slice(0, 32);
    const exact = cachedGraphSlice(cacheKey);
    if (exact) return exact;
    if (requestNeedsSourceAnchoredEvidence(text)) {
      const residentHot = await hotNeighborhoodIfResident();
      if (residentHot) {
        const hotAnchoredEvidence = sourceAnchoredEvidenceFromHot(residentHot, text);
        const hotSlice = hotAnchoredEvidence.length
          ? graphSliceFromHotEvidence(residentHot, hotAnchoredEvidence, features, topicTerms)
          : undefined;
        if (hotSlice && hotAnchoredEvidence.length >= 4 && !temporalCounterexampleExpected(text, hotAnchoredEvidence)) return cacheGraphSlice(cacheKey, hotSlice, "hot-neighborhood");
      }
      const anchoredEvidence = await sourceAnchoredEvidenceForText(text, features, allowSemanticFrameEvidence);
      if (!anchoredEvidence.length) {
        return cacheGraphSlice(cacheKey, { graph: { nodes: [], edges: [], hyperedges: [], bounded: true, query: { evidenceIds: [], features: [...features], topicTerms, radius: 0, limitNodes: 0, limitEdges: 0 } }, evidence: [] }, "postgres");
      }
      const graph = await deps.storage.graph.getSlice({
        evidenceIds: anchoredEvidence.map(span => span.id),
        features: [...features],
        topicTerms,
        radius: 2,
        limitNodes: sourceAnchorHotNodeLimit,
        limitEdges: sourceAnchorHotEdgeLimit
      });
      const graphEvidenceIds = uniqueKernelStrings([
        ...anchoredEvidence.map(span => String(span.id)),
        ...graph.nodes.flatMap(node => node.evidenceIds.map(String)),
        ...graph.edges.flatMap(edge => edge.evidenceIds.map(String)),
        ...graph.hyperedges.flatMap(edge => edge.provenanceRefs.map(String))
      ]).slice(0, 80);
      const graphEvidence = graphEvidenceIds.length ? await deps.storage.evidence.getEvidenceBatch(graphEvidenceIds as EvidenceSpan["id"][]) : [];
      const anchoredGraphEvidence = graphEvidence.filter(span => evidenceMatchesSourceAnchor(span, anchoredEvidence));
      const value: RuntimeGraphSliceValue = {
        graph: {
          ...graph,
          query: { evidenceIds: anchoredEvidence.map(span => span.id), features: [...features], topicTerms, radius: 2, limitNodes: sourceAnchorHotNodeLimit, limitEdges: sourceAnchorHotEdgeLimit }
        },
        evidence: mergeEvidenceSpans([...anchoredEvidence, ...anchoredGraphEvidence])
      };
      return cacheGraphSlice(cacheKey, value, "postgres");
    }
    if (!requireDurableGraphLookup && !requestNeedsSourceAnchoredEvidence(text)) {
      const hot = await hotNeighborhoodCached();
      const hotSlice = hot ? graphSliceFromHotNeighborhood(hot, features, topicTerms) : undefined;
      if (hotSlice) return cacheGraphSlice(cacheKey, hotSlice, "hot-neighborhood");
    }
    const value = await graphForTextUncached(text, features, topicTerms);
    requireDurableGraphLookup = false;
    return cacheGraphSlice(cacheKey, value, "postgres");
  }

  async function graphForEvidenceIds(evidenceIds: readonly string[]): Promise<RuntimeGraphSliceValue> {
    const boundedEvidenceIds = uniqueKernelStrings(evidenceIds).slice(0, 80) as EvidenceSpan["id"][];
    if (!boundedEvidenceIds.length) return {
      graph: { nodes: [], edges: [], hyperedges: [], bounded: true, query: { evidenceIds: [] } },
      evidence: []
    };
    const cacheKey = hasher.digestHex(JSON.stringify({ evidenceIds: boundedEvidenceIds })).slice(0, 32);
    const exact = cachedGraphSlice(cacheKey);
    if (exact) return exact;
    const graph = await deps.storage.graph.getSlice({
      evidenceIds: boundedEvidenceIds,
      radius: 2,
      limitNodes: sourceAnchorHotNodeLimit,
      limitEdges: sourceAnchorHotEdgeLimit
    });
    const graphEvidenceIds = uniqueKernelStrings([
      ...boundedEvidenceIds.map(String),
      ...graph.nodes.flatMap(node => node.evidenceIds.map(String)),
      ...graph.edges.flatMap(edge => edge.evidenceIds.map(String)),
      ...graph.hyperedges.flatMap(edge => edge.provenanceRefs.map(String))
    ]).slice(0, 80);
    const graphEvidence = graphEvidenceIds.length ? await deps.storage.evidence.getEvidenceBatch(graphEvidenceIds as EvidenceSpan["id"][]) : [];
    return cacheGraphSlice(cacheKey, { graph, evidence: graphEvidence }, "postgres");
  }

  async function graphForEvidenceIdsUnrouted(evidenceIds: readonly string[]): Promise<RuntimeGraphSliceValue> {
    const boundedEvidenceIds = uniqueKernelStrings(evidenceIds).slice(0, 80) as EvidenceSpan["id"][];
    if (!boundedEvidenceIds.length) return emptyRuntimeGraphSlice({ evidenceIds: [] }, []);
    const graph = await deps.storage.graph.getSlice({
      evidenceIds: boundedEvidenceIds,
      radius: 2,
      limitNodes: sourceAnchorHotNodeLimit,
      limitEdges: sourceAnchorHotEdgeLimit
    });
    const graphEvidenceIds = uniqueKernelStrings([
      ...boundedEvidenceIds.map(String),
      ...graph.nodes.flatMap(node => node.evidenceIds.map(String)),
      ...graph.edges.flatMap(edge => edge.evidenceIds.map(String)),
      ...graph.hyperedges.flatMap(edge => edge.provenanceRefs.map(String))
    ]).slice(0, 80) as EvidenceSpan["id"][];
    const evidence = graphEvidenceIds.length ? await deps.storage.evidence.getEvidenceBatch(graphEvidenceIds) : [];
    return { graph, evidence };
  }

  async function evidenceOnlyForText(text: string, allowSemanticFrameEvidence = true): Promise<RuntimeGraphSliceValue> {
    const features = graphRetrievalFeatures(text);
    const topicTerms = graphTopicTermsForText(text);
    const evidence = requestNeedsSourceAnchoredEvidence(text)
      ? await sourceAnchoredEvidenceForText(text, features, allowSemanticFrameEvidence)
      : (await deps.storage.evidence.searchEvidence({ features, limit: 40 })).map(item => item.span);
    return emptyRuntimeGraphSlice({ evidenceIds: evidence.map(span => span.id), features, topicTerms, radius: 0, limitNodes: 0, limitEdges: 0 }, evidence);
  }

  async function evidenceOnlyForIds(evidenceIds: readonly string[]): Promise<RuntimeGraphSliceValue> {
    const bounded = uniqueKernelStrings(evidenceIds).slice(0, 80) as EvidenceSpan["id"][];
    const evidence = bounded.length ? await deps.storage.evidence.getEvidenceBatch(bounded) : [];
    return emptyRuntimeGraphSlice({ evidenceIds: bounded, radius: 0, limitNodes: 0, limitEdges: 0 }, evidence);
  }

  function emptyRuntimeGraphSlice(query: GraphSlice["query"], evidence: readonly EvidenceSpan[]): RuntimeGraphSliceValue {
    return {
      graph: { nodes: [], edges: [], hyperedges: [], bounded: true, query },
      evidence: [...evidence]
    };
  }

  async function hotNeighborhoodIfResident(): Promise<HotGraphNeighborhood | undefined> {
    if (hotNeighborhood) return hotNeighborhood;
    return hotNeighborhoodLoad;
  }

  async function sourceAnchoredEvidenceForText(text: string, features: readonly string[], allowSemanticFrameEvidence = true): Promise<EvidenceSpan[]> {
    const anchorFeatures = sourceAnchorRetrievalFeatures(text);
    const retrievalFeatures = uniqueKernelStrings([...features, ...anchorFeatures]).slice(0, 256);
    const [evidenceResults, semanticFrameEvidence] = await Promise.all([
      deps.storage.evidence.searchEvidence({ features: retrievalFeatures, limit: anchorFeatures.length ? 96 : 48 }),
      allowSemanticFrameEvidence ? sourceAnchorSemanticFrameEvidence(text) : Promise.resolve([])
    ]);
    const promoted = mergeEvidenceSpans(evidenceResults.map(item => item.span).concat(semanticFrameEvidence))
      .filter(span => span.status === "promoted" || promotedSessionEvidence(span));
    const anchored = sourceAnchoredEvidenceForRequest(text, promoted);
    return (anchored.evidence.length ? anchored.evidence : []).slice(0, 24);
  }

  async function sourceAnchorSemanticFrameEvidence(text: string): Promise<EvidenceSpan[]> {
    const anchors = sourceEvidenceAnchorsForRequest(text);
    if (!anchors.length) return [];
    const frames = await deps.storage.languageMemory.listSemanticFrames({ sourceSystem: "wikipedia", limit: 2048 }).catch(() => []);
    const evidenceIds = uniqueKernelStrings(frames
      .filter(frame => semanticFrameMatchesSourceAnchor(frame, anchors))
      .flatMap(frame => frame.evidenceIds.map(String)))
      .slice(0, 64) as EvidenceSpan["id"][];
    return evidenceIds.length ? deps.storage.evidence.getEvidenceBatch(evidenceIds) : [];
  }

  function semanticFrameMatchesSourceAnchor(frame: SemanticFrameRecord, anchors: readonly string[]): boolean {
    const record = jsonRecord(frame.frameJson);
    const surface = sourceTextSurface(kernelString(record.preview) ?? kernelString(record.text) ?? "", 6000);
    if (!surface) return false;
    const surfaceUnits = splitPriorUnits(normalizePriorKey(surface)).filter(Boolean);
    return anchors.some(anchor => {
      const anchorUnits = splitPriorUnits(anchor).filter(Boolean);
      return anchorUnits.length > 0 && sourceAnchorPhraseContains(surfaceUnits, anchorUnits);
    });
  }

  function sourceAnchorRetrievalFeatures(text: string): string[] {
    const features = new Map<string, true>();
    for (const anchor of sourceEvidenceAnchorsForRequest(text).slice(0, 24)) {
      for (const feature of orderedRetrievalFeatures(anchor)) {
        if (isHighInformationRetrievalFeature(feature)) features.set(feature, true);
        if (feature.startsWith("sym:")) {
          for (const variant of retrievalUnitPrefixVariants(feature.slice(4))) {
            const variantFeature = `sym:${variant}`;
            if (isHighInformationRetrievalFeature(variantFeature)) features.set(variantFeature, true);
          }
        }
      }
    }
    return [...features.keys()].slice(0, 128);
  }

  function retrievalUnitPrefixVariants(unit: string): string[] {
    const normalized = normalizePriorKey(unit);
    if ([...normalized].length < 5) return [];
    const chars = [...normalized];
    return [chars.slice(0, -1).join("")]
      .filter(value => value.length >= 4 && value !== normalized && !genericQuestionSignal(value));
  }

  async function hotNeighborhoodCached(): Promise<HotGraphNeighborhood | undefined> {
    if (!hotNeighborhoodEnabled || hotNeighborhoodNodeLimit <= 0 || hotNeighborhoodEdgeLimit <= 0) return undefined;
    if (hotNeighborhood) return hotNeighborhood;
    if (hotNeighborhoodLoad) return hotNeighborhoodLoad;
    const epoch = runtimeCacheEpoch;
    hotNeighborhoodLoad = loadHotNeighborhood(epoch).finally(() => { hotNeighborhoodLoad = undefined; });
    return hotNeighborhoodLoad;
  }

  async function loadHotNeighborhood(epoch: number): Promise<HotGraphNeighborhood | undefined> {
    try {
      const graph = await deps.storage.graph.getSlice({
        limitNodes: hotNeighborhoodNodeLimit,
        limitEdges: hotNeighborhoodEdgeLimit,
        allowLatestFallback: true
      });
      if (epoch !== runtimeCacheEpoch || !graph.nodes.length) return undefined;
      const graphEvidenceIds = uniqueKernelStrings([
        ...graph.nodes.flatMap(node => node.evidenceIds.map(String)),
        ...graph.edges.flatMap(edge => edge.evidenceIds.map(String)),
        ...graph.hyperedges.flatMap(edge => edge.provenanceRefs.map(String))
      ]).slice(0, hotNeighborhoodEvidenceLimit);
      const evidence = graphEvidenceIds.length ? await deps.storage.evidence.getEvidenceBatch(graphEvidenceIds as EvidenceSpan["id"][]) : [];
      if (epoch !== runtimeCacheEpoch) return undefined;
      const value = fitRuntimeGraphSliceToBudget({ graph, evidence }, Math.max(16 * 1024 * 1024, Math.floor(graphSliceCacheMaxBytes * 0.8)));
      const hot = buildHotNeighborhood(value);
      hotNeighborhood = hot;
      kernelTrace({
        stage: "graph.resolve",
        label: "kernel.hot_neighborhood",
        counts: {
          nodes: hot.value.graph.nodes.length,
          edges: hot.value.graph.edges.length,
          evidence: hot.value.evidence.length,
          bytes: hot.bytes,
          cacheBytes: graphSliceCacheBytes
        }
      });
      return hot;
    } catch (error) {
      failures.push(`hot neighborhood load failed: ${error instanceof Error ? error.message : String(error)}`);
      return undefined;
    }
  }

  function buildHotNeighborhood(value: RuntimeGraphSliceValue): HotGraphNeighborhood {
    const nodeById = new Map<string, GraphNode>();
    const edgeById = new Map<string, GraphEdge>();
    const hyperedgeById = new Map<string, GraphSlice["hyperedges"][number]>();
    const edgeByNodeId = new Map<string, GraphEdge[]>();
    const hyperedgeByNodeId = new Map<string, GraphSlice["hyperedges"][number][]>();
    const featureNodeIds = new Map<string, Set<string>>();
    const evidenceById = new Map<string, EvidenceSpan>();
    const evidenceNodeIds = new Map<string, Set<string>>();
    const evidenceEdgeIds = new Map<string, Set<string>>();
    const evidenceHyperedgeIds = new Map<string, Set<string>>();
    const sourceAnchorEvidenceIds = new Map<string, Set<string>>();
    for (const span of value.evidence) {
      const evidenceId = String(span.id);
      evidenceById.set(evidenceId, span);
      for (const anchor of sourceAnchorKeysForSurface(evidenceSourceAnchorSurface(span))) {
        addHotIndexValue(sourceAnchorEvidenceIds, anchor, evidenceId, 256);
      }
    }
    for (const node of value.graph.nodes) {
      const nodeId = String(node.id);
      nodeById.set(nodeId, node);
      for (const evidenceId of node.evidenceIds.map(String)) addHotIndexValue(evidenceNodeIds, evidenceId, nodeId, 1024);
      for (const feature of node.features.slice(0, 160)) {
        if (!isHighInformationRetrievalFeature(feature)) continue;
        addHotIndexValue(featureNodeIds, feature, nodeId, hotNeighborhoodPostingCap);
      }
    }
    for (const edge of value.graph.edges) {
      const edgeId = String(edge.id);
      edgeById.set(edgeId, edge);
      const source = String(edge.source);
      const target = String(edge.target);
      for (const evidenceId of edge.evidenceIds.map(String)) addHotIndexValue(evidenceEdgeIds, evidenceId, edgeId, 1024);
      const sourceEdges = edgeByNodeId.get(source) ?? [];
      sourceEdges.push(edge);
      edgeByNodeId.set(source, sourceEdges);
      const targetEdges = edgeByNodeId.get(target) ?? [];
      targetEdges.push(edge);
      edgeByNodeId.set(target, targetEdges);
    }
    for (const hyperedge of value.graph.hyperedges) {
      const hyperedgeId = String(hyperedge.id);
      hyperedgeById.set(hyperedgeId, hyperedge);
      for (const evidenceId of hyperedge.provenanceRefs.map(String)) addHotIndexValue(evidenceHyperedgeIds, evidenceId, hyperedgeId, 1024);
      for (const nodeId of hyperedge.memberNodeIds.map(String)) {
        const rows = hyperedgeByNodeId.get(nodeId) ?? [];
        rows.push(hyperedge);
        hyperedgeByNodeId.set(nodeId, rows);
      }
    }
    return {
      key: hasher.digestHex(JSON.stringify({
        nodes: value.graph.nodes.slice(0, 12).map(node => String(node.id)),
        edges: value.graph.edges.slice(0, 12).map(edge => String(edge.id)),
        evidence: value.evidence.slice(0, 12).map(span => String(span.id))
      })).slice(0, 32),
      loadedAt: clock.now(),
      bytes: estimateRuntimeGraphSliceBytes(value),
      value,
      nodeById,
      edgeById,
      hyperedgeById,
      edgeByNodeId,
      hyperedgeByNodeId,
      featureNodeIds,
      evidenceById,
      evidenceNodeIds,
      evidenceEdgeIds,
      evidenceHyperedgeIds,
      sourceAnchorEvidenceIds
    };
  }

  function addHotIndexValue(map: Map<string, Set<string>>, key: string, value: string, cap: number): void {
    if (!key || !value) return;
    const postings = map.get(key) ?? new Set<string>();
    if (postings.size < cap) postings.add(value);
    map.set(key, postings);
  }

  function sourceAnchoredEvidenceFromHot(hot: HotGraphNeighborhood, text: string): EvidenceSpan[] {
    const anchors = sourceEvidenceAnchorsForRequest(text);
    if (!anchors.length) return [];
    const evidenceIds = new Set<string>();
    for (const anchor of anchors) {
      for (const key of sourceAnchorKeysForSurface(anchor)) {
        for (const evidenceId of hot.sourceAnchorEvidenceIds.get(key) ?? []) evidenceIds.add(evidenceId);
      }
    }
    const indexedEvidence = [...evidenceIds]
      .map(id => hot.evidenceById.get(id))
      .filter((span): span is EvidenceSpan => Boolean(span));
    const candidates = indexedEvidence.length ? indexedEvidence : hot.value.evidence;
    const anchored = sourceAnchoredEvidenceForRequest(text, candidates);
    return evidenceForRequest(text, anchored.evidence).slice(0, 24);
  }

  function graphSliceFromHotEvidence(hot: HotGraphNeighborhood, anchoredEvidence: readonly EvidenceSpan[], features: string[], topicTerms: string[]): RuntimeGraphSliceValue | undefined {
    const queryFeatures = uniqueKernelStrings([
      ...features,
      ...topicTerms.flatMap(term => orderedRetrievalFeatures(term))
    ]).slice(0, 512);
    const nodeLimit = sourceAnchorHotNodeLimit;
    const edgeLimit = sourceAnchorHotEdgeLimit;
    const evidenceSeedIds = new Set(anchoredEvidence.map(span => String(span.id)));
    const selectedNodeIds = new Set<string>();
    const edgeRows = new Map<string, { edge: GraphEdge; score: number }>();
    const hyperedgeRows = new Map<string, GraphSlice["hyperedges"][number]>();
    const addEdge = (edge: GraphEdge, score: number) => {
      const edgeId = String(edge.id);
      const previous = edgeRows.get(edgeId);
      if (!previous || score > previous.score) edgeRows.set(edgeId, { edge, score });
      if (selectedNodeIds.size < nodeLimit && hot.nodeById.has(String(edge.source))) selectedNodeIds.add(String(edge.source));
      if (selectedNodeIds.size < nodeLimit && hot.nodeById.has(String(edge.target))) selectedNodeIds.add(String(edge.target));
    };

    for (const evidenceId of evidenceSeedIds) {
      for (const nodeId of hot.evidenceNodeIds.get(evidenceId) ?? []) {
        if (selectedNodeIds.size < nodeLimit) selectedNodeIds.add(nodeId);
      }
      for (const edgeId of hot.evidenceEdgeIds.get(evidenceId) ?? []) {
        const edge = hot.edgeById.get(edgeId);
        if (edge) addEdge(edge, 1 + edge.alpha + edge.weight);
      }
      for (const hyperedgeId of hot.evidenceHyperedgeIds.get(evidenceId) ?? []) {
        const hyperedge = hot.hyperedgeById.get(hyperedgeId);
        if (!hyperedge) continue;
        hyperedgeRows.set(hyperedgeId, hyperedge);
        for (const nodeId of hyperedge.memberNodeIds.map(String)) {
          if (selectedNodeIds.size < nodeLimit && hot.nodeById.has(nodeId)) selectedNodeIds.add(nodeId);
        }
      }
    }

    for (const nodeId of [...selectedNodeIds]) {
      for (const edge of hot.edgeByNodeId.get(nodeId) ?? []) {
        const source = String(edge.source);
        const target = String(edge.target);
        const touchesSelected = selectedNodeIds.has(source) || selectedNodeIds.has(target);
        if (!touchesSelected) continue;
        addEdge(edge, edge.alpha * 0.58 + edge.weight * 0.32 + (selectedNodeIds.has(source) && selectedNodeIds.has(target) ? 0.1 : 0));
      }
      for (const hyperedge of hot.hyperedgeByNodeId.get(nodeId) ?? []) hyperedgeRows.set(String(hyperedge.id), hyperedge);
    }

    const nodes = [...selectedNodeIds]
      .map(nodeId => hot.nodeById.get(nodeId))
      .filter((node): node is GraphNode => Boolean(node))
      .sort((left, right) => right.alpha - left.alpha || String(left.id).localeCompare(String(right.id)))
      .slice(0, nodeLimit);
    if (!nodes.length) return undefined;
    const nodeIds = new Set(nodes.map(node => String(node.id)));
    const edges = [...edgeRows.values()]
      .filter(row => nodeIds.has(String(row.edge.source)) || nodeIds.has(String(row.edge.target)))
      .sort((left, right) => right.score - left.score || String(left.edge.id).localeCompare(String(right.edge.id)))
      .slice(0, edgeLimit)
      .map(row => row.edge);
    const hyperedges = [...hyperedgeRows.values()]
      .filter(edge => edge.memberNodeIds.some(nodeId => nodeIds.has(String(nodeId))))
      .slice(0, Math.max(64, Math.floor(edgeLimit / 4)));
    return {
      graph: {
        nodes,
        edges,
        hyperedges,
        bounded: true,
        query: { evidenceIds: anchoredEvidence.map(span => span.id), features: queryFeatures, topicTerms, radius: 2, limitNodes: nodeLimit, limitEdges: edgeLimit }
      },
      evidence: mergeEvidenceSpans([...anchoredEvidence])
    };
  }

  function sourceAnchorKeysForSurface(surface: string): string[] {
    const normalized = normalizePriorKey(surface);
    const units = splitPriorUnits(normalized).filter(unit => unit.length >= 2);
    if (!units.length) return [];
    const keys: string[] = [normalized];
    for (let width = 2; width <= Math.min(4, units.length); width++) {
      for (let index = 0; index <= units.length - width; index++) keys.push(units.slice(index, index + width).join(" "));
    }
    if (units.length === 1 && units[0]!.length >= 4) keys.push(units[0]!);
    return uniqueKernelStrings(keys.filter(Boolean)).slice(0, 32);
  }

  function graphSliceFromHotNeighborhood(hot: HotGraphNeighborhood, features: string[], topicTerms: string[]): RuntimeGraphSliceValue | undefined {
    const queryFeatures = uniqueKernelStrings([
      ...features,
      ...topicTerms.flatMap(term => orderedRetrievalFeatures(term))
    ]).slice(0, 512);
    const ranked = rankHotNeighborhoodNodes(hot, queryFeatures);
    if (!ranked.length || ranked[0]!.score < 0.04) return undefined;
    const nodeLimit = 420;
    const edgeLimit = 900;
    const selectedNodeIds = new Set<string>();
    for (const row of ranked.slice(0, nodeLimit)) selectedNodeIds.add(row.nodeId);
    const edgeRows = new Map<string, { edge: GraphEdge; score: number }>();
    for (const nodeId of [...selectedNodeIds]) {
      for (const edge of hot.edgeByNodeId.get(nodeId) ?? []) {
        const source = String(edge.source);
        const target = String(edge.target);
        if (selectedNodeIds.size < nodeLimit) {
          if (hot.nodeById.has(source)) selectedNodeIds.add(source);
          if (hot.nodeById.has(target)) selectedNodeIds.add(target);
        }
        const touchesSelected = selectedNodeIds.has(source) || selectedNodeIds.has(target);
        if (!touchesSelected) continue;
        const score = edge.alpha * 0.58 + edge.weight * 0.32 + (selectedNodeIds.has(source) && selectedNodeIds.has(target) ? 0.1 : 0);
        const previous = edgeRows.get(String(edge.id));
        if (!previous || score > previous.score) edgeRows.set(String(edge.id), { edge, score });
      }
    }
    const nodes = [...selectedNodeIds]
      .map(nodeId => hot.nodeById.get(nodeId))
      .filter((node): node is GraphNode => Boolean(node))
      .sort((left, right) => right.alpha - left.alpha || String(left.id).localeCompare(String(right.id)))
      .slice(0, nodeLimit);
    if (!nodes.length) return undefined;
    const nodeIds = new Set(nodes.map(node => String(node.id)));
    const edges = [...edgeRows.values()]
      .filter(row => nodeIds.has(String(row.edge.source)) || nodeIds.has(String(row.edge.target)))
      .sort((left, right) => right.score - left.score || String(left.edge.id).localeCompare(String(right.edge.id)))
      .slice(0, edgeLimit)
      .map(row => row.edge);
    const hyperedges = uniqueById([...nodeIds].flatMap(nodeId => hot.hyperedgeByNodeId.get(nodeId) ?? []))
      .filter(edge => edge.memberNodeIds.some(nodeId => nodeIds.has(String(nodeId))))
      .slice(0, Math.max(64, Math.floor(edgeLimit / 4)));
    const evidenceIds = uniqueKernelStrings([
      ...nodes.flatMap(node => node.evidenceIds.map(String)),
      ...edges.flatMap(edge => edge.evidenceIds.map(String)),
      ...hyperedges.flatMap(edge => edge.provenanceRefs.map(String))
    ]).slice(0, 80);
    const evidence = evidenceIds
      .map(id => hot.evidenceById.get(id))
      .filter((span): span is EvidenceSpan => Boolean(span));
    return {
      graph: {
        nodes,
        edges,
        hyperedges,
        bounded: true,
        query: { features: queryFeatures, topicTerms, radius: 2, limitNodes: nodeLimit, limitEdges: edgeLimit }
      },
      evidence
    };
  }

  function rankHotNeighborhoodNodes(hot: HotGraphNeighborhood, features: readonly string[]): Array<{ nodeId: string; score: number }> {
    const scores = new Map<string, number>();
    features.slice(0, 256).forEach((feature, index) => {
      const postings = hot.featureNodeIds.get(feature);
      if (!postings) return;
      const weight = 1 / Math.max(1, Math.sqrt(index + 1));
      for (const nodeId of postings) scores.set(nodeId, (scores.get(nodeId) ?? 0) + weight);
    });
    return [...scores.entries()]
      .map(([nodeId, overlap]) => {
        const node = hot.nodeById.get(nodeId);
        return node ? { nodeId, score: overlap + node.alpha * 0.2 } : undefined;
      })
      .filter((row): row is { nodeId: string; score: number } => Boolean(row))
      .sort((left, right) => right.score - left.score || left.nodeId.localeCompare(right.nodeId));
  }

  async function graphForTextUncached(text: string, features = graphRetrievalFeatures(text), topicTerms = graphTopicTermsForText(text)): Promise<RuntimeGraphSliceValue> {
    const evidenceResults = await deps.storage.evidence.searchEvidence({ features, limit: 40 });
    const evidenceIds = evidenceResults.map(item => item.span.id);
    const graph = await deps.storage.graph.getSlice({ evidenceIds, features, topicTerms, radius: 2, limitNodes: 420, limitEdges: 900 });
    const graphEvidenceIds = uniqueKernelStrings([
      ...evidenceIds.map(String),
      ...graph.nodes.flatMap(node => node.evidenceIds.map(String)),
      ...graph.edges.flatMap(edge => edge.evidenceIds.map(String)),
      ...graph.hyperedges.flatMap(edge => edge.provenanceRefs.map(String))
    ]).slice(0, 80);
    const graphEvidence = graphEvidenceIds.length ? await deps.storage.evidence.getEvidenceBatch(graphEvidenceIds as EvidenceSpan["id"][]) : [];
    return { graph, evidence: mergeEvidenceSpans([...evidenceResults.map(item => item.span), ...graphEvidence]) };
  }

  function retrievalTextForTurn(input: OwnerInput): string {
    return input.text;
  }

  async function evidenceFromTurnMetadata(metadata: JsonValue | undefined): Promise<EvidenceSpan[]> {
    const ids = runtimeEvidenceIdsFromMetadata(metadata);
    if (!ids.length) return [];
    const spans = await deps.storage.evidence.getEvidenceBatch(ids as EvidenceSpan["id"][]);
    return spans.filter(span => span.status === "promoted");
  }

  function runtimeEvidenceIdsFromMetadata(metadata: JsonValue | undefined): string[] {
    const record = jsonRecord(metadata);
    const webLearning = jsonRecord(record.webLearning);
    return uniqueKernelStrings([
      ...kernelStringArray(record.runtimeEvidenceIds),
      ...kernelStringArray(record.evidenceIds),
      ...kernelStringArray(webLearning.promotedEvidenceIds)
    ]).slice(0, 80);
  }

  function sessionEvidenceFromMetadata(metadata: JsonValue | undefined): EvidenceSpan[] {
    const session = jsonRecord(jsonRecord(metadata).session);
    const discourseObject = discourseObjectStateFromMetadata(metadata);
    const sessionId = kernelString(session.sessionId);
    const recentTurns = Array.isArray(session.recentTurns) ? session.recentTurns : [];
    if (!sessionId || !recentTurns.length) return [];
    const sessionHash = hasher.digestHex(sessionId).slice(0, 24);
    const sourceId = `source_session_${sessionHash}` as EvidenceSpan["sourceId"];
    const sourceVersionId = `source_version_session_${sessionHash}` as EvidenceSpan["sourceVersionId"];
    return recentTurns
      .map((value, index): EvidenceSpan | undefined => {
        const record = jsonRecord(value as JsonValue);
        const text = (kernelString(record.text) ?? "").trim();
        if (!text) return undefined;
        const roleId = kernelString(record.roleId) || "session.role.unknown";
        const ownerTurn = roleId === "session.role.owner";
        const turnId = kernelString(record.id) || `${sessionId}:${index}`;
        const discourseBoundTurn = discourseObject?.mentionIds.includes(turnId) === true;
        const discourseFeature = discourseBoundTurn ? `disc:${discourseObject.objectId.replace(/^.*_([0-9a-f]+)$/u, "$1")}` : undefined;
        const episodeId = kernelString(record.episodeId);
        const createdAt = kernelNumber(record.createdAt) ?? clock.now();
        const spanHash = hasher.digestHex(`${sessionId}\n${turnId}\n${roleId}\n${text}`);
        return {
          id: `evidence_session_${spanHash.slice(0, 48)}` as EvidenceSpan["id"],
          sourceId,
          sourceVersionId,
          chunkId: `chunk_session_${spanHash.slice(0, 48)}` as EvidenceSpan["chunkId"],
          contentHash: `sha256_${spanHash}` as EvidenceSpan["contentHash"],
          mediaType: "application/scce-session-turn+json",
          byteStart: 0,
          byteEnd: text.length,
          charStart: 0,
          charEnd: [...text].length,
          text,
          textPreview: text.replace(/\s+/g, " ").slice(0, 700),
          languageHints: {},
          scriptHints: {},
          trustVector: toJsonValue({ trust: ownerTurn ? 0.96 : 0.62, sourceTrust: ownerTurn ? 0.96 : 0.62, forceClass: ownerTurn ? "session_owner_turn_evidence" : "session_assistant_turn_context" }),
          provenance: toJsonValue({ sourceSystem: "conversation-session", sessionId, turnId, roleId, episodeId, createdAt, discourseObjectId: discourseBoundTurn ? discourseObject?.objectId : null }),
          features: [...new Set([...featureSet(text, 512), `session:${sessionHash}`, `role:${roleId}`, ...(discourseFeature ? [discourseFeature] : [])])].slice(0, 560),
          status: ownerTurn ? "promoted" : "quarantined",
          alpha: ownerTurn ? 0.88 : 0.48,
          observedAt: createdAt
        };
      })
      .filter((span): span is EvidenceSpan => Boolean(span));
  }

  function currentOwnerSessionEvidence(input: OwnerInput): EvidenceSpan[] {
    const session = jsonRecord(jsonRecord(input.metadata).session);
    const sessionId = kernelString(session.sessionId);
    if (!sessionId || !sessionObservationSurface(input.text)) return [];
    return sessionEvidenceRecords({
      sessionId,
      turns: [{
        id: `current:${hasher.digestHex(input.text).slice(0, 24)}`,
        roleId: "session.role.owner",
        text: input.text,
        createdAt: clock.now()
      }]
    });
  }

  function sessionEvidenceRecords(input: { sessionId: string; turns: Array<{ id: string; roleId: string; text: string; episodeId?: string; createdAt: number }> }): EvidenceSpan[] {
    const sessionHash = hasher.digestHex(input.sessionId).slice(0, 24);
    const sourceId = `source_session_${sessionHash}` as EvidenceSpan["sourceId"];
    const sourceVersionId = `source_version_session_${sessionHash}` as EvidenceSpan["sourceVersionId"];
    return input.turns
      .map((turn): EvidenceSpan | undefined => {
        const text = turn.text.trim();
        if (!text) return undefined;
        const roleId = turn.roleId || "session.role.unknown";
        const ownerTurn = roleId === "session.role.owner";
        const spanHash = hasher.digestHex(`${input.sessionId}\n${turn.id}\n${roleId}\n${text}`);
        return {
          id: `evidence_session_${spanHash.slice(0, 48)}` as EvidenceSpan["id"],
          sourceId,
          sourceVersionId,
          chunkId: `chunk_session_${spanHash.slice(0, 48)}` as EvidenceSpan["chunkId"],
          contentHash: `sha256_${spanHash}` as EvidenceSpan["contentHash"],
          mediaType: "application/scce-session-turn+json",
          byteStart: 0,
          byteEnd: text.length,
          charStart: 0,
          charEnd: [...text].length,
          text,
          textPreview: text.replace(/\s+/g, " ").slice(0, 700),
          languageHints: toJsonValue({}),
          scriptHints: toJsonValue({}),
          trustVector: toJsonValue({ trust: ownerTurn ? 0.96 : 0.62, sourceTrust: ownerTurn ? 0.96 : 0.62, forceClass: ownerTurn ? "session_owner_turn_evidence" : "session_assistant_turn_context" }),
          provenance: toJsonValue({ sourceSystem: "conversation-session", sessionId: input.sessionId, turnId: turn.id, roleId, episodeId: turn.episodeId ?? null, createdAt: turn.createdAt }),
          features: [...new Set([...featureSet(text, 512), `session:${sessionHash}`, `role:${roleId}`])].slice(0, 560),
          status: ownerTurn ? "promoted" as const : "quarantined" as const,
          alpha: ownerTurn ? 0.88 : 0.48,
          observedAt: turn.createdAt
        };
      })
      .filter((span): span is EvidenceSpan => Boolean(span));
  }

  function sessionObservationSurface(text: string): boolean {
    const clean = text.trim();
    if (!clean || /[\u003f\u0021\uFF1F\uFF01]$/u.test(clean)) return false;
    return /\p{Terminal_Punctuation}$/u.test(clean);
  }

  function mergeEvidenceSpans(spans: EvidenceSpan[]): EvidenceSpan[] {
    const byId = new Map<string, EvidenceSpan>();
    for (const span of spans) if (!byId.has(String(span.id))) byId.set(String(span.id), span);
    return [...byId.values()];
  }

  function evidenceMatchesSourceAnchor(span: EvidenceSpan, anchors: readonly EvidenceSpan[]): boolean {
    const spanId = String(span.id);
    const sourceId = String(span.sourceId);
    const sourceVersionId = String(span.sourceVersionId);
    return anchors.some(anchor =>
      String(anchor.id) === spanId ||
      String(anchor.sourceId) === sourceId ||
      String(anchor.sourceVersionId) === sourceVersionId
    );
  }

  function graphRetrievalFeatures(text: string): string[] {
    const features = new Map<string, true>();
    const add = (feature: string) => {
      if (isHighInformationRetrievalFeature(feature)) features.set(feature, true);
    };
    for (const term of graphTopicTermsForText(text)) {
      for (const feature of orderedRetrievalFeatures(term)) add(feature);
    }
    for (const anchor of namedSubjectAnchors(text).slice(0, 6)) {
      for (const feature of orderedRetrievalFeatures(anchor)) add(feature);
    }
    for (const anchor of sourceEvidenceAnchorsForRequest(text).slice(0, 16)) {
      for (const feature of orderedRetrievalFeatures(anchor)) features.set(feature, true);
    }
    for (const feature of featureSet(requestContentSurface(text), 256)) add(feature);
    return [...features.keys()].slice(0, 256);
  }

  function isHighInformationRetrievalFeature(feature: string): boolean {
    if (feature.startsWith("tri:")) return retrievalFeatureUnits(feature).filter(highInformationUnit).length >= 2;
    if (feature.startsWith("bi:")) return retrievalFeatureUnits(feature).every(highInformationUnit);
    if (feature.startsWith("sym:")) return highInformationUnit(feature.slice(4));
    return false;
  }

  function orderedRetrievalFeatures(surface: string): string[] {
    const units = splitPriorUnits(normalizePriorKey(surface)).filter(Boolean);
    const out: string[] = [];
    for (const unit of units) out.push(`sym:${unit}`);
    for (let index = 0; index < units.length - 1; index++) out.push(`bi:${units[index]}|${units[index + 1]}`);
    for (let index = 0; index < units.length - 2; index++) out.push(`tri:${units[index]}|${units[index + 1]}|${units[index + 2]}`);
    return out;
  }

  function retrievalFeatureUnits(feature: string): string[] {
    const index = feature.indexOf(":");
    const body = index >= 0 ? feature.slice(index + 1) : feature;
    return body.split("|").filter(Boolean);
  }

  function highInformationUnit(unit: string): boolean {
    const normalized = normalizePriorKey(unit);
    if (normalized.length < 4) return false;
    if (genericQuestionSignal(normalized)) return false;
    return true;
  }

  function graphTopicTermsForText(text: string): string[] {
    const focuses = relevanceRequestFocuses(text).slice(0, 10);
    const phrases: string[] = [];
    for (let index = 0; index < focuses.length - 1; index++) {
      const left = focuses[index] ?? "";
      const right = focuses[index + 1] ?? "";
      if (left.length >= 3 && right.length >= 3) phrases.push(`${left} ${right}`);
    }
    for (let index = 0; index < focuses.length - 2; index++) {
      const left = focuses[index] ?? "";
      const middle = focuses[index + 1] ?? "";
      const right = focuses[index + 2] ?? "";
      if (left.length >= 3 && middle.length >= 3 && right.length >= 3) phrases.push(`${left} ${middle} ${right}`);
    }
    return uniqueKernelStrings([...phrases, ...focuses]).slice(0, 16);
  }

  const kernel: ScceKernel = {
    async warmup(input: RuntimeWarmupInput = {}): Promise<RuntimeWarmupResult> {
      const started = clock.now();
      const failures: string[] = [];
      const result: RuntimeWarmupResult = {
        schema: "scce.runtime_warmup.v1",
        totalMs: 0,
        failures
      };
      const languageLimit = Math.max(1, Math.min(256, Math.floor(input.languageLimit ?? 36)));
      const tasks: Array<Promise<void>> = [];

      if (input.graph ?? true) {
        tasks.push(hotNeighborhoodCached()
          .then(hot => {
            const graph = hot?.value.graph;
            result.graph = {
              loaded: Boolean(hot),
              nodes: graph?.nodes.length ?? 0,
              edges: graph?.edges.length ?? 0,
              hyperedges: graph?.hyperedges.length ?? 0,
              evidence: hot?.value.evidence.length ?? 0,
              bytes: hot?.bytes ?? 0
            };
          })
          .catch(error => {
            failures.push(`graph warmup failed: ${error instanceof Error ? error.message : String(error)}`);
            result.graph = { loaded: false, nodes: 0, edges: 0, hyperedges: 0, evidence: 0, bytes: 0 };
          }));
      }

      if (input.language ?? true) {
        tasks.push(hydrateSurfaceLanguageMemoryCached(languageLimit)
          .then(language => {
            result.language = {
              loaded: true,
              models: language.models.length,
              observations: language.observations.length,
              units: language.units.length,
              patterns: language.patterns.length,
              semanticFrames: language.semanticFrames.length
            };
          })
          .catch(error => {
            failures.push(`language warmup failed: ${error instanceof Error ? error.message : String(error)}`);
            result.language = { loaded: false, models: 0, observations: 0, units: 0, patterns: 0, semanticFrames: 0 };
          }));
      }

      if (input.brain ?? true) {
        tasks.push(activeBrainMarker()
          .then(() => { result.brain = { loaded: true }; })
          .catch(error => {
            failures.push(`brain warmup failed: ${error instanceof Error ? error.message : String(error)}`);
            result.brain = { loaded: false };
          }));
      }

      if (input.profile ?? true) {
        tasks.push(surfaceLanguageProfileCached()
          .then(profile => { result.profile = { loaded: Boolean(profile) }; })
          .catch(error => {
            failures.push(`profile warmup failed: ${error instanceof Error ? error.message : String(error)}`);
            result.profile = { loaded: false };
          }));
      }

      if (input.corrections ?? true) {
        tasks.push(correctionRulesCached()
          .then(rules => { result.corrections = { loaded: true, rules: rules.length }; })
          .catch(error => {
            failures.push(`correction warmup failed: ${error instanceof Error ? error.message : String(error)}`);
            result.corrections = { loaded: false, rules: 0 };
          }));
      }

      await Promise.all(tasks);
      result.totalMs = Math.max(0, clock.now() - started);
      kernelTrace({
        stage: "runtime.start",
        label: "kernel.warmup",
        durationMs: result.totalMs,
        counts: {
          graphNodes: result.graph?.nodes ?? 0,
          graphEdges: result.graph?.edges ?? 0,
          evidence: result.graph?.evidence ?? 0,
          languageModels: result.language?.models ?? 0,
          languageUnits: result.language?.units ?? 0,
          failures: failures.length
        },
        support: { warmup: result as unknown as Record<string, unknown> }
      });
      return result;
    },

    async ingest(input: IngestInput): Promise<IngestResult> {
      const episodeId = idFactory.episodeId();
      const events: ScceEvent[] = [];
      events.push(await append(eventFactory.create({ episodeId, typeId: "OwnerAsked", payload: { ingest: input.path ?? input.uri ?? "inline", metadata: input.metadata ?? null } })));
      let sources = 0;
      let fileCount = 0;
      let evidenceCount = 0;
      let graphNodes = 0;
      let graphEdges = 0;
      let languageProfiles = 0;
      const typedObservationCounts: Record<string, number> = {};
      const observationRouteCounts: Record<string, number> = {};
      const skipped: Array<{ path: string; reason: string }> = [];
      const stream = input.content !== undefined
        ? inlineIngestStream(input, clock.now(), hasher)
        : deps.files.streamPath(input.path ?? input.uri ?? ".", { metadata: input.metadata });
      for await (const item of stream) {
        await deps.storage.ingestion.put(item.checkpoint);
        if (item.type === "checkpoint") continue;
        if (item.type === "skipped") {
          skipped.push(item.skipped);
          continue;
        }
        const file = item.file;
        fileCount++;
        const now = clock.now();
        const contentHash = await deps.storage.blobs.put(file.bytes, file.mediaType);
        const sourceId = idFactory.sourceId(file.namespace, file.uri);
        const sourceVersionId = idFactory.sourceVersionId(file.bytes);
        const source: SourceVersion = {
          sourceId,
          sourceVersionId,
          namespace: file.namespace,
          canonicalUri: file.uri,
          contentHash,
          mediaType: file.mediaType,
          observedAt: now,
          byteLength: file.bytes.byteLength,
          trust: 0.82,
          metadata: file.metadata
        };
        await deps.storage.evidence.putSourceVersion(source);
        events.push(await append(eventFactory.create({ episodeId, typeId: "SourceObserved", payload: { sourceId, uri: file.uri, namespace: file.namespace } })));
        events.push(await append(eventFactory.create({ episodeId, typeId: "SourceVersionObserved", payload: { sourceVersionId, contentHash, byteLength: file.bytes.byteLength } })));
        sources++;
        const preview = typedIngest.preview({ uri: file.uri, mediaType: file.mediaType, text: file.text, metadata: file.metadata });
        const languageSurface = preview.languageText || (preview.suppressRawLanguageTraining ? "" : file.text);
        const profile = language.acquire({ sourceVersionId, text: languageSurface, createdAt: now });
        if (deps.storage.model.putLanguageProfiles) await deps.storage.model.putLanguageProfiles([profile]);
        else await deps.storage.model.putLanguageProfile(profile);
        events.push(await append(eventFactory.create({ episodeId, typeId: "LanguagePatternLearned", payload: { profileId: profile.id, scripts: profile.scripts.slice(0, 4), entropy: profile.entropy } })));
        languageProfiles++;
        const extracted = evidenceExtractor.extract({
          sourceId,
          sourceVersionId,
          namespace: file.namespace,
          uri: file.uri,
          mediaType: file.mediaType,
          text: file.text,
          languageProfile: profile,
          observedAt: now,
          maxChunkBytes: deps.maxChunkBytes ?? 131072,
          metadata: file.metadata
        });
        const decision = admission.decide({ source, evidence: extracted.spans, metadata: file.metadata });
        await deps.storage.quarantine.put({
          id: `${sourceVersionId}:admission`,
          sourceId,
          sourceVersionId,
          uri: file.uri,
          contentHash,
          mediaType: file.mediaType,
          fetchedAt: now,
          trustVector: decision.audit,
          permissionVector: { disposition: decision.disposition, safetyRails: decision.safetyRails },
          decision: decision.disposition === "reject" ? "rejected" : decision.disposition === "promote" ? "promoted" : "pending",
          decisionJson: decision.audit
        });
        events.push(await append(eventFactory.create({ episodeId, typeId: decision.disposition === "promote" ? "SourcePromoted" : "SourceQuarantined", payload: decision.audit })));
        if (decision.disposition === "reject") {
          events.push(await append(eventFactory.create({ episodeId, typeId: "FailureObserved", payload: { sourceVersionId, reasons: decision.reasons } })));
          continue;
        }
        const actionByEvidence = new Map(decision.evidenceActions.map(action => [action.evidenceId, action]));
        const admittedSpans = extracted.spans.map(span => {
          const action = actionByEvidence.get(String(span.id));
          return {
            ...span,
            alpha: action?.action === "lower-alpha" ? Math.min(span.alpha, action.alpha) : span.alpha,
            status: decision.disposition === "promote" ? "promoted" as const : "quarantined" as const,
            trustVector: { ...(span.trustVector as Record<string, JsonValue>), admission: decision.audit, action: action?.action ?? "quarantine" }
          };
        });
        for (const span of admittedSpans) await deps.storage.blobs.put(Buffer.from(span.text, "utf8"), file.mediaType);
        if (deps.storage.evidence.putEvidenceSpans) await deps.storage.evidence.putEvidenceSpans(admittedSpans);
        else for (const span of admittedSpans) await deps.storage.evidence.putEvidenceSpan(span);
        evidenceCount += admittedSpans.length;
        const typedProjection = typedIngest.project({
          sourceId,
          sourceVersionId,
          uri: file.uri,
          mediaType: file.mediaType,
          text: file.text,
          metadata: file.metadata,
          evidence: admittedSpans,
          observedAt: now
        });
        for (const [kind, count] of Object.entries(typedProjection.observationCounts)) typedObservationCounts[kind] = (typedObservationCounts[kind] ?? 0) + count;
        const routeCounts = routeStoreCounts(typedProjection.routes);
        for (const [store, count] of Object.entries(routeCounts)) observationRouteCounts[store] = (observationRouteCounts[store] ?? 0) + count;
        if (deps.storage.graph.upsertNodes) await deps.storage.graph.upsertNodes(typedProjection.graphNodes);
        else for (const graphNode of typedProjection.graphNodes) await deps.storage.graph.upsertNode(graphNode);
        if (deps.storage.graph.upsertEdges) await deps.storage.graph.upsertEdges(typedProjection.graphEdges);
        else for (const graphEdge of typedProjection.graphEdges) await deps.storage.graph.upsertEdge(graphEdge);
        graphNodes += typedProjection.graphNodes.length;
        graphEdges += typedProjection.graphEdges.length;
        events.push(await append(eventFactory.create({ episodeId, typeId: "GraphUpdated", payload: { typedIngest: typedProjection.diagnostics } })));

        const languageMemory = typedProjection.languageText.trim() ? languageMemoryRuntime.observe({
          streamId: file.uri,
          profile,
          sourceVersionId,
          text: typedProjection.languageText,
          evidence: admittedSpans,
          createdAt: now,
          maxOrder: 6,
          maxCountersPerOrder: 12000,
          vocabularyLimit: 24000
        }) : undefined;
        if (languageMemory) {
        await deps.storage.languageMemory.putNgramObservationsBatch(languageMemory.observations);
        if (deps.storage.languageMemory.putNgramModels) await deps.storage.languageMemory.putNgramModels(languageMemory.models);
        else for (const model of languageMemory.models) await deps.storage.languageMemory.putNgramModel(model);
        if (deps.storage.languageMemory.putLanguageUnits) await deps.storage.languageMemory.putLanguageUnits(languageMemory.units);
        else for (const unit of languageMemory.units) await deps.storage.languageMemory.putLanguageUnit(unit);
        if (deps.storage.languageMemory.putLanguagePatterns) await deps.storage.languageMemory.putLanguagePatterns(languageMemory.patterns);
        else for (const pattern of languageMemory.patterns) await deps.storage.languageMemory.putLanguagePattern(pattern);
        if (deps.storage.languageMemory.putSemanticFrames) await deps.storage.languageMemory.putSemanticFrames(languageMemory.semanticFrames);
        else for (const frame of languageMemory.semanticFrames) await deps.storage.languageMemory.putSemanticFrame(frame);
        events.push(await append(eventFactory.create({ episodeId, typeId: "SymbolPatternLearned", payload: languageMemory.audit })));
        } else {
          events.push(await append(eventFactory.create({ episodeId, typeId: "SymbolPatternLearned", payload: { skipped: "no language-bearing observations", uri: file.uri, typedIngest: typedProjection.diagnostics } })));
        }
        const builtGraph = graphBuilder.build({ sourceVersionId, uri: file.uri, mediaType: file.mediaType, languageProfile: profile, evidence: admittedSpans, observedAt: now });
        if (deps.storage.graph.upsertNodes) await deps.storage.graph.upsertNodes(builtGraph.nodes);
        else for (const graphNode of builtGraph.nodes) await deps.storage.graph.upsertNode(graphNode);
        if (deps.storage.graph.upsertEdges) await deps.storage.graph.upsertEdges(builtGraph.edges);
        else for (const graphEdge of builtGraph.edges) await deps.storage.graph.upsertEdge(graphEdge);
        if (deps.storage.graph.upsertHyperedges) await deps.storage.graph.upsertHyperedges(builtGraph.hyperedges);
        else for (const hyperedge of builtGraph.hyperedges) await deps.storage.graph.upsertHyperedge(hyperedge);
        graphNodes += builtGraph.nodes.length;
        graphEdges += builtGraph.edges.length;
        await deps.storage.ingestion.put({ ...item.checkpoint, phase: "stored", status: "complete", offsetBytes: file.bytes.byteLength, contentHash, byteLength: file.bytes.byteLength, updatedAt: clock.now(), metadata: { ...(item.checkpoint.metadata as Record<string, JsonValue>), typedIngest: typedProjection.diagnostics } });
        events.push(await append(eventFactory.create({ episodeId, typeId: "EvidenceLinked", payload: { sourceVersionId, diagnostics: extracted.diagnostics } })));
        events.push(await append(eventFactory.create({ episodeId, typeId: "GraphUpdated", payload: builtGraph.diagnostics })));
      }
      lastEpisodeId = episodeId;
      lastOutput = `ingested ${sources} source version(s), ${evidenceCount} evidence span(s), ${sumRecord(typedObservationCounts)} typed observation(s)`;
      if (sources || evidenceCount || graphNodes || graphEdges || languageProfiles) invalidateRuntimeCaches();
      events.push(await append(eventFactory.create({ episodeId, typeId: "EpisodeClosed", payload: { output: lastOutput, typedObservations: typedObservationCounts, observationRoutes: observationRouteCounts } })));
      return { episodeId, files: fileCount, sources, evidence: evidenceCount, graphNodes, graphEdges, languageProfiles, typedObservations: typedObservationCounts, observationRoutes: observationRouteCounts, skipped, events };
    },

    async train(input: TrainInput): Promise<TrainResult> {
      const episodeId = idFactory.episodeId();
      const events: ScceEvent[] = [];
      let model = await deps.storage.model.readModel();
      const slice = await deps.storage.graph.getSlice({ limitNodes: 2000, limitEdges: 4000, allowLatestFallback: true });
      const featureSketches = featureSketchLearner.learn(slice.nodes, 24);
      const pending = await deps.storage.quarantine.listPending({ limit: 500 });
      let profiles = await deps.storage.model.listLanguageProfiles(200);
      const evidenceForLearning = (await deps.storage.evidence.searchEvidence({ features: [...new Set(slice.nodes.flatMap(node => node.features.slice(0, 16)))].slice(0, 128), limit: 200 })).map(item => item.span);
      const plan = learning.plan({ config: input.config, model, graph: slice, pending, profiles, candidateEvidence: evidenceForLearning });
      const eviPlan = learningLoop.plan({ goals: input.config.learningGoals ?? model.learningGoals, model, graph: slice, evidence: evidenceForLearning, languageProfiles: profiles });
      const mvpTrainPlan = trainingOrchestrator.plan({ train: input, evidence: evidenceForLearning, modelState: model, policy });
      const promotionIds = trainingPromotionEvidenceIds(mvpTrainPlan);
      const promoted = await deps.storage.evidence.promoteEvidence(promotionIds, trainingPromotionReason(input, plan, mvpTrainPlan));
      const trainingLanguage = await persistTrainingLanguageMemory(evidenceForLearning.filter(span => promotionIds.some(id => String(id) === String(span.id))), profiles, mvpTrainPlan.id);
      profiles = trainingLanguage.profiles;
      model = learning.updateModel(model, plan, profiles);
      // Keep the historical model_state key for JSON compatibility; the
      // records themselves are explicitly labelled weighted feature sketches.
      model.latentConcepts = featureSketches;
      if (input.config.policy) Object.assign(policy, input.config.policy);
      await deps.storage.model.writeModel(model);
      events.push(await append(eventFactory.create({ episodeId, typeId: "LearningPlanBuilt", payload: plan.audit })));
      events.push(await append(eventFactory.create({ episodeId, typeId: "LearningPlanBuilt", payload: eviPlan.audit })));
      events.push(await append(eventFactory.create({ episodeId, typeId: "LearningPlanBuilt", payload: mvpTrainPlan.audit })));
      events.push(await append(eventFactory.create({ episodeId, typeId: "LearningPromoted", payload: { promotedEvidence: promoted, selectedEvidenceIds: promotionIds.map(String), weightedFeatureSketches: featureSketches.length, legacyModelStateKey: "latentConcepts", languageProfiles: profiles.length, trainingLanguage: trainingLanguage.audit, promotionPlan: plan.promotion, trainingPromotion: mvpTrainPlan.promotion.slice(0, 64).map(item => ({ evidenceId: item.evidenceId, promote: item.promote, score: item.score, reasons: item.reasons })) } })));
      const selfState = await createFunctionalSelfModel({ storage: deps.storage, model, policy, recentFailures: failures });
      const trainField = fieldEngine.activate({ text: model.learningGoals.join("\n"), nodes: slice.nodes, edges: slice.edges });
      const trainForecastState = prediction.state({ episodeId, graph: slice, alphaTrace: trainField.alphaTrace, t: clock.now() });
      const trainSsd = ssd.distill({ model, graph: slice, state: trainForecastState, self: selfState });
      const trainFcs = fcs.score({ self: selfState, ssd: trainSsd });
      events.push(await append(eventFactory.create({ episodeId, typeId: "SelfModelProjected", payload: { self: selfState, selfDistillation: trainSsd.audit, fcs: trainFcs.audit } })));
      lastEpisodeId = episodeId;
      lastOutput = `trained ${featureSketches.length} weighted feature sketch(es), promoted ${promoted} evidence span(s)`;
      invalidateRuntimeCaches();
      events.push(await append(eventFactory.create({ episodeId, typeId: "EpisodeClosed", payload: { output: lastOutput } })));
      return { episodeId, promotedEvidence: promoted, featureSketches: featureSketches.length, latentConcepts: featureSketches.length, languageProfiles: profiles.length, learningGoals: model.learningGoals, events };
    },

    async turn(input: OwnerInput): Promise<TurnResult> {
      return withBufferedEventWrites(async () => {
      const turnStarted = Date.now();
      const timingParts: Record<string, number> = {};
      let timingStageStarted = turnStarted;
      const markTiming = (stage: "seedMs" | "graphSliceMs" | "proofMs" | "candidateMs" | "planningMs" | "mouthMs" | "validationMs" | "forecastMs" | "maintenanceMs"): void => {
        const now = Date.now();
        timingParts[stage] = now - timingStageStarted;
        timingStageStarted = now;
      };
      const buildTiming = (persistenceMode: "foreground" | "deferred"): NonNullable<TurnResult["timing"]> => {
        const budgetsMs = { graphSlice: 100, proof: 150, mouth: 300, total: 2500 };
        const totalMs = Date.now() - turnStarted;
        const budgetExceeded: string[] = [];
        if ((timingParts.graphSliceMs ?? 0) > budgetsMs.graphSlice) budgetExceeded.push("graphSlice");
        if ((timingParts.proofMs ?? 0) > budgetsMs.proof) budgetExceeded.push("proof");
        if ((timingParts.mouthMs ?? 0) > budgetsMs.mouth) budgetExceeded.push("mouth");
        if (totalMs > budgetsMs.total) budgetExceeded.push("total");
        return {
          schema: "scce.turn_timing.v1",
          totalMs,
          seedMs: timingParts.seedMs,
          graphSliceMs: timingParts.graphSliceMs,
          proofMs: timingParts.proofMs,
          candidateMs: timingParts.candidateMs,
          planningMs: timingParts.planningMs,
          mouthMs: timingParts.mouthMs,
          validationMs: timingParts.validationMs,
          forecastMs: timingParts.forecastMs,
          maintenanceMs: timingParts.maintenanceMs,
          persistenceMode,
          budgetsMs,
          budgetExceeded
        };
      };
      const turnContract = (args: Omit<Parameters<typeof launchContractForTurn>[0], "now">) =>
        launchContractForTurn({ ...args, now: clock.now() });
      const episodeId = idFactory.episodeId();
      const evaluationTrace = deps.evaluationCondition
        ? createEvaluationTrace(deps.evaluationCondition, {
          traceId: `eval-trace-${hasher.digestHex(`${deps.evaluationCondition.configHash}:${String(episodeId)}`).slice(0, 32)}`,
          runId: deps.evaluationRunId?.trim() || deps.evaluationCondition.cacheNamespace,
          questionId: evaluationQuestionId(input.metadata, episodeId)
        }, { nowIso: () => deps.evaluationCondition!.clockIso })
        : undefined;
      const evaluationComponent = <T>(
        component: EvaluationComponentId,
        boundary: string,
        execute: () => T,
        bypass: () => T
      ): T => deps.evaluationCondition && evaluationTrace
        ? executeEvaluationComponent({ condition: deps.evaluationCondition, trace: evaluationTrace, component, boundary, execute, bypass })
        : execute();
      const fieldEvaluation = deps.evaluationCondition && evaluationTrace
        ? { condition: deps.evaluationCondition, trace: evaluationTrace }
        : undefined;
      const evaluationTraceResult = (): Pick<TurnResult, "evaluationTrace"> => {
        if (!evaluationTrace || !deps.evaluationCondition) return {};
        const observed = new Set(evaluationTrace.events().map(event => event.component));
        for (const component of EVALUATION_COMPONENT_IDS) {
          if (observed.has(component)) continue;
          const conditionDisabled = deps.evaluationCondition.disabledComponents.includes(component);
          evaluationTrace.componentBypassed(
            component,
            `turn.not-applicable.${component}`,
            conditionDisabled ? "condition-disabled" : "not-applicable"
          );
        }
        return { evaluationTrace: toJsonValue(evaluationTrace.events()) };
      };
      const events: ScceEvent[] = [];
      kernelTrace({ stage: "runtime.start", label: "kernel.turn", counts: { textChars: input.text.length } });
      const locale = localeFromMetadata(input.metadata, input.text);
      const translationTarget = translationTargetFromMetadata(input.metadata);
      const authorityLanguage = await evaluationComponent(
        "language-memory",
        "authority.language-memory.hydrate",
        () => hydrateSurfaceLanguageMemoryCached(12, languageHintForSurface(input.text)),
        () => Promise.resolve(emptySurfaceLanguageMemory())
      );
      const previousDialogueState = previousDialogueStateFromMetadata(input.metadata);
      const authorityDialogueState = updateDialogueState({
        requestText: input.text,
        targetLanguage: translationTarget ?? locale,
        previousState: previousDialogueState,
        conversationId: previousDialogueState?.conversationId
      });
      const runtimeDiagnosticRequested = explicitRuntimeDiagnosticRequest(input.metadata);
      const explicitAuthority = requestedAuthorityFromTurnInput(input, translationTarget);
      const requirementField = deriveTurnRequirementField({
        requestText: input.text,
        explicitRequirements: explicitTurnRequirementsFromInput(input, explicitAuthority),
        dialogueState: authorityDialogueState,
        languageMemoryState: authorityLanguage.state,
        contextContribution: requirementContextFromMetadata(input.metadata)
      });
      let operatorActivations = activateCognitiveOperators({
        requirementField,
        dialogueSupport: operatorDialogueSupport(requirementField),
        outcomeSupport: operatorOutcomeSupport(input.metadata)
      });
      const requestedAuthority = requestedAuthorityFromRequirementField(requirementField, explicitAuthority);
      const requestedAuthorityDecision = toJsonValue({
        schema: "scce.requested_authority.requirement_projection.v1",
        requestedAuthority,
        explicitOverride: Boolean(explicitAuthority),
        source: "turn_requirement_field",
        lexicalRouterUsed: false,
        requirementConfidence: requirementField.confidence,
        activeOperatorIds: operatorActivations.filter(row => row.active).map(row => row.operatorId)
      });
      const calibrationTaskClass = calibrationTaskClassForRequirements(requirementField, requestedAuthority);
      const ownerAsked = await append(eventFactory.create({ episodeId, typeId: "OwnerAsked", payload: { textHash: hasher.digestHex(input.text), metadata: input.metadata ?? null, requestedAuthority, requestedAuthorityDecision } }));
      events.push(ownerAsked);
      events.push(await append(eventFactory.create({ episodeId, typeId: "TurnRequirementsBuilt", payload: toJsonValue({
        field: requirementField,
        featureSchema: TURN_REQUIREMENT_DIMENSIONS,
        coefficientHash: hasher.digestHex(JSON.stringify(jsonRecord(requirementField.trace).coefficientModel ?? null)),
        brainRevision: await activeBrainMarker()
      }) })));
      events.push(await append(eventFactory.create({ episodeId, typeId: "CognitiveOperatorsActivated", payload: toJsonValue({
        operators: operatorActivations,
        featureSchema: TURN_REQUIREMENT_DIMENSIONS,
        coefficientHash: hasher.digestHex(JSON.stringify(operatorActivations.map(row => jsonRecord(row.trace).coefficientModel ?? null)))
      }) })));
      events.push(await append(eventFactory.create({ episodeId, typeId: "RequestedAuthorityProjected", payload: requestedAuthorityDecision })));
      const detectedCorrections = correctionMemory.fromMetadata({ episodeId, metadata: input.metadata, ownerFeedbackEventId: ownerAsked.id, now: clock.now() });
      for (const rule of detectedCorrections) {
        await deps.storage.corrections.putRule(rule);
        events.push(await append(eventFactory.create({ episodeId, typeId: "UserCorrected", payload: { ruleId: rule.id, kind: rule.ruleKind, scope: rule.scope, patternHash: hasher.digestHex(rule.pattern), replacementHash: rule.replacement ? hasher.digestHex(rule.replacement) : null, provenance: rule.provenanceJson } })));
      }
      const runtimeDag = runtimeOrchestrator.dag({ episodeId, mode: "turn", mutating: true, requestedTools: Boolean(deps.connectors) });
      const safetyDecision = safetyRails.evaluate({ text: input.text, plans: [], policy });
      events.push(await append(eventFactory.create({ episodeId, typeId: "ActionPrepared", payload: { runtimeDag: runtimeDag.audit, safety: safetyDecision.audit } })));
      markTiming("seedMs");
      const arithmetic = arithmeticAnswerForText(input.text);
      if (arithmetic && requestedAuthority !== "creative" && requestedAuthority !== "translation") {
        markTiming("graphSliceMs");
        const graph: GraphSlice = { nodes: [], edges: [], hyperedges: [], bounded: true, query: {} };
        const field = fieldEngine.activate({ text: input.text, nodes: [], edges: [], previous: lastField, evaluation: fieldEvaluation });
        lastField = field;
        const entailment = createArithmeticEntailment({ requestText: input.text, arithmetic, field, idFactory, createdAt: clock.now() });
        markTiming("proofMs");
        const answer = arithmetic.answer;
        const construct = programBuilder.build({ episodeId, text: input.text, entailment, evidence: [], createdAt: clock.now() });
        const pcaReport = pca.certify({ answer, evidence: [], force: entailment.force });
        const validation = validationBuilder.build({ construct, entailment, pca: pcaReport as unknown as JsonValue });
        const rawEmission = emissionEngine.emit({ construct, validation, entailment, answer, pca: pcaReport as unknown as JsonValue });
        const emission = { ...rawEmission, assistantForce: "reasoned_answer" as const };
        timingParts.candidateMs = 0;
        timingParts.planningMs = 0;
        timingParts.mouthMs = 0;
        markTiming("validationMs");
        const state = prediction.state({ episodeId, graph, alphaTrace: field.alphaTrace, t: clock.now() });
        const forecast = prediction.forecast({ states: [], source: state, horizon: 2, createdAt: clock.now() });
        markTiming("forecastMs");
        timingParts.maintenanceMs = 0;
        lastEpisodeId = episodeId;
        lastOutput = emission.answer;
        events.push(await append(eventFactory.create({ episodeId, typeId: "ComputationEvaluated", payload: arithmetic.audit })));
        events.push(await append(eventFactory.create({ episodeId, typeId: "SemanticEntailmentChecked", payload: { proofId: entailment.proof.id, force: entailment.force, assistantForce: emission.assistantForce, support: entailment.support, contradiction: entailment.contradiction, deterministicArithmetic: true } })));
        events.push(await append(eventFactory.create({ episodeId, typeId: "EmissionGraphBuilt", payload: emission })));
        const timing = buildTiming("deferred");
        events.push(await append(eventFactory.create({ episodeId, typeId: "EpisodeClosed", payload: { output: emission.answer, deterministicArithmetic: true, timing } })));
        lastTurnTiming = timing;
        return {
          episodeId,
          requestedAuthority,
          requestedAuthorityDecision: toJsonValue(requestedAuthorityDecision),
          requirementField: toJsonValue(requirementField),
          operatorActivations: toJsonValue(operatorActivations),
          answer: emission.answer,
          epistemicForce: emission.epistemicForce,
          assistantForce: emission.assistantForce,
          evidence: [],
          field,
          entailment,
          constructGraph: construct,
          validationGraph: validation,
          emissionGraph: emission,
          forecast,
          learningNeeds: [],
          actionGraph: toJsonValue({ deterministicArithmetic: arithmetic.audit, runtime: runtimeDag.audit, safety: safetyDecision.audit, maintenanceDeferred: true }),
          proofCarryingAnswer: pcaReport.audit,
          languageAcquisition: toJsonValue({ skipped: true, reason: "kernel.turn.deterministic_arithmetic" }),
          mouth: toJsonValue({ skipped: true, reason: "kernel.turn.deterministic_arithmetic" }),
          corrections: correctionMemory.summarize(detectedCorrections),
          learningLoop: toJsonValue({ maintenanceDeferred: true, deterministicArithmetic: true }),
          timing,
          ...evaluationTraceResult(),
          ...turnContract({ entailment, evidence: [], assistantForce: emission.assistantForce, unsupportedContentBlocked: false }),
          events
        };
      }
      const discourseObject = discourseObjectStateFromMetadata(input.metadata);
      const discourseObjectTrace = discourseObject ? toJsonValue(discourseObject) : undefined;
      if (discourseObjectTrace) events.push(await append(eventFactory.create({ episodeId, typeId: "DiscourseObjectBound", payload: discourseObjectTrace })));
      const retrievalText = retrievalTextForTurn(input);
      const sessionEvidence = mergeEvidenceSpans([...currentOwnerSessionEvidence(input), ...sessionEvidenceFromMetadata(input.metadata)]);
      const metadataEvidence = await evidenceFromTurnMetadata(input.metadata);
      const metadataEvidenceIds = new Set([
        ...metadataEvidence.map(span => String(span.id)),
        ...(discourseObject?.evidenceIds ?? [])
      ]);
      const discourseEvidenceBound = sessionContextEvidenceEnabled(input.metadata) && metadataEvidenceIds.size > 0;
      const allowSemanticFrameEvidence = deps.evaluationCondition?.flags.disableLanguageMemory !== true
        && deps.evaluationCondition?.flags.disableLearnedSemantics !== true;
      const graphSlice = await evaluationComponent(
        "graph",
        "graph.resolve",
        () => evaluationComponent(
          "shard-router",
          "graph.resolve.shard-router",
          () => discourseEvidenceBound ? graphForEvidenceIds([...metadataEvidenceIds]) : graphForText(retrievalText, { allowSemanticFrameEvidence }),
          () => discourseEvidenceBound ? graphForEvidenceIdsUnrouted([...metadataEvidenceIds]) : graphForTextUncached(retrievalText)
        ),
        () => discourseEvidenceBound ? evidenceOnlyForIds([...metadataEvidenceIds]) : evidenceOnlyForText(retrievalText, allowSemanticFrameEvidence)
      );
      let graph = graphSlice.graph;
      const evidencePool = discourseEvidenceBound
        ? mergeEvidenceSpans([...sessionEvidence, ...metadataEvidence, ...graphSlice.evidence.filter(span => metadataEvidenceIds.has(String(span.id)))])
        : mergeEvidenceSpans([...sessionEvidence, ...metadataEvidence, ...graphSlice.evidence]);
      const evidence = evidenceWithGraphPreviewWindows(input.text, evidencePool, graph.nodes, metadataEvidenceIds);
      const calibrationModels = await calibrationModelsCached();
      const sourceAnchorAudit = discourseEvidenceBound
        ? { required: false, anchors: [] as string[], evidence }
        : sourceAnchoredEvidenceForRequest(input.text, evidence);
      const admissibleEvidence = sourceAnchorAudit.required ? sourceAnchorAudit.evidence : evidence;
      if (sourceAnchorAudit.required) graph = graphFilteredToEvidence(graph, sourceAnchorAudit.evidence);
      const retrievalFeatures = graphRetrievalFeatures(retrievalText);
      const semanticRetrieval = evaluationComponent(
        "learned-semantics",
        "retrieval.learned-semantics",
        () => ({
          retrieval: semanticMemory.search({
            query: { text: input.text, features: retrievalFeatures, limit: 80 },
            slice: semanticMemory.buildSlice({ evidence: admissibleEvidence, nodes: graph.nodes }),
            corpusRows: { evidenceRows: Math.max(1, admissibleEvidence.length), nodeRows: Math.max(1, graph.nodes.length), edgeRows: Math.max(1, graph.edges.length) },
            calibrationModels,
            calibrationTaskClass
          }),
          roleRetrieval: hybridRecall({ query: input.text, evidence: admissibleEvidence, graph, hasher, limit: 80, calibrationModels, calibrationTaskClass })
        }),
        () => disabledLearnedSemanticRetrieval(input.text, retrievalFeatures, hasher)
      );
      const { retrieval, roleRetrieval } = semanticRetrieval;
      const retrievalRoles = retrievalRoleTracesFromHybridRecall(roleRetrieval.recall);
      events.push(await append(eventFactory.create({ episodeId, typeId: "GraphUpdated", payload: { retrieval: retrieval.diagnostics, plan: retrieval.plan.audit, roleRecall: roleRetrieval.audit } })));
      const walk = evaluationComponent(
        "powerwalk",
        "graph.resolve.powerwalk",
        () => powerWalk.run(graph.nodes, graph.edges),
        () => emptyPowerWalkResult()
      );
      const semanticSeedAnchors = queryConditionedSemanticSeedAnchors(retrieval.candidates, retrievalFeatures);
      const walkSeedExpansion = expandPowerWalkSeedAnchors({
        anchors: semanticSeedAnchors,
        embeddings: walk.embeddings,
        maximumAnchors: 40,
        maximumExpandedSeeds: 24
      });
      events.push(await append(eventFactory.create({ episodeId, typeId: "GraphUpdated", payload: { powerWalk: {
        walks: walk.walks.length,
        typePairWalkLengths: walk.typePairWalkLengths.slice(0, 8),
        transitionAudit: walk.transitionAudit.slice(0, 12),
        representation: walk.representation,
        seedExpansion: walkSeedExpansion.audit
      } } })));
      const field = fieldEngine.activate({
        text: retrievalText,
        nodes: graph.nodes,
        edges: graph.edges,
        previous: lastField,
        evaluation: fieldEvaluation,
        seedPriors: [...semanticSeedAnchors, ...walkSeedExpansion.seeds]
      });
      lastField = field;
      operatorActivations = activateCognitiveOperators({
        requirementField,
        graphSupport: operatorGraphSupport(graph, admissibleEvidence, field),
        dialogueSupport: operatorDialogueSupport(requirementField),
        outcomeSupport: operatorOutcomeSupport(input.metadata)
      });
      events.push(await append(eventFactory.create({
        episodeId,
        typeId: "CognitiveOperatorsActivated",
        payload: toJsonValue({ phase: "graph_activated", operators: operatorActivations })
      })));
      const alphaRecord = alphaRecordFromField({ graph, requestText: input.text, requestFeatures: featureSet(input.text, 1024), field, createdAt: clock.now() });
      void persistAlphaRecord(alphaRecord, field).catch(error => failures.push(`alpha persistence failed: ${error instanceof Error ? error.message : String(error)}`));
      const importedPriorTrace = jsonRecord(field.ppfDiagnostics).importedPriorTrace ?? null;
      events.push(await append(eventFactory.create({ episodeId, typeId: "FieldSeeded", payload: { seeds: field.seeds.slice(0, 16) } })));
      events.push(await append(eventFactory.create({ episodeId, typeId: "FieldActivated", payload: { active: field.active.slice(0, 24), importedPriorTrace } })));
      events.push(await append(eventFactory.create({ episodeId, typeId: "FieldPropagated", payload: { ppfTop: field.ppf.slice(0, 16), importedPriorTrace } })));
      events.push(await append(eventFactory.create({ episodeId, typeId: "PPFComputed", payload: { top: field.ppf.slice(0, 16), diagnostics: field.ppfDiagnostics ?? null, importedPriorTrace, cache: { key: alphaRecord.cacheKey, graph: alphaRecord.graphFingerprint.id, pf: alphaRecord.diagnostics.audit } } })));
      events.push(await append(eventFactory.create({ episodeId, typeId: "CausalGraphDiscovered", payload: { causalMass: field.causalMass.slice(0, 16) } })));
      kernelTrace({
        stage: "graph.resolve",
        label: "kernel.turn",
        counts: {
          nodes: graph.nodes.length,
          edges: graph.edges.length,
          evidence: admissibleEvidence.length,
          active: field.active.length,
          ppf: field.ppf.length,
          retrieval: retrieval.candidates.length,
          retrievalRoles: retrievalRoles.length,
          powerWalkExpandedSeeds: walkSeedExpansion.seeds.length
        },
        support: discourseObjectTrace ? { discourseObject: discourseObjectTrace, queryConcatenationUsed: false } : { queryConcatenationUsed: false }
      });
      markTiming("graphSliceMs");
      const preProofSelectedEvidence = runtimeEvidenceWindowsForRequest(input.text, evidenceForRequest(input.text, admissibleEvidence, metadataEvidenceIds));
      const supportCandidates = runtimeEvidenceWindowsForRequest(input.text, evidenceForRequest(input.text, admissibleEvidence.filter(span => span.status === "promoted"), metadataEvidenceIds).slice(0, turnProofEvidenceLimit));
      const supportBundle = evaluationComponent(
        "support-engine",
        "proof.support-engine",
        () => {
          const entailmentResult = entailment.check({ text: input.text, evidence: supportCandidates, nodes: graph.nodes, field, createdAt: clock.now(), calibrationModels });
          return {
            promoted: supportCandidates,
            entailmentResult,
            semanticProof: semanticProofSystem.prove({ claimText: input.text, evidence: supportCandidates, nodes: graph.nodes, field }),
            ccrResult: ccr.run({ text: input.text, evidence: supportCandidates, nodes: graph.nodes, edges: graph.edges, field, entailment: entailmentResult }),
            pfaceEstimate: pface.estimate({ nodes: graph.nodes, edges: graph.edges, field })
          };
        },
        () => ({
          promoted: [] as EvidenceSpan[],
          entailmentResult: createAblatedSupportEntailment({ requestText: input.text, field, idFactory, createdAt: clock.now() }),
          semanticProof: emptySemanticProofResult(input.text, hasher),
          ccrResult: emptyCcrResult(input.text),
          pfaceEstimate: undefined
        })
      );
      const { promoted, entailmentResult, semanticProof, ccrResult, pfaceEstimate } = supportBundle;
      const entailmentAssistantForce = assistantForceDecision({
        requestedAuthority,
        epistemicForce: entailmentResult.force,
        proofVerdict: semanticProof.verdict,
        evidenceIds: entailmentResult.evidenceIds,
        directEvidenceIds: promoted.map(span => span.id),
        support: entailmentResult.support,
        contradiction: Math.max(entailmentResult.contradiction, semanticProof.contradiction)
      });
      kernelTrace({
        stage: "contradiction.check",
        label: "kernel.turn",
        counts: {
          promotedEvidence: promoted.length,
          proofEvidence: entailmentResult.evidenceIds.length,
          semanticObligations: semanticProof.obligations.length,
          counterexamples: semanticProof.counterexamples.length
        },
        support: {
          entailmentSupport: entailmentResult.support,
          entailmentContradiction: entailmentResult.contradiction,
          semanticSupport: semanticProof.support,
          semanticContradiction: semanticProof.contradiction,
          semanticVerdict: semanticProof.verdict
        }
      });
      entailmentResult.proof.scores = { ...(entailmentResult.proof.scores as Record<string, JsonValue>), ccr: ccrResult.audit, semanticProofSystem: semanticProof.replay };
      if (pfaceEstimate) entailmentResult.proof.scores = { ...(entailmentResult.proof.scores as Record<string, JsonValue>), pface: pfaceEstimate.audit };
      await deps.storage.proofs.putProof(entailmentResult.proof);
      events.push(await append(eventFactory.create({ episodeId, typeId: "SemanticEntailmentChecked", payload: { proofId: entailmentResult.proof.id, force: entailmentResult.force, assistantForce: entailmentAssistantForce.force, assistantForceTrace: entailmentAssistantForce.audit, support: entailmentResult.support, contradiction: entailmentResult.contradiction, lcb: entailmentResult.faithfulnessLcb, boundaries: entailmentResult.boundaries, ccr: ccrResult.audit, semanticProofSystem: { id: semanticProof.id, verdict: semanticProof.verdict, support: semanticProof.support, contradiction: semanticProof.contradiction, obligations: semanticProof.obligations.length, counterexamples: semanticProof.counterexamples.length }, pface: pfaceEstimate?.audit ?? null } })));
      events.push(await append(eventFactory.create({ episodeId, typeId: "EvidenceLinked", payload: { evidenceIds: entailmentResult.evidenceIds } })));
      kernelTrace({
        stage: "proof.attach",
        label: "kernel.turn",
        counts: { evidenceIds: entailmentResult.evidenceIds.length },
        support: { proofId: entailmentResult.proof.id, force: entailmentResult.force, faithfulnessLcb: entailmentResult.faithfulnessLcb }
      });
      const proofSelectedEvidence = evidenceBatchFromSlice(promoted, entailmentResult.evidenceIds)
        ?? (sourceAnchorAudit.required ? [] : runtimeEvidenceWindowsForRequest(input.text, await deps.storage.evidence.getEvidenceBatch(entailmentResult.evidenceIds)));
      const metadataSelectedEvidence = metadataEvidenceIds.size
        ? metadataEvidence.filter(span => span.status === "promoted" && metadataEvidenceIds.has(String(span.id)))
        : [];
      const evidenceSelectionPool = proofSelectedEvidence.length
        ? mergeEvidenceSpans([...proofSelectedEvidence, ...metadataSelectedEvidence])
        : promoted;
      let selectedEvidence = runtimeEvidenceWindowsForRequest(input.text, evidenceForRequest(input.text, evidenceSelectionPool, metadataEvidenceIds));
      let earlyLearningNeeds = learningNeedsFor(input.text, entailmentResult, selectedEvidence, locale);
      markTiming("proofMs");
      const selectedPoolLocalEvidenceAnswer = localEvidenceAnswerSurface({
        requestText: input.text,
        selectedEvidence,
        entailment: entailmentResult,
        semanticProof: { verdict: semanticProof.verdict, contradiction: semanticProof.contradiction },
        translationTarget,
        sessionContextEvidence: sessionContextEvidenceEnabled(input.metadata)
      });
      const preProofPoolLocalEvidenceAnswer = preProofSelectedEvidence.length ? localEvidenceAnswerSurface({
        requestText: input.text,
        selectedEvidence: preProofSelectedEvidence,
        entailment: entailmentResult,
        semanticProof: { verdict: semanticProof.verdict, contradiction: semanticProof.contradiction },
        translationTarget,
        sessionContextEvidence: sessionContextEvidenceEnabled(input.metadata)
      }) : undefined;
      // A later evidence-surface shortcut must not reattach proof support after
      // the support engine has been explicitly bypassed.
      const localEvidenceAnswer = deps.evaluationCondition?.flags.disableSupportEngine
        ? undefined
        : preferredLocalEvidenceAnswer(selectedPoolLocalEvidenceAnswer, preProofPoolLocalEvidenceAnswer);
      const longPathBasisAnswer = requestedAuthority === "creative" ? undefined : localEvidenceAnswer;
      let answerEntailmentSeed = entailmentResult;
      if (longPathBasisAnswer) {
        selectedEvidence = runtimeEvidenceWindowsForRequest(input.text, longPathBasisAnswer.evidence);
        answerEntailmentSeed = bindSelectedEvidenceToEntailment(entailmentResult, selectedEvidence, longPathBasisAnswer.audit);
        earlyLearningNeeds = learningNeedsFor(input.text, answerEntailmentSeed, selectedEvidence, locale);
        events.push(await append(eventFactory.create({ episodeId, typeId: "CandidateGenerated", payload: { kind: "basis-aware-answer", basis: longPathBasisAnswer.audit } })));
        kernelTrace({
          stage: "candidate.score",
          label: "kernel.turn.basis_answer",
          counts: { evidence: selectedEvidence.length },
          support: {
            answerChars: longPathBasisAnswer.answer.length,
            evidenceIds: selectedEvidence.map(span => String(span.id)),
            audit: longPathBasisAnswer.audit
          }
        });
      }
      const surfaceLanguage = authorityLanguage;
      const surfaceLanguageModels = surfaceLanguage.models;
      const surfaceLanguageMemory = surfaceLanguage.state;
      const productionTranslationProfiles = translationTarget
        ? await deps.storage.model.listLanguageProfiles(200)
        : [];
      let productionTranslationPlan: TranslationPlan | undefined;
      if (translationTarget) {
        const priorAlignments = await deps.storage.languageMemory.listTranslationAlignments({ targetLanguage: translationTarget, limit: 500 });
        productionTranslationPlan = translationEngine.plan({
          text: input.text,
          targetLanguage: translationTarget,
          evidence: selectedEvidence,
          profiles: productionTranslationProfiles,
          priorAlignments,
          createdAt: clock.now()
        });
      }
      const brain = await activeBrainMarker();
      events.push(await append(eventFactory.create({ episodeId, typeId: "BrainInfluenceObserved", payload: { ...brain as Record<string, JsonValue>, languageMemory: surfaceLanguageMemoryProfile(surfaceLanguageMemory, deps.evaluationCondition?.flags.disableLanguageMemory === true) } })));
      const correctionRules = correctionMemory.retrieve({
        rules: mergeCorrectionRules(await correctionRulesCached(), detectedCorrections),
        context: { targetLanguageId: translationTarget ?? locale, targetScriptId: undefined },
        limit: 96
      });
      const answerSurface = longPathBasisAnswer
        ? {
          answer: longPathBasisAnswer.answer,
          audit: toJsonValue({
            source: "kernel.turn.long_path_basis_answer",
            basis: longPathBasisAnswer.audit,
            evidenceIds: selectedEvidence.map(span => String(span.id)),
            evidenceCount: selectedEvidence.length,
            fakeEvidenceForbidden: true
          })
        }
        : composeEvidenceGroundedAnswer({ requestText: input.text, entailment: answerEntailmentSeed, evidence: selectedEvidence, field, ccr: ccrResult, languageModels: surfaceLanguageModels, languageMemory: surfaceLanguageMemory, locale });
      const proofAnswer = answerSurface.answer;
      const candidateConstructSeed = programBuilder.build({ episodeId, text: input.text, entailment: answerEntailmentSeed, evidence: selectedEvidence, createdAt: clock.now() });
      const candidateApprovalPolicyPatch = deps.approvals?.policyPatch?.() ?? {};
      const candidateActionPlans = candidateConstructSeed.program || candidateConstructSeed.artifacts.length
        ? toolCognition.plan({
          episodeId,
          request: input.text,
          capabilities: connectorGovernance.capabilities(defaultConnectorConfigs()),
          policy,
          evidence: selectedEvidence,
          field,
          temporaryOperatorGrant: { enabled: candidateApprovalPolicyPatch.dryRunByDefault === false }
        }).capabilityPlans
        : [];
      const cognitiveActionPlans: CognitiveActionPlan[] = candidateActionPlans.map(plan => ({
        id: String(plan.id),
        capabilityId: plan.capabilityId,
        phase: plan.phase,
        status: plan.status,
        trace: toJsonValue({
          input: plan.input,
          permission: plan.permission,
          riskVector: plan.riskVector,
          executionState: "not_executed"
        })
      }));
      const inventionCandidates = planInventions({
        requestText: input.text,
        requestedAuthority,
        field,
        graph,
        languageMemory: languageMemoryRuntime,
        languageMemoryState: surfaceLanguageMemory,
        dialogueState: authorityDialogueState,
        evidence: selectedEvidence,
        construct: candidateConstructSeed,
        requirementField,
        operatorActivations,
        samplingDisabled: deps.deterministicReplay === true
      });
      if (inventionCandidates.length) {
        events.push(await append(eventFactory.create({
          episodeId,
          typeId: "InventionPlanned",
          payload: toJsonValue({
            requestedAuthority,
            candidates: inventionCandidates.map(invention => ({ id: invention.id, title: invention.title, noveltyScore: invention.noveltyScore, supportScore: invention.supportScore, riskScore: invention.riskScore, basisEvidenceIds: invention.basisEvidenceIds, basisPriorIds: invention.basisPriorIds, trace: invention.trace }))
          })
        })));
      }
      const counterfactualWorld = counterfactual.simulate({
        graph,
        query: {
          targetFeatures: featureSet(input.text, 512),
          interventions: field.seeds.slice(0, 3).map((seed, index) => ({
            id: `field_seed_${index}`,
            nodeId: seed.nodeId,
            value: Math.max(0, Math.min(1, seed.weight)),
            operator: "increase" as const,
            confidence: Math.max(0, Math.min(1, seed.weight)),
            reason: seed.feature
          })),
          horizon: 4,
          maxPaths: 32
        }
      });
      const cognitiveProposals = planCognitiveProposals({
        requestText: input.text,
        requirements: requirementField,
        operatorActivations,
        evidence: selectedEvidence,
        graph,
        field,
        construct: candidateConstructSeed,
        inventions: inventionCandidates,
        counterfactualWorlds: [counterfactualWorld],
        translationPlans: productionTranslationPlan ? [productionTranslationPlan] : [],
        programGraphs: candidateConstructSeed.program ? [candidateConstructSeed.program] : [],
        actionPlans: cognitiveActionPlans,
        maxProposals: 8
      });
      events.push(await append(eventFactory.create({
        episodeId,
        typeId: "CognitiveProposalsBuilt",
        payload: toJsonValue({
          proposals: cognitiveProposals.map(proposal => ({
            id: proposal.id,
            operatorIds: proposal.operatorActivations.map(operator => operator.operatorId),
            claimBases: proposal.claims.map(claim => ({ claimId: claim.id, basis: claim.basis, evidenceIds: claim.evidenceIds })),
            constructIds: proposal.constructIds,
            satisfiedRequirementIds: proposal.satisfiedRequirementIds,
            missedRequirementIds: proposal.missedRequirementIds,
            quality: proposal.quality
          }))
        })
      })));
      const candidateField = candidates.generate({
        requestText: input.text,
        requestedAuthority,
        inventionCandidates,
        requirementField,
        operatorActivations,
        cognitiveProposals,
        dialogueState: toJsonValue(authorityDialogueState),
        workspacePlans: candidateConstructSeed.artifacts.map(artifact => toJsonValue({
          schema: "scce.workspace.proposed_artifact.v1",
          path: artifact.path,
          contentHash: artifact.contentHash,
          mediaType: artifact.mediaType,
          role: artifact.role
        })),
        actionPlans: candidateActionPlans.map(plan => toJsonValue(plan)),
        entailment: answerEntailmentSeed,
        evidence: selectedEvidence,
        field,
        ccr: ccrResult,
        proofAnswer,
        learningNeeds: earlyLearningNeeds,
        locale,
        calibrationModels,
        calibrationTaskClass
      });
      for (const candidate of candidateField.candidates) {
        const candidateProposal = cognitiveProposalForCandidate(candidate, cognitiveProposals);
        const candidateAssistantForce = assistantForceDecision({
          requestedAuthority,
          selectedProposal: candidateProposal,
          epistemicForce: candidate.force,
          proofVerdict: requestedAuthority === "creative" ? undefined : semanticProof.verdict,
          evidenceIds: candidate.evidenceIds,
          directEvidenceIds: selectedEvidence.map(span => span.id),
          constructForces: candidate.kind === "creative-candidate" ? ["CreativeConstruct"] : [],
          support: candidate.scores.support,
          contradiction: candidate.scores.contradiction
        });
        events.push(await append(eventFactory.create({ episodeId, typeId: "CandidateGenerated", payload: { candidateId: candidate.id, kind: candidate.kind, force: candidate.force, assistantForce: candidateAssistantForce.force, assistantForceTrace: candidateAssistantForce.audit, scores: candidate.scores, candidateAudit: candidate.audit, answerSurface: candidate.kind === "proof-answer" ? answerSurface.audit : null } })));
      }
      kernelTrace({
        stage: "candidate.score",
        label: "kernel.turn",
        counts: { candidates: candidateField.candidates.length },
        support: {
          candidates: candidateField.candidates.slice(0, 6).map(candidate => ({
            id: candidate.id,
            kind: candidate.kind,
            force: candidate.force,
            assistantForce: assistantForceDecision({
              requestedAuthority,
              selectedProposal: cognitiveProposalForCandidate(candidate, cognitiveProposals),
              epistemicForce: candidate.force,
              proofVerdict: requestedAuthority === "creative" ? undefined : semanticProof.verdict,
              evidenceIds: candidate.evidenceIds,
              directEvidenceIds: selectedEvidence.map(span => span.id),
              constructForces: candidate.kind === "creative-candidate" ? ["CreativeConstruct"] : [],
              support: candidate.scores.support,
              contradiction: candidate.scores.contradiction
            }).force,
            scores: candidate.scores,
            evidenceIds: candidate.evidenceIds.length
          })),
          surfaceMass: candidateField.surfaceMass.slice(0, 6)
        }
      });
      const judged = judge.select({
        field: candidateField,
        policy,
        requestedAuthority,
        requirementField,
        deterministicReplay: deps.deterministicReplay
      });
      const selectedProposal = cognitiveProposalForCandidate(judged.selected, cognitiveProposals);
      for (const rejected of judged.rejected) events.push(await append(eventFactory.create({ episodeId, typeId: "CandidateRejected", payload: { candidateId: rejected.candidate.id, score: rejected.score, reasons: rejected.reasons } })));
      const selectedAssistantForce = assistantForceDecision({
        requestedAuthority,
        selectedProposal,
        epistemicForce: judged.selected.force,
        proofVerdict: requestedAuthority === "creative" ? undefined : semanticProof.verdict,
        evidenceIds: judged.selected.evidenceIds,
        directEvidenceIds: selectedEvidence.map(span => span.id),
        constructForces: judged.selected.kind === "creative-candidate" ? ["CreativeConstruct"] : [],
        support: judged.selected.scores.support,
        contradiction: judged.selected.scores.contradiction
      });
      events.push(await append(eventFactory.create({ episodeId, typeId: "CandidateSelected", payload: { candidateId: judged.selected.id, kind: judged.selected.kind, force: judged.selected.force, assistantForce: selectedAssistantForce.force, assistantForceTrace: selectedAssistantForce.audit, candidateAudit: judged.selected.audit, judge: judged.audit } })));
      kernelTrace({
        stage: "planner.select",
        label: "kernel.turn",
        counts: { rejected: judged.rejected.length },
        support: {
          candidateId: judged.selected.id,
          kind: judged.selected.kind,
          force: judged.selected.force,
          assistantForce: selectedAssistantForce.force,
          rejected: judged.rejected.slice(0, 6).map(row => ({
            candidateId: row.candidate.id,
            score: row.score,
            reasons: row.reasons.slice(0, 6)
          }))
        }
      });
      markTiming("candidateMs");
      const answerEntailment = selectedCandidateEntailment(answerEntailmentSeed, judged.selected);
      const selectedInvention = selectedInventionForCandidate(judged.selected, inventionCandidates);
      await deps.storage.proofs.putProof(answerEntailment.proof);
      let answer = "";
      const capabilityPlans: CapabilityPlan[] = [];
      const approvalPolicyPatch = deps.approvals?.policyPatch?.() ?? {};
      const construct = programBuilder.build({ episodeId, text: input.text, entailment: answerEntailment, evidence: selectedEvidence, createdAt: clock.now() });
      const toolPlan = construct.program || construct.artifacts.length
        ? toolCognition.plan({
          episodeId,
          request: input.text,
          capabilities: connectorGovernance.capabilities(defaultConnectorConfigs()),
          policy,
          evidence: selectedEvidence,
          field,
          temporaryOperatorGrant: { enabled: approvalPolicyPatch.dryRunByDefault === false }
        })
        : {
          id: `tool_cognition_${hasher.digestHex(`skipped:${episodeId}`).slice(0, 32)}`,
          episodeId,
          objectives: [],
          scores: [],
          capabilityPlans: [],
          approvals: [],
          ledger: [],
          policyAudit: toJsonValue({ source: "tool-cognition.skipped", reason: "no_program_or_artifact" }),
          residualNeeds: [],
          session: {
            operatorGrant: false,
            maxToolCalls: policy.maxToolCalls,
            remainingToolCalls: policy.maxToolCalls,
            maxNetworkRequests: policy.maxNetworkRequests,
            remainingNetworkRequests: policy.maxNetworkRequests
          }
        };
      for (const plan of toolPlan.capabilityPlans) {
        await deps.storage.capabilities.putPlan(plan);
        capabilityPlans.push(plan);
        if (requiresExplicitApproval(plan)) await deps.approvals?.observePending(plan);
        events.push(await append(eventFactory.create({ episodeId, typeId: "CapabilityPlanned", payload: plan })));
      }
      let buildTest: BuildTestResult | undefined;
      if (construct.program) {
        const registry = createCapabilityRegistry({ process: true, network: Boolean(deps.connectors) });
        const capability = registry.get("process.build_test");
        if (capability) {
          const payload = toJsonValue({ program: construct.program.id, files: construct.program.files.map(file => ({ path: file.path, hash: file.contentHash })) });
          const approved = deps.approvals?.isApproved({ capabilityId: capability.id, input: payload }) ?? false;
          const effectivePolicy = { ...policy, ...(deps.approvals?.policyPatch?.() ?? {}) };
          const plan = createActionPlanner({ idFactory, policy: effectivePolicy }).plan({ episodeId, capability, payload, now: clock.now(), approved });
          await deps.storage.capabilities.putPlan(plan);
          capabilityPlans.push(plan);
          await deps.approvals?.observePending(plan);
          events.push(await append(eventFactory.create({ episodeId, typeId: "CapabilityPlanned", payload: plan })));
          const permission = plan.permission as { allowed?: boolean; dryRun?: boolean; reason?: string };
          if (permission.allowed && !permission.dryRun) {
            events.push(await append(eventFactory.create({ episodeId, typeId: "CapabilityInvoked", payload: { capabilityId: capability.id, planId: plan.id } })));
            buildTest = await deps.buildTest.executeProgram({ episodeId, construct });
            await deps.storage.constructs.putBuildTest(episodeId, construct.id, buildTest);
            events.push(await append(eventFactory.create({ episodeId, typeId: "BuildExecuted", payload: { code: buildTest.build.code, durationMs: buildTest.build.durationMs, stderrHash: hasher.digestHex(buildTest.build.stderr) } })));
            events.push(await append(eventFactory.create({ episodeId, typeId: "TestExecuted", payload: { code: buildTest.test.code, passed: buildTest.passed, repairAttempted: buildTest.repairAttempted } })));
            events.push(await append(eventFactory.create({ episodeId, typeId: buildTest.passed ? "CapabilitySucceeded" : "CapabilityFailed", payload: { capabilityId: capability.id, planId: plan.id, passed: buildTest.passed } })));
          } else {
            events.push(await append(eventFactory.create({ episodeId, typeId: "ActionPrepared", payload: { capabilityId: capability.id, planId: plan.id, reason: permission.reason ?? "approval-required" } })));
          }
        }
      }
      const safetyWithPlans = safetyRails.evaluate({ text: input.text, plans: capabilityPlans, policy });
      const assembly = constructSubstrate.assemble({
        episodeId,
        requestText: input.text,
        entailment: answerEntailment,
        semanticProof,
        toolPlan,
        program: construct.program,
        artifacts: construct.artifacts
      });
      const priorConstructGraph = runtimeDiagnosticRequested
        ? assembly.constructGraph
        : longPathBasisAnswer
          ? attachLocalEvidenceAnswerConstruct({
            construct: assembly.constructGraph,
            plan: longPathBasisAnswer.plan,
            requestText: input.text,
            brainMarker: brain,
            hasher
          })
          : attachLearnedGraphPriorConstruct({
          construct: assembly.constructGraph,
          requestText: input.text,
          graph,
          field,
          selectedEvidence,
          brainMarker: brain,
          hasher
        });
      const proposalConstructGraph = attachCognitiveProposal({ construct: priorConstructGraph, proposal: selectedProposal });
      const orderedInventions = selectedInvention
        ? [selectedInvention, ...inventionCandidates.filter(invention => invention.id !== selectedInvention.id)]
        : inventionCandidates;
      const inventionConstructGraph = orderedInventions.reduce(
        (current, invention) => attachInventionConstruct({ construct: current, invention }),
        proposalConstructGraph
      );
      const spokenConstructGraph = attachRuntimeDiagnosticConstruct({
        construct: inventionConstructGraph,
        enabled: runtimeDiagnosticRequested,
        requestText: input.text,
        brainMarker: brain,
        hasher,
        locale
      });
      await deps.storage.constructs.putConstruct(construct);
      await deps.storage.constructs.putConstruct(spokenConstructGraph);
      events.push(await append(eventFactory.create({ episodeId, typeId: "ConstructGraphBuilt", payload: construct })));
      events.push(await append(eventFactory.create({ episodeId, typeId: "ConstructGraphBuilt", payload: { substrate: assembly.audit, constructGraphId: spokenConstructGraph.id } })));
      events.push(await append(eventFactory.create({ episodeId, typeId: "CausalGraphDiscovered", payload: { counterfactual: counterfactualWorld.audit } })));
      events.push(await append(eventFactory.create({ episodeId, typeId: "ActionPrepared", payload: { safety: safetyWithPlans.audit, toolPlan: toolPlan.policyAudit } })));
      if (construct.program) events.push(await append(eventFactory.create({ episodeId, typeId: "ProgramGraphBuilt", payload: construct.program })));
      if (construct.artifacts.length) events.push(await append(eventFactory.create({ episodeId, typeId: "FileGraphBuilt", payload: { files: construct.artifacts.map(file => ({ path: file.path, contentHash: file.contentHash, role: file.role })) } })));
      markTiming("planningMs");
      const surfaceProfile = deps.evaluationCondition?.flags.disableLanguageMemory ? undefined : await surfaceLanguageProfileCached();
      const mouthStarted = Date.now();
      const speakInput = {
        construct: spokenConstructGraph,
        field,
        languageProfile: surfaceProfile ?? runtimeLanguageProfile(clock.now()),
        evidence: selectedEvidence,
        entailment: answerEntailment,
        languageMemory: surfaceLanguageMemory,
        targetLanguage: translationTarget ?? locale,
        detailProfileId: surfaceDetailProfileIdFromMetadata(input.metadata),
        styleProfileId: styleProfileIdFromMetadata(input.metadata),
        registerId: registerIdFromMetadata(input.metadata),
        correctionRules,
        brainMarker: brain,
        selectedCandidate: judged.selected,
        requirementField,
        selectedProposal,
        claimBases: selectedProposal?.claims ?? [],
        requiredOutputFeatures: requirementField.requiredFeatures,
        prohibitedOutputFeatures: requirementField.prohibitedFeatures,
        calibrationModels,
        calibrationTaskClass,
        requestedAuthority
      };
      let spoken = await evaluationComponent(
        "learned-mouth",
        "mouth.realize",
        () => mouth.speak(speakInput),
        () => deterministicMouth.speak(speakInput)
      );
      answer = spoken.text;
      if (!answer.trim()) answer = "";
      const mouthAssistantForce = assistantForceDecision({
        requestedAuthority,
        selectedProposal,
        epistemicForce: answerEntailment.force,
        proofVerdict: requestedAuthority === "creative" ? undefined : semanticProof.verdict,
        outputForce: spoken.force,
        evidenceIds: spoken.evidenceRefs,
        directEvidenceIds: selectedEvidence.map(span => span.id),
        constructForces: spoken.surfacePlan.constructForces.map(force => force.id),
        support: answerEntailment.support,
        contradiction: requestedAuthority === "creative"
          ? judged.selected.scores.contradiction
          : Math.max(answerEntailment.contradiction, semanticProof.contradiction),
        targetLanguageChanged: Boolean(translationTarget && translationTarget !== locale)
      });
      kernelTrace({
        stage: "mouth.generate",
        label: "kernel.turn",
        durationMs: Date.now() - mouthStarted,
        output: previewTraceText(spoken.text),
        counts: {
          answerChars: spoken.text.length,
          evidenceRefs: spoken.evidenceRefs.length,
          uncertainty: spoken.uncertainty.length,
          inspectRefs: spoken.inspectRefs.length
        },
        support: { selectedCandidateId: judged.selected.id, force: spoken.force, assistantForce: mouthAssistantForce.force }
      });
      timingParts.mouthMs = Date.now() - mouthStarted;
      timingStageStarted = Date.now();
      if (correctionRules.length) events.push(await append(eventFactory.create({ episodeId, typeId: "CorrectionApplied", payload: { summary: correctionMemory.summarize(correctionRules), trace: spoken.realizationTrace.corrections } })));
      const certifiedPcaReport = pca.certify({ answer, evidence: selectedEvidence, force: pcaForceForMouthSurface(spoken, judged.selected.force) });
      let pcaReport = longPathBasisAnswer
        ? {
          ...certifiedPcaReport,
          releaseAnswer: answer,
          basisAwareRelease: longPathBasisAnswer.audit
        }
        : certifiedPcaReport;
      let validation = validationBuilder.build({ construct: spokenConstructGraph, entailment: answerEntailment, buildTest, pca: pcaReport as unknown as JsonValue });
      let rawEmission = emissionEngine.emit({ construct: spokenConstructGraph, validation, entailment: answerEntailment, answer, pca: pcaReport as unknown as JsonValue });
      let answerRevisionTrace: JsonValue | undefined;
      if (selectedProposal && !deps.evaluationCondition) {
        const revisionArtifacts = new Map<string, { spoken: SpokenOutput; validation: TurnResult["validationGraph"]; pca: ReturnType<typeof pca.certify> }>();
        const baselineVersion = revisionAnswerVersion({
          id: "revision:" + String(episodeId) + ":baseline",
          proposal: selectedProposal,
          candidate: judged.selected,
          spoken,
          evidence: selectedEvidence,
          dialogueState: authorityDialogueState,
          validation,
          quality: selectedCandidateRevisionQuality(judged, spoken)
        });
        revisionArtifacts.set(baselineVersion.id, { spoken, validation, pca: certifiedPcaReport });
        const revisionResult = await answerRevision.revise({
          requirementField,
          baseline: baselineVersion,
          source: {
            kind: "planner_mouth",
            planner(revisionInput) {
              return {
                id: "revision-plan:" + String(episodeId) + ":" + revisionInput.round,
                round: revisionInput.round,
                constraints: revisionInput.constraints,
                trace: toJsonValue({
                  schema: "scce.answer_revision.plan.v1",
                  round: revisionInput.round,
                  defectIds: revisionInput.defects.map(defect => defect.id),
                  constraintIds: revisionInput.constraints.map(constraint => constraint.defectId)
                })
              };
            },
            async mouth(revisionInput) {
              const revisedSpoken = await mouth.speak({
                ...speakInput,
                revisionConstraints: revisionInput.constraints
              });
              const revisedPca = pca.certify({
                answer: revisedSpoken.text,
                evidence: selectedEvidence,
                force: pcaForceForMouthSurface(revisedSpoken, judged.selected.force)
              });
              const revisedValidation = validationBuilder.build({
                construct: spokenConstructGraph,
                entailment: answerEntailment,
                buildTest,
                pca: revisedPca as unknown as JsonValue
              });
              const version = revisionAnswerVersion({
                id: "revision:" + String(episodeId) + ":" + revisionInput.round,
                proposal: selectedProposal,
                candidate: judged.selected,
                spoken: revisedSpoken,
                evidence: selectedEvidence,
                dialogueState: authorityDialogueState,
                validation: revisedValidation,
                quality: selectedCandidateRevisionQuality(judged, revisedSpoken)
              });
              revisionArtifacts.set(version.id, { spoken: revisedSpoken, validation: revisedValidation, pca: revisedPca });
              return version;
            }
          }
        });
        answerRevisionTrace = toJsonValue(revisionResult);
        events.push(await append(eventFactory.create({
          episodeId,
          typeId: "AnswerRevisionEvaluated",
          payload: answerRevisionTrace
        })));
        const selectedRevision = revisionResult.selected ? revisionArtifacts.get(revisionResult.selected.id) : undefined;
        if (selectedRevision && revisionResult.selected?.id !== baselineVersion.id) {
          spoken = selectedRevision.spoken;
          answer = spoken.text;
          pcaReport = {
            ...selectedRevision.pca,
            releaseAnswer: answer
          };
          validation = selectedRevision.validation;
          rawEmission = emissionEngine.emit({
            construct: spokenConstructGraph,
            validation,
            entailment: answerEntailment,
            answer,
            pca: pcaReport as unknown as JsonValue
          });
        }
      }
      const emissionAssistantForce = assistantForceDecision({
        requestedAuthority,
        selectedProposal,
        epistemicForce: rawEmission.epistemicForce,
        proofVerdict: requestedAuthority === "creative" ? undefined : semanticProof.verdict,
        outputForce: spoken.force,
        evidenceIds: rawEmission.evidenceIds,
        directEvidenceIds: selectedEvidence.map(span => span.id),
        constructForces: spoken.surfacePlan.constructForces.map(force => force.id),
        support: answerEntailment.support,
        contradiction: requestedAuthority === "creative"
          ? judged.selected.scores.contradiction
          : Math.max(answerEntailment.contradiction, semanticProof.contradiction),
        targetLanguageChanged: Boolean(translationTarget && translationTarget !== locale)
      });
      const runtimeReadinessForEmission = runtimeOrchestrator.readiness({ dag: runtimeDag, safety: safetyWithPlans, retrieval, field, alphaRecord, entailment: answerEntailment, construct: spokenConstructGraph, assembly, toolPlan, capabilityPlans, counterfactual: counterfactualWorld, validation, emission: rawEmission });
      const runtimeCoherence = decideRuntimeCoherence({
        requestText: input.text,
        answerText: answer,
        evidence: selectedEvidence,
        entailment: answerEntailment,
        assistantForce: longPathBasisAnswer
          ? assistantForceFromLocalEvidenceAudit(longPathBasisAnswer.audit, emissionAssistantForce.force)
          : emissionAssistantForce.force,
        counterfactual: counterfactualWorld,
        readiness: runtimeReadinessForEmission,
        discourseObject: discourseObjectTrace,
        mouthAudit: toJsonValue({ surfacePlan: spoken.surfacePlan, trace: spoken.realizationTrace, inspectRefs: spoken.inspectRefs, uncertainty: spoken.uncertainty }),
        selectedCandidateAudit: judged.selected.audit
      });
      const runtimeCoherenceTrace = toJsonValue(runtimeCoherence);
      if (!runtimeCoherence.emitAllowed) {
        answer = "I do not have enough source-backed evidence to answer that.";
        const blockedPcaReport = pca.certify({ answer, evidence: selectedEvidence, force: "unknown" });
        pcaReport = {
          ...blockedPcaReport,
          releaseAnswer: answer,
          audit: toJsonValue({
            ...jsonRecord(blockedPcaReport.audit),
            runtimeCoherenceBlocked: runtimeCoherenceTrace
          })
        };
        validation = validationBuilder.build({ construct: spokenConstructGraph, entailment: answerEntailment, buildTest, pca: pcaReport as unknown as JsonValue });
        rawEmission = emissionEngine.emit({ construct: spokenConstructGraph, validation, entailment: answerEntailment, answer, pca: pcaReport as unknown as JsonValue });
      }
      await deps.storage.constructs.putValidation(validation);
      events.push(await append(eventFactory.create({ episodeId, typeId: "ValidationGraphBuilt", payload: validation })));
      const emission = {
        ...rawEmission,
        assistantForce: runtimeCoherence.assistantForceAfter
      };
      await deps.storage.constructs.putEmission(emission);
      events.push(await append(eventFactory.create({ episodeId, typeId: "RuntimeCoherenceDecided", payload: runtimeCoherenceTrace })));
      events.push(await append(eventFactory.create({ episodeId, typeId: "MouthSpoken", payload: { assistantForce: runtimeCoherence.assistantForceAfter, assistantForceBeforeCoherence: mouthAssistantForce.force, assistantForceTrace: mouthAssistantForce.audit, surfacePlan: spoken.surfacePlan, trace: spoken.realizationTrace, inspectRefs: spoken.inspectRefs, evidenceRefs: spoken.evidenceRefs, uncertainty: spoken.uncertainty, answerRevision: answerRevisionTrace ?? null, runtimeCoherence: runtimeCoherenceTrace } })));
      events.push(await append(eventFactory.create({ episodeId, typeId: "EmissionGraphBuilt", payload: { ...emission, assistantForceTrace: emissionAssistantForce.audit, runtimeCoherence: runtimeCoherenceTrace } })));
      markTiming("validationMs");
      const actionGraph = actionGraphBuilder.build({ episodeId, plans: capabilityPlans, emission, policy });
      const state = prediction.state({ episodeId, graph, alphaTrace: field.alphaTrace, t: clock.now() });
      const afterTurnMaintenance = afterTurnMaintenanceDecision({ translationTarget, construct, capabilityPlans, assistantForce: emission.assistantForce });
      const incrementalLearningDisabled = deps.evaluationCondition?.flags.disableIncrementalLearning === true;
      if (incrementalLearningDisabled) {
        evaluationComponent("incremental-learning", "maintenance.incremental-learning", () => undefined, () => undefined);
      }
      const afterTurnMaintenanceDeferred = afterTurnMaintenance.deferred
        || incrementalLearningDisabled
        || deps.evaluationCondition?.flags.disableLanguageMemory === true;
      const priorStates = afterTurnMaintenanceDeferred ? [] : await deps.storage.forecasts.getSeries({ limit: 8 });
      const forecast = prediction.forecast({ states: priorStates, source: state, horizon: 2, createdAt: clock.now() });
      if (!afterTurnMaintenanceDeferred) {
        await deps.storage.forecasts.putState(state);
        await deps.storage.forecasts.putForecast(forecast);
      }
      events.push(await append(eventFactory.create({ episodeId, typeId: "ForecastComputed", payload: { stateId: state.id, forecastId: forecast.id, interval: forecast.interval, persistenceDeferred: afterTurnMaintenanceDeferred, maintenance: afterTurnMaintenance.audit } })));
      markTiming("forecastMs");
      if (afterTurnMaintenanceDeferred) {
        lastEpisodeId = episodeId;
        lastOutput = emission.answer;
        events.push(await append(eventFactory.create({ episodeId, typeId: "ActionPrepared", payload: { turnMaintenance: afterTurnMaintenance.audit } })));
        const timing = buildTiming("deferred");
        events.push(await append(eventFactory.create({ episodeId, typeId: "EpisodeClosed", payload: { output: emission.answer, maintenanceDeferred: true, timing } })));
        lastTurnTiming = timing;
        kernelTrace({
          stage: "turn.output",
          label: "kernel.turn",
          durationMs: Date.now() - turnStarted,
          output: previewTraceText(emission.answer),
          counts: { answerChars: emission.answer.length, evidence: selectedEvidence.length, events: events.length },
          support: { timing, budgetExceeded: timing.budgetExceeded }
        });
        return {
          episodeId,
          requestedAuthority,
          requestedAuthorityDecision: toJsonValue(requestedAuthorityDecision),
          requirementField: toJsonValue(requirementField),
          operatorActivations: toJsonValue(operatorActivations),
          cognitiveProposals: toJsonValue(cognitiveProposals),
          answerRevision: answerRevisionTrace,
          answer: emission.answer,
          epistemicForce: emission.epistemicForce,
          assistantForce: emission.assistantForce,
          evidence: selectedEvidence,
          field,
          entailment: answerEntailment,
          constructGraph: spokenConstructGraph,
          validationGraph: validation,
          emissionGraph: emission,
          forecast,
          learningNeeds: earlyLearningNeeds,
          candidateField: candidateField.audit,
          judge: judged.audit,
          actionGraph: toJsonValue({ actionGraph: actionGraph.audit, toolPlan: toolPlan.policyAudit, safety: safetyWithPlans.audit, runtime: runtimeDag.audit, runtimeReadiness: runtimeReadinessForEmission.audit, runtimeCoherence: runtimeCoherenceTrace, discourseObject: discourseObjectTrace ?? null, counterfactual: counterfactualWorld.audit, constructSubstrate: assembly.audit, sourceAnchor: { sourceAnchorRequired: sourceAnchorAudit.required, sourceAnchorMatched: sourceAnchorAudit.evidence.length > 0, sourceAnchors: sourceAnchorAudit.anchors }, maintenanceDeferred: true, maintenance: afterTurnMaintenance.audit }),
          proofCarryingAnswer: pcaReport.audit,
          pface: pfaceEstimate?.audit,
          languageAcquisition: toJsonValue({ maintenanceDeferred: true, maintenance: afterTurnMaintenance.audit }),
          mouth: toJsonValue({ surfacePlan: spoken.surfacePlan, trace: spoken.realizationTrace, inspectRefs: spoken.inspectRefs, uncertainty: spoken.uncertainty }),
          runtimeCoherence: runtimeCoherenceTrace,
          discourseObject: discourseObjectTrace,
          corrections: correctionMemory.summarize(correctionRules),
          brain,
          learningLoop: toJsonValue({ maintenanceDeferred: true, maintenance: afterTurnMaintenance.audit }),
          timing,
          buildTest,
          ...evaluationTraceResult(),
          ...turnContract({
            entailment: answerEntailment,
            evidence: selectedEvidence,
            assistantForce: emission.assistantForce,
            scoreTraces: [...candidateField.scoreTrace, ...(judged.selected.scoreTrace ?? [])],
            retrievalRoles,
            preservationChecked: true,
            unsupportedContentBlocked: emission.assistantForce === "insufficient_support" || !runtimeCoherence.emitAllowed || runtimeCoherence.demotionRequired
          }),
          events
        };
      }
      evaluationComponent("incremental-learning", "maintenance.incremental-learning", () => undefined, () => undefined);
      const runtimeModel = await deps.storage.model.readModel();
      const profiles = translationTarget
        ? productionTranslationProfiles
        : await deps.storage.model.listLanguageProfiles(200);
      const languageAcquisition = multilingual.analyze({ text: input.text, profiles, evidence: selectedEvidence });
      let translationPlan: JsonValue | undefined;
      if (productionTranslationPlan) {
        const plan = productionTranslationPlan;
        for (const frame of plan.records.semanticFrames) await deps.storage.languageMemory.putSemanticFrame(frame);
        for (const alignment of plan.records.translationAlignments) await deps.storage.languageMemory.putTranslationAlignment(alignment);
        translationPlan = plan.audit;
        events.push(await append(eventFactory.create({ episodeId, typeId: "CandidateGenerated", payload: { kind: "translation", translation: plan.audit } })));
      }
      const learningNeeds = [
        ...earlyLearningNeeds,
        ...languageAcquisition.acquisitionNeeds.map(need => formatSurfaceMessage("learning.need.language", { script: need.script, reason: need.reason }, locale))
      ];
      const learningLoopPlan = learningLoop.plan({ goals: learningNeeds.length ? learningNeeds : runtimeModel.learningGoals, model: runtimeModel, graph, evidence: selectedEvidence, languageProfiles: profiles });
      const learningCapabilityPlans = learningAcquisitionCapabilityPlans({
        episodeId,
        learningLoopPlan,
        policy,
        connectorsConfigured: Boolean(deps.connectors),
        idFactory,
        now: clock.now()
      });
      for (const plan of learningCapabilityPlans) {
        await deps.storage.capabilities.putPlan(plan);
        capabilityPlans.push(plan);
        if (requiresExplicitApproval(plan)) await deps.approvals?.observePending(plan);
        events.push(await append(eventFactory.create({ episodeId, typeId: "CapabilityPlanned", payload: plan })));
      }
      const mvpTrainingPlan = trainingOrchestrator.plan({
        train: { config: { learningGoals: learningNeeds.length ? learningNeeds : runtimeModel.learningGoals, policy } },
        evidence: selectedEvidence,
        modelState: runtimeModel,
        recentProofs: [semanticProof],
        recentEntailments: [entailmentResult],
        policy
      });
      const selfState = await createFunctionalSelfModel({ storage: deps.storage, model: runtimeModel, policy, recentFailures: failures });
      const selfDistillation = ssd.distill({ model: runtimeModel, graph, state, forecast, self: selfState });
      const functionalConsciousness = fcs.score({ self: selfState, ssd: selfDistillation });
      const functionalCognition = functionalCognitionEngine.project({ now: clock.now(), self: selfState, model: runtimeModel, graph, policy, ssdAudit: selfDistillation.audit, learningNeeds, candidates: candidateField.audit });
      events.push(await append(eventFactory.create({ episodeId, typeId: "LanguagePatternLearned", payload: languageAcquisition.audit })));
      for (const need of learningNeeds) events.push(await append(eventFactory.create({ episodeId, typeId: "LearningNeedDetected", payload: { need } })));
      for (const need of learningLoopPlan.learningNeeds) events.push(await append(eventFactory.create({ episodeId, typeId: "LearningNeedDetected", payload: { id: need.id, goal: need.goal, gapId: need.gapId, priority: need.priority, continuation: need.continuation, sourcePlans: need.sourcePlans.map(plan => ({ id: plan.id, kind: plan.kind, capabilityId: plan.capabilityId, query: plan.query, utility: plan.utility, acquisition: plan.acquisition })) } })));
      if (learningLoopPlan.goals.length || learningLoopPlan.globalSources.length) events.push(await append(eventFactory.create({ episodeId, typeId: "LearningPlanBuilt", payload: learningLoopPlan.audit })));
      events.push(await append(eventFactory.create({ episodeId, typeId: "LearningPlanBuilt", payload: mvpTrainingPlan.audit })));
      lastEpisodeId = episodeId;
      lastOutput = emission.answer;
      events.push(await append(eventFactory.create({ episodeId, typeId: "SelfModelProjected", payload: { self: selfState, selfDistillation: selfDistillation.audit, fcs: functionalConsciousness.audit, functionalCognition: functionalCognition.audit } })));
      markTiming("maintenanceMs");
      const timing = buildTiming("foreground");
      events.push(await append(eventFactory.create({ episodeId, typeId: "EpisodeClosed", payload: { output: emission.answer, timing } })));
      lastTurnTiming = timing;
      kernelTrace({
        stage: "turn.output",
        label: "kernel.turn",
        durationMs: Date.now() - turnStarted,
        output: previewTraceText(emission.answer),
        counts: { answerChars: emission.answer.length, evidence: selectedEvidence.length, events: events.length },
        support: { timing, budgetExceeded: timing.budgetExceeded }
      });
      return {
        episodeId,
        requestedAuthority,
        requestedAuthorityDecision: toJsonValue(requestedAuthorityDecision),
        requirementField: toJsonValue(requirementField),
        operatorActivations: toJsonValue(operatorActivations),
        cognitiveProposals: toJsonValue(cognitiveProposals),
        answerRevision: answerRevisionTrace,
        answer: emission.answer,
        epistemicForce: emission.epistemicForce,
        assistantForce: emission.assistantForce,
        evidence: selectedEvidence,
        field,
        entailment: answerEntailment,
        constructGraph: spokenConstructGraph,
        validationGraph: validation,
        emissionGraph: emission,
        forecast,
        learningNeeds,
        candidateField: candidateField.audit,
        judge: judged.audit,
        actionGraph: toJsonValue({ actionGraph: actionGraph.audit, toolPlan: toolPlan.policyAudit, safety: safetyWithPlans.audit, runtime: runtimeDag.audit, runtimeReadiness: runtimeReadinessForEmission.audit, runtimeCoherence: runtimeCoherenceTrace, discourseObject: discourseObjectTrace ?? null, counterfactual: counterfactualWorld.audit, constructSubstrate: assembly.audit, sourceAnchor: { sourceAnchorRequired: sourceAnchorAudit.required, sourceAnchorMatched: sourceAnchorAudit.evidence.length > 0, sourceAnchors: sourceAnchorAudit.anchors }, maintenance: afterTurnMaintenance.audit }),
        selfState,
        selfDistillation: selfDistillation.audit,
        functionalConsciousness: functionalConsciousness.audit,
        functionalCognition: toJsonValue({ ...(functionalCognition.audit as Record<string, JsonValue>), runtimeReadiness: runtimeReadinessForEmission.audit, runtimeCoherence: runtimeCoherenceTrace }),
        runtimeCoherence: runtimeCoherenceTrace,
        discourseObject: discourseObjectTrace,
        proofCarryingAnswer: pcaReport.audit,
        pface: pfaceEstimate?.audit,
        languageAcquisition: languageAcquisition.audit,
        translation: translationPlan,
        mouth: toJsonValue({ surfacePlan: spoken.surfacePlan, trace: spoken.realizationTrace, inspectRefs: spoken.inspectRefs, uncertainty: spoken.uncertainty }),
        corrections: correctionMemory.summarize(correctionRules),
        brain,
        learningLoop: toJsonValue({ loop: learningLoopPlan.audit, acquisitionPlans: learningCapabilityPlans, training: mvpTrainingPlan.audit }),
        timing,
        buildTest,
        ...evaluationTraceResult(),
        ...turnContract({
          entailment: answerEntailment,
          evidence: selectedEvidence,
          assistantForce: emission.assistantForce,
          scoreTraces: [...candidateField.scoreTrace, ...(judged.selected.scoreTrace ?? [])],
          retrievalRoles,
          preservationChecked: true,
          unsupportedContentBlocked: emission.assistantForce === "insufficient_support" || !runtimeCoherence.emitAllowed || runtimeCoherence.demotionRequired
        }),
        events
      };
      });
    },

    async replay(episodeId: EpisodeId) {
      const events = await deps.storage.events.readEpisode(episodeId);
      return { episodeId, events, ledgerHash: eventFactory.ledgerHash(events), ...extractReplayValue(events) };
    },

    async inspect(target: InspectionTarget): Promise<InspectionResult> {
      if (target === "last") {
        const events = lastEpisodeId ? await deps.storage.events.readEpisode(lastEpisodeId) : [];
        const payloads = (typeId: string) => events.filter(event => event.typeId === typeId).map(event => event.payload);
        const latestPayload = (typeId: string): JsonValue => payloads(typeId).at(-1) ?? null;
        const requirementTrace = latestPayload("TurnRequirementsBuilt");
        return {
          kind: "last",
          value: toJsonValue({
            schema: "scce.inspect.last_turn.v2",
            episodeId: lastEpisodeId ?? null,
            output: lastOutput,
            requirements: requirementTrace,
            learnedActivations: jsonRecord(requirementTrace).field ?? null,
            operators: payloads("CognitiveOperatorsActivated"),
            proposals: latestPayload("CognitiveProposalsBuilt"),
            candidates: {
              generated: payloads("CandidateGenerated"),
              rejected: payloads("CandidateRejected"),
              selected: latestPayload("CandidateSelected")
            },
            mouth: latestPayload("MouthSpoken"),
            criticAndRevisions: latestPayload("AnswerRevisionEvaluated"),
            evidenceAndEmission: latestPayload("EmissionGraphBuilt"),
            brainRevision: jsonRecord(requirementTrace).brainRevision ?? null,
            actionState: {
              prepared: payloads("ActionPrepared"),
              committed: payloads("ActionCommitted"),
              rolledBack: payloads("ActionRolledBack")
            },
            timing: lastTurnTiming ?? null,
            events
          })
        };
      }
      if (target === "brain") return { kind: "brain", value: { marker: await activeBrainMarker(), summary: await deps.storage.brainImports.summarize({ limit: 2000 }), languageMemory: await languageMemorySummary() } as unknown as JsonValue };
      if (target === "language") return { kind: "language", value: { languageMemory: await languageMemorySummary(), brain: await deps.storage.brainImports.summarize({ limit: 2000 }) } as unknown as JsonValue };
      if (target === "graph-priors") {
        const graph = await deps.storage.graph.getSlice({ features: ["concept-prior"], limitNodes: 500, limitEdges: 1000, allowLatestFallback: true });
        return { kind: "graph-priors", value: { marker: await activeBrainMarker(), graph, analytics: analyzeGraph(graph), forceClasses: (await deps.storage.brainImports.summarize({ limit: 2000 })).runs.flatMap(run => Object.entries(run.forceClasses).map(([forceClass, count]) => ({ run: run.importRunId, forceClass, count }))) } as unknown as JsonValue };
      }
      if (target === "graph") {
        const graph = await deps.storage.graph.getSlice({ limitNodes: 200, limitEdges: 400, allowLatestFallback: true });
        return { kind: "graph", value: { graph, analytics: analyzeGraph(graph) } as unknown as JsonValue };
      }
      if (target === "ingestion") {
        const checkpoints = await deps.storage.ingestion.list({ limit: 500 });
        return { kind: "ingestion", value: { checkpoints, typedObservations: summarizeTypedCheckpoints(checkpoints), routeStores: summarizeTypedRouteStores(checkpoints), codebase: summarizeCodebaseCheckpoints(checkpoints), languageMemory: await languageMemorySummary() } as unknown as JsonValue };
      }
      if (target === "codebase") {
        const checkpoints = await deps.storage.ingestion.list({ limit: 2000 });
        return { kind: "codebase", value: summarizeCodebaseCheckpoints(checkpoints) };
      }
      if (target === "model") return { kind: "model", value: { model: await deps.storage.model.readModel(), languageMemory: await languageMemorySummary() } as unknown as JsonValue };
      if (target === "language-memory") {
        const rules = await deps.storage.corrections.listRules({ limit: 100 });
        return { kind: "language-memory", value: { languageMemory: await languageMemorySummary(), corrections: correctionMemory.summarize(rules) } as unknown as JsonValue };
      }
      if (target === "corrections") {
        const rules = await deps.storage.corrections.listRules({ limit: 200 });
        return { kind: "corrections", value: { rules, summary: correctionMemory.summarize(rules) } as unknown as JsonValue };
      }
      if (target === "localization") {
        const bundles = await deps.storage.localization.listBundles({ limit: 200 });
        return { kind: "localization", value: { bundles, languageMemory: await languageMemorySummary() } as unknown as JsonValue };
      }
      if (target === "math-spine") {
        const graph = await deps.storage.graph.getSlice({ limitNodes: 300, limitEdges: 600, allowLatestFallback: true });
        const stats = await deps.storage.stats();
        const languageMemory = await languageMemorySummary();
        const localization = await deps.storage.localization.listBundles({ limit: 100 });
        const report = createWalshSpineReport({ stats, graph, languageMemory: languageMemory as unknown as JsonValue, localization: localization as unknown as JsonValue, now: clock.now() });
        return { kind: "math-spine", value: walshSpineReportToJson(report) };
      }
      if (target === "self") {
        const currentModel = await deps.storage.model.readModel();
        const graph = await deps.storage.graph.getSlice({ limitNodes: 300, limitEdges: 600, allowLatestFallback: true });
        const selfState = await createFunctionalSelfModel({ storage: deps.storage, model: currentModel, policy, recentFailures: failures });
        const projected = ssd.distill({ model: currentModel, graph, self: selfState });
        const consciousness = fcs.score({ self: selfState, ssd: projected });
        return { kind: "self", value: { self: selfState, selfDistillation: projected, functionalConsciousness: consciousness } as unknown as JsonValue };
      }
      if (target === "snapshot") {
        const graph = await deps.storage.graph.getSlice({ limitNodes: 200, limitEdges: 400, allowLatestFallback: true });
        const currentModel = await deps.storage.model.readModel();
        const selfState = await createFunctionalSelfModel({ storage: deps.storage, model: currentModel, policy, recentFailures: failures });
        const stats = await deps.storage.stats();
        const languageMemory = await languageMemorySummary();
        const localization = await deps.storage.localization.listBundles({ limit: 25 });
        const mathSpine = createWalshSpineReport({ stats, graph, languageMemory: languageMemory as unknown as JsonValue, localization: localization as unknown as JsonValue, now: clock.now() });
        return { kind: "snapshot", value: { model: currentModel, graph, graphAnalytics: analyzeGraph(graph), self: selfState, ingestion: await deps.storage.ingestion.list({ limit: 100 }), languageMemory, localization, mathSpine, stats } as unknown as JsonValue };
      }
      if (target === "proofs") return { kind: "proofs", value: { message: validationMessageKey("inspect.proofs.replay_required") } };
      if (typeof target === "object" && target.kind === "brain-import") return { kind: "brain-import", value: { marker: await activeBrainMarker(), summary: await deps.storage.brainImports.summarize({ importRunId: target.importRunId, limit: 2000 }), ledger: await deps.storage.brainImports.listLedger({ importRunId: target.importRunId, limit: 2000 }) } as unknown as JsonValue };
      if (typeof target === "object" && target.kind === "episode") return { kind: "episode", value: (await kernel.replay(target.episodeId)) as unknown as JsonValue };
      if (typeof target === "object" && target.kind === "event") {
        const events = await deps.storage.events.readRange({ limit: 1000 });
        return { kind: "event", value: (events.find(event => event.id === target.eventId) ?? null) as JsonValue };
      }
      return { kind: "unknown", value: null };
    },

    async benchmark(input: BenchmarkInput): Promise<BenchmarkResult> {
      const runId = idFactory.runId();
      const episodeId = idFactory.episodeId();
      const startedAt = clock.now();
      const tasks = input.tasks ?? input.config?.tasks ?? [];
      const results: BenchmarkResult["tasks"] = [];
      const events: ScceEvent[] = [];
      const benchmarkScorer = createBenchmarkScorer();
      for (const task of tasks) {
        const turn = await kernel.turn({ text: task.input, metadata: { benchmarkTaskId: task.id } });
        const rubric = benchmarkScorer.scoreTurn(task, turn);
        const dims = new Map(rubric.dimensions.map(dim => [dim.id, dim.score]));
        const artifactScore = task.expectedArtifacts?.length
          ? task.expectedArtifacts.filter(path => turn.emissionGraph.artifacts.some(artifact => artifact.path === path)).length / task.expectedArtifacts.length
          : dims.get("buildAndTest") ?? 0.5;
        const result = {
          id: task.id,
          score: rubric.score,
          correctness: dims.get("correctness") ?? 0,
          evidenceEntailment: dims.get("evidenceEntailment") ?? 0,
          toolSuccess: dims.get("toolUse") ?? 0,
          codeBuildTest: artifactScore,
          learningImprovement: turn.learningNeeds.length || task.caseType === "LearningAcquisitionCase" ? 0.72 : 0.42,
          multilingual: dims.get("multilingualTransfer") ?? languageScore(turn.evidence),
          efficiency: dims.get("efficiency") ?? 0,
          auditability: dims.get("auditability") ?? 0,
          notes: [...rubric.notes, `caseType=${task.caseType ?? "SmokeCase"}`, "not frontier-comparable"]
        };
        results.push(result);
        await deps.storage.benchmarks.putCase({ id: `${runId}:${task.id}`, runId, case: task as unknown as JsonValue, result: { ...result, rubric: rubric as unknown as JsonValue } as unknown as JsonValue, score: { score: rubric.score } });
      }
      const score = results.length ? results.reduce((sum, item) => sum + item.score, 0) / results.length : 0;
      await deps.storage.benchmarks.putRun({ id: runId, config: (input.config ?? { tasks }) as JsonValue, startedAt, completedAt: clock.now(), summary: { score, tasks: results.length } });
      events.push(await append(eventFactory.create({ episodeId, typeId: "TestExecuted", payload: { runId, tasks: results.length, score } })));
      return { runId, tasks: results, score, events, note: "Benchmarks are persisted local executions. Frontier comparisons are not claimed unless separately run." };
    }
  };

  return kernel;
}

interface LearnedGraphPriorFact {
  subject: string;
  predicate: string;
  object: string;
  sourceNodeId: string;
  targetNodeId: string;
  relationId: string;
  forceClass: string;
  score: number;
  activation: number;
  overlap: number;
  support: number;
  sourceVersionId?: string;
  evidenceIds: string[];
  ppfMass: number;
  sourceActivation: number;
  targetActivation: number;
  graphQuality: GraphEdgeQuality;
  cognitiveEdge: CognitiveEdge;
  questionEdgeFit: QuestionEdgeFit;
}

interface CleanPriorTerm {
  text: string;
  markerId?: string;
}

interface SemanticAnswerConstructFact {
  subject: string;
  predicate: string;
  object: string;
  sourceNodeId: string;
  targetNodeId: string;
  relationId: string;
  forceClass: string;
  score: number;
  activation: number;
  overlap: number;
  support: number;
  sourceVersionId?: string;
  evidenceIds?: string[];
  roleId?: string;
  alphaRhetoricalCentrality?: number;
  pathScore?: number;
  roleScore?: number;
  bridgeValue?: number;
  backgroundPenalty?: number;
  forceMeaning?: number;
  certificationPower?: number;
  semanticQuality?: number;
  graphQualityClassId?: string;
  answerGrade?: boolean;
  cognitiveEdgeId?: string;
  requestedSlotId?: string;
  relationRoleId?: string;
  topicSenseId?: string;
  finalQuestionFit?: number;
  questionSlotId?: string;
  questionSlotImportance?: string;
  questionSlotScore?: number;
  questionSlotReasonIds?: string[];
}

interface SemanticAnswerSlot {
  id: string;
  relationIds: string[];
  factKeys: string[];
  support: number;
  activation: number;
}

interface SemanticAnswerConstructState {
  schema: "scce.semantic_answer_construct.v1";
  questionShapeId: string;
  selectedSubject: string;
  selectedFacts: SemanticAnswerConstructFact[];
  answerSlots: SemanticAnswerSlot[];
  selectedRelations: string[];
  activatedNeighborhood: SemanticAnswerConstructFact[];
  rejectedCandidates: Array<{ relationId: string; sourceNodeId: string; targetNodeId: string; reasonId: string; score: number }>;
  supportIds: string[];
  forceId: "output.force.learned_concept_prior_answer";
  boundaryId: "output.force.import_bound";
  activeBrainVersion: string;
  activeImportRunIds: string[];
  relevanceGate: RelevanceGate;
  cognitiveFabric: QuestionCognitiveFabric;
  questionSlotPlan: QuestionSlotPlan;
  explanatoryAnswerContract: ExplanatoryAnswerContract;
  alphaRhetoricalPlan: AlphaRhetoricalPlan;
  certificationBoundary: {
    directEvidenceCount: number;
    evidenceSpanIds: string[];
    sourceVersionIds: string[];
    externalFactCertification: boolean;
  };
}

type RelevanceGateDecision = QuestionEdgeDecisionId;

interface RelevanceGate {
  schema: "scce.relevance_gate.v1";
  queryFingerprint: string;
  normalizedQuerySignals: string[];
  candidateSubjectMatches: Array<{ label: string; affinity: number; nodeIds: string[] }>;
  activatedNodeCount: number;
  activatedEdgeCount: number;
  selectedPathCount: number;
  maxSubjectAffinity: number;
  maxQuestionOverlap: number;
  alphaSupportMass: number;
  ppfSupportMass: number;
  relationSupportMass: number;
  answerGradeGraphPriorCount: number;
  weakGraphPriorCount: number;
  categoryGraphPriorCount: number;
  noisyGraphPriorCount: number;
  answerGradeSupportMass: number;
  weakGraphSupportMass: number;
  requestedCognitiveSupportCount: number;
  requestedCognitiveSupportMass: number;
  missingRequestedSlots: string[];
  selectedTopicSenseId: string;
  languageOnlySupportMass: number;
  directEvidenceCount: number;
  learnedGraphPriorCount: number;
  learnedLanguagePriorCount: number;
  relevanceScore: number;
  decision: RelevanceGateDecision;
  reasonIds: string[];
}

interface ExplanatoryAnswerContract {
  schema: "scce.explanatory_answer_contract.v1";
  questionShapeId: string;
  mainSubjectCandidates: string[];
  selectedMainSubject: string;
  requestedFocuses: string[];
  requiredSlots: string[];
  optionalSlots: string[];
  filledSlots: string[];
  unsupportedSlots: string[];
  relevanceGate: RelevanceGate;
  alphaAnswerPlan?: AlphaRhetoricalPlan;
  rhetoricalPlan: JsonValue;
  certificationBoundary: JsonValue;
  targetSurfaceExtent: { floor: number; target: number; ceiling: number };
  questionSlotPlan?: QuestionSlotPlan;
}

interface InsufficientSupportConstructState {
  schema: "scce.insufficient_support_construct.v1";
  questionShapeId: string;
  selectedMainSubject: string;
  requestedFocuses: string[];
  closestSubjectCandidates: string[];
  relevanceGate: RelevanceGate;
  explanatoryAnswerContract: ExplanatoryAnswerContract;
  activeBrainVersion: string;
  activeImportRunIds: string[];
  certificationBoundary: {
    directEvidenceCount: number;
    externalFactCertification: false;
  };
}

interface GraphNodeAnswerConstructState {
  schema: "scce.graph_node_answer_construct.v1";
  questionShapeId: string;
  selectedSubject: string;
  requestedFocuses: string[];
  answerSurface: string;
  selectedNodes: GraphNodeAnswerRow[];
  forceId: "output.force.learned_graph_node_answer";
  boundaryId: "output.force.import_bound";
  activeBrainVersion: string;
  activeImportRunIds: string[];
  certificationBoundary: {
    directEvidenceCount: number;
    evidenceSpanIds: string[];
    sourceVersionIds: string[];
    externalFactCertification: boolean;
  };
}

interface GraphNodeAnswerRow {
  nodeId: string;
  surface: string;
  score: number;
  alpha: number;
  activation: number;
  ppfMass: number;
  featureOverlap: number;
  surfaceOverlap: number;
  forceClass: string;
}

interface AlphaRhetoricalAssignment {
  id: string;
  factKey: string;
  relationId: string;
  sourceNodeId: string;
  targetNodeId: string;
  roleId: string;
  arc: number;
  pathScore: number;
  roleScore: number;
  pathActivation: number;
  relationSupport: number;
  bridgeValue: number;
  backgroundPenalty: number;
  contradictionPressure: number;
  forceMeaning: number;
  certificationPower: number;
  semanticQuality: number;
  graphQualityClassId: string;
  answerGrade: boolean;
  selected: boolean;
  shouldSurface: boolean;
}

interface AlphaRhetoricalPlan {
  schema: "scce.alpha_rhetorical_plan.v1";
  plannerId: "walsh.alpha_rhetorical_centrality";
  selectedSubject: string;
  selectedSubjectNodeIds: string[];
  requiredRoleIds: string[];
  optionalRoleIds: string[];
  selectedRoleIds: string[];
  backgroundRoleIds: string[];
  assignments: AlphaRhetoricalAssignment[];
  selectedFactKeys: string[];
  backgroundFactKeys: string[];
  planEnergy: number;
  explanationCompleteness: number;
  targetSentenceCount: number;
  proofBoundaryId: "output.force.import_bound";
  audit: JsonValue;
}

function selectedCandidateEntailment(entailment: TurnResult["entailment"], selected: CandidateSurface): TurnResult["entailment"] {
  if (selected.force === entailment.force) {
    return {
      ...entailment,
      evidenceIds: [...selected.evidenceIds],
      boundaries: [...new Set([...entailment.boundaries, `selected-candidate:${selected.id}`])]
    };
  }
  return {
    ...entailment,
    force: selected.force,
    evidenceIds: [...selected.evidenceIds],
    proof: {
      ...entailment.proof,
      verdict: selected.force,
      confidence: toJsonValue({
        ...jsonRecord(entailment.proof.confidence),
        selectedCandidateId: selected.id,
        selectedCandidateKind: selected.kind,
        selectedCandidateForce: selected.force,
        originalEntailmentForce: entailment.force
      }),
      scores: {
        ...jsonRecord(entailment.proof.scores),
        selectedCandidate: toJsonValue({
          id: selected.id,
          kind: selected.kind,
          force: selected.force,
          evidenceIds: selected.evidenceIds.map(String),
          boundaries: selected.boundaries
        })
      }
    },
    confidence: {
      ...entailment.confidence,
      verdict: selected.force === "unknown" ? "unknown" : entailment.confidence.verdict
    },
    boundaries: [...new Set([...entailment.boundaries, `selected-candidate:${selected.id}`, `selected-force:${selected.force}`])]
  };
}

function calibrationTaskClassForAuthority(authority: RequestedAuthority): string {
  if (authority === "creative") return CALIBRATION_TASK_CLASS_IDS.creativeGeneration;
  if (authority === "program") return CALIBRATION_TASK_CLASS_IDS.codeAnswer;
  if (authority === "action") return CALIBRATION_TASK_CLASS_IDS.workspaceAnswer;
  if (authority === "reasoned" || authority === "translation") return CALIBRATION_TASK_CLASS_IDS.dialogueOutcome;
  return CALIBRATION_TASK_CLASS_IDS.sourceBoundQa;
}

function calibrationTaskClassForRequirements(requirements: TurnRequirementField, authority: RequestedAuthority): string {
  if (requirements.executableArtifactDemand >= 0.6) {
    return authority === "action" ? CALIBRATION_TASK_CLASS_IDS.workspaceAnswer : CALIBRATION_TASK_CLASS_IDS.codeAnswer;
  }
  if (requirements.noveltyDemand >= 0.6) return CALIBRATION_TASK_CLASS_IDS.creativeGeneration;
  if (requirements.surfaceTransformation >= 0.6 && requirements.semanticPreservation >= 0.6) return CALIBRATION_TASK_CLASS_IDS.translation;
  if (requirements.inferentialDepth >= 0.5 || requirements.causalReasoningDemand >= 0.5 || requirements.temporalReasoningDemand >= 0.5 || requirements.counterfactualDemand >= 0.5) {
    return CALIBRATION_TASK_CLASS_IDS.generalCognition;
  }
  return calibrationTaskClassForAuthority(authority);
}

function explicitTurnRequirementsFromInput(input: OwnerInput, authority?: RequestedAuthority): ExplicitTurnRequirement[] {
  const metadata = jsonRecord(input.metadata);
  const nestedRequest = jsonRecord(metadata.request);
  const rows = [
    ...(Array.isArray(metadata.turnRequirements) ? metadata.turnRequirements : []),
    ...(Array.isArray(nestedRequest.turnRequirements) ? nestedRequest.turnRequirements : [])
  ];
  const explicit: ExplicitTurnRequirement[] = [];
  for (const value of rows) {
    const row = jsonRecord(value);
    const dimension = kernelString(row.dimension);
    if (!dimension || !isTurnRequirementDimension(dimension)) continue;
    const span = jsonRecord(row.span);
    const charStart = Math.max(0, Math.trunc(kernelNumber(span.charStart, 0)));
    const charEnd = Math.max(charStart, Math.trunc(kernelNumber(span.charEnd, [...input.text].length)));
    explicit.push({
      id: kernelString(row.id) || undefined,
      dimension,
      value: Math.max(0, Math.min(1, kernelNumber(row.value, 0))),
      confidence: Math.max(0, Math.min(1, kernelNumber(row.confidence, 1))),
      polarity: row.polarity === "prohibited" ? "prohibited" : "required",
      status: row.status === "inferred" ? "inferred" : "explicit",
      span: { charStart, charEnd },
      semanticRoleId: kernelString(row.semanticRoleId) || "role.request.requirement.v1",
      learnedFrameOrPatternId: kernelString(row.learnedFrameOrPatternId) || "pattern.structured_api.requirement.v1",
      dialogueReferenceId: kernelString(row.dialogueReferenceId) || undefined,
      sourceActivationId: kernelString(row.sourceActivationId) || "activation.structured_api.requirement.v1",
      trace: row.trace ?? toJsonValue({ source: "owner_input.metadata.turnRequirements" })
    });
  }
  if (!authority) return explicit;
  const authorityValues: Partial<Record<(typeof TURN_REQUIREMENT_DIMENSIONS)[number], number>> =
    authority === "creative" ? { noveltyDemand: 0.96, inferentialDepth: 0.62, uncertaintyTolerance: 0.74 }
      : authority === "translation" ? { semanticPreservation: 0.97, surfaceTransformation: 0.96, audienceAdaptation: 0.64 }
        : authority === "program" ? { executableArtifactDemand: 0.96, inferentialDepth: 0.72, formatConstraintStrength: 0.62 }
          : authority === "action" ? { actionCommitment: 0.97, executableArtifactDemand: 0.72, externalTruthAuthority: 0.78 }
            : authority === "reasoned" ? { inferentialDepth: 0.9, externalTruthAuthority: 0.62, uncertaintyTolerance: 0.46 }
              : { externalTruthAuthority: 0.92, sourceDependence: 0.82, uncertaintyTolerance: 0.34 };
  for (const [dimension, value] of Object.entries(authorityValues)) {
    if (!isTurnRequirementDimension(dimension) || value === undefined) continue;
    explicit.push({
      id: `requirement.structured_authority.${authority}.${dimension}.v1`,
      dimension,
      value,
      confidence: 1,
      polarity: "required",
      status: "explicit",
      span: { charStart: 0, charEnd: [...input.text].length },
      semanticRoleId: "role.request.authority.v1",
      learnedFrameOrPatternId: `pattern.structured_authority.${authority}.v1`,
      sourceActivationId: "activation.structured_api.authority.v1",
      trace: toJsonValue({ source: "OwnerInput.requestedAuthority", authority })
    });
  }
  return explicit;
}

function requirementContextFromMetadata(metadata: JsonValue | undefined): Partial<Record<(typeof TURN_REQUIREMENT_DIMENSIONS)[number], number>> {
  const root = jsonRecord(metadata);
  const context = jsonRecord(root.requirementContext);
  const out: Partial<Record<(typeof TURN_REQUIREMENT_DIMENSIONS)[number], number>> = {};
  for (const dimension of TURN_REQUIREMENT_DIMENSIONS) {
    const value = context[dimension];
    if (typeof value === "number" && Number.isFinite(value)) out[dimension] = Math.max(-4, Math.min(4, value));
  }
  return out;
}

function operatorDialogueSupport(requirements: TurnRequirementField): Partial<Record<CognitiveOperatorId, number>> {
  return {
    [COGNITIVE_OPERATOR_IDS.dialogueContinuation]: Math.max(-1, Math.min(1, requirements.dialogueDependence * 0.5)),
    [COGNITIVE_OPERATOR_IDS.clarification]: Math.max(-1, Math.min(1, (1 - requirements.confidence) * 0.35))
  };
}

function operatorGraphSupport(graph: GraphSlice, evidence: readonly EvidenceSpan[], field: TurnResult["field"]): Partial<Record<CognitiveOperatorId, number>> {
  const sourceCount = new Set(evidence.map(span => String(span.sourceVersionId))).size;
  const graphMass = Math.max(0, Math.min(1, Math.log2(1 + graph.edges.length) / 8));
  const evidenceMass = Math.max(0, Math.min(1, Math.log2(1 + evidence.length) / 5));
  const causalMass = Math.max(0, Math.min(1, mean(field.causalMass.slice(0, 12).map(row => row.mass))));
  const hasQualifiedTime = graph.edges.some(edge => edge.temporalScope.validTo !== undefined);
  return {
    [COGNITIVE_OPERATOR_IDS.evidenceActivation]: evidenceMass,
    [COGNITIVE_OPERATOR_IDS.graphPropagation]: graphMass,
    [COGNITIVE_OPERATOR_IDS.sourceSynthesis]: sourceCount >= 2 ? Math.min(1, sourceCount / 4) : 0,
    [COGNITIVE_OPERATOR_IDS.relationComposition]: graph.edges.length >= 2 ? graphMass : 0,
    [COGNITIVE_OPERATOR_IDS.semanticProof]: evidenceMass,
    [COGNITIVE_OPERATOR_IDS.temporalAnalysis]: hasQualifiedTime ? graphMass : 0,
    [COGNITIVE_OPERATOR_IDS.causalAnalysis]: causalMass
  };
}

function operatorOutcomeSupport(metadata: JsonValue | undefined): Partial<Record<CognitiveOperatorId, number>> {
  const root = jsonRecord(metadata);
  const support = jsonRecord(root.operatorOutcomeSupport);
  const out: Partial<Record<CognitiveOperatorId, number>> = {};
  for (const operatorId of Object.values(COGNITIVE_OPERATOR_IDS)) {
    const value = support[operatorId];
    if (typeof value === "number" && Number.isFinite(value)) out[operatorId] = Math.max(-1, Math.min(1, value));
  }
  return out;
}

function requestedAuthorityFromRequirementField(requirements: TurnRequirementField, explicit?: RequestedAuthority): RequestedAuthority {
  if (explicit) return explicit;
  const scores: Record<RequestedAuthority, number> = {
    factual: 0.42 + 0.34 * requirements.externalTruthAuthority + 0.24 * requirements.sourceDependence,
    reasoned: 0.18 + 0.62 * requirements.inferentialDepth + 0.12 * requirements.causalReasoningDemand + 0.08 * requirements.temporalReasoningDemand,
    creative: 0.10 + 0.72 * requirements.noveltyDemand + 0.18 * requirements.counterfactualDemand,
    translation: 0.08 + 0.47 * requirements.semanticPreservation + 0.45 * requirements.surfaceTransformation,
    program: 0.08 + 0.72 * requirements.executableArtifactDemand + 0.20 * requirements.formatConstraintStrength,
    action: 0.08 + 0.78 * requirements.actionCommitment + 0.14 * requirements.executableArtifactDemand
  };
  return (Object.keys(scores) as RequestedAuthority[])
    .sort((left, right) => scores[right] - scores[left] || left.localeCompare(right))[0] ?? "factual";
}

function isTurnRequirementDimension(value: string): value is (typeof TURN_REQUIREMENT_DIMENSIONS)[number] {
  return (TURN_REQUIREMENT_DIMENSIONS as readonly string[]).includes(value);
}

function cognitiveProposalForCandidate(candidate: CandidateSurface, proposals: readonly CognitiveProposal[]): CognitiveProposal | undefined {
  if (candidate.proposalId) return proposals.find(proposal => proposal.id === candidate.proposalId);
  const audit = jsonRecord(candidate.audit);
  const proposalId = kernelString(audit.proposalId);
  return proposals.find(proposal => proposal.id === proposalId);
}

function attachCognitiveProposal(input: { construct: ConstructGraph; proposal?: CognitiveProposal }): ConstructGraph {
  if (!input.proposal) return input.construct;
  const node = {
    id: `construct:cognitive-proposal:${input.proposal.id}`,
    kind: "construct:cognitive-proposal",
    label: "cognitive proposal",
    metadata: toJsonValue({
      schema: "scce.cognitive_proposal.construct.v1",
      proposalId: input.proposal.id,
      claimBases: input.proposal.claims.map(claim => ({
        claimId: claim.id,
        basis: claim.basis,
        evidenceIds: claim.evidenceIds,
        actionReceiptId: claim.actionReceiptId ?? null
      })),
      operatorIds: input.proposal.operatorActivations.map(operator => operator.operatorId),
      constructIds: input.proposal.constructIds,
      quality: input.proposal.quality,
      trace: input.proposal.trace
    })
  };
  return {
    ...input.construct,
    nodes: [...input.construct.nodes.filter(existing => existing.id !== node.id), node],
    edges: [
      ...input.construct.edges.filter(edge => edge.source !== node.id && edge.target !== node.id),
      {
        source: input.construct.nodes.find(existing => existing.id === "request")?.id ?? input.construct.nodes[0]?.id ?? "request",
        target: node.id,
        relation: "licenses_cognitive_proposal",
        weight: Math.max(0, Math.min(1, input.proposal.quality.mmr))
      }
    ]
  };
}

function selectedCandidateRevisionQuality(judged: JudgeDecision, spoken: SpokenOutput): number {
  const judgeScore = judged.scores.find(row => row.candidateId === judged.selected.id)?.score ?? 0;
  const mouthScore = spoken.realizationTrace.candidates.find(row => row.id === spoken.realizationTrace.selected.id)?.score ?? 0;
  return Math.max(0, Math.min(1, 0.56 * Math.max(0, Math.min(1, judgeScore)) + 0.44 * Math.max(0, Math.min(1, mouthScore))));
}

function revisionAnswerVersion(input: {
  id: string;
  proposal: CognitiveProposal;
  candidate: CandidateSurface;
  spoken: SpokenOutput;
  evidence: readonly EvidenceSpan[];
  dialogueState: ReturnType<typeof updateDialogueState>;
  validation: TurnResult["validationGraph"];
  quality: number;
}): RevisionAnswerVersion {
  const validationResults = revisionValidationResults(input);
  return {
    id: input.id,
    selectedProposal: input.proposal,
    selectedCandidate: input.candidate,
    mouthOutput: { text: input.spoken.text, evidenceRefs: input.spoken.evidenceRefs },
    claimBases: input.proposal.claims.map(claim => ({
      claimId: claim.id,
      basis: claim.basis,
      evidenceIds: claim.evidenceIds,
      trace: claim.trace
    })),
    evidence: input.evidence,
    dialogueState: input.dialogueState,
    validationResults,
    quality: {
      score: input.quality,
      hardFailures: validationResults.hardFailures,
      trace: toJsonValue({
        source: "judge_and_mouth",
        score: input.quality,
        candidateId: input.candidate.id,
        mouthCandidateId: input.spoken.realizationTrace.selected.id
      })
    }
  };
}

function revisionValidationResults(input: {
  proposal: CognitiveProposal;
  candidate: CandidateSurface;
  spoken: SpokenOutput;
  evidence: readonly EvidenceSpan[];
  validation: TurnResult["validationGraph"];
}): RevisionValidationResults {
  const satisfied = new Set(input.proposal.satisfiedRequirementIds);
  const evidenceIds = new Set(input.evidence.map(span => String(span.id)));
  const proposalEvidenceIds = new Set([
    ...input.proposal.evidenceIds.map(String),
    ...input.proposal.claims.flatMap(claim => claim.evidenceIds.map(String))
  ]);
  const issues: Array<RevisionValidationResults["issues"][number]> = [];
  const hardFailures: Array<RevisionValidationResults["hardFailures"][number]> = [];
  const quality = input.candidate.quality;
  if ((quality?.telemetryLeak ?? 0) > 0) {
    issues.push({
      kind: "telemetry_leak",
      severity: "hard_failure",
      correction: "remove_telemetry",
      confidence: 1,
      trace: toJsonValue({ candidateId: input.candidate.id })
    });
    hardFailures.push({ id: "revision.hard.telemetry_leak.v1", kind: "telemetry_leak", trace: input.candidate.audit });
  }
  if ((quality?.fakeFactualAuthority ?? 0) > 0 || (quality?.unsupportedFactRate ?? 0) > 0) {
    issues.push({
      kind: (quality?.fakeFactualAuthority ?? 0) > 0 ? "citation_mismatch" : "unsupported_factual_claim",
      severity: (quality?.fakeFactualAuthority ?? 0) > 0 ? "hard_failure" : "error",
      correction: (quality?.fakeFactualAuthority ?? 0) > 0 ? "repair_citation_binding" : "ground_or_qualify_claim",
      confidence: Math.max(quality?.fakeFactualAuthority ?? 0, quality?.unsupportedFactRate ?? 0),
      trace: input.candidate.audit
    });
  }
  if ((quality?.testWeakening ?? 0) > 0) {
    issues.push({
      kind: "test_weakening",
      severity: "hard_failure",
      correction: "restore_test_strength",
      confidence: 1,
      trace: input.candidate.audit
    });
    hardFailures.push({ id: "revision.hard.test_weakening.v1", kind: "test_weakening", trace: input.candidate.audit });
  }
  return {
    validationGraph: input.validation,
    requirementChecks: [
      ...input.proposal.satisfiedRequirementIds.map(requirementId => ({
        requirementId,
        satisfied: true,
        confidence: 1,
        trace: toJsonValue({ proposalId: input.proposal.id })
      })),
      ...input.proposal.missedRequirementIds.map(requirementId => ({
        requirementId,
        satisfied: satisfied.has(requirementId),
        confidence: 1,
        trace: toJsonValue({ proposalId: input.proposal.id })
      }))
    ],
    citationChecks: input.spoken.evidenceRefs.map(evidenceId => ({
      evidenceId,
      matched: evidenceIds.has(String(evidenceId)) && proposalEvidenceIds.has(String(evidenceId)),
      confidence: 1,
      trace: toJsonValue({
        evidenceId,
        existsInTurnEvidence: evidenceIds.has(String(evidenceId)),
        licensedByProposal: proposalEvidenceIds.has(String(evidenceId))
      })
    })),
    issues,
    hardFailures,
    trace: toJsonValue({
      schema: "scce.answer_revision.validation.v1",
      validationGraphId: input.validation.id,
      validationPassed: input.validation.passed,
      proposalId: input.proposal.id,
      candidateId: input.candidate.id
    })
  };
}

function requestedAuthorityFromTurnInput(input: OwnerInput, translationTarget?: string): RequestedAuthority | undefined {
  if (isRequestedAuthority(input.requestedAuthority)) return input.requestedAuthority;
  const metadata = jsonRecord(input.metadata);
  const nested = jsonRecord(metadata.request);
  const explicit = metadata.requestedAuthority ?? nested.requestedAuthority;
  if (isRequestedAuthority(explicit)) return explicit;
  return translationTarget ? "translation" : undefined;
}

function dialogueActionIdsFromMetadata(metadata: JsonValue | undefined): string[] {
  const record = jsonRecord(metadata);
  const dialogue = jsonRecord(record.dialogue);
  return uniqueKernelStrings([
    ...kernelStringArray(record.dialogueActionIds),
    ...kernelStringArray(record.policyActionIds),
    ...kernelStringArray(dialogue.selectedActionIds)
  ]).slice(0, 32);
}

function isRequestedAuthority(value: unknown): value is RequestedAuthority {
  return value === "factual" || value === "reasoned" || value === "creative" || value === "translation" || value === "program" || value === "action";
}

function attachInventionConstruct(input: { construct: ConstructGraph; invention?: InventionConstruct }): ConstructGraph {
  if (!input.invention) return input.construct;
  const node = inventionConstructNode(input.invention);
  return {
    ...input.construct,
    nodes: [
      ...input.construct.nodes.filter(existing => existing.id !== node.id),
      node
    ],
    edges: [
      ...input.construct.edges.filter(edge => edge.source !== node.id && edge.target !== node.id),
      {
        source: input.construct.nodes.find(existing => existing.id === "request")?.id ?? input.construct.nodes[0]?.id ?? "request",
        target: node.id,
        relation: "licenses_invention",
        weight: Math.max(0, Math.min(1, input.invention.supportScore * 0.45 + input.invention.noveltyScore * 0.35 + (1 - input.invention.riskScore) * 0.2))
      }
    ]
  };
}

function selectedInventionForCandidate(candidate: CandidateSurface, inventions: readonly InventionConstruct[]): InventionConstruct | undefined {
  if (candidate.kind !== "creative-candidate") return undefined;
  const inventionId = kernelString(jsonRecord(candidate.audit).inventionConstructId)
    ?? kernelString(jsonRecord(candidate.audit).constructId);
  return inventions.find(invention => invention.id === inventionId) ?? inventions[0];
}

function evaluationQuestionId(metadata: JsonValue | undefined, episodeId: EpisodeId): string {
  const record = jsonRecord(metadata);
  return kernelString(record.questionId)
    ?? kernelString(record.benchmarkTaskId)
    ?? kernelString(jsonRecord(record.evaluation).questionId)
    ?? String(episodeId);
}

function emptySurfaceLanguageMemory(): {
  models: never[];
  observations: never[];
  units: never[];
  patterns: never[];
  semanticFrames: never[];
  state: LanguageMemoryRuntimeState;
  active: { activeImportRunIds: never[] };
  corpusPlan: never[];
} {
  const competenceVector = {
    scriptRecognition: 0,
    segmentationQuality: 0,
    lexicalCoverage: 0,
    phraseFluency: 0,
    syntacticCoverage: 0,
    semanticFrameCoverage: 0,
    translationAlignment: 0,
    entailmentReliability: 0,
    generationReliability: 0,
    correctionStability: 0,
    localizationReliability: 0
  };
  return {
    models: [],
    observations: [],
    units: [],
    patterns: [],
    semanticFrames: [],
    state: {
      models: [],
      records: [],
      streamIds: [],
      languageHints: [],
      maxOrder: 0,
      observedSymbolCount: 0,
      vocabularySize: 0,
      importedUnits: [],
      importedPatterns: [],
      importedObservations: [],
      importedSemanticFrames: [],
      importedLanguagePriorCount: 0,
      competenceVector,
      audit: toJsonValue({ source: "evaluation.language-memory-bypass", conditionDisabled: true })
    },
    active: { activeImportRunIds: [] },
    corpusPlan: []
  };
}

function surfaceLanguageMemoryProfile(state: LanguageMemoryRuntimeState, disabled: boolean): JsonValue {
  if (disabled) return toJsonValue({ bypassed: true, reason: "condition-disabled", importedLanguagePriorCount: 0 });
  return toJsonValue({
    streamIds: state.streamIds,
    languageHints: state.languageHints,
    maxOrder: state.maxOrder,
    observedSymbolCount: state.observedSymbolCount,
    vocabularySize: state.vocabularySize,
    importedLanguagePriorCount: state.importedLanguagePriorCount,
    competenceVector: state.competenceVector,
    audit: state.audit
  });
}

function disabledLearnedSemanticRetrieval(text: string, features: string[], hasher: ReturnType<typeof createHasher>): {
  retrieval: HybridRetrievalResult;
  roleRetrieval: RetrievalPlan;
} {
  const query: RetrievalQuery = { text, features, limit: 80 };
  const audit = toJsonValue({ source: "evaluation.learned-semantics-bypass", reason: "condition-disabled", lexicalSelectionRemainsInEvidenceBoundary: true });
  return {
    retrieval: {
      plan: {
        id: `retrieval_plan_disabled_${hasher.digestHex(text).slice(0, 24)}`,
        query,
        terms: [],
        shards: [],
        postgres: { preparedStatements: [], transaction: "read_committed", cursorRows: 0 },
        residentMemoryBytes: 0,
        audit
      },
      candidates: [],
      selectedEvidenceIds: [],
      selectedNodeIds: [],
      diagnostics: audit
    },
    roleRetrieval: {
      query: text,
      queryFeatures: features,
      recall: [],
      expansionFeatures: [],
      graphSeeds: [],
      audit
    }
  };
}

function queryConditionedSemanticSeedAnchors(
  candidates: readonly HybridRetrievalResult["candidates"][number][],
  queryFeatures: readonly string[],
  limit = 40
): PowerWalkSeedAnchor[] {
  const bestByNode = new Map<string, PowerWalkSeedAnchor>();
  for (const candidate of candidates) {
    if (!candidate.nodeId || !Number.isFinite(candidate.score) || candidate.score <= 0) continue;
    const overlap = weightedJaccard(queryFeatures, candidate.features);
    if (!(overlap > 0)) continue;
    const seed: PowerWalkSeedAnchor = {
      nodeId: candidate.nodeId,
      weight: Math.max(0, Math.min(1, candidate.score)),
      feature: `semantic-retrieval:query-overlap:${overlap.toFixed(6)}`
    };
    const key = String(seed.nodeId);
    const existing = bestByNode.get(key);
    if (!existing || seed.weight > existing.weight) bestByNode.set(key, seed);
  }
  return [...bestByNode.values()]
    .sort((left, right) => right.weight - left.weight || String(left.nodeId).localeCompare(String(right.nodeId)))
    .slice(0, Math.max(0, Math.min(64, Math.floor(limit))));
}

function emptyPowerWalkResult(): PowerWalkResult {
  return {
    walks: [],
    embeddings: [],
    typePairWalkLengths: [],
    transitionAudit: [],
    cooccurrence: [],
    cooccurrenceState: { version: "powerwalk.cooccurrence.v3", window: 4, partitionPolicyHash: "evaluation-disabled", totalCount: 0, appliedSnapshotIds: [], entries: [] },
    representation: {
      version: "powerwalk.sparse-ppmi-projection.v1",
      method: "positive_pointwise_mutual_information_with_seeded_sparse_projection",
      dimensions: 64,
      projectionSeed: "evaluation-disabled",
      trainPairs: 0,
      trainEvents: 0,
      priorEvents: 0,
      positivePpmiEntries: 0,
      representedNodes: 0,
      zeroContextNodes: 0,
      validationPairs: 0,
      validationEvents: 0,
      partitionPolicyHash: "evaluation-disabled",
      currentSplitHash: "evaluation-disabled",
      validationHash: "evaluation-disabled",
      priorStateDisposition: "not_provided",
      dataHash: "evaluation-disabled-no-data",
      modelHash: "evaluation-disabled-no-model",
      validationInterpretation: "not_available",
      excludedZeroContextNodes: 0,
      zeroContextPolicy: "excluded_from_similarity"
    },
    calibration: toJsonValue({ source: "evaluation.powerwalk-bypass", reason: "condition-disabled" })
  };
}

function createAblatedSupportEntailment(input: {
  requestText: string;
  field: TurnResult["field"];
  idFactory: Pick<IdFactory, "claimId" | "proofId">;
  createdAt: number;
}): TurnResult["entailment"] {
  const normalized = normalizePriorKey(input.requestText);
  const features = featureSet(input.requestText, 256);
  const claim = {
    id: input.idFactory.claimId({ normalized, polarity: 1, features: features.slice(0, 96) }),
    text: input.requestText,
    normalized,
    features,
    polarity: 1
  };
  const transformIds = ["evaluation-support-bypass"];
  const proofId = input.idFactory.proofId({ claimId: claim.id, evidenceIds: [], transforms: transformIds, validatorVersion: "scce-evaluation-support-bypass-v1" });
  const scores = {
    structuralCoverage: 0,
    roleCoverage: 0,
    relationCompatibility: 0,
    transformationSupport: 0,
    causalMass: 0,
    faithfulnessLCB: 0,
    contradiction: 0,
    stability: 0
  };
  const confidence = {
    verdict: "unknown" as const,
    support: 0,
    contradiction: 0,
    faithfulnessLcb: 0,
    supportingEvidence: 0,
    sourceVersions: [],
    structuralCoverage: 0,
    roleCoverage: 0,
    relationCompatibility: 0,
    transformationSupport: 0,
    causalMass: 0,
    stability: 0,
    satisfiedObligations: 0,
    requiredObligations: 1
  };
  return {
    claim,
    verdict: "unknown",
    semanticVerdict: "unknown",
    force: "unknown",
    support: 0,
    contradiction: 0,
    faithfulnessLcb: 0,
    confidence,
    scores,
    obligations: [{
      id: "obligation:evaluation-support-engine-disabled",
      kind: "source_version",
      status: "missing",
      claimText: input.requestText,
      evidenceIds: [],
      sourceVersionIds: [],
      support: 0,
      contradiction: 0,
      required: true,
      reason: "evaluation.support_engine.disabled",
      metadata: toJsonValue({ supportEngineExecuted: false })
    }],
    mappings: [],
    transforms: [],
    counterexamples: [],
    missing: [],
    proof: {
      id: proofId,
      claimId: claim.id,
      verdict: "unknown",
      confidence: toJsonValue({ ...confidence, supportEngineExecuted: false }),
      proofGraph: {
        nodes: [{ id: String(claim.id), kind: "claim", label: "proof.claim.support_engine_disabled", metadata: toJsonValue({ textHash: hashTextForLocalProof(input.requestText) }) }],
        edges: []
      },
      evidenceIds: [],
      transformIds,
      scores: toJsonValue({ supportEngineExecuted: false, scores }),
      validatorVersion: "scce-evaluation-support-bypass-v1",
      createdAt: input.createdAt
    },
    evidenceIds: [],
    boundaries: ["support-engine-disabled", "non-certifying"]
  };
}

function emptySemanticProofResult(text: string, hasher: ReturnType<typeof createHasher>): SemanticProofResult {
  const replay = toJsonValue({ source: "evaluation.support-engine-bypass", claimHash: hasher.digestHex(text), supportEngineExecuted: false });
  return {
    id: `semantic_proof_disabled_${hasher.digestHex(text).slice(0, 24)}`,
    verdict: "underdetermined",
    claimAtoms: [],
    evidenceAtoms: [],
    graphAtoms: [],
    support: 0,
    contradiction: 0,
    coverage: 0,
    faithfulnessLcb: 0,
    obligations: [],
    counterexamples: [],
    steps: [],
    graph: { nodes: [], edges: [] },
    replay
  };
}

function emptyCcrResult(text: string): CcrResult {
  const audit = toJsonValue({ source: "evaluation.support-engine-bypass", queryHash: hashTextForLocalProof(text), accepted: false });
  return {
    l1: { candidates: [], queryFeatures: [], audit },
    l2: { survivors: [], prunedEdges: 0, davisKahan: null, chernoff: null, sde: null, minimumCover: null, audit } as unknown as CcrResult["l2"],
    l3: { sentences: [], answer: "", abstentions: ["support-engine-disabled"], audit },
    accepted: false,
    audit
  };
}

function previewTraceText(value: string, maxChars = 600): string {
  return value.length <= maxChars ? value : `${value.slice(0, maxChars)}...`;
}

function afterTurnMaintenanceDecision(input: { translationTarget?: string; construct: ConstructGraph; capabilityPlans: readonly CapabilityPlan[]; assistantForce?: string }): { deferred: boolean; audit: JsonValue } {
  const required: string[] = [];
  if (input.translationTarget) required.push("maintenance.required.translation");
  if (input.construct.program) required.push("maintenance.required.program_construct");
  if (input.construct.artifacts.length > 0) required.push("maintenance.required.artifact_emission");
  if (capabilityPlansRequireForeground(input.capabilityPlans)) required.push("maintenance.required.capability_plan");
  const deferred = required.length === 0;
  const deferredStages = deferred ? [
    "language_acquisition",
    "learning_loop",
    "training_plan",
    "self_model",
    "self_distillation",
    "functional_cognition",
    "forecast_persistence"
  ] : [];
  return {
    deferred,
    audit: toJsonValue({
      source: "kernel.turn.maintenance_boundary",
      deferred,
      required,
      deferredStages,
      assistantForce: input.assistantForce ?? null
    })
  };
}

function requiresForegroundTurnPersistence(input: {
  translationTarget?: string;
  construct: ConstructGraph;
  capabilityPlans: readonly CapabilityPlan[];
  selectedEvidence: readonly EvidenceSpan[];
}): boolean {
  return Boolean(input.translationTarget) ||
    Boolean(input.construct.program) ||
    input.construct.artifacts.length > 0 ||
    capabilityPlansRequireForeground(input.capabilityPlans);
}

function capabilityPlansRequireForeground(plans: readonly CapabilityPlan[]): boolean {
  return plans.some(plan => {
    if (plan.status === "invoked" || plan.status === "succeeded" || plan.status === "failed" || plan.status === "rolled_back") return true;
    const permission = jsonRecord(plan.permission);
    return permission.allowed === true && permission.dryRun === false;
  });
}

function evidenceBatchFromSlice(evidence: readonly EvidenceSpan[], evidenceIds: readonly EvidenceSpan["id"][]): EvidenceSpan[] | undefined {
  const byId = new Map(evidence.map(span => [String(span.id), span]));
  const selected = evidenceIds.map(id => byId.get(String(id)));
  if (selected.some(span => !span)) return undefined;
  return selected.filter((span): span is EvidenceSpan => Boolean(span));
}

function evidenceForRequest(text: string, evidence: readonly EvidenceSpan[], priorityIds: ReadonlySet<string> = new Set()): EvidenceSpan[] {
  const requestFeatures = featureSet(text, 256);
  const anchors = sourceEvidenceAnchorsForRequest(text);
  const orderedRequestUnits = requestUnitsFromText(text);
  const contentUnits = requestContentEvidenceUnits(text);
  const promoted = evidence.filter(span => span.status === "promoted");
  const pool = promoted.length ? promoted : evidence.filter(span => span.status !== "quarantined");
  const rows = pool
    .map(span => {
      const surfaceFeatures = featureSet(sourceTextSurface(span.text || span.textPreview, 24000), 256);
      const lexical = Math.max(weightedJaccard(requestFeatures, span.features), weightedJaccard(requestFeatures, surfaceFeatures));
      const sessionSpan = String(span.id).startsWith("evidence_session_");
      const contentOverlap = evidenceRequestContentOverlap(span, contentUnits);
      const anchorAligned = anchors.length > 0 && (
        evidenceExactSourceAnchorMatches(span, anchors) ||
        evidenceTitleDistinctAnchorMatches(span, anchors) ||
        evidenceSourceMatchesAnchors(span, anchors)
      );
      const priorityAligned = priorityIds.has(String(span.id)) && (
        !anchors.length ||
        evidenceExactSourceAnchorMatches(span, anchors) ||
        evidenceTitleDistinctAnchorMatches(span, anchors) ||
        evidenceRequestAdjacentUnitPairOverlap(span, orderedRequestUnits) >= 2
      );
      const priorityBoost = priorityAligned ? 0.36 : anchorAligned ? 0.22 : 0;
      const alphaBoost = lexical >= 0.025 || priorityAligned || anchorAligned ? span.alpha * 0.18 : 0;
      const sessionBoost = sessionSpan && (lexical >= 0.045 || priorityAligned) ? 0.08 : 0;
      return { span, score: lexical + alphaBoost + sessionBoost + priorityBoost + Math.min(0.16, contentOverlap * 0.04), lexical, priorityAligned, anchorAligned, sessionSpan, contentOverlap };
    })
    .filter(row => {
      if (row.priorityAligned || row.anchorAligned) return true;
      if (!contentUnits.length || row.contentOverlap <= 0) return false;
      return row.lexical >= (row.sessionSpan ? 0.045 : 0.025);
    })
    .sort((a, b) => b.score - a.score || b.span.alpha - a.span.alpha || String(a.span.id).localeCompare(String(b.span.id)));
  const pinned = rows.filter(row =>
    priorityIds.has(String(row.span.id)) &&
    (evidenceExactSourceAnchorMatches(row.span, anchors) || evidenceTitleDistinctAnchorMatches(row.span, anchors))
  );
  return uniqueEvidenceById([...pinned.map(row => row.span), ...rows.map(row => row.span)]).slice(0, 16);
}

function evidenceWithGraphPreviewWindows(text: string, evidence: readonly EvidenceSpan[], nodes: readonly GraphNode[], preserveIds: ReadonlySet<string> = new Set()): EvidenceSpan[] {
  const requestFeatures = featureSet(text, 256);
  const previewsByEvidenceId = new Map<string, string[]>();
  for (const node of nodes) {
    const representation = jsonRecord(node.representation);
    const preview = sourceTextSurface(kernelString(representation.preview) ?? kernelString(representation.textPreview) ?? "", 2400);
    if (!preview) continue;
    const ids = uniqueKernelStrings([
      ...node.evidenceIds.map(String),
      ...kernelStringArray(representation.evidenceIds)
    ]);
    for (const id of ids) {
      const rows = previewsByEvidenceId.get(id) ?? [];
      rows.push(preview);
      previewsByEvidenceId.set(id, rows);
    }
  }
  return evidence.map(span => {
    if (preserveIds.has(String(span.id))) return span;
    const previews = previewsByEvidenceId.get(String(span.id)) ?? [];
    if (!previews.length) return span;
    const currentFull = sourceTextSurface(span.text || span.textPreview, 24000);
    const current = sourceTextSurface(currentFull, 2400);
    const currentScore = weightedJaccard(requestFeatures, featureSet(current, 128));
    const selected = previews
      .map(preview => ({ preview, score: weightedJaccard(requestFeatures, featureSet(preview, 128)) + Math.min(0.12, preview.length / 6000) }))
      .sort((a, b) => b.score - a.score || a.preview.length - b.preview.length)[0];
    if (selected && currentFull.length > Math.max(2400, selected.preview.length * 2)) return span;
    if (!selected || selected.score < Math.max(0.015, currentScore * 0.7)) return span;
    return { ...span, text: selected.preview, textPreview: selected.preview };
  });
}

function runtimeEvidenceWindowsForRequest(text: string, evidence: readonly EvidenceSpan[]): EvidenceSpan[] {
  const requestFeatures = featureSet(text, 256);
  const requestUnits = requestUnitSet(text);
  const definitionAnchor = definitionRequestAnchor(text);
  return evidence.slice(0, 8).map(span => {
    const source = sourceTextSurface(span.text || span.textPreview, 24000);
    if (source.length <= 6000) return span;
    const sentences = source
      .split(/(?<=[.!?。！？])\s+|\n+/u)
      .map(item => item.replace(/\s+/gu, " ").trim())
      .filter(Boolean);
    const leadRows = sentences.slice(0, 6).map((sentence, index) => ({
      sentence,
      index,
      score: definitionAnchor && definitionSentenceMatches(sentence, definitionAnchor) ? 2.5 - index * 0.05 : 0
    }));
    const ranked = sentences
      .map((sentence, index) => ({
        sentence,
        index,
        score: weightedJaccard(requestFeatures, featureSet(sentence, 128)) + Math.min(0.18, Math.max(0, sentence.length - 40) / 1200)
      }))
      .sort((a, b) => b.score - a.score || a.index - b.index)
      .slice(0, 8);
    const dateRows = sentences
      .map((sentence, index) => ({
        sentence,
        index,
        score: requestUnitOverlapForSurface(sentence, requestUnits)
      }))
      .filter(row => row.score > 0 && /\b(1[0-9]{3}|[2-9][0-9]{2}|20[0-9]{2})\b/u.test(row.sentence))
      .sort((a, b) => a.index - b.index)
      .slice(0, 6);
    const sectionRows = sourceSections(source)
      .map(section => ({
        sentence: sourceTextSurface(`==${section.heading}== ${section.body}`, 3600),
        index: section.index,
        score: sourceHeadingOverlap(section.heading, requestUnits, sourceTitleUnitSet(span))
      }))
      .filter(row => row.score > 0 && row.sentence.length >= 24)
      .sort((a, b) => b.score - a.score || a.index - b.index)
      .slice(0, 4);
    const byIndex = new Map<number, { sentence: string; index: number; score: number }>();
    for (const row of [...leadRows, ...ranked, ...dateRows, ...sectionRows]) byIndex.set(row.index, row);
    const selectedRows = [...byIndex.values()]
      .sort((a, b) => a.index - b.index);
    const selected = (selectedRows.length ? selectedRows : sentences.slice(0, 8).map((sentence, index) => ({ sentence, index, score: 0 })))
      .map(row => row.sentence)
      .join(" ")
      .slice(0, 6000)
      .trim();
    return selected ? { ...span, text: selected, textPreview: selected } : span;
  });
}

function sessionContextEvidenceEnabled(metadata: JsonValue | undefined): boolean {
  const record = jsonRecord(metadata);
  const runtime = jsonRecord(record.runtime);
  return record.sessionContextEvidence === true || runtime.sessionContextEvidence === true;
}

function localEvidenceAnswerSurface(input: {
  requestText: string;
  selectedEvidence: readonly EvidenceSpan[];
  entailment: TurnResult["entailment"];
  semanticProof: { verdict: string; contradiction: number };
  translationTarget?: string;
  sessionContextEvidence?: boolean;
}): LocalEvidenceAnswerCandidate | undefined {
  if (input.translationTarget) return undefined;
  const plan = localEvidenceAnswerPlan(input);
  if (!plan) return undefined;
  return {
    answer: "",
    evidence: plan.evidence,
    audit: toJsonValue({
      ...jsonRecord(plan.audit),
      answerPlanId: plan.planId,
      answerKindId: plan.kindId,
      slotIds: Object.keys(plan.slotSurfaces),
      mouthRealizationRequired: true,
      fakeEvidenceForbidden: true
    }),
    plan
  };
}

function localEvidenceAnswerPlan(input: {
  requestText: string;
  selectedEvidence: readonly EvidenceSpan[];
  entailment: TurnResult["entailment"];
  semanticProof: { verdict: string; contradiction: number };
  sessionContextEvidence?: boolean;
}): LocalEvidenceAnswerPlan | undefined {
  const evidence = input.selectedEvidence.filter(span => span.status === "promoted" || promotedSessionEvidence(span));
  if (!evidence.length) return undefined;
  const counterexample = temporalCounterexampleAnswerPlan(input.requestText, evidence);
  if (counterexample) return counterexample;
  if (temporalCounterexampleExpected(input.requestText, evidence)) return undefined;
  const collection = collectionAnswerPlan(input.requestText, evidence, input.entailment, input.semanticProof);
  if (collection) return collection;
  const anchored = sourceAnchoredEvidenceForRequest(input.requestText, evidence);
  const sessionBound = evidence.some(promotedSessionEvidence) || input.sessionContextEvidence === true;
  if (anchored.required && !anchored.evidence.length && !sessionBound) return undefined;
  const answerEvidence = anchored.evidence.length ? anchored.evidence : sourceCoherentUnanchoredEvidence(input.requestText, evidence);
  if (!answerEvidence.length) return undefined;
  const contradiction = Math.max(input.entailment.contradiction, input.semanticProof.contradiction);
  if (contradiction >= 0.72 || (contradiction >= 0.45 && !anchored.evidence.length)) return undefined;
  const sentences = bestEvidenceSentences(input.requestText, answerEvidence, input.sessionContextEvidence === true);
  if (!sentences.length) return undefined;
  const relevance = localEvidenceAnswerScore(input.requestText, answerEvidence);
  const evidenceBound = input.entailment.evidenceIds.length > 0;
  const answerSessionBound = answerEvidence.some(promotedSessionEvidence) || input.sessionContextEvidence === true;
  if (!evidenceBound && !answerSessionBound && relevance < 0.035) return undefined;
  return {
    planId: "ans.plan.31a6c2f8",
    kindId: LOCAL_ANSWER_KIND_IDS.evidenceBoundary,
    evidence: answerEvidence,
    slotSurfaces: {
      [LOCAL_ANSWER_SLOT_IDS.sentence]: sentences
    },
    maxSentences: evidenceAnswerSentenceLimit(input.requestText, answerEvidence, input.sessionContextEvidence === true),
    audit: toJsonValue({
      source: "kernel.turn.fast_local_evidence",
      basisClassId: "basis.54d2a9be",
      certificationId: evidenceBound ? "cert.2b4f8a11" : "cert.4e8b2d11",
      evidenceIds: answerEvidence.map(span => String(span.id)),
      evidenceCount: answerEvidence.length,
      sourceAnchorRequired: anchored.required,
      sourceAnchorMatched: anchored.evidence.length > 0,
      sourceAnchors: anchored.anchors,
      evidenceBound,
      sessionBound: answerSessionBound,
      relevance,
      contradiction,
      entailmentForce: input.entailment.force,
      certificationVerifierVerdict: input.semanticProof.verdict,
      selectedSentenceCount: sentences.length,
      fakeEvidenceForbidden: true
    })
  };
}

function sourceCoherentUnanchoredEvidence(requestText: string, evidence: readonly EvidenceSpan[]): EvidenceSpan[] {
  const contentUnits = requestContentEvidenceUnits(requestText);
  if (!contentUnits.length) return [];
  const compatible = evidence.filter(span => evidenceRequestContentOverlap(span, contentUnits) > 0);
  if (!compatible.length) return [];
  const groups = new Map<string, EvidenceSpan[]>();
  for (const span of compatible) {
    const sourceVersionId = String(span.sourceVersionId);
    groups.set(sourceVersionId, [...(groups.get(sourceVersionId) ?? []), span]);
  }
  if (groups.size <= 1) return compatible;
  const ranked = [...groups.entries()]
    .map(([sourceVersionId, spans]) => ({
      sourceVersionId,
      spans,
      score: localEvidenceAnswerScore(requestText, spans)
        + Math.max(...spans.map(span => evidenceRequestContentOverlap(span, contentUnits))) * 0.08
        + Math.min(0.12, spans.length * 0.02)
    }))
    .sort((left, right) => right.score - left.score || right.spans.length - left.spans.length || left.sourceVersionId.localeCompare(right.sourceVersionId));
  return ranked[0]?.spans ?? [];
}

function requestContentEvidenceUnits(requestText: string): string[] {
  return uniqueKernelStrings(requestContentAnchorUnits(requestText)
    .filter(unit => [...unit].length >= 4 || hasUncasedNonLatinLetter(unit)));
}

function evidenceRequestContentOverlap(span: EvidenceSpan, contentUnits: readonly string[]): number {
  if (!contentUnits.length) return 0;
  const units = new Set(contentUnits);
  return Math.max(
    requestUnitOverlapForSurface(sourceTextSurface(span.text || span.textPreview, 12000), units),
    requestUnitOverlapForSurface(evidenceSourceAnchorSurface(span), units),
    requestUnitOverlapForSurface(evidenceTitle(span), units)
  );
}

function preferredLocalEvidenceAnswer(
  primary: LocalEvidenceAnswerCandidate | undefined,
  alternate: LocalEvidenceAnswerCandidate | undefined
): LocalEvidenceAnswerCandidate | undefined {
  if (!primary) return alternate;
  if (!alternate) return primary;
  return localEvidenceAnswerPriority(alternate.plan) > localEvidenceAnswerPriority(primary.plan) ? alternate : primary;
}

function localEvidenceAnswerPriority(plan: LocalEvidenceAnswerPlan): number {
  if (plan.kindId === LOCAL_ANSWER_KIND_IDS.temporalCounterexample) return 3;
  if (plan.kindId === LOCAL_ANSWER_KIND_IDS.collection) return 2;
  return 1;
}

function stringArrayFromSlot(value: string | string[] | undefined): string[] {
  if (Array.isArray(value)) return value.map(item => sourceTextSurface(String(item), 1200)).filter(Boolean);
  return typeof value === "string" && value ? [value] : [];
}

function collectionAnswerPlan(
  requestText: string,
  evidence: readonly EvidenceSpan[],
  entailment: TurnResult["entailment"],
  semanticProof: { verdict: string; contradiction: number }
): LocalEvidenceAnswerPlan | undefined {
  const contradiction = Math.max(entailment.contradiction, semanticProof.contradiction);
  const anchored = sourceAnchoredEvidenceForRequest(requestText, evidence);
  const anchors = sourceEvidenceAnchorsForRequest(requestText);
  const titleMatched = evidence.filter(span => evidenceExactSourceAnchorMatches(span, anchors) || evidenceTitleDistinctAnchorMatches(span, anchors));
  const candidateEvidence = titleMatched.length ? titleMatched : anchored.evidence.length ? anchored.evidence : evidence;
  const namedAnchors = namedSubjectAnchors(requestText).filter(sourceAnchorSpecificEnough);
  if (namedAnchors.length && !candidateEvidence.some(span => evidenceExactSourceAnchorMatches(span, namedAnchors) || evidenceTitleDistinctAnchorMatches(span, namedAnchors))) return undefined;
  if (candidateEvidence.some(span => anchoredBiographicalSubject(span, anchors))) return undefined;
  const requestUnits = requestUnitSet(requestText);
  const requestFeatures = featureSet(requestText, 256);
  const sourceSectionRows = sourceDerivedCollectionRows(candidateEvidence, requestText, requestUnits, requestFeatures);
  const rows = [
    ...sourceSectionRows,
    ...candidateEvidence
    .filter(span => span.status === "promoted" || promotedSessionEvidence(span))
    .flatMap(span => fastAnswerSentences(sourceTextSurface(span.text || span.textPreview, 24000)).slice(0, 80).map((sentence, index) => {
      const names = collectionNamesFromSurface(sentence, requestText, span);
      const unitOverlap = requestUnitOverlapForSurface(sentence, requestUnits);
      const lexical = weightedJaccard(requestFeatures, featureSet(sentence, 128));
      const delimiterMass = collectionListMass(sentence);
      const sectionAffinity = sourceDerivedSectionOverlap(sentence, requestUnits, sourceTitleUnitSet(span));
      return {
        span,
        sentence,
        names,
        sectionAffinity,
        delimiterMass,
        score: names.length * 0.18 + unitOverlap * 0.08 + lexical * 0.32 + delimiterMass * 0.18 + sectionAffinity * 0.5 + Math.max(0, 0.08 - index * 0.004)
      };
    }))
  ]
    .filter(row => row.names.length >= 2)
    .sort((left, right) => right.score - left.score || right.names.length - left.names.length);
  const sourceLabelRows = rows.filter(row => row.sectionAffinity > 0 && row.names.length >= 2);
  const listRichRows = rows.filter(row => row.names.length >= 4 && row.delimiterMass >= 0.28);
  if (!sourceLabelRows.length) return undefined;
  if (contradiction >= 0.72 && !sourceLabelRows.length) return undefined;
  const answerRows = (sourceLabelRows.length ? sourceLabelRows : listRichRows.length ? listRichRows : rows)
    .sort((left, right) => right.sectionAffinity - left.sectionAffinity || right.names.length - left.names.length || right.score - left.score);
  const selectedNames: string[] = [];
  const selectedEvidence: EvidenceSpan[] = [];
  for (const row of answerRows.slice(0, 8)) {
    selectedEvidence.push(row.span);
    for (const name of row.names) {
      if (selectedNames.some(existing => sameCollectionName(existing, name))) continue;
      selectedNames.push(name);
      if (selectedNames.length >= 12) break;
    }
    if (selectedNames.length >= 12) break;
  }
  if (selectedNames.length < 2) return undefined;
  const selectedEvidenceUnique = uniqueEvidenceById(selectedEvidence);
  return {
    planId: "ans.plan.6d1f7c0a",
    kindId: LOCAL_ANSWER_KIND_IDS.collection,
    evidence: selectedEvidenceUnique,
    slotSurfaces: {
      [LOCAL_ANSWER_SLOT_IDS.memberList]: selectedNames
    },
    maxSentences: 1,
    audit: toJsonValue({
      source: "kernel.turn.collection_answer",
      basisClassId: "basis.54d2a9be",
      certificationId: "cert.2b4f8a11",
      evidenceIds: selectedEvidenceUnique.map(span => String(span.id)),
      evidenceCount: selectedEvidenceUnique.length,
      sourceDerivedRows: sourceLabelRows.length,
      listRichRows: listRichRows.length,
      answerObjectId: "ans.obj.6d1f7c0a",
      actionId: "act.3be50f92",
      supportStatusId: "support.7d7a2cf1",
      fakeEvidenceForbidden: true
    })
  };
}

interface CollectionAnswerRow {
  span: EvidenceSpan;
  sentence: string;
  names: string[];
  sectionAffinity: number;
  delimiterMass: number;
  score: number;
}

function sourceDerivedCollectionRows(
  evidence: readonly EvidenceSpan[],
  requestText: string,
  requestUnits: ReadonlySet<string>,
  requestFeatures: readonly string[]
): CollectionAnswerRow[] {
  const out: CollectionAnswerRow[] = [];
  for (const span of evidence.filter(item => item.status === "promoted" || promotedSessionEvidence(item))) {
    const source = sourceTextSurface(span.text || span.textPreview, 24000);
    const excludedHeadingUnits = sourceTitleUnitSet(span);
    for (const section of sourceSections(source)) {
      const sectionAffinity = sourceHeadingOverlap(section.heading, requestUnits, excludedHeadingUnits);
      if (sectionAffinity <= 0) continue;
      const names = collectionNamesFromSurface(section.body, requestText, span);
      if (names.length < 2) continue;
      const surface = `${section.heading} ${names.join(", ")}`;
      const lexical = weightedJaccard(requestFeatures, featureSet(surface, 128));
      out.push({
        span,
        sentence: surface,
        names,
        sectionAffinity,
        delimiterMass: collectionListMass(section.body),
        score: 0.72 + sectionAffinity * 0.8 + names.length * 0.12 + lexical * 0.28
      });
    }
  }
  return out.sort((left, right) => right.score - left.score || right.names.length - left.names.length);
}

function sourceSections(source: string): Array<{ heading: string; body: string; index: number }> {
  const matches = [...source.matchAll(/==([^=\r\n]{1,120})==/gu)];
  const sections: Array<{ heading: string; body: string; index: number }> = [];
  for (let index = 0; index < matches.length; index++) {
    const match = matches[index];
    if (!match || match.index === undefined) continue;
    const next = matches[index + 1];
    const start = match.index + match[0].length;
    const end = next?.index ?? source.length;
    const heading = sourceTextSurface(match[1] ?? "", 160);
    const body = sourceTextSurface(source.slice(start, end), 6000);
    if (heading && body) sections.push({ heading, body, index: match.index });
  }
  return sections;
}

function collectionNamesFromSurface(sentence: string, requestText: string, span: EvidenceSpan): string[] {
  const sourceTitle = normalizePriorKey(evidenceTitle(span));
  const requestAnchors = new Set(sourceEvidenceAnchorsForRequest(requestText));
  const requestUnits = requestUnitSet(requestText);
  const headNames = collectionListHeadNames(sentence);
  const rawNames = headNames.length ? headNames : surfaceEntityRuns(sentence);
  const out: string[] = [];
  for (const raw of rawNames) {
    const clean = raw.replace(/^[\s"'`]+|[\s"'`,;:.]+$/gu, "").replace(/\s+/gu, " ").trim();
    if (!clean) continue;
    const key = normalizePriorKey(clean);
    if (!key) continue;
    const nameUnits = splitPriorUnits(key).filter(unit => unit.length >= 4);
    if (nameUnits.length && nameUnits.every(unit => [...requestUnits].some(requestUnit => requestUnitMatchesSurface(unit, requestUnit)))) continue;
    if (sourceTitle && (key === sourceTitle || sourceTitle.includes(key) || key.includes(sourceTitle))) continue;
    if ([...requestAnchors].some(anchor => anchor === key || anchor.includes(key) || key.includes(anchor))) continue;
    if (collectionNameLooksInstitutional(clean)) continue;
    out.push(clean);
  }
  return uniqueKernelStrings(out).slice(0, 16);
}

function collectionListHeadNames(surface: string): string[] {
  const out: string[] = [];
  for (const segment of surface.split(/(?:^|\s)[*\u2022]\s+/u).slice(1)) {
    const head = segment
      .split(/\s[-\u2013\u2014:]\s/u)[0]
      ?.replace(/\([^)]{0,160}\)/gu, " ")
      .replace(/==[^=]{1,120}==/gu, " ")
      .trim() ?? "";
    if (!head) continue;
    const direct = sourceBulletHeadName(head);
    if (direct) {
      out.push(direct);
      continue;
    }
    const [name] = surfaceEntityRuns(head);
    if (name) out.push(name);
  }
  return uniqueKernelStrings(out).slice(0, 24);
}

function sourceBulletHeadName(surface: string): string {
  const clean = cleanSourceAnswerSurface(surface)
    .replace(/\([^)]{0,160}\)/gu, " ")
    .replace(/["'`]+/gu, " ")
    .replace(/\s+/gu, " ")
    .replace(/^[\s,;:.]+|[\s,;:.]+$/gu, "")
    .trim();
  if (!clean || clean.length > 90) return "";
  const units = splitPriorUnits(normalizePriorKey(clean)).filter(Boolean);
  if (!units.length || units.length > 7) return "";
  if (!units.some(unit => [...unit].some(char => char.toLocaleLowerCase() !== char.toLocaleUpperCase()))) return "";
  return clean;
}

function collectionListMass(surface: string): number {
  const markers = surface.match(/[,;*\u2022]|\s[-\u2013\u2014:]\s/gu) ?? [];
  return Math.min(1, markers.length / 8);
}

function sourceDerivedSectionOverlap(surface: string, requestUnits: ReadonlySet<string>, excludedUnits: ReadonlySet<string> = new Set()): number {
  if (!requestUnits.size) return 0;
  let overlap = 0;
  for (const match of surface.matchAll(/==([^=]{1,120})==/gu)) {
    overlap += sourceHeadingOverlap(match[1] ?? "", requestUnits, excludedUnits);
  }
  return Math.min(1, overlap);
}

function sourceHeadingOverlap(heading: string, requestUnits: ReadonlySet<string>, excludedUnits: ReadonlySet<string> = new Set()): number {
  if (!requestUnits.size) return 0;
  const units = splitPriorUnits(normalizePriorKey(heading))
    .filter(unit => unit.length >= 4 && ![...excludedUnits].some(excluded => requestUnitMatchesSurface(excluded, unit)));
  let overlap = 0;
  for (const unit of units) {
    if ([...requestUnits].some(requestUnit => requestUnitMatchesSurface(requestUnit, unit))) overlap++;
  }
  return Math.min(1, overlap / Math.max(1, units.length));
}

function sourceTitleUnitSet(span: EvidenceSpan): Set<string> {
  return new Set(splitPriorUnits(normalizePriorKey(evidenceTitle(span))).filter(unit => unit.length >= 4));
}

function collectionNameLooksInstitutional(name: string): boolean {
  const units = splitPriorUnits(normalizePriorKey(name));
  return units.length > 5;
}

function sameCollectionName(left: string, right: string): boolean {
  const a = normalizePriorKey(left);
  const b = normalizePriorKey(right);
  if (!a || !b) return false;
  return a === b || a.includes(b) || b.includes(a);
}

function assistantForceFromLocalEvidenceAudit(audit: JsonValue, defaultForce: NonNullable<TurnResult["assistantForce"]>): NonNullable<TurnResult["assistantForce"]> {
  const record = jsonRecord(audit);
  const basisClassId = kernelString(record.basisClassId);
  const evidenceCount = kernelNumber(record.evidenceCount);
  const evidenceBound = record.evidenceBound === true;
  const sourceAnchorMatched = record.sourceAnchorMatched !== false;
  if (basisClassId === "basis.9f1b2c7a") return "reasoned_answer";
  if (evidenceBound && evidenceCount > 0 && sourceAnchorMatched) return "source_grounded_answer";
  return defaultForce;
}

function clampUnit(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(1, value));
}

function temporalCounterexampleAnswerPlan(requestText: string, evidence: readonly EvidenceSpan[]): LocalEvidenceAnswerPlan | undefined {
  const anchors = sourceEvidenceAnchorsForRequest(requestText);
  if (!anchors.length) return undefined;
  const requestUnits = requestUnitSet(requestText);
  const orderedRequestUnits = requestUnitsFromText(requestText);
  const subject = evidence
    .map(span => ({ span, title: evidenceTitle(span), key: normalizePriorKey(evidenceTitle(span)) }))
    .map(row => ({ ...row, lifespan: lifespanYears(row.span) }))
    .map(row => ({
      ...row,
      anchorFit: row.title && row.lifespan && anchors.some(anchor => temporalSubjectAnchorMatches(row.key, anchor)) ? 1 : 0,
      requestOverlap: evidenceRequestUnitOverlap(row.span, requestUnits)
    }))
    .filter(row => row.title && row.lifespan && (row.anchorFit > 0 || row.requestOverlap >= 2))
    .sort((left, right) => right.anchorFit - left.anchorFit || right.requestOverlap - left.requestOverlap || left.title.localeCompare(right.title))[0];
  if (!subject) return undefined;
  const lifespan = subject.lifespan;
  if (!lifespan) return undefined;
  const conceptUnits = temporalCounterexampleConceptUnits(requestText, subject.title);
  if (!conceptUnits.size) return undefined;
  const orderedConceptUnits = requestUnitsFromText(firstStringSlot(requestDerivedPolaritySlots(requestText, subject.title)?.[LOCAL_ANSWER_SLOT_IDS.requestPredicate])).filter(unit => conceptUnits.has(unit));
  const counter = evidence
    .filter(span => String(span.id) !== String(subject.span.id))
    .map(span => {
      const marker = earliestHistoricalMarker(span);
      const sourceSurface = sourceTextSurface(span.text || span.textPreview, 24000);
      const markerSentence = marker ? sentenceContaining(sourceSurface, marker.surface) : "";
      const overlap = Math.max(
        evidenceRequestUnitOverlap(span, requestUnits),
        requestUnitOverlapForSurface(sourceSurface, requestUnits)
      );
      const conceptOverlap = Math.max(
        requestUnitOverlapForSurface(evidenceTitle(span), conceptUnits),
        requestUnitOverlapForSurface(sourceSurface, conceptUnits)
      );
      const pairOverlap = evidenceRequestAdjacentUnitPairOverlap(span, orderedRequestUnits);
      const conceptPairOverlap = surfaceRequestAdjacentUnitPairOverlap(`${evidenceTitle(span)} ${sourceSurface}`, orderedConceptUnits);
      const markerConceptOverlap = requestUnitOverlapForSurface(markerSentence, conceptUnits);
      const titlePosition = evidenceTitleRequestPosition(span, orderedRequestUnits);
      return marker && overlap > 0 ? { span, marker, markerSentence, overlap, conceptOverlap, markerConceptOverlap, pairOverlap, conceptPairOverlap, titlePosition } : undefined;
    })
    .filter((row): row is { span: EvidenceSpan; marker: HistoricalMarker; markerSentence: string; overlap: number; conceptOverlap: number; markerConceptOverlap: number; pairOverlap: number; conceptPairOverlap: number; titlePosition: number } => Boolean(row))
    .filter(row => row.conceptOverlap >= 2 || row.conceptPairOverlap >= 1)
    .filter(row => row.markerConceptOverlap >= 1 || row.conceptPairOverlap >= 2)
    .filter(row => (row.overlap >= 2 || row.titlePosition < Number.POSITIVE_INFINITY || row.conceptOverlap >= 2) && (row.pairOverlap >= 1 || row.conceptPairOverlap >= 1 || row.marker.absoluteYear < lifespan.birthYear) && !containedTitlePair(subject.title, evidenceTitle(row.span)))
    .filter(row => row.marker.absoluteYear < lifespan.birthYear)
    .sort((left, right) => {
      const leftPosition = Number.isFinite(left.titlePosition) ? left.titlePosition : 9999;
      const rightPosition = Number.isFinite(right.titlePosition) ? right.titlePosition : 9999;
      return right.conceptPairOverlap - left.conceptPairOverlap || right.conceptOverlap - left.conceptOverlap || leftPosition - rightPosition || right.overlap - left.overlap || right.pairOverlap - left.pairOverlap || left.marker.absoluteYear - right.marker.absoluteYear;
    })[0];
  if (!counter) return undefined;
  const counterSentence = boundedLocalQuoteSurface(cleanSourceAnswerSurface(
    sentenceContaining(sourceTextSurface(counter.span.text || counter.span.textPreview, 24000), counter.marker.surface)
    || firstUsefulSentence(counter.span)
  ), 260);
  const conceptSentence = boundedLocalQuoteSurface(cleanSourceAnswerSurface(bestRequestSentence(counter.span, conceptUnits) || firstUsefulSentence(counter.span)), 220);
  const polaritySlots = requestDerivedPolaritySlots(requestText, subject.title);
  if (!polaritySlots) return undefined;
  const answerEvidence = uniqueEvidenceById([counter.span, subject.span]);
  return {
    planId: "ans.plan.7f1c2a90",
    kindId: LOCAL_ANSWER_KIND_IDS.temporalCounterexample,
    evidence: answerEvidence,
    slotSurfaces: {
      ...polaritySlots,
      [LOCAL_ANSWER_SLOT_IDS.conceptEvidence]: conceptSentence,
      [LOCAL_ANSWER_SLOT_IDS.counterexampleEvidence]: counterSentence
    },
    maxSentences: 3,
    audit: toJsonValue({
      source: "turn.basis.7f1c2a90",
      basisClassId: "basis.9f1b2c7a",
      certificationId: "cert.4e8b2d11",
      polarityId: "pol.2a4e8c19",
      subject: subject.title,
      subjectEvidenceId: String(subject.span.id),
      counterexampleEvidenceId: String(counter.span.id),
      counterexampleDate: counter.marker.surface,
      counterexampleYear: counter.marker.absoluteYear,
      conceptOverlap: counter.conceptOverlap,
      conceptPairOverlap: counter.conceptPairOverlap,
      birthYear: lifespan.birthYear,
      deathYear: lifespan.deathYear,
      answerObjectId: "ans.obj.7f1c2a90",
      actionId: "act.7f1c2a90",
      supportStatusId: "support.0d7419ce"
    })
  };
}

function temporalCounterexampleExpected(requestText: string, evidence: readonly EvidenceSpan[]): boolean {
  const anchors = sourceEvidenceAnchorsForRequest(requestText);
  if (!anchors.length) return false;
  const requestUnits = requestUnitSet(requestText);
  const subject = evidence
    .map(span => ({ span, title: evidenceTitle(span), key: normalizePriorKey(evidenceTitle(span)), lifespan: lifespanYears(span) }))
    .map(row => ({
      ...row,
      anchorFit: row.title && row.lifespan && anchors.some(anchor => temporalSubjectAnchorMatches(row.key, anchor)) ? 1 : 0,
      requestOverlap: evidenceRequestUnitOverlap(row.span, requestUnits)
    }))
    .filter(row => row.title && row.lifespan && (row.anchorFit > 0 || row.requestOverlap >= 2))
    .sort((left, right) => right.anchorFit - left.anchorFit || right.requestOverlap - left.requestOverlap || left.title.localeCompare(right.title))[0];
  if (!subject || !requestDerivedPolaritySlots(requestText, subject.title)) return false;
  return temporalCounterexampleConceptUnits(requestText, subject.title).size > 0;
}

function temporalCounterexampleConceptUnits(requestText: string, subjectTitle: string): Set<string> {
  const subjectUnits = new Set(requestUnitsFromText(subjectTitle));
  const polaritySlots = requestDerivedPolaritySlots(requestText, subjectTitle);
  const predicateSurface = firstStringSlot(polaritySlots?.[LOCAL_ANSWER_SLOT_IDS.requestPredicate]);
  const units = requestUnitsFromText(predicateSurface || requestText)
    .filter(unit => !subjectUnits.has(unit))
    .filter(unit => ![...subjectUnits].some(subjectUnit => requestUnitMatchesSurface(unit, subjectUnit)));
  return new Set(units);
}

function temporalSubjectAnchorMatches(titleKey: string, anchor: string): boolean {
  if (!titleKey || !anchor) return false;
  const titleUnits = splitPriorUnits(titleKey).filter(unit => unit.length >= 4);
  if (titleUnits.length >= 2) return titleKey === anchor || titleKey.includes(anchor) || anchor.includes(titleKey);
  return titleKey === anchor;
}

function anchoredBiographicalSubject(span: EvidenceSpan, anchors: readonly string[]): boolean {
  const lifespan = lifespanYears(span);
  if (!lifespan) return false;
  const duration = lifespan.deathYear - lifespan.birthYear;
  if (duration < 10 || duration > 130) return false;
  const titleKey = normalizePriorKey(evidenceTitle(span));
  return anchors.some(anchor => temporalSubjectAnchorMatches(titleKey, anchor));
}

function requestDerivedPolaritySlots(requestText: string, subjectTitle: string): Record<string, string> | undefined {
  const cleanRequest = cleanSourceAnswerSurface(requestText).replace(/[?!.]+$/u, "").trim();
  const cleanSubject = cleanSourceAnswerSurface(subjectTitle).replace(/[?!.]+$/u, "").trim();
  if (!cleanRequest || !cleanSubject) return undefined;
  const subjectIndex = surfaceIndexOf(cleanRequest, cleanSubject);
  if (subjectIndex < 0) return undefined;
  const beforeSubject = cleanRequest.slice(0, subjectIndex).trim();
  const afterSubject = stripLeadingShortBridgeUnits(cleanRequest.slice(subjectIndex + cleanSubject.length).replace(/^[\s,;:]+/u, "").trim());
  const requestHead = surfaceWords(beforeSubject)[0] ?? "";
  if (!requestHead || !afterSubject) return undefined;
  return {
    [LOCAL_ANSWER_SLOT_IDS.subject]: cleanSubject,
    [LOCAL_ANSWER_SLOT_IDS.requestHead]: requestHead,
    [LOCAL_ANSWER_SLOT_IDS.requestPredicate]: afterSubject
  };
}

function stripLeadingShortBridgeUnits(surface: string): string {
  const clean = cleanSourceAnswerSurface(surface);
  if (!clean) return "";
  const words = localSurfaceWordSpans(clean);
  const contentIndex = words.findIndex(word => [...word.key].length >= 4 || hasUncasedNonLatinLetter(word.key));
  if (contentIndex <= 0 || contentIndex > 4) return clean;
  return clean.slice(words[contentIndex]?.start ?? 0).trim();
}

function firstStringSlot(value: string | string[] | undefined): string {
  return stringArrayFromSlot(value)[0] ?? "";
}

function surfaceIndexOf(surface: string, needle: string): number {
  const lowerSurface = surface.toLocaleLowerCase();
  const lowerNeedle = needle.toLocaleLowerCase();
  return lowerSurface.indexOf(lowerNeedle);
}

interface HistoricalMarker {
  surface: string;
  absoluteYear: number;
}

function lifespanYears(span: EvidenceSpan): { birthYear: number; deathYear: number } | undefined {
  const years = [...sourceTextSurface(span.text || span.textPreview, 900).matchAll(/\b(1[0-9]{3}|20[0-9]{2})\b/gu)]
    .map(match => Number(match[1]))
    .filter(year => Number.isSafeInteger(year));
  if (years.length < 2) return undefined;
  const birthYear = years[0] ?? 0;
  const deathYear = years[1] ?? 0;
  if (birthYear <= 0 || deathYear <= 0 || birthYear >= deathYear) return undefined;
  return { birthYear, deathYear };
}

function earliestHistoricalMarker(span: EvidenceSpan): HistoricalMarker | undefined {
  const text = sourceTextSurface(span.text || span.textPreview, 24000);
  const markers: HistoricalMarker[] = [];
  for (const match of text.matchAll(/\b([1-9][0-9]?)(?:st|nd|rd|th)\s+century\s+(?:BC|BCE)\b/giu)) {
    const century = Number(match[1]);
    if (Number.isSafeInteger(century)) markers.push({ surface: match[0], absoluteYear: -((century - 1) * 100 + 1) });
  }
  for (const match of text.matchAll(/\b(1[0-9]{3}|[7-9][0-9]{2}|20[0-9]{2})\b/gu)) {
    const year = Number(match[1]);
    if (Number.isSafeInteger(year) && historicalYearContextAllowed(text, match.index ?? 0, match[0].length)) markers.push({ surface: match[0], absoluteYear: year });
  }
  return markers.sort((left, right) => left.absoluteYear - right.absoluteYear)[0];
}

function historicalYearContextAllowed(text: string, index: number, length: number): boolean {
  const before = text.slice(Math.max(0, index - 12), index);
  const after = text.slice(index + length, Math.min(text.length, index + length + 12));
  if (/[-‐‑‒–—]\s*(?:[IVXLCDM]+|\d+(?:\.\d+)?)/iu.test(after)) return false;
  if (/[$€£¥₩₹₽¢]/u.test(before) || /[$€£¥₩₹₽¢]/u.test(after)) return false;
  if (/^\s+\p{Ll}{1,4}\b/u.test(after)) return false;
  if (/^\s*(?:kb|mb|gb|kg|cm|mm|m|km|ha|iv|v|vi|vii|viii|ix|x)\b/iu.test(after)) return false;
  return true;
}

function evidenceRequestUnitOverlap(span: EvidenceSpan, requestUnits: ReadonlySet<string>): number {
  if (!requestUnits.size) return 0;
  const surfaceUnits = splitPriorUnits(normalizePriorKey(`${evidenceTitle(span)} ${sourceTextSurface(span.textPreview || span.text || "", 1400)}`)).filter(unit => unit.length >= 4);
  let overlap = 0;
  for (const unit of requestUnits) {
    if (surfaceUnits.some(surfaceUnit => requestUnitMatchesSurface(unit, surfaceUnit))) overlap++;
  }
  return overlap;
}

function requestUnitSet(text: string): Set<string> {
  return new Set(requestUnitsFromText(text));
}

function definitionRequestAnchor(text: string): string | undefined {
  const units = requestUnitsFromText(text)
    .filter(unit => !definitionQuestionUnit(unit));
  if (units.length !== 1) return undefined;
  const anchor = units[0] ?? "";
  return anchor.length >= 4 ? anchor : undefined;
}

function definitionQuestionUnit(unit: string): boolean {
  return unit === "what" || unit === "who" || unit === "which" || unit === "define" || unit === "definition";
}

function definitionSentenceMatches(sentence: string, anchor: string): boolean {
  const units = splitPriorUnits(normalizePriorKey(sentence)).filter(Boolean);
  const anchorIndex = units.findIndex(unit => requestUnitMatchesSurface(anchor, unit));
  if (anchorIndex < 0 || anchorIndex > 4) return false;
  const window = units.slice(anchorIndex + 1, anchorIndex + 7);
  return window.some(unit => unit === "is" || unit === "are" || unit === "was" || unit === "were" || unit === "refers" || unit === "means");
}

function requestUnitsFromText(text: string): string[] {
  const out = new Set<string>();
  for (const raw of splitPriorUnits(normalizePriorKey(text.replace(/[?!.]+$/u, "")))) {
    const unit = raw.replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, "");
    if (unit.length < 4) continue;
    out.add(unit);
  }
  return [...out];
}

function evidenceRequestAdjacentUnitPairOverlap(span: EvidenceSpan, requestUnits: readonly string[]): number {
  if (requestUnits.length < 2) return 0;
  const surfaceUnits = splitPriorUnits(normalizePriorKey(`${evidenceTitle(span)} ${sourceTextSurface(span.textPreview || span.text || "", 1800)}`)).filter(unit => unit.length >= 4);
  let overlap = 0;
  for (let index = 0; index < requestUnits.length - 1; index++) {
    const left = requestUnits[index] ?? "";
    const right = requestUnits[index + 1] ?? "";
    if (!left || !right || left === right) continue;
    if (requestUnitAppearsInSurface(left, surfaceUnits) && requestUnitAppearsInSurface(right, surfaceUnits)) overlap++;
  }
  return overlap;
}

function evidenceTitleRequestPosition(span: EvidenceSpan, requestUnits: readonly string[]): number {
  const titleUnits = splitPriorUnits(normalizePriorKey(evidenceTitle(span))).filter(unit => unit.length >= 4);
  if (!titleUnits.length) return Number.POSITIVE_INFINITY;
  let best = Number.POSITIVE_INFINITY;
  for (let index = 0; index < requestUnits.length; index++) {
    const requestUnit = requestUnits[index] ?? "";
    if (titleUnits.some(titleUnit => requestUnitMatchesSurface(requestUnit, titleUnit))) best = Math.min(best, index);
  }
  return best;
}

function requestUnitAppearsInSurface(unit: string, surfaceUnits: readonly string[]): boolean {
  return surfaceUnits.some(surfaceUnit => requestUnitMatchesSurface(unit, surfaceUnit));
}

function requestUnitMatchesSurface(unit: string, surfaceUnit: string): boolean {
  if (!unit || !surfaceUnit) return false;
  if (unit === surfaceUnit) return true;
  const minLength = Math.min(unit.length, surfaceUnit.length);
  const maxLength = Math.max(unit.length, surfaceUnit.length);
  const prefixCompatible = (unit.startsWith(surfaceUnit) || surfaceUnit.startsWith(unit)) && minLength / Math.max(1, maxLength) >= 0.72;
  return prefixCompatible || requestUnitSimilarity(unit, surfaceUnit) >= 0.72;
}

function requestUnitSimilarity(left: string, right: string): number {
  if (!left || !right) return 0;
  if (left === right) return 1;
  const minLength = Math.min(left.length, right.length);
  const maxLength = Math.max(left.length, right.length);
  if (left.length >= 4 && right.length >= 4 && (left.includes(right) || right.includes(left)) && minLength / Math.max(1, maxLength) >= 0.72) return 0.82;
  const distance = boundedEditDistance(left, right, 3);
  if (distance > 3 || maxLength <= 0) return 0;
  return kernelClamp01(1 - distance / maxLength);
}

function bestRequestSentence(span: EvidenceSpan, requestUnits: ReadonlySet<string>): string {
  if (!requestUnits.size) return "";
  const sentences = fastAnswerSentences(sourceTextSurface(span.text || span.textPreview, 24000));
  return sentences
    .map(sentence => ({ sentence, score: requestUnitOverlapForSurface(sentence, requestUnits) }))
    .filter(row => row.score > 0 && row.sentence.length >= 24)
    .sort((left, right) => right.score - left.score || left.sentence.length - right.sentence.length)[0]?.sentence ?? "";
}

function requestUnitOverlapForSurface(surface: string, requestUnits: ReadonlySet<string>): number {
  const surfaceUnits = splitPriorUnits(normalizePriorKey(surface)).filter(unit => unit.length >= 4);
  let overlap = 0;
  for (const unit of requestUnits) {
    if (surfaceUnits.some(surfaceUnit => requestUnitMatchesSurface(unit, surfaceUnit))) overlap++;
  }
  return overlap;
}

function evidenceTitle(span: EvidenceSpan): string {
  const provenance = jsonRecord(span.provenance);
  const metadata = jsonRecord(provenance.metadata);
  return kernelString(provenance.title) ?? kernelString(metadata.title) ?? "";
}

function containedTitlePair(leftTitle: string, rightTitle: string): boolean {
  const left = normalizePriorKey(leftTitle);
  const right = normalizePriorKey(rightTitle);
  if (!left || !right || left === right) return false;
  return left.includes(right) || right.includes(left);
}

function firstUsefulSentence(span: EvidenceSpan): string {
  return fastAnswerSentences(sourceTextSurface(span.text || span.textPreview, 24000)).find(sentence => sentence.length >= 24) ?? "";
}

function sentenceContaining(text: string, needle: string): string {
  const lowerNeedle = needle.toLocaleLowerCase();
  return fastAnswerSentences(text).find(sentence => sentence.toLocaleLowerCase().includes(lowerNeedle)) ?? "";
}

function sourceAnchoredEvidenceForRequest(requestText: string, evidence: readonly EvidenceSpan[]): { required: boolean; anchors: string[]; evidence: EvidenceSpan[] } {
  const anchors = sourceEvidenceAnchorsForRequest(requestText);
  if (!anchors.length) return { required: false, anchors, evidence: [...evidence] };
  const durableEvidencePresent = evidence.some(span => !String(span.id).startsWith("evidence_session_"));
  if (!durableEvidencePresent) {
    const sessionEvidence = evidence.filter(promotedSessionEvidence);
    if (sessionEvidence.length) return { required: true, anchors, evidence: sessionEvidence };
  }
  const primaryAnchor = primarySourceAnchorForRequest(requestText);
  const primaryAnchorUnits = primaryAnchor ? splitPriorUnits(primaryAnchor).filter(Boolean) : [];
  const primaryEvidence = primaryAnchor
    ? primaryEvidenceForSourceAnchor(primaryAnchor, requestText, evidence)
    : [];
  if (primaryAnchor && !primaryEvidence.length) return { required: true, anchors: uniqueKernelStrings([primaryAnchor, ...anchors]), evidence: [] };
  const primaryExact = primaryAnchor
    ? evidence.filter(span => evidenceExactSourceAnchorMatches(span, [primaryAnchor]) && evidenceAnchorFitForRequest(span, requestText))
    : [];
  if (primaryAnchor && primaryExact.length && requestContentEvidenceUnits(requestText).length <= 3) {
    return { required: true, anchors: uniqueKernelStrings([primaryAnchor, ...anchors]), evidence: uniqueEvidenceById(primaryExact) };
  }
  if (primaryAnchor && primaryAnchorUnits.length === 1 && primaryEvidence.length) {
    return { required: true, anchors: uniqueKernelStrings([primaryAnchor, ...anchors]), evidence: uniqueEvidenceById(primaryEvidence) };
  }
  const exact = evidence.filter(span => (
    (evidenceExactSourceAnchorMatches(span, anchors) || evidenceTitleDistinctAnchorMatches(span, anchors)) &&
    evidenceAnchorFitForRequest(span, requestText)
  ));
  const selected = evidence.filter(span => (
    (evidenceSourceMatchesAnchors(span, anchors) || evidenceTitleDistinctAnchorMatches(span, anchors)) &&
    evidenceAnchorFitForRequest(span, requestText)
  ));
  return { required: true, anchors: uniqueKernelStrings([...(primaryAnchor ? [primaryAnchor] : []), ...anchors]), evidence: exact.length ? uniqueEvidenceById([...primaryEvidence, ...exact, ...selected]) : uniqueEvidenceById([...primaryEvidence, ...selected]) };
}

function primaryEvidenceForSourceAnchor(primaryAnchor: string, requestText: string, evidence: readonly EvidenceSpan[]): EvidenceSpan[] {
  const exact = evidence.filter(span =>
    evidenceExactSourceAnchorMatches(span, [primaryAnchor]) &&
    evidenceAnchorFitForRequest(span, requestText)
  );
  const primaryAnchorUnits = splitPriorUnits(primaryAnchor).filter(Boolean);
  if (primaryAnchorUnits.length === 1 && exact.length) return exact;
  return evidence.filter(span => {
    const titleMatched = evidenceExactSourceAnchorMatches(span, [primaryAnchor]) || evidenceTitleDistinctAnchorMatches(span, [primaryAnchor]);
    if (titleMatched && evidenceAnchorFitForRequest(span, requestText)) return true;
    return primaryAnchorUnits.length >= 2 && evidenceMatchesSourceAnchor(span, primaryAnchor);
  });
}

function evidenceAnchorFitForRequest(span: EvidenceSpan, requestText: string): boolean {
  const titleUnits = sourceTitleAnchorFitUnitSet(span);
  if (!titleUnits.size) return true;
  const requestUnits = requestAnchorFitUnits(requestText);
  if (!requestUnits.length) return true;
  const matchedTitleUnits = [...titleUnits].filter(titleUnit => requestUnits.some(unit => requestUnitMatchesSurface(unit, titleUnit)));
  const firstTitlePosition = firstTitleUnitPosition(requestUnits, titleUnits);
  const nonTitleUnits = requestUnits.filter(unit => ![...titleUnits].some(titleUnit => requestUnitMatchesSurface(unit, titleUnit)));
  const sourceSurface = sourceTextSurface(span.text || span.textPreview, 3200);
  const nonTitleOverlap = requestUnitOverlapForSurface(sourceSurface, new Set(nonTitleUnits));
  if (matchedTitleUnits.length >= 2 && firstTitlePosition <= 2) return true;
  const singleLateTitleOverlapFloor = titleUnits.size === 1 && firstTitlePosition > 2 ? 2 : 1;
  if (matchedTitleUnits.length >= 1 && nonTitleOverlap >= singleLateTitleOverlapFloor) return true;
  return titleUnits.size > 1 && firstTitlePosition <= 2 && matchedTitleUnits.length / Math.max(1, titleUnits.size) >= 0.67;
}

function sourceTitleAnchorFitUnitSet(span: EvidenceSpan): Set<string> {
  return new Set(splitPriorUnits(normalizePriorKey(evidenceTitle(span)))
    .map(unit => unit.replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, ""))
    .filter(unit => unit.length >= 3 && !genericQuestionSignal(unit)));
}

function requestAnchorFitUnits(text: string): string[] {
  return splitPriorUnits(normalizePriorKey(text.replace(/[?!.]+$/u, "")))
    .map(unit => unit.replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, ""))
    .filter(unit => unit.length >= 3 && !genericQuestionSignal(unit));
}

function firstTitleUnitPosition(requestUnits: readonly string[], titleUnits: ReadonlySet<string>): number {
  let best = Number.POSITIVE_INFINITY;
  for (let index = 0; index < requestUnits.length; index++) {
    const unit = requestUnits[index] ?? "";
    if ([...titleUnits].some(titleUnit => requestUnitMatchesSurface(unit, titleUnit))) best = Math.min(best, index);
  }
  return best;
}

function requestNeedsSourceAnchoredEvidence(requestText: string): boolean {
  return sourceEvidenceAnchorsForRequest(requestText).length > 0;
}

function uniqueEvidenceById(evidence: readonly EvidenceSpan[]): EvidenceSpan[] {
  const byId = new Map<string, EvidenceSpan>();
  for (const span of evidence) if (!byId.has(String(span.id))) byId.set(String(span.id), span);
  return [...byId.values()];
}

function graphFilteredToEvidence(graph: GraphSlice, evidence: readonly EvidenceSpan[]): GraphSlice {
  const ids = new Set(evidence.map(span => String(span.id)));
  if (!ids.size) return { ...graph, nodes: [], edges: [], hyperedges: [] };
  const nodeIds = new Set<string>();
  const nodes = graph.nodes.filter(node => {
    const matched = node.evidenceIds.some(id => ids.has(String(id)));
    if (matched) nodeIds.add(String(node.id));
    return matched;
  });
  const edges = graph.edges.filter(edge =>
    edge.evidenceIds.some(id => ids.has(String(id))) ||
    nodeIds.has(String(edge.source)) && nodeIds.has(String(edge.target))
  );
  const hyperedges = graph.hyperedges.filter(edge =>
    edge.provenanceRefs.some(id => ids.has(String(id))) ||
    edge.memberNodeIds.some(id => nodeIds.has(String(id)))
  );
  return { ...graph, nodes, edges, hyperedges };
}

function sourceEvidenceAnchorsForRequest(requestText: string): string[] {
  const named = namedSubjectAnchors(requestText)
    .sort((left, right) => splitPriorUnits(right).length - splitPriorUnits(left).length || right.length - left.length);
  const derived = derivedSourceAnchorPhrases(requestText);
  if (named.length) return uniqueKernelStrings([...named, ...derived]).slice(0, 24);
  const casedSingle = casedSingleSourceAnchors(requestText);
  if (casedSingle.length) return uniqueKernelStrings([...casedSingle, ...derived]).slice(0, 24);
  const singleTopic = singleTopicSourceAnchors(requestText);
  if (singleTopic.length) return singleTopic;
  const anchors = [...derived]
    .filter(sourceAnchorSpecificEnough);
  const pairs = anchors
    .filter(anchor => splitPriorUnits(anchor).length === 2)
    .sort((left, right) => right.length - left.length);
  const wider = anchors
    .filter(anchor => splitPriorUnits(anchor).length > 2)
    .sort((left, right) => splitPriorUnits(right).length - splitPriorUnits(left).length || right.length - left.length);
  return uniqueKernelStrings([...pairs, ...wider]).slice(0, 32);
}

function primarySourceAnchorForRequest(requestText: string): string | undefined {
  const named = namedSubjectAnchors(requestText)
    .filter(sourceAnchorSpecificEnough)
    .sort((left, right) => splitPriorUnits(right).length - splitPriorUnits(left).length || right.length - left.length);
  if (named.length) return named[0];
  const casedSingle = casedSingleSourceAnchors(requestText);
  if (casedSingle.length) return casedSingle[0];
  const singleTopic = singleTopicSourceAnchors(requestText);
  if (singleTopic.length) return singleTopic[0];
  return derivedSourceAnchorPhrases(requestText)[0];
}

function casedSingleSourceAnchors(requestText: string): string[] {
  return uniqueKernelStrings(surfaceWords(requestText)
    .map(stripOuterPriorSeparators)
    .filter(unit => hasUppercaseLetter(unit) && [...unit].length >= 4)
    .map(normalizePriorKey)
    .filter(Boolean));
}

function singleTopicSourceAnchors(requestText: string): string[] {
  const units = requestContentAnchorUnits(requestText);
  if (units.length !== 1) return [];
  const unit = units[0] ?? "";
  return [...unit].length >= 5 || hasUncasedNonLatinLetter(unit) ? [unit] : [];
}

function derivedSourceAnchorPhrases(requestText: string): string[] {
  const units = requestContentAnchorUnits(requestText);
  const phrases: string[] = [];
  for (let index = 0; index < units.length - 1; index++) {
    const pair = [units[index]!, units[index + 1]!];
    if (anchorPhraseUnitsSpecificEnough(pair)) phrases.push(pair.join(" "));
  }
  for (let index = 0; index < units.length - 2; index++) {
    const triple = [units[index]!, units[index + 1]!, units[index + 2]!];
    if (triple.every(unit => unit.length >= 4)) phrases.push(triple.join(" "));
  }
  return uniqueKernelStrings(phrases)
    .sort((left, right) => sourceAnchorPhraseRank(right) - sourceAnchorPhraseRank(left) || splitPriorUnits(right).length - splitPriorUnits(left).length || right.length - left.length)
    .slice(0, 16);
}

function requestContentAnchorUnits(requestText: string): string[] {
  return requestContentPriorUnits(requestText)
    .map(stripOuterPriorSeparators)
    .map(normalizePriorKey)
    .filter(unit => unit.length >= 3 && !genericQuestionSignal(unit));
}

function anchorPhraseUnitsSpecificEnough(units: readonly string[]): boolean {
  if (units.length < 2) return false;
  const lengths = units.map(unit => [...unit].length);
  if (lengths.every(length => length >= 4)) return true;
  return units.length === 2 && Math.min(...lengths) >= 3 && lengths.reduce((sum, length) => sum + length, 0) >= 11;
}

function sourceAnchorPhraseRank(anchor: string): number {
  const units = splitPriorUnits(anchor);
  const lengthMass = units.reduce((sum, unit) => sum + Math.min(12, [...unit].length), 0);
  const shortPenalty = units.filter(unit => [...unit].length < 4).length * 6;
  return lengthMass - shortPenalty + units.length * 2;
}

function sourceAnchorSpecificEnough(anchor: string): boolean {
  const units = splitPriorUnits(anchor);
  if (units.length >= 2) return true;
  return hasUncasedNonLatinLetter(anchor) && [...anchor].length >= 2;
}

function evidenceSourceMatchesAnchors(span: EvidenceSpan, anchors: readonly string[]): boolean {
  const source = normalizePriorKey(evidenceSourceAnchorSurface(span));
  if (!source) return false;
  return anchors.some(anchor => evidenceMatchesSourceAnchor(span, anchor));
}

function evidenceMatchesSourceAnchor(span: EvidenceSpan, anchor: string): boolean {
  const source = normalizePriorKey(evidenceSourceAnchorSurface(span));
  if (!anchor) return false;
  const sourceUnits = splitPriorUnits(source).filter(Boolean);
  const anchorUnits = splitPriorUnits(anchor).filter(Boolean);
  if (!anchorUnits.length) return false;
  if (sourceUnits.length && sourceAnchorPhraseContains(sourceUnits, anchorUnits)) return true;
  if (anchorUnits.length === 1 && sourceUnits.some(unit => requestUnitMatchesSurface(anchorUnits[0]!, unit))) return true;
  const matched = anchorUnits.filter(anchorUnit => sourceUnits.some(sourceUnit => requestUnitMatchesSurface(anchorUnit, sourceUnit))).length;
  return matched >= Math.min(2, anchorUnits.length);
}

function sourceAnchorPhraseContains(sourceUnits: readonly string[], anchorUnits: readonly string[]): boolean {
  if (!sourceUnits.length || !anchorUnits.length || anchorUnits.length > sourceUnits.length) return false;
  for (let index = 0; index <= sourceUnits.length - anchorUnits.length; index++) {
    const window = sourceUnits.slice(index, index + anchorUnits.length);
    if (window.every((unit, offset) => requestUnitMatchesSurface(anchorUnits[offset]!, unit))) return true;
  }
  return sourceAnchorOrderedNearMatch(sourceUnits, anchorUnits);
}

function sourceAnchorOrderedNearMatch(sourceUnits: readonly string[], anchorUnits: readonly string[]): boolean {
  if (anchorUnits.length < 2) return false;
  const maxWindow = anchorUnits.length + 2;
  for (let start = 0; start < sourceUnits.length; start++) {
    if (!requestUnitMatchesSurface(anchorUnits[0]!, sourceUnits[start] ?? "")) continue;
    let anchorIndex = 1;
    const end = Math.min(sourceUnits.length - 1, start + maxWindow - 1);
    for (let surfaceIndex = start + 1; surfaceIndex <= end && anchorIndex < anchorUnits.length; surfaceIndex++) {
      if (requestUnitMatchesSurface(anchorUnits[anchorIndex]!, sourceUnits[surfaceIndex] ?? "")) anchorIndex++;
    }
    if (anchorIndex >= anchorUnits.length) return true;
  }
  return false;
}

function evidenceExactSourceAnchorMatches(span: EvidenceSpan, anchors: readonly string[]): boolean {
  const title = evidenceTitle(span);
  const exactSurfaces = title ? [title] : [];
  return exactSurfaces.some(surface => {
    const normalized = normalizePriorKey(surface);
    return Boolean(normalized) && anchors.some(anchor => normalized === anchor);
  });
}

function evidenceTitleDistinctAnchorMatches(span: EvidenceSpan, anchors: readonly string[]): boolean {
  const rawTitle = evidenceTitle(span);
  const title = normalizePriorKey(rawTitle);
  const coreTitle = normalizePriorKey(stripParentheticalTitleQualifiers(rawTitle));
  if (!title && !coreTitle) return false;
  const titleUnits = titleAnchorUnits(coreTitle || title);
  const rawCoreUnits = splitPriorUnits(coreTitle || title).filter(Boolean);
  if (!titleUnits.length) return false;
  for (const anchor of anchors) {
    const anchorUnits = titleAnchorUnits(anchor);
    if (!anchorUnits.length) continue;
    if (titleAnchorPhraseMatches(coreTitle || title, anchor)) {
      if (anchorUnits.length === 1 && rawCoreUnits.length > 1 && !evidenceTitleExactlyMatchesAnchor(span, anchor)) continue;
      return true;
    }
    const matchedTitleUnits = titleUnits.filter(titleUnit => anchorUnits.some(unit => titleAnchorUnitMatches(unit, titleUnit)));
    const matchedAnchorUnits = anchorUnits.filter(unit => titleUnits.some(titleUnit => titleAnchorUnitMatches(unit, titleUnit)));
    if (hasUncasedNonLatinLetter(anchor) && titleUnits.length === 1 && rawCoreUnits.length >= 2 && anchorUnits[0] && titleAnchorUnitMatches(anchorUnits[0], titleUnits[0]!)) return true;
    if (titleUnits.length === 1 && rawCoreUnits.length === 1 && titleSingleUnitMatchesNonInitialAnchor(titleUnits[0]!, anchorUnits)) return true;
    if (titleUnits.length >= 2 && matchedTitleUnits.length >= Math.min(2, titleUnits.length) && matchedAnchorUnits.length >= Math.min(2, anchorUnits.length)) return true;
  }
  return false;
}

function evidenceTitleExactlyMatchesAnchor(span: EvidenceSpan, anchor: string): boolean {
  const rawTitle = evidenceTitle(span);
  const title = normalizePriorKey(rawTitle);
  const coreTitle = normalizePriorKey(stripParentheticalTitleQualifiers(rawTitle));
  const normalizedAnchor = normalizePriorKey(anchor);
  return Boolean(normalizedAnchor) && (title === normalizedAnchor || coreTitle === normalizedAnchor);
}

function titleAnchorUnits(surface: string): string[] {
  return splitPriorUnits(normalizePriorKey(surface))
    .map(unit => unit.replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, ""))
    .filter(unit => unit.length >= 4 && !genericQuestionSignal(unit));
}

function stripParentheticalTitleQualifiers(value: string): string {
  return value.replace(/\s*\([^)]*\)\s*/gu, " ").trim();
}

function titleAnchorPhraseMatches(title: string, anchor: string): boolean {
  if (!title || !anchor) return false;
  if (title === anchor) return true;
  const paddedTitle = ` ${title} `;
  const paddedAnchor = ` ${anchor} `;
  return paddedTitle.includes(` ${anchor} `) || paddedAnchor.includes(` ${title} `);
}

function titleSingleUnitMatchesNonInitialAnchor(titleUnit: string, anchorUnits: readonly string[]): boolean {
  if (!titleUnit || anchorUnits.length < 2) return false;
  return anchorUnits.some((unit, index) => index > 0 && titleAnchorUnitMatches(unit, titleUnit));
}

function titleAnchorUnitMatches(unit: string, titleUnit: string): boolean {
  if (!unit || !titleUnit) return false;
  if (unit === titleUnit) return true;
  const minLength = Math.min(unit.length, titleUnit.length);
  const maxLength = Math.max(unit.length, titleUnit.length);
  return (unit.startsWith(titleUnit) || titleUnit.startsWith(unit)) && minLength / Math.max(1, maxLength) >= 0.72;
}

function evidenceSourceAnchorSurface(span: EvidenceSpan): string {
  const provenance = jsonRecord(span.provenance);
  const metadata = jsonRecord(provenance.metadata);
  return [
    evidenceTitle(span),
    kernelString(provenance.uri),
    kernelString(provenance.canonicalUri),
    kernelString(provenance.sourceUri),
    kernelString(metadata.uri),
    kernelString(metadata.canonicalUri),
    kernelString(metadata.sourceUri)
  ].filter(Boolean).join(" ");
}

function localEvidenceAnswerScore(requestText: string, evidence: readonly EvidenceSpan[]): number {
  const requestFeatures = featureSet(requestText, 256);
  return evidence.reduce((best, span) => {
    const surface = sourceTextSurface(span.text || span.textPreview, 24000);
    const score = Math.max(
      weightedJaccard(requestFeatures, span.features),
      weightedJaccard(requestFeatures, featureSet(surface, 256))
    ) + span.alpha * 0.12;
    return Math.max(best, score);
  }, 0);
}

interface ArithmeticEvaluation {
  expression: string;
  normalizedExpression: string;
  value: number;
  valueText: string;
  answer: string;
  audit: JsonValue;
}

interface ArithmeticToken {
  kind: "number" | "operator" | "left" | "right";
  value: string;
  numeric?: number;
}

function arithmeticAnswerForText(text: string): ArithmeticEvaluation | undefined {
  for (const candidate of arithmeticCandidateSegments(text)) {
    const parsed = parseArithmeticExpression(candidate);
    if (!parsed) continue;
    const valueText = formatArithmeticNumber(parsed.value);
    const expression = formatArithmeticExpression(parsed.normalizedExpression);
    return {
      expression,
      normalizedExpression: parsed.normalizedExpression,
      value: parsed.value,
      valueText,
      answer: `${expression} = ${valueText}.`,
      audit: toJsonValue({
        source: "kernel.turn.deterministic_arithmetic",
        expressionHash: hashTextForLocalProof(parsed.normalizedExpression),
        operatorCount: parsed.operatorCount,
        numberCount: parsed.numberCount,
        valueText
      })
    };
  }
  return undefined;
}

function arithmeticCandidateSegments(text: string): string[] {
  const segments: string[] = [];
  let current = "";
  for (const char of text) {
    if (arithmeticCandidateChar(char)) {
      current += char;
      continue;
    }
    if (current.trim()) segments.push(current.trim());
    current = "";
  }
  if (current.trim()) segments.push(current.trim());
  return segments
    .map(segment => segment.slice(0, 160))
    .filter(plausibleArithmeticSegment)
    .sort((left, right) => right.length - left.length);
}

function arithmeticCandidateChar(char: string): boolean {
  const code = char.codePointAt(0);
  return (char >= "0" && char <= "9") || char === "." || char === " " || char === "\t" || char === "\r" || char === "\n" || "+-*/^()[]{}".includes(char) || code === 0xd7 || code === 0xf7 || code === 0x2212;
}

function plausibleArithmeticSegment(segment: string): boolean {
  const compact = normalizeArithmeticOperators(segment).replace(/\s+/gu, "");
  if (compact.length < 3 || compact.length > 140) return false;
  if (/^\d{4}-\d{1,2}(?:-\d{1,2})?$/u.test(compact)) return false;
  if ((compact.match(/\d+(?:\.\d+)?/gu) ?? []).length < 2) return false;
  return /[+\-*/^]/u.test(compact);
}

function parseArithmeticExpression(raw: string): { value: number; normalizedExpression: string; operatorCount: number; numberCount: number } | undefined {
  const normalizedExpression = normalizeArithmeticOperators(raw).replace(/\s+/gu, "");
  const tokens = tokenizeArithmeticExpression(normalizedExpression);
  if (!tokens?.length) return undefined;
  let position = 0;
  let operatorCount = 0;
  const numberCount = tokens.filter(token => token.kind === "number").length;
  const peek = (): ArithmeticToken | undefined => tokens[position];
  const fail = (): never => { throw new Error("invalid arithmetic expression"); };
  const consume = (): ArithmeticToken => {
    const token = tokens[position];
    if (!token) return fail();
    position++;
    return token;
  };
  const bounded = (value: number): number => {
    if (!Number.isFinite(value) || Math.abs(value) > 1e15) fail();
    return Object.is(value, -0) ? 0 : value;
  };
  const parseExpression = (): number => parseAdditive();
  const parseAdditive = (): number => {
    let left = parseMultiplicative();
    while (peek()?.kind === "operator" && (peek()?.value === "+" || peek()?.value === "-")) {
      const operator = consume().value;
      const right = parseMultiplicative();
      operatorCount++;
      left = bounded(operator === "+" ? left + right : left - right);
    }
    return left;
  };
  const parseMultiplicative = (): number => {
    let left = parsePower();
    while (peek()?.kind === "operator" && (peek()?.value === "*" || peek()?.value === "/")) {
      const operator = consume().value;
      const right = parsePower();
      if (operator === "/" && right === 0) fail();
      operatorCount++;
      left = bounded(operator === "*" ? left * right : left / right);
    }
    return left;
  };
  const parsePower = (): number => {
    let left = parseUnary();
    if (peek()?.kind === "operator" && peek()?.value === "^") {
      consume();
      const right = parsePower();
      operatorCount++;
      left = bounded(left ** right);
    }
    return left;
  };
  const parseUnary = (): number => {
    if (peek()?.kind === "operator" && (peek()?.value === "+" || peek()?.value === "-")) {
      const operator = consume().value;
      const value = parseUnary();
      return bounded(operator === "-" ? -value : value);
    }
    return parsePrimary();
  };
  const parsePrimary = (): number => {
    const token = consume();
    if (!token) fail();
    if (token.kind === "number" && token.numeric !== undefined) return bounded(token.numeric);
    if (token.kind === "left") {
      const value = parseExpression();
      if (peek()?.kind !== "right") fail();
      consume();
      return bounded(value);
    }
    return fail();
  };
  try {
    const value = bounded(parseExpression());
    if (position !== tokens.length || operatorCount < 1 || numberCount < 2) return undefined;
    return { value, normalizedExpression, operatorCount, numberCount };
  } catch {
    return undefined;
  }
}

function tokenizeArithmeticExpression(expression: string): ArithmeticToken[] | undefined {
  const tokens: ArithmeticToken[] = [];
  for (let index = 0; index < expression.length;) {
    const char = expression[index];
    if (char === undefined) return undefined;
    if ((char >= "0" && char <= "9") || char === ".") {
      let end = index + 1;
      while (end < expression.length) {
        const next = expression[end];
        if (next === undefined || !((next >= "0" && next <= "9") || next === ".")) break;
        end++;
      }
      const raw = expression.slice(index, end);
      if (!/^\d+(?:\.\d+)?$|^\.\d+$/u.test(raw)) return undefined;
      const numeric = Number(raw);
      if (!Number.isFinite(numeric)) return undefined;
      tokens.push({ kind: "number", value: raw, numeric });
      index = end;
      continue;
    }
    if ("+-*/^".includes(char)) {
      tokens.push({ kind: "operator", value: char });
      index++;
      continue;
    }
    if (char === "(" || char === "[" || char === "{") {
      tokens.push({ kind: "left", value: char });
      index++;
      continue;
    }
    if (char === ")" || char === "]" || char === "}") {
      tokens.push({ kind: "right", value: char });
      index++;
      continue;
    }
    return undefined;
  }
  return tokens;
}

function normalizeArithmeticOperators(text: string): string {
  return [...text].map(char => {
    const code = char.codePointAt(0);
    if (code === 0xd7) return "*";
    if (code === 0xf7) return "/";
    if (code === 0x2212) return "-";
    return char;
  }).join("");
}

function formatArithmeticExpression(expression: string): string {
  return expression
    .replace(/\*/gu, " * ")
    .replace(/\//gu, " / ")
    .replace(/\^/gu, " ^ ")
    .replace(/\+/gu, " + ")
    .replace(/-/gu, " - ")
    .replace(/\s+/gu, " ")
    .replace(/\(\s+/gu, "(")
    .replace(/\s+\)/gu, ")")
    .trim();
}

function formatArithmeticNumber(value: number): string {
  const normalized = Object.is(value, -0) ? 0 : value;
  if (Number.isSafeInteger(normalized)) return String(normalized);
  return String(Number(normalized.toPrecision(12)));
}

function createArithmeticEntailment(input: {
  requestText: string;
  arithmetic: ArithmeticEvaluation;
  field: TurnResult["field"];
  idFactory: Pick<IdFactory, "claimId" | "proofId">;
  createdAt: number;
}): TurnResult["entailment"] {
  const normalized = `${input.arithmetic.normalizedExpression}=${input.arithmetic.valueText}`;
  const features = featureSet(normalized, 256);
  const claim = {
    id: input.idFactory.claimId({ normalized, polarity: 1, features: features.slice(0, 96) }),
    text: input.requestText,
    normalized,
    features,
    polarity: 1
  };
  const transformIds = ["deterministic-arithmetic"];
  const proofId = input.idFactory.proofId({ claimId: claim.id, evidenceIds: [], transforms: transformIds, validatorVersion: "scce-deterministic-arithmetic-v1" });
  const scores = {
    structuralCoverage: 1,
    roleCoverage: 1,
    relationCompatibility: 1,
    transformationSupport: 1,
    causalMass: Math.min(1, input.field.causalMass.reduce((sum, row) => sum + Math.max(0, row.mass), 0)),
    faithfulnessLCB: 1,
    contradiction: 0,
    stability: 1
  };
  const confidence = {
    verdict: "entailed" as const,
    support: 1,
    contradiction: 0,
    faithfulnessLcb: 1,
    supportingEvidence: 0,
    sourceVersions: [],
    structuralCoverage: scores.structuralCoverage,
    roleCoverage: scores.roleCoverage,
    relationCompatibility: scores.relationCompatibility,
    transformationSupport: scores.transformationSupport,
    causalMass: scores.causalMass,
    stability: scores.stability,
    satisfiedObligations: 1,
    requiredObligations: 1
  };
  const proofGraph = {
    nodes: [
      { id: String(claim.id), kind: "claim" as const, label: "proof.claim.deterministic_arithmetic", metadata: toJsonValue({ normalizedHash: hashTextForLocalProof(normalized) }) },
      { id: "transform:deterministic-arithmetic", kind: "transform" as const, label: "proof.transform.deterministic_arithmetic", metadata: input.arithmetic.audit },
      { id: "boundary:deterministic-computation", kind: "boundary" as const, label: "proof.boundary.deterministic_computation", metadata: toJsonValue({ validatorVersion: "scce-deterministic-arithmetic-v1", sourceEvidenceRequired: false }) }
    ],
    edges: [
      { source: "transform:deterministic-arithmetic", target: String(claim.id), relation: "transforms" as const, weight: 1, evidenceIds: [] },
      { source: "boundary:deterministic-computation", target: String(claim.id), relation: "bounds" as const, weight: 1, evidenceIds: [] }
    ]
  };
  return {
    claim,
    verdict: "entailed",
    semanticVerdict: "entailed",
    force: "proved",
    support: 1,
    contradiction: 0,
    faithfulnessLcb: 1,
    confidence,
    scores,
    obligations: [{
      id: "obligation:deterministic-quantity",
      kind: "quantity",
      status: "satisfied",
      claimText: input.arithmetic.normalizedExpression,
      evidenceIds: [],
      sourceVersionIds: [],
      support: 1,
      contradiction: 0,
      required: true,
      reason: "proof.obligation.deterministic_quantity",
      metadata: input.arithmetic.audit
    }],
    mappings: [],
    transforms: [{
      id: "transform:deterministic-arithmetic",
      transformKind: "constraint_preservation",
      source: input.arithmetic.normalizedExpression,
      target: input.arithmetic.valueText,
      registered: true,
      support: 1,
      evidenceIds: [],
      sourceVersionIds: [],
      audit: input.arithmetic.audit
    }],
    counterexamples: [],
    missing: [],
    proof: {
      id: proofId,
      claimId: claim.id,
      verdict: "proved",
      confidence: toJsonValue({ ...confidence, deterministicArithmetic: true, sourceEvidenceRequired: false }),
      proofGraph,
      evidenceIds: [],
      transformIds,
      scores: toJsonValue({ deterministicArithmetic: true, scores }),
      validatorVersion: "scce-deterministic-arithmetic-v1",
      createdAt: input.createdAt
    },
    evidenceIds: [],
    boundaries: ["deterministic-arithmetic", "source-evidence-not-required"]
  };
}

function createLocalEvidenceEntailment(input: {
  requestText: string;
  evidence: readonly EvidenceSpan[];
  field: TurnResult["field"];
  idFactory: Pick<IdFactory, "claimId" | "proofId">;
  createdAt: number;
}): TurnResult["entailment"] {
  const normalized = normalizePriorKey(input.requestText);
  const features = featureSet(input.requestText, 512);
  const claim = {
    id: input.idFactory.claimId({ normalized, polarity: 1, features: features.slice(0, 96) }),
    text: input.requestText,
    normalized,
    features,
    polarity: 1
  };
  const evidenceIds = uniqueKernelStrings(input.evidence.map(span => String(span.id))).map(id => id as EvidenceSpan["id"]);
  const sourceVersions = uniqueKernelStrings(input.evidence.map(span => String(span.sourceVersionId)));
  const relevance = localEvidenceAnswerScore(input.requestText, input.evidence);
  const fieldMass = input.field.ppf.slice(0, 16).reduce((sum, row) => sum + Math.max(0, Math.min(1, row.mass)), 0);
  const support = Math.min(0.74, 0.24 + relevance * 0.72 + Math.min(0.18, input.evidence.length * 0.018) + Math.min(0.08, fieldMass * 0.08));
  const faithfulnessLcb = Math.min(0.64, Math.max(0.24, support * 0.82));
  const stability = Math.min(0.82, 0.42 + Math.min(0.24, input.evidence.length * 0.02) + Math.min(0.16, input.evidence.reduce((sum, span) => sum + span.alpha, 0) / Math.max(1, input.evidence.length) * 0.16));
  const force: EpistemicForce = support >= 0.34 ? "inferred" : "conjectured";
  const transformIds = ["local-evidence-fast-path", "source-bound-surface"];
  const proofId = input.idFactory.proofId({ claimId: claim.id, evidenceIds, transforms: transformIds, validatorVersion: "scce-local-evidence-bound-v1" });
  const scores = {
    structuralCoverage: Math.min(1, relevance + 0.12),
    roleCoverage: Math.min(1, relevance + 0.08),
    relationCompatibility: Math.min(1, relevance + 0.16),
    transformationSupport: 0,
    causalMass: Math.min(1, fieldMass),
    faithfulnessLCB: faithfulnessLcb,
    contradiction: 0,
    stability
  };
  const proofGraph = {
    nodes: [
      { id: String(claim.id), kind: "claim" as const, label: "proof.claim.local_evidence_bound", metadata: toJsonValue({ textHash: hashTextForLocalProof(input.requestText), normalizedHash: hashTextForLocalProof(normalized) }) },
      ...input.evidence.map(span => ({
        id: String(span.id),
        kind: "evidence" as const,
        label: "proof.evidence.selected_local",
        metadata: toJsonValue({
          sourceVersionId: String(span.sourceVersionId),
          contentHash: String(span.contentHash),
          status: span.status,
          alpha: span.alpha
        })
      })),
      { id: "boundary:local-evidence-fast-path", kind: "boundary" as const, label: "proof.boundary.local_evidence_fast_path", metadata: toJsonValue({ validatorVersion: "scce-local-evidence-bound-v1", certifiesFullProof: false }) }
    ],
    edges: [
      ...input.evidence.map(span => ({
        source: String(span.id),
        target: String(claim.id),
        relation: "supports" as const,
        weight: Math.max(0.01, Math.min(1, span.alpha)),
        evidenceIds: [span.id]
      })),
      { source: "boundary:local-evidence-fast-path", target: String(claim.id), relation: "bounds" as const, weight: 1, evidenceIds }
    ]
  };
  const confidence = {
    verdict: "underdetermined" as const,
    support,
    contradiction: 0,
    faithfulnessLcb,
    supportingEvidence: evidenceIds.length,
    sourceVersions,
    structuralCoverage: scores.structuralCoverage,
    roleCoverage: scores.roleCoverage,
    relationCompatibility: scores.relationCompatibility,
    transformationSupport: scores.transformationSupport,
    causalMass: scores.causalMass,
    stability,
    satisfiedObligations: evidenceIds.length ? 1 : 0,
    requiredObligations: 1
  };
  return {
    claim,
    verdict: "underdetermined",
    semanticVerdict: "underdetermined",
    force,
    support,
    contradiction: 0,
    faithfulnessLcb,
    confidence,
    scores,
    obligations: [{
      id: "obligation:source-bound-local-evidence",
      kind: "source_version",
      status: evidenceIds.length ? "satisfied" : "missing",
      claimText: input.requestText,
      evidenceIds,
      sourceVersionIds: sourceVersions.map(id => id as EvidenceSpan["sourceVersionId"]),
      support,
      contradiction: 0,
      required: true,
      reason: "proof.obligation.source_bound_local_evidence",
      metadata: toJsonValue({ validatorVersion: "scce-local-evidence-bound-v1" })
    }],
    mappings: [],
    transforms: [{
      id: "transform:source-bound-surface",
      transformKind: "supported_paraphrase",
      source: "selected-local-evidence",
      target: "answer-surface",
      registered: true,
      support,
      evidenceIds,
      sourceVersionIds: sourceVersions.map(id => id as EvidenceSpan["sourceVersionId"]),
      audit: toJsonValue({ validatorVersion: "scce-local-evidence-bound-v1", relevance })
    }],
    counterexamples: [],
    missing: [],
    proof: {
      id: proofId,
      claimId: claim.id,
      verdict: force,
      confidence: toJsonValue({ ...confidence, localEvidenceBound: true, certifiesFullProof: false, relevance }),
      proofGraph,
      evidenceIds,
      transformIds,
      scores: toJsonValue({ localEvidenceBound: true, relevance, scores }),
      validatorVersion: "scce-local-evidence-bound-v1",
      createdAt: input.createdAt
    },
    evidenceIds,
    boundaries: ["selected-evidence-bound", "fast-local-evidence-answer", "local-evidence-certification-boundary"]
  };
}

function hashTextForLocalProof(text: string): string {
  let hash = 2166136261;
  for (let index = 0; index < text.length; index++) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

function bindSelectedEvidenceToEntailment(entailment: TurnResult["entailment"], evidence: readonly EvidenceSpan[], audit: JsonValue): TurnResult["entailment"] {
  const evidenceIds = uniqueKernelStrings([
    ...entailment.evidenceIds.map(String),
    ...evidence.map(span => String(span.id))
  ]).map(id => id as EvidenceSpan["id"]);
  const sourceVersions = uniqueKernelStrings([
    ...entailment.confidence.sourceVersions,
    ...evidence.map(span => String(span.sourceVersionId))
  ]);
  const existingNodeIds = new Set(entailment.proof.proofGraph.nodes.map(node => node.id));
  const evidenceNodes = evidence
    .filter(span => !existingNodeIds.has(String(span.id)))
    .map(span => ({
      id: String(span.id),
      kind: "evidence" as const,
      label: "proof.evidence.selected_local",
      metadata: toJsonValue({
        sourceVersionId: String(span.sourceVersionId),
        contentHash: String(span.contentHash),
        status: span.status,
        alpha: span.alpha
      })
    }));
  const evidenceEdges = evidence.map(span => ({
    source: String(span.id),
    target: String(entailment.claim.id),
    relation: "supports" as const,
    weight: Math.max(0.01, Math.min(1, span.alpha)),
    evidenceIds: [span.id]
  }));
  const confidence = {
    ...entailment.confidence,
    supportingEvidence: evidenceIds.length,
    sourceVersions
  };
  return {
    ...entailment,
    evidenceIds,
    confidence,
    proof: {
      ...entailment.proof,
      evidenceIds,
      confidence: toJsonValue({
        ...jsonRecord(entailment.proof.confidence),
        selectedEvidenceBound: audit,
        supportingEvidence: evidenceIds.length,
        sourceVersions
      }),
      proofGraph: {
        nodes: [...entailment.proof.proofGraph.nodes, ...evidenceNodes],
        edges: [...entailment.proof.proofGraph.edges, ...evidenceEdges]
      },
      scores: {
        ...jsonRecord(entailment.proof.scores),
        selectedEvidenceBound: audit
      }
    },
    boundaries: [...new Set([...entailment.boundaries, "selected-evidence-bound", "fast-local-evidence-answer"])]
  };
}

function promotedSessionEvidence(span: EvidenceSpan): boolean {
  return span.status === "promoted" && String(span.id).startsWith("evidence_session_");
}

function bestEvidenceSurface(requestText: string, evidence: readonly EvidenceSpan[]): string {
  return bestEvidenceSentences(requestText, evidence)
    .map(ensureSentenceSurface)
    .filter(Boolean)
    .join(" ");
}

interface EvidenceSentenceRow {
  span: EvidenceSpan;
  sentence: string;
  features: string[];
  index: number;
  score: number;
  unitOverlap: number;
}

function bestEvidenceSentences(requestText: string, evidence: readonly EvidenceSpan[], sessionContextEvidence = false): string[] {
  const limit = evidenceAnswerSentenceLimit(requestText, evidence, sessionContextEvidence);
  if (evidence.length === 1) {
    const span = evidence[0];
    if (!span) return [];
    const sentences = fastAnswerSentences(sourceTextSurface(span.text || span.textPreview || "", 24000));
    const requestFeatures = featureSet(requestText, 256);
    const requestUnits = requestUnitSet(requestText);
    const anchors = sourceEvidenceAnchorsForRequest(requestText);
    const focused = sentences
      .map((sentence, index): EvidenceSentenceRow => {
        const clean = anchorFocusedAnswerSurface(cleanSourceAnswerSurface(sentence), anchors, evidenceTitle(span));
        const unitOverlap = requestUnitOverlapForSurface(clean, requestUnits);
        const anchorBoost = sourceSurfaceMatchesAnyAnchor(clean, anchors) ? 0.54 : 0;
        const titleLeadBoost = anchors.length && index <= 1 && evidenceTitleDistinctAnchorMatches(span, anchors) && evidenceTitleAppearsInSurface(span, clean) ? 0.32 : 0;
        return {
          span,
          sentence: clean,
          features: featureSet(clean, 256),
          index,
          unitOverlap,
          score: unitOverlap * 0.92 + weightedJaccard(requestFeatures, featureSet(clean, 256)) * 0.35 + Math.max(0, 0.16 - index * 0.018) + titleLeadBoost + anchorBoost - fastAnswerLongSentencePenalty(clean)
        };
      })
      .filter(row => row.sentence && (row.score > 0.16 || (anchors.length > 0 && row.index === 0)))
      .sort((left, right) => right.score - left.score || right.unitOverlap - left.unitOverlap || left.index - right.index);
    const selected = selectEvidenceSentenceRows(focused.length ? focused : sentences.map((sentence, index): EvidenceSentenceRow => {
      const clean = cleanSourceAnswerSurface(sentence);
        return {
          span,
          sentence: clean,
          features: featureSet(clean, 256),
        index,
        unitOverlap: requestUnitOverlapForSurface(clean, requestUnits),
        score: Math.max(0, 0.12 - index * 0.012)
      };
    }), limit);
    return selected.map(row => row.sentence);
  }
  const requestFeatures = featureSet(requestText, 256);
  const requestUnits = requestUnitSet(requestText);
  const orderedRequestUnits = requestUnitsFromText(requestText);
  const anchors = sourceEvidenceAnchorsForRequest(requestText);
  const candidates = evidence
    .flatMap(span => fastAnswerSentences(sourceTextSurface(span.text || span.textPreview, 24000)).slice(0, 80).map((surface, index) => {
      const clean = anchorFocusedAnswerSurface(cleanSourceAnswerSurface(surface), anchors, evidenceTitle(span));
      const features = featureSet(clean, 256);
      const lexical = weightedJaccard(requestFeatures, features) + weightedJaccard(requestFeatures, span.features) * 0.35;
      const unitOverlap = requestUnitOverlapForSurface(clean, requestUnits);
      const pairOverlap = surfaceRequestAdjacentUnitPairOverlap(clean, orderedRequestUnits);
      const anchorBoost = sourceSurfaceMatchesAnyAnchor(clean, anchors) ? 0.54 : 0;
      const positionPrior = Math.max(0, 0.18 - index * 0.015);
      return {
        span,
        sentence: clean,
        features,
        index,
        unitOverlap,
        score: lexical + Math.min(4, unitOverlap) * 0.08 + pairOverlap * 0.16 + span.alpha * 0.12 + positionPrior + anchorBoost + fastAnswerNamedSurfaceMass(clean) * 0.22 - fastAnswerLongSentencePenalty(clean)
      };
    }))
    .filter(row => row.sentence)
    .sort((a, b) => b.score - a.score || String(a.span.id).localeCompare(String(b.span.id)));
  const selected = selectEvidenceSentenceRows(candidates, limit);
  return selected.map(item => item.sentence);
}

function anchorFocusedAnswerSurface(surface: string, anchors: readonly string[], title = ""): string {
  if (!surface || !anchors.length) return surface;
  const parts = splitSourceSentenceBoundaries(surface);
  const selected = parts.find(part => sourceSurfaceMatchesAnyAnchor(part, anchors)) ?? surface;
  return anchorLocalSurface(stripLeadingSourceTitle(selected, title, anchors), anchors);
}

function stripLeadingSourceTitle(surface: string, title: string, anchors: readonly string[]): string {
  const cleanTitle = cleanSourceAnswerSurface(title);
  if (!surface || !cleanTitle) return surface;
  const rawPrefixMatch = surface.toLocaleLowerCase().startsWith(cleanTitle.toLocaleLowerCase());
  const normalizedPrefixMatch = normalizePriorKey(surface).startsWith(normalizePriorKey(cleanTitle));
  if (!rawPrefixMatch && !normalizedPrefixMatch) return surface;
  const stripped = rawPrefixMatch
    ? surface.slice(cleanTitle.length).replace(/^[\s:;,\-.|]+/u, "").trim()
    : stripLeadingSurfaceUnits(surface, splitPriorUnits(normalizePriorKey(cleanTitle)).length);
  return stripped && sourceSurfaceMatchesAnyAnchor(stripped, anchors) ? stripped : surface;
}

function stripLeadingSurfaceUnits(surface: string, unitCount: number): string {
  if (unitCount <= 0) return surface;
  let seen = 0;
  let index = 0;
  let inUnit = false;
  for (; index < surface.length; index++) {
    const char = surface[index] ?? "";
    if (/\p{L}|\p{N}/u.test(char)) {
      if (!inUnit) {
        seen++;
        inUnit = true;
      }
      continue;
    }
    if (inUnit && seen >= unitCount) {
      index++;
      break;
    }
    inUnit = false;
  }
  return surface.slice(index).replace(/^[\s:;,\-.|]+/u, "").trim();
}

function anchorLocalSurface(surface: string, anchors: readonly string[]): string {
  if (!surface || !anchors.length) return surface;
  const words = surfaceWords(surface);
  if (words.length < 12) return surface;
  const normalized = words.map(word => normalizePriorKey(stripOuterPriorSeparators(word))).filter(Boolean);
  for (const anchor of anchors) {
    const anchorUnits = splitPriorUnits(anchor).filter(Boolean);
    if (!anchorUnits.length) continue;
    const first = anchorUnits[0] ?? "";
    const index = normalized.findIndex(unit => requestUnitMatchesSurface(first, unit));
    if (index <= 8) continue;
    const clipped = words.slice(Math.max(0, index - 7)).join(" ").trim();
    if (clipped && sourceSurfaceMatchesAnyAnchor(clipped, [anchor])) return clipped;
  }
  return surface;
}

interface LocalSurfaceWordSpan {
  start: number;
  end: number;
  key: string;
}

function anchorMentionSurface(surface: string, anchors: readonly string[]): string {
  if (!surface || !anchors.length) return "";
  const words = localSurfaceWordSpans(surface);
  if (!words.length) return "";
  for (const anchor of anchors) {
    const anchorUnits = splitPriorUnits(anchor).filter(Boolean);
    if (!anchorUnits.length) continue;
    for (let startIndex = 0; startIndex < words.length; startIndex++) {
      if (!requestUnitMatchesSurface(anchorUnits[0] ?? "", words[startIndex]?.key ?? "")) continue;
      let anchorIndex = 1;
      let endIndex = startIndex;
      const maxEnd = Math.min(words.length - 1, startIndex + anchorUnits.length + 4);
      for (let index = startIndex + 1; index <= maxEnd && anchorIndex < anchorUnits.length; index++) {
        if (requestUnitMatchesSurface(anchorUnits[anchorIndex] ?? "", words[index]?.key ?? "")) {
          anchorIndex++;
          endIndex = index;
        }
      }
      if (anchorIndex < anchorUnits.length) continue;
      let end = words[endIndex]?.end ?? 0;
      const parenthetical = surface.slice(end).match(/^\s*\([^)]{1,96}\)/u)?.[0] ?? "";
      if (parenthetical) end += parenthetical.length;
      const mention = cleanSourceAnswerSurface(surface.slice(words[startIndex]?.start ?? 0, end).replace(/[,;:\s]+$/u, ""));
      if (mention && sourceSurfaceMatchesAnyAnchor(mention, [anchor])) return mention;
    }
  }
  return "";
}

function localSurfaceWordSpans(surface: string): LocalSurfaceWordSpan[] {
  const out: LocalSurfaceWordSpan[] = [];
  for (const match of surface.matchAll(/[\p{L}\p{N}][\p{L}\p{N}'’.-]*/gu)) {
    const raw = match[0] ?? "";
    const start = match.index ?? 0;
    const end = start + raw.length;
    const key = normalizePriorKey(stripOuterPriorSeparators(raw));
    if (key) out.push({ start, end, key });
  }
  return out;
}

function splitSourceSentenceBoundaries(surface: string): string[] {
  const out: string[] = [];
  let start = 0;
  for (let index = 0; index < surface.length; index++) {
    const char = surface[index] ?? "";
    if (char !== "." && char !== "!" && char !== "?" && char !== "。" && char !== "！" && char !== "？") continue;
    const next = surface[index + 1] ?? "";
    if (next && !/\s/u.test(next)) continue;
    if (char === "." && previousSurfaceWord(surface, index).length === 1) continue;
    const part = surface.slice(start, index + 1).trim();
    if (part) out.push(part);
    start = index + 1;
  }
  const tail = surface.slice(start).trim();
  if (tail) out.push(tail);
  return out.length ? out : [surface];
}

function previousSurfaceWord(surface: string, punctuationIndex: number): string {
  let index = punctuationIndex - 1;
  while (index >= 0 && /\s/u.test(surface[index] ?? "")) index--;
  let word = "";
  while (index >= 0) {
    const char = surface[index] ?? "";
    if (!/\p{L}|\p{N}/u.test(char)) break;
    word = `${char}${word}`;
    index--;
  }
  return word;
}

function sourceSurfaceMatchesAnyAnchor(surface: string, anchors: readonly string[]): boolean {
  if (!surface || !anchors.length) return false;
  const units = splitPriorUnits(normalizePriorKey(surface)).filter(Boolean);
  return anchors.some(anchor => {
    const anchorUnits = splitPriorUnits(anchor).filter(Boolean);
    return anchorUnits.length > 0 && sourceAnchorPhraseContains(units, anchorUnits);
  });
}

function selectEvidenceSentenceRows(rows: readonly EvidenceSentenceRow[], limit: number): EvidenceSentenceRow[] {
  const selected: EvidenceSentenceRow[] = [];
  for (const candidate of rows) {
    if (selected.length >= limit) break;
    if (selected.some(item => weightedJaccard(item.features, candidate.features) > 0.9)) continue;
    selected.push(candidate);
  }
  return selected;
}

function evidenceAnswerSentenceLimit(requestText: string, evidence: readonly EvidenceSpan[], sessionContextEvidence = false): number {
  if (sessionContextEvidence && !namedSubjectAnchors(requestText).length) return 1;
  const anchors = sourceEvidenceAnchorsForRequest(requestText);
  if (!anchors.length && evidence.some(promotedSessionEvidence)) return 1;
  if (evidence.length === 1 && anchors.length && evidenceExactSourceAnchorMatches(evidence[0]!, anchors)) return 1;
  return anchors.length ? 2 : 1;
}

function evidenceTitleAppearsInSurface(span: EvidenceSpan, surface: string): boolean {
  const title = normalizePriorKey(evidenceTitle(span));
  const text = normalizePriorKey(surface);
  return Boolean(title && text && (text.includes(title) || title.includes(text)));
}

function surfaceRequestAdjacentUnitPairOverlap(surface: string, requestUnits: readonly string[]): number {
  if (requestUnits.length < 2) return 0;
  const surfaceUnits = splitPriorUnits(normalizePriorKey(surface)).filter(unit => unit.length >= 4);
  let overlap = 0;
  for (let index = 0; index < requestUnits.length - 1; index++) {
    const left = requestUnits[index] ?? "";
    const right = requestUnits[index + 1] ?? "";
    if (!left || !right || left === right) continue;
    if (requestUnitAppearsInSurface(left, surfaceUnits) && requestUnitAppearsInSurface(right, surfaceUnits)) overlap++;
  }
  return overlap;
}

function fastAnswerSentences(text: string): string[] {
  const merged: string[] = [];
  for (const rawSentence of splitSurfaceSentences(text)) {
    const sentence = cleanFastAnswerSentence(rawSentence);
    if (!sentence) continue;
    const previous = merged[merged.length - 1];
    if (previous && (previous.length <= 3 && previous.endsWith(".") || fastAnswerSentenceShouldMerge(previous))) {
      merged[merged.length - 1] = `${previous} ${sentence}`;
    } else {
      merged.push(sentence);
    }
  }
  return merged;
}

function cleanFastAnswerSentence(sentence: string): string {
  const trimmed = cleanSourceAnswerSurface(sentence);
  const marker = trimmed.lastIndexOf("]]");
  if (marker >= 0 && marker < trimmed.length - 2) return cleanSourceAnswerSurface(trimmed.slice(marker + 2).replace(/^[\s\p{Punctuation}]+/u, "").trim());
  return trimmed;
}

function cleanSourceAnswerSurface(text: string): string {
  let out = collapseSurfaceWhitespace(text.replace(/\u0000/g, " ").normalize("NFC"));
  if (!out) return "";
  out = out.replace(/\[\[\s*(?:File|Image):[^\]]{0,600}\]\]/giu, " ");
  out = out.replace(/\|(?:alt|thumb|thumbnail|frameless|upright|left|right|center)\s*=?[^|\]]{0,240}/giu, " ");
  out = out.replace(/\|[a-z][a-z0-9_-]{0,32}\s*=[^|\]]{0,240}/giu, " ");
  out = out.replace(/\[\[([^[\]|]+)\|([^\]]+)\]\]/gu, "$2");
  out = out.replace(/\[\[([^\]]+)\]\]/gu, "$1");
  out = out.replace(/\[(?:https?:)?\/\/[^\]\s]+(?:\s+([^\]]+))?\]/giu, "$1");
  out = out.replace(/={2,}\s*([^=]{1,120}?)\s*={2,}/gu, "$1");
  out = out.replace(/'{2,}/gu, "");
  out = out.replace(/(^|[\s([{])'([^']{2,160})'(?=$|[\s,.;:)\]}])/gu, "$1$2");
  out = out.replace(/\(\s*;\s*/gu, "(");
  out = out.replace(/\(\s*\)/gu, " ");
  out = out.replace(/\s+([,.;:!?])/gu, "$1");
  out = out.replace(/([([{])\s+/gu, "$1");
  out = out.replace(/\s+([)\]}])/gu, "$1");
  out = out.replace(/^\s*[,;:]\s*/u, "");
  out = out.replace(/\s+/gu, " ").trim();
  return out;
}

function fastAnswerSentenceShouldMerge(sentence: string): boolean {
  return delimiterBalance(sentence, "(", ")") > 0 || delimiterBalance(sentence, "[", "]") > 0;
}

function delimiterBalance(text: string, open: string, close: string): number {
  let balance = 0;
  for (const char of text) {
    if (char === open) balance++;
    else if (char === close) balance--;
  }
  return balance;
}

function fastAnswerNamedSurfaceMass(text: string): number {
  const names = new Set(surfaceEntityRuns(text).map(item => item.toLocaleLowerCase()));
  const parentheticalNames = (text.match(/\([^)]{2,100}\)/gu) ?? []).filter(item => surfaceEntityRuns(item).length > 0).length;
  return Math.max(0, Math.min(1, Math.min(1, names.size / 16) * 0.38 + Math.min(1, parentheticalNames / 4) * 0.62));
}

function fastAnswerLongSentencePenalty(text: string): number {
  return Math.max(0, Math.min(1, Math.max(0, text.length - 560) / 1600)) * 0.18;
}

function ensureSentenceSurface(text: string): string {
  return ensureUnicodeSurfaceSentence(text);
}

function sentenceBoundarySurface(text: string): string {
  const clean = collapseSurfaceWhitespace(text);
  if (clean.length < 180) return clean;
  const selected: string[] = [];
  let total = 0;
  for (const sentence of splitSurfaceSentences(clean)) {
    selected.push(sentence);
    total += sentence.length;
    if (total >= 180) break;
  }
  return selected.length ? selected.join(" ") : clean;
}

function attachLocalEvidenceAnswerConstruct(input: {
  construct: ConstructGraph;
  plan: LocalEvidenceAnswerPlan;
  requestText: string;
  brainMarker: JsonValue;
  hasher: { digestHex(input: string | Uint8Array): string };
}): ConstructGraph {
  const facts = localEvidenceAnswerFacts(input.plan, input.requestText, input.hasher);
  if (!facts.length) return input.construct;
  const marker = jsonRecord(input.brainMarker);
  const evidenceIds = uniqueKernelStrings(input.plan.evidence.map(span => String(span.id)));
  const sourceVersionIds = uniqueKernelStrings(input.plan.evidence.map(span => String(span.sourceVersionId)));
  const nodeId = `construct:ans:${input.hasher.digestHex(JSON.stringify({ planId: input.plan.planId, evidenceIds })).slice(0, 20)}`;
  const selectedSubject = localEvidenceSelectedSubject(input.plan, input.requestText);
  const metadata = {
    schema: "scce.semantic_answer_construct.v1",
    questionShapeId: `qshape.${input.hasher.digestHex(input.requestText).slice(0, 12)}`,
    selectedSubject,
    selectedFacts: facts,
    answerSlots: facts.map(fact => ({
      id: `slot.${input.hasher.digestHex(localEvidenceSemanticFactKey(fact)).slice(0, 16)}`,
      relationIds: [fact.relationId],
      factKeys: [localEvidenceSemanticFactKey(fact)],
      support: fact.support,
      activation: fact.activation
    })),
    selectedRelations: uniqueKernelStrings(facts.map(fact => fact.relationId)),
    activatedNeighborhood: facts,
    rejectedCandidates: [],
    supportIds: evidenceIds,
    forceId: "output.force.source_bound_answer",
    boundaryId: "output.force.source_bound",
    activeBrainVersion: kernelString(marker.activeBrainVersion) ?? "",
    activeImportRunIds: kernelStringArray(marker.activeImportRunIds),
    alphaRhetoricalPlan: null,
    cognitiveFabric: null,
    questionSlotPlan: null,
    certificationBoundary: {
      directEvidenceCount: evidenceIds.length,
      evidenceSpanIds: evidenceIds,
      sourceVersionIds,
      externalFactCertification: true
    },
    localEvidenceAnswer: {
      planId: input.plan.planId,
      kindId: input.plan.kindId,
      audit: input.plan.audit
    }
  };
  return {
    ...input.construct,
    nodes: [
      ...input.construct.nodes.filter(node => node.kind !== "construct:semantic_answer"),
      {
        id: nodeId,
        kind: "construct:semantic_answer",
        label: selectedSubject || facts[0]?.subject || nodeId,
        metadata: toJsonValue(metadata)
      }
    ],
    edges: [
      ...input.construct.edges,
      ...facts.flatMap(fact => [
        { source: nodeId, target: fact.sourceNodeId, relation: "rel.b40c2e11", weight: fact.support },
        { source: nodeId, target: fact.targetNodeId, relation: "rel.f73a91d0", weight: fact.support }
      ])
    ]
  };
}

function localEvidenceAnswerFacts(plan: LocalEvidenceAnswerPlan, requestText: string, hasher: { digestHex(input: string | Uint8Array): string }): SemanticAnswerConstructFact[] {
  if (plan.kindId === LOCAL_ANSWER_KIND_IDS.collection) {
    const subject = localEvidenceSelectedSubject(plan, requestText);
    return stringArrayFromSlot(plan.slotSurfaces[LOCAL_ANSWER_SLOT_IDS.memberList]).map((member, index) => localEvidenceSemanticFact({
      subject: member,
      predicate: "\u2208",
      object: subject,
      relationId: LOCAL_ANSWER_RELATION_IDS.member,
      evidence: plan.evidence,
      index,
      hasher
    }));
  }
  if (plan.kindId === LOCAL_ANSWER_KIND_IDS.temporalCounterexample) {
    const facts: SemanticAnswerConstructFact[] = [];
    const subject = firstStringSlot(plan.slotSurfaces[LOCAL_ANSWER_SLOT_IDS.subject]);
    const predicate = firstStringSlot(plan.slotSurfaces[LOCAL_ANSWER_SLOT_IDS.requestPredicate]);
    const concept = firstStringSlot(plan.slotSurfaces[LOCAL_ANSWER_SLOT_IDS.conceptEvidence]);
    const counter = firstStringSlot(plan.slotSurfaces[LOCAL_ANSWER_SLOT_IDS.counterexampleEvidence]);
    if (subject && predicate) facts.push(localEvidenceSemanticFact({
      subject,
      predicate: "\u00ac",
      object: predicate,
      relationId: LOCAL_ANSWER_RELATION_IDS.polarityReject,
      evidence: plan.evidence,
      index: 0,
      hasher
    }));
    if (concept || counter) facts.push(localEvidenceSemanticFact({
      subject: cleanSourceAnswerSurface(evidenceTitle(plan.evidence[0]!) || subject),
      predicate: kernelString(jsonRecord(plan.audit).counterexampleDate) ?? "",
      object: uniqueKernelStrings([concept, counter]).join(" "),
      relationId: LOCAL_ANSWER_RELATION_IDS.temporalCounterexample,
      evidence: plan.evidence,
      index: facts.length,
      hasher
    }));
    return facts;
  }
  return localEvidenceFactSurfaces(plan, requestText).map((sentence, index) => localEvidenceSemanticFact({
    subject: localEvidenceSelectedSubject(plan, requestText),
    predicate: sentence,
    object: sentence,
    relationId: LOCAL_ANSWER_RELATION_IDS.sourceQuote,
    evidence: plan.evidence,
    index,
    hasher
  }));
}

function localEvidenceFactSurfaces(plan: LocalEvidenceAnswerPlan, requestText: string): string[] {
  const anchors = sourceEvidenceAnchorsForRequest(requestText);
  const exactTitle = anchors.length > 0 && plan.evidence.some(span => evidenceExactSourceAnchorMatches(span, anchors));
  const surfaces = uniqueKernelStrings(stringArrayFromSlot(plan.slotSurfaces[LOCAL_ANSWER_SLOT_IDS.sentence])
    .map(sentence => boundedLocalQuoteSurface(localEvidenceRealizationSurface(plan, requestText, sentence), 320))
    .filter(Boolean));
  if (!anchors.length || exactTitle) return surfaces;
  const focused = surfaces
    .filter(surface => sourceSurfaceMatchesAnyAnchor(surface, anchors))
    .filter(surface => splitPriorUnits(normalizePriorKey(surface)).length <= 8);
  return focused.length ? focused.slice(0, 1) : surfaces.slice(0, 1);
}

function localEvidenceSemanticFact(input: {
  subject: string;
  predicate: string;
  object: string;
  relationId: string;
  evidence: readonly EvidenceSpan[];
  index: number;
  hasher: { digestHex(input: string | Uint8Array): string };
}): SemanticAnswerConstructFact {
  const subject = cleanSourceAnswerSurface(input.subject);
  const predicate = cleanSourceAnswerSurface(input.predicate);
  const object = cleanSourceAnswerSurface(input.object);
  const evidenceIds = uniqueKernelStrings(input.evidence.map(span => String(span.id)));
  const sourceVersionId = String(input.evidence[0]?.sourceVersionId ?? "");
  const factKey = input.hasher.digestHex(JSON.stringify({ subject, predicate, object, relationId: input.relationId, index: input.index })).slice(0, 20);
  return {
    subject,
    predicate,
    object: object || predicate,
    sourceNodeId: `local:evidence:subject:${factKey}`,
    targetNodeId: `local:evidence:object:${factKey}`,
    relationId: input.relationId,
    forceClass: "direct_evidence",
    score: 0.86,
    activation: 0.86,
    overlap: 0.86,
    support: Math.max(0.42, mean(input.evidence.map(span => span.alpha))),
    sourceVersionId,
    evidenceIds,
    roleId: input.relationId,
    relationRoleId: input.relationId,
    questionSlotImportance: input.index === 0 ? "core" : "secondary",
    questionSlotScore: Math.max(0.42, 0.9 - input.index * 0.08),
    questionSlotReasonIds: [input.relationId]
  };
}

function localEvidenceSemanticFactKey(fact: Pick<SemanticAnswerConstructFact, "subject" | "predicate" | "object" | "relationId">): string {
  return [fact.subject, fact.predicate, fact.object, fact.relationId]
    .map(part => collapsePriorWhitespace(part.normalize("NFKC").toLocaleLowerCase()))
    .join("\u0001");
}

function localEvidenceSelectedSubject(plan: LocalEvidenceAnswerPlan, requestText: string): string {
  const explicit = firstStringSlot(plan.slotSurfaces[LOCAL_ANSWER_SLOT_IDS.subject]);
  if (explicit) return explicit;
  const anchors = sourceEvidenceAnchorsForRequest(requestText);
  const mention = stringArrayFromSlot(plan.slotSurfaces[LOCAL_ANSWER_SLOT_IDS.sentence])
    .map(sentence => anchorMentionSurface(sentence, anchors))
    .find(Boolean);
  if (mention) return mention;
  const anchor = anchors.find(value => stringArrayFromSlot(plan.slotSurfaces[LOCAL_ANSWER_SLOT_IDS.sentence]).some(sentence => sourceSurfaceMatchesAnyAnchor(sentence, [value])));
  if (anchor) return anchor;
  const titled = plan.evidence.map(evidenceTitle).map(cleanSourceAnswerSurface).find(Boolean);
  if (titled) return titled;
  return cleanSourceAnswerSurface(requestText);
}

function localEvidenceRealizationSurface(plan: LocalEvidenceAnswerPlan, requestText: string, sentence: string): string {
  const clean = cleanSourceAnswerSurface(sentence);
  const anchors = sourceEvidenceAnchorsForRequest(requestText);
  if (!clean || !anchors.length) return clean;
  const exactTitle = plan.evidence.some(span => evidenceExactSourceAnchorMatches(span, anchors));
  if (exactTitle) return clean;
  const mention = anchorMentionSurface(clean, anchors);
  if (!mention) return clean;
  const mentionMass = splitPriorUnits(normalizePriorKey(mention)).length;
  const cleanMass = splitPriorUnits(normalizePriorKey(clean)).length;
  return mentionMass >= 2 && cleanMass > mentionMass + 4 ? mention : clean;
}

function boundedLocalQuoteSurface(surface: string, maxChars: number): string {
  const clean = stripLocalTerminalBoundary(cleanSourceAnswerSurface(surface)).replace(/"/gu, "'");
  if ([...clean].length <= maxChars) return clean;
  return `${[...clean].slice(0, Math.max(0, maxChars - 3)).join("").replace(/\s+\S*$/u, "").trimEnd()}...`;
}

function stripLocalTerminalBoundary(surface: string): string {
  const clean = cleanSourceAnswerSurface(surface);
  const chars = [...clean];
  const last = chars.at(-1) ?? "";
  return last === "." || last === "!" || last === "?" || last === "\u3002" || last === "\uff01" || last === "\uff1f"
    ? chars.slice(0, -1).join("").trimEnd()
    : clean;
}

function attachLearnedGraphPriorConstruct(input: {
  construct: ConstructGraph;
  requestText: string;
  graph: { nodes: readonly GraphNode[]; edges: readonly GraphEdge[] };
  field: TurnResult["field"];
  selectedEvidence: readonly EvidenceSpan[];
  brainMarker: JsonValue;
  hasher: { digestHex(input: string | Uint8Array): string };
}): ConstructGraph {
  const state = learnedGraphPriorConstructState(input);
  if (!state) {
    const nodeAnswer = graphNodeAnswerConstructState(input);
    if (nodeAnswer) {
      const nodeId = `construct:graph-node-answer:${input.hasher.digestHex(JSON.stringify(nodeAnswer.selectedNodes.map(node => node.nodeId))).slice(0, 20)}`;
      const nodes = input.construct.nodes.filter(node => node.kind !== "construct:graph_node_answer");
      const edges = input.construct.edges.filter(edge => edge.source !== nodeId && edge.target !== nodeId);
      return {
        ...input.construct,
        nodes: [
          ...nodes,
          {
            id: nodeId,
            kind: "construct:graph_node_answer",
            label: nodeAnswer.selectedSubject || "construct.graph_node_answer",
            metadata: toJsonValue(nodeAnswer)
          }
        ],
        edges: [
          ...edges,
          ...nodeAnswer.selectedNodes.map(row => ({ source: nodeId, target: row.nodeId, relation: "uses_prior_node", weight: row.score }))
        ]
      };
    }
    const insufficient = insufficientSupportConstructState(input);
    if (!insufficient) return input.construct;
    const nodeId = `construct:insufficient-support:${input.hasher.digestHex(JSON.stringify(insufficient.relevanceGate)).slice(0, 20)}`;
    const nodes = input.construct.nodes.filter(node => node.kind !== "construct:insufficient_support");
    const edges = input.construct.edges.filter(edge => edge.source !== nodeId && edge.target !== nodeId);
    return {
      ...input.construct,
      nodes: [
        ...nodes,
        {
          id: nodeId,
          kind: "construct:insufficient_support",
          label: insufficient.selectedMainSubject || "construct.insufficient_support",
          metadata: toJsonValue(insufficient)
        }
      ],
      edges
    };
  }
  const nodeId = `construct:semantic-answer:${input.hasher.digestHex(JSON.stringify(state.supportIds)).slice(0, 20)}`;
  const nodes = input.construct.nodes.filter(node => node.kind !== "construct:semantic_answer");
  const edges = input.construct.edges.filter(edge => edge.source !== nodeId && edge.target !== nodeId);
  return {
    ...input.construct,
    nodes: [
      ...nodes,
      {
        id: nodeId,
        kind: "construct:semantic_answer",
        label: state.selectedSubject || "construct.semantic_answer",
        metadata: toJsonValue(state)
      }
    ],
    edges: [
      ...edges,
      ...state.selectedFacts.flatMap(fact => [
        { source: nodeId, target: fact.sourceNodeId, relation: "uses_prior_subject", weight: fact.support },
        { source: nodeId, target: fact.targetNodeId, relation: "uses_prior_object", weight: fact.support }
      ])
    ]
  };
}

function attachRuntimeDiagnosticConstruct(input: {
  construct: ConstructGraph;
  enabled: boolean;
  requestText: string;
  brainMarker: JsonValue;
  hasher: { digestHex(input: string | Uint8Array): string };
  locale?: string;
}): ConstructGraph {
  if (!input.enabled) return input.construct;
  const marker = jsonRecord(input.brainMarker);
  const graphPriorCount = kernelNumber(marker.importedGraphPriorCount);
  const languagePriorCount = kernelNumber(marker.importedLanguagePriorCount);
  const programPriorCount = kernelNumber(marker.importedProgramPriorCount);
  const nodeId = `construct:runtime-diagnostic:${input.hasher.digestHex(input.requestText).slice(0, 20)}`;
  const answerSurface = runtimeDiagnosticAnswerSurface({ graphPriorCount, languagePriorCount, programPriorCount });
  return {
    ...input.construct,
    nodes: [
      ...input.construct.nodes.filter(node => node.kind !== "construct:runtime_diagnostic"),
      {
        id: nodeId,
        kind: "construct:runtime_diagnostic",
        label: "construct.runtime_diagnostic",
        metadata: toJsonValue({
          schema: "scce.runtime_diagnostic_construct.v1",
          answerSurface,
          forceId: "output.force.import_bound",
          priorCounts: {
            graphPriorCount,
            languagePriorCount,
            programPriorCount
          },
          runtimeBoundary: "learned_priors_are_speakable_not_certifying",
          requestedCorrection: "do_not_bind_system_questions_to_world_graph_subjects"
        })
      }
    ],
    edges: [
      ...input.construct.edges,
      { source: nodeId, target: input.construct.nodes[0]?.id ?? "request", relation: "explains_runtime_boundary", weight: 0.86 }
    ]
  };
}

function explicitRuntimeDiagnosticRequest(metadata: JsonValue | undefined): boolean {
  const record = jsonRecord(metadata);
  const control = jsonRecord(record.control);
  return record.runtimeDiagnostic === true || control.runtimeDiagnostic === true;
}

function previousDialogueStateFromMetadata(metadata: JsonValue | undefined): DialogueState | undefined {
  const record = jsonRecord(metadata);
  const dialogue = jsonRecord(record.dialogue);
  const state = jsonRecord(dialogue.previousState ?? record.previousDialogueState);
  const profile = jsonRecord(state.userStyleProfile);
  if (
    typeof state.conversationId !== "string"
    || typeof state.turnId !== "string"
    || typeof state.currentIntentId !== "string"
    || !Array.isArray(state.unresolvedSlots)
    || !Array.isArray(state.establishedFacts)
    || !Array.isArray(state.rejectedAssumptions)
    || !Array.isArray(state.interactionFeatures)
    || !Array.isArray(state.interactionSignals)
    || !Array.isArray(state.continuityLinks)
    || profile.schema !== "scce.dialogue.policy_profile.v1"
  ) return undefined;
  return state as unknown as DialogueState;
}

function runtimeDiagnosticAnswerSurface(input: { graphPriorCount: number; languagePriorCount: number; programPriorCount: number }): string {
  void input;
  const parts = ["SCCE/Yopp is a local runtime"];
  parts.push("I answer by routing the turn through the kernel, graph memory, and mouth surface");
  parts.push("I can use source evidence when it is available and reason from learned structure when it is not");
  return parts.map(part => part.trim()).filter(Boolean).join(". ") + ".";
}

function runtimeDiagnosticCounts(value: JsonValue): { graphPriorCount: number; languagePriorCount: number; programPriorCount: number } {
  const marker = jsonRecord(value);
  return {
    graphPriorCount: kernelNumber(marker.importedGraphPriorCount),
    languagePriorCount: kernelNumber(marker.importedLanguagePriorCount),
    programPriorCount: kernelNumber(marker.importedProgramPriorCount)
  };
}

function learnedGraphPriorConstructState(input: {
  requestText: string;
  graph: { nodes: readonly GraphNode[]; edges: readonly GraphEdge[] };
  field: TurnResult["field"];
  selectedEvidence: readonly EvidenceSpan[];
  brainMarker: JsonValue;
  hasher: { digestHex(input: string | Uint8Array): string };
}): SemanticAnswerConstructState | undefined {
  const marker = jsonRecord(input.brainMarker);
  const activeBrainVersion = kernelString(marker.activeBrainVersion) ?? (input.selectedEvidence.length ? "runtime.direct_evidence" : "");
  if (!activeBrainVersion) return undefined;
  const learnedPriorCount =
    kernelNumber(marker.importedLearnedPriorCount) +
    kernelNumber(marker.importedGraphPriorCount) +
    kernelNumber(marker.importedLanguagePriorCount) +
    kernelNumber(marker.importedProgramPriorCount);
  if (learnedPriorCount <= 0 && input.selectedEvidence.length <= 0) return undefined;
  const ranked = rankedLearnedGraphPriorFacts(input);
  const cognitiveFabric = cognitiveFabricFromFacts(ranked, input.requestText);
  const initialAlphaPlan = createAlphaRhetoricalPlan({
    ranked,
    requestText: input.requestText,
    field: input.field,
    hasher: input.hasher
  });
  const preliminarySlotSelection = questionSlotSelectionForPriorFacts({
    ranked,
    requestText: input.requestText,
    selectedSubject: initialAlphaPlan?.selectedSubject || cognitiveTopicForRequest(input.requestText),
    alphaPlan: initialAlphaPlan
  });
  const gate = relevanceGateFor({
    requestText: input.requestText,
    ranked,
    cognitiveFabric,
    questionSlotPlan: preliminarySlotSelection?.plan,
    alphaPlan: initialAlphaPlan,
    field: input.field,
    brainMarker: marker,
    selectedEvidence: input.selectedEvidence,
    hasher: input.hasher
  });
  if (!relevanceGateCanSpeakPriorAnswer(gate)) return undefined;
  const gateSelectedSubject = gate.candidateSubjectMatches[0]?.label || cognitiveTopicForRequest(input.requestText);
  const selectedSubject = gateSelectedSubject || initialAlphaPlan?.selectedSubject || "";
  const initialAlphaPlanUsable = Boolean(initialAlphaPlan && semanticAnswerSubjectAllowed(input.requestText, initialAlphaPlan.selectedSubject, gate) && (!gateSelectedSubject || samePriorEntity(initialAlphaPlan.selectedSubject, gateSelectedSubject)));
  const alphaPlan = initialAlphaPlanUsable ? initialAlphaPlan : createFallbackAlphaRhetoricalPlan({
    ranked,
    selectedSubject,
    requestText: input.requestText,
    field: input.field,
    hasher: input.hasher
  }) ?? createMinimalAlphaRhetoricalPlan({
    ranked,
    selectedSubject,
    cognitiveFabric
  });
  if (!alphaPlan) return undefined;
  if (!semanticAnswerSubjectAllowed(input.requestText, alphaPlan.selectedSubject, gate)) return undefined;
  const factByKey = new Map(ranked.map(fact => [semanticFactKey(fact), fact]));
  const slotSelection = questionSlotSelectionForPriorFacts({
    ranked,
    requestText: input.requestText,
    selectedSubject: alphaPlan.selectedSubject,
    alphaPlan
  });
  if (!slotSelection) return undefined;
  const { plan: questionSlotPlan, topicFacts, assignmentByFactKey } = slotSelection;
  if (!questionSlotPlanAllowsPriorAnswer(questionSlotPlan, gate)) return undefined;
  const slotAssignmentByFactKey = new Map<string, QuestionSlotAssignment>();
  const orderedSlotAssignments = [...questionSlotPlan.selectedAnswerCore, ...questionSlotPlan.selectedContext];
  if (!orderedSlotAssignments.length) return undefined;
  orderedSlotAssignments.forEach((assignment, index) => {
    const existing = slotAssignmentByFactKey.get(assignment.factKey);
    if (!existing || assignment.score > existing.score || index < orderedSlotAssignments.findIndex(row => row.factKey === existing.factKey)) slotAssignmentByFactKey.set(assignment.factKey, assignment);
  });
  const slotOrder = new Map(orderedSlotAssignments.map((assignment, index) => [assignment.factKey, index]));
  const facts = uniqueLearnedFacts(orderedSlotAssignments
    .map(assignment => factByKey.get(assignment.factKey))
    .filter((fact): fact is LearnedGraphPriorFact => Boolean(fact)))
    .sort((left, right) => (slotOrder.get(semanticFactKey(left)) ?? 999) - (slotOrder.get(semanticFactKey(right)) ?? 999))
    .slice(0, 10);
  if (!facts.length) return undefined;
  const answerSlots = semanticAnswerSlots(facts, input.hasher);
  const selectedRelations = uniqueKernelStrings(facts.map(fact => fact.relationId));
  const certifyingEvidenceIds = uniqueKernelStrings([
    ...input.selectedEvidence.map(span => String(span.id)),
    ...facts.filter(fact => fact.forceClass === "direct_evidence").flatMap(fact => fact.evidenceIds)
  ]);
  const selectedSourceVersionIds = uniqueKernelStrings([
    ...input.selectedEvidence.map(span => String(span.sourceVersionId)),
    ...facts.map(fact => fact.sourceVersionId ?? "")
  ]);
  const activatedNeighborhood = facts
    .slice()
    .sort((left, right) => right.activation - left.activation || right.score - left.score)
    .slice(0, 12);
  const selectedKeys = new Set(facts.map(semanticFactKey));
  const rejectedCandidates = ranked
    .filter(fact => !selectedKeys.has(semanticFactKey(fact)))
    .slice(0, 16)
    .map(fact => ({
      relationId: fact.relationId,
      sourceNodeId: fact.sourceNodeId,
      targetNodeId: fact.targetNodeId,
      reasonId: "semantic_answer.selection.outside_neighborhood",
      score: fact.score
    }));
  return {
    schema: "scce.semantic_answer_construct.v1",
    questionShapeId: semanticQuestionShapeId(facts, input.requestText, input.hasher, alphaPlan),
    selectedSubject: alphaPlan?.selectedSubject || facts[0]?.subject || "",
    selectedFacts: facts.map(fact => ({
      subject: fact.subject,
      predicate: fact.predicate,
      object: fact.object,
      sourceNodeId: fact.sourceNodeId,
      targetNodeId: fact.targetNodeId,
      relationId: fact.relationId,
      forceClass: fact.forceClass,
      score: fact.score,
      activation: fact.activation,
      overlap: fact.overlap,
      support: fact.support,
      sourceVersionId: fact.sourceVersionId,
      evidenceIds: fact.evidenceIds,
      roleId: assignmentByFactKey.get(semanticFactKey(fact))?.roleId,
      alphaRhetoricalCentrality: assignmentByFactKey.get(semanticFactKey(fact))?.arc,
      pathScore: assignmentByFactKey.get(semanticFactKey(fact))?.pathScore,
      roleScore: assignmentByFactKey.get(semanticFactKey(fact))?.roleScore,
      bridgeValue: assignmentByFactKey.get(semanticFactKey(fact))?.bridgeValue,
      backgroundPenalty: assignmentByFactKey.get(semanticFactKey(fact))?.backgroundPenalty,
      forceMeaning: assignmentByFactKey.get(semanticFactKey(fact))?.forceMeaning,
      certificationPower: assignmentByFactKey.get(semanticFactKey(fact))?.certificationPower,
      semanticQuality: fact.graphQuality.semanticQuality,
      graphQualityClassId: fact.graphQuality.classId,
      answerGrade: factQuestionFitAllowsSurface(fact),
      cognitiveEdgeId: fact.cognitiveEdge.id,
      requestedSlotId: fact.questionEdgeFit.requestedSlotId,
      relationRoleId: fact.questionEdgeFit.relationRoleId,
      topicSenseId: fact.questionEdgeFit.topicSenseId,
      finalQuestionFit: fact.questionEdgeFit.finalQuestionFit,
      questionSlotId: slotAssignmentByFactKey.get(semanticFactKey(fact))?.slotId,
      questionSlotImportance: slotAssignmentByFactKey.get(semanticFactKey(fact))?.importance,
      questionSlotScore: slotAssignmentByFactKey.get(semanticFactKey(fact))?.score,
      questionSlotReasonIds: slotAssignmentByFactKey.get(semanticFactKey(fact))?.reasonIds
    })),
    answerSlots,
    selectedRelations,
    activatedNeighborhood: activatedNeighborhood.map(fact => ({
      subject: fact.subject,
      predicate: fact.predicate,
      object: fact.object,
      sourceNodeId: fact.sourceNodeId,
      targetNodeId: fact.targetNodeId,
      relationId: fact.relationId,
      forceClass: fact.forceClass,
      score: fact.score,
      activation: fact.activation,
      overlap: fact.overlap,
      support: fact.support,
      sourceVersionId: fact.sourceVersionId,
      evidenceIds: fact.evidenceIds,
      roleId: assignmentByFactKey.get(semanticFactKey(fact))?.roleId,
      alphaRhetoricalCentrality: assignmentByFactKey.get(semanticFactKey(fact))?.arc,
      pathScore: assignmentByFactKey.get(semanticFactKey(fact))?.pathScore,
      roleScore: assignmentByFactKey.get(semanticFactKey(fact))?.roleScore,
      bridgeValue: assignmentByFactKey.get(semanticFactKey(fact))?.bridgeValue,
      backgroundPenalty: assignmentByFactKey.get(semanticFactKey(fact))?.backgroundPenalty,
      forceMeaning: assignmentByFactKey.get(semanticFactKey(fact))?.forceMeaning,
      certificationPower: assignmentByFactKey.get(semanticFactKey(fact))?.certificationPower,
      semanticQuality: fact.graphQuality.semanticQuality,
      graphQualityClassId: fact.graphQuality.classId,
      answerGrade: factQuestionFitAllowsSurface(fact),
      cognitiveEdgeId: fact.cognitiveEdge.id,
      requestedSlotId: fact.questionEdgeFit.requestedSlotId,
      relationRoleId: fact.questionEdgeFit.relationRoleId,
      topicSenseId: fact.questionEdgeFit.topicSenseId,
      finalQuestionFit: fact.questionEdgeFit.finalQuestionFit,
      questionSlotId: slotAssignmentByFactKey.get(semanticFactKey(fact))?.slotId,
      questionSlotImportance: slotAssignmentByFactKey.get(semanticFactKey(fact))?.importance,
      questionSlotScore: slotAssignmentByFactKey.get(semanticFactKey(fact))?.score,
      questionSlotReasonIds: slotAssignmentByFactKey.get(semanticFactKey(fact))?.reasonIds
    })),
    rejectedCandidates,
    supportIds: uniqueKernelStrings(facts.flatMap(fact => [fact.sourceNodeId, fact.targetNodeId, fact.relationId, fact.sourceVersionId ?? "", ...fact.evidenceIds])),
    forceId: "output.force.learned_concept_prior_answer",
    boundaryId: "output.force.import_bound",
    activeBrainVersion,
    activeImportRunIds: kernelStringArray(marker.activeImportRunIds),
    relevanceGate: gate,
    cognitiveFabric,
    questionSlotPlan,
    explanatoryAnswerContract: explanatoryAnswerContractFor({ requestText: input.requestText, gate, alphaPlan, facts, cognitiveFabric, questionSlotPlan, hasher: input.hasher }),
    alphaRhetoricalPlan: alphaPlan,
    certificationBoundary: {
      directEvidenceCount: input.selectedEvidence.length,
      evidenceSpanIds: certifyingEvidenceIds,
      sourceVersionIds: selectedSourceVersionIds,
      externalFactCertification: certifyingEvidenceIds.length > 0
    }
  };
}

function relevanceGateCanSpeakPriorAnswer(gate: RelevanceGate): boolean {
  return gate.decision === QUESTION_EDGE_DECISION_IDS.directEvidence ||
    gate.decision === QUESTION_EDGE_DECISION_IDS.requestedSupport ||
    gate.decision === QUESTION_EDGE_DECISION_IDS.partialSupport;
}

function createMinimalAlphaRhetoricalPlan(input: {
  ranked: readonly LearnedGraphPriorFact[];
  selectedSubject: string;
  cognitiveFabric: QuestionCognitiveFabric;
}): AlphaRhetoricalPlan | undefined {
  const subject = input.selectedSubject.trim();
  if (!subject) return undefined;
  const subjectFacts = input.ranked.filter(fact => factTopicMatchesSelected(fact, subject)).slice(0, 12);
  if (!subjectFacts.length) return undefined;
  return {
    schema: "scce.alpha_rhetorical_plan.v1",
    plannerId: "walsh.alpha_rhetorical_centrality",
    selectedSubject: subject,
    selectedSubjectNodeIds: uniqueKernelStrings(subjectFacts.filter(fact => factSubjectMatchesSelected(fact, subject)).map(fact => fact.sourceNodeId)),
    requiredRoleIds: [],
    optionalRoleIds: [],
    selectedRoleIds: uniqueKernelStrings(subjectFacts.map(fact => rhetoricalRoleFromRelationRoleId(fact.questionEdgeFit.relationRoleId))),
    backgroundRoleIds: [],
    assignments: [],
    selectedFactKeys: subjectFacts.map(semanticFactKey),
    backgroundFactKeys: [],
    planEnergy: kernelClamp01(1 - input.cognitiveFabric.supportMass),
    explanationCompleteness: input.cognitiveFabric.supportMass,
    targetSentenceCount: Math.max(2, Math.min(4, subjectFacts.length)),
    proofBoundaryId: "output.force.import_bound",
    audit: toJsonValue({ fallback: "minimal_cognitive_fabric", selectedFitCount: input.cognitiveFabric.selectedFits.length })
  };
}

function createFallbackAlphaRhetoricalPlan(input: {
  ranked: readonly LearnedGraphPriorFact[];
  selectedSubject: string;
  requestText: string;
  field: TurnResult["field"];
  hasher: { digestHex(input: string | Uint8Array): string };
}): AlphaRhetoricalPlan | undefined {
  const subject = input.selectedSubject.trim();
  if (!subject) return undefined;
  const anchors = priorRequestAnchors(input.requestText);
  const subjectFacts = input.ranked.filter(fact => factTopicMatchesSelected(fact, subject)).slice(0, 96);
  if (!subjectFacts.length) return undefined;
  const bridgeAnchors = specificPriorBridgeAnchors(subjectFacts);
  const contradictionPressure = kernelClamp01(input.field.alphaTrace.surfaces.contradiction * 0.58 + input.field.alphaTrace.contradictionMass * 0.42);
  const assignmentCandidates = subjectFacts
    .map(fact => alphaRhetoricalAssignment({ fact, subject, anchors, bridgeAnchors, contradictionPressure, hasher: input.hasher }))
    .sort((left, right) => right.arc - left.arc || right.pathScore - left.pathScore || left.factKey.localeCompare(right.factKey));
  const assignments = assignmentCandidates.filter(assignment => assignment.arc > 0.0001 || assignment.pathScore > 0.18);
  const fallbackAssignments = assignments.length ? assignments : assignmentCandidates.slice(0, 12);
  if (!fallbackAssignments.length) return undefined;
  const selected = selectAlphaRhetoricalAssignments(fallbackAssignments);
  const selectedKeys = new Set(selected.map(assignment => assignment.factKey));
  const allAssignments = fallbackAssignments.map(assignment => ({
    ...assignment,
    selected: selectedKeys.has(assignment.factKey),
    shouldSurface: selectedKeys.has(assignment.factKey) && assignment.shouldSurface
  }));
  const selectedRoleIds = uniqueKernelStrings(selected.map(assignment => assignment.roleId));
  const requiredRoleIds = [...ANSWER_ROLE_GROUPS.required];
  const bridgeCoverage = selectedRoleIds.some(isBridgeAnswerRoleId) ? 1 : 0;
  const supportMass = mean(selected.map(assignment => assignment.arc || assignment.pathScore));
  const missingRequired = requiredRoleIds.filter(roleId => !selectedRoleIds.includes(roleId)).length;
  const targetSentenceCount = alphaRhetoricalTargetSentenceCount({ selected, bridgeCoverage, supportMass, missingRequired });
  return {
    schema: "scce.alpha_rhetorical_plan.v1",
    plannerId: "walsh.alpha_rhetorical_centrality",
    selectedSubject: subject,
    selectedSubjectNodeIds: uniqueKernelStrings(subjectFacts.filter(fact => factSubjectMatchesSelected(fact, subject)).map(fact => fact.sourceNodeId)),
    requiredRoleIds,
    optionalRoleIds: [...ANSWER_ROLE_GROUPS.optional],
    selectedRoleIds,
    backgroundRoleIds: [...ANSWER_ROLE_GROUPS.background],
    assignments: allAssignments.slice(0, 64),
    selectedFactKeys: selected.map(assignment => assignment.factKey),
    backgroundFactKeys: selected.filter(assignment => isBackgroundAnswerRoleId(assignment.roleId)).map(assignment => assignment.factKey),
    planEnergy: kernelClamp01(missingRequired * 0.18 + Math.max(0, 0.42 - supportMass) - bridgeCoverage * 0.08),
    explanationCompleteness: kernelClamp01(0.34 * (1 - missingRequired / requiredRoleIds.length) + 0.24 * bridgeCoverage + 0.24 * supportMass + 0.18 * Math.min(1, selected.length / 4)),
    targetSentenceCount,
    proofBoundaryId: "output.force.import_bound",
    audit: toJsonValue({
      inputFactCount: input.ranked.length,
      assignmentCount: allAssignments.length,
      contradictionPressure,
      supportMass,
      bridgeCoverage,
      missingRequired,
      selectedRoleIds,
      fallback: true
    })
  };
}

function selectedSubjectCategoryLabelFact(fact: LearnedGraphPriorFact, alphaPlan: AlphaRhetoricalPlan): boolean {
  if (fact.graphQuality.classId !== GRAPH_QUALITY_CLASS_IDS.catalogNavigation) return false;
  if (!alphaPlan.selectedSubjectNodeIds.includes(fact.sourceNodeId)) return false;
  return fact.questionEdgeFit.relationRoleId === RELATION_ROLE_IDS.graphRequestMembership ||
    fact.questionEdgeFit.relationRoleId === RELATION_ROLE_IDS.graphCompoundMembership ||
    fact.questionEdgeFit.relationRoleId === RELATION_ROLE_IDS.graphNavigation;
}

function questionSlotSelectionForPriorFacts(input: {
  ranked: readonly LearnedGraphPriorFact[];
  requestText: string;
  selectedSubject: string;
  alphaPlan?: AlphaRhetoricalPlan;
}): { plan: QuestionSlotPlan; topicFacts: LearnedGraphPriorFact[]; assignmentByFactKey: Map<string, AlphaRhetoricalAssignment> } | undefined {
  const selectedSubject = input.selectedSubject.trim();
  if (!selectedSubject) return undefined;
  const assignmentByFactKey = new Map((input.alphaPlan?.assignments ?? []).map(assignment => [assignment.factKey, assignment]));
  const topicFacts = input.ranked
    .filter(fact => factTopicMatchesSelected(fact, selectedSubject))
    .filter(fact => !input.alphaPlan || !selectedSubjectCategoryLabelFact(fact, input.alphaPlan))
    .filter(fact => factQuestionFitAllowsSurface(fact) || topicCompoundMembershipAnswerFact(fact))
    .filter(fact => questionShapeAllowsPriorFact(fact, input.requestText) || topicCompoundMembershipAnswerFact(fact));
  const plan = planQuestionSlots({
    questionText: input.requestText,
    selectedTopic: selectedSubject,
    facts: topicFacts
      .slice(0, 160)
      .map(fact => {
        const key = semanticFactKey(fact);
        const assignment = assignmentByFactKey.get(key);
        return {
          factKey: key,
          subject: fact.subject,
          predicate: fact.predicate,
          object: fact.object,
          relationId: fact.relationId,
          forceClass: fact.forceClass,
          score: fact.score,
          support: fact.support,
          alphaSupport: fact.activation,
          ppfSupport: fact.ppfMass,
          semanticQuality: fact.graphQuality.semanticQuality,
          graphQualityClassId: fact.graphQuality.classId,
          answerGrade: fact.graphQuality.answerGrade,
          requestedSlotId: fact.questionEdgeFit.requestedSlotId,
          relationRoleId: fact.questionEdgeFit.relationRoleId,
          topicSenseId: fact.questionEdgeFit.topicSenseId,
          finalQuestionFit: fact.questionEdgeFit.finalQuestionFit,
          upstreamRoleId: assignment?.roleId,
          alphaRhetoricalCentrality: assignment?.arc
        };
      })
  });
  return { plan, topicFacts, assignmentByFactKey };
}

function questionSlotPlanAllowsPriorAnswer(plan: QuestionSlotPlan, gate: RelevanceGate): boolean {
  if (!plan.selectedAnswerCore.length) return false;
  return gate.decision === QUESTION_EDGE_DECISION_IDS.directEvidence ||
    gate.decision === QUESTION_EDGE_DECISION_IDS.requestedSupport ||
    gate.decision === QUESTION_EDGE_DECISION_IDS.partialSupport;
}

function topicCompoundMembershipAnswerFact(fact: LearnedGraphPriorFact): boolean {
  if (fact.questionEdgeFit.relationRoleId !== RELATION_ROLE_IDS.graphRequestMembership) return false;
  if (samePriorEntity(fact.subject, fact.object)) return false;
  const objectMass = semanticPriorSurfaceMass(fact.object);
  return objectMass > 0 && objectMass <= 5 && fact.questionEdgeFit.finalQuestionFit >= 0.3;
}

function fallbackQuestionSlotAssignments(facts: readonly LearnedGraphPriorFact[], requestText: string): QuestionSlotAssignment[] {
  const anchors = priorRequestAnchors(requestText);
  const selected = uniqueLearnedFacts([
    ...facts.filter(topicCompoundMembershipAnswerFact),
    ...expandGraphPriorAnswerNeighborhood({
      ranked: facts,
      prioritized: prioritizeGraphPriorFacts(facts, requestText),
      requestText
    })
  ])
    .filter(fact => factCompletenessScore(fact, anchors) > 0.08 || topicCompoundMembershipAnswerFact(fact))
    .sort((left, right) =>
      Number(topicCompoundMembershipAnswerFact(right)) - Number(topicCompoundMembershipAnswerFact(left)) ||
      factCompletenessScore(right, anchors) - factCompletenessScore(left, anchors) ||
      right.score - left.score ||
      right.support - left.support
    )
    .slice(0, 10);
  return selected.map((fact, index): QuestionSlotAssignment => ({
    factKey: semanticFactKey(fact),
    slotId: topicCompoundMembershipAnswerFact(fact) ? ANSWER_SLOT_IDS.memberRelation : fact.questionEdgeFit.requestedSlotId || ANSWER_SLOT_IDS.knownForContribution,
    importance: "core",
    score: kernelClamp01(0.44 + factCompletenessScore(fact, anchors) * 0.28 + fact.questionEdgeFit.finalQuestionFit * 0.28),
    reasonIds: ["qr.qr.d20a6b4e"],
    topicSenseId: fact.questionEdgeFit.topicSenseId || `topic_sense.${index}`
  }));
}

function cognitiveFabricSlotAssignments(facts: readonly LearnedGraphPriorFact[], fabric: QuestionCognitiveFabric): QuestionSlotAssignment[] {
  const selectedFitIds = new Set(fabric.selectedFits.map(fit => fit.cognitiveEdgeId));
  const selected = facts
    .filter(fact => selectedFitIds.has(fact.cognitiveEdge.id))
    .sort((left, right) =>
      right.questionEdgeFit.finalQuestionFit - left.questionEdgeFit.finalQuestionFit ||
      right.score - left.score ||
      right.support - left.support
    )
    .slice(0, 8);
  return selected.map((fact, index): QuestionSlotAssignment => ({
    factKey: semanticFactKey(fact),
    slotId: fact.questionEdgeFit.requestedSlotId || ANSWER_SLOT_IDS.knownForContribution,
    importance: "core",
    score: kernelClamp01(0.42 + fact.questionEdgeFit.finalQuestionFit * 0.42 + fact.support * 0.16),
    reasonIds: ["qr.qr.0a59c3f8"],
    topicSenseId: fact.questionEdgeFit.topicSenseId || `topic_sense.fabric.${index}`
  }));
}

function rhetoricalRoleFromRelationRoleId(value: string): string {
  if (value === RELATION_ROLE_IDS.graphCompactAttribute) return ANSWER_ROLE_IDS.identity;
  if (value === RELATION_ROLE_IDS.graphRequestRelation || value === RELATION_ROLE_IDS.graphExplanatoryPath || value === RELATION_ROLE_IDS.graphRequestMembership) return ANSWER_ROLE_IDS.contribution;
  if (value === RELATION_ROLE_IDS.graphContextRelation || value === RELATION_ROLE_IDS.graphContextBridge || value === RELATION_ROLE_IDS.graphCompoundAttribute || value === RELATION_ROLE_IDS.graphCompoundMembership) return ANSWER_ROLE_IDS.context;
  return ANSWER_ROLE_IDS.field;
}

function rankedLearnedGraphPriorFacts(input: {
  requestText: string;
  graph: { nodes: readonly GraphNode[]; edges: readonly GraphEdge[] };
  field: TurnResult["field"];
}): LearnedGraphPriorFact[] {
  const requestFeatures = featureSet(input.requestText, 512);
  const unitSpecificity = requestUnitSpecificity(input.graph.nodes, new Set(requestFeatures));
  const primaryUnits = primarySpecificRequestUnits(unitSpecificity);
  const requestAnchors = priorRequestAnchors(input.requestText);
  const selectedTopic = cognitiveTopicForRequest(input.requestText);
  const nodeById = new Map(input.graph.nodes.map(node => [String(node.id), node]));
  const activationByNodeId = new Map(input.field.active.map(row => [String(row.nodeId), row.activation]));
  const ppfMassByNodeId = new Map(input.field.ppf.map(row => [String(row.nodeId), row.mass]));
  const facts: LearnedGraphPriorFact[] = [];
  for (const edge of input.graph.edges) {
    const sourceNode = nodeById.get(String(edge.source));
    const targetNode = nodeById.get(String(edge.target));
    const edgeClass = graphEdgePriorClass(edge);
    const sourceClass = sourceNode ? graphNodePriorClass(sourceNode) : "none";
    const targetClass = targetNode ? graphNodePriorClass(targetNode) : "none";
    const edgeEvidenceIds = edge.evidenceIds.map(String);
    const learnedPriorClass = isLearnedPriorClass(edgeClass) ? edgeClass : isLearnedPriorClass(sourceClass) ? sourceClass : isLearnedPriorClass(targetClass) ? targetClass : "";
    const forceClass = learnedPriorClass || (edgeEvidenceIds.length ? "direct_evidence" : "");
    if (!forceClass) continue;
    if (forceClass !== "learned_concept_prior" && forceClass !== "direct_evidence") continue;
    const metadata = jsonRecord(edge.metadata);
    const sourceMetadata = jsonRecord(sourceNode?.metadata);
    const targetMetadata = jsonRecord(targetNode?.metadata);
    const relation = jsonRecord(metadata.relation);
    const rawSubject = cleanPriorTerm(kernelString(relation.subject) || graphNodeSurface(sourceNode));
    const rawPredicate = cleanPriorTerm(kernelString(relation.predicate) || String(edge.relationId));
    const rawObject = cleanPriorTerm(kernelString(relation.object) || graphNodeSurface(targetNode));
    if (!rawSubject.text || !rawPredicate.text || !rawObject.text) continue;
    if (priorSurfaceLooksStructuralDebris(rawSubject.text) || priorSurfaceLooksStructuralDebris(rawObject.text)) continue;
    if (rawSubject.markerId === "question" || rawSubject.markerId === "object") continue;
    if (rawObject.markerId === "question") continue;
    if (rawSubject.text === rawObject.text) continue;
    const subject = displayPriorTerm(rawSubject.text, "subject");
    const predicate = rawPredicate.text.toLocaleLowerCase();
    const object = displayPriorTerm(rawObject.text, "object");
    if (primaryUnits.length && !graphPriorFactMatchesPrimaryUnit({ subject, predicate, object, sourceNode, targetNode, primaryUnits })) continue;
    const graphQuality = scoreGraphEdgeQuality({
      edgeId: String(edge.id),
      relationId: String(edge.relationId),
      subject,
      predicate,
      object,
      weight: edge.weight,
      alpha: edge.alpha,
      forceClass,
      sourceShardSupport: kernelNumber(relation.confidence, edge.weight)
    });
    if (!priorFactAdmissibleForAnswer(subject, predicate, object, requestAnchors) && graphQuality.semanticQuality < 0.2) continue;
    const sourceActivation = activationByNodeId.get(String(edge.source)) ?? 0;
    const targetActivation = activationByNodeId.get(String(edge.target)) ?? 0;
    const activation = Math.max(sourceActivation, targetActivation);
    const ppfMass = Math.max(ppfMassByNodeId.get(String(edge.source)) ?? 0, ppfMassByNodeId.get(String(edge.target)) ?? 0);
    const support = Math.max(0, Math.min(1, kernelNumber(relation.confidence, edge.weight)));
    const cognitiveEdges = normalizeRawGraphEdgeToCognitiveEdges({
      rawEdgeId: String(edge.id),
      relationId: String(edge.relationId),
      subject,
      predicate,
      object,
      forceClass,
      semanticQuality: graphQuality.semanticQuality,
      graphQuality,
      alphaSupport: activation,
      ppfSupport: ppfMass,
      supportMass: support,
      selectedTopic,
      requestText: input.requestText
    });
    for (const cognitive of cognitiveEdges) {
      const factText = `${cognitive.cognitiveEdge.subjectRef} ${cognitive.cognitiveEdge.sourceDerivedLabels.predicate} ${cognitive.cognitiveEdge.objectRef}`;
      const overlap = weightedJaccard(requestFeatures, featureSet(factText, 512));
      const qualityMass = graphQuality.answerGrade || cognitive.fit.decision === QUESTION_EDGE_DECISION_IDS.requestedSupport
        ? Math.max(graphQuality.semanticQuality, cognitive.fit.finalQuestionFit)
        : Math.max(graphQuality.semanticQuality * 0.32, cognitive.fit.finalQuestionFit * 0.5);
      const score = (
        overlap * 0.24 +
        activation * 0.16 +
        ppfMass * 0.1 +
        support * 0.08 +
        graphQuality.semanticQuality * 0.12 +
        cognitive.fit.finalQuestionFit * 0.3
      ) * qualityMass;
      if (overlap <= 0 && activation <= 0.00001 && cognitive.fit.finalQuestionFit < 0.18) continue;
      facts.push({
        subject: cognitive.cognitiveEdge.subjectRef,
        predicate: cognitive.cognitiveEdge.sourceDerivedLabels.predicate.toLocaleLowerCase(),
        object: cognitive.cognitiveEdge.objectRef,
        sourceNodeId: String(edge.source),
        targetNodeId: String(edge.target),
        relationId: String(edge.relationId),
        forceClass,
        score,
        activation,
        overlap,
        support,
        sourceVersionId: kernelString(metadata.sourceVersionId) ?? kernelString(sourceMetadata.sourceVersionId) ?? kernelString(targetMetadata.sourceVersionId),
        evidenceIds: edgeEvidenceIds,
        ppfMass,
        sourceActivation,
        targetActivation,
        graphQuality,
        cognitiveEdge: cognitive.cognitiveEdge,
        questionEdgeFit: cognitive.fit
      });
    }
  }
  return uniqueLearnedFacts(facts)
    .sort((left, right) => right.score - left.score || right.support - left.support || left.subject.localeCompare(right.subject));
}

function graphPriorFactMatchesPrimaryUnit(input: {
  subject: string;
  predicate: string;
  object: string;
  sourceNode: GraphNode | undefined;
  targetNode: GraphNode | undefined;
  primaryUnits: readonly string[];
}): boolean {
  const surfaceUnits = new Set(splitPriorUnits(normalizePriorKey(`${input.subject} ${input.predicate} ${input.object}`)).filter(unit => unit.length >= 3));
  const featureUnits = new Set<string>();
  for (const node of [input.sourceNode, input.targetNode]) {
    for (const feature of node?.features ?? []) {
      if (feature.startsWith("sym:")) featureUnits.add(feature.slice(4));
    }
  }
  return input.primaryUnits.some(unit => surfaceUnits.has(unit) || featureUnits.has(unit));
}

function uniqueLearnedFacts(facts: readonly LearnedGraphPriorFact[]): LearnedGraphPriorFact[] {
  const byKey = new Map<string, LearnedGraphPriorFact>();
  for (const fact of facts) {
    const key = normalizePriorKey(`${fact.subject}:${fact.predicate}:${fact.object}:${fact.questionEdgeFit.requestedSlotId}:${fact.questionEdgeFit.relationRoleId}`);
    const existing = byKey.get(key);
    if (!existing || fact.score > existing.score) byKey.set(key, fact);
  }
  return [...byKey.values()];
}

function cognitiveFabricFromFacts(facts: readonly LearnedGraphPriorFact[], requestText: string): QuestionCognitiveFabric {
  return buildQuestionCognitiveFabric(facts.map(fact => ({ cognitiveEdge: fact.cognitiveEdge, fit: fact.questionEdgeFit })), requestText);
}

function factQuestionFitAllowsSurface(fact: LearnedGraphPriorFact): boolean {
  return fact.questionEdgeFit.decision === QUESTION_EDGE_DECISION_IDS.requestedSupport ||
    fact.questionEdgeFit.decision === QUESTION_EDGE_DECISION_IDS.partialSupport ||
    fact.questionEdgeFit.finalQuestionFit >= 0.44;
}

function cognitiveTopicForRequest(text: string): string {
  const named = namedSubjectAnchors(text);
  if (named.length) return named[0] ?? "";
  const focuses = relevanceRequestFocuses(text).filter(unit => !genericQuestionSignal(unit)).slice(0, 6);
  for (let length = Math.min(3, focuses.length); length >= 2; length--) {
    for (let index = 0; index <= focuses.length - length; index++) {
      const phrase = focuses.slice(index, index + length).join(" ");
      if (phrase.length >= 6) return phrase;
    }
  }
  return focuses[0] ?? "";
}

function insufficientSupportConstructState(input: {
  requestText: string;
  graph: { nodes: readonly GraphNode[]; edges: readonly GraphEdge[] };
  field: TurnResult["field"];
  selectedEvidence: readonly EvidenceSpan[];
  brainMarker: JsonValue;
  hasher: { digestHex(input: string | Uint8Array): string };
}): InsufficientSupportConstructState | undefined {
  if (input.selectedEvidence.length > 0) return undefined;
  const marker = jsonRecord(input.brainMarker);
  const activeBrainVersion = kernelString(marker.activeBrainVersion);
  if (!activeBrainVersion) return undefined;
  const ranked = rankedLearnedGraphPriorFacts(input);
  const cognitiveFabric = cognitiveFabricFromFacts(ranked, input.requestText);
  const alphaPlan = createAlphaRhetoricalPlan({ ranked, requestText: input.requestText, field: input.field, hasher: input.hasher });
  const slotSelection = questionSlotSelectionForPriorFacts({
    ranked,
    requestText: input.requestText,
    selectedSubject: alphaPlan?.selectedSubject || cognitiveTopicForRequest(input.requestText),
    alphaPlan
  });
  const gate = relevanceGateFor({
    requestText: input.requestText,
    ranked,
    cognitiveFabric,
    questionSlotPlan: slotSelection?.plan,
    alphaPlan,
    field: input.field,
    brainMarker: marker,
    selectedEvidence: input.selectedEvidence,
    hasher: input.hasher
  });
  const confidentSubjects = gate.candidateSubjectMatches.filter(row => row.affinity >= 0.18).map(row => row.label).slice(0, 6);
  const requestedFocuses = relevanceRequestFocuses(input.requestText);
  const contract = explanatoryAnswerContractFor({
    requestText: input.requestText,
    gate,
    alphaPlan,
    facts: [],
    cognitiveFabric,
    questionSlotPlan: slotSelection?.plan,
    hasher: input.hasher
  });
  return {
    schema: "scce.insufficient_support_construct.v1",
    questionShapeId: contract.questionShapeId,
    selectedMainSubject: confidentSubjects[0] ?? requestedFocuses[0] ?? "",
    requestedFocuses,
    closestSubjectCandidates: confidentSubjects,
    relevanceGate: gate,
    explanatoryAnswerContract: contract,
    activeBrainVersion,
    activeImportRunIds: kernelStringArray(marker.activeImportRunIds),
    certificationBoundary: {
      directEvidenceCount: input.selectedEvidence.length,
      externalFactCertification: false
    }
  };
}

function graphNodeAnswerConstructState(input: {
  requestText: string;
  graph: { nodes: readonly GraphNode[]; edges: readonly GraphEdge[] };
  field: TurnResult["field"];
  selectedEvidence: readonly EvidenceSpan[];
  brainMarker: JsonValue;
  hasher: { digestHex(input: string | Uint8Array): string };
}): GraphNodeAnswerConstructState | undefined {
  if (input.selectedEvidence.length > 0) return undefined;
  const marker = jsonRecord(input.brainMarker);
  const activeBrainVersion = kernelString(marker.activeBrainVersion);
  if (!activeBrainVersion) return undefined;
  const rows = rankedGraphNodeAnswerRows(input);
  if (!rows.length) return undefined;
  const requestedFocuses = relevanceRequestFocuses(input.requestText);
  const selected = rows.slice(0, Math.min(10, rows.length));
  const answerSurface = selected.map(row => row.surface).join("\n").trim();
  if (!answerSurface) return undefined;
  return {
    schema: "scce.graph_node_answer_construct.v1",
    questionShapeId: `question.shape.node:${input.hasher.digestHex(JSON.stringify({ requestedFocuses, nodes: selected.map(row => row.nodeId) })).slice(0, 16)}`,
    selectedSubject: selected[0]?.surface ?? requestedFocuses[0] ?? "",
    requestedFocuses,
    answerSurface,
    selectedNodes: selected,
    forceId: "output.force.learned_graph_node_answer",
    boundaryId: "output.force.import_bound",
    activeBrainVersion,
    activeImportRunIds: kernelStringArray(marker.activeImportRunIds),
    certificationBoundary: {
      directEvidenceCount: input.selectedEvidence.length,
      evidenceSpanIds: [],
      sourceVersionIds: [],
      externalFactCertification: false
    }
  };
}

function rankedGraphNodeAnswerRows(input: {
  requestText: string;
  graph: { nodes: readonly GraphNode[]; edges: readonly GraphEdge[] };
  field: TurnResult["field"];
}): GraphNodeAnswerRow[] {
  const requestFeatures = new Set(featureSet(input.requestText, 512));
  const requestFeatureList = [...requestFeatures];
  const requestAnchors = priorRequestAnchors(input.requestText);
  const unitSpecificity = requestUnitSpecificity(input.graph.nodes, requestFeatures);
  const primaryUnits = primarySpecificRequestUnits(unitSpecificity);
  const focusUnits = new Set(relevanceRequestFocuses(input.requestText).flatMap(focus => splitPriorUnits(normalizePriorKey(focus))).filter(unit => unit.length >= 3));
  const activationByNodeId = new Map(input.field.active.map(row => [String(row.nodeId), row.activation]));
  const ppfMassByNodeId = new Map(input.field.ppf.map(row => [String(row.nodeId), row.mass]));
  const rows: GraphNodeAnswerRow[] = [];
  for (const node of input.graph.nodes) {
    const forceClass = graphNodePriorClass(node);
    if (!isLearnedPriorClass(forceClass)) continue;
    const raw = cleanPriorTerm(graphNodeSurface(node));
    const surface = compactGraphNodeSurface(raw.text);
    if (!surface || priorSurfaceLooksStructuralDebris(surface)) continue;
    const normalized = normalizePriorKey(surface);
    const surfaceUnits = splitPriorUnits(normalized).filter(unit => unit.length >= 3);
    if (!surfaceUnits.length) continue;
    if (primaryUnits.length && !graphNodeMatchesPrimaryUnit(node, surfaceUnits, primaryUnits)) continue;
    const featureOverlap = nodeSpecificFeatureOverlap(node.features, unitSpecificity);
    const surfaceOverlap = weightedJaccard(requestFeatureList, featureSet(surface, 256));
    const surfaceSpecificity = surfaceSpecificityOverlap(surfaceUnits, unitSpecificity);
    const anchorScore = graphNodeAnchorScore(normalized, surfaceUnits, requestAnchors, focusUnits, unitSpecificity);
    const activation = activationByNodeId.get(String(node.id)) ?? 0;
    const ppfMass = ppfMassByNodeId.get(String(node.id)) ?? 0;
    const topologySupport = Math.max(activation, ppfMass);
    if (featureOverlap <= 0 && surfaceSpecificity <= 0 && surfaceOverlap <= 0 && anchorScore <= 0 && topologySupport <= 0.000001) continue;
    const alpha = kernelClamp01(node.alpha);
    const score = kernelClamp01(
      featureOverlap * 0.42 +
      Math.min(1, anchorScore / 8) * 0.2 +
      surfaceSpecificity * 0.16 +
      surfaceOverlap * 0.08 +
      activation * 0.1 +
      ppfMass * 0.08 +
      alpha * 0.06
    );
    if (score < 0.018 && anchorScore <= 0) continue;
    rows.push({
      nodeId: String(node.id),
      surface,
      score,
      alpha,
      activation,
      ppfMass,
      featureOverlap,
      surfaceOverlap,
      forceClass
    });
  }
  return uniqueGraphNodeAnswerRows(rows)
    .sort((left, right) =>
      right.score - left.score ||
      right.featureOverlap - left.featureOverlap ||
      right.surfaceOverlap - left.surfaceOverlap ||
      left.surface.localeCompare(right.surface)
    );
}

function requestUnitSpecificity(nodes: readonly GraphNode[], requestFeatures: ReadonlySet<string>): Map<string, number> {
  const requestUnits = [...requestFeatures]
    .filter(feature => feature.startsWith("sym:"))
    .map(feature => feature.slice(4))
    .filter(unit => unit.length >= 3)
    .filter(unit => !genericQuestionSignal(unit))
    .filter(Boolean);
  const counts = new Map(requestUnits.map(unit => [unit, 0]));
  for (const node of nodes) {
    const seen = new Set<string>();
    for (const feature of node.features) {
      if (!feature.startsWith("sym:")) continue;
      const unit = feature.slice(4);
      if (counts.has(unit)) seen.add(unit);
    }
    for (const unit of seen) counts.set(unit, (counts.get(unit) ?? 0) + 1);
  }
  const nodeCount = Math.max(1, nodes.length);
  const specificity = new Map<string, number>();
  for (const unit of requestUnits) {
    const count = counts.get(unit) ?? 0;
    if (count <= 0) continue;
    const rarity = Math.log((nodeCount + 1) / (count + 1)) / Math.log(nodeCount + 1);
    const lengthMass = Math.min(1, [...unit].length / 12);
    specificity.set(unit, kernelClamp01(0.12 + rarity * 0.58 + lengthMass * 0.3));
  }
  return specificity;
}

function primarySpecificRequestUnits(specificity: ReadonlyMap<string, number>): string[] {
  const ranked = [...specificity.entries()]
    .sort((left, right) => right[1] - left[1] || right[0].length - left[0].length);
  const top = ranked[0]?.[1] ?? 0;
  if (top <= 0) return [];
  return ranked
    .filter(([, score]) => score >= top * 0.92)
    .slice(0, 2)
    .map(([unit]) => unit);
}

function graphNodeMatchesPrimaryUnit(node: GraphNode, surfaceUnits: readonly string[], primaryUnits: readonly string[]): boolean {
  const featureUnits = new Set(node.features.filter(feature => feature.startsWith("sym:")).map(feature => feature.slice(4)));
  return primaryUnits.some(unit => featureUnits.has(unit) || surfaceUnits.includes(unit));
}

function nodeSpecificFeatureOverlap(features: readonly string[], specificity: ReadonlyMap<string, number>): number {
  if (!features.length || !specificity.size) return 0;
  const total = [...specificity.values()].reduce((sum, value) => sum + value, 0);
  if (total <= 0) return 0;
  let matched = 0;
  const seen = new Set<string>();
  for (const feature of features) {
    if (!feature.startsWith("sym:")) continue;
    const unit = feature.slice(4);
    if (seen.has(unit)) continue;
    seen.add(unit);
    matched += specificity.get(unit) ?? 0;
  }
  return kernelClamp01(matched / total);
}

function surfaceSpecificityOverlap(units: readonly string[], specificity: ReadonlyMap<string, number>): number {
  if (!units.length || !specificity.size) return 0;
  const total = [...specificity.values()].reduce((sum, value) => sum + value, 0);
  if (total <= 0) return 0;
  const matched = uniqueKernelStrings(units).reduce((sum, unit) => sum + (specificity.get(unit) ?? 0), 0);
  return kernelClamp01(matched / total);
}

function graphNodeAnchorScore(normalized: string, units: readonly string[], anchors: ReadonlySet<string>, focusUnits: ReadonlySet<string>, specificity: ReadonlyMap<string, number>): number {
  let score = 0;
  for (const anchor of anchors) {
    const anchorMass = anchorSpecificity(anchor, specificity);
    if (normalized === anchor) score += 8 * anchorMass;
    else if (anchor.length >= 4 && normalized.includes(anchor)) score += (anchor.includes(" ") ? 5 : 2) * anchorMass;
  }
  for (const unit of units) {
    const unitMass = specificity.get(unit) ?? 0;
    if (anchors.has(unit)) score += 2 * unitMass;
    if (focusUnits.has(unit)) score += unitMass;
  }
  return score;
}

function anchorSpecificity(anchor: string, specificity: ReadonlyMap<string, number>): number {
  const units = splitPriorUnits(anchor).filter(Boolean);
  if (!units.length) return 0.1;
  const matched = units.map(unit => specificity.get(unit) ?? 0).filter(value => value > 0);
  if (!matched.length) return 0.1;
  return mean(matched);
}

function uniqueGraphNodeAnswerRows(rows: readonly GraphNodeAnswerRow[]): GraphNodeAnswerRow[] {
  const bySurface = new Map<string, GraphNodeAnswerRow>();
  for (const row of rows) {
    const key = normalizePriorKey(row.surface);
    const existing = bySurface.get(key);
    if (!existing || row.score > existing.score) bySurface.set(key, row);
  }
  return [...bySurface.values()];
}

function compactGraphNodeSurface(value: string): string {
  const clean = collapsePriorWhitespace(stripOuterPriorSeparators(sourceTextSurface(value, 600)));
  if ([...clean].length <= 180) return clean;
  return [...clean].slice(0, 177).join("").trimEnd() + "...";
}

function relevanceGateFor(input: {
  requestText: string;
  ranked: readonly LearnedGraphPriorFact[];
  cognitiveFabric: QuestionCognitiveFabric;
  questionSlotPlan?: QuestionSlotPlan;
  alphaPlan: AlphaRhetoricalPlan | undefined;
  field: TurnResult["field"];
  brainMarker: Record<string, JsonValue>;
  selectedEvidence: readonly EvidenceSpan[];
  hasher: { digestHex(input: string | Uint8Array): string };
}): RelevanceGate {
  const signals = relevanceRequestFocuses(input.requestText);
  const candidateSubjectMatches = relevanceSubjectMatches(input.ranked, signals).slice(0, 8);
  const selectedKeys = new Set(input.alphaPlan?.selectedFactKeys ?? []);
  const selectedFacts = input.ranked.filter(fact => selectedKeys.has(semanticFactKey(fact))).slice(0, 12);
  const scoredFacts = selectedFacts.length ? selectedFacts : input.ranked.slice(0, 8);
  const maxSubjectAffinity = candidateSubjectMatches[0]?.affinity ?? 0;
  const maxQuestionOverlap = Math.max(0, ...input.ranked.slice(0, 24).map(fact => fact.overlap));
  const alphaSupportMass = kernelClamp01(mean(scoredFacts.map(fact => fact.activation)));
  const ppfSupportMass = kernelClamp01(mean(scoredFacts.map(fact => fact.ppfMass)));
  const relationSupportMass = kernelClamp01(mean(scoredFacts.map(fact => fact.support)));
  const answerGradeFacts = input.ranked.filter(fact => fact.graphQuality.answerGrade);
  const weakGraphFacts = input.ranked.filter(fact => fact.graphQuality.classId === GRAPH_QUALITY_CLASS_IDS.weakFragment);
  const categoryGraphFacts = input.ranked.filter(fact => fact.graphQuality.classId === GRAPH_QUALITY_CLASS_IDS.catalogNavigation);
  const noisyGraphFacts = input.ranked.filter(fact => fact.graphQuality.classId === GRAPH_QUALITY_CLASS_IDS.noisyMarkup);
  const answerGradeGraphPriorCount = answerGradeFacts.length;
  const weakGraphPriorCount = weakGraphFacts.length;
  const categoryGraphPriorCount = categoryGraphFacts.length;
  const noisyGraphPriorCount = noisyGraphFacts.length;
  const answerGradeSupportMass = kernelClamp01(mean(answerGradeFacts.slice(0, 12).map(fact => fact.graphQuality.semanticQuality * Math.max(fact.support, fact.activation, fact.ppfMass))));
  const weakGraphSupportMass = kernelClamp01(mean([...weakGraphFacts, ...categoryGraphFacts].slice(0, 12).map(fact => fact.graphQuality.semanticQuality * Math.max(fact.support, fact.activation, fact.ppfMass))));
  const slotPlanCoreCount = input.questionSlotPlan?.selectedAnswerCore.length ?? 0;
  const slotPlanAllowsAnswer = !input.questionSlotPlan || slotPlanCoreCount > 0;
  const requestedCognitiveSupportCount = input.questionSlotPlan ? slotPlanCoreCount : input.cognitiveFabric.selectedFits.length;
  const requestedCognitiveSupportMass = input.questionSlotPlan ? input.questionSlotPlan.supportMass : input.cognitiveFabric.supportMass;
  const missingRequestedSlots = uniqueKernelStrings([
    ...input.cognitiveFabric.missingRequestedSlots,
    ...(input.questionSlotPlan?.missingSlots ?? [])
  ]);
  const selectedTopicSenseId = input.cognitiveFabric.selectedTopicSenseId;
  const selectedPathCoherence = input.alphaPlan?.explanationCompleteness ?? 0;
  const directEvidenceCount = input.selectedEvidence.length;
  const learnedGraphPriorCount = input.ranked.length;
  const learnedLanguagePriorCount = kernelNumber(input.brainMarker.importedLanguagePriorCount);
  const languageOnlySupportMass = learnedGraphPriorCount > 0 ? 0 : kernelClamp01(Math.log1p(learnedLanguagePriorCount) / Math.log(100000));
  const contradictionPressure = kernelClamp01(input.field.alphaTrace.surfaces.contradiction * 0.5 + input.field.alphaTrace.contradictionMass * 0.5);
  const unrelatedPriorPenalty = learnedGraphPriorCount > 0 && maxSubjectAffinity < 0.08 && maxQuestionOverlap < 0.03 ? 0.6 : 0;
  const graphPriorSupport = learnedGraphPriorCount > 0 ? kernelClamp01(Math.log1p(learnedGraphPriorCount) / Math.log(64)) : 0;
  const relevanceScore = kernelClamp01(
    0.16 * maxSubjectAffinity +
    0.12 * maxQuestionOverlap +
    0.1 * alphaSupportMass +
    0.08 * ppfSupportMass +
    0.12 * selectedPathCoherence +
    0.08 * relationSupportMass +
    0.12 * answerGradeSupportMass +
    0.22 * requestedCognitiveSupportMass +
    0.03 * weakGraphSupportMass +
    0.04 * graphPriorSupport +
    0.12 * Math.min(1, directEvidenceCount) -
    0.24 * languageOnlySupportMass -
    0.16 * contradictionPressure -
    0.22 * unrelatedPriorPenalty
  );
  const reasonIds: string[] = [];
  if (directEvidenceCount > 0) reasonIds.push("relevance.reason.direct_evidence_present");
  if (learnedGraphPriorCount > 0) reasonIds.push("relevance.reason.graph_priors_present");
  if (answerGradeGraphPriorCount > 0) reasonIds.push("relevance.reason.answer_grade_graph_priors_present");
  if (requestedCognitiveSupportCount > 0) reasonIds.push("relevance.reason.requested_cognitive_support_present");
  if (missingRequestedSlots.length > 0) reasonIds.push("relevance.reason.requested_slots_missing");
  if (!slotPlanAllowsAnswer) reasonIds.push("relevance.reason.question_slot_answer_core_missing");
  if (weakGraphPriorCount + categoryGraphPriorCount > 0) reasonIds.push("relevance.reason.weak_or_category_graph_priors_present");
  if (languageOnlySupportMass > 0) reasonIds.push("relevance.reason.language_only_support");
  if (unrelatedPriorPenalty > 0) reasonIds.push("relevance.reason.unrelated_prior_penalty");
  if (contradictionPressure > 0.1) reasonIds.push("relevance.reason.contradiction_pressure");
  let decision: RelevanceGateDecision = QUESTION_EDGE_DECISION_IDS.insufficientSupport;
  if (directEvidenceCount > 0 && relevanceScore >= 0.22) decision = QUESTION_EDGE_DECISION_IDS.directEvidence;
  else if (learnedGraphPriorCount <= 0 && learnedLanguagePriorCount > 0) decision = QUESTION_EDGE_DECISION_IDS.languageOnlyRejected;
  else if (!slotPlanAllowsAnswer && learnedGraphPriorCount > 0) decision = QUESTION_EDGE_DECISION_IDS.requestedSlotMissing;
  else if (input.cognitiveFabric.decision === QUESTION_EDGE_DECISION_IDS.requestedSupport && slotPlanAllowsAnswer && relevanceScore >= 0.22 && requestedCognitiveSupportMass >= 0.2) decision = QUESTION_EDGE_DECISION_IDS.requestedSupport;
  else if (input.cognitiveFabric.decision === QUESTION_EDGE_DECISION_IDS.partialSupport && slotPlanAllowsAnswer && relevanceScore >= 0.18 && requestedCognitiveSupportMass >= 0.14) decision = QUESTION_EDGE_DECISION_IDS.partialSupport;
  else if (input.cognitiveFabric.decision === QUESTION_EDGE_DECISION_IDS.requestedSlotMissing) decision = QUESTION_EDGE_DECISION_IDS.requestedSlotMissing;
  else if (input.cognitiveFabric.decision === QUESTION_EDGE_DECISION_IDS.ambiguousSense) decision = QUESTION_EDGE_DECISION_IDS.ambiguousSense;
  else if (learnedGraphPriorCount > 0 && weakGraphSupportMass > 0) decision = QUESTION_EDGE_DECISION_IDS.weakGraphOnly;
  else if (candidateSubjectMatches.length > 1 && Math.abs((candidateSubjectMatches[0]?.affinity ?? 0) - (candidateSubjectMatches[1]?.affinity ?? 0)) < 0.025 && relevanceScore >= 0.18) decision = QUESTION_EDGE_DECISION_IDS.clarificationCosted;
  if (decision === QUESTION_EDGE_DECISION_IDS.insufficientSupport) reasonIds.push("relevance.reason.below_floor");
  if (decision === QUESTION_EDGE_DECISION_IDS.languageOnlyRejected) reasonIds.push("relevance.reason.language_priors_do_not_supply_facts");
  return {
    schema: "scce.relevance_gate.v1",
    queryFingerprint: input.hasher.digestHex(input.requestText).slice(0, 24),
    normalizedQuerySignals: signals,
    candidateSubjectMatches,
    activatedNodeCount: input.field.active.length,
    activatedEdgeCount: input.ranked.filter(fact => fact.activation > 0.00001).length,
    selectedPathCount: input.alphaPlan?.selectedFactKeys.length ?? 0,
    maxSubjectAffinity,
    maxQuestionOverlap,
    alphaSupportMass,
    ppfSupportMass,
    relationSupportMass,
    answerGradeGraphPriorCount,
    weakGraphPriorCount,
    categoryGraphPriorCount,
    noisyGraphPriorCount,
    answerGradeSupportMass,
    weakGraphSupportMass,
    requestedCognitiveSupportCount,
    requestedCognitiveSupportMass,
    missingRequestedSlots,
    selectedTopicSenseId,
    languageOnlySupportMass,
    directEvidenceCount,
    learnedGraphPriorCount,
    learnedLanguagePriorCount,
    relevanceScore,
    decision,
    reasonIds: uniqueKernelStrings(reasonIds)
  };
}

function explanatoryAnswerContractFor(input: {
  requestText: string;
  gate: RelevanceGate;
  alphaPlan: AlphaRhetoricalPlan | undefined;
  facts: readonly LearnedGraphPriorFact[];
  cognitiveFabric: QuestionCognitiveFabric;
  questionSlotPlan?: QuestionSlotPlan;
  hasher: { digestHex(input: string | Uint8Array): string };
}): ExplanatoryAnswerContract {
  const questionShapeId = semanticQuestionShapeId(input.facts, input.requestText, input.hasher, input.alphaPlan);
  const requestedFocuses = relevanceRequestFocuses(input.requestText);
  const selectedRoles = new Set(input.alphaPlan?.selectedRoleIds ?? []);
  const requiredSlots = uniqueKernelStrings([...(input.questionSlotPlan?.requiredSlots ?? []), ...explanatoryRequiredSlots(input.requestText, requestedFocuses), ...input.cognitiveFabric.requestedSlotIds]);
  const optionalSlots = [
    EXPLANATORY_CONTRACT_SLOT_IDS.important,
    EXPLANATORY_CONTRACT_SLOT_IDS.significance,
    EXPLANATORY_CONTRACT_SLOT_IDS.background,
    EXPLANATORY_CONTRACT_SLOT_IDS.boundary
  ];
  const cognitiveFilled = new Set(input.cognitiveFabric.selectedFits.map(fit => fit.requestedSlotId));
  const slotPlanFilled = new Set([...(input.questionSlotPlan?.filledCoreSlots ?? []), ...(input.questionSlotPlan?.filledSecondarySlots ?? [])]);
  const filledSlots = requiredSlots.filter(slot => slotPlanFilled.has(slot) || explanatorySlotFilled(slot, selectedRoles, input.facts) || cognitiveFilled.has(slot));
  const unsupportedSlots = requiredSlots.filter(slot => !filledSlots.includes(slot));
  const supportRichness = input.gate.relevanceScore + filledSlots.length / Math.max(1, requiredSlots.length);
  const richAnswer = input.gate.decision === QUESTION_EDGE_DECISION_IDS.requestedSupport || input.gate.decision === QUESTION_EDGE_DECISION_IDS.partialSupport;
  const target = richAnswer
    ? Math.max(2, Math.min(10, Math.round(2 + supportRichness * 4 + (input.questionSlotPlan?.selectedAnswerCore.length ?? 0) * 0.6 + unsupportedSlots.length * 0.25)))
    : 1;
  return {
    schema: "scce.explanatory_answer_contract.v1",
    questionShapeId,
    mainSubjectCandidates: input.gate.candidateSubjectMatches.map(row => row.label),
    selectedMainSubject: input.alphaPlan?.selectedSubject || input.gate.candidateSubjectMatches[0]?.label || requestedFocuses[0] || "",
    requestedFocuses,
    requiredSlots,
    optionalSlots,
    filledSlots,
    unsupportedSlots,
    relevanceGate: input.gate,
    alphaAnswerPlan: input.alphaPlan,
    rhetoricalPlan: toJsonValue({
      selectedRoleIds: input.alphaPlan?.selectedRoleIds ?? [],
      backgroundRoleIds: input.alphaPlan?.backgroundRoleIds ?? [],
      planEnergy: input.alphaPlan?.planEnergy ?? 1,
      explanationCompleteness: input.alphaPlan?.explanationCompleteness ?? 0,
      cognitiveFabric: input.cognitiveFabric
    }),
    certificationBoundary: toJsonValue({
      directEvidenceCount: input.gate.directEvidenceCount,
      externalFactCertification: input.gate.decision === QUESTION_EDGE_DECISION_IDS.directEvidence
    }),
    targetSurfaceExtent: {
      floor: richAnswer ? Math.min(3, Math.max(2, input.questionSlotPlan?.selectedAnswerCore.length ?? 2)) : 1,
      target,
      ceiling: richAnswer ? 10 : 2
    },
    questionSlotPlan: input.questionSlotPlan
  };
}

function createAlphaRhetoricalPlan(input: {
  ranked: readonly LearnedGraphPriorFact[];
  requestText: string;
  field: TurnResult["field"];
  hasher: { digestHex(input: string | Uint8Array): string };
}): AlphaRhetoricalPlan | undefined {
  if (!input.ranked.length) return undefined;
  const anchors = priorRequestAnchors(input.requestText);
  const subject = alphaRhetoricalSubject(input.ranked, anchors, input.requestText);
  if (!subject) return undefined;
  const subjectFacts = input.ranked.filter(fact => samePriorEntity(fact.subject, subject));
  const bridgeAnchors = specificPriorBridgeAnchors(subjectFacts);
  const contradictionPressure = kernelClamp01(input.field.alphaTrace.surfaces.contradiction * 0.58 + input.field.alphaTrace.contradictionMass * 0.42);
  const assignments = input.ranked.slice(0, 96)
    .map(fact => alphaRhetoricalAssignment({ fact, subject, anchors, bridgeAnchors, contradictionPressure, hasher: input.hasher }))
    .filter(assignment => assignment.arc > 0.0001)
    .sort((left, right) => right.arc - left.arc || right.pathScore - left.pathScore || left.factKey.localeCompare(right.factKey));
  if (!assignments.length) return undefined;
  const selected = selectAlphaRhetoricalAssignments(assignments);
  if (!selected.length) return undefined;
  const selectedKeys = new Set(selected.map(assignment => assignment.factKey));
  const allAssignments = assignments.map(assignment => ({
    ...assignment,
    selected: selectedKeys.has(assignment.factKey),
    shouldSurface: selectedKeys.has(assignment.factKey) && assignment.shouldSurface
  }));
  const selectedRoleIds = uniqueKernelStrings(selected.map(assignment => assignment.roleId));
  const requiredRoleIds = [...ANSWER_ROLE_GROUPS.required];
  const optionalRoleIds = [...ANSWER_ROLE_GROUPS.optional];
  const missingRequired = requiredRoleIds.filter(roleId => !selectedRoleIds.includes(roleId)).length;
  const surfaced = selected.filter(assignment => assignment.shouldSurface);
  const supportMass = mean(selected.map(assignment => assignment.arc));
  const bridgeCoverage = selectedRoleIds.some(isBridgeAnswerRoleId) ? 1 : 0;
  const backgroundDominance = selected.filter(assignment => isBackgroundAnswerRoleId(assignment.roleId)).reduce((sum, assignment) => sum + (assignment.shouldSurface ? assignment.arc : assignment.arc * 0.15), 0);
  const fragmentation = kernelClamp01(Math.max(0, selected.length - uniqueKernelStrings(selected.map(assignment => assignment.roleId)).length) / Math.max(1, selected.length));
  const explanationCompleteness = kernelClamp01(0.36 * (1 - missingRequired / requiredRoleIds.length) + 0.22 * bridgeCoverage + 0.22 * supportMass + 0.2 * Math.min(1, surfaced.length / 4));
  const targetSentenceCount = alphaRhetoricalTargetSentenceCount({ selected, bridgeCoverage, supportMass, missingRequired });
  const planEnergy = kernelClamp01(
    missingRequired * 0.18 +
    backgroundDominance * 0.22 +
    fragmentation * 0.14 +
    contradictionPressure * 0.18 +
    Math.abs(targetSentenceCount - Math.max(2, surfaced.length)) * 0.03 -
    explanationCompleteness * 0.28
  );
  return {
    schema: "scce.alpha_rhetorical_plan.v1",
    plannerId: "walsh.alpha_rhetorical_centrality",
    selectedSubject: subject,
    selectedSubjectNodeIds: uniqueKernelStrings(input.ranked.filter(fact => samePriorEntity(fact.subject, subject)).map(fact => fact.sourceNodeId)),
    requiredRoleIds,
    optionalRoleIds,
    selectedRoleIds,
    backgroundRoleIds: [...ANSWER_ROLE_GROUPS.background],
    assignments: allAssignments.slice(0, 64),
    selectedFactKeys: selected.map(assignment => assignment.factKey),
    backgroundFactKeys: selected.filter(assignment => isBackgroundAnswerRoleId(assignment.roleId)).map(assignment => assignment.factKey),
    planEnergy,
    explanationCompleteness,
    targetSentenceCount,
    proofBoundaryId: "output.force.import_bound",
    audit: toJsonValue({
      inputFactCount: input.ranked.length,
      assignmentCount: allAssignments.length,
      contradictionPressure,
      supportMass,
      bridgeCoverage,
      backgroundDominance,
      fragmentation,
      missingRequired,
      selectedRoleIds
    })
  };
}

function alphaRhetoricalSubject(facts: readonly LearnedGraphPriorFact[], anchors: ReadonlySet<string>, requestText: string): string {
  for (const anchor of namedSubjectAnchors(requestText)) {
    const best = subjectAnchorCandidates(facts, anchors, anchor)[0];
    if (best) return best.label;
  }
  const phraseAnchors = [...anchors]
    .filter(anchor => anchor.includes(" "))
    .sort((left, right) => splitPriorUnits(right).length - splitPriorUnits(left).length || right.length - left.length);
  for (const anchor of phraseAnchors) {
    const best = subjectAnchorCandidates(facts, anchors, anchor)[0];
    if (best) return best.label;
  }
  const scores = new Map<string, { label: string; score: number; nodeIds: Set<string> }>();
  for (const fact of facts) {
    const key = normalizePriorKey(fact.subject);
    const anchorMass = factRequestAnchorScore(fact, anchors);
    const score = fact.score * 0.28 + fact.activation * 0.22 + fact.ppfMass * 0.22 + fact.support * 0.16 + anchorMass * 0.12;
    const previous = scores.get(key) ?? { label: fact.subject, score: 0, nodeIds: new Set<string>() };
    previous.score += score;
    previous.nodeIds.add(fact.sourceNodeId);
    scores.set(key, previous);
  }
  const best = [...scores.values()]
    .filter(row => !anchors.size || splitPriorUnits(normalizePriorKey(row.label)).some(unit => anchors.has(unit)))
    .sort((left, right) => right.score - left.score || right.nodeIds.size - left.nodeIds.size || left.label.localeCompare(right.label))[0];
  return best?.label ?? "";
}

function namedSubjectAnchors(text: string): string[] {
  return namedPriorSurfaceRuns(text)
    .map(normalizePriorKey)
    .filter(namedSourceAnchorSpecificEnough)
    .sort((left, right) => splitPriorUnits(right).length - splitPriorUnits(left).length || right.length - left.length);
}

function namedSourceAnchorSpecificEnough(anchor: string): boolean {
  const units = splitPriorUnits(anchor);
  if (units.length >= 2) return true;
  return units.some(unit => [...unit].length >= 3 && !genericQuestionSignal(unit));
}

function requestContentPriorUnits(text: string): string[] {
  const units = splitPriorUnits(normalizePriorKey(text));
  if (text.includes("?") && units.length > 1) return units.slice(1);
  return units;
}

function requestContentSurface(text: string): string {
  const words = splitPriorSurfaceWords(text);
  const contentWords = text.includes("?") && words.length > 1 ? words.slice(1) : words;
  return contentWords.join(" ") || text;
}

function semanticAnswerSubjectAllowed(requestText: string, selectedSubject: string, gate: RelevanceGate): boolean {
  const selected = normalizePriorKey(selectedSubject);
  if (!selected) return false;
  for (const anchor of namedSubjectAnchors(requestText)) {
    if (selected === anchor || selected.startsWith(`${anchor} `) || anchor.startsWith(`${selected} `)) return true;
  }
  const selectedUnits = splitPriorUnits(selected);
  const contentUnits = requestContentPriorUnits(requestText).filter(unit => unit.length >= 5 && !genericQuestionSignal(unit));
  if (contentUnits.some(unit => selectedUnits.includes(unit))) return true;
  return gate.candidateSubjectMatches.some(row => normalizePriorKey(row.label) === selected && row.affinity >= 0.3);
}

function subjectAnchorCandidates(facts: readonly LearnedGraphPriorFact[], anchors: ReadonlySet<string>, anchor: string): Array<{ label: string; exact: number; mass: number; score: number }> {
  return facts
    .filter(fact => priorSubjectMatchesAnchorPhrase(fact.subject, anchor))
    .map(fact => ({
      label: fact.subject,
      exact: normalizePriorKey(fact.subject) === anchor ? 1 : 0,
      mass: semanticPriorSurfaceMass(fact.subject),
      score: fact.score + fact.activation + fact.ppfMass + fact.support + factRequestAnchorScore(fact, anchors)
    }))
    .sort((left, right) => right.exact - left.exact || left.mass - right.mass || right.score - left.score || left.label.localeCompare(right.label));
}

function priorSubjectMatchesAnchorPhrase(subject: string, phrase: string): boolean {
  const key = normalizePriorKey(subject);
  return key === phrase || key.startsWith(`${phrase} `);
}

function alphaRhetoricalAssignment(input: {
  fact: LearnedGraphPriorFact;
  subject: string;
  anchors: ReadonlySet<string>;
  bridgeAnchors: ReadonlySet<string>;
  contradictionPressure: number;
  hasher: { digestHex(input: string | Uint8Array): string };
}): AlphaRhetoricalAssignment {
  const roleId = alphaRhetoricalRoleId(input.fact, input.subject, input.anchors, input.bridgeAnchors);
  const subjectCentrality = samePriorEntity(input.fact.subject, input.subject) || samePriorEntity(input.fact.object, input.subject) ? 1 : factSharesSpecificPriorAnchor(input.fact, input.bridgeAnchors) ? 0.58 : 0.22;
  const requestFit = kernelClamp01(factRequestAnchorScore(input.fact, input.anchors) / Math.max(1, input.anchors.size + 1));
  const questionFit = input.fact.questionEdgeFit.finalQuestionFit;
  const pathActivation = kernelClamp01(0.38 * input.fact.activation + 0.34 * input.fact.ppfMass + 0.28 * Math.max(input.fact.sourceActivation, input.fact.targetActivation));
  const relationSupport = kernelClamp01(input.fact.support);
  const bridgeValue = alphaRhetoricalBridgeValue(input.fact, input.subject, input.bridgeAnchors, input.anchors, roleId);
  const semanticQuality = input.fact.graphQuality.semanticQuality;
  const backgroundPenalty = isBackgroundAnswerRoleId(roleId)
    ? kernelClamp01(0.66 - questionFit * 0.28 + subjectCentrality * 0.08)
    : 0;
  const forceMeaning = input.fact.forceClass === "learned_concept_prior" ? 0.92 : 0.5;
  const certificationPower = input.fact.forceClass === "direct_evidence" && Boolean(input.fact.sourceVersionId) ? 1 : 0;
  const distanceFromSubject = samePriorEntity(input.fact.subject, input.subject) || samePriorEntity(input.fact.object, input.subject) ? 0 : factSharesSpecificPriorAnchor(input.fact, input.bridgeAnchors) ? 0.42 : 0.76;
  const pathScore = kernelClamp01(
    0.26 * Math.log1p(pathActivation * 8) / Math.log(9) +
    0.22 * relationSupport +
    0.1 * requestFit +
    0.18 * questionFit +
    0.18 * bridgeValue +
    0.12 * forceMeaning +
    0.22 * semanticQuality -
    0.1 * distanceFromSubject -
    0.12 * input.contradictionPressure
  );
  const roleScore = sigmoidKernel(
    1.7 * subjectCentrality +
    0.72 * requestFit +
    1.45 * questionFit +
    1.4 * pathActivation +
    1.05 * relationSupport +
    1.25 * bridgeValue -
    1.2 * (1 - semanticQuality) -
    1.15 * distanceFromSubject -
    1.55 * backgroundPenalty -
    1.3 * input.contradictionPressure
  );
  const answerGradeMass = factQuestionFitAllowsSurface(input.fact) ? 1 : 0.18;
  const arc = kernelClamp01(pathScore * roleScore * forceMeaning * semanticQuality * answerGradeMass * bridgeValueOrOne(bridgeValue, roleId) * (1 - backgroundPenalty * 0.72) * (1 - input.contradictionPressure));
  const shouldSurface = factQuestionFitAllowsSurface(input.fact) && !isBackgroundAnswerRoleId(roleId) && roleId !== ANSWER_ROLE_IDS.boundary;
  return {
    id: `alpha.rhetorical.assignment:${input.hasher.digestHex(`${semanticFactKey(input.fact)}:${roleId}`).slice(0, 18)}`,
    factKey: semanticFactKey(input.fact),
    relationId: input.fact.relationId,
    sourceNodeId: input.fact.sourceNodeId,
    targetNodeId: input.fact.targetNodeId,
    roleId,
    arc,
    pathScore,
    roleScore,
    pathActivation,
    relationSupport,
    bridgeValue,
    backgroundPenalty,
    contradictionPressure: input.contradictionPressure,
    forceMeaning,
    certificationPower,
    semanticQuality,
    graphQualityClassId: input.fact.graphQuality.classId,
    answerGrade: factQuestionFitAllowsSurface(input.fact),
    selected: false,
    shouldSurface
  };
}

function alphaRhetoricalRoleId(fact: LearnedGraphPriorFact, subject: string, anchors: ReadonlySet<string>, bridgeAnchors: ReadonlySet<string>): string {
  const subjectMatch = samePriorEntity(fact.subject, subject);
  const objectMatch = samePriorEntity(fact.object, subject);
  if (fact.questionEdgeFit.relationRoleId === RELATION_ROLE_IDS.graphNavigation) return ANSWER_ROLE_IDS.backgroundRelation;
  if (lowValueCatalogFact(fact)) return ANSWER_ROLE_IDS.backgroundRelation;
  if (fact.questionEdgeFit.relationRoleId === RELATION_ROLE_IDS.graphRequestMembership) return subjectMatch || objectMatch ? ANSWER_ROLE_IDS.context : ANSWER_ROLE_IDS.backgroundActor;
  if (fact.questionEdgeFit.relationRoleId === RELATION_ROLE_IDS.graphRequestRelation) return ANSWER_ROLE_IDS.contribution;
  if (fact.questionEdgeFit.relationRoleId === RELATION_ROLE_IDS.graphExplanatoryPath) return ANSWER_ROLE_IDS.contribution;
  if (fact.questionEdgeFit.relationRoleId === RELATION_ROLE_IDS.graphCompactAttribute) return subjectMatch ? ANSWER_ROLE_IDS.identity : ANSWER_ROLE_IDS.field;
  if (fact.questionEdgeFit.relationRoleId === RELATION_ROLE_IDS.graphCompoundMembership || fact.questionEdgeFit.relationRoleId === RELATION_ROLE_IDS.graphCompoundAttribute) return subjectMatch || objectMatch ? ANSWER_ROLE_IDS.context : ANSWER_ROLE_IDS.backgroundActor;
  if (fact.questionEdgeFit.relationRoleId === RELATION_ROLE_IDS.graphContextRelation) return subjectMatch ? ANSWER_ROLE_IDS.context : ANSWER_ROLE_IDS.backgroundRelation;
  if (fact.questionEdgeFit.relationRoleId === RELATION_ROLE_IDS.metadata) return ANSWER_ROLE_IDS.backgroundRelation;
  if (fact.questionEdgeFit.relationRoleId === RELATION_ROLE_IDS.contribution || fact.questionEdgeFit.relationRoleId === RELATION_ROLE_IDS.knownFor || fact.questionEdgeFit.relationRoleId === RELATION_ROLE_IDS.characterCast) return ANSWER_ROLE_IDS.contribution;
  if (fact.questionEdgeFit.relationRoleId === RELATION_ROLE_IDS.effect) return ANSWER_ROLE_IDS.significance;
  if (fact.questionEdgeFit.relationRoleId === RELATION_ROLE_IDS.domain) return ANSWER_ROLE_IDS.field;
  if (fact.questionEdgeFit.relationRoleId === RELATION_ROLE_IDS.roleClass || fact.questionEdgeFit.relationRoleId === RELATION_ROLE_IDS.definitionClass) return ANSWER_ROLE_IDS.identity;
  if (subjectMatch) return ANSWER_ROLE_IDS.contribution;
  if (objectMatch) return ANSWER_ROLE_IDS.contribution;
  if (factSharesSpecificPriorAnchor({ ...fact, object: fact.subject }, bridgeAnchors)) {
    return factRequestAnchorScore(fact, anchors) > 0 ? ANSWER_ROLE_IDS.significance : ANSWER_ROLE_IDS.context;
  }
  if (factSharesSpecificPriorAnchor(fact, bridgeAnchors)) return ANSWER_ROLE_IDS.backgroundActor;
  return factRequestAnchorScore(fact, anchors) > 0 ? ANSWER_ROLE_IDS.field : ANSWER_ROLE_IDS.backgroundRelation;
}

function alphaRhetoricalBridgeValue(fact: LearnedGraphPriorFact, subject: string, bridgeAnchors: ReadonlySet<string>, anchors: ReadonlySet<string>, roleId: string): number {
  const direct = samePriorEntity(fact.subject, subject) || samePriorEntity(fact.object, subject) ? 0.88 : 0;
  const bridge = factSpecificBridgeScore(fact, bridgeAnchors) ? 0.78 : 0;
  const request = factRequestAnchorScore(fact, anchors) > 0 ? 0.64 : 0;
  const role = roleId === ANSWER_ROLE_IDS.significance ? 0.92 : roleId === ANSWER_ROLE_IDS.context || roleId === ANSWER_ROLE_IDS.field ? 0.78 : roleId === ANSWER_ROLE_IDS.contribution ? 0.86 : 0.48;
  return kernelClamp01(Math.max(direct, bridge, request, role));
}

function bridgeValueOrOne(bridgeValue: number, roleId: string): number {
  return isBackgroundAnswerRoleId(roleId) ? kernelClamp01(0.72 + bridgeValue * 0.18) : kernelClamp01(0.82 + bridgeValue * 0.18);
}

function selectAlphaRhetoricalAssignments(assignments: readonly AlphaRhetoricalAssignment[]): AlphaRhetoricalAssignment[] {
  const selected: AlphaRhetoricalAssignment[] = [];
  const selectedKeys = new Set<string>();
  const addBest = (roleId: string) => {
    const row = assignments.filter(item => item.roleId === roleId && !selectedKeys.has(item.factKey)).sort((left, right) => right.arc - left.arc || right.pathScore - left.pathScore)[0];
    if (!row) return;
    selected.push(row);
    selectedKeys.add(row.factKey);
  };
  for (const roleId of ANSWER_ROLE_GROUPS.selectionOrder) addBest(roleId);
  const background = assignments
    .filter(item => isBackgroundAnswerRoleId(item.roleId) && !selectedKeys.has(item.factKey))
    .sort((left, right) => right.arc - left.arc || right.bridgeValue - left.bridgeValue)[0];
  if (background && selected.length >= 2) {
    selected.push(background);
    selectedKeys.add(background.factKey);
  }
  if (!selected.length) {
    const best = assignments[0];
    if (best) selected.push(best);
  }
  return selected.sort((left, right) => alphaRhetoricalRoleOrder(left.roleId) - alphaRhetoricalRoleOrder(right.roleId) || right.arc - left.arc);
}

function alphaRhetoricalRoleOrder(roleId: string): number {
  if (roleId === ANSWER_ROLE_IDS.identity) return 0;
  if (roleId === ANSWER_ROLE_IDS.contribution) return 1;
  if (roleId === ANSWER_ROLE_IDS.significance) return 2;
  if (roleId === ANSWER_ROLE_IDS.context) return 3;
  if (roleId === ANSWER_ROLE_IDS.field) return 4;
  if (roleId === ANSWER_ROLE_IDS.backgroundActor) return 5;
  if (roleId === ANSWER_ROLE_IDS.backgroundRelation) return 6;
  return 8;
}

function alphaRhetoricalTargetSentenceCount(input: { selected: readonly AlphaRhetoricalAssignment[]; bridgeCoverage: number; supportMass: number; missingRequired: number }): number {
  const supported = uniqueKernelStrings(input.selected.map(assignment => assignment.roleId)).length;
  const raw = 2 + supported * 0.7 + input.bridgeCoverage * 1.2 + input.supportMass * 1.6 - input.missingRequired * 0.75;
  return Math.max(2, Math.min(8, Math.round(raw)));
}

function relevanceRequestFocuses(text: string): string[] {
  const named = namedSubjectAnchors(text);
  const units = requestContentPriorUnits(text)
    .map(stripOuterPriorSeparators)
    .filter(unit => unit.length >= 4)
    .filter(unit => !genericQuestionSignal(unit));
  return uniqueKernelStrings([...named, ...units]).slice(0, 16);
}

function genericQuestionSignal(unit: string): boolean {
  if (!unit) return true;
  if (unit.length <= 2) return true;
  let letters = 0;
  let repeated = 0;
  let previous = "";
  for (const char of unit) {
    if (char.toLocaleLowerCase() !== char.toLocaleUpperCase()) letters++;
    if (char === previous) repeated++;
    previous = char;
  }
  return letters <= 1 || repeated / Math.max(1, unit.length - 1) > 0.72;
}

function namedPriorSurfaceRuns(text: string): string[] {
  return uniqueKernelStrings(surfaceEntityRuns(text)).slice(0, 8);
}

function splitPriorSurfaceWords(text: string): string[] {
  return surfaceWords(text);
  const out: string[] = [];
  let current = "";
  for (const char of text.normalize("NFKC")) {
    const symbol = char.toLocaleLowerCase() !== char.toLocaleUpperCase() || (char >= "0" && char <= "9") || char === "'" || char === "’";
    if (symbol) {
      current += char;
      continue;
    }
    if (current) out.push(current);
    current = "";
  }
  if (current) out.push(current);
  return out;
}

function surfaceEntityRuns(text: string): string[] {
  const out: string[] = [];
  let current: string[] = [];
  const flush = () => {
    if (
      current.length >= 2 ||
      current.some(hasUncasedNonLatinLetter) ||
      current.some(unit => hasPriorAnchorSignal(unit) && [...normalizePriorKey(unit)].length >= 4)
    ) out.push(current.join(" "));
    current = [];
  };
  for (const raw of surfaceWords(text)) {
    const word = stripOuterPriorSeparators(raw);
    if (!word) continue;
    if (hasPriorAnchorSignal(word) && splitPriorUnits(normalizePriorKey(word)).some(unit => unit.length >= 2)) {
      current.push(word);
      continue;
    }
    flush();
  }
  flush();
  return uniqueKernelStrings(out).slice(0, 32);
}

function relevanceSubjectMatches(facts: readonly LearnedGraphPriorFact[], signals: readonly string[]): Array<{ label: string; affinity: number; nodeIds: string[] }> {
  const rows = new Map<string, { label: string; affinity: number; nodeIds: Set<string> }>();
  for (const fact of facts.slice(0, 128)) {
    const key = normalizePriorKey(fact.subject);
    const affinity = kernelClamp01(
      0.42 * fuzzySignalAffinity(fact.subject, signals) +
      0.18 * fuzzySignalAffinity(fact.object, signals) +
      0.18 * fact.overlap +
      0.12 * fact.activation +
      0.1 * fact.ppfMass
    );
    if (affinity <= 0.001) continue;
    const previous = rows.get(key) ?? { label: fact.subject, affinity: 0, nodeIds: new Set<string>() };
    previous.affinity = Math.max(previous.affinity, affinity);
    previous.nodeIds.add(fact.sourceNodeId);
    rows.set(key, previous);
  }
  return [...rows.values()]
    .map(row => ({ label: row.label, affinity: row.affinity, nodeIds: [...row.nodeIds].slice(0, 8) }))
    .sort((left, right) => right.affinity - left.affinity || left.label.localeCompare(right.label));
}

function fuzzySignalAffinity(label: string, signals: readonly string[]): number {
  const units = splitPriorUnits(normalizePriorKey(label)).filter(Boolean);
  if (!units.length || !signals.length) return 0;
  let score = 0;
  for (const signal of signals) {
    let best = 0;
    for (const unit of units) best = Math.max(best, fuzzyUnitSimilarity(signal, unit));
    score += best;
  }
  return kernelClamp01(score / Math.max(1, Math.min(signals.length, units.length + 1)));
}

function fuzzyUnitSimilarity(left: string, right: string): number {
  if (!left || !right) return 0;
  if (left === right) return 1;
  if (left.length >= 4 && right.length >= 4 && (left.includes(right) || right.includes(left))) return 0.82;
  const distance = boundedEditDistance(left, right, 3);
  const scale = Math.max(left.length, right.length);
  if (distance > 3 || scale <= 0) return 0;
  return kernelClamp01(1 - distance / scale);
}

function boundedEditDistance(left: string, right: string, maxDistance: number): number {
  if (Math.abs(left.length - right.length) > maxDistance) return maxDistance + 1;
  let previous = Array.from({ length: right.length + 1 }, (_, index) => index);
  for (let i = 1; i <= left.length; i++) {
    const current = [i];
    let rowMin = i;
    for (let j = 1; j <= right.length; j++) {
      const cost = left[i - 1] === right[j - 1] ? 0 : 1;
      const value = Math.min((previous[j] ?? 0) + 1, (current[j - 1] ?? 0) + 1, (previous[j - 1] ?? 0) + cost);
      current[j] = value;
      rowMin = Math.min(rowMin, value);
    }
    if (rowMin > maxDistance) return maxDistance + 1;
    previous = current;
  }
  return previous[right.length] ?? maxDistance + 1;
}

function explanatoryRequiredSlots(text: string, focuses: readonly string[]): string[] {
  void text;
  const slots: string[] = [GRAPH_SLOT_IDS.topicAnchor, GRAPH_SLOT_IDS.compactAttribute, GRAPH_SLOT_IDS.explanatoryPath];
  if (focuses.length > 1) slots.push(GRAPH_SLOT_IDS.requestAlignedRelation, GRAPH_SLOT_IDS.contextBridge);
  return uniqueKernelStrings(slots);
}

function explanatorySlotFilled(slot: string, selectedRoles: ReadonlySet<string>, facts: readonly LearnedGraphPriorFact[]): boolean {
  if (slot === GRAPH_SLOT_IDS.topicAnchor) return facts.length > 0 || selectedRoles.size > 0;
  if (slot === GRAPH_SLOT_IDS.requestAlignedRelation) return facts.some(fact => fact.questionEdgeFit.requestedSlotId === slot || fact.questionEdgeFit.relationRoleId === RELATION_ROLE_IDS.graphRequestRelation || fact.questionEdgeFit.relationRoleId === RELATION_ROLE_IDS.graphRequestMembership);
  if (slot === GRAPH_SLOT_IDS.compactAttribute) return selectedRoles.has(ANSWER_ROLE_IDS.identity) || facts.some(fact => fact.questionEdgeFit.relationRoleId === RELATION_ROLE_IDS.graphCompactAttribute);
  if (slot === GRAPH_SLOT_IDS.explanatoryPath) return selectedRoles.has(ANSWER_ROLE_IDS.contribution) || facts.some(fact => fact.questionEdgeFit.relationRoleId === RELATION_ROLE_IDS.graphExplanatoryPath);
  if (slot === GRAPH_SLOT_IDS.contextBridge) return selectedRoles.has(ANSWER_ROLE_IDS.context) || selectedRoles.has(ANSWER_ROLE_IDS.significance) || selectedRoles.has(ANSWER_ROLE_IDS.field) || facts.some(fact => fact.questionEdgeFit.relationRoleId === RELATION_ROLE_IDS.graphCompoundMembership || fact.questionEdgeFit.relationRoleId === RELATION_ROLE_IDS.graphCompoundAttribute);
  if (slot === EXPLANATORY_CONTRACT_SLOT_IDS.subject) return selectedRoles.has(ANSWER_ROLE_IDS.identity) || facts.length > 0;
  if (slot === EXPLANATORY_CONTRACT_SLOT_IDS.role) return selectedRoles.has(ANSWER_ROLE_IDS.identity);
  if (slot === EXPLANATORY_CONTRACT_SLOT_IDS.primary) return selectedRoles.has(ANSWER_ROLE_IDS.contribution);
  if (slot === EXPLANATORY_CONTRACT_SLOT_IDS.context || slot === EXPLANATORY_CONTRACT_SLOT_IDS.important || slot === EXPLANATORY_CONTRACT_SLOT_IDS.contextDomain) return selectedRoles.has(ANSWER_ROLE_IDS.context) || selectedRoles.has(ANSWER_ROLE_IDS.field) || selectedRoles.has(ANSWER_ROLE_IDS.significance);
  if (slot === EXPLANATORY_CONTRACT_SLOT_IDS.significance) return selectedRoles.has(ANSWER_ROLE_IDS.significance) || selectedRoles.has(ANSWER_ROLE_IDS.context);
  if (slot === EXPLANATORY_CONTRACT_SLOT_IDS.definition) return selectedRoles.has(ANSWER_ROLE_IDS.identity) || selectedRoles.has(ANSWER_ROLE_IDS.field);
  if (slot === EXPLANATORY_CONTRACT_SLOT_IDS.memberSet) return facts.length >= 3 && uniqueKernelStrings(facts.map(fact => fact.object)).length >= 3;
  if (slot === EXPLANATORY_CONTRACT_SLOT_IDS.source || slot === EXPLANATORY_CONTRACT_SLOT_IDS.target) return facts.length > 0;
  if (slot === EXPLANATORY_CONTRACT_SLOT_IDS.effect) return selectedRoles.has(ANSWER_ROLE_IDS.significance) || selectedRoles.has(ANSWER_ROLE_IDS.field);
  if (slot === EXPLANATORY_CONTRACT_SLOT_IDS.request) return facts.some(fact => fact.overlap > 0.03);
  return false;
}

function semanticPriorRelationMass(fact: LearnedGraphPriorFact): number {
  return splitPriorUnits(normalizePriorKey(`${fact.predicate} ${fact.object}`)).filter(Boolean).length;
}

function semanticPriorSurfaceMass(value: string): number {
  return splitPriorUnits(normalizePriorKey(value)).filter(Boolean).length;
}

function kernelClamp01(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(1, value));
}

function sigmoidKernel(value: number): number {
  return 1 / (1 + Math.exp(-value));
}

function priorFactAdmissibleForAnswer(subject: string, predicate: string, object: string, requestAnchors: ReadonlySet<string>): boolean {
  const subjectUnits = splitPriorUnits(normalizePriorKey(subject));
  const predicateUnits = splitPriorUnits(normalizePriorKey(predicate));
  const objectUnits = splitPriorUnits(normalizePriorKey(object));
  if (!subjectUnits.length || !predicateUnits.length || !objectUnits.length) return false;
  if (priorSurfaceLooksStructuralDebris(subject) || priorSurfaceLooksStructuralDebris(object)) return false;
  if (priorSurfaceIsQuestionOperator(subjectUnits)) return false;
  if (priorSurfaceIsQuestionOperator(predicateUnits)) return false;
  if (priorSurfaceIsQuestionOperator(objectUnits)) return false;
  if (subjectUnits.some(genericQuestionSignal) && subjectUnits.filter(unit => !genericQuestionSignal(unit)).length < 1) return false;
  if (subjectUnits.length > 8) return false;
  if (predicateUnits.length > 6) return false;
  if (objectUnits.length > 5) return false;
  if ([...subject].length > 96) return false;
  if ([...predicate].length > 80) return false;
  if ([...object].length > 96) return false;
  const punctuationMass = [...object].filter(isDensePriorPunctuation).length / Math.max(1, [...object].length);
  if (punctuationMass > 0.12) return false;
  if (!requestAllowsDiagnosticModality(requestAnchors) && priorFactHasDiagnosticModality([...predicateUnits, ...objectUnits])) return false;
  return true;
}

function priorSurfaceLooksStructuralDebris(value: string): boolean {
  const clean = stripOuterPriorSeparators(collapsePriorWhitespace(value));
  if (!clean) return true;
  const first = clean[0] ?? "";
  if (first === "#" || first === "<" || first === ">") return true;
  let quoteCount = 0;
  for (const char of clean) if (char === "\"" || char === "'") quoteCount++;
  if (quoteCount > 0 && splitPriorUnits(clean).length <= 4) return true;
  const units = splitPriorUnits(normalizePriorKey(clean));
  if (units.length <= 2 && units.some(unit => unit.includes("abort") || unit.includes("thread"))) return true;
  return false;
}

function priorSurfaceIsQuestionOperator(units: readonly string[]): boolean {
  if (!units.length) return false;
  return units.every(unit => genericQuestionSignal(unit) || unit.length <= 1);
}

function isDensePriorPunctuation(char: string): boolean {
  return char === ":" || char === ";" || char === "{" || char === "}" || char === "[" || char === "]" || char === "(" || char === ")" || char === "=" || char === "|";
}

function requestAllowsDiagnosticModality(anchors: ReadonlySet<string>): boolean {
  void anchors;
  return false;
}

function priorFactHasDiagnosticModality(units: readonly string[]): boolean {
  void units;
  return false;
}

function prioritizeGraphPriorFacts(facts: readonly LearnedGraphPriorFact[], requestText: string): LearnedGraphPriorFact[] {
  const anchors = priorRequestAnchors(requestText);
  const primary = [...facts]
    .sort((left, right) =>
      factRequestAnchorScore(right, anchors) - factRequestAnchorScore(left, anchors) ||
      right.score - left.score ||
      right.support - left.support ||
      left.subject.localeCompare(right.subject)
    )[0];
  if (!primary) return [];
  if (factRequestAnchorScore(primary, anchors) < 2) return [];
  const subjectFacts = facts
    .filter(fact => samePriorEntity(fact.subject, primary.subject))
    .sort((left, right) => right.score - left.score || right.support - left.support || left.object.localeCompare(right.object));
  const subjectObjects = specificPriorBridgeAnchors(subjectFacts);
  const linkedFacts = facts
    .filter(fact => !samePriorEntity(fact.subject, primary.subject))
    .filter(fact => factSharesSpecificPriorAnchor(fact, subjectObjects))
    .filter(fact => factRequestAnchorScore(fact, anchors) >= 2)
    .sort((left, right) => right.score - left.score || right.support - left.support)
    .slice(0, 1);
  return uniqueLearnedFacts([...subjectFacts.slice(0, 4), ...linkedFacts]).slice(0, 5);
}

function expandGraphPriorAnswerNeighborhood(input: {
  ranked: readonly LearnedGraphPriorFact[];
  prioritized: readonly LearnedGraphPriorFact[];
  requestText: string;
}): LearnedGraphPriorFact[] {
  const anchors = priorRequestAnchors(input.requestText);
  const primary = input.prioritized[0];
  if (!primary) return [];
  const selected: LearnedGraphPriorFact[] = [];
  const add = (fact: LearnedGraphPriorFact | undefined) => {
    if (!fact) return;
    if (selected.some(row => semanticFactKey(row) === semanticFactKey(fact))) return;
    selected.push(fact);
  };
  const subjectFacts = input.ranked
    .filter(fact => samePriorEntity(fact.subject, primary.subject))
    .sort((left, right) =>
      factCompletenessScore(right, anchors) - factCompletenessScore(left, anchors) ||
      right.score - left.score ||
      right.support - left.support
    );
  for (const fact of subjectFacts.slice(0, 8)) add(fact);
  const bridgeAnchors = specificPriorBridgeAnchors(subjectFacts);
  const linkedFacts = input.ranked
    .filter(fact => !samePriorEntity(fact.subject, primary.subject))
    .filter(fact => factSharesSpecificPriorAnchor(fact, bridgeAnchors))
    .filter(fact => factRequestAnchorScore(fact, anchors) > 0 || factSpecificBridgeScore(fact, bridgeAnchors) > 0)
    .sort((left, right) =>
      factSpecificBridgeScore(right, bridgeAnchors) - factSpecificBridgeScore(left, bridgeAnchors) ||
      factCompletenessScore(right, anchors) - factCompletenessScore(left, anchors) ||
      right.activation - left.activation ||
      right.score - left.score
    );
  for (const fact of linkedFacts.slice(0, 4)) add(fact);
  return selected
    .sort((left, right) =>
      Number(samePriorEntity(right.subject, primary.subject)) - Number(samePriorEntity(left.subject, primary.subject)) ||
      factSpecificBridgeScore(right, bridgeAnchors) - factSpecificBridgeScore(left, bridgeAnchors) ||
      factCompletenessScore(right, anchors) - factCompletenessScore(left, anchors) ||
      right.score - left.score ||
      right.support - left.support
    )
    .slice(0, 8);
}

function semanticAnswerSlots(facts: readonly LearnedGraphPriorFact[], hasher: { digestHex(input: string | Uint8Array): string }): SemanticAnswerSlot[] {
  const byRelation = new Map<string, LearnedGraphPriorFact[]>();
  for (const fact of facts) byRelation.set(fact.relationId, [...(byRelation.get(fact.relationId) ?? []), fact]);
  return [...byRelation.entries()]
    .map(([relationId, rows]) => ({
      id: `answer.slot:${hasher.digestHex(relationId).slice(0, 16)}`,
      relationIds: [relationId],
      factKeys: rows.map(semanticFactKey),
      support: mean(rows.map(row => row.support)),
      activation: mean(rows.map(row => row.activation))
    }))
    .sort((left, right) => right.support - left.support || right.activation - left.activation)
    .slice(0, 12);
}

function semanticQuestionShapeId(facts: readonly LearnedGraphPriorFact[], requestText: string, hasher: { digestHex(input: string | Uint8Array): string }, alphaPlan?: AlphaRhetoricalPlan): string {
  const relationMass = uniqueKernelStrings(facts.map(fact => fact.relationId)).slice(0, 8);
  const anchorMass = [...priorRequestAnchors(requestText)].slice(0, 8);
  const roleMass = alphaPlan?.selectedRoleIds ?? [];
  return `question.shape:${hasher.digestHex(JSON.stringify({ relationMass, anchorMass, roleMass })).slice(0, 16)}`;
}

function factCompletenessScore(fact: LearnedGraphPriorFact, anchors: ReadonlySet<string>): number {
  return factRequestAnchorScore(fact, anchors) * 0.46 + fact.activation * 0.24 + fact.support * 0.18 + fact.overlap * 0.12;
}

function semanticFactKey(fact: Pick<LearnedGraphPriorFact, "subject" | "predicate" | "object" | "relationId">): string {
  return normalizePriorKey(`${fact.subject}\u0001${fact.predicate}\u0001${fact.object}\u0001${fact.relationId}`);
}

function priorRequestAnchors(text: string): Set<string> {
  const anchors = new Set(requestContentPriorUnits(text).filter(unit => unit.length >= 5));
  const contentUnits = requestContentPriorUnits(text)
    .map(stripOuterPriorSeparators)
    .filter(unit => unit.length >= 3 && !genericQuestionSignal(unit));
  for (const unit of splitPriorUnits(collapsePriorWhitespace(requestContentSurface(text)))) {
    const clean = stripOuterPriorSeparators(unit);
    if (clean.length >= 3 && clean.length < 5 && hasPriorAnchorSignal(clean)) anchors.add(normalizePriorKey(clean));
  }
  for (let index = 0; index < contentUnits.length - 1; index++) {
    const left = contentUnits[index] ?? "";
    const right = contentUnits[index + 1] ?? "";
    if (left.length >= 3 && right.length >= 3) anchors.add(`${left} ${right}`);
  }
  for (let index = 0; index < contentUnits.length - 2; index++) {
    const left = contentUnits[index] ?? "";
    const middle = contentUnits[index + 1] ?? "";
    const right = contentUnits[index + 2] ?? "";
    if (left.length >= 3 && middle.length >= 3 && right.length >= 3) anchors.add(`${left} ${middle} ${right}`);
  }
  const focuses = relevanceRequestFocuses(text).slice(0, 10);
  for (let index = 0; index < focuses.length - 1; index++) {
    const left = focuses[index] ?? "";
    const right = focuses[index + 1] ?? "";
    if (left.length >= 3 && right.length >= 3) anchors.add(`${left} ${right}`);
  }
  for (let index = 0; index < focuses.length - 2; index++) {
    const left = focuses[index] ?? "";
    const middle = focuses[index + 1] ?? "";
    const right = focuses[index + 2] ?? "";
    if (left.length >= 3 && middle.length >= 3 && right.length >= 3) anchors.add(`${left} ${middle} ${right}`);
  }
  return anchors;
}

function hasPriorAnchorSignal(value: string): boolean {
  return hasUppercaseLetter(value) || hasUncasedNonLatinLetter(value);
}

function factRequestAnchorScore(fact: LearnedGraphPriorFact, anchors: ReadonlySet<string>): number {
  if (!anchors.size) return 0;
  const subjectKey = normalizePriorKey(fact.subject);
  const objectKey = normalizePriorKey(fact.object);
  const predicateKey = normalizePriorKey(fact.predicate);
  const subjectUnits = splitPriorUnits(subjectKey);
  const objectUnits = splitPriorUnits(objectKey);
  const predicateUnits = splitPriorUnits(predicateKey);
  let phraseScore = 0;
  for (const anchor of anchors) {
    if (!anchor.includes(" ")) continue;
    if (subjectKey === anchor) phraseScore += 8;
    else if (subjectKey.includes(anchor)) phraseScore += 6;
    else if (objectKey.includes(anchor)) phraseScore += 3;
    else if (predicateKey.includes(anchor)) phraseScore += 1;
  }
  const subjectScore = subjectUnits.filter(unit => anchors.has(unit)).length * 2;
  const objectScore = objectUnits.filter(unit => anchors.has(unit)).length;
  const predicateScore = predicateUnits.filter(unit => anchors.has(unit)).length * 0.5;
  return phraseScore + subjectScore + objectScore + predicateScore;
}

function factTopicMatchesSelected(fact: LearnedGraphPriorFact, selectedSubject: string): boolean {
  return factSubjectMatchesSelected(fact, selectedSubject) || factObjectMatchesSelected(fact, selectedSubject);
}

function factSubjectMatchesSelected(fact: LearnedGraphPriorFact, selectedSubject: string): boolean {
  const subject = normalizePriorKey(fact.subject);
  const selected = normalizePriorKey(selectedSubject);
  if (!subject || !selected) return false;
  if (subject === selected || subject.startsWith(`${selected} `) || selected.startsWith(`${subject} `)) return true;
  if (!subject.includes(selected)) return false;
  return semanticPriorSurfaceMass(subject) <= Math.max(8, semanticPriorSurfaceMass(selected) + 5);
}

function factObjectMatchesSelected(fact: LearnedGraphPriorFact, selectedSubject: string): boolean {
  const object = normalizePriorKey(fact.object);
  const selected = normalizePriorKey(selectedSubject);
  if (!object || !selected) return false;
  return object === selected || object.startsWith(`${selected} `) || selected.startsWith(`${object} `);
}

function questionShapeAllowsPriorFact(fact: LearnedGraphPriorFact, requestText: string): boolean {
  void requestText;
  if (!factQuestionFitAllowsSurface(fact)) return false;
  if (lowValueCatalogFact(fact)) return false;
  if (fact.questionEdgeFit.relationRoleId === RELATION_ROLE_IDS.graphNavigation) return false;
  return fact.graphQuality.answerGrade ||
    fact.questionEdgeFit.finalQuestionFit >= 0.44 ||
    fact.questionEdgeFit.requestedSlotId === GRAPH_SLOT_IDS.requestAlignedRelation;
}

function lowValueCatalogFact(fact: LearnedGraphPriorFact): boolean {
  const role = fact.questionEdgeFit.relationRoleId;
  const fit = fact.questionEdgeFit.finalQuestionFit;
  const quality = fact.graphQuality;
  if (role === RELATION_ROLE_IDS.graphNavigation) return true;
  if (quality.classId === GRAPH_QUALITY_CLASS_IDS.noisyMarkup || quality.classId === GRAPH_QUALITY_CLASS_IDS.redirectAlias || quality.classId === GRAPH_QUALITY_CLASS_IDS.titleHint) return true;
  if (temporalOrQuantityCatalogSurface(fact.subject) && fit < 0.7) return true;
  if (temporalOrQuantityCatalogSurface(fact.object) && fit < 0.62 && role !== RELATION_ROLE_IDS.graphRequestRelation) return true;
  if (quality.classId === GRAPH_QUALITY_CLASS_IDS.catalogNavigation) return !(role === RELATION_ROLE_IDS.graphRequestMembership && fit >= 0.5 && semanticPriorSurfaceMass(fact.object) > 1);
  if (quality.classId === GRAPH_QUALITY_CLASS_IDS.weakFragment && fit < 0.5 && fact.overlap < 0.08) return true;
  if (quality.fragmentScore >= 0.62 && fit < 0.64) return true;
  return false;
}

function temporalOrQuantityCatalogSurface(value: string): boolean {
  const units = splitPriorUnits(normalizePriorKey(value));
  if (!units.length) return false;
  const numeric = units.filter(numericCatalogUnit).length;
  if (!numeric) return false;
  return numeric / units.length >= 0.5 || (units.length <= 3 && numeric > 0);
}

function numericCatalogUnit(unit: string): boolean {
  let digits = 0;
  let letters = 0;
  for (const char of unit) {
    if (char >= "0" && char <= "9") digits++;
    else if (char.toLocaleLowerCase() !== char.toLocaleUpperCase()) letters++;
  }
  return digits > 0 && (letters === 0 || digits >= letters);
}

function graphNodeSurface(node: GraphNode | undefined): string {
  if (!node) return "";
  const representation = node.representation;
  if (typeof representation === "string") return representation;
  const record = jsonRecord(representation);
  for (const key of ["names", "aliases"]) {
    const value = kernelStringArray(record[key])[0];
    if (value) return value;
  }
  for (const key of ["name", "label", "text", "textPreview", "conceptId", "title", "body"]) {
    const value = kernelString(record[key]);
    if (value) return sourceTextSurface(value, 900) || value;
  }
  return String(node.id);
}

function cleanPriorTerm(value: string): CleanPriorTerm {
  let text = collapsePriorWhitespace(value.normalize("NFKC"));
  let markerId: string | undefined;
  for (let pass = 0; pass < 4; pass++) {
    text = stripOuterPriorSeparators(text);
    const stripped = stripLeadingPriorSchemaMarker(text);
    if (!stripped) break;
    markerId = stripped.markerId;
    text = stripped.text;
  }
  return { text: stripOuterPriorSeparators(collapsePriorWhitespace(text)), markerId };
}

function stripLeadingPriorSchemaMarker(text: string): CleanPriorTerm | undefined {
  const markers = ["body", "sentence", "answer", "question", "title", "text", "object"];
  const lower = text.toLocaleLowerCase();
  for (const marker of markers) {
    if (!lower.startsWith(marker)) continue;
    const next = text[marker.length] ?? "";
    if (next && !isPriorSeparator(next)) continue;
    let index = marker.length;
    while (index < text.length && isPriorSeparator(text[index] ?? "")) index++;
    return { markerId: marker, text: text.slice(index).trim() };
  }
  return undefined;
}

function stripOuterPriorSeparators(value: string): string {
  let start = 0;
  let end = value.length;
  while (start < end && isPriorSeparator(value[start] ?? "")) start++;
  while (end > start && isPriorSeparator(value[end - 1] ?? "")) end--;
  return value.slice(start, end).trim();
}

function isPriorSeparator(char: string): boolean {
  return char === "\\" || char === "\"" || char === "'" || char === ":" || char === "," || char === "." || char === ";" || char === "?" || char === "!" || char === "{" || char === "}" || char === "[" || char === "]" || isPriorWhitespace(char);
}

function collapsePriorWhitespace(value: string): string {
  let out = "";
  let pendingSpace = false;
  for (const char of value) {
    if (isPriorWhitespace(char)) {
      pendingSpace = out.length > 0;
      continue;
    }
    if (pendingSpace) out += " ";
    out += char;
    pendingSpace = false;
  }
  return out.trim();
}

function isPriorWhitespace(char: string): boolean {
  return char === " " || char === "\t" || char === "\n" || char === "\r";
}

function displayPriorTerm(value: string, role: "subject" | "object"): string {
  const clean = stripOuterPriorSeparators(collapsePriorWhitespace(value));
  if (role === "object") return clean;
  return titleCaseShortPriorTerm(clean);
}

function titleCaseShortPriorTerm(value: string): string {
  const units = splitPriorUnits(value);
  if (!units.length || units.length > 6) return uppercaseInitial(value);
  return units.map(uppercaseInitial).join(" ");
}

function splitPriorUnits(value: string): string[] {
  const units: string[] = [];
  let current = "";
  for (const char of value) {
    if (isPriorWhitespace(char)) {
      if (current) units.push(current);
      current = "";
      continue;
    }
    current += char;
  }
  if (current) units.push(current);
  return units;
}

function uppercaseInitial(value: string): string {
  if (!value) return value;
  const first = value[0] ?? "";
  return `${first.toLocaleUpperCase()}${value.slice(1)}`;
}

function normalizePriorKey(value: string): string {
  return collapsePriorWhitespace(value.toLocaleLowerCase());
}

function samePriorEntity(left: string, right: string): boolean {
  const a = normalizePriorKey(left);
  const b = normalizePriorKey(right);
  return a === b || a.includes(b) || b.includes(a);
}

function overlapsPriorTerm(left: string, right: string): boolean {
  const leftUnits = splitPriorUnits(normalizePriorKey(left)).filter(unit => unit.length > 3);
  const rightUnits = new Set(splitPriorUnits(normalizePriorKey(right)).filter(unit => unit.length > 3));
  if (!leftUnits.length || !rightUnits.size) return false;
  return leftUnits.some(unit => rightUnits.has(unit));
}

function priorAnchorUnits(facts: readonly LearnedGraphPriorFact[]): Set<string> {
  const anchors = new Set<string>();
  for (const fact of facts) {
    for (const unit of [...splitPriorUnits(normalizePriorKey(fact.subject)), ...splitPriorUnits(normalizePriorKey(fact.object))]) {
      if (unit.length > 3) anchors.add(unit);
    }
  }
  return anchors;
}

function specificPriorBridgeAnchors(facts: readonly LearnedGraphPriorFact[]): Set<string> {
  const anchors = new Set<string>();
  for (const fact of facts) {
    addSpecificPriorBridgeSurface(anchors, fact.object);
  }
  return anchors;
}

function addSpecificPriorBridgeSurface(anchors: Set<string>, value: string): void {
  const normalized = normalizePriorKey(value);
  const units = splitPriorUnits(normalized);
  if (units.length >= 2) anchors.add(normalized);
  for (const unit of units) {
    if (unit.length >= 8) anchors.add(unit);
  }
}

function factSpecificBridgeScore(fact: LearnedGraphPriorFact, anchors: ReadonlySet<string>): number {
  if (!anchors.size) return 0;
  let score = 0;
  for (const surface of [fact.subject, fact.object]) {
    const normalized = normalizePriorKey(surface);
    if (anchors.has(normalized)) score += 3;
    for (const unit of splitPriorUnits(normalized)) {
      if (unit.length >= 8 && anchors.has(unit)) score += 1;
    }
  }
  return score;
}

function factSharesSpecificPriorAnchor(fact: LearnedGraphPriorFact, anchors: ReadonlySet<string>): boolean {
  return factSpecificBridgeScore(fact, anchors) > 0;
}

function factSharesPriorAnchor(fact: LearnedGraphPriorFact, anchors: ReadonlySet<string>): boolean {
  if (!anchors.size) return false;
  for (const unit of [...splitPriorUnits(normalizePriorKey(fact.subject)), ...splitPriorUnits(normalizePriorKey(fact.object))]) {
    if (unit.length > 3 && anchors.has(unit)) return true;
  }
  return false;
}

function kernelString(value: JsonValue | undefined): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function kernelNumber(value: JsonValue | undefined, fallback = 0): number {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim()) {
    const numeric = Number(value);
    if (Number.isFinite(numeric)) return numeric;
  }
  return fallback;
}

function kernelStringArray(value: JsonValue | undefined): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string" && item.trim().length > 0) : [];
}

function uniqueKernelStrings(values: readonly string[]): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const value of values) {
    const clean = value.trim();
    if (!clean || seen.has(clean)) continue;
    seen.add(clean);
    out.push(clean);
  }
  return out;
}

function learningAcquisitionCapabilityPlans(input: {
  episodeId: EpisodeId;
  learningLoopPlan: LearningLoopPlan;
  policy: PolicyProfile;
  connectorsConfigured: boolean;
  idFactory: ReturnType<typeof createIdFactory>;
  now: number;
}): CapabilityPlan[] {
  const registry = createCapabilityRegistry({
    filesystem: true,
    process: true,
    network: input.connectorsConfigured,
    outlook: input.connectorsConfigured,
    youtube: input.connectorsConfigured,
    telephone: input.connectorsConfigured
  });
  const planner = createActionPlanner({ idFactory: input.idFactory, policy: input.policy });
  const sourcePlans = [
    ...input.learningLoopPlan.learningNeeds.flatMap(need => need.sourcePlans),
    ...input.learningLoopPlan.globalSources
  ]
    .filter(plan => plan.acquisition.acquire)
    .sort((a, b) => b.utility - a.utility || b.expectedValue - a.expectedValue);
  const seen = new Set<string>();
  const out: CapabilityPlan[] = [];
  for (const sourcePlan of sourcePlans) {
    if (out.length >= 12) break;
    const key = `${sourcePlan.capabilityId}:${sourcePlan.query}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const capability = registry.get(sourcePlan.capabilityId);
    if (!capability) continue;
    const payload = learningAcquisitionPayload(sourcePlan);
    out.push(planner.plan({ episodeId: input.episodeId, capability, payload, now: input.now + out.length, approved: false }));
  }
  return out;
}

function learningAcquisitionPayload(plan: LearningSourcePlan): JsonValue {
  return toJsonValue({
    kind: "learning_source_acquisition",
    sourcePlanId: plan.id,
    sourceKind: plan.kind,
    query: plan.query,
    evi: plan.expectedValue,
    utility: plan.utility,
    capabilityId: plan.capabilityId,
    acquisition: {
      stages: [
        plan.acquisition.acquire ? "acquisition" : undefined,
        plan.acquisition.quarantine ? "quarantine" : undefined,
        plan.acquisition.extract ? "extraction" : undefined,
        plan.acquisition.validate ? "validation" : undefined,
        plan.acquisition.promote,
        plan.acquisition.graphUpdate ? "graph_update" : undefined
      ].filter(Boolean),
      quarantineRequired: plan.acquisition.quarantine,
      promotion: plan.acquisition.promote,
      mutatingCommitAllowed: false
    },
    objective: {
      expectedInformationGain: plan.expectedInformationGain,
      taskProgress: plan.taskProgress,
      proofValue: plan.proofValue,
      cost: plan.cost,
      risk: plan.risk,
      permissionPenalty: plan.permissionPenalty
    },
    rationale: plan.rationale
  });
}

function translationTargetFromMetadata(metadata: JsonValue | undefined): string | undefined {
  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) return undefined;
  const record = metadata as Record<string, JsonValue>;
  for (const key of ["translationTarget", "targetLanguage", "target_language", "translateTo"]) {
    const value = record[key];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return undefined;
}

function surfaceDetailProfileIdFromMetadata(metadata: JsonValue | undefined): string | undefined {
  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) return undefined;
  const record = metadata as Record<string, JsonValue>;
  const explicit = record.detailProfileId;
  if (typeof explicit === "string" && explicit.trim()) return explicit;
  const vector = numericVector(record.detailVector ?? record.surfaceDetailVector);
  if (vector?.length) return resolveDetailProfileId({ registerVector: vector, styleDensity: vector[0] });
  return undefined;
}

function numericVector(value: JsonValue | undefined): number[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const out: number[] = [];
  for (const item of value) {
    if (typeof item !== "number" || !Number.isFinite(item)) return undefined;
    out.push(Math.max(0, Math.min(1, item)));
  }
  return out;
}

function styleProfileIdFromMetadata(metadata: JsonValue | undefined): string | undefined {
  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) return undefined;
  const value = (metadata as Record<string, JsonValue>).styleProfileId;
  return typeof value === "string" && value.trim() ? value : undefined;
}

function registerIdFromMetadata(metadata: JsonValue | undefined): string | undefined {
  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) return undefined;
  const value = (metadata as Record<string, JsonValue>).registerId;
  return typeof value === "string" && value.trim() ? value : undefined;
}

function mergeCorrectionRules<T extends { id: string; updatedAt: number; weight: number }>(stored: readonly T[], detected: readonly T[]): T[] {
  const byId = new Map<string, T>();
  for (const rule of [...stored, ...detected]) {
    const existing = byId.get(rule.id);
    if (!existing || rule.updatedAt > existing.updatedAt || rule.weight > existing.weight) byId.set(rule.id, rule);
  }
  return [...byId.values()].sort((a, b) => b.weight - a.weight || b.updatedAt - a.updatedAt).slice(0, 128);
}

function runtimeLanguageProfile(now: number): LanguageProfile {
  return {
    id: "surface-und",
    sourceVersionId: "source_version_surface_runtime" as never,
    scripts: [{ script: "und", mass: 1 }],
    symbolShapes: [],
    charNgrams: [],
    direction: "unknown",
    entropy: 0,
    createdAt: now
  };
}

function requiresExplicitApproval(plan: CapabilityPlan): boolean {
  const permission = plan.permission;
  if (!permission || typeof permission !== "object" || Array.isArray(permission)) return false;
  const record = permission as Record<string, JsonValue>;
  return record.requiresExplicitApproval === true || record.mode === "explicit" || record.allowed === false && plan.phase === "commit";
}

async function* inlineIngestStream(input: IngestInput, now: number, hasher: ReturnType<typeof createHasher>): AsyncIterable<{ type: "file"; file: IngestedSourceFile; checkpoint: IngestionCheckpoint }> {
  const bytes = typeof input.content === "string" ? Buffer.from(input.content, "utf8") : new Uint8Array(input.content ?? new Uint8Array());
  const text = redactSecrets(typeof input.content === "string" ? input.content : Buffer.from(bytes).toString("utf8"));
  const uri = input.uri ?? "inline://owner-content";
  const hash = `sha256_${hasher.digestHex(bytes)}` as ContentHash;
  yield {
    type: "file",
    file: {
      uri,
      namespace: input.namespace ?? "inline",
      mediaType: input.mediaType ?? "text/plain",
      bytes,
      text,
      metadata: input.metadata ?? null
    },
    checkpoint: {
      id: `ingest_${hasher.digestHex(`${uri}\u001f${hash}`).slice(0, 32)}`,
      rootUri: uri,
      itemUri: uri,
      phase: "extracted",
      status: "complete",
      offsetBytes: bytes.byteLength,
      contentHash: hash,
      byteLength: bytes.byteLength,
      updatedAt: now,
      metadata: toJsonValue({ inline: true, mediaType: input.mediaType ?? "text/plain" })
    }
  };
}

function routeStoreCounts(routes: Array<{ durableStores: string[] }>): Record<string, number> {
  const out: Record<string, number> = {};
  for (const route of routes) for (const store of route.durableStores) out[store] = (out[store] ?? 0) + 1;
  return out;
}

function sumRecord(record: Record<string, number>): number {
  return Object.values(record).reduce((sum, value) => sum + value, 0);
}

function summarizeTypedCheckpoints(checkpoints: IngestionCheckpoint[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const checkpoint of checkpoints) {
    const typed = typedDiagnostics(checkpoint);
    const counts = typed?.observationCounts;
    if (!counts || typeof counts !== "object" || Array.isArray(counts)) continue;
    for (const [kind, raw] of Object.entries(counts as Record<string, JsonValue>)) {
      const count = typeof raw === "number" ? raw : 0;
      out[kind] = (out[kind] ?? 0) + count;
    }
  }
  return out;
}

function summarizeTypedRouteStores(checkpoints: IngestionCheckpoint[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const checkpoint of checkpoints) {
    const typed = typedDiagnostics(checkpoint);
    const routeCounts = typed?.routeCounts;
    if (!routeCounts || typeof routeCounts !== "object" || Array.isArray(routeCounts)) continue;
    for (const [store, raw] of Object.entries(routeCounts as Record<string, JsonValue>)) {
      const count = typeof raw === "number" ? raw : 0;
      out[store] = (out[store] ?? 0) + count;
    }
  }
  return out;
}

function summarizeCodebaseCheckpoints(checkpoints: IngestionCheckpoint[]): JsonValue {
  const parsers = new Map<string, number>();
  const roles = new Map<string, number>();
  const dependencies = new Map<string, number>();
  const importedModules = new Map<string, number>();
  const declarationKinds = new Map<string, number>();
  const packageScripts = new Map<string, number>();
  const repositories = new Map<string, {
    files: number;
    parserFacts: number;
    declarations: number;
    imports: number;
    routes: number;
    tests: number;
    packages: number;
    packageNames: Set<string>;
    roles: Map<string, number>;
  }>();
  const repositoryManifests: JsonValue[] = [];
  const routeInventory: Array<{ repository: string; file: string; method: string; path: string; handlerHint?: string }> = [];
  const testInventory: Array<{ repository: string; file: string; name?: string; runnerHint?: string }> = [];
  let files = 0;
  let parserFacts = 0;
  let declarations = 0;
  let imports = 0;
  let routes = 0;
  let tests = 0;
  let packages = 0;
  for (const checkpoint of checkpoints) {
    const metadata = checkpoint.metadata && typeof checkpoint.metadata === "object" && !Array.isArray(checkpoint.metadata) ? checkpoint.metadata as Record<string, JsonValue> : {};
    const codebase = metadata.codebase && typeof metadata.codebase === "object" && !Array.isArray(metadata.codebase) ? metadata.codebase as Record<string, JsonValue> : undefined;
    const facts = sourceCodeFileFactsFromJson(metadata.sourceCode);
    const repositoryFacts = sourceRepositoryFactsFromJson(metadata.repositoryFacts);
    if (repositoryFacts) {
      repositoryManifests.push(repositoryManifestSummary(repositoryFacts));
      const repo = repositorySummary(repositories, repositoryFacts.normalizedRootUri);
      repo.files = Math.max(repo.files, repositoryFacts.workspace.fileCount);
      repo.declarations = Math.max(repo.declarations, repositoryFacts.workspace.declarationCount);
      repo.imports = Math.max(repo.imports, repositoryFacts.workspace.importCount);
      repo.routes = Math.max(repo.routes, repositoryFacts.workspace.routeCount);
      repo.tests = Math.max(repo.tests, repositoryFacts.workspace.testFileCount);
      repo.packages = Math.max(repo.packages, repositoryFacts.workspace.packageCount);
      for (const pkg of repositoryFacts.packages) if (pkg.name) repo.packageNames.add(pkg.name);
      continue;
    }
    if (!codebase && !facts) continue;
    const repositoryId = typeof codebase?.rootUri === "string" && codebase.rootUri ? codebase.rootUri : "codebase:unresolved";
    const repo = repositorySummary(repositories, repositoryId);
    files++;
    repo.files++;
    if (facts) {
      parserFacts++;
      repo.parserFacts++;
      parsers.set(facts.parser.id, (parsers.get(facts.parser.id) ?? 0) + 1);
      declarations += facts.declarations.length;
      repo.declarations += facts.declarations.length;
      imports += facts.imports.length;
      repo.imports += facts.imports.length;
      routes += facts.routes.length;
      repo.routes += facts.routes.length;
      tests += facts.tests.length;
      repo.tests += facts.tests.length;
      for (const item of facts.imports) addCount(importedModules, item.moduleSpecifier);
      for (const item of facts.declarations) addCount(declarationKinds, item.kind);
      for (const item of facts.routes.slice(0, 256)) routeInventory.push({ repository: repositoryId, file: facts.normalizedPath, method: item.method, path: item.path, handlerHint: item.handlerHint });
      for (const item of facts.tests.slice(0, 256)) testInventory.push({ repository: repositoryId, file: facts.normalizedPath, name: item.name, runnerHint: item.runnerHint });
      if (facts.packageFacts) {
        packages++;
        repo.packages++;
        if (facts.packageFacts.name) repo.packageNames.add(facts.packageFacts.name);
        for (const script of facts.packageFacts.scripts) addCount(packageScripts, script.name);
        for (const dep of facts.packageFacts.dependencies) addCount(dependencies, dep.name);
      }
      for (const role of facts.roleEvidence) {
        addCount(roles, role.roleId);
        addCount(repo.roles, role.roleId);
      }
    } else if (typeof codebase?.parserFactsPresent === "boolean" && codebase.parserFactsPresent) {
      parserFacts++;
      repo.parserFacts++;
    }
  }
  return toJsonValue({
    files,
    parserFacts,
    parserCoverage: files ? parserFacts / files : 0,
    declarations,
    imports,
    routes,
    tests,
    packages,
    parsers: sortedRecord(parsers),
    roles: sortedRecord(roles),
    topImportedModules: topCounts(importedModules, 32),
    topDependencies: topCounts(dependencies, 32),
    declarationKinds: sortedRecord(declarationKinds),
    packageScripts: topCounts(packageScripts, 32),
    repositoryManifests,
    routeInventory: routeInventory.slice(0, 256),
    testInventory: testInventory.slice(0, 256),
    repositories: [...repositories.entries()].map(([id, repo]) => ({
      id,
      files: repo.files,
      parserFacts: repo.parserFacts,
      parserCoverage: repo.files ? repo.parserFacts / repo.files : 0,
      declarations: repo.declarations,
      imports: repo.imports,
      routes: repo.routes,
      tests: repo.tests,
      packages: repo.packages,
      packageNames: [...repo.packageNames].sort(),
      roles: sortedRecord(repo.roles)
    })).sort((a, b) => b.files - a.files || a.id.localeCompare(b.id))
  });
}

function repositoryManifestSummary(facts: ReturnType<typeof sourceRepositoryFactsFromJson>): JsonValue {
  if (!facts) return null;
  return toJsonValue({
    rootUri: facts.normalizedRootUri,
    workspace: facts.workspace,
    packageManagers: facts.workspace.packageManagers,
    packages: facts.packages.map(pkg => ({ manifestPath: pkg.manifestPath, name: pkg.name, version: pkg.version, scripts: pkg.scripts.map(script => script.name), dependencies: pkg.dependencies.length })),
    distributions: facts.distributions,
    graphNodes: facts.graph.nodes.length,
    graphEdges: facts.graph.edges.length
  });
}

function repositorySummary(repositories: Map<string, {
  files: number;
  parserFacts: number;
  declarations: number;
  imports: number;
  routes: number;
  tests: number;
  packages: number;
  packageNames: Set<string>;
  roles: Map<string, number>;
}>, id: string) {
  let summary = repositories.get(id);
  if (!summary) {
    summary = { files: 0, parserFacts: 0, declarations: 0, imports: 0, routes: 0, tests: 0, packages: 0, packageNames: new Set<string>(), roles: new Map<string, number>() };
    repositories.set(id, summary);
  }
  return summary;
}

function addCount(map: Map<string, number>, key: string): void {
  if (!key) return;
  map.set(key, (map.get(key) ?? 0) + 1);
}

function sortedRecord(map: Map<string, number>): Record<string, number> {
  return Object.fromEntries([...map.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])));
}

function topCounts(map: Map<string, number>, limit: number): Array<{ value: string; count: number }> {
  return [...map.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, limit)
    .map(([value, count]) => ({ value, count }));
}

function typedDiagnostics(checkpoint: IngestionCheckpoint): Record<string, JsonValue> | undefined {
  const metadata = checkpoint.metadata;
  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) return undefined;
  const typed = (metadata as Record<string, JsonValue>).typedIngest;
  return typed && typeof typed === "object" && !Array.isArray(typed) ? typed as Record<string, JsonValue> : undefined;
}

function learningNeedsFor(text: string, entailment: TurnResult["entailment"], evidence: EvidenceSpan[], locale?: string): string[] {
  const needs: string[] = [];
  if (evidence.length < 2 || entailment.faithfulnessLcb < 0.2) needs.push(formatSurfaceMessage("learning.need.evidence", { text: text.slice(0, 180) }, locale));
  if (entailment.contradiction > 0.2) needs.push(formatSurfaceMessage("learning.need.contradiction", { claim: entailment.claim.normalized.slice(0, 180) }, locale));
  return needs;
}

function pcaForceForMouthSurface(spoken: { surfacePlan?: { audit?: JsonValue } }, selectedForce: EpistemicForce): EpistemicForce {
  const policy = jsonRecord(jsonRecord(spoken.surfacePlan?.audit).forceAwareAnswerPolicy);
  const policyId = typeof policy.policyId === "string" ? policy.policyId : "";
  const boundaryId = typeof policy.boundaryId === "string" ? policy.boundaryId : "";
  const certifies = policy.allowsExternalFactCertification === true;
  if (!certifies && policyId === "learned_prior_summary" && boundaryId === "import_bound") return "conjectured";
  return selectedForce;
}

function forceScore(force: string): number {
  return force === "proved" ? 1 : force === "observed" ? 0.85 : force === "inferred" ? 0.65 : force === "conjectured" ? 0.45 : force === "invented" ? 0.35 : 0.1;
}

function languageScore(evidence: EvidenceSpan[]): number {
  const scripts = new Set(evidence.flatMap(span => ((span.languageHints as { scripts?: Array<{ script: string }> }).scripts ?? []).map(item => item.script)));
  return scripts.size > 1 ? 0.8 : scripts.size === 1 ? 0.55 : 0.3;
}

function jsonRecord(value: JsonValue | undefined): Record<string, JsonValue> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, JsonValue> : {};
}

function positiveRuntimeInt(name: string, fallback: number): number {
  const raw = runtimeEnv(name);
  if (!raw) return fallback;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function runtimeFlag(name: string, fallback: boolean): boolean {
  const raw = runtimeEnv(name);
  if (!raw) return fallback;
  const clean = raw.trim().toLowerCase();
  if (["0", "false", "off", "no"].includes(clean)) return false;
  if (["1", "true", "on", "yes"].includes(clean)) return true;
  return fallback;
}

function runtimeEnv(name: string): string | undefined {
  const globalWithProcess = globalThis as typeof globalThis & { process?: { env?: Record<string, string | undefined> } };
  return globalWithProcess.process?.env?.[name];
}

function estimateRuntimeGraphSliceBytes(value: RuntimeGraphSliceValue): number {
  let bytes = 2048;
  for (const node of value.graph.nodes) {
    bytes += 280;
    bytes += String(node.id).length * 2 + String(node.typeId).length * 2;
    bytes += node.features.reduce((sum, feature) => sum + feature.length * 2 + 24, 0);
    bytes += node.evidenceIds.reduce((sum, id) => sum + String(id).length * 2 + 16, 0);
    bytes += estimateJsonBytes(node.representation, 4096) + estimateJsonBytes(node.metadata, 4096);
  }
  for (const edge of value.graph.edges) {
    bytes += 260;
    bytes += String(edge.id).length * 2 + String(edge.source).length * 2 + String(edge.target).length * 2 + String(edge.relationId).length * 2;
    bytes += edge.evidenceIds.reduce((sum, id) => sum + String(id).length * 2 + 16, 0);
    bytes += estimateJsonBytes(edge.metadata, 2048);
  }
  for (const hyperedge of value.graph.hyperedges) {
    bytes += 220;
    bytes += String(hyperedge.id).length * 2 + String(hyperedge.relationId).length * 2;
    bytes += hyperedge.memberNodeIds.reduce((sum, id) => sum + String(id).length * 2 + 16, 0);
    bytes += hyperedge.provenanceRefs.reduce((sum, id) => sum + String(id).length * 2 + 16, 0);
    bytes += estimateJsonBytes(hyperedge.weightVector, 2048) + estimateJsonBytes(hyperedge.temporalScope, 2048);
  }
  for (const span of value.evidence) {
    bytes += 360;
    bytes += String(span.id).length * 2 + String(span.sourceId).length * 2 + String(span.sourceVersionId).length * 2;
    bytes += (span.text?.length ?? 0) * 2 + (span.textPreview?.length ?? 0) * 2;
    bytes += span.features.reduce((sum, feature) => sum + feature.length * 2 + 24, 0);
    bytes += estimateJsonBytes(span.languageHints, 2048) + estimateJsonBytes(span.scriptHints, 2048) + estimateJsonBytes(span.trustVector, 2048) + estimateJsonBytes(span.provenance, 4096);
  }
  return bytes;
}

function estimateJsonBytes(value: JsonValue | undefined, cap: number): number {
  if (value === undefined || value === null) return 0;
  try {
    return Math.min(cap, JSON.stringify(value).length * 2);
  } catch {
    return Math.min(512, cap);
  }
}

function fitRuntimeGraphSliceToBudget(value: RuntimeGraphSliceValue, budgetBytes: number): RuntimeGraphSliceValue {
  let current = value;
  let bytes = estimateRuntimeGraphSliceBytes(current);
  let nodeLimit = current.graph.nodes.length;
  let edgeLimit = current.graph.edges.length;
  let evidenceLimit = current.evidence.length;
  while (bytes > budgetBytes && nodeLimit > 256) {
    nodeLimit = Math.max(256, Math.floor(nodeLimit * 0.74));
    edgeLimit = Math.max(512, Math.floor(edgeLimit * 0.74));
    evidenceLimit = Math.max(128, Math.floor(evidenceLimit * 0.74));
    current = limitRuntimeGraphSlice(value, nodeLimit, edgeLimit, evidenceLimit);
    bytes = estimateRuntimeGraphSliceBytes(current);
  }
  return current;
}

function limitRuntimeGraphSlice(value: RuntimeGraphSliceValue, nodeLimit: number, edgeLimit: number, evidenceLimit: number): RuntimeGraphSliceValue {
  const nodes = value.graph.nodes.slice(0, nodeLimit);
  const nodeIds = new Set(nodes.map(node => String(node.id)));
  const edges = value.graph.edges
    .filter(edge => nodeIds.has(String(edge.source)) || nodeIds.has(String(edge.target)))
    .slice(0, edgeLimit);
  const hyperedges = value.graph.hyperedges
    .filter(edge => edge.memberNodeIds.some(nodeId => nodeIds.has(String(nodeId))))
    .slice(0, Math.max(64, Math.floor(edgeLimit / 4)));
  const evidenceIds = new Set(uniqueKernelStrings([
    ...nodes.flatMap(node => node.evidenceIds.map(String)),
    ...edges.flatMap(edge => edge.evidenceIds.map(String)),
    ...hyperedges.flatMap(edge => edge.provenanceRefs.map(String))
  ]));
  const evidence = value.evidence.filter(span => evidenceIds.has(String(span.id))).slice(0, evidenceLimit);
  return {
    graph: {
      ...value.graph,
      nodes,
      edges,
      hyperedges,
      query: { ...value.graph.query, limitNodes: nodeLimit, limitEdges: edgeLimit }
    },
    evidence
  };
}

function uniqueById<T extends { id: unknown }>(values: readonly T[]): T[] {
  const byId = new Map<string, T>();
  for (const value of values) {
    const id = String(value.id);
    if (!byId.has(id)) byId.set(id, value);
  }
  return [...byId.values()];
}
