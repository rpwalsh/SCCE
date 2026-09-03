import { createActionGraphBuilder } from "./action-graph.js";
import { createAlphaFieldPersistence } from "./alpha-field-persistence.js";
import { composeEvidenceGroundedAnswer } from "./answer-emitter.js";
import { revisionAnswerVersion, selectedCandidateRevisionQuality } from "./answer-revision-runtime.js";
import {
  createAnswerRevisionCoordinator
} from "./answer-revision.js";
import { assistantForceDecision } from "./assistant-force.js";
import { assistantForceProposalFromCandidateClaimBasis, attachCognitiveProposal, attachInventionConstruct, cognitiveProposalForCandidate, selectedInventionForCandidate } from "./candidate-construct-binding.js";
import { candidateIsSafeNonExecutingPlan, candidateUsesNonFactualPlanSemantics, selectedCandidateEntailment } from "./candidate-proof-policy.js";
import { createCandidateEngine, type CandidateSurface } from "./candidate.js";
import { createPfaceEstimator } from "./causal-estimation.js";
import { createCcrEngine } from "./ccr.js";
import { cognitiveProposalComparisonReceipt, planCognitiveProposals, type CognitiveActionPlan } from "./cognitive-planner.js";
import { createConnectorGovernance, defaultConnectorConfigs } from "./connector-governance.js";
import { createConstructSubstratePlanner } from "./construct-substrate.js";
import { CORPUS_ROLE_IDS } from "./corpus-registry.js";
import { createCorrectionMemory } from "./correction-memory.js";
import { compileCreativeRequestFrameFromCompatibilityModels, type CreativeRequestFrame } from "./creative-event-compatibility.js";
import { createCounterfactualCognition } from "./counterfactual-cognition.js";
import { traceEvent } from "./debug/trace.js";
import { updateDialogueState } from "./dialogue-pragmatics.js";
import { discourseObjectStateFromMetadata } from "./discourse-state.js";
import { createSemanticEntailmentEngine } from "./entailment.js";
import { consolidateEpisode } from "./episodic-memory-consolidation.js";
import { EVALUATION_COMPONENT_IDS, type EvaluationComponentId } from "./evaluation-flags.js";
import {
  createAblatedSupportEntailment,
  disabledLearnedSemanticRetrieval,
  emptyCcrResult,
  emptyPowerWalkResult,
  emptySemanticProofResult,
  emptySurfaceLanguageMemory,
  queryConditionedSemanticSeedAnchors,
  surfaceLanguageMemoryProfile
} from "./evaluation-runtime-bypass.js";
import { createEvaluationTrace, executeEvaluationComponent } from "./evaluation-trace.js";
import { createEventFactory } from "./events.js";
import { type ConsolidatedEpisode, retrieveRelevantEpisodes } from "./episodic-memory-consolidation.js";
import { evidenceCitations, formatCitationSuffix } from "./evidence-citation.js";
import { extractTemporalAnswerFromEvidence } from "./semantic-obligations.js";
import { induceOperatorFromLedger } from "./induced-reasoning-operator-runtime.js";
import { createAlphaFieldEngine } from "./field.js";
import { properNounEntityAnchors, realizeCreativeSection } from "./creative-section-realization.js";
import {
  counterfactualTraceFromRejectedCandidate,
  createFunctionalCognitionEngine,
  functionalCapabilityAuthorizationGate,
  functionalSelectionGate,
  personaHistoryFromEvents,
  personaSnapshotFromSelf,
  standingFunctionalGate,
  STANDING_FUNCTIONAL_COGNITION_TTL_MS,
  type CounterfactualTrace,
  type FunctionalSelectionGate,
  type StandingFunctionalCognition
} from "./functional-cognition.js";
import { counterfactualTracesFromCapabilityPreview } from "./functional-cognition-adapters.js";
import { runFunctionalCognitionOffProcess } from "./functional-cognition-offload.js";
import { POLICY_OBJECTIVE_SCHEMA_ID, policyGenomeFromDurable } from "./policy-evolution.js";
import { unavailableGovernanceObservation } from "./governance-observation.js";
import { runtimeFlag } from "./runtime-graph-cache.js";
import { createIdFactory } from "./ids.js";
import { planInventions } from "./invention-planner.js";
import { createJudge } from "./judge.js";
import { jsonRecord, kernelNumber, kernelString, kernelStringArray, uniqueKernelStrings } from "./kernel-answer-primitives.js";
import {
  mergeCorrectionRules,
  pcaForceForMouthSurface,
  registerIdFromMetadata,
  repoFilesFromMetadata,
  requiresExplicitApproval,
  runtimeLanguageProfile,
  sourceLanguageAliasFromMetadata,
  styleProfileIdFromMetadata,
  surfaceDetailProfileIdFromMetadata,
  translationTargetFromMetadata
} from "./kernel-input-controls.js";
import type { LanguageMemoryRuntimeState } from "./language-memory-runtime.js";
import { activeJoinProgram, createLanguageMemoryRuntime } from "./language-memory-runtime.js";
import {
  selectLanguageProfileClusterForSourceVersions
} from "./language.js";
import { launchContractForTurn, retrievalRoleTracesFromHybridRecall } from "./launch-contract.js";
import { learningAcquisitionCapabilityPlans, learningNeedsFor } from "./learning-acquisition-runtime.js";
import { createLearningLoop } from "./learning-loop.js";
import {
  arithmeticAnswerForText,
  assistantForceFromLocalEvidenceAudit,
  attachLocalEvidenceAnswerConstruct,
  createArithmeticEntailment,
  evidenceBatchFromSlice,
  bindSelectedEvidenceToEntailment,
  evidenceForRequest,
  evidenceWithGraphPreviewWindows,
  graphFilteredToEvidence,
  localEvidenceAnswerClaimSurface,
  localEvidenceAnswerProofExcerpts,
  localEvidenceAnswerSurface,
  proposeSourceExactEvidenceAnswer,
  requestSentenceSequences,
  runtimeEvidenceWindowsForRequest,
  sessionContextEvidenceEnabled,
  sourceAnchoredEvidenceForRequest,
  evidenceSpanProvenanceTitle,
  spanContainsRequestNearDuplicateSentence,
  temporalCounterexampleExpected
} from "./local-evidence-runtime.js";
import { formatSurfaceMessage, localeFromMetadata } from "./localization.js";
import {
  createDeterministicMouth,
  createMouth,
  type MouthSemanticInput,
  type SpokenOutput
} from "./mouth.js";
import { createMultilingualAcquisitionEngine } from "./multilingual-acquisition.js";
import {
  createTypedTemporalWalkEngine,
  expandPowerWalkSeedAnchors
} from "./powerwalk.js";
import { createPredictionLayer } from "./prediction.js";
import { clamp01, createClock, createHasher, featureSet, toJsonValue } from "./primitives.js";
import { collapseSurfaceWhitespace, surfaceUnits } from "./surface-linguistics.js";
import { createEmissionEngine, createProgramGraphBuilder, createValidationGraphBuilder } from "./program.js";
import { createProofCarryingAnswer } from "./proof-carrying-answer.js";
import { repoCognitionForTurn } from "./repo-cognition.js";
import { deriveClosedClassWords } from "./closed-class-words.js";
import { documentGenerationRequestFromMetadata, syncDocumentGenerationRequestForTurn } from "./document-generation-turn-request.js";
import { extendedGenerationDecision, extendedGenerationSessionForTurn, runExtendedGeneration } from "./extended-generation-turn.js";
import { checkAntiCopyGuard } from "./voice-profile.js";
import { buildConstructionAlgebra, searchTargetConditionedDerivation, semanticTargetFromGraph } from "./generative-derivation-runtime.js";
import { syncTaskResumptionSnapshotForTurn } from "./task-resumption-turn-request.js";
import { schedulableSubtasks } from "./hierarchical-task-decomposition.js";
import { solveTaskSchedule } from "./task-schedule-solver.js";
import { replan } from "./task-replanning.js";
import { CODE_CONSTRAINT } from "./code-learning.js";
import { exactComputationForText } from "./exact-computation.js";
import { syncUserModelStoreForTurn, userModelStoreToJson } from "./user-model-turn-request.js";
import { compileBuildTestSkillFromLedger, executeBuildTestSkill } from "./procedural-skill-runtime.js";
import { applyPragmaticsGuard, type PresentationPlan } from "./pragmatics-authorization-guard.js";
import { conflictingGraphEdgeIntervals } from "./graph-temporal.js";
import {
  activeRequestOperatorIds,
  admitCandidatesForAuthority,
  projectRequestAuthority,
  requestOperatorDialogueSupport,
  requestOperatorGraphSupport
} from "./request-authority.js";
import { hybridRecall } from "./retrieval.js";
import { createRuntimeAcquisition } from "./runtime-acquisition.js";
import { preferredLocalEvidenceAnswer } from "./local-evidence-runtime.js";
import { attachLearnedGraphPriorConstruct } from "./learned-graph-prior-runtime.js";
import { decideRuntimeCoherence } from "./runtime-coherence.js";
import { executableRuntimeDeadlineFromMetadata, type RuntimeDeadlineDecision } from "./runtime-deadline.js";
import { estimateKneserNeyGenerationCostMs } from "./runtime-cost-estimate.js";
import { createRuntimeGraphRetrieval, isCodeEvidenceSpan, isControlCorpusSpan } from "./runtime-graph-retrieval.js";
import { updateFtrlFromTurnOutcome } from "./sparse-ranking-outcome.js";
import { createRuntimeMemoryControl } from "./runtime-memory-control.js";
import type { RuntimeReplanMotion } from "./runtime-motion.js";
import {
  RUNTIME_TERMINAL_INVENTION_POLICY_ID,
  attachRuntimeDiagnosticConstruct,
  attachRuntimeMotionConstruct,
  explicitRuntimeDiagnosticRequest,
  fastRuntimeBudgetRequested,
  metadataWithRuntimeReplanMotion,
  previousDialogueStateFromMetadata,
  priorRejectedHypothesesFromCandidates,
  requestedConversationIdFromMetadata,
  reviveMatchingPriorRejectedHypothesis,
  runtimeCandidateReplanTrigger,
  runtimeMotionCandidateField,
  runtimeReplanMotionFromMetadata,
  runtimeTerminalInventionIsAdmissible,
  runtimeTerminalInventionPriorContext,
  uniqueInventionConstructs
} from "./runtime-motion.js";
import { createRuntimeOrchestrator } from "./runtime-orchestrator.js";
import { runtimeWorkspacePlanContext } from "./runtime-workspace-plan-context.js";
import { createSafetyRailEngine } from "./safety-rail-engine.js";
import { createActionPlanner, createCapabilityRegistry } from "./safety.js";
import { createFunctionalConsciousnessScore, createSpectralSelfDistillation } from "./self-distillation.js";
import { createFunctionalSelfModel } from "./self.js";
import { consolidateSemanticClaims, type SemanticClaimObservation } from "./semantic-memory-consolidation.js";
import { createSemanticMemoryIndex } from "./semantic-memory-index.js";
import { createSemanticProofSystem } from "./semantic-proof-system.js";
import type { ScceKernelDeps } from "./storage.js";
import { createSurfaceLanguageRuntime } from "./surface-language-runtime.js";
import { createAutonomousToolCognition } from "./tool-cognition.js";
import { createTrainingOrchestrator } from "./training-orchestrator.js";
import { canonicalTranslationTargetKey, createTranslationEngine, type TranslationPlan } from "./translation.js";
import { CALIBRATION_IDS, CALIBRATION_SUBSYSTEM_IDS, CALIBRATION_TASK_CLASS_IDS, calibrationObservationRecord } from "./calibration-spine.js";
import {
  afterTurnMaintenanceDecision,
  previewTraceText
} from "./turn-maintenance-policy.js";
import {
  calibrationTaskClassForRequirements,
  evaluationQuestionId,
  explicitTurnRequirementsFromInput,
  operatorOutcomeSupport,
  requestedAuthorityFromTurnInput,
  requirementContextFromMetadata
} from "./turn-request-control.js";
import {
  TURN_REQUIREMENT_DIMENSIONS,
  activateCognitiveOperators,
  deriveTurnRequirementField
} from "./turn-requirements.js";
import {
  EMPTY_WORKING_MEMORY,
  promoteWorkingMemoryEntry,
  putWorkingMemoryEntry
} from "./working-memory.js";
import type {
  BuildTestResult,
  CapabilityPlan,
  ConstructGraph,
  EpisodeId,
  EvidenceSpan,
  GraphSlice,
  GraphSnapshot,
  JsonValue,
  OwnerInput,
  PolicyProfile,
  ScceEvent,
  TurnResult
} from "./types.js";
import { createCapabilityExecutorRegistry, dispatchCapabilityTask, type CapabilityExecutor } from "./capability-dispatcher.js";

export interface ProductionTurnRuntimeState {
  lastEpisodeId?: EpisodeId;
  lastOutput: string;
  lastTurnTiming?: TurnResult["timing"];
  lastField?: TurnResult["field"];
  /**
   * CRITICAL fix: the deferred functional-cognition task each turn can
   * spawn (see "functional-cognition.project" below) holds a real,
   * potentially large `graph` object in closure for its whole real
   * 30-45s runtime. With no concurrency bound, firing turns faster than
   * these drain piles them up -- reproduced live: a real OOM crash
   * ("JavaScript heap out of memory") after ~112s of real, ordinary
   * traffic. Bounded the same way dialoguePersistenceTails is bounded in
   * routes.ts: a hard cap on concurrent in-flight deferred tasks: beyond
   * it, a turn simply skips deferring (the audit trail catches up once
   * concurrency drops, it is never silently corrupted, only delayed).
   */
  deferredFunctionalCognitionInFlight: number;
  /**
   * Standing self-state register: the latest COMPLETED functional-
   * cognition projection's selection gate. Turns consult this (with a
   * freshness bound) instead of ever blocking on the 30-45s projection;
   * the deferred task below refreshes it continuously. First turn after
   * a cold start reads it as missing (gate down, honestly) and fires the
   * warmup refresh -- no turn ever waits on self-reflection.
   */
  standingFunctionalCognition?: StandingFunctionalCognition;
  /**
   * Real counterfactuals for the next projection: the candidates the
   * judge actually rejected last turn -- roads genuinely not taken, with
   * the judge's own scores as trace signals.
   */
  lastRejectedCandidateTraces?: CounterfactualTrace[];
  /**
   * Plan item 161 live wiring: induceOperatorFromLedger mines up to 256
   * EpisodeConsolidated rows plus a full readEpisode per matched episode --
   * real, repeated Postgres round-trips, not free. Firing it after every
   * single turn would add load for no new information between consecutive
   * turns on the same conversation. Throttled by both a concurrency guard
   * (never two attempts overlapping) and a minimum real-time gap since the
   * last attempt, mirroring deferredFunctionalCognitionInFlight's
   * philosophy: skip rather than queue when not safe to run.
   */
  reasoningOperatorInductionInFlight: boolean;
  lastReasoningOperatorInductionAttemptAt: number;
}

// Plan items 229-230: maps this turn's own real caveat bindings (Mouth's
// SurfacePlan.caveatBindings -- required disclosures a candidate's own
// force/support computed, not invented here), capability plans (their real
// permission.allowed decisions), and dialogue-pragmatics state (the user's
// real rejected-phrase/preferred-vocabulary corrections) into
// applyPragmaticsGuard's typed inputs. The guard itself already proves,
// structurally, that pragmatics preference can never suppress a required
// disclosure or authorize a capability -- this only supplies it real turn
// data to run that structural proof against, instead of leaving it
// unexercised by any live call site.
function presentationGuardInputFromTurn(input: {
  surfacePlan: { caveatBindings: readonly { pointId: string; reason: string; severity: string }[] };
  capabilityPlans: readonly CapabilityPlan[];
  userStyleProfile: { rejectedPhrases: readonly string[]; preferredVocabulary: readonly string[] };
}): PresentationPlan {
  return {
    requiredDisclosures: input.surfacePlan.caveatBindings.map(binding => ({ id: binding.pointId, content: binding.reason })),
    authorizationDecisions: input.capabilityPlans.map(plan => {
      const permission = jsonRecord(plan.permission);
      return {
        capabilityId: plan.capabilityId,
        authorized: permission.allowed === true,
        reason: kernelString(permission.reason) ?? ""
      };
    }),
    pragmatics: {
      suppressPhraseIds: input.userStyleProfile.rejectedPhrases,
      reorderPriority: input.userStyleProfile.preferredVocabulary
    }
  };
}

// Plan items 213-214: reads a construct:semantic_answer node's real
// selectedFacts (attachLocalEvidenceAnswerConstruct's output, subject/
// predicate/object/sourceVersionId/evidenceIds) and maps each fact into a
// SemanticClaimObservation. Returns [] (not fabricated placeholder claims)
// for any turn whose winning candidate carries no such construct.
function semanticClaimObservationsFromConstruct(
  construct: ConstructGraph,
  hasher: ReturnType<typeof createHasher>,
  observedAt: number
): SemanticClaimObservation[] {
  const node = construct.nodes.find(candidate => candidate.kind === "construct:semantic_answer");
  if (!node) return [];
  const metadata = jsonRecord(node.metadata);
  const rawFacts = Array.isArray(metadata.selectedFacts) ? metadata.selectedFacts : [];
  const observations: SemanticClaimObservation[] = [];
  rawFacts.forEach((rawFact, index) => {
    const fact = jsonRecord(rawFact as JsonValue);
    const subjectId = kernelString(fact.subject);
    const predicate = kernelString(fact.predicate);
    const object = kernelString(fact.object) ?? "";
    if (!subjectId || !predicate) return;
    const sourceId = kernelString(fact.sourceVersionId) ?? "";
    observations.push({
      id: `semantic_claim_observation_${hasher.digestHex(JSON.stringify({ subjectId, predicate, object, sourceId, index })).slice(0, 32)}`,
      subjectId,
      canonicalValue: { predicate, object },
      sourceId,
      observedAt,
      evidenceIds: kernelStringArray(fact.evidenceIds)
    });
  });
  return observations;
}

export function createProductionTurnRuntime(options: {
  deps: ScceKernelDeps;
  state: ProductionTurnRuntimeState;
  policy: PolicyProfile;
  failures: string[];
  turnProofEvidenceLimit: number;
  clock: ReturnType<typeof createClock>;
  hasher: ReturnType<typeof createHasher>;
  idFactory: ReturnType<typeof createIdFactory>;
  eventFactory: ReturnType<typeof createEventFactory>;
  graphRetrieval: ReturnType<typeof createRuntimeGraphRetrieval>;
  surfaceLanguageRuntime: ReturnType<typeof createSurfaceLanguageRuntime>;
  runtimeMemory: ReturnType<typeof createRuntimeMemoryControl>;
  runtimeAcquisition: ReturnType<typeof createRuntimeAcquisition>;
  languageMemoryRuntime: ReturnType<typeof createLanguageMemoryRuntime>;
  lifecycle: {
    append(event: ScceEvent): Promise<ScceEvent>;
    withBufferedEventWrites<T>(run: () => Promise<T>): Promise<T>;
    kernelTrace(event: Parameters<typeof traceEvent>[1]): void;
  };
  engines: {
    actionGraphBuilder: ReturnType<typeof createActionGraphBuilder>;
    alphaPersistence: ReturnType<typeof createAlphaFieldPersistence>;
    answerRevision: ReturnType<typeof createAnswerRevisionCoordinator>;
    candidates: ReturnType<typeof createCandidateEngine>;
    ccr: ReturnType<typeof createCcrEngine>;
    connectorGovernance: ReturnType<typeof createConnectorGovernance>;
    constructSubstrate: ReturnType<typeof createConstructSubstratePlanner>;
    correctionMemory: ReturnType<typeof createCorrectionMemory>;
    counterfactual: ReturnType<typeof createCounterfactualCognition>;
    deterministicMouth: ReturnType<typeof createDeterministicMouth>;
    emissionEngine: ReturnType<typeof createEmissionEngine>;
    entailment: ReturnType<typeof createSemanticEntailmentEngine>;
    fcs: ReturnType<typeof createFunctionalConsciousnessScore>;
    fieldEngine: ReturnType<typeof createAlphaFieldEngine>;
    functionalCognitionEngine: ReturnType<typeof createFunctionalCognitionEngine>;
    judge: ReturnType<typeof createJudge>;
    learningLoop: ReturnType<typeof createLearningLoop>;
    mouth: ReturnType<typeof createMouth>;
    multilingual: ReturnType<typeof createMultilingualAcquisitionEngine>;
    pca: ReturnType<typeof createProofCarryingAnswer>;
    pface: ReturnType<typeof createPfaceEstimator>;
    powerWalk: ReturnType<typeof createTypedTemporalWalkEngine>;
    prediction: ReturnType<typeof createPredictionLayer>;
    programBuilder: ReturnType<typeof createProgramGraphBuilder>;
    runtimeOrchestrator: ReturnType<typeof createRuntimeOrchestrator>;
    safetyRails: ReturnType<typeof createSafetyRailEngine>;
    semanticMemory: ReturnType<typeof createSemanticMemoryIndex>;
    semanticProofSystem: ReturnType<typeof createSemanticProofSystem>;
    ssd: ReturnType<typeof createSpectralSelfDistillation>;
    toolCognition: ReturnType<typeof createAutonomousToolCognition>;
    trainingOrchestrator: ReturnType<typeof createTrainingOrchestrator>;
    translationEngine: ReturnType<typeof createTranslationEngine>;
    validationBuilder: ReturnType<typeof createValidationGraphBuilder>;
  };
}) {
  const {
    deps, state: runtimeState, policy, failures, turnProofEvidenceLimit, clock, hasher, idFactory, eventFactory,
    graphRetrieval, surfaceLanguageRuntime, runtimeMemory, runtimeAcquisition, languageMemoryRuntime,
    lifecycle, engines
  } = options;
  const { append, withBufferedEventWrites, kernelTrace } = lifecycle;
  const {
    currentOwnerSessionEvidence, evidenceFromTurnMetadata, evidenceOnlyForIds, evidenceOnlyForText,
    graphForEvidenceIds, graphForEvidenceIdsUnrouted, graphForText, graphForTextUncached,
    graphRetrievalFeatures, mergeEvidenceSpans, retrievalTextForTurn, runtimeEvidenceIdsFromMetadata,
    sessionEvidenceFromMetadata, ftrlShadowRankingForFeatures
  } = graphRetrieval;
  const {
    hydrateSurfaceLanguageMemoryCached, requestSemanticFrames, sourceOwnedLanguageClusterForAlias,
    sourceOwnedLanguageProfilesCached, surfaceLanguageClusterCached, surfaceLanguageProfilesCached,
    uniqueRecordsById
  } = surfaceLanguageRuntime;
  // A resident-only hydration miss must never crash the turn: an ordinary
  // question whose language cluster had never been touched before (a
  // request-evidence cluster, a translation target -- anything beyond
  // SCCE_STARTUP_LANGUAGE_LIMIT's bounded warm set) failed the whole turn
  // with the raw "was not warmed" error surfaced to the caller
  // (live-verified on "tell me about mmorpgs"/"tell me about einstein").
  // The resident-only attempt still runs first, so the common warm-
  // cluster case keeps its fast path; only a genuine miss pays a real
  // durable hydration -- once, since the cache holds it resident after.
  const hydrateSurfaceLanguageMemoryResidentOrDurable: typeof hydrateSurfaceLanguageMemoryCached = async (limit, cluster, unscopedReason, preferredCorpusRoleId, preferredSurface, hydrationOptions) => {
    try {
      return await hydrateSurfaceLanguageMemoryCached(limit, cluster, unscopedReason, preferredCorpusRoleId, preferredSurface, hydrationOptions);
    } catch (error) {
      if (!hydrationOptions?.residentOnly || !isResidentRuntimeNotWarmError(error)) throw error;
      return hydrateSurfaceLanguageMemoryCached(limit, cluster, unscopedReason, preferredCorpusRoleId, preferredSurface, { ...hydrationOptions, residentOnly: false });
    }
  };
  const { activeBrainMarker, calibrationModelsCached, correctionRulesCached } = runtimeMemory;
  const { learnHydrateReplan, runtimeMotionDeferredByDeadline } = runtimeAcquisition;
  const {
    actionGraphBuilder, alphaPersistence, answerRevision, candidates, ccr, connectorGovernance,
    constructSubstrate, correctionMemory, counterfactual, deterministicMouth, emissionEngine,
    entailment, fcs, fieldEngine, functionalCognitionEngine, judge, learningLoop, mouth, multilingual,
    pca, pface, powerWalk, prediction, programBuilder, runtimeOrchestrator, safetyRails, semanticMemory,
    semanticProofSystem, ssd, toolCognition, trainingOrchestrator, translationEngine, validationBuilder
  } = engines;


  const persistAlphaFlowEnabled = runtimeFlag("SCCE_PERSIST_ALPHA_FLOW", false);
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

/**
 * A whole-turn replan is only worth its cost when the recovery motion
 * actually brought new evidence back. learnHydrateReplan reports that
 * directly: "hydrated" means it ingested something, while "empty",
 * "failed" and "unavailable" all mean the graph is byte-for-byte what the
 * first pass already read.
 *
 * Re-entering turn() on those statuses re-runs seeding, graph slicing,
 * proof, and candidate generation over identical inputs and necessarily
 * reaches the identical conclusion. Measured on the 2026-08-18 sealed run:
 * every turn ran the full pipeline twice (~60s instead of ~30s) and the
 * second pass changed no answer, because a sealed run disables connectors
 * so the motion can only ever report "unavailable".
 */
function runtimeMotionAddedEvidence(motion: RuntimeReplanMotion | undefined): boolean {
  return motion?.status === "hydrated" && motion.ingestedEvidenceCount > 0;
}

  async function turn(input: OwnerInput): Promise<TurnResult> {

      return withBufferedEventWrites(async () => {
      const turnStarted = Date.now();
      // A recovery motion that ran but did not justify a replan still has to
      // be reported: result.runtimeMotion previously came only from
      // inheritedRuntimeMotion, which exists solely on a second pass, so
      // skipping the pointless replan would otherwise silently drop the
      // record that acquisition was attempted and came back empty.
      let performedRuntimeMotion: RuntimeReplanMotion | undefined;
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
      // Plan item 211: consolidates this turn's own event history into a
      // bounded summary (goal/context/actions/outcomes/corrections/lessons)
      // right before each return, once `events` has accumulated everything
      // this turn produced. Every claim in the result stays traceable back
      // to a real event id in sourceEventIds -- consolidateEpisode never
      // invents summary text.
      const consolidateCurrentEpisode = async (): Promise<JsonValue> => {
        const consolidated = consolidateEpisode(events, { requestText: input.text });
        events.push(await append(eventFactory.create({ episodeId, typeId: "EpisodeConsolidated", payload: toJsonValue(consolidated) })));
        return toJsonValue(consolidated);
      };
      // Plan items 213-214: when the winning candidate carries a real
      // construct:semantic_answer node (attachLocalEvidenceAnswerConstruct's
      // selectedFacts), consolidate its subject/predicate/object facts by
      // subject + canonicalized value. Distinct claimed values for the same
      // subject stay separate (a genuine, preserved disagreement) rather than
      // collapsing into false consensus -- nothing here decides which claim
      // is right. Absent (not just empty), never fabricated, when the turn's
      // construct carries no semantic-answer facts at all.
      const consolidateCurrentSemanticClaims = async (constructGraph: ConstructGraph): Promise<JsonValue | undefined> => {
        const observations = semanticClaimObservationsFromConstruct(constructGraph, hasher, clock.now());
        if (!observations.length) return undefined;
        const consolidated = consolidateSemanticClaims(observations);
        events.push(await append(eventFactory.create({ episodeId, typeId: "SemanticClaimsConsolidated", payload: toJsonValue(consolidated) })));
        return toJsonValue(consolidated);
      };
      kernelTrace({ stage: "runtime.start", label: "kernel.turn", counts: { textChars: input.text.length } });
      const repoFiles = repoFilesFromMetadata(input.metadata);
      const documentGenerationRequest = documentGenerationRequestFromMetadata(input.metadata);
      const fastRuntimeBudget = fastRuntimeBudgetRequested(input.metadata);
      const runtimeDeadline = executableRuntimeDeadlineFromMetadata(input.metadata);
      const deadlineCheckpoint = (phase: string, requiredMs: number): RuntimeDeadlineDecision | undefined => {
        input.runtimeControl?.onProgress?.({
          phase,
          observedAtMonotonicMs: performance.now()
        });
        if (input.runtimeControl?.signal?.aborted) {
          const reason = input.runtimeControl.signal.reason;
          throw reason instanceof Error
            ? reason
            : new Error(`runtime turn aborted at ${phase}`);
        }
        const decision = runtimeDeadline?.checkpoint(phase, requiredMs);
        const deadlineMetadata = runtimeDeadline?.metadata;
        if (decision && deadlineMetadata) {
          kernelTrace({
            stage: "runtime.deadline.check",
            label: phase,
            durationMs: decision.observedAtMonotonicMs - deadlineMetadata.startedMonotonicMs,
            support: { ...decision },
            ...(decision.allowed ? {} : { warnings: [`deadline guard did not admit ${phase}`] })
          });
        }
        return decision;
      };
      deadlineCheckpoint("kernel.turn.start", 0);
      const locale = localeFromMetadata(input.metadata, input.text);
      const translationTarget = translationTargetFromMetadata(input.metadata);
      const sourceLanguageAlias = sourceLanguageAliasFromMetadata(input.metadata);
      const surfaceClusterStarted = Date.now();
      const selectedSurfaceCluster = deps.evaluationCondition?.flags.disableLanguageMemory
        ? undefined
        : sourceLanguageAlias
          ? await sourceOwnedLanguageClusterForAlias(
            sourceLanguageAlias,
            input.text,
            { residentOnly: fastRuntimeBudget }
          )
          : await surfaceLanguageClusterCached(input.text, fastRuntimeBudget);
      kernelTrace({
        stage: "runtime.seed.surface_cluster",
        label: "kernel.turn",
        durationMs: Date.now() - surfaceClusterStarted,
        counts: { profiles: selectedSurfaceCluster?.profileIds.length ?? 0 },
        support: {
          residentOnly: fastRuntimeBudget,
          durableProfileScanAllowed: !fastRuntimeBudget,
          sourceLanguageAlias: sourceLanguageAlias ?? null,
          sourceLanguageAliasResolved: sourceLanguageAlias ? Boolean(selectedSurfaceCluster) : null
        }
      });
      deadlineCheckpoint("runtime.seed.surface_cluster.complete", 0);
      const selectedSurfaceProfile = selectedSurfaceCluster?.members[0];
      const authorityLanguageStarted = Date.now();
      const baseAuthorityLanguage = await evaluationComponent(
        "language-memory",
        "authority.language-memory.hydrate",
        () => hydrateSurfaceLanguageMemoryResidentOrDurable(
          12,
          selectedSurfaceCluster,
          selectedSurfaceCluster ? "source-cluster-selected" : "source-surface-ambiguous-or-no-signal",
          undefined,
          "",
          { residentOnly: fastRuntimeBudget }
        ),
        () => Promise.resolve(emptySurfaceLanguageMemory())
      );
      kernelTrace({
        stage: "runtime.seed.language",
        label: "kernel.turn",
        durationMs: Date.now() - authorityLanguageStarted,
        counts: {
          models: baseAuthorityLanguage.models.length,
          patterns: baseAuthorityLanguage.patterns.length,
          semanticFrames: baseAuthorityLanguage.semanticFrames.length
        }
      });
      deadlineCheckpoint("runtime.seed.language.complete", 0);
      const exactRequestFramesStarted = Date.now();
      const exactRequestFrames = deps.evaluationCondition?.flags.disableLanguageMemory
        ? []
        : await requestSemanticFrames(input.text, { residentOnly: fastRuntimeBudget });
      kernelTrace({
        stage: "runtime.seed.request_frames",
        label: "kernel.turn",
        durationMs: Date.now() - exactRequestFramesStarted,
        counts: { semanticFrames: exactRequestFrames.length }
      });
      deadlineCheckpoint("runtime.seed.request_frames.complete", 0);
      const authorityLanguage = exactRequestFrames.length
        ? {
          ...baseAuthorityLanguage,
          semanticFrames: uniqueRecordsById([...exactRequestFrames, ...baseAuthorityLanguage.semanticFrames], 128),
          state: {
            ...baseAuthorityLanguage.state,
            importedSemanticFrames: uniqueRecordsById([...exactRequestFrames, ...baseAuthorityLanguage.state.importedSemanticFrames], 128),
            importedLanguagePriorCount: baseAuthorityLanguage.state.importedLanguagePriorCount + exactRequestFrames.filter(frame => !baseAuthorityLanguage.state.importedSemanticFrames.some(existing => existing.id === frame.id)).length,
            audit: toJsonValue({
              ...jsonRecord(baseAuthorityLanguage.state.audit),
              requestExactSemanticFrameIds: exactRequestFrames.map(frame => frame.id),
              requestExactSemanticFrameMatch: true
            })
          }
        }
        : baseAuthorityLanguage;
      // Repo cognition runs after the language seed so symbol localization filters
      // closed-class words derived from the active language, not a hardcoded list.
      const repoCognition = repoFiles
        ? toJsonValue(repoCognitionForTurn({
          requestText: input.text,
          files: repoFiles,
          closedClassWords: deriveClosedClassWords({ models: authorityLanguage.state.models ?? [] })
        }))
        : undefined;
      const previousDialogueState = previousDialogueStateFromMetadata(input.metadata);
      const requestedConversationId = requestedConversationIdFromMetadata(input.metadata);
      const authorityDialogueState = updateDialogueState({
        requestText: input.text,
        targetLanguage: translationTarget ?? locale,
        previousState: previousDialogueState,
        conversationId: requestedConversationId ?? previousDialogueState?.conversationId
      });
      // Plan items 221-228: real, durable, cross-turn document-generation
      // sessions (deps.storage.documentGeneration, a genuine Postgres-
      // backed store -- see storage.ts/postgres.ts), keyed by the
      // caller's own chosen sessionId via metadata.documentGeneration. An
      // absent request simply leaves this field absent, never fails the
      // turn -- same contract as repoCognition above. A *malformed* one
      // (the key is present but doesn't parse) is a real, distinguishable
      // caller error -- surfaced as a real rejection, not silently
      // dropped as if nothing was asked. `authorityDialogueState.conversationId`
      // is the real tenant-isolation boundary -- a session is scoped to
      // this exact conversation and never visible to, or overwritable by,
      // another.
      const documentGenerationResult = documentGenerationRequest.status === "ok"
        ? await syncDocumentGenerationRequestForTurn(deps.storage.documentGeneration, documentGenerationRequest.request, clock.now(), authorityDialogueState.conversationId)
        : documentGenerationRequest.status === "malformed"
          ? { accepted: false as const, reason: "malformed request" as const }
          : undefined;
      const documentGeneration = documentGenerationResult ? toJsonValue(documentGenerationResult) : undefined;
      const runtimeDiagnosticRequested = explicitRuntimeDiagnosticRequest(input.metadata);
      const inheritedRuntimeMotion = runtimeReplanMotionFromMetadata(input.metadata, hasher.digestHex(input.text));
      const explicitAuthority = requestedAuthorityFromTurnInput(input, translationTarget);
      const workspacePlanContext = runtimeWorkspacePlanContext(input.metadata, input.text);
      const requestRequirementLanguageState: LanguageMemoryRuntimeState = {
        ...authorityLanguage.state,
        importedPatterns: uniqueRecordsById([
          ...authorityLanguage.requestControlPatterns,
          ...authorityLanguage.state.importedPatterns
        ], 2048)
      };
      const requirementField = deriveTurnRequirementField({
        requestText: input.text,
        explicitRequirements: [
          ...explicitTurnRequirementsFromInput(input, explicitAuthority),
          ...workspacePlanContext.explicitRequirements
        ],
        dialogueState: authorityDialogueState,
        languageMemoryState: requestRequirementLanguageState,
        contextContribution: requirementContextFromMetadata(input.metadata)
      });
      const authorityProjection = projectRequestAuthority({ requirementField, explicitAuthority });
      const requestedAuthority = authorityProjection.requestedAuthority;
      let creativeRequestFrame: CreativeRequestFrame | undefined = undefined;
      let operatorActivations = activateCognitiveOperators({
        requirementField,
        dialogueSupport: requestOperatorDialogueSupport(requirementField),
        outcomeSupport: operatorOutcomeSupport(input.metadata)
      });
      const requestedAuthorityDecision = toJsonValue({
        ...jsonRecord(authorityProjection.trace),
        activeOperatorIds: activeRequestOperatorIds(operatorActivations)
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
      if (workspacePlanContext.plans.length) {
        events.push(await append(eventFactory.create({ episodeId, typeId: "WorkspacePlansBound", payload: workspacePlanContext.audit })));
      }
      const detectedCorrections = correctionMemory.fromMetadata({ episodeId, metadata: input.metadata, ownerFeedbackEventId: ownerAsked.id, now: clock.now() });
      for (const rule of detectedCorrections) {
        await deps.storage.corrections.putRule(rule);
        events.push(await append(eventFactory.create({ episodeId, typeId: "UserCorrected", payload: { ruleId: rule.id, kind: rule.ruleKind, scope: rule.scope, patternHash: hasher.digestHex(rule.pattern), replacementHash: rule.replacement ? hasher.digestHex(rule.replacement) : null, provenance: rule.provenanceJson } })));
      }
      // Plan items 219-220: real, durable, provenance-aware user-model
      // claims (deps.storage.userModelClaims, a genuine Postgres-backed
      // store -- see storage.ts/postgres.ts), not a caller-side metadata
      // round trip. Every real correction detected above -- always
      // explicit_instruction, since it only ever arrives via explicit
      // owner-supplied metadata -- is recorded as a real claim.
      // Idempotent: a persistent correction repeated across turns is
      // never recorded twice. `authorityDialogueState.conversationId` is
      // the real tenant-isolation boundary -- claims are scoped to this
      // exact conversation and never leak into an unrelated one's
      // `TurnResult.userModelStore`.
      const userModelStore = await syncUserModelStoreForTurn(deps.storage.userModelClaims, detectedCorrections, authorityDialogueState.conversationId);
      const runtimeDag = runtimeOrchestrator.dag({ episodeId, mode: "turn", mutating: true, requestedTools: Boolean(deps.connectors) });
      const safetyDecision = safetyRails.evaluate({ text: input.text, plans: [], policy });
      events.push(await append(eventFactory.create({ episodeId, typeId: "ActionPrepared", payload: { runtimeDag: runtimeDag.audit, safety: safetyDecision.audit } })));
      markTiming("seedMs");
      // Plan items 171-172: a real unit-bearing or arbitrary-precision
      // expression is dispatched to exact-computation.ts's exact rational
      // engine, checked first since it's the strictly more precise route
      // when it applies (it only ever fires when a genuine unit token is
      // present -- see exactComputationForText's own contract) and never
      // competes with the plain float calculator below. `.value` is a
      // best-effort float used only by this shared entailment builder's
      // internal bookkeeping, never by the actually-displayed
      // answer/audit text (`.answer`/`.audit` below), which stay the
      // real, exact rational rendering throughout -- so no precision is
      // lost in what the user is ever shown, even for a value this float
      // conversion itself could not represent exactly.
      const exactComputation = exactComputationForText(input.text);
      const arithmetic = exactComputation
        ? {
          expression: exactComputation.expression,
          normalizedExpression: exactComputation.expression,
          value: Number(exactComputation.result.numerator) / Number(exactComputation.result.denominator),
          valueText: exactComputation.resultText,
          answer: exactComputation.answer,
          audit: exactComputation.audit
        }
        : arithmeticAnswerForText(input.text);
      if (arithmetic && requestedAuthority !== "creative" && requestedAuthority !== "translation") {
        markTiming("graphSliceMs");
        const graph: GraphSlice = { nodes: [], edges: [], hyperedges: [], bounded: true, query: {} };
        const field = fieldEngine.activate({ text: input.text, nodes: [], edges: [], previous: runtimeState.lastField, evaluation: fieldEvaluation });
        runtimeState.lastField = field;
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
        runtimeState.lastEpisodeId = episodeId;
        runtimeState.lastOutput = emission.answer;
        events.push(await append(eventFactory.create({ episodeId, typeId: "ComputationEvaluated", payload: arithmetic.audit })));
        events.push(await append(eventFactory.create({ episodeId, typeId: "SemanticEntailmentChecked", payload: { proofId: entailment.proof.id, force: entailment.force, assistantForce: emission.assistantForce, support: entailment.support, contradiction: entailment.contradiction, deterministicArithmetic: true } })));
        events.push(await append(eventFactory.create({ episodeId, typeId: "EmissionGraphBuilt", payload: emission })));
        const timing = buildTiming("deferred");
        events.push(await append(eventFactory.create({ episodeId, typeId: "EpisodeClosed", payload: { output: emission.answer, deterministicArithmetic: true, timing } })));
        runtimeState.lastTurnTiming = timing;
        const episodeConsolidation = await consolidateCurrentEpisode();
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
          userModelStore: userModelStoreToJson(userModelStore),
          learningLoop: toJsonValue({ maintenanceDeferred: true, deterministicArithmetic: true }),
          episodeConsolidation,
          relevantPastEpisodes: undefined,
          repoCognition,
          documentGeneration,
          timing,
          ...evaluationTraceResult(),
          ...turnContract({ entailment, evidence: [], assistantForce: emission.assistantForce, unsupportedContentBlocked: false }),
          events
        };
      }
      const discourseObject = discourseObjectStateFromMetadata(input.metadata);
      const discourseObjectTrace = discourseObject ? toJsonValue(discourseObject) : undefined;
      if (discourseObjectTrace) events.push(await append(eventFactory.create({ episodeId, typeId: "DiscourseObjectBound", payload: discourseObjectTrace })));
      // A program-authority request (imperative: write/fix/add code) is never a near-duplicate of
      // corpus prose; rendering it interrogative for retrieval disables the near-dup fast path
      // language-neutrally (a question mark, not an English verb list). Evidence must then be
      // anchored, or the turn falls to the code mouth / offer-to-learn arm.
      const baseRetrievalText = retrievalTextForTurn(input);
      const retrievalText = requestedAuthority === "program" && !/[?？؟]s*$/u.test(baseRetrievalText) ? `${baseRetrievalText}?` : baseRetrievalText;
      const sessionEvidence = mergeEvidenceSpans([...currentOwnerSessionEvidence(input), ...sessionEvidenceFromMetadata(input.metadata)]);
      const metadataEvidence = await evidenceFromTurnMetadata(input.metadata);
      const metadataEvidenceIds = new Set([
        ...metadataEvidence.map(span => String(span.id)),
        ...(discourseObject?.evidenceIds ?? [])
      ]);
      const sessionContextEvidence = sessionContextEvidenceEnabled(input.metadata);
      const explicitContextEvidenceIds = new Set(sessionContextEvidence
        ? discourseObject?.evidenceIds.length
          ? discourseObject.evidenceIds
          : runtimeEvidenceIdsFromMetadata(input.metadata)
        : []);
      const discourseEvidenceBound = explicitContextEvidenceIds.size > 0;
      const allowSemanticFrameEvidence = deps.evaluationCondition?.flags.disableLanguageMemory !== true
        && deps.evaluationCondition?.flags.disableLearnedSemantics !== true;
      const graphSliceStarted = Date.now();
      const graphSlice = await evaluationComponent(
        "graph",
        "graph.resolve",
        () => evaluationComponent(
          "shard-router",
          "graph.resolve.shard-router",
          () => discourseEvidenceBound
            ? graphForEvidenceIds([...metadataEvidenceIds])
            : graphForText(retrievalText, {
              allowSemanticFrameEvidence,
              // Reverted to conditional (was unconditionally true): this
              // flag doesn't just tighten anchoring, it switches
              // runtime-graph-retrieval.ts's graphForText onto an entirely
              // different, far more expensive retrieval strategy --
              // semantic-frame Postgres lookups and potential full uncached
              // traversal -- instead of the fast in-memory hot-neighborhood
              // path taken when this is false (see graphForText's
              // `!requireDurableGraphLookup && !sourceAnchoringRequired`
              // branch). Forcing it on for every creative turn against a
              // real corpus (millions of graph edges) is what produced a
              // 20-30 minute hang and repeated OOM crash on a live
              // rehearsal. The compositional force fix does not actually
              // need this: the pre-existing "keeps a source-inspired
              // request creative..." test already proves the cheap
              // hot-neighborhood path supplies real, usable evidence for a
              // creative candidate's embedded factual premise -- it passed
              // on main with this exact conditional before any of this
              // session's changes.
              sourceAnchoringRequired: requestedAuthority !== "creative",
              residentOnly: fastRuntimeBudget
            }),
          () => discourseEvidenceBound ? graphForEvidenceIdsUnrouted([...metadataEvidenceIds]) : graphForTextUncached(retrievalText)
        ),
        () => discourseEvidenceBound ? evidenceOnlyForIds([...metadataEvidenceIds]) : evidenceOnlyForText(retrievalText, allowSemanticFrameEvidence)
      );
      kernelTrace({
        stage: "graph.resolve",
        label: "kernel.turn.graph_slice",
        durationMs: Date.now() - graphSliceStarted,
        counts: {
          nodes: graphSlice.graph.nodes.length,
          edges: graphSlice.graph.edges.length,
          evidence: graphSlice.evidence.length
        }
      });
      // Kicked off here (not awaited) so it can resolve concurrently with
      // the rest of turn processing; only awaited later, right where this
      // turn's proof/certification outcome becomes known (Part A finding
      // 9, stage 3). Deliberately recomputed against the resident hot
      // neighborhood rather than reading anything off graphSlice, which
      // may be served from a cache shared across turns/queries and must
      // never carry per-turn learning state.
      const ftrlShadowRankingPromise = requestedAuthority === "creative"
        ? Promise.resolve(undefined)
        : ftrlShadowRankingForFeatures(graphRetrievalFeatures(retrievalText)).catch(() => undefined);
      const semanticFrameBoundEvidenceIds = new Set(graphSlice.semanticFrameBoundEvidenceIds ?? []);
      let graph = graphSlice.graph;
      const unsealedEvidencePool = discourseEvidenceBound
        ? mergeEvidenceSpans([...sessionEvidence, ...metadataEvidence, ...graphSlice.evidence.filter(span => metadataEvidenceIds.has(String(span.id)))]).filter(span => !isControlCorpusSpan(span))
        : mergeEvidenceSpans([...sessionEvidence, ...metadataEvidence, ...graphSlice.evidence]).filter(span => !isControlCorpusSpan(span) && (requestedAuthority !== "program" || isCodeEvidenceSpan(span)));
      // Sealed-corpus allowlist (trusted in-process runtimeControl, like
      // signal): every downstream evidence consumer -- proof support,
      // answer proposal, mouth realization, citations -- draws from this
      // pool, so filtering here is the single enforcement point. A sealed
      // turn that loses all its evidence falls through to the normal
      // insufficient_support abstention rather than any special case.
      const sealedSourceAllowlist = input.runtimeControl?.evidenceSourceAllowlist;
      const evidencePool = sealedSourceAllowlist
        ? unsealedEvidencePool.filter(span => sealedSourceAllowlist.includes(span.sourceVersionId))
        : unsealedEvidencePool;
      const evidence = evidenceWithGraphPreviewWindows(
        input.text,
        evidencePool,
        graph.nodes,
        new Set([
          ...metadataEvidenceIds,
          ...semanticFrameBoundEvidenceIds,
          ...graphSlice.evidence.map(span => String(span.id))
        ])
      );
      const calibrationModels = await calibrationModelsCached();
      const sourceAnchorAudit = discourseEvidenceBound
        ? { required: false, anchors: [] as string[], evidence }
        : sourceAnchoredEvidenceForRequest(input.text, evidence, semanticFrameBoundEvidenceIds);
      // Empty audit over a titleless pool: identity admission can never bind
      // workspace-file spans, so fall back to the titleless spans the graph
      // slice already content-admitted; titled corpora keep strict abstention.
      const auditFallbackEvidence = sourceAnchorAudit.required && !sourceAnchorAudit.evidence.length
        ? evidence.filter(span => !evidenceSpanProvenanceTitle(span)).slice(0, 24)
        : [];
      const admissibleEvidence = sourceAnchorAudit.required
        ? (sourceAnchorAudit.evidence.length ? sourceAnchorAudit.evidence : auditFallbackEvidence)
        : evidence;
      if (sourceAnchorAudit.required && admissibleEvidence.length) graph = graphFilteredToEvidence(graph, admissibleEvidence);
      const retrievalFeatures = graphRetrievalFeatures(retrievalText);
      const semanticRetrievalStarted = Date.now();
      const compiledMemorySlice = semanticMemory.buildSlice({
        evidence: admissibleEvidence,
        nodes: graph.nodes
      });
      const semanticRetrieval = evaluationComponent(
        "learned-semantics",
        "retrieval.learned-semantics",
        () => ({
          retrieval: semanticMemory.search({
            query: { text: input.text, features: retrievalFeatures, limit: 80 },
            slice: compiledMemorySlice,
            corpusRows: { evidenceRows: Math.max(1, admissibleEvidence.length), nodeRows: Math.max(1, graph.nodes.length), edgeRows: Math.max(1, graph.edges.length) },
            calibrationModels,
            calibrationTaskClass
          }),
          roleRetrieval: hybridRecall({
            query: input.text,
            index: compiledMemorySlice.corpusIndex,
            graph,
            hasher,
            limit: 80,
            calibrationModels,
            calibrationTaskClass
          })
        }),
        () => disabledLearnedSemanticRetrieval(input.text, retrievalFeatures, hasher)
      );
      const { retrieval, roleRetrieval } = semanticRetrieval;
      kernelTrace({
        stage: "graph.resolve",
        label: "kernel.turn.semantic_retrieval",
        durationMs: Date.now() - semanticRetrievalStarted,
        counts: {
          evidence: admissibleEvidence.length,
          nodes: graph.nodes.length,
          candidates: retrieval.candidates.length,
          recall: roleRetrieval.recall.length
        }
      });
      const retrievalRoles = retrievalRoleTracesFromHybridRecall(roleRetrieval.recall);
      events.push(await append(eventFactory.create({ episodeId, typeId: "GraphUpdated", payload: { retrieval: retrieval.diagnostics, plan: retrieval.plan.audit, roleRecall: roleRetrieval.audit } })));
      const powerWalkStarted = Date.now();
      const walk = evaluationComponent(
        "powerwalk",
        "graph.resolve.powerwalk",
        () => powerWalk.run(graph.nodes, graph.edges),
        () => emptyPowerWalkResult()
      );
      kernelTrace({
        stage: "graph.resolve",
        label: "kernel.turn.powerwalk",
        durationMs: Date.now() - powerWalkStarted,
        counts: { nodes: graph.nodes.length, edges: graph.edges.length, walks: walk.walks.length }
      });
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
        hyperedges: graph.hyperedges,
        previous: runtimeState.lastField,
        evaluation: fieldEvaluation,
        seedPriors: [...semanticSeedAnchors, ...walkSeedExpansion.seeds]
      });
      runtimeState.lastField = field;
      operatorActivations = activateCognitiveOperators({
        requirementField,
        graphSupport: requestOperatorGraphSupport({ graph, evidence: admissibleEvidence, field }),
        dialogueSupport: requestOperatorDialogueSupport(requirementField),
        outcomeSupport: operatorOutcomeSupport(input.metadata)
      });
      events.push(await append(eventFactory.create({
        episodeId,
        typeId: "CognitiveOperatorsActivated",
        payload: toJsonValue({ phase: "graph_activated", operators: operatorActivations })
      })));
      const alphaRecord = alphaRecordFromField({ graph, requestText: input.text, requestFeatures: featureSet(input.text, 1024), field, createdAt: clock.now() });
      // Opt-in only. persistAlphaRecord writes multi-MB ppf_cache and
      // alpha_traces rows every turn -- measured at 4.3s of one warm turn's
      // 26.9s database time -- to tables with ZERO readers anywhere in the
      // repo (getPpf/getAlphaTrace/listAlphaTraces have no callers), under a
      // key containing requestHash and fieldHash so it could never hit as a
      // cache either. A cache nothing reads is a log; a mandatory 4.3s log
      // on the answer path is a defect. The mechanism stays for replay
      // debugging behind an explicit flag.
      if (persistAlphaFlowEnabled) {
        void persistAlphaRecord(alphaRecord, field).catch(error => failures.push(`alpha persistence failed: ${error instanceof Error ? error.message : String(error)}`));
      }
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
      deadlineCheckpoint("runtime.graph_slice.complete", 0);
      // Always computed regardless of requestedAuthority: a creative-authority
      // turn can still embed a factual claim that needs real evidence and a
      // real proof verdict (Valid(Y) = ∧ᵢ Valid(yᵢ | force(yᵢ))), and a
      // factual/reasoned turn can still embed an invented analogy that must
      // NOT be forced through this machinery as if it were a claim. Which
      // candidates/claims actually consume this is decided per-unit later
      // by assistantForceDecision, not by skipping the computation itself.
      const supportCandidates = runtimeEvidenceWindowsForRequest(input.text, evidenceForRequest(input.text, admissibleEvidence.filter(span => span.status === "promoted"), metadataEvidenceIds, explicitContextEvidenceIds, semanticFrameBoundEvidenceIds).slice(0, turnProofEvidenceLimit));
      const proofNodes = graph.nodes;
      const proofEdges = graph.edges;
      // The learned response form's surface layout supplies the sentence
      // budget: an enumeration-shaped request (matched against the
      // hand-authored request-requirement corpus, never a keyword list)
      // answers with the source's contiguous lead block instead of a single
      // lexically-best sentence -- the fix for questions whose answers the
      // source expresses only as instances ("list the main characters"
      // vs. a lead that names them without ever saying "characters").
      const responseFormSentences = requirementField.responseForm?.surfaceLayout?.sentencesPerBlock;
      const answerProposal = proposeSourceExactEvidenceAnswer({
        requestText: input.text,
        selectedEvidence: supportCandidates,
        semanticFrameBoundEvidenceIds,
        ...(Number.isFinite(responseFormSentences) && (responseFormSentences ?? 0) > 1
          ? { responseSentenceBudget: responseFormSentences }
          : {})
      });
      // Not input.text directly: evaluateSemanticObligations/structural.check
      // extract material assertable items from claim.text -- a raw
      // interrogative request ("Who was X, and what did Y?") doesn't carry
      // the same clean predicate structure a declarative excerpt does, so
      // substituting it here left entailmentResult.evidenceIds empty for
      // otherwise well-supported compound questions (verified: this exact
      // substitution alone turned a real source_grounded_answer into a
      // degraded reasoned_answer with no other change). The excerpt is
      // still a legitimate proposition to check -- entailment.ts no longer
      // fabricates perfect scores for it (see the exact-source-excerpt
      // fix), so checking "does the evidence support this excerpt" is now
      // a real, non-tautological check, including correctly rejecting a
      // discourse-dependent or irrelevant excerpt.
      const proofClaimText = answerProposal
        ? localEvidenceAnswerClaimSurface(answerProposal) || input.text
        : input.text;
      const proofCandidateEvidence = answerProposal?.evidence ?? supportCandidates;
      const proofSourceExcerpts = answerProposal
        ? localEvidenceAnswerProofExcerpts(answerProposal)
        : [];
      kernelTrace({
        stage: "candidate.proposal",
        label: "kernel.turn.source_exact",
        counts: {
          proposed: answerProposal ? 1 : 0,
          claimChars: proofClaimText.length,
          evidence: proofCandidateEvidence.length,
          sourceExcerpts: proofSourceExcerpts.length
        },
        support: {
          planId: answerProposal?.plan.planId ?? null,
          evidenceIds: answerProposal?.evidence.map(span => String(span.id)) ?? []
        }
      });
      const emptySupportBundle = () => ({
          promoted: [] as EvidenceSpan[],
          entailmentResult: createAblatedSupportEntailment({ requestText: proofClaimText, field, idFactory, createdAt: clock.now() }),
          semanticProof: emptySemanticProofResult(proofClaimText, hasher),
          ccrResult: emptyCcrResult(proofClaimText),
          pfaceEstimate: undefined
        });
      const supportBundle = evaluationComponent(
          "support-engine",
          "proof.support-engine",
          () => {
            const entailmentStarted = Date.now();
            const entailmentResult = entailment.check({
              text: proofClaimText,
              evidence: proofCandidateEvidence,
              nodes: proofNodes,
              field,
              createdAt: clock.now(),
              sourceExcerpts: proofSourceExcerpts,
              calibrationModels
            });
            kernelTrace({
              stage: "proof.entailment",
              label: "kernel.turn",
              durationMs: Date.now() - entailmentStarted,
              counts: {
                claimChars: proofClaimText.length,
                evidence: proofCandidateEvidence.length,
                sourceExcerpts: proofSourceExcerpts.length,
                certifiedEvidence: entailmentResult.evidenceIds.length
              }
            });
            const semanticProofStarted = Date.now();
            const semanticProof = semanticProofSystem.prove({ claimText: proofClaimText, evidence: proofCandidateEvidence, nodes: proofNodes, field });
            kernelTrace({
              stage: "proof.semantic",
              label: "kernel.turn",
              durationMs: Date.now() - semanticProofStarted,
              counts: {
                obligations: semanticProof.obligations.length,
                counterexamples: semanticProof.counterexamples.length
              }
            });
            const ccrStarted = Date.now();
            const ccrResult = ccr.run({ text: proofClaimText, evidence: proofCandidateEvidence, nodes: proofNodes, edges: proofEdges, field, entailment: entailmentResult });
            kernelTrace({
              stage: "proof.ccr",
              label: "kernel.turn",
              durationMs: Date.now() - ccrStarted
            });
            return {
              promoted: proofCandidateEvidence,
              entailmentResult,
              semanticProof,
              ccrResult,
              pfaceEstimate: pface.estimate({ nodes: proofNodes, edges: proofEdges, field })
            };
          },
          emptySupportBundle
        );
      const { promoted, entailmentResult, semanticProof, ccrResult, pfaceEstimate } = supportBundle;
      {
        // Fire-and-forget: outcome-based FTRL learning must never affect
        // or delay this turn's response. proofCandidateEvidence is the
        // full pool the entailment check chose from -- the candidate
        // pool a pairwise label is contrasted against (Part A finding 9,
        // stage 3).
        const candidatePoolEvidenceIds = proofCandidateEvidence.map(span => span.id);
        ftrlShadowRankingPromise
          .then(shadow => shadow
            ? updateFtrlFromTurnOutcome({
              store: deps.sparseRankingModels,
              comparisonLog: deps.sparseRankingComparisons,
              shadowRanking: shadow.ranking,
              nodesById: shadow.nodesById,
              entailment: entailmentResult,
              candidatePoolEvidenceIds,
              clock
            })
            : undefined)
          .then(result => {
            if (!result) return;
            kernelTrace({
              stage: "retrieval.ftrl_outcome",
              label: "kernel.turn",
              support: { updated: result.updated, reason: result.reason }
            });
          })
          .catch(error => {
            failures.push(`ftrl outcome update failed: ${error instanceof Error ? error.message : String(error)}`);
          });
      }
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
      let selectedEvidence = runtimeEvidenceWindowsForRequest(input.text, evidenceForRequest(input.text, evidenceSelectionPool, metadataEvidenceIds, explicitContextEvidenceIds, semanticFrameBoundEvidenceIds));
      const temporalEvidencePool = mergeEvidenceSpans([...admissibleEvidence, ...metadataEvidence]);
      const selectedTemporalCandidateEvidence = evidenceBatchFromSlice(temporalEvidencePool, selectedEvidence.map(span => span.id)) ?? selectedEvidence;
      const durableTemporalEvidence = temporalCounterexampleExpected(input.text, selectedTemporalCandidateEvidence)
        ? await deps.storage.evidence.getEvidenceBatch(selectedEvidence.map(span => span.id))
        : [];
      const selectedTemporalEvidence = evidenceBatchFromSlice(durableTemporalEvidence, selectedEvidence.map(span => span.id))
        ?? selectedTemporalCandidateEvidence;
      let earlyLearningNeeds = learningNeedsFor(input.text, entailmentResult, selectedEvidence, locale);
      // Plan item 212 (read-back): consolidation (211) was write-only until
      // now -- nothing retrieved a past consolidated episode to influence a
      // *new* turn's proposal generation. This closes that gap using the
      // already-real, already-tested retrieveRelevantEpisodes (feature-
      // overlap similarity, never a fabricated match): past episodes whose
      // request genuinely overlaps this one have their verbatim lessons
      // merged into earlyLearningNeeds, which already feeds both
      // candidates.generate and functionalCognitionEngine.project -- real
      // influence on this turn's candidates, not just a receipt.
      const pastConsolidatedEpisodeEvents = await deps.storage.events.readRange({ typeId: "EpisodeConsolidated", beforeT: clock.now(), limit: 32 });
      const pastConsolidatedEpisodes = pastConsolidatedEpisodeEvents.map(event => event.payload as unknown as ConsolidatedEpisode);
      const relevantPastEpisodes = retrieveRelevantEpisodes(pastConsolidatedEpisodes, input.text, { excludeEpisodeId: episodeId, limit: 3 });
      if (relevantPastEpisodes.length) {
        earlyLearningNeeds = uniqueKernelStrings([...earlyLearningNeeds, ...relevantPastEpisodes.flatMap(row => row.episode.lessons)]);
      }
      markTiming("proofMs");
      deadlineCheckpoint("runtime.proof.complete", 0);
      const semanticProofContradiction = typeof semanticProof.contradiction === "number"
        && Number.isFinite(semanticProof.contradiction)
        ? semanticProof.contradiction
        : 0;
      // Formal-proof pressure can remain high when the proof graph is incomplete.
      // It calibrates force, but it is not counterevidence against an exact
      // promoted source excerpt. Only contradiction mass from the selected
      // evidence lane can reject that excerpt.
      const proposalContradiction = entailmentResult.contradiction;
      const evidenceProposalAdmissible = Boolean(
        answerProposal
        && proofSourceExcerpts.length > 0
        && proposalContradiction < 0.72
      );
      // localEvidenceAnswerSurface (backed by localEvidenceAnswerPlan) covers
      // however many sentences a compound request actually needs
      // (evidenceAnswerSentenceLimit) and optimizes for request coverage,
      // not just top lexical/anchor score -- so it is tried first. Falling
      // back to answerProposal (proposeSourceExactEvidenceAnswer's single
      // highest-scoring sentence, uncorrelated with how many parts the
      // request asked about) only when the richer plan finds nothing keeps
      // the exact-single-sentence path available without letting it
      // pre-empt a real compound answer by default.
      const richLocalEvidenceAnswer = proofSelectedEvidence.length
        ? localEvidenceAnswerSurface({
            requestText: input.text,
            selectedEvidence,
            temporalEvidence: selectedTemporalEvidence,
            entailment: entailmentResult,
            semanticProof: { verdict: semanticProof.verdict, contradiction: semanticProof.contradiction },
            translationTarget,
            sessionContextEvidence,
            explicitContextEvidenceIds,
            semanticFrameBoundEvidenceIds
          })
        : undefined;
      // Priority by plan kind (temporal counterexample > collection > single sentence): the richer plan still leads by default, and the exact-sentence proposal takes over only when its plan outranks it.
      const selectedPoolLocalEvidenceAnswer = preferredLocalEvidenceAnswer(richLocalEvidenceAnswer, evidenceProposalAdmissible ? answerProposal : undefined);
      // Direct source evidence may propose a bounded answer without full proof.
      // Proof strengthens force; material contradiction can still reject it.
      kernelTrace({
        stage: "candidate.proposal.admit",
        label: "kernel.turn.source_exact",
        counts: {
          proposed: answerProposal ? 1 : 0,
          sourceExcerpts: proofSourceExcerpts.length,
          admitted: evidenceProposalAdmissible ? 1 : 0,
          supportEngineDisabled: deps.evaluationCondition?.flags.disableSupportEngine ? 1 : 0
        },
        support: {
          entailmentContradiction: entailmentResult.contradiction,
          semanticProofContradiction,
          proposalContradiction
        }
      });
      const localEvidenceAnswer = deps.evaluationCondition?.flags.disableSupportEngine
        ? undefined
        : selectedPoolLocalEvidenceAnswer;
      // Reverted from an unconditional use of localEvidenceAnswer: that
      // change caused a real regression (a creative candidate's own
      // factual-premise evidenceIds were getting silently cleared by
      // bindSelectedEvidenceToEntailment's rebinding, meant for non-creative
      // answers, once it started firing for creative turns too -- see
      // kernel-local-evidence-anchor.test.ts's "keeps a source-inspired
      // request creative..." case). The compositional per-claim fix
      // (assistant-force.ts) does not depend on this variable; only this
      // one downstream rebinding path does, and it isn't creative-safe.
      const longPathBasisAnswer = requestedAuthority === "creative" ? undefined : localEvidenceAnswer;
      // bindSelectedEvidenceToEntailment binds longPathBasisAnswer's evidence
      // into the entailment (evidenceIds, proof graph nodes/edges) and, for
      // a temporal-counterexample basis specifically, promotes force to
      // "inferred" and truthState to "truth.source_bound_only" -- without
      // it, a temporal-counterexample answer keeps whatever truthState the
      // base entailment happened to have (typically
      // "truth.insufficient_evidence", since the base entailment doesn't
      // know about the local-evidence-derived counterexample). Preserve the
      // existing "local-evidence-certification-boundary" marker mouth.ts
      // checks for alongside the boundaries bindSelectedEvidenceToEntailment
      // already adds.
      const boundLongPathEntailment = longPathBasisAnswer
        ? bindSelectedEvidenceToEntailment(entailmentResult, longPathBasisAnswer.evidence, longPathBasisAnswer.audit)
        : undefined;
      const answerEntailmentSeed = boundLongPathEntailment
        ? {
          ...boundLongPathEntailment,
          boundaries: [...new Set([...boundLongPathEntailment.boundaries, "local-evidence-certification-boundary"])]
        }
        : entailmentResult;
      if (longPathBasisAnswer) {
        selectedEvidence = runtimeEvidenceWindowsForRequest(input.text, longPathBasisAnswer.evidence);
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
      const candidateLanguageStarted = Date.now();
      // Unlike the other language-memory reads above, this one was never
      // gated on disableLanguageMemory -- under the no_language_memory
      // evaluation condition it still queried listLanguagePatterns (via
      // surfaceLanguageProfilesCached), a real storage read the condition
      // is supposed to eliminate entirely.
      const evidenceSurfaceClusters = deps.evaluationCondition?.flags.disableLanguageMemory
        ? []
        : (await surfaceLanguageProfilesCached(fastRuntimeBudget)).clusters;
      const evidenceSurfaceCluster = selectLanguageProfileClusterForSourceVersions(
        evidenceSurfaceClusters,
        selectedEvidence.map(span => span.sourceVersionId)
      );
      const preferredSurfaceCorpusRole = requestedAuthority === "creative"
        ? CORPUS_ROLE_IDS.publicDomainProse
        : undefined;
      const exactCreativeAuthorityReady = Boolean(
        preferredSurfaceCorpusRole
        && selectedSurfaceCluster
        && authorityLanguage.state.scope.mode === "cluster"
        && authorityLanguage.state.scope.purityProven
        && [...authorityLanguage.state.scope.profileIds].sort().join("\u001f")
          === [...selectedSurfaceCluster.profileIds].sort().join("\u001f")
        && authorityLanguage.state.importedConstructionBundles.some(bundle =>
          (bundle.creativeEvents?.length ?? 0) > 0
        )
      );
      // Durable candidate-stage hydration ran 54s on a cold turn AFTER the
      // deadline had passed -- the checks only ran once it finished. Consult
      // the deadline first; past-budget turns hydrate resident-only.
      // requiredMs is the honest worst cost: a cold durable hydrate loads
      // whole ngram model blobs (measured 55s); admitting it on a 1.5s
      // estimate let a 10s turn run 61s.
      const candidateHydrateDecision = deadlineCheckpoint("runtime.candidates.language_hydrate", 5_000);
      // A near-duplicate turn quotes, it does not generate: no threshold can
      // bound a 55s stage, so the quote regime skips durable hydration.
      const turnSequences = requestSentenceSequences(input.text);
      const nearDuplicateTurn = turnSequences.length > 0
        && selectedEvidence.some(span => spanContainsRequestNearDuplicateSentence(span, turnSequences));
      const candidateHydrateResidentOnly = fastRuntimeBudget || nearDuplicateTurn || candidateHydrateDecision?.allowed === false;
      const evidenceOutputLanguage = evidenceSurfaceCluster && evidenceSurfaceCluster.id !== selectedSurfaceCluster?.id
        ? await hydrateSurfaceLanguageMemoryResidentOrDurable(
          12,
          evidenceSurfaceCluster,
          "evidence-source-cluster-selected",
          undefined,
          "",
          { residentOnly: candidateHydrateResidentOnly }
        )
        : undefined;
      // Deliberately NOT residentOnly even under the fast runtime budget: a
      // creative long-form request cannot meet the fast-first-response
      // contract anyway (generation itself dominates), so failing the whole
      // turn because the prose-role cluster wasn't already warm turned every
      // first creative request on a fresh server into a 500 ("resident
      // language-memory:creative-output-language-unresolved was not
      // warmed") -- verified live. The first creative turn pays the durable
      // hydration once; the cache holds it for every later one.
      const creativeOutputLanguage = preferredSurfaceCorpusRole
        ? await hydrateSurfaceLanguageMemoryCached(
          12,
          selectedSurfaceCluster,
          "creative-output-language-unresolved",
          preferredSurfaceCorpusRole,
          input.text,
          { residentOnly: false }
        )
        : undefined;
      let surfaceLanguage = preferredSurfaceCorpusRole
        ? exactCreativeAuthorityReady
          ? authorityLanguage
          : requireHydratedSurfaceLanguage(
            creativeOutputLanguage,
            `creative corpus role ${preferredSurfaceCorpusRole}`
          )
        : evidenceOutputLanguage
          ? evidenceOutputLanguage
          : authorityLanguage;
      const productionTranslationProfiles = translationTarget
        ? (await sourceOwnedLanguageProfilesCached(
          [translationTarget],
          { residentOnly: fastRuntimeBudget }
        )).profiles
        : [];
      let productionTranslationPlan: TranslationPlan | undefined;
      if (translationTarget) {
        const canonicalTranslationTarget = canonicalTranslationTargetKey(translationTarget);
        const priorAlignments = await deps.storage.languageMemory.listTranslationAlignments({ targetLanguage: canonicalTranslationTarget, limit: 500 });
        // Plan item 121: real bilingual correspondence a prior call already
        // induced and persisted for this target language, so this request's
        // own (possibly sparse) admitted evidence is not the only source of
        // seed substitution.
        const durableSeeds = deps.storage.translationSeeds
          ? await deps.storage.translationSeeds.listSeeds(canonicalTranslationTarget)
          : [];
        // Plan item 127: durable multi-symbol constructions from prior
        // requests, reusable against a new sentence binding the same
        // symbols in a different context.
        const durableConstructions = deps.storage.translationConstructions
          ? await deps.storage.translationConstructions.listConstructions(canonicalTranslationTarget)
          : [];
        productionTranslationPlan = translationEngine.plan({
          text: input.text,
          targetLanguage: translationTarget,
          evidence: selectedEvidence,
          profiles: productionTranslationProfiles,
          priorAlignments,
          durableSeeds,
          durableConstructions,
          calibrationModels,
          createdAt: clock.now()
        });
        if (deps.storage.translationSeeds && productionTranslationPlan.inducedSeeds.length) {
          await deps.storage.translationSeeds.putSeeds({
            sourceLanguage: productionTranslationPlan.sourceLanguage,
            targetLanguage: canonicalTranslationTarget,
            seeds: productionTranslationPlan.inducedSeeds,
            observedAt: clock.now()
          });
        }
        if (deps.storage.translationConstructions && productionTranslationPlan.inducedConstructions.length) {
          await deps.storage.translationConstructions.putConstructions({
            targetLanguage: canonicalTranslationTarget,
            constructions: productionTranslationPlan.inducedConstructions,
            observedAt: clock.now()
          });
        }
        // Plan item 129: a real calibration observation for this turn's
        // translation -- rawScore is the pre-calibration preservation
        // figure `calibratedConfidence` was derived from, outcome is the
        // real, deterministic item-125 preservation-gate verdict (did this
        // translation actually keep every required number/date/code
        // symbol), not user feedback that may never arrive. Feeds the same
        // fit pipeline (buildCalibrationModelsById) already used for every
        // other calibrated subsystem.
        await deps.storage.dialogueMemory?.putCalibrationObservation?.(calibrationObservationRecord({
          calibrationId: CALIBRATION_IDS.translationPreservation,
          subsystemId: CALIBRATION_SUBSYSTEM_IDS.translation,
          taskClass: CALIBRATION_TASK_CLASS_IDS.translation,
          rawScore: productionTranslationPlan.calibratedConfidence.raw,
          outcome: productionTranslationPlan.construct.preservationValidation.valid && productionTranslationPlan.force !== "unknown",
          sourceRecordId: productionTranslationPlan.id,
          metadata: toJsonValue({ targetLanguage: canonicalTranslationTarget, sourceLanguage: productionTranslationPlan.sourceLanguage, force: productionTranslationPlan.force }),
          createdAt: clock.now()
        }));
        if (deps.evaluationCondition?.flags.disableLanguageMemory !== true) {
          surfaceLanguage = productionTranslationPlan.targetCluster
            ? await hydrateSurfaceLanguageMemoryResidentOrDurable(
              12,
              productionTranslationPlan.targetCluster,
              "translation-target-cluster-selected",
              undefined,
              "",
              { residentOnly: fastRuntimeBudget }
            )
            : await hydrateSurfaceLanguageMemoryResidentOrDurable(
              12,
              undefined,
              "translation-target-ambiguous-or-unknown",
              undefined,
              "",
              { residentOnly: fastRuntimeBudget }
            );
        }
      }
      const surfaceLanguageModels = surfaceLanguage.models;
      const surfaceLanguageMemory = surfaceLanguage.state;
      if (requestedAuthority === "creative") {
        creativeRequestFrame = compileCreativeRequestFrameFromCompatibilityModels({
          requestText: input.text,
          models: surfaceLanguageMemory.creativeEventCompatibilityModels,
          hasher
        });
      }
      kernelTrace({
        stage: "candidate.language.hydrate",
        label: "kernel.turn",
        durationMs: Date.now() - candidateLanguageStarted,
        counts: {
          models: surfaceLanguageModels.length,
          patterns: surfaceLanguage.patterns.length,
          semanticFrames: surfaceLanguage.semanticFrames.length
        },
        support: {
          requestedAuthority,
          corpusRole: preferredSurfaceCorpusRole ?? null,
          creativeRequestFrameId: creativeRequestFrame?.id ?? null,
          creativeRequestCompilerId: creativeRequestFrame?.compilerId ?? null,
          creativeRequestActivations: creativeRequestFrame?.sourceActivationIds.length ?? 0
        }
      });
      if (creativeRequestFrame) {
        events.push(await append(eventFactory.create({
          episodeId,
          typeId: "CreativeRequestFrameProjected",
          payload: toJsonValue({
            id: creativeRequestFrame.id,
            compilerId: creativeRequestFrame.compilerId,
            focusHash: hasher.digestHex(creativeRequestFrame.focus.span.text),
            argumentCount: creativeRequestFrame.arguments.length,
            explicitRelationId: creativeRequestFrame.explicitRelationId ?? null,
            sourceActivationIds: creativeRequestFrame.sourceActivationIds.slice(0, 24)
          })
        })));
      }
      const candidatePriorStarted = Date.now();
      const brain = await activeBrainMarker();
      events.push(await append(eventFactory.create({ episodeId, typeId: "BrainInfluenceObserved", payload: { ...brain as Record<string, JsonValue>, languageMemory: surfaceLanguageMemoryProfile(surfaceLanguageMemory, deps.evaluationCondition?.flags.disableLanguageMemory === true) } })));
      const correctionRules = correctionMemory.retrieve({
        rules: mergeCorrectionRules(await correctionRulesCached(), detectedCorrections),
        context: { targetLanguageId: translationTarget ?? locale, targetScriptId: undefined },
        limit: 96
      });
      kernelTrace({
        stage: "candidate.prior.bind",
        label: "kernel.turn",
        durationMs: Date.now() - candidatePriorStarted,
        counts: { correctionRules: correctionRules.length }
      });
      const answerSurface = longPathBasisAnswer
        ? {
          answer: longPathBasisAnswer.answer || localEvidenceAnswerClaimSurface(longPathBasisAnswer),
          audit: toJsonValue({
            source: "kernel.turn.long_path_basis_answer",
            basis: longPathBasisAnswer.audit,
            evidenceIds: selectedEvidence.map(span => String(span.id)),
            evidenceCount: selectedEvidence.length,
            fakeEvidenceForbidden: true
          })
        }
        : composeEvidenceGroundedAnswer({ requestText: input.text, entailment: answerEntailmentSeed, evidence: selectedEvidence, field, ccr: ccrResult, languageModels: surfaceLanguageModels, languageMemory: surfaceLanguageMemory, locale });
      // Real bug, confirmed live: for "when did Ada Lovelace die?", the
      // longPathBasisAnswer branch above (bypasses composeEvidenceGroundedAnswer
      // entirely) picked a sentence that merely scored well lexically --
      // shared the subject's name and *a* date -- not the sentence that
      // actually states the death date. This is the same class of defect
      // already fixed in answer-emitter.ts, but that fix only covers
      // callers that reach composeEvidenceGroundedAnswer; longPathBasisAnswer
      // is a separate branch with its own sentence-scoring
      // (local-evidence-runtime.ts's bestEvidenceSentences). Applying the
      // override here, once, after both branches converge, covers every
      // path uniformly instead of patching each sentence-scorer
      // separately. Never fabricates: returns undefined (falls through to
      // whichever branch's real answer) for anything that isn't a
      // recognizable temporal question.
      const proofAnswer = extractTemporalAnswerFromEvidence(input.text, selectedEvidence) || answerSurface.answer;
      const candidateConstructSeed = programBuilder.build({ episodeId, text: input.text, entailment: answerEntailmentSeed, evidence: selectedEvidence, createdAt: clock.now() });
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
      const capabilityPlanPreview = toolCognition.previewPlans({
        request: input.text,
        capabilities: connectorGovernance.capabilities(defaultConnectorConfigs()),
        policy,
        evidence: selectedEvidence,
        field,
        actionCommitment: requirementField.actionCommitment
      });
      const projectionStarted = Date.now();
      const projectionNow = clock.now();
      const [runtimeModel, priorStates, persistedPersonaEvents, durablePolicyGenomes] = await Promise.all([
        deps.storage.model.readModel(),
        deps.storage.forecasts.getSeries({ limit: 64 }),
        deps.storage.events.readRange({ typeId: "SelfModelProjected", beforeT: projectionNow, limit: 9 }),
        deps.storage.policyEvolution?.listGenomes({ objectiveSchemaId: POLICY_OBJECTIVE_SCHEMA_ID, limit: 64 }) ?? Promise.resolve([])
      ]);
      const selfState = await createFunctionalSelfModel({ storage: deps.storage, model: runtimeModel, policy, recentFailures: failures });
      // Always computed (cheap, pure) -- used unconditionally below for
      // real forecast persistence (deps.storage.forecasts.putState/
      // putForecast, TurnResult.forecast), independent of whether the
      // functional-cognition projection below is live or deferred.
      const state = prediction.state({ episodeId, graph, alphaTrace: field.alphaTrace, t: projectionNow });
      const forecast = prediction.forecast({ states: priorStates, source: state, horizon: 2, createdAt: projectionNow });
      /**
       * Real, measured fix: this whole block (self-distillation, functional
       * consciousness scoring, counterfactual/persona/policy-population
       * projection) cost ~30-45 real seconds on every single turn --
       * measured live via SCCE_TRACE against the real database -- yet
       * `functionalCapabilityAuthorizationGate` unconditionally forces
       * `fc`/`efc` to `false` whenever `deps.functionalCognitionAuthorizeCapabilities`
       * isn't `true`, which is the common case. When that's true, this
       * turn's real answer was blocked on self-reflection audit data that
       * provably cannot authorize anything this turn -- audit/introspection
       * work with no business being on the critical path to a chat answer.
       * It is real, genuinely useful work (persisted for real, read back by
       * later turns) -- just not work this turn's response should wait on.
       * When capabilities genuinely need live authorization, the full
       * synchronous computation still runs exactly as before; only the
       * common, unauthorized case is deferred.
       */
      const requiresLiveFunctionalCognition = deps.functionalCognitionAuthorizeCapabilities === true;
      const lastPersistedSelfModel = jsonRecord(persistedPersonaEvents[0]?.payload);
      let functionalGate: FunctionalSelectionGate;
      let selfDistillationAudit: JsonValue;
      let functionalConsciousnessAudit: JsonValue;
      let functionalCognitionAudit: JsonValue;
      // The standing self-state register replaces per-turn synchronous
      // projection in BOTH modes: no turn ever blocks 30-45s on
      // self-reflection. In authorized deployments the register's real
      // fc/efc (bounded by freshness) authorize live; in audit-only
      // deployments functionalCapabilityAuthorizationGate still forces
      // them false, exactly as before. The deferred task below refreshes
      // the register continuously; the first turn after a cold start
      // honestly reads it as missing (gate down, warming).
      const standingRead = standingFunctionalGate({
        standing: runtimeState.standingFunctionalCognition,
        now: projectionNow,
        authorizeCapabilities: requiresLiveFunctionalCognition
      });
      {
        functionalGate = standingRead.gate;
        selfDistillationAudit = lastPersistedSelfModel.selfDistillation ?? null;
        functionalConsciousnessAudit = lastPersistedSelfModel.fcs ?? null;
        functionalCognitionAudit = lastPersistedSelfModel.functionalCognition ?? null;
        kernelTrace({
          stage: "functional-cognition.project",
          label: "kernel.turn.preselection",
          durationMs: Date.now() - projectionStarted,
          counts: { personaSnapshots: 0, counterfactualTraces: runtimeState.lastRejectedCandidateTraces?.length ?? 0, policyPopulation: 0, durablePolicyGenomes: durablePolicyGenomes.length },
          support: {
            fc: functionalGate.fc,
            efc: functionalGate.efc,
            gov: functionalGate.gov,
            authorizeCapabilities: requiresLiveFunctionalCognition,
            authorizedFc: functionalGate.fc,
            authorizedEfc: functionalGate.efc,
            standingSource: standingRead.source,
            standingAgeMs: standingRead.ageMs ?? null,
            deferred: true
          }
        });
        // The real computation still runs -- for real, on the real graph,
        // real storage, real durable event -- just after this turn's
        // response, not blocking it. A later turn's persistedPersonaEvents
        // read genuinely sees it, same as if it had run synchronously here.
        // CRITICAL fix, v2: an in-process concurrency counter alone only
        // bounds *how many* of these run at once -- it does not stop any
        // single one from holding a real, potentially large `graph` in the
        // *main process's own heap* for its whole real 30-45s runtime, on a
        // machine that is also running the editor and Postgres on the same
        // 16GB of RAM (reproduced live: a real "JavaScript heap out of
        // memory" crash even with a small cap). The real fix mirrors how
        // the wikipedia ingestor already avoids this: on a long-lived
        // server absorbing continuous real traffic, the heavy work runs in
        // a separate, short-lived child process with its own hard
        // `--max-old-space-size` heap ceiling (functional-cognition-offload.ts),
        // so it can never grow the caller's own heap no matter how large
        // `graph` is or how long it runs. That real OS process spawn is
        // NOT free, though: firing it from hundreds of short-lived kernels
        // created rapid-fire (every unit test creates its own) reproduced
        // the exact same "JavaScript heap out of memory" crash, just in the
        // test runner's worker process instead of the server's. Gated
        // behind deps.functionalCognitionOffloadProcess (see storage.ts) so
        // only a real, long-lived adapter-backed runtime opts in; anything
        // that builds ScceKernelDeps by hand (every test fixture) safely
        // falls back to the cheap, real in-process computation instead.
        // Concurrency is capped at 1 (serial, like the ingestor's
        // one-child-at-a-time-then-respawn model) either way: each in-flight
        // task, process-isolated or not, is real work stacked on top of
        // whatever the live turn path and Postgres are already holding.
        // Past the cap, a turn simply skips deferring this audit-only work
        // rather than queuing -- the next turn under the cap catches up the
        // real audit trail; nothing is ever fabricated, only delayed.
        const DEFERRED_FUNCTIONAL_COGNITION_MAX_CONCURRENT = 1;
        // Refresh the standing register when it is missing or has burned
        // half its TTL -- continuous background self-projection keeps the
        // gate warm in both authorized and audit-only modes, so authorized
        // deployments never pay a synchronous projection either.
        const standingAgeMs = runtimeState.standingFunctionalCognition
          ? projectionNow - runtimeState.standingFunctionalCognition.computedAt
          : Number.POSITIVE_INFINITY;
        const standingNeedsRefresh = standingAgeMs > STANDING_FUNCTIONAL_COGNITION_TTL_MS / 2;
        if (standingNeedsRefresh && runtimeState.deferredFunctionalCognitionInFlight < DEFERRED_FUNCTIONAL_COGNITION_MAX_CONCURRENT) {
          runtimeState.deferredFunctionalCognitionInFlight++;
          void (async () => {
          try {
            const policyPopulation = durablePolicyGenomes.map(policyGenomeFromDurable);
            const personaHistory = personaHistoryFromEvents(
              persistedPersonaEvents,
              personaSnapshotFromSelf({ sessionId: String(episodeId), self: selfState, t: projectionNow })
            );
            const governance = deps.governance
              ? await deps.governance.observe({ policy, now: projectionNow }).catch(error =>
                unavailableGovernanceObservation(
                  projectionNow,
                  `governance_probe_error:${error instanceof Error ? error.message : String(error)}`
                ))
              : unavailableGovernanceObservation(projectionNow);
            const offloadInput = {
              now: projectionNow,
              self: selfState,
              model: runtimeModel,
              graph,
              policy,
              state,
              forecast,
              learningNeeds: earlyLearningNeeds,
              personaHistory,
              governance,
              // Real counterfactuals lead: the candidates the judge
              // actually rejected (previous turn), then capability-plan
              // previews as supplementary projection material.
              traces: [
                ...(runtimeState.lastRejectedCandidateTraces ?? []),
                ...counterfactualTracesFromCapabilityPreview(capabilityPlanPreview)
              ].slice(0, 16),
              policyPopulation
            };
            const offloaded = deps.functionalCognitionOffloadProcess === true
              ? await runFunctionalCognitionOffProcess(offloadInput)
              : (() => {
                const selfDistillation = ssd.distill(offloadInput);
                const functionalConsciousness = fcs.score({ self: offloadInput.self, ssd: selfDistillation });
                const functionalCognition = functionalCognitionEngine.project({ ...offloadInput, ssdAudit: selfDistillation.audit });
                return {
                  selfDistillationAudit: selfDistillation.audit,
                  functionalConsciousnessAudit: functionalConsciousness.audit,
                  functionalCognitionAudit: functionalCognition.audit,
                  gate: functionalSelectionGate(functionalCognition)
                };
              })();
            if (offloaded.gate) {
              runtimeState.standingFunctionalCognition = { gate: offloaded.gate, computedAt: projectionNow };
            }
            await append(eventFactory.create({
              episodeId,
              typeId: "SelfModelProjected",
              payload: {
                phase: "preselection",
                self: selfState,
                selfDistillation: offloaded.selfDistillationAudit as JsonValue,
                fcs: offloaded.functionalConsciousnessAudit as JsonValue,
                functionalCognition: offloaded.functionalCognitionAudit as JsonValue,
                capabilityPlanPreview: toJsonValue({
                  objectives: capabilityPlanPreview.objectives.map(objective => ({ id: objective.id, kind: objective.kind })),
                  scoredCount: capabilityPlanPreview.scored.length
                }),
                authorizeCapabilities: false
              }
            }));
          } catch {
            // A failed deferred self-projection must never surface as a
            // turn error -- it already finished responding to the caller.
          } finally {
            runtimeState.deferredFunctionalCognitionInFlight--;
          }
          })();
        }
      }
      // Plan item 161 live wiring: this real, already-tested induction pass
      // (episodic-memory-consolidation.ts's now-live 211-212 output is its
      // real input) was never called from a live turn. Deferred and
      // throttled for the same reason as the functional-cognition audit
      // above -- real, repeated Postgres round-trips per attempt, not free
      // -- but no child-process isolation is needed here: this is I/O-bound
      // ledger scanning, not a large in-memory/CPU computation.
      const REASONING_OPERATOR_INDUCTION_MIN_INTERVAL_MS = 5 * 60 * 1000;
      if (
        !runtimeState.reasoningOperatorInductionInFlight
        && clock.now() - runtimeState.lastReasoningOperatorInductionAttemptAt >= REASONING_OPERATOR_INDUCTION_MIN_INTERVAL_MS
      ) {
        runtimeState.reasoningOperatorInductionInFlight = true;
        runtimeState.lastReasoningOperatorInductionAttemptAt = clock.now();
        void (async () => {
          try {
            const induced = await induceOperatorFromLedger(deps.storage.events);
            if (induced?.promotion.promoted) {
              await append(eventFactory.create({
                episodeId,
                typeId: "ReasoningOperatorInduced",
                payload: toJsonValue({
                  actionTypeSequence: induced.promotion.candidate.actionTypeSequence,
                  supportCount: induced.promotion.candidate.supportCount,
                  descriptionLengthSavedUnits: induced.promotion.candidate.descriptionLengthSavedUnits,
                  promotion: induced.promotion,
                  fitCount: induced.fitCount,
                  heldOutCount: induced.heldOutCount
                })
              }));
            }
          } catch {
            // A failed deferred induction attempt must never surface as a
            // turn error -- it already finished responding to the caller.
          } finally {
            runtimeState.reasoningOperatorInductionInFlight = false;
          }
        })();
      }
      const candidateApprovalPolicyPatch = deps.approvals?.policyPatch?.() ?? {};
      const candidateActionPlans = candidateConstructSeed.program || candidateConstructSeed.artifacts.length
        ? toolCognition.plan({
          episodeId,
          request: input.text,
          capabilities: connectorGovernance.capabilities(defaultConnectorConfigs()),
          policy,
          evidence: selectedEvidence,
          field,
          actionCommitment: requirementField.actionCommitment,
          temporaryOperatorGrant: { enabled: candidateApprovalPolicyPatch.dryRunByDefault === false },
          functionalGate
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
      const inventionPlanStarted = Date.now();
      const plannedInventionCandidates = planInventions({
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
        creativeRequestFrame,
        samplingDisabled: deps.deterministicReplay === true
      });
      kernelTrace({
        stage: "candidate.invention.plan",
        label: "kernel.turn",
        durationMs: Date.now() - inventionPlanStarted,
        counts: { candidates: plannedInventionCandidates.length }
      });
      const runtimeTerminalPriorContext = inheritedRuntimeMotion
        && inheritedRuntimeMotion.status !== "hydrated"
        && (requestedAuthority === "factual" || requestedAuthority === "reasoned")
        ? runtimeTerminalInventionPriorContext({ graph, field, languageMemoryState: surfaceLanguageMemory, requirementField })
        : undefined;
      const runtimeTerminalInventions = runtimeTerminalPriorContext
        ? planInventions({
          requestText: input.text,
          requestedAuthority,
          field,
          graph: runtimeTerminalPriorContext.graph,
          languageMemory: languageMemoryRuntime,
          languageMemoryState: runtimeTerminalPriorContext.languageMemoryState,
          dialogueState: authorityDialogueState,
          evidence: [],
          construct: candidateConstructSeed,
          requirementField: {
            ...requirementField,
            noveltyDemand: Math.max(0.5, requirementField.noveltyDemand),
            activatedConstructIds: uniqueKernelStrings([
              ...requirementField.activatedConstructIds,
              RUNTIME_TERMINAL_INVENTION_POLICY_ID
            ])
          },
          operatorActivations,
          creativeRequestFrame,
          samplingDisabled: true,
          maxCandidates: 1
        }).filter(invention => runtimeTerminalInventionIsAdmissible({
          invention,
          requestText: input.text,
          eligiblePriorIds: runtimeTerminalPriorContext.eligiblePriorIds
        }))
        : [];
      const inventionCandidates = uniqueInventionConstructs([
        ...runtimeTerminalInventions,
        ...plannedInventionCandidates
      ]);
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
      const cognitiveProposalStarted = Date.now();
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
        workspacePlans: workspacePlanContext.plans,
        actionPlans: cognitiveActionPlans,
        maxProposals: 8
      });
      kernelTrace({
        stage: "candidate.cognitive.plan",
        label: "kernel.turn",
        durationMs: Date.now() - cognitiveProposalStarted,
        counts: { proposals: cognitiveProposals.length }
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
      // Plan items 160/162: a real, checked reasoning-operators.ts
      // comparisonOperator receipt proving the final selected cognitive
      // proposals' relative order really does follow MMR's declared
      // weights (COGNITIVE_PROPOSAL_BOOTSTRAP.mmr), computed from the same
      // quality/diversity values selectWithMmr's own greedy process already
      // produced -- not a recomputation or replacement of that selection.
      // Absent (not fabricated) whenever fewer than two proposals exist.
      const cognitiveProposalComparison = cognitiveProposalComparisonReceipt(cognitiveProposals);
      if (cognitiveProposalComparison) {
        events.push(await append(eventFactory.create({ episodeId, typeId: "ReasoningOperatorApplied", payload: toJsonValue(cognitiveProposalComparison) })));
      }
      // Plan items 169-170: real Allen-relation conflicts among peer edges.
      const temporalConflicts = conflictingGraphEdgeIntervals(graph.edges);
      if (temporalConflicts.length) {
        events.push(await append(eventFactory.create({ episodeId, typeId: "TemporalConflictDetected", payload: toJsonValue(temporalConflicts.map(([left, right]) => ({ leftEdgeId: String(left.id), rightEdgeId: String(right.id) }))) })));
      }
      const candidateFieldStarted = Date.now();
      const candidateField = candidates.generate({
        requestText: input.text,
        requestedAuthority,
        inventionCandidates,
        requirementField,
        operatorActivations,
        cognitiveProposals,
        dialogueState: toJsonValue(authorityDialogueState),
        workspacePlans: [
          ...workspacePlanContext.plans.map(plan => toJsonValue(plan)),
          ...candidateConstructSeed.artifacts.map(artifact => toJsonValue({
            schema: "scce.workspace.proposed_artifact.v1",
            path: artifact.path,
            contentHash: artifact.contentHash,
            mediaType: artifact.mediaType,
            role: artifact.role
          }))
        ],
        actionPlans: candidateActionPlans.map(plan => toJsonValue(plan)),
        entailment: answerEntailmentSeed,
        evidence: selectedEvidence,
        field,
        ccr: ccrResult,
        proofAnswer,
        learningNeeds: earlyLearningNeeds,
        locale,
        calibrationModels,
        calibrationTaskClass,
        functionalGate
      });
      kernelTrace({
        stage: "candidate.field.generate",
        label: "kernel.turn",
        durationMs: Date.now() - candidateFieldStarted,
        counts: { candidates: candidateField.candidates.length }
      });
      let authorityCandidateField = admitCandidatesForAuthority(candidateField, requestedAuthority);
      let runtimeSurfaceMotion: RuntimeReplanMotion | undefined;
      const candidateMotionTrigger = requestedAuthority === "creative" || runtimeDiagnosticRequested
        ? undefined
        : runtimeCandidateReplanTrigger(authorityCandidateField, requestedAuthority, selectedEvidence);
      // A completed acquisition attempt is context for this replan, not an
      // instruction to discard a candidate that the replan can now realize.
      // Only the current field decides whether a terminal motion surface is
      // still required.
      if (candidateMotionTrigger) {
        const trigger = candidateMotionTrigger ?? inheritedRuntimeMotion?.trigger ?? "coherence_support_failure";
        let motion = inheritedRuntimeMotion;
        if (!motion) {
          const recoveryDecision = deadlineCheckpoint("runtime.replan.acquire", 5_000);
          if (recoveryDecision?.allowed !== false) {
            motion = await learnHydrateReplan({
              ownerInput: input,
              episodeId,
              requestedAuthority,
              trigger,
              events
            });
            performedRuntimeMotion = motion;
            if (runtimeMotionAddedEvidence(motion)) {
              runtimeState.lastField = undefined;
              return turn({
                ...input,
                metadata: metadataWithRuntimeReplanMotion(input.metadata, motion)
              });
            }
          }
          motion = runtimeMotionDeferredByDeadline({
            episodeId,
            requestedAuthority,
            trigger,
            requestText: input.text,
            connectorConfigured: Boolean(deps.connectors),
            decision: recoveryDecision
          });
          events.push(await append(eventFactory.create({
            episodeId,
            typeId: "ActionPrepared",
            payload: toJsonValue({
              runtimeMotion: motion,
              deadlineDecision: recoveryDecision,
              acquisitionStarted: false
            })
          })));
        }
        runtimeSurfaceMotion = motion;
        const terminalInvention = runtimeTerminalInventions[0];
        const terminalInventionCandidate = terminalInvention
          ? candidateField.candidates.find(candidate => candidate.constructIds?.includes(terminalInvention.id)
            || kernelString(jsonRecord(candidate.audit).constructId) === terminalInvention.id)
          : undefined;
        authorityCandidateField = runtimeMotionCandidateField({
          base: authorityCandidateField,
          requestText: input.text,
          authority: requestedAuthority,
          motion,
          inventionCandidate: terminalInventionCandidate,
          unresolvedSlots: authorityDialogueState.unresolvedSlots,
          learnedLanguageFrameIds: surfaceLanguageMemory.importedSemanticFrames.map(frame => frame.id),
          hasher
        });
      }
      const generatedCandidates = new Map<string, CandidateSurface>();
      for (const candidate of [...candidateField.candidates, ...authorityCandidateField.candidates]) generatedCandidates.set(candidate.id, candidate);
      for (const candidate of generatedCandidates.values()) {
        const candidateProposal = cognitiveProposalForCandidate(candidate, cognitiveProposals)
          ?? assistantForceProposalFromCandidateClaimBasis(candidate);
        const candidateAssistantForce = assistantForceDecision({
          requestedAuthority,
          selectedProposal: candidateProposal,
          epistemicForce: candidate.force,
          proofVerdict: semanticProof.verdict,
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
        counts: {
          candidates: generatedCandidates.size,
          admittedCandidates: authorityCandidateField.candidates.length
        },
        support: {
          candidates: [...generatedCandidates.values()].slice(0, 6).map(candidate => ({
            id: candidate.id,
            kind: candidate.kind,
            force: candidate.force,
            assistantForce: assistantForceDecision({
              requestedAuthority,
              selectedProposal: cognitiveProposalForCandidate(candidate, cognitiveProposals)
                ?? assistantForceProposalFromCandidateClaimBasis(candidate),
              epistemicForce: candidate.force,
              proofVerdict: semanticProof.verdict,
              evidenceIds: candidate.evidenceIds,
              directEvidenceIds: selectedEvidence.map(span => span.id),
              constructForces: candidate.kind === "creative-candidate" ? ["CreativeConstruct"] : [],
              support: candidate.scores.support,
              contradiction: candidate.scores.contradiction
            }).force,
            scores: candidate.scores,
            evidenceIds: candidate.evidenceIds.length
          })),
          surfaceMass: authorityCandidateField.surfaceMass.slice(0, 6),
          authorityAdmission: authorityCandidateField.audit
        }
      });
      // Plan items 156-157's typed working memory, task-scoped to this
      // turn's candidate selection: every generated candidate is recorded
      // as a real hypothesis here, genuinely before the judge decides --
      // not as a post-hoc receipt of a decision already made. The judge's
      // eventual choice only changes promotionStatus afterward (see below).
      const candidateSelectionTaskId = `task.turn.${episodeId}.candidate_selection`;
      let candidateWorkingMemory = EMPTY_WORKING_MEMORY;
      for (const candidate of authorityCandidateField.candidates) {
        candidateWorkingMemory = putWorkingMemoryEntry(candidateWorkingMemory, {
          id: `wm.${episodeId}.${candidate.id}`,
          taskId: candidateSelectionTaskId,
          type: "hypothesis",
          createdBy: candidate.kind,
          confidence: clamp01(candidate.scores.support),
          payload: toJsonValue({ candidateId: candidate.id, kind: candidate.kind, force: candidate.force }),
          createdAt: turnStarted,
          expiresAt: turnStarted + 15 * 60 * 1000
        });
      }
      const judged = judge.select({
        field: authorityCandidateField,
        policy,
        requestedAuthority,
        requirementField,
        deterministicReplay: deps.deterministicReplay,
        functionalGate
      });
      // The judge's rejected candidates are NOT deleted from working
      // memory: they stay as provisional, unpromoted entries (with their
      // rejection reasons attached) so a later step within this same task
      // can still revisit/backtrack to one of them. They only ever "stay
      // out of canonical knowledge" by never being promoted -- not by
      // being erased the moment they lose -- and they still expire like
      // any other unpromoted entry (see expiresAt above). The winning
      // candidate's existing entry is promoted with the judge's full audit
      // as its derivation, so a later reader can see exactly why it won.
      for (const rejected of judged.rejected) {
        candidateWorkingMemory = putWorkingMemoryEntry(candidateWorkingMemory, {
          id: `wm.${episodeId}.${rejected.candidate.id}`,
          taskId: candidateSelectionTaskId,
          type: "hypothesis",
          createdBy: rejected.candidate.kind,
          confidence: clamp01(rejected.candidate.scores.support),
          payload: toJsonValue({ candidateId: rejected.candidate.id, kind: rejected.candidate.kind, force: rejected.candidate.force, rejectionReasons: rejected.reasons }),
          createdAt: turnStarted,
          expiresAt: turnStarted + 15 * 60 * 1000
        });
      }
      // If this attempt is a replan continuation, check whether the
      // winning candidate is a real revival of a hypothesis the *prior*
      // attempt's judge rejected (same kind, same normalized-answer-text
      // hash) -- proof that the carried-forward working-memory record
      // actually informed this decision, not just that regeneration
      // coincidentally produced similar text. This is genuinely
      // across-attempt memory use, not telemetry: the prior rejection
      // reasons are attached to the promotion's own derivation.
      const revivedPriorHypothesis = inheritedRuntimeMotion
        ? reviveMatchingPriorRejectedHypothesis(judged.selected, inheritedRuntimeMotion.priorRejectedHypotheses, hasher)
        : undefined;
      candidateWorkingMemory = promoteWorkingMemoryEntry(candidateWorkingMemory, `wm.${episodeId}.${judged.selected.id}`, {
        derivation: toJsonValue({
          judge: judged.audit,
          candidateAudit: judged.selected.audit,
          ...(revivedPriorHypothesis ? { revivedFromPriorAttempt: true, priorRejectionReasons: revivedPriorHypothesis.rejectionReasons } : {})
        }),
        promotedAt: turnStarted
      });
      if (revivedPriorHypothesis) {
        events.push(await append(eventFactory.create({
          episodeId,
          typeId: "WorkingMemoryHypothesisRevived",
          payload: toJsonValue({ candidateId: judged.selected.id, kind: judged.selected.kind, priorRejectionReasons: revivedPriorHypothesis.rejectionReasons })
        })));
      }
      events.push(await append(eventFactory.create({ episodeId, typeId: "WorkingMemoryScoped", payload: toJsonValue(candidateWorkingMemory) })));
      const selectedProposal = cognitiveProposalForCandidate(judged.selected, cognitiveProposals);
      // Kept separate from selectedProposal above: that variable must stay a
      // real CognitiveProposal (attachCognitiveProposal / Mouth claimBases /
      // answer-revision all read fields -- operatorActivations, quality,
      // trace, claim.text -- a creative candidate's proposal doesn't have.
      // Force computation only needs id+claims, so it can also see a
      // creative candidate's own embedded factual-premise sub-claims.
      const selectedAssistantForceProposal = selectedProposal
        ?? assistantForceProposalFromCandidateClaimBasis(judged.selected);
      for (const rejected of judged.rejected) events.push(await append(eventFactory.create({ episodeId, typeId: "CandidateRejected", payload: { candidateId: rejected.candidate.id, score: rejected.score, reasons: rejected.reasons } })));
      // Feed the next self-projection REAL counterfactuals: these are the
      // roads genuinely not taken this turn, scored by the judge itself --
      // not capability-plan previews recast as "traces".
      runtimeState.lastRejectedCandidateTraces = judged.rejected.slice(0, 8).map(rejected =>
        counterfactualTraceFromRejectedCandidate({
          episodeId: String(episodeId),
          candidateId: rejected.candidate.id,
          candidateKind: rejected.candidate.kind,
          score: rejected.score,
          reasons: rejected.reasons,
          support: rejected.candidate.scores.support,
          evidenceCount: rejected.candidate.evidenceIds.length,
          hardFailure: rejected.reasons.some(reason => reason.startsWith("hard-failure:")),
          selectedCandidateId: judged.selected.id
        }));
      const selectedAssistantForce = assistantForceDecision({
        requestedAuthority,
        selectedProposal: selectedAssistantForceProposal,
        epistemicForce: judged.selected.force,
        proofVerdict: semanticProof.verdict,
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
      deadlineCheckpoint("runtime.candidates.complete", 0);
      const answerEntailment = selectedCandidateEntailment(answerEntailmentSeed, judged.selected);
      const selectedInvention = selectedInventionForCandidate(judged.selected, inventionCandidates);
      await deps.storage.proofs.putProof(answerEntailment.proof);
      let answer = "";
      const capabilityPlans: CapabilityPlan[] = [];
      const approvalPolicyPatch = deps.approvals?.policyPatch?.() ?? {};
      const construct = programBuilder.build({ episodeId, text: input.text, entailment: answerEntailment, evidence: selectedEvidence, createdAt: clock.now() });
      // Plan items 217-218: a real, durably-persisted long-horizon task-
      // resumption snapshot (deps.storage.taskResumption, real Postgres-
      // backed store), built from this turn's own already-real task
      // decomposition (items 158-159, present only for code-shaped turns)
      // and working memory (items 156-157, already finalized above) --
      // keyed by the real, stable conversationId (not the per-turn
      // episodeId) so a later turn with no fresh task decomposition of
      // its own still recovers the conversation's real last snapshot.
      const taskResumptionSnapshot = await syncTaskResumptionSnapshotForTurn(deps.storage.taskResumption, {
        goalId: authorityDialogueState.conversationId,
        taskDecomposition: construct.program?.taskDecomposition,
        workingMemory: candidateWorkingMemory,
        artifactIds: construct.artifacts.map(artifact => String(artifact.artifactId)),
        receiptIds: [],
        capturedAt: clock.now(),
        hasher
      });
      // Plan items 173-174: real constraint-solver dispatch. Whenever this
      // turn (or a resumed one) has a real task-decomposition graph, its
      // execution order is a genuine precedence-scheduling problem --
      // dispatched here to task-schedule-solver.ts's real Kahn's-algorithm
      // solver rather than left as an untouched graph nobody ever
      // resolves into an order. A real cycle is reported honestly
      // (status "infeasible" + the actual cycle), never silently dropped
      // or arbitrarily ordered. A resumed (deserialized) graph, unlike one
      // freshly built this turn via addTaskDecompositionNode, was not
      // re-validated for cross-node referential integrity on the way back
      // out of storage -- solveTaskSchedule throws for a dangling
      // dependency reference rather than returning a result, so that case
      // is reported the same honest way instead of crashing the turn.
      const taskSchedule = taskResumptionSnapshot
        ? (() => {
          try {
            return solveTaskSchedule(schedulableSubtasks(taskResumptionSnapshot.taskGraph));
          } catch (error) {
            return { status: "infeasible" as const, reason: "invalid_graph" as const, message: error instanceof Error ? error.message : String(error) };
          }
        })()
        : undefined;
      const toolPlan = construct.program || construct.artifacts.length
        ? toolCognition.plan({
          episodeId,
          request: input.text,
          capabilities: connectorGovernance.capabilities(defaultConnectorConfigs()),
          policy,
          evidence: selectedEvidence,
          field,
          actionCommitment: requirementField.actionCommitment,
          temporaryOperatorGrant: { enabled: approvalPolicyPatch.dryRunByDefault === false },
          functionalGate
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
      let taskReplanning: ReturnType<typeof replan> | undefined;
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
          const buildTestDecision = permission.allowed && !permission.dryRun
            ? deadlineCheckpoint("build_test.execute", 5_000)
            : undefined;
          if (permission.allowed && !permission.dryRun && buildTestDecision?.allowed !== false) {
            events.push(await append(eventFactory.create({ episodeId, typeId: "CapabilityInvoked", payload: { capabilityId: capability.id, planId: plan.id } })));
            const executiveDispatch = deps.executive
              ? await dispatchBuildTestThroughExecutive({ deps, episodeId, construct, capabilityId: capability.id, planId: String(plan.id), hasher, clock })
              : undefined;
            // Plan items 215-216: mine the real, durable event ledger for a
            // proven build/test skill (the exact same real dispatch,
            // succeeded at least minimumSuccessCount times across real past
            // episodes). Compilation always runs here, so item 215 is a real,
            // observable step every time this dispatch is reached, not only
            // when it happens to be consumed. When a skill exists and no
            // executive dispatch already produced a result, run the real
            // capability through executeSkill's typed program instead of a
            // bare call -- the real capability still runs exactly once
            // either way; this only adds proven-sequence provenance
            // (skillId, sourceEpisodeIds) to the trace.
            const compiledBuildTestSkill = await compileBuildTestSkillFromLedger(deps.storage.events);
            if (compiledBuildTestSkill) {
              events.push(await append(eventFactory.create({ episodeId, typeId: "ProceduralSkillCompiled", payload: toJsonValue(compiledBuildTestSkill) })));
            }
            let proceduralSkillExecution: JsonValue | undefined;
            if (!executiveDispatch && compiledBuildTestSkill) {
              const skillRun = await executeBuildTestSkill({ skill: compiledBuildTestSkill, episodeId, construct, executeProgram: deps.buildTest.executeProgram });
              buildTest = skillRun.buildTest;
              proceduralSkillExecution = toJsonValue({
                skillId: compiledBuildTestSkill.id,
                sourceEpisodeIds: compiledBuildTestSkill.sourceEpisodeIds,
                ok: skillRun.execution.ok,
                rolledBack: skillRun.execution.rolledBack
              });
            }
            buildTest = buildTest ?? executiveDispatch?.buildTest ?? await deps.buildTest.executeProgram({ episodeId, construct });
            await deps.storage.constructs.putBuildTest(episodeId, construct.id, buildTest);
            events.push(await append(eventFactory.create({ episodeId, typeId: "BuildExecuted", payload: { code: buildTest.build.code, durationMs: buildTest.build.durationMs, stderrHash: hasher.digestHex(buildTest.build.stderr) } })));
            events.push(await append(eventFactory.create({ episodeId, typeId: "TestExecuted", payload: { code: buildTest.test.code, passed: buildTest.passed, repairAttempted: buildTest.repairAttempted } })));
            events.push(await append(eventFactory.create({ episodeId, typeId: buildTest.passed ? "CapabilitySucceeded" : "CapabilityFailed", payload: { capabilityId: capability.id, planId: plan.id, passed: buildTest.passed } })));
            // Plan items 180-181: a failing build/test is a real, concrete
            // "meaningful observation" -- direct evidence that whatever
            // this construct's own task-decomposition plan claimed about
            // TEST_BEHAVIOR/BUILD_NOT_PRECLAIMED (code-learning.ts's own
            // named condition ids for exactly this) no longer holds. Only
            // those two specific conditions are invalidated, never the
            // unrelated ones (path containment, secret material, etc.) a
            // failing build has no real bearing on. taskResumptionSnapshot
            // (computed earlier this same turn) already has this turn's
            // real graph; replanning reuses every node whose own claims
            // this failure doesn't touch, rather than restarting the plan.
            if (!buildTest.passed && taskResumptionSnapshot) {
              taskReplanning = replan(taskResumptionSnapshot.taskGraph, {
                invalidatedConditionIds: [CODE_CONSTRAINT.TEST_BEHAVIOR, CODE_CONSTRAINT.BUILD_NOT_PRECLAIMED]
              });
            }
            if (proceduralSkillExecution) {
              events.push(await append(eventFactory.create({ episodeId, typeId: "ProceduralSkillExecuted", payload: proceduralSkillExecution })));
            }
            if (executiveDispatch) {
              events.push(await append(eventFactory.create({
                episodeId,
                typeId: "ExecutiveCapabilityDispatched",
                payload: {
                  capabilityId: capability.id,
                  planId: plan.id,
                  disposition: executiveDispatch.disposition,
                  attemptId: executiveDispatch.attemptId ?? null,
                  receiptStatus: executiveDispatch.receipt?.status ?? null
                }
              })));
            }
          } else {
            events.push(await append(eventFactory.create({
              episodeId,
              typeId: "ActionPrepared",
              payload: {
                capabilityId: capability.id,
                planId: plan.id,
                reason: buildTestDecision?.allowed === false ? "runtime-deadline-reserve" : permission.reason ?? "approval-required",
                ...(buildTestDecision ? { deadlineDecision: toJsonValue(buildTestDecision) } : {})
              }
            })));
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
      const selectedCandidateEvidenceIds = new Set(judged.selected.evidenceIds.map(String));
      const localAnswerEvidenceIds = longPathBasisAnswer?.evidence.map(span => String(span.id)) ?? [];
      const selectedLocalEvidenceAnswer = Boolean(
        longPathBasisAnswer &&
        judged.selected.kind === "proof-answer" &&
        selectedCandidateEvidenceIds.size === localAnswerEvidenceIds.length &&
        localAnswerEvidenceIds.every(id => selectedCandidateEvidenceIds.has(id))
      );
      const localAnswerConstructGraph = runtimeDiagnosticRequested
        ? assembly.constructGraph
        : selectedLocalEvidenceAnswer && longPathBasisAnswer
          ? attachLocalEvidenceAnswerConstruct({
            construct: assembly.constructGraph,
            plan: longPathBasisAnswer.plan,
            requestText: input.text,
            brainMarker: brain,
            hasher
          })
          : assembly.constructGraph;
      // Learned graph prior: the graph-node answer / insufficient-support constructs the mouth already knows how to realize.
      const priorConstructGraph = runtimeDiagnosticRequested
        ? localAnswerConstructGraph
        : attachLearnedGraphPriorConstruct({ construct: localAnswerConstructGraph, requestText: input.text, graph, field, selectedEvidence, brainMarker: brain, hasher });
      const proposalConstructGraph = attachCognitiveProposal({ construct: priorConstructGraph, proposal: selectedProposal });
      const selectedInventions = selectedInvention ? [selectedInvention] : [];
      const inventionConstructGraph = selectedInventions.reduce(
        (current, invention) => attachInventionConstruct({ construct: current, invention }),
        proposalConstructGraph
      );
      const runtimeDiagnosticConstructGraph = attachRuntimeDiagnosticConstruct({
        construct: inventionConstructGraph,
        enabled: runtimeDiagnosticRequested,
        requestText: input.text,
        brainMarker: brain,
        hasher,
        locale
      });
      const spokenConstructGraph = attachRuntimeMotionConstruct({
        construct: runtimeDiagnosticConstructGraph,
        requestText: input.text,
        motion: runtimeSurfaceMotion,
        answerSurface: runtimeSurfaceMotion ? authorityCandidateField.candidates[0]?.answer : undefined,
        hasher
      });
      await deps.storage.constructs.putConstruct(construct);
      await deps.storage.constructs.putConstruct(spokenConstructGraph);
      events.push(await append(eventFactory.create({ episodeId, typeId: "ConstructGraphBuilt", payload: construct })));
      events.push(await append(eventFactory.create({ episodeId, typeId: "ConstructGraphBuilt", payload: { substrate: assembly.audit, constructGraphId: spokenConstructGraph.id } })));
      events.push(await append(eventFactory.create({ episodeId, typeId: "CounterfactualSimulated", payload: { counterfactual: counterfactualWorld.audit } })));
      events.push(await append(eventFactory.create({ episodeId, typeId: "ActionPrepared", payload: { safety: safetyWithPlans.audit, toolPlan: toolPlan.policyAudit } })));
      if (construct.program) events.push(await append(eventFactory.create({ episodeId, typeId: "ProgramGraphBuilt", payload: construct.program })));
      if (construct.artifacts.length) events.push(await append(eventFactory.create({ episodeId, typeId: "FileGraphBuilt", payload: { files: construct.artifacts.map(file => ({ path: file.path, contentHash: file.contentHash, role: file.role })) } })));
      markTiming("planningMs");
      deadlineCheckpoint("runtime.planning.complete", 0);
      const mouthStarted = Date.now();
      const speakInput = {
        requestText: input.text,
        ...(deps.wordingRealizer ? { wordingRealizer: deps.wordingRealizer } : {}),
        construct: spokenConstructGraph,
        field,
        languageProfile: translationTarget
          ? productionTranslationPlan?.targetProfile ?? runtimeLanguageProfile(clock.now())
          : surfaceLanguage.surfaceProfile ?? selectedSurfaceProfile ?? runtimeLanguageProfile(clock.now()),
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
        requestedAuthority,
        semanticInput: judged.selected.kind === "action-preview" && judged.selected.answer.trim()
          ? {
            schema: "scce.mouth.semantic_input.v1" as const,
            authority: requestedAuthority,
            slots: [{
              id: `mouth.slot.action.preview.${judged.selected.id}`,
              roleId: "mouth.role.action.preview",
              value: judged.selected.answer,
              evidenceIds: judged.selected.evidenceIds,
              sourceId: judged.selected.proposalId
            }]
          }
          : typedSemanticInputForMouth({
            construct: spokenConstructGraph,
            graph,
            authority: requestedAuthority
          })
      };
      // Plan item L10: real, measured Kneser-Ney generation cost (see
      // runtime-cost-estimate.ts) instead of a bare literal -- strictly
      // tightens this gate's requirement (measured ~2-4ms vs. the previous
      // 750ms placeholder), so it can only become *more* permissive, never
      // less, for any caller already relying on the old budget.
      const learnedMouthDecision = deadlineCheckpoint("mouth.realize.learned", estimateKneserNeyGenerationCostMs(64));
      const realizeOnce = (realizationInput: typeof speakInput) => evaluationComponent(
        "learned-mouth",
        "mouth.realize",
        () => learnedMouthDecision?.allowed === false
          ? deterministicMouth.speak(realizationInput)
          : mouth.speak(realizationInput),
        () => deterministicMouth.speak(realizationInput)
      );
      // Plan items 221-228, live routing: a turn whose own learned
      // requirement field demands extended generation must not collapse
      // into one realization call. It produces a real multi-section plan,
      // real persistent session state, per-section realization through
      // this same Mouth, the real anti-copy + narrative-consistency gate,
      // and a real assembly. Decided by requirement projection only -- no
      // request-text branch -- so it stays language-neutral and routes
      // through the same abstraction that already decides authority.
      // Recursive generative derivation, on the live path. The turn's own
      // learned constructions are read as typed operators, closed under
      // composition, and searched against a semantic target taken from this
      // turn's own graph slice -- so a creative turn can emit a structure
      // no single learned construction described. Additive: it contributes
      // a candidate surface and never replaces the existing realization,
      // and it yields nothing when the corpus supplies no composable
      // constructions.
      const learnedConstructions = surfaceLanguageMemory.importedReversibleConstructions ?? [];
      let generativeDerivation: ReturnType<typeof searchTargetConditionedDerivation> | undefined;
      if (requestedAuthority === "creative" && learnedConstructions.length > 1) {
        try {
          const algebra = buildConstructionAlgebra({
            constructions: learnedConstructions.slice(0, 48),
            maxRecursionDepth: 3
          });
          if (algebra.composed.length) {
            const semanticTarget = semanticTargetFromGraph({ graph });
            if (semanticTarget.parts.length) {
              generativeDerivation = searchTargetConditionedDerivation({
                target: semanticTarget,
                algebra,
                joinMixture: activeJoinProgram(surfaceLanguageMemory)
              });
              kernelTrace({
                stage: "candidate.field.generate",
                label: "kernel.turn.generative_derivation",
                counts: {
                  learnedConstructions: learnedConstructions.length,
                  composites: algebra.composed.length,
                  targetParts: semanticTarget.parts.length,
                  coveredParts: generativeDerivation.coveredPartIds.length,
                  derivedChars: generativeDerivation.text.length
                },
                support: { algebra: algebra.audit, target: semanticTarget.audit, search: generativeDerivation.audit }
              });
            }
          }
        } catch (error) {
          failures.push(`generative derivation failed: ${error instanceof Error ? error.message : String(error)}`);
        }
      }
      const extendedGeneration = extendedGenerationDecision({ requirementField, requestedAuthority });
      let extendedGenerationRun: Awaited<ReturnType<typeof runExtendedGeneration>> | undefined;
      if (extendedGeneration.required) {
        // This turn's own retrieved evidence names what the story is
        // actually about; without this, word choice has nothing but the
        // corpus itself to lean on and drifts into whichever novel the
        // continuation model happens to favor.
        const creativeTopicVocabulary = [...new Set(
          selectedEvidence.slice(0, 12).flatMap(span => surfaceUnits(collapseSurfaceWhitespace(span.text).toLocaleLowerCase()))
        )].filter(unit => unit.length >= 4).slice(0, 96);
        // The document's persistent cast, derived once from the whole
        // request (not the per-section goal): this is what
        // narrative-state.ts's real consistency tracking follows across
        // sections, not a per-call heuristic. A request whose subject is
        // a bare pronoun ("write a story about her") has no proper noun
        // of its own to find -- but selectedEvidence, resolved through
        // the SAME discourse-binding this turn already used for factual
        // pronoun follow-ups (discourse-state.ts, metadata.runtimeEvidenceIds),
        // carries the real subject's own text when a prior turn's
        // discourse object was bound. This falls back to that, not to a
        // heuristic: no cast at all is the honest result when neither
        // signal resolves.
        const creativeCastSubjectIds = properNounEntityAnchors(input.text).length
          ? properNounEntityAnchors(input.text).slice(0, 3)
          : properNounEntityAnchors(selectedEvidence.slice(0, 3).map(span => span.text).join(" ")).slice(0, 3);
        const extendedSession = extendedGenerationSessionForTurn({
          requestText: input.text,
          sectionTarget: extendedGeneration.sectionTarget,
          protectedPassages: selectedEvidence.slice(0, 8).map(span => ({ sourceId: String(span.id), text: span.text })),
          castSubjectIds: creativeCastSubjectIds
        });
        extendedGenerationRun = await runExtendedGeneration({
          session: extendedSession,
          realizeSection: async (section, _index, priorSectionTexts, conditioning) => {
            // The real established-facts conditioning (narrative-state.ts)
            // tells this section which cast members already appeared --
            // still-unintroduced members are boosted harder so the whole
            // cast appears at least once, not just whichever the rotation
            // happens to favor this section.
            const notYetIntroduced = conditioning.establishedFacts
              .filter(fact => fact.factId === "introduced" && fact.value !== true)
              .map(fact => fact.subjectId);
            const sectionTopicVocabulary = [...creativeTopicVocabulary, ...notYetIntroduced.flatMap(id => [id, id, id])];
            // A short local-context model can converge on the same
            // highest-probability sentence for two structurally similar
            // section goals -- reusing the real anti-copy guard
            // (voice-profile.ts, already wired to check generated text
            // against protected passages) against the DOCUMENT'S OWN prior
            // sections catches a section that duplicates an earlier one,
            // the same way it catches plagiarizing a source.
            const priorSectionPassages = priorSectionTexts.map((text, passageIndex) => ({ sourceId: `section:${passageIndex}`, text }));
            // Fast direct engine call first; full Mouth only when that is
            // inadequate. Both fail empty, never echo. One unlucky or
            // self-duplicating sample must not end a document, so a
            // declined attempt retries with a distinct sampling seed.
            let direct: ReturnType<typeof realizeCreativeSection> | undefined;
            for (let attempt = 1; attempt <= 2; attempt++) {
              const candidate = realizeCreativeSection({
                languageMemory: languageMemoryRuntime,
                state: speakInput.languageMemory,
                targetLanguageProfile: speakInput.languageProfile,
                requestText: input.text,
                sectionGoal: section.goal,
                narrativeConditioning: priorSectionTexts.slice(-2),
                topicVocabulary: sectionTopicVocabulary,
                resolvedCastSubjectIds: creativeCastSubjectIds,
                casingSourceTexts: selectedEvidence.slice(0, 4).map(span => span.text),
                attempt,
                generationExtent: 180
              });
              const duplicatesPriorSection = candidate.accepted
                && checkAntiCopyGuard(candidate.text, priorSectionPassages, 8).violatesProtectedSpan;
              if (candidate.accepted && !duplicatesPriorSection) {
                direct = candidate;
                break;
              }
              kernelTrace({
                stage: "mouth.generate",
                label: "kernel.turn.creative_section_direct",
                counts: { chars: candidate.text.length },
                support: {
                  goal: section.goal,
                  reason: duplicatesPriorSection ? "duplicates-prior-section" : candidate.reason,
                  generation: toJsonValue(candidate.generationAudit ?? null)
                }
              });
            }
            if (direct?.accepted) {
              // A cast member's own "introduced" fact only ever flips
              // false -> true, once, the first section that actually
              // mentions it -- a state change with no risk of ever
              // contradicting what came before, and real substrate for
              // establishedNarrativeFacts to hand the next section.
              const lowerText = direct.text.toLocaleLowerCase();
              const stateChanges = notYetIntroduced
                .filter(subjectId => lowerText.includes(subjectId))
                .map(subjectId => ({ subjectId, factId: "introduced", fromValue: false, toValue: true }));
              return {
                text: direct.text,
                ...(stateChanges.length
                  ? { narrativeEvent: { id: `event:${section.id}`, order: _index, description: section.goal, causedByEventIds: [], stateChanges, setupIds: [], payoffForSetupIds: [] } }
                  : {})
              };
            }
            const sectionSpoken = await realizeOnce({ ...speakInput, requestText: section.goal });
            return { text: String(sectionSpoken.text ?? "") };
          }
        });
        kernelTrace({
          stage: "mouth.generate",
          label: "kernel.turn.extended_generation",
          counts: {
            sectionsAttempted: extendedGenerationRun.sections.length,
            sectionsAccepted: extendedGenerationRun.sections.filter(row => row.accepted).length,
            answerChars: extendedGenerationRun.answer.length
          },
          support: { decision: extendedGeneration.audit, run: extendedGenerationRun.audit }
        });
      }
      let spoken = extendedGenerationRun?.answer
        ? { ...(await realizeOnce(speakInput)), text: extendedGenerationRun.answer }
        : await realizeOnce(speakInput);
      deadlineCheckpoint("runtime.mouth.primary.complete", 0);
      // CRITICAL fix: the empty-mouth recovery path below is real and
      // works (confirmed live: a genuinely empty realization reliably
      // recovers a full, real, evidence-grounded answer on retry) -- but
      // it only ever fired on a literally empty `spoken.text`. Measured
      // live against the real corpus, a broken (non-empty) 1-2 word stub
      // ("It", "The", "story", "In January") happens too, for a factual/
      // reasoned request, and slipped past this exact check untouched,
      // becoming the final answer instead of triggering the same real
      // recovery. Arithmetic and other genuinely short-but-complete
      // answers never reach this point at all (arithmeticAnswerForText
      // returns earlier in this same function), so anything landing here
      // is real prose realization output -- a healthy prose answer is
      // never one or two bare words, so a low word-count floor is a safe,
      // low-false-positive signal of the same broken-realization failure
      // mode as literal emptiness, not a new invented threshold.
      const spokenWordCount = spoken.text.trim().length ? spoken.text.trim().split(/\s+/).length : 0;
      const emptyAuthoritySurface = (spokenWordCount === 0 || spokenWordCount < 4)
        && (requestedAuthority === "factual" || requestedAuthority === "reasoned")
        && !runtimeDiagnosticRequested;
      if (emptyAuthoritySurface && !inheritedRuntimeMotion && !performedRuntimeMotion) {
        const recoveryDecision = deadlineCheckpoint("runtime.replan.empty_mouth", 5_000);
        if (recoveryDecision?.allowed !== false) {
          const motion = await learnHydrateReplan({
            ownerInput: input,
            episodeId,
            requestedAuthority,
            trigger: "coherence_support_failure",
            events,
            priorRejectedHypotheses: priorRejectedHypothesesFromCandidates(judged.rejected, hasher)
          });
          performedRuntimeMotion = motion;
          if (runtimeMotionAddedEvidence(motion)) {
            runtimeState.lastField = undefined;
            return turn({
              ...input,
              metadata: metadataWithRuntimeReplanMotion(input.metadata, motion)
            });
          }
        }
        events.push(await append(eventFactory.create({
          episodeId,
          typeId: "ActionPrepared",
          payload: toJsonValue({
            runtimeMotion: "not_started",
            reason: "runtime-deadline-reserve",
            deadlineDecision: recoveryDecision
          })
        })));
        spoken = await deterministicMouth.speak(speakInput);
      }
      if (emptyAuthoritySurface && inheritedRuntimeMotion) {
        // Learned Mouth remains the primary realization lane. The
        // deterministic Mouth is the bounded terminal realization of the
        // already-selected semantic motion/candidate, never a new fact lane.
        spoken = await deterministicMouth.speak(speakInput);
      }
      if (!spoken.text.trim() && candidateIsSafeNonExecutingPlan(judged.selected)) {
        spoken = await deterministicMouth.speak(speakInput);
      }
      // Real citation, not a stylistic flourish: an evidence-grounded
      // factual/reasoned answer -- quoted or synthesized, doesn't matter
      // which -- must carry a real source name and, when one is
      // derivable, a real clickable link, not just structured provenance
      // a caller might never render. evidenceCitation never fabricates a
      // URL: it only reconstructs one from fields the ingestor itself
      // recorded (corpus language code, provenance.uri), and falls back
      // to a bare title when no real link can be derived. Applied via a
      // shared closure (not inlined once) because the answer-revision
      // pass below can replace `answer`/`spoken` with a revised version,
      // which needs the exact same treatment, not a citation left over
      // from the pre-revision text.
      const withCitation = (rawAnswer: string, spokenSurface: typeof spoken): string => {
        if (!rawAnswer || !spokenSurface.evidenceRefs.length || (requestedAuthority !== "factual" && requestedAuthority !== "reasoned")) return rawAnswer;
        const citedSpans = selectedEvidence.filter(span => spokenSurface.evidenceRefs.includes(span.id));
        const citationSuffix = formatCitationSuffix(evidenceCitations(citedSpans));
        return citationSuffix ? `${rawAnswer}${citationSuffix}` : rawAnswer;
      };
      answer = spoken.text;
      if (!answer.trim()) answer = "";
      answer = withCitation(answer, spoken);
      const mouthAssistantForce = assistantForceDecision({
        requestedAuthority,
        selectedProposal: selectedAssistantForceProposal,
        epistemicForce: answerEntailment.force,
        proofVerdict: semanticProof.verdict,
        outputForce: spoken.force,
        evidenceIds: spoken.evidenceRefs,
        directEvidenceIds: selectedEvidence.map(span => span.id),
        constructForces: spoken.surfacePlan.constructForces.map(force => force.id),
        support: answerEntailment.support,
        contradiction: candidateUsesNonFactualPlanSemantics(judged.selected)
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
        support: {
          selectedCandidateId: judged.selected.id,
          semanticCandidateId: spoken.realizationTrace.selected.semanticCandidateId ?? judged.selected.id,
          semanticPlanId: spoken.realizationTrace.selected.semanticPlanId ?? null,
          surfaceRealizationId: spoken.realizationTrace.selected.surfaceRealizationId ?? spoken.realizationTrace.selected.id,
          force: spoken.force,
          assistantForce: mouthAssistantForce.force,
          learnedMouthAdmitted: learnedMouthDecision?.allowed ?? true
        }
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
      const sourceStructuralCreativeSurface = Boolean(
        selectedInvention
        && spoken.realizationTrace.selected.semanticCandidateId === judged.selected.id
        && spoken.realizationTrace.selected.semanticPlanId
        && spoken.realizationTrace.selected.surfaceRealizationId === spoken.realizationTrace.selected.id
      );
      // Creative/invention answers are revisable too -- answer-revision.ts
      // has no creative-specific handling that would make it unsafe, and
      // excluding all of requestedAuthority === "creative" was broader than
      // the one case that actually needs excluding: a structural creative
      // surface realized directly from a semantic/construction-grammar
      // plan (sourceStructuralCreativeSurface below), which bypasses normal
      // Mouth realization and isn't in the shape revision expects.
      const answerRevisionEligible = Boolean(
        selectedProposal
        && !deps.evaluationCondition
        && !sourceStructuralCreativeSurface
      );
      const answerRevisionDecision = answerRevisionEligible
        ? deadlineCheckpoint("answer.revision", 900)
        : undefined;
      if (selectedProposal && answerRevisionEligible && answerRevisionDecision?.allowed !== false) {
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
          answer = withCitation(spoken.text, spoken);
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
        selectedProposal: selectedAssistantForceProposal,
        epistemicForce: rawEmission.epistemicForce,
        proofVerdict: semanticProof.verdict,
        outputForce: spoken.force,
        evidenceIds: rawEmission.evidenceIds,
        directEvidenceIds: selectedEvidence.map(span => span.id),
        constructForces: spoken.surfacePlan.constructForces.map(force => force.id),
        support: answerEntailment.support,
        contradiction: candidateUsesNonFactualPlanSemantics(judged.selected)
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
        counterfactual: judged.selected.kind === "counterfactual-response" ? counterfactualWorld : undefined,
        readiness: runtimeReadinessForEmission,
        discourseObject: discourseObjectTrace,
        mouthAudit: toJsonValue({ surfacePlan: spoken.surfacePlan, trace: spoken.realizationTrace, inspectRefs: spoken.inspectRefs, uncertainty: spoken.uncertainty }),
        selectedCandidateAudit: judged.selected.audit,
        mouthSurfaceValid: spoken.surfaceValid,
        mouthHardViolationIds: spoken.hardSurfaceViolationIds
      });
      const runtimeCoherenceTrace = toJsonValue(runtimeCoherence);
      // assistantForceAfter === "insufficient_support" alone no longer
      // triggers this whole-turn recovery loop: thin/absent evidence is a
      // citation concern, honestly reflected in the answer's force label,
      // not a reason to throw the turn away and replan. emitAllowed/
      // demotionRequired still gate on the other coherence dimensions
      // (mouth-surface leakage, runtime readiness, counterfactual
      // instability, etc.) -- those are real quality/safety concerns
      // distinct from evidence strength.
      const coherenceRequiresContinuation = !runtimeCoherence.emitAllowed
        || runtimeCoherence.demotionRequired;
      // requestedAuthority === "creative" stays exempt from this whole-turn
      // recovery/regenerate loop, deliberately. The compositional claim
      // check (assistant-force.ts's unsupportedClaimIds) is real now and a
      // creative answer's own force can in principle read
      // "insufficient_support" -- but replanning the ENTIRE turn is the
      // wrong response to that for creative content: it can silence or
      // rewrite freely-invented material because of one flagged sub-claim,
      // which is a heavier-handed "proof bound" behavior than what was
      // asked for. The Mouth must stay free to speak a creative answer;
      // the claim-level data (unsupportedClaimIds/claimDecisions) is
      // preserved in the trace for a future targeted caveat/citation on
      // just the affected unit, not a full-turn veto.
      if (
        coherenceRequiresContinuation
        && requestedAuthority !== "creative"
        && !candidateIsSafeNonExecutingPlan(judged.selected)
        && !runtimeDiagnosticRequested
        && !inheritedRuntimeMotion
        && !performedRuntimeMotion
      ) {
        const recoveryDecision = deadlineCheckpoint("runtime.replan.coherence", 5_000);
        if (recoveryDecision?.allowed !== false) {
          const motion = await learnHydrateReplan({
            ownerInput: input,
            episodeId,
            requestedAuthority,
            trigger: "coherence_support_failure",
            events,
            priorRejectedHypotheses: priorRejectedHypothesesFromCandidates(judged.rejected, hasher)
          });
          performedRuntimeMotion = motion;
          if (runtimeMotionAddedEvidence(motion)) {
            runtimeState.lastField = undefined;
            return turn({
              ...input,
              metadata: metadataWithRuntimeReplanMotion(input.metadata, motion)
            });
          }
          events.push(await append(eventFactory.create({
            episodeId,
            typeId: "ActionPrepared",
            payload: toJsonValue({
              runtimeMotion: motion,
              reason: "runtime-motion-added-no-evidence",
              replanSkipped: true,
              coherence: runtimeCoherenceTrace
            })
          })));
        } else {
          events.push(await append(eventFactory.create({
            episodeId,
            typeId: "ActionPrepared",
            payload: toJsonValue({
              runtimeMotion: "not_started",
              reason: "runtime-deadline-reserve",
              deadlineDecision: recoveryDecision,
              coherence: runtimeCoherenceTrace
            })
          })));
        }
      }
      await deps.storage.constructs.putValidation(validation);
      events.push(await append(eventFactory.create({ episodeId, typeId: "ValidationGraphBuilt", payload: validation })));
      const emission = {
        ...rawEmission,
        assistantForce: runtimeCoherence.assistantForceAfter
      };
      // Fired exactly once per non-recursive turn, right here: this is the
      // earliest point where emission.answer is settled -- past
      // answer-revision (~line 2064) and past the coherence-replan check
      // above (which would have recursed the whole turn via an early
      // `return turn(...)` instead of reaching this line). Everything after
      // this is bookkeeping (persistence, learning-loop planning, event
      // writes) that no longer touches the answer text, so a streaming
      // consumer can safely render it now instead of waiting for the full
      // turn to finish.
      input.runtimeControl?.onProgress?.({
        phase: "answer.ready",
        observedAtMonotonicMs: performance.now(),
        answer: emission.answer,
        assistantForce: emission.assistantForce
      });
      await deps.storage.constructs.putEmission(emission);
      events.push(await append(eventFactory.create({ episodeId, typeId: "RuntimeCoherenceDecided", payload: runtimeCoherenceTrace })));
      events.push(await append(eventFactory.create({ episodeId, typeId: "MouthSpoken", payload: { assistantForce: runtimeCoherence.assistantForceAfter, assistantForceBeforeCoherence: mouthAssistantForce.force, assistantForceTrace: mouthAssistantForce.audit, surfacePlan: spoken.surfacePlan, trace: spoken.realizationTrace, inspectRefs: spoken.inspectRefs, evidenceRefs: spoken.evidenceRefs, uncertainty: spoken.uncertainty, answerRevision: answerRevisionTrace ?? null, runtimeCoherence: runtimeCoherenceTrace } })));
      events.push(await append(eventFactory.create({ episodeId, typeId: "EmissionGraphBuilt", payload: { ...emission, assistantForceTrace: emissionAssistantForce.audit, runtimeCoherence: runtimeCoherenceTrace } })));
      markTiming("validationMs");
      deadlineCheckpoint("runtime.validation.complete", 0);
      const actionGraph = actionGraphBuilder.build({ episodeId, plans: capabilityPlans, emission, policy });
      const afterTurnMaintenance = afterTurnMaintenanceDecision({ translationTarget, construct, capabilityPlans, assistantForce: emission.assistantForce });
      const incrementalLearningDisabled = deps.evaluationCondition?.flags.disableIncrementalLearning === true;
      if (incrementalLearningDisabled) {
        evaluationComponent("incremental-learning", "maintenance.incremental-learning", () => undefined, () => undefined);
      }
      const afterTurnMaintenanceDeferred = afterTurnMaintenance.deferred
        || incrementalLearningDisabled
        || deps.evaluationCondition?.flags.disableLanguageMemory === true;
      if (!afterTurnMaintenanceDeferred) {
        await deps.storage.forecasts.putState(state);
        await deps.storage.forecasts.putForecast(forecast);
      }
      events.push(await append(eventFactory.create({ episodeId, typeId: "ForecastComputed", payload: { stateId: state.id, forecastId: forecast.id, interval: forecast.interval, persistenceDeferred: afterTurnMaintenanceDeferred, maintenance: afterTurnMaintenance.audit } })));
      markTiming("forecastMs");
      if (afterTurnMaintenanceDeferred) {
        runtimeState.lastEpisodeId = episodeId;
        runtimeState.lastOutput = emission.answer;
        events.push(await append(eventFactory.create({ episodeId, typeId: "ActionPrepared", payload: { turnMaintenance: afterTurnMaintenance.audit } })));
        const timing = buildTiming("deferred");
        events.push(await append(eventFactory.create({ episodeId, typeId: "EpisodeClosed", payload: { output: emission.answer, maintenanceDeferred: true, timing } })));
        runtimeState.lastTurnTiming = timing;
        const episodeConsolidation = await consolidateCurrentEpisode();
        const semanticConsolidation = await consolidateCurrentSemanticClaims(spokenConstructGraph);
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
          candidateField: authorityCandidateField.audit,
          selectedCandidate: toJsonValue(judged.selected),
          judge: judged.audit,
          workingMemory: toJsonValue(candidateWorkingMemory),
          taskResumptionSnapshot: taskResumptionSnapshot ? toJsonValue(taskResumptionSnapshot) : undefined,
          taskSchedule: taskSchedule ? toJsonValue(taskSchedule) : undefined,
          taskReplanning: taskReplanning ? toJsonValue(taskReplanning) : undefined,
          episodeConsolidation,
          relevantPastEpisodes: relevantPastEpisodes.length ? toJsonValue(relevantPastEpisodes) : undefined,
          semanticConsolidation,
          cognitiveProposalComparison: cognitiveProposalComparison ? toJsonValue(cognitiveProposalComparison) : undefined,
          presentationGuard: toJsonValue(applyPragmaticsGuard(presentationGuardInputFromTurn({
            surfacePlan: spoken.surfacePlan,
            capabilityPlans,
            userStyleProfile: authorityDialogueState.userStyleProfile
          }))),
          temporalConflicts: toJsonValue(temporalConflicts.map(([left, right]) => ({ leftEdgeId: String(left.id), rightEdgeId: String(right.id) }))),
          repoCognition,
          documentGeneration,
          actionGraph: toJsonValue({ actionGraph: actionGraph.audit, toolPlan: toolPlan.policyAudit, safety: safetyWithPlans.audit, runtime: runtimeDag.audit, runtimeReadiness: runtimeReadinessForEmission.audit, runtimeCoherence: runtimeCoherenceTrace, discourseObject: discourseObjectTrace ?? null, counterfactual: counterfactualWorld.audit, constructSubstrate: assembly.audit, sourceAnchor: { sourceAnchorRequired: sourceAnchorAudit.required, sourceAnchorMatched: sourceAnchorAudit.evidence.length > 0, sourceAnchors: sourceAnchorAudit.anchors }, maintenanceDeferred: true, maintenance: afterTurnMaintenance.audit }),
          proofCarryingAnswer: pcaReport.audit,
          pface: pfaceEstimate?.audit,
          languageAcquisition: toJsonValue({ maintenanceDeferred: true, maintenance: afterTurnMaintenance.audit }),
          mouth: toJsonValue({ surfacePlan: spoken.surfacePlan, trace: spoken.realizationTrace, inspectRefs: spoken.inspectRefs, uncertainty: spoken.uncertainty }),
          runtimeCoherence: runtimeCoherenceTrace,
          ...(inheritedRuntimeMotion ?? performedRuntimeMotion ? { runtimeMotion: toJsonValue((inheritedRuntimeMotion ?? performedRuntimeMotion) as RuntimeReplanMotion) } : {}),
          discourseObject: discourseObjectTrace,
          corrections: correctionMemory.summarize(correctionRules),
          userModelStore: userModelStoreToJson(userModelStore),
          brain,
          selfState,
          selfDistillation: selfDistillationAudit,
          functionalConsciousness: functionalConsciousnessAudit,
          functionalCognition: toJsonValue({
            ...(jsonRecord(functionalCognitionAudit)),
            phase: "preselection",
            runtimeReadiness: runtimeReadinessForEmission.audit,
            runtimeCoherence: runtimeCoherenceTrace
          }),
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
            unsupportedContentBlocked: emission.assistantForce === "insufficient_support" || runtimeCoherence.demotionRequired
          }),
          events
        };
      }
      evaluationComponent("incremental-learning", "maintenance.incremental-learning", () => undefined, () => undefined);
      const profiles = translationTarget
        ? productionTranslationProfiles
        : (await surfaceLanguageProfilesCached()).profiles;
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
      }).filter(plan =>
        functionalGate.gov
        && functionalGate.fc
        && (plan.phase === "read" || functionalGate.efc && Boolean(functionalGate.selectedGoalId))
      );
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
      events.push(await append(eventFactory.create({ episodeId, typeId: "LanguagePatternLearned", payload: languageAcquisition.audit })));
      for (const need of learningNeeds) events.push(await append(eventFactory.create({ episodeId, typeId: "LearningNeedDetected", payload: { need } })));
      for (const need of learningLoopPlan.learningNeeds) events.push(await append(eventFactory.create({ episodeId, typeId: "LearningNeedDetected", payload: { id: need.id, goal: need.goal, gapId: need.gapId, priority: need.priority, continuation: need.continuation, sourcePlans: need.sourcePlans.map(plan => ({ id: plan.id, kind: plan.kind, capabilityId: plan.capabilityId, query: plan.query, utility: plan.utility, acquisition: plan.acquisition })) } })));
      if (learningLoopPlan.goals.length || learningLoopPlan.globalSources.length) events.push(await append(eventFactory.create({ episodeId, typeId: "LearningPlanBuilt", payload: learningLoopPlan.audit })));
      const trainingPlanBuiltEvent = await append(eventFactory.create({ episodeId, typeId: "LearningPlanBuilt", payload: mvpTrainingPlan.audit }));
      events.push(trainingPlanBuiltEvent);
      // The only real, event-id-backed claim this turn can make: the plan was
      // computed and its audit was durably recorded. Nothing downstream
      // executes, persists, or validates the checkpoint/curriculum/
      // distillation objects yet, so no further status entry is honest here.
      mvpTrainingPlan.statusHistory.push({ status: "planned", at: clock.now(), eventId: String(trainingPlanBuiltEvent.id) });
      runtimeState.lastEpisodeId = episodeId;
      runtimeState.lastOutput = emission.answer;
      markTiming("maintenanceMs");
      const timing = buildTiming("foreground");
      events.push(await append(eventFactory.create({ episodeId, typeId: "EpisodeClosed", payload: { output: emission.answer, timing } })));
      runtimeState.lastTurnTiming = timing;
      const episodeConsolidation = await consolidateCurrentEpisode();
      const semanticConsolidation = await consolidateCurrentSemanticClaims(spokenConstructGraph);
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
        candidateField: authorityCandidateField.audit,
        selectedCandidate: toJsonValue(judged.selected),
        judge: judged.audit,
        workingMemory: toJsonValue(candidateWorkingMemory),
        taskResumptionSnapshot: taskResumptionSnapshot ? toJsonValue(taskResumptionSnapshot) : undefined,
        taskSchedule: taskSchedule ? toJsonValue(taskSchedule) : undefined,
        taskReplanning: taskReplanning ? toJsonValue(taskReplanning) : undefined,
        episodeConsolidation,
        relevantPastEpisodes: relevantPastEpisodes.length ? toJsonValue(relevantPastEpisodes) : undefined,
        semanticConsolidation,
        cognitiveProposalComparison: cognitiveProposalComparison ? toJsonValue(cognitiveProposalComparison) : undefined,
        presentationGuard: toJsonValue(applyPragmaticsGuard(presentationGuardInputFromTurn({
          surfacePlan: spoken.surfacePlan,
          capabilityPlans,
          userStyleProfile: authorityDialogueState.userStyleProfile
        }))),
        temporalConflicts: toJsonValue(temporalConflicts.map(([left, right]) => ({ leftEdgeId: String(left.id), rightEdgeId: String(right.id) }))),
        repoCognition,
        documentGeneration,
        actionGraph: toJsonValue({ actionGraph: actionGraph.audit, toolPlan: toolPlan.policyAudit, safety: safetyWithPlans.audit, runtime: runtimeDag.audit, runtimeReadiness: runtimeReadinessForEmission.audit, runtimeCoherence: runtimeCoherenceTrace, discourseObject: discourseObjectTrace ?? null, counterfactual: counterfactualWorld.audit, constructSubstrate: assembly.audit, sourceAnchor: { sourceAnchorRequired: sourceAnchorAudit.required, sourceAnchorMatched: sourceAnchorAudit.evidence.length > 0, sourceAnchors: sourceAnchorAudit.anchors }, maintenance: afterTurnMaintenance.audit }),
        selfState,
        selfDistillation: selfDistillationAudit,
        functionalConsciousness: functionalConsciousnessAudit,
        functionalCognition: toJsonValue({
          ...(jsonRecord(functionalCognitionAudit)),
          phase: "preselection",
          runtimeReadiness: runtimeReadinessForEmission.audit,
          runtimeCoherence: runtimeCoherenceTrace
        }),
        runtimeCoherence: runtimeCoherenceTrace,
        ...(inheritedRuntimeMotion ?? performedRuntimeMotion ? { runtimeMotion: toJsonValue((inheritedRuntimeMotion ?? performedRuntimeMotion) as RuntimeReplanMotion) } : {}),
        discourseObject: discourseObjectTrace,
        proofCarryingAnswer: pcaReport.audit,
        pface: pfaceEstimate?.audit,
        languageAcquisition: languageAcquisition.audit,
        translation: translationPlan,
        mouth: toJsonValue({ surfacePlan: spoken.surfacePlan, trace: spoken.realizationTrace, inspectRefs: spoken.inspectRefs, uncertainty: spoken.uncertainty }),
        corrections: correctionMemory.summarize(correctionRules),
        userModelStore: userModelStoreToJson(userModelStore),
        brain,
        learningLoop: toJsonValue({ loop: learningLoopPlan.audit, acquisitionPlans: learningCapabilityPlans, training: mvpTrainingPlan.audit, trainingStatus: mvpTrainingPlan.statusHistory }),
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
          unsupportedContentBlocked: emission.assistantForce === "insufficient_support" || runtimeCoherence.demotionRequired
        }),
        events
      };
      });

  }

  return { turn };
}

/**
 * Drives the local build/test capability through the durable executive
 * spine (goal -> task -> attempt -> receipt -> outcome -> learning record)
 * so every real invocation leaves a crash-recoverable, auditable trail --
 * the first real executor proving the dispatcher mechanism end to end. The
 * actual `executeProgram` call still happens exactly once, inside the
 * dispatcher's own prepare-then-invoke ordering; its full result is
 * captured via closure since the executive ledger only needs bounded
 * receipt evidence, not raw stdout/stderr.
 */
async function dispatchBuildTestThroughExecutive(input: {
  deps: ScceKernelDeps;
  episodeId: EpisodeId;
  construct: ConstructGraph;
  capabilityId: string;
  planId: string;
  hasher: ReturnType<typeof createHasher>;
  clock: ReturnType<typeof createClock>;
}): Promise<{ disposition: string; attemptId?: string; receipt?: { status: string }; buildTest?: BuildTestResult } | undefined> {
  const executive = input.deps.executive;
  if (!executive) return undefined;

  let capturedResult: BuildTestResult | undefined;
  const executor: CapabilityExecutor = {
    descriptor: { capabilityId: input.capabilityId, idempotency: "non-repeatable", rollback: "unavailable" },
    execute: async request => {
      const payload = request.payload as unknown as { episodeId: EpisodeId; construct: ConstructGraph };
      const result = await input.deps.buildTest.executeProgram({ episodeId: payload.episodeId, construct: payload.construct });
      capturedResult = result;
      return {
        status: result.passed ? "succeeded" : "failed",
        outputRefs: result.artifacts.map(artifact => artifact.path),
        evidenceRefs: [
          `build_test.build.code.${result.build.code ?? "null"}`,
          `build_test.test.code.${result.test.code ?? "null"}`
        ],
        attestationRef: `build_test.${request.invocation.idempotencyKey}`
      };
    }
  };

  const ownerId = input.deps.informationAccess?.principalId ?? "scce-runtime";
  const policyVersionId = `policy_${input.hasher.digestHex(JSON.stringify(input.deps.policy ?? {})).slice(0, 32)}`;
  const goalId = `goal_build_test_${input.planId}`;
  const taskId = `task_build_test_${input.planId}`;

  const result = await dispatchCapabilityTask(
    { executive, executors: createCapabilityExecutorRegistry([executor]), hasher: input.hasher, now: () => input.clock.now() },
    {
      episodeId: input.episodeId,
      ownerId,
      policyVersionId,
      goal: { id: goalId, goalClassId: "goal.class.build_test", objectiveRef: input.planId, requirementIds: [], ownerId },
      task: {
        id: taskId,
        goalId,
        taskClassId: "task.class.build_test",
        requirementIds: [],
        dependencyTaskIds: [],
        capabilityId: input.capabilityId,
        inputRef: input.planId,
        policyVersionId,
        controls: {
          authority: {
            authorityClassId: "authority.class.build_test",
            subjectId: ownerId,
            requiredScopeIds: [],
            state: "not_required",
            justificationRef: input.planId
          },
          approval: {
            policyId: "approval.policy.build_test",
            state: "pending",
            approverClassIds: ["policy-gate"],
            justificationRef: input.planId
          }
        },
        rollback: {
          mode: "not_required",
          justificationRef: "build_test executes in an ephemeral workspace with no durable mutation to roll back"
        }
      },
      approvalDecision: {
        decisionId: `approval_${input.planId}`,
        decision: "approved",
        policyId: "approval.policy.build_test",
        decidedBy: "policy-gate",
        evidenceRefs: [input.planId]
      },
      payload: { episodeId: input.episodeId, construct: input.construct } as unknown as JsonValue,
      outcomeEvidenceRefs: []
    }
  );

  return { disposition: result.disposition, attemptId: result.attemptId, receipt: result.receipt, buildTest: capturedResult };
}

function requireHydratedSurfaceLanguage<T>(value: T | undefined, context: string): T {
  if (value) return value;
  throw new Error(`hydrated runtime unavailable: required learned surface language for ${context}`);
}

function isResidentRuntimeNotWarmError(error: unknown): boolean {
  return error instanceof Error && error.message.startsWith("hydrated runtime unavailable: resident");
}

export function typedSemanticInputForMouth(input: {
  construct: ConstructGraph;
  graph: GraphSnapshot;
  authority: MouthSemanticInput["authority"];
}): MouthSemanticInput | undefined {
  const nodes = (input.construct as unknown as {
    nodes?: Array<{ kind?: string; metadata?: JsonValue }>;
  }).nodes ?? [];
  const selectedFacts = nodes.flatMap(node => {
    if (node.kind !== "construct:semantic_answer") return [];
    const value = jsonRecord(node.metadata ?? {});
    return Array.isArray(value.selectedFacts)
      ? value.selectedFacts.map(jsonRecord)
      : [];
  });
  if (selectedFacts.length !== 1) return undefined;
  const fact = selectedFacts[0]!;
  const sourceNodeId = kernelString(fact.sourceNodeId);
  const targetNodeId = kernelString(fact.targetNodeId);
  const relationId = kernelString(fact.relationId);
  const subject = kernelString(fact.subject);
  const object = kernelString(fact.object);
  if (!sourceNodeId || !targetNodeId || !relationId || !subject || !object) {
    return undefined;
  }
  const matching = input.graph.hyperedges.filter(hyperedge =>
    String(hyperedge.relationId) === relationId
    && hyperedge.participantPorts.some(port =>
      String(port.nodeId ?? "") === sourceNodeId)
    && hyperedge.participantPorts.some(port =>
      String(port.nodeId ?? "") === targetNodeId));
  if (matching.length !== 1) return undefined;
  const hyperedge = matching[0]!;
  const sourcePorts = hyperedge.participantPorts.filter(port =>
    String(port.nodeId ?? "") === sourceNodeId
    && port.realization === "observed"
    && Boolean(port.roleId));
  const targetPorts = hyperedge.participantPorts.filter(port =>
    String(port.nodeId ?? "") === targetNodeId
    && port.realization === "observed"
    && Boolean(port.roleId));
  if (sourcePorts.length !== 1 || targetPorts.length !== 1) return undefined;
  const sourcePort = sourcePorts[0]!;
  const targetPort = targetPorts[0]!;
  const factEvidenceIds = Array.isArray(fact.evidenceIds)
    ? fact.evidenceIds
    : [];
  const evidenceIds = uniqueKernelStrings([
    ...factEvidenceIds.flatMap(value =>
      typeof value === "string" ? [value] : []),
    ...hyperedge.evidenceIds.map(String)
  ]);
  const sourceSlotId = `mouth.slot.graph.${sourceNodeId}.source`;
  const targetSlotId = `mouth.slot.graph.${targetNodeId}.target`;
  return {
    schema: "scce.mouth.semantic_input.v1",
    authority: input.authority,
    slots: [
      {
        id: sourceSlotId,
        roleId: String(sourcePort.roleId),
        value: subject,
        evidenceIds: evidenceIds as MouthSemanticInput["slots"][number]["evidenceIds"],
        sourceId: sourceNodeId
      },
      {
        id: targetSlotId,
        roleId: String(targetPort.roleId),
        value: object,
        evidenceIds: evidenceIds as MouthSemanticInput["slots"][number]["evidenceIds"],
        sourceId: targetNodeId
      }
    ],
    relations: [{
      id: `mouth.relation.graph.${hyperedge.id}`,
      relationId,
      sourceSlotId,
      targetSlotId,
      evidenceIds: evidenceIds as NonNullable<
        MouthSemanticInput["relations"]
      >[number]["evidenceIds"]
    }]
  };
}
