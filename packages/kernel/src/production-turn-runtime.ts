import { createActionGraphBuilder } from "./action-graph.js";
import { createAlphaFieldPersistence } from "./alpha-field-persistence.js";
import { composeEvidenceGroundedAnswer } from "./answer-emitter.js";
import { revisionAnswerVersion, selectedCandidateRevisionQuality } from "./answer-revision-runtime.js";
import {
  createAnswerRevisionCoordinator
} from "./answer-revision.js";
import { assistantForceDecision } from "./assistant-force.js";
import { attachCognitiveProposal, attachInventionConstruct, cognitiveProposalForCandidate, selectedInventionForCandidate } from "./candidate-construct-binding.js";
import { candidateIsSafeNonExecutingPlan, candidateUsesNonFactualPlanSemantics, selectedCandidateEntailment } from "./candidate-proof-policy.js";
import { createCandidateEngine, type CandidateSurface } from "./candidate.js";
import { createPfaceEstimator } from "./causal-estimation.js";
import { createCcrEngine } from "./ccr.js";
import { planCognitiveProposals, type CognitiveActionPlan } from "./cognitive-planner.js";
import { createConnectorGovernance, defaultConnectorConfigs } from "./connector-governance.js";
import { createConstructSubstratePlanner } from "./construct-substrate.js";
import { CORPUS_ROLE_IDS } from "./corpus-registry.js";
import { createCorrectionMemory } from "./correction-memory.js";
import { createCounterfactualCognition } from "./counterfactual-cognition.js";
import { traceEvent } from "./debug/trace.js";
import { updateDialogueState } from "./dialogue-pragmatics.js";
import { discourseObjectStateFromMetadata } from "./discourse-state.js";
import { createSemanticEntailmentEngine } from "./entailment.js";
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
import { createAlphaFieldEngine } from "./field.js";
import { createFunctionalCognitionEngine } from "./functional-cognition.js";
import { createIdFactory } from "./ids.js";
import { planInventions } from "./invention-planner.js";
import { createJudge } from "./judge.js";
import { jsonRecord, kernelNumber, kernelString, uniqueKernelStrings } from "./kernel-answer-primitives.js";
import {
  mergeCorrectionRules,
  pcaForceForMouthSurface,
  registerIdFromMetadata,
  requiresExplicitApproval,
  runtimeLanguageProfile,
  sourceLanguageAliasFromMetadata,
  styleProfileIdFromMetadata,
  surfaceDetailProfileIdFromMetadata,
  translationTargetFromMetadata
} from "./kernel-input-controls.js";
import type { LanguageMemoryRuntimeState } from "./language-memory-runtime.js";
import { createLanguageMemoryRuntime } from "./language-memory-runtime.js";
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
  evidenceForRequest,
  evidenceWithGraphPreviewWindows,
  graphFilteredToEvidence,
  localEvidenceAnswerClaimSurface,
  localEvidenceAnswerProofExcerpts,
  localEvidenceAnswerSurface,
  proposeSourceExactEvidenceAnswer,
  runtimeEvidenceWindowsForRequest,
  sessionContextEvidenceEnabled,
  sourceAnchoredEvidenceForRequest,
  temporalCounterexampleExpected
} from "./local-evidence-runtime.js";
import { formatSurfaceMessage, localeFromMetadata } from "./localization.js";
import { createDeterministicMouth, createMouth, type SpokenOutput } from "./mouth.js";
import { createMultilingualAcquisitionEngine } from "./multilingual-acquisition.js";
import {
  createTypedTemporalWalkEngine,
  expandPowerWalkSeedAnchors
} from "./powerwalk.js";
import { createPredictionLayer } from "./prediction.js";
import { createClock, createHasher, featureSet, toJsonValue } from "./primitives.js";
import { createEmissionEngine, createProgramGraphBuilder, createValidationGraphBuilder } from "./program.js";
import { createProofCarryingAnswer } from "./proof-carrying-answer.js";
import {
  activeRequestOperatorIds,
  admitCandidatesForAuthority,
  projectRequestAuthority,
  requestOperatorDialogueSupport,
  requestOperatorGraphSupport
} from "./request-authority.js";
import { hybridRecall } from "./retrieval.js";
import { createRuntimeAcquisition } from "./runtime-acquisition.js";
import { decideRuntimeCoherence } from "./runtime-coherence.js";
import { executableRuntimeDeadlineFromMetadata, type RuntimeDeadlineDecision } from "./runtime-deadline.js";
import { createRuntimeGraphRetrieval } from "./runtime-graph-retrieval.js";
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
import { createSemanticMemoryIndex } from "./semantic-memory-index.js";
import { createSemanticProofSystem } from "./semantic-proof-system.js";
import type { ScceKernelDeps } from "./storage.js";
import { createSurfaceLanguageRuntime } from "./surface-language-runtime.js";
import { createAutonomousToolCognition } from "./tool-cognition.js";
import { createTrainingOrchestrator } from "./training-orchestrator.js";
import { canonicalTranslationTargetKey, createTranslationEngine, type TranslationPlan } from "./translation.js";
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
import type {
  BuildTestResult,
  CapabilityPlan,
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

export interface ProductionTurnRuntimeState {
  lastEpisodeId?: EpisodeId;
  lastOutput: string;
  lastTurnTiming?: TurnResult["timing"];
  lastField?: TurnResult["field"];
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
    sessionEvidenceFromMetadata
  } = graphRetrieval;
  const {
    hydrateSurfaceLanguageMemoryCached, requestSemanticFrames, sourceOwnedLanguageClusterForAlias,
    residentSurfaceLanguageMemory,
    sourceOwnedLanguageProfilesCached, surfaceLanguageClusterCached, surfaceLanguageProfilesCached,
    uniqueRecordsById
  } = surfaceLanguageRuntime;
  const { activeBrainMarker, calibrationModelsCached, correctionRulesCached } = runtimeMemory;
  const { learnHydrateReplan, runtimeMotionDeferredByDeadline } = runtimeAcquisition;
  const {
    actionGraphBuilder, alphaPersistence, answerRevision, candidates, ccr, connectorGovernance,
    constructSubstrate, correctionMemory, counterfactual, deterministicMouth, emissionEngine,
    entailment, fcs, fieldEngine, functionalCognitionEngine, judge, learningLoop, mouth, multilingual,
    pca, pface, powerWalk, prediction, programBuilder, runtimeOrchestrator, safetyRails, semanticMemory,
    semanticProofSystem, ssd, toolCognition, trainingOrchestrator, translationEngine, validationBuilder
  } = engines;


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

  async function turn(input: OwnerInput): Promise<TurnResult> {

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
      const fastRuntimeBudget = fastRuntimeBudgetRequested(input.metadata);
      const runtimeDeadline = executableRuntimeDeadlineFromMetadata(input.metadata);
      const deadlineCheckpoint = (phase: string, requiredMs: number): RuntimeDeadlineDecision | undefined => {
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
          ? await sourceOwnedLanguageClusterForAlias(sourceLanguageAlias, input.text)
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
      const selectedSurfaceProfile = selectedSurfaceCluster?.members[0];
      const authorityLanguageStarted = Date.now();
      const baseAuthorityLanguage = await evaluationComponent(
        "language-memory",
        "authority.language-memory.hydrate",
        () => hydrateSurfaceLanguageMemoryCached(12, selectedSurfaceCluster, selectedSurfaceCluster ? "source-cluster-selected" : "source-surface-ambiguous-or-no-signal"),
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
      const exactRequestFramesStarted = Date.now();
      const exactRequestFrames = deps.evaluationCondition?.flags.disableLanguageMemory
        ? []
        : await requestSemanticFrames(input.text);
      kernelTrace({
        stage: "runtime.seed.request_frames",
        label: "kernel.turn",
        durationMs: Date.now() - exactRequestFramesStarted,
        counts: { semanticFrames: exactRequestFrames.length }
      });
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
      const previousDialogueState = previousDialogueStateFromMetadata(input.metadata);
      const authorityDialogueState = updateDialogueState({
        requestText: input.text,
        targetLanguage: translationTarget ?? locale,
        previousState: previousDialogueState,
        conversationId: previousDialogueState?.conversationId
      });
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
      let operatorActivations = activateCognitiveOperators({
        requirementField,
        dialogueSupport: requestOperatorDialogueSupport(requirementField),
        outcomeSupport: operatorOutcomeSupport(input.metadata)
      });
      const authorityProjection = projectRequestAuthority({ requirementField, explicitAuthority });
      const requestedAuthority = authorityProjection.requestedAuthority;
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
      const runtimeDag = runtimeOrchestrator.dag({ episodeId, mode: "turn", mutating: true, requestedTools: Boolean(deps.connectors) });
      const safetyDecision = safetyRails.evaluate({ text: input.text, plans: [], policy });
      events.push(await append(eventFactory.create({ episodeId, typeId: "ActionPrepared", payload: { runtimeDag: runtimeDag.audit, safety: safetyDecision.audit } })));
      markTiming("seedMs");
      const arithmetic = arithmeticAnswerForText(input.text);
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
      const semanticFrameBoundEvidenceIds = new Set(graphSlice.semanticFrameBoundEvidenceIds ?? []);
      let graph = graphSlice.graph;
      const evidencePool = discourseEvidenceBound
        ? mergeEvidenceSpans([...sessionEvidence, ...metadataEvidence, ...graphSlice.evidence.filter(span => metadataEvidenceIds.has(String(span.id)))])
        : mergeEvidenceSpans([...sessionEvidence, ...metadataEvidence, ...graphSlice.evidence]);
      const evidence = evidenceWithGraphPreviewWindows(
        input.text,
        evidencePool,
        graph.nodes,
        new Set([...metadataEvidenceIds, ...semanticFrameBoundEvidenceIds])
      );
      const calibrationModels = await calibrationModelsCached();
      const sourceAnchorAudit = discourseEvidenceBound
        ? { required: false, anchors: [] as string[], evidence }
        : requestedAuthority === "creative"
          ? { required: false, anchors: [] as string[], evidence }
          : sourceAnchoredEvidenceForRequest(input.text, evidence, semanticFrameBoundEvidenceIds);
      const admissibleEvidence = sourceAnchorAudit.required ? sourceAnchorAudit.evidence : evidence;
      if (sourceAnchorAudit.required) graph = graphFilteredToEvidence(graph, sourceAnchorAudit.evidence);
      const retrievalFeatures = graphRetrievalFeatures(retrievalText);
      const semanticRetrievalStarted = Date.now();
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
      const factualProofRequired = requestedAuthority !== "creative";
      const supportCandidates = factualProofRequired
        ? runtimeEvidenceWindowsForRequest(input.text, evidenceForRequest(input.text, admissibleEvidence.filter(span => span.status === "promoted"), metadataEvidenceIds, explicitContextEvidenceIds, semanticFrameBoundEvidenceIds).slice(0, turnProofEvidenceLimit))
        : [];
      const proofNodes = factualProofRequired ? graph.nodes : [];
      const proofEdges = factualProofRequired ? graph.edges : [];
      const answerProposal = factualProofRequired
        ? proposeSourceExactEvidenceAnswer({
          requestText: input.text,
          selectedEvidence: supportCandidates,
          semanticFrameBoundEvidenceIds
        })
        : undefined;
      const proofClaimText = answerProposal
        ? localEvidenceAnswerClaimSurface(answerProposal) || input.text
        : input.text;
      const proofCandidateEvidence = answerProposal?.evidence ?? supportCandidates;
      const proofSourceExcerpts = answerProposal
        ? localEvidenceAnswerProofExcerpts(answerProposal)
        : [];
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
            pfaceEstimate: factualProofRequired ? pface.estimate({ nodes: proofNodes, edges: proofEdges, field }) : undefined
          };
        },
        () => ({
          promoted: [] as EvidenceSpan[],
          entailmentResult: createAblatedSupportEntailment({ requestText: proofClaimText, field, idFactory, createdAt: clock.now() }),
          semanticProof: emptySemanticProofResult(proofClaimText, hasher),
          ccrResult: emptyCcrResult(proofClaimText),
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
      let selectedEvidence = runtimeEvidenceWindowsForRequest(input.text, evidenceForRequest(input.text, evidenceSelectionPool, metadataEvidenceIds, explicitContextEvidenceIds, semanticFrameBoundEvidenceIds));
      const temporalEvidencePool = mergeEvidenceSpans([...admissibleEvidence, ...metadataEvidence]);
      const selectedTemporalFallback = evidenceBatchFromSlice(temporalEvidencePool, selectedEvidence.map(span => span.id)) ?? selectedEvidence;
      const durableTemporalEvidence = temporalCounterexampleExpected(input.text, selectedTemporalFallback)
        ? await deps.storage.evidence.getEvidenceBatch(selectedEvidence.map(span => span.id))
        : [];
      const selectedTemporalEvidence = evidenceBatchFromSlice(durableTemporalEvidence, selectedEvidence.map(span => span.id))
        ?? selectedTemporalFallback;
      let earlyLearningNeeds = learningNeedsFor(input.text, entailmentResult, selectedEvidence, locale);
      markTiming("proofMs");
      const selectedPoolLocalEvidenceAnswer = proofSelectedEvidence.length
        ? (
          answerProposal
          && proofSourceExcerpts.length > 0
          && answerProposal.evidence.every(span => entailmentResult.evidenceIds.some(id => String(id) === String(span.id)))
            ? answerProposal
            : localEvidenceAnswerSurface({
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
        )
        : undefined;
      // Surface planning may narrow the evidence selected by the proof engine,
      // but it may not introduce evidence or support edges after proof.
      const localEvidenceAnswer = deps.evaluationCondition?.flags.disableSupportEngine
        ? undefined
        : selectedPoolLocalEvidenceAnswer;
      const longPathBasisAnswer = requestedAuthority === "creative" ? undefined : localEvidenceAnswer;
      const answerEntailmentSeed = entailmentResult;
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
      const evidenceSurfaceCluster = selectLanguageProfileClusterForSourceVersions(
        (await surfaceLanguageProfilesCached(fastRuntimeBudget)).clusters,
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
      const residentEvidenceLanguage = residentSurfaceLanguageMemory(
        evidenceSurfaceCluster,
        preferredSurfaceCorpusRole
      );
      let surfaceLanguage = preferredSurfaceCorpusRole
        ? exactCreativeAuthorityReady
          ? authorityLanguage
          : residentEvidenceLanguage ?? authorityLanguage
        : evidenceSurfaceCluster && evidenceSurfaceCluster.id !== selectedSurfaceCluster?.id
          ? residentEvidenceLanguage ?? authorityLanguage
          : authorityLanguage;
      const productionTranslationProfiles = translationTarget
        ? (await sourceOwnedLanguageProfilesCached([translationTarget])).profiles
        : [];
      let productionTranslationPlan: TranslationPlan | undefined;
      if (translationTarget) {
        const priorAlignments = await deps.storage.languageMemory.listTranslationAlignments({ targetLanguage: canonicalTranslationTargetKey(translationTarget), limit: 500 });
        productionTranslationPlan = translationEngine.plan({
          text: input.text,
          targetLanguage: translationTarget,
          evidence: selectedEvidence,
          profiles: productionTranslationProfiles,
          priorAlignments,
          createdAt: clock.now()
        });
        if (deps.evaluationCondition?.flags.disableLanguageMemory !== true) {
          surfaceLanguage = productionTranslationPlan.targetCluster
            ? await hydrateSurfaceLanguageMemoryCached(12, productionTranslationPlan.targetCluster, "translation-target-cluster-selected")
            : await hydrateSurfaceLanguageMemoryCached(12, undefined, "translation-target-ambiguous-or-unknown");
        }
      }
      const surfaceLanguageModels = surfaceLanguage.models;
      const surfaceLanguageMemory = surfaceLanguage.state;
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
          corpusRole: preferredSurfaceCorpusRole ?? null
        }
      });
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
          actionCommitment: requirementField.actionCommitment,
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
        calibrationTaskClass
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
            runtimeState.lastField = undefined;
            return turn({
              ...input,
              metadata: metadataWithRuntimeReplanMotion(input.metadata, motion)
            });
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
          surfaceMass: authorityCandidateField.surfaceMass.slice(0, 6),
          authorityAdmission: authorityCandidateField.audit
        }
      });
      const judged = judge.select({
        field: authorityCandidateField,
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
          actionCommitment: requirementField.actionCommitment,
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
          const buildTestDecision = permission.allowed && !permission.dryRun
            ? deadlineCheckpoint("build_test.execute", 5_000)
            : undefined;
          if (permission.allowed && !permission.dryRun && buildTestDecision?.allowed !== false) {
            events.push(await append(eventFactory.create({ episodeId, typeId: "CapabilityInvoked", payload: { capabilityId: capability.id, planId: plan.id } })));
            buildTest = await deps.buildTest.executeProgram({ episodeId, construct });
            await deps.storage.constructs.putBuildTest(episodeId, construct.id, buildTest);
            events.push(await append(eventFactory.create({ episodeId, typeId: "BuildExecuted", payload: { code: buildTest.build.code, durationMs: buildTest.build.durationMs, stderrHash: hasher.digestHex(buildTest.build.stderr) } })));
            events.push(await append(eventFactory.create({ episodeId, typeId: "TestExecuted", payload: { code: buildTest.test.code, passed: buildTest.passed, repairAttempted: buildTest.repairAttempted } })));
            events.push(await append(eventFactory.create({ episodeId, typeId: buildTest.passed ? "CapabilitySucceeded" : "CapabilityFailed", payload: { capabilityId: capability.id, planId: plan.id, passed: buildTest.passed } })));
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
      const priorConstructGraph = runtimeDiagnosticRequested
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
      events.push(await append(eventFactory.create({ episodeId, typeId: "CausalGraphDiscovered", payload: { counterfactual: counterfactualWorld.audit } })));
      events.push(await append(eventFactory.create({ episodeId, typeId: "ActionPrepared", payload: { safety: safetyWithPlans.audit, toolPlan: toolPlan.policyAudit } })));
      if (construct.program) events.push(await append(eventFactory.create({ episodeId, typeId: "ProgramGraphBuilt", payload: construct.program })));
      if (construct.artifacts.length) events.push(await append(eventFactory.create({ episodeId, typeId: "FileGraphBuilt", payload: { files: construct.artifacts.map(file => ({ path: file.path, contentHash: file.contentHash, role: file.role })) } })));
      markTiming("planningMs");
      const mouthStarted = Date.now();
      const speakInput = {
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
          : undefined
      };
      const learnedMouthDecision = deadlineCheckpoint("mouth.realize.learned", 750);
      let spoken = await evaluationComponent(
        "learned-mouth",
        "mouth.realize",
        () => learnedMouthDecision?.allowed === false
          ? deterministicMouth.speak(speakInput)
          : mouth.speak(speakInput),
        () => deterministicMouth.speak(speakInput)
      );
      const emptyAuthoritySurface = !spoken.text.trim()
        && (requestedAuthority === "factual" || requestedAuthority === "reasoned")
        && !runtimeDiagnosticRequested;
      if (emptyAuthoritySurface && !inheritedRuntimeMotion) {
        const recoveryDecision = deadlineCheckpoint("runtime.replan.empty_mouth", 5_000);
        if (recoveryDecision?.allowed !== false) {
          const motion = await learnHydrateReplan({
            ownerInput: input,
            episodeId,
            requestedAuthority,
            trigger: "coherence_support_failure",
            events
          });
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
        contradiction: candidateUsesNonFactualPlanSemantics(judged.selected)
          ? judged.selected.scores.contradiction
          : requestedAuthority === "creative"
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
      const answerRevisionEligible = Boolean(
        selectedProposal
        && requestedAuthority !== "creative"
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
        contradiction: candidateUsesNonFactualPlanSemantics(judged.selected)
          ? judged.selected.scores.contradiction
          : requestedAuthority === "creative"
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
        selectedCandidateAudit: judged.selected.audit
      });
      const runtimeCoherenceTrace = toJsonValue(runtimeCoherence);
      const coherenceRequiresContinuation = !runtimeCoherence.emitAllowed
        || runtimeCoherence.demotionRequired
        || runtimeCoherence.assistantForceAfter === "insufficient_support";
      if (
        coherenceRequiresContinuation
        && requestedAuthority !== "creative"
        && !candidateIsSafeNonExecutingPlan(judged.selected)
        && !runtimeDiagnosticRequested
        && !inheritedRuntimeMotion
      ) {
        const recoveryDecision = deadlineCheckpoint("runtime.replan.coherence", 5_000);
        if (recoveryDecision?.allowed !== false) {
          const motion = await learnHydrateReplan({
            ownerInput: input,
            episodeId,
            requestedAuthority,
            trigger: "coherence_support_failure",
            events
          });
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
            runtimeMotion: "not_started",
            reason: "runtime-deadline-reserve",
            deadlineDecision: recoveryDecision,
            coherence: runtimeCoherenceTrace
          })
        })));
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
      const priorStates = afterTurnMaintenanceDeferred ? [] : await deps.storage.forecasts.getSeries({ limit: 64 });
      const forecast = prediction.forecast({ states: priorStates, source: state, horizon: 2, createdAt: clock.now() });
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
          actionGraph: toJsonValue({ actionGraph: actionGraph.audit, toolPlan: toolPlan.policyAudit, safety: safetyWithPlans.audit, runtime: runtimeDag.audit, runtimeReadiness: runtimeReadinessForEmission.audit, runtimeCoherence: runtimeCoherenceTrace, discourseObject: discourseObjectTrace ?? null, counterfactual: counterfactualWorld.audit, constructSubstrate: assembly.audit, sourceAnchor: { sourceAnchorRequired: sourceAnchorAudit.required, sourceAnchorMatched: sourceAnchorAudit.evidence.length > 0, sourceAnchors: sourceAnchorAudit.anchors }, maintenanceDeferred: true, maintenance: afterTurnMaintenance.audit }),
          proofCarryingAnswer: pcaReport.audit,
          pface: pfaceEstimate?.audit,
          languageAcquisition: toJsonValue({ maintenanceDeferred: true, maintenance: afterTurnMaintenance.audit }),
          mouth: toJsonValue({ surfacePlan: spoken.surfacePlan, trace: spoken.realizationTrace, inspectRefs: spoken.inspectRefs, uncertainty: spoken.uncertainty }),
          runtimeCoherence: runtimeCoherenceTrace,
          ...(inheritedRuntimeMotion ? { runtimeMotion: toJsonValue(inheritedRuntimeMotion) } : {}),
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
            unsupportedContentBlocked: emission.assistantForce === "insufficient_support" || runtimeCoherence.demotionRequired
          }),
          events
        };
      }
      evaluationComponent("incremental-learning", "maintenance.incremental-learning", () => undefined, () => undefined);
      const runtimeModel = await deps.storage.model.readModel();
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
      runtimeState.lastEpisodeId = episodeId;
      runtimeState.lastOutput = emission.answer;
      events.push(await append(eventFactory.create({ episodeId, typeId: "SelfModelProjected", payload: { self: selfState, selfDistillation: selfDistillation.audit, fcs: functionalConsciousness.audit, functionalCognition: functionalCognition.audit } })));
      markTiming("maintenanceMs");
      const timing = buildTiming("foreground");
      events.push(await append(eventFactory.create({ episodeId, typeId: "EpisodeClosed", payload: { output: emission.answer, timing } })));
      runtimeState.lastTurnTiming = timing;
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
        actionGraph: toJsonValue({ actionGraph: actionGraph.audit, toolPlan: toolPlan.policyAudit, safety: safetyWithPlans.audit, runtime: runtimeDag.audit, runtimeReadiness: runtimeReadinessForEmission.audit, runtimeCoherence: runtimeCoherenceTrace, discourseObject: discourseObjectTrace ?? null, counterfactual: counterfactualWorld.audit, constructSubstrate: assembly.audit, sourceAnchor: { sourceAnchorRequired: sourceAnchorAudit.required, sourceAnchorMatched: sourceAnchorAudit.evidence.length > 0, sourceAnchors: sourceAnchorAudit.anchors }, maintenance: afterTurnMaintenance.audit }),
        selfState,
        selfDistillation: selfDistillation.audit,
        functionalConsciousness: functionalConsciousness.audit,
        functionalCognition: toJsonValue({ ...(functionalCognition.audit as Record<string, JsonValue>), runtimeReadiness: runtimeReadinessForEmission.audit, runtimeCoherence: runtimeCoherenceTrace }),
        runtimeCoherence: runtimeCoherenceTrace,
        ...(inheritedRuntimeMotion ? { runtimeMotion: toJsonValue(inheritedRuntimeMotion) } : {}),
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
          unsupportedContentBlocked: emission.assistantForce === "insufficient_support" || runtimeCoherence.demotionRequired
        }),
        events
      };
      });
    
  }

  return { turn };
}
