import type { IdFactory } from "./ids.js";
import { createIdFactory } from "./ids.js";
import type { CorrectionRuleRecord } from "./storage.js";
import type {
  EvidenceSpan,
  GraphEdge,
  GraphNode,
  Hasher,
  JsonValue,
  NodeId,
  ProgramGraph,
  RuntimeCalibrationStatus,
  RuntimeCalibrationSummary,
  RuntimeEvidenceForce,
  RuntimeGuardFlags,
  RuntimeScoreTrace,
  RuntimeTruthState,
  SourceVersion
} from "./types.js";
import { canonicalStringify, clamp01, createClock, createHasher, featureSet, toJsonValue, weightedJaccard } from "./primitives.js";
import { launchContractForTurn } from "./launch-contract.js";
import { INTERACTION_FEATURE_IDS, updateDialogueState, type DialogueFeedback, type DialogueState, type UserStyleProfile } from "./dialogue-pragmatics.js";
import type { ScoreTrace } from "./scoring/score-trace.js";
import { buildCalibrationModel, type CalibrationModel, type CalibrationPoint } from "./scoring/calibration.js";
import {
  CALIBRATION_IDS,
  CALIBRATION_SUBSYSTEM_IDS,
  CALIBRATION_TASK_CLASS_IDS,
  buildCalibrationModelSet,
  calibrationObservationRecord,
  type CalibrationModelSet
} from "./calibration-spine.js";
import { createTypedIngestProjector, type TypedIngestProjection } from "./typed-ingest.js";
import {
  promoteWorkspaceAnalysisToCoreRecords,
  type WorkspaceCoreAnalysisInput,
  type WorkspaceCorePromotionResult,
  type WorkspaceCoreSourceFileInput,
  type WorkspaceCoreSourceRef,
  type WorkspaceCoreWorkspaceRef
} from "./workspace-core-fusion.js";
import { answerFromWorkspaceCoreContext, type WorkspaceKernelAnswerResult } from "./workspace-kernel-context.js";
import {
  defaultSyntheticToolCapabilities,
  runLearningLoop,
  type LearningLoopResult,
  type SyntheticToolFixtures,
  type ToolCapability
} from "./learning-loop.js";
import { createProgramRepairKernel, type RepairPlan } from "./program-repair-kernel.js";
import {
  createSourceCompletionContract,
  planHydration as planSourceCompletionHydration,
  validateSourceCompletionContract,
  type SourceCompletionContract,
  type SourceCompletionHydrationPlan,
  type SourceCompletionHydrationRecord,
  type SourceCompletionRuntimeCounts
} from "./source-completion-contract.js";

export interface ScceRuntimeFixtureFile {
  path: string;
  mediaType: string;
  text: string;
  metadata?: JsonValue;
}

export interface ScceRuntimeFixtureAnalysis {
  summary?: WorkspaceCoreAnalysisInput["summary"];
  map?: WorkspaceCoreAnalysisInput["map"];
  symbols?: WorkspaceCoreAnalysisInput["symbols"];
  commands?: WorkspaceCoreAnalysisInput["commands"];
  routes?: WorkspaceCoreAnalysisInput["routes"];
  gaps?: WorkspaceCoreAnalysisInput["gaps"];
  contradictions?: WorkspaceCoreAnalysisInput["contradictions"];
  tasks?: WorkspaceCoreAnalysisInput["tasks"];
  reports?: WorkspaceCoreAnalysisInput["reports"];
}

export interface ScceRuntimeFixtureInput {
  id?: string;
  rootPath?: string;
  workspace?: Partial<WorkspaceCoreWorkspaceRef>;
  files: ScceRuntimeFixtureFile[];
  analysis?: ScceRuntimeFixtureAnalysis;
  now?: number;
}

export interface ScceRuntimeIngestResult {
  schema: "scce.runtime.fixture_ingest.v1";
  id: string;
  workspace: WorkspaceCoreWorkspaceRef;
  analysis: WorkspaceCoreAnalysisInput;
  sourceVersions: SourceVersion[];
  evidence: EvidenceSpan[];
  typedProjections: TypedIngestProjection[];
  graph: { nodes: GraphNode[]; edges: GraphEdge[] };
  graphLearning: RuntimeGraphLearningReport;
  classificationCounts: Record<string, number>;
  unsupportedRecords: JsonValue[];
  audit: JsonValue;
}

export interface RuntimeGraphLearningReport {
  schema: "scce.runtime.graph_learning_report.v2";
  id: string;
  trainingStatus: "trained_cpu_local" | "insufficient_graph";
  model: {
    schema: "scce.runtime.graph_link_model.v1";
    featureIds: string[];
    weights: number[];
    relationIds: string[];
    createdAt: number;
  };
  linkPrediction: {
    positiveEdgeCount: number;
    negativeEdgeCount: number;
    heldOutCount: number;
    learnedAuc: number;
    lexicalBaselineAuc: number;
    learnedAucAboveLexicalBaseline: boolean;
  };
  evidenceConstructAlignment: {
    evidenceLinkedEdgeCount: number;
    typedObservationCount: number;
    sourceBoundRatio: number;
  };
  temporalPrediction: {
    temporallyScopedEdgeCount: number;
    freshEdgeRatio: number;
  };
  trace: JsonValue;
}

export interface SourceOnlyTurnSimulationInput {
  text: string;
  promotionId?: string;
  correctionRules?: CorrectionRuleRecord[];
  maxLength?: number;
  conversationId?: string;
  targetLanguage?: string;
  dialogueState?: DialogueState;
  dialogueFeedback?: DialogueFeedback;
  userStyleProfile?: Partial<UserStyleProfile>;
}

export type ScceRuntimeTurnInput = SourceOnlyTurnSimulationInput;

export interface SourceOnlyTurnSimulationTrace {
  schema: "scce.runtime.turn_trace.v1";
  id: string;
  turnId: string;
  inputId: string;
  runtimeModeId: "runtime.mode.source_only_in_memory";
  simulation: true;
  hydratedRuntime: false;
  serverPath: false;
  promotionId?: string;
  constructId: string;
  evidenceIds: string[];
  proofVerdictId: string;
  graphAlphaPpfSummaryId?: string;
  graphAlphaPpfSummary?: {
    id: string;
    nodeCount: number;
    edgeCount: number;
    seedCount: number;
    activeCount: number;
    ppfTopNodeIds: string[];
  };
  learningGapIds: string[];
  learningNeedIds: string[];
  programGraphId?: string;
  toolUseResultId?: string;
  walshSurfaceEnergySelectedCandidateId: string;
  mouthTraceId: string;
  dialogueStateId: string;
  dialoguePolicyDecisionId: string;
  pragmaticsCriticId: string;
  sourceRefs: WorkspaceCoreSourceRef[];
  warnings: string[];
  unsupportedRecords: JsonValue[];
  answerTextHash: string;
  scoreTraces: RuntimeScoreTrace[];
  calibrationStatus: RuntimeCalibrationStatus;
  calibration?: RuntimeCalibrationSummary;
  truthState: RuntimeTruthState;
  evidenceForce: RuntimeEvidenceForce;
  guardFlags: RuntimeGuardFlags;
  validation: { valid: boolean; diagnostics: string[] };
}

export type ScceRuntimeTurnTrace = SourceOnlyTurnSimulationTrace;

export interface SourceOnlyTurnSimulationResult {
  schema: "scce.runtime.turn.v1";
  id: string;
  runtimeModeId: "runtime.mode.source_only_in_memory";
  simulation: true;
  hydratedRuntime: false;
  serverPath: false;
  answer: string;
  workspace: WorkspaceKernelAnswerResult;
  trace: SourceOnlyTurnSimulationTrace;
}

export type ScceRuntimeTurnResult = SourceOnlyTurnSimulationResult;

export interface ScceRuntimeLearningStepResult {
  schema: "scce.runtime.learning_step.v1";
  id: string;
  turnId?: string;
  learning: LearningLoopResult;
  toolUseResultIds: string[];
  updatePlanIds: string[];
  validated: boolean;
  audit: JsonValue;
}

export type ScceRuntimeOutcomeStatus = "accepted" | "rejected" | "corrected" | "succeeded" | "failed" | "rolled_back";

export interface ScceRuntimeOutcomeInput {
  turnId?: string;
  patchPlanId?: string;
  status: ScceRuntimeOutcomeStatus;
  tests?: { passed: boolean; total?: number; failed?: number; command?: string };
  feedbackText?: string;
  correctionRules?: CorrectionRuleRecord[];
  errorClass?: string;
  now?: number;
}

export interface ScceRuntimeOutcomeResult {
  schema: "scce.runtime.outcome_record.v1";
  id: string;
  target: { kind: "turn" | "patch_plan"; id: string };
  status: ScceRuntimeOutcomeStatus;
  successScore: number;
  calibrationPoints: Array<CalibrationPoint & { taskClass: string; sourceTraceId?: string }>;
  calibrationModel?: CalibrationModel;
  patchRankSignal?: {
    patchSetId?: string;
    previousScore: number;
    adjustedScore: number;
    regressionRiskDelta: number;
    lossKind: "patch-rank";
  };
  correctionRuleIds: string[];
  reversible: true;
  audit: JsonValue;
}

export interface ScceRuntimePatchPlanResult {
  schema: "scce.runtime.patch_plan.v1";
  id: string;
  turnId?: string;
  programGraphId: string;
  workspaceAffectedFiles: string[];
  repairPlan: RepairPlan;
  virtualPatch?: { changed: string[]; audit: JsonValue };
  safeToApplyInTemp: boolean;
  audit: JsonValue;
}

export interface ScceRuntimeHydrationPlanResult {
  schema: "scce.runtime.hydration_plan.v1";
  id: string;
  contract: SourceCompletionContract;
  validation: ReturnType<typeof validateSourceCompletionContract>;
  dryRunPlan: SourceCompletionHydrationPlan;
  safeToHydrateLater: boolean;
  audit: JsonValue;
}

export type ScceRuntimeInspection =
  | { schema: "scce.runtime.inspect.v1"; id: string; kind: "fixture_ingest"; value: ScceRuntimeIngestResult }
  | { schema: "scce.runtime.inspect.v1"; id: string; kind: "workspace_promotion"; value: WorkspaceCorePromotionResult }
  | { schema: "scce.runtime.inspect.v1"; id: string; kind: "turn"; value: SourceOnlyTurnSimulationTrace }
  | { schema: "scce.runtime.inspect.v1"; id: string; kind: "learning_step"; value: ScceRuntimeLearningStepResult }
  | { schema: "scce.runtime.inspect.v1"; id: string; kind: "patch_plan"; value: ScceRuntimePatchPlanResult }
  | { schema: "scce.runtime.inspect.v1"; id: string; kind: "hydration_plan"; value: ScceRuntimeHydrationPlanResult }
  | { schema: "scce.runtime.inspect.v1"; id: string; kind: "outcome"; value: ScceRuntimeOutcomeResult }
  | { schema: "scce.runtime.inspect.v1"; id: string; kind: "dialogue_state"; value: DialogueState }
  | { schema: "scce.runtime.inspect.v1"; id: string; kind: "not_found"; value: { id: string; knownIds: string[] } };

export interface InMemoryScceRuntime {
  ingest(input: ScceRuntimeFixtureInput): ScceRuntimeIngestResult;
  ingestFixture(input: ScceRuntimeFixtureInput): ScceRuntimeIngestResult;
  promote(input: { ingestId?: string; analysis?: WorkspaceCoreAnalysisInput }): WorkspaceCorePromotionResult;
  promoteWorkspace(input: { ingestId?: string; analysis?: WorkspaceCoreAnalysisInput }): WorkspaceCorePromotionResult;
  simulateTurn(input: SourceOnlyTurnSimulationInput): Promise<SourceOnlyTurnSimulationResult>;
  runSourceOnlyTurn(input: SourceOnlyTurnSimulationInput): Promise<SourceOnlyTurnSimulationResult>;
  turn(input: SourceOnlyTurnSimulationInput): Promise<SourceOnlyTurnSimulationResult>;
  inspect(id: string): ScceRuntimeInspection;
  inspectSourceOnlyTurn(id: string): ScceRuntimeInspection;
  planHydration(input?: { turnId?: string; promotionId?: string; records?: SourceCompletionHydrationRecord[] }): ScceRuntimeHydrationPlanResult;
  planPatch(input: { turnId?: string; programGraph?: ProgramGraph; stdout?: string; stderr?: string; requestText?: string }): ScceRuntimePatchPlanResult;
  runLearningStep(input: { turnId?: string; fixtures?: SyntheticToolFixtures; toolCapabilities?: ToolCapability[]; maxPlansToRun?: number; now?: number }): ScceRuntimeLearningStepResult;
  recordOutcome(input: ScceRuntimeOutcomeInput): ScceRuntimeOutcomeResult;
}

export type ScceRuntime = InMemoryScceRuntime;

interface RuntimeState {
  ingests: Map<string, ScceRuntimeIngestResult>;
  promotions: Map<string, WorkspaceCorePromotionResult>;
  turns: Map<string, SourceOnlyTurnSimulationResult>;
  learningSteps: Map<string, ScceRuntimeLearningStepResult>;
  patches: Map<string, ScceRuntimePatchPlanResult>;
  hydrationPlans: Map<string, ScceRuntimeHydrationPlanResult>;
  outcomes: Map<string, ScceRuntimeOutcomeResult>;
  dialogueStates: Map<string, DialogueState>;
}

export function createInMemoryScceRuntime(options: { idFactory?: IdFactory; hasher?: Hasher; now?: () => number } = {}): InMemoryScceRuntime {
  const hasher = options.hasher ?? createHasher();
  const clock = createClock({ fixedTime: options.now?.() ?? 1700000000000, stepMs: 1 });
  const idFactory = options.idFactory ?? createIdFactory({ clock, hasher, deterministicReplay: true, namespace: "scce-runtime" });
  const typedIngest = createTypedIngestProjector({ idFactory, hasher });
  const state: RuntimeState = {
    ingests: new Map(),
    promotions: new Map(),
    turns: new Map(),
    learningSteps: new Map(),
    patches: new Map(),
    hydrationPlans: new Map(),
    outcomes: new Map(),
    dialogueStates: new Map()
  };

  function ingestFixture(input: ScceRuntimeFixtureInput): ScceRuntimeIngestResult {
    const now = input.now ?? clock.now();
    const id = input.id ?? stableId(hasher, "runtime_ingest", { files: input.files.map(file => [file.path, file.mediaType, hashText(hasher, file.text)]), now });
    const rootPath = input.rootPath ?? ".";
    const workspace: WorkspaceCoreWorkspaceRef = {
      id: input.workspace?.id ?? stableId(hasher, "workspace", { id, rootPath }),
      corpusId: input.workspace?.corpusId ?? stableId(hasher, "corpus", { id, rootPath }),
      rootPath,
      rootUri: input.workspace?.rootUri ?? `fixture://${id}`
    };
    const sourceFiles: WorkspaceCoreSourceFileInput[] = [];
    const sourceVersions: SourceVersion[] = [];
    const evidence: EvidenceSpan[] = [];
    const typedProjections: TypedIngestProjection[] = [];
    const graphNodes: GraphNode[] = [];
    const graphEdges: GraphEdge[] = [];
    const unsupportedRecords: JsonValue[] = [];

    for (const file of input.files) {
      const sourceVersion = sourceVersionFor({ file, workspace, idFactory, now });
      const span = evidenceSpanFor({ file, sourceVersion, idFactory, now });
      sourceVersions.push(sourceVersion);
      evidence.push(span);
      sourceFiles.push({
        workspaceId: workspace.id,
        corpusId: workspace.corpusId,
        path: file.path,
        absolutePath: file.path,
        mediaType: file.mediaType,
        contentHash: String(sourceVersion.contentHash),
        byteLength: sourceVersion.byteLength,
        evidenceIds: [String(span.id)],
        metadata: toJsonValue({ ...(jsonRecord(file.metadata)), sourceVersionId: sourceVersion.sourceVersionId, evidenceSpanId: span.id })
      });
      const projection = typedIngest.project({
        sourceId: sourceVersion.sourceId,
        sourceVersionId: sourceVersion.sourceVersionId,
        uri: file.path,
        mediaType: file.mediaType,
        text: file.text,
        metadata: file.metadata ?? null,
        evidence: [span],
        observedAt: now
      });
      typedProjections.push(projection);
      graphNodes.push(...projection.graphNodes);
      graphEdges.push(...projection.graphEdges);
      if (!projection.observations.length) unsupportedRecords.push(toJsonValue({ path: file.path, reasonId: "runtime.ingest.no_typed_observations" }));
    }

    const analysis: WorkspaceCoreAnalysisInput = {
      schema: "scce.runtime.fixture_analysis.v1",
      rootPath,
      workspace,
      sources: sourceFiles,
      summary: input.analysis?.summary ?? { sourceRefs: sourceFiles.flatMap(source => sourceRefFromSource(source)), counts: { files: sourceFiles.length, evidence: evidence.length } },
      map: input.analysis?.map,
      symbols: input.analysis?.symbols ?? [],
      commands: input.analysis?.commands ?? [],
      routes: input.analysis?.routes ?? [],
      gaps: input.analysis?.gaps ?? [],
      contradictions: input.analysis?.contradictions ?? [],
      tasks: input.analysis?.tasks ?? [],
      reports: input.analysis?.reports
    };
    const graph = { nodes: dedupeById(graphNodes), edges: dedupeById(graphEdges) };
    const graphLearning = graphLearningReport({ graph, typedObservationCount: typedProjections.flatMap(item => item.observations).length, hasher, now });
    const result: ScceRuntimeIngestResult = {
      schema: "scce.runtime.fixture_ingest.v1",
      id,
      workspace,
      analysis,
      sourceVersions,
      evidence,
      typedProjections,
      graph,
      graphLearning,
      classificationCounts: countStrings(typedProjections.flatMap(item => item.observations.map(obs => obs.kind))),
      unsupportedRecords,
      audit: toJsonValue({
        source: "source-only-runtime.ingest",
        fixtureId: id,
        fileCount: input.files.length,
        evidenceIds: evidence.map(item => String(item.id)),
        observationCounts: typedProjections.map(item => item.observationCounts),
        graphLearningReportId: graphLearning.id
      })
    };
    state.ingests.set(id, result);
    return result;
  }

  function promoteWorkspace(input: { ingestId?: string; analysis?: WorkspaceCoreAnalysisInput }): WorkspaceCorePromotionResult {
    const ingest = input.ingestId ? state.ingests.get(input.ingestId) : latest(state.ingests);
    const analysis = input.analysis ?? ingest?.analysis;
    if (!analysis) throw new Error("source-only runtime promotion requires fixture analysis");
    const promotion = promoteWorkspaceAnalysisToCoreRecords(analysis);
    state.promotions.set(promotion.replayTraceId, promotion);
    state.promotions.set(promotion.workspaceId, promotion);
    return promotion;
  }

  async function simulateTurn(input: SourceOnlyTurnSimulationInput): Promise<SourceOnlyTurnSimulationResult> {
    const promotion = input.promotionId ? state.promotions.get(input.promotionId) : latest(state.promotions);
    if (!promotion) throw new Error("source-only turn simulation requires promoted workspace core records");
    const conversationId = input.conversationId ?? promotion.workspaceId;
    const previousDialogueState = input.dialogueState ?? state.dialogueStates.get(conversationId);
    const calibrationModels = calibrationModelSetFromRuntimeOutcomes([...state.outcomes.values()], clock.now());
    const answer = await answerFromWorkspaceCoreContext({
      promotion,
      question: input.text,
      options: {
        idFactory,
        hasher,
        createdAt: clock.now(),
        maxLength: input.maxLength,
        correctionRules: input.correctionRules,
        conversationId,
        targetLanguage: input.targetLanguage,
        dialogueState: previousDialogueState,
        dialogueFeedback: input.dialogueFeedback,
        userStyleProfile: input.userStyleProfile,
        calibrationModels
      }
    });
    const inputId = stableId(hasher, "runtime_input", { text: input.text, promotionId: promotion.replayTraceId });
    const traceId = stableId(hasher, "runtime_turn", { inputId, answer: answer.spoken.realizationTrace.selected.textHash });
    const trace = sourceOnlyTurnTrace({ id: traceId, inputId, promotion, answer, hasher });
    const result: SourceOnlyTurnSimulationResult = {
      schema: "scce.runtime.turn.v1",
      id: traceId,
      runtimeModeId: "runtime.mode.source_only_in_memory",
      simulation: true,
      hydratedRuntime: false,
      serverPath: false,
      answer: answer.spoken.text,
      workspace: answer,
      trace
    };
    state.turns.set(traceId, result);
    state.dialogueStates.set(answer.dialogueState.conversationId, answer.dialogueState);
    state.dialogueStates.set(answer.dialogueState.turnId, answer.dialogueState);
    return result;
  }

  function inspect(id: string): ScceRuntimeInspection {
    const ingest = state.ingests.get(id);
    if (ingest) return { schema: "scce.runtime.inspect.v1", id, kind: "fixture_ingest", value: ingest };
    const promotion = state.promotions.get(id);
    if (promotion) return { schema: "scce.runtime.inspect.v1", id, kind: "workspace_promotion", value: promotion };
    const turnResult = state.turns.get(id);
    if (turnResult) return { schema: "scce.runtime.inspect.v1", id, kind: "turn", value: turnResult.trace };
    const learning = state.learningSteps.get(id);
    if (learning) return { schema: "scce.runtime.inspect.v1", id, kind: "learning_step", value: learning };
    const patch = state.patches.get(id);
    if (patch) return { schema: "scce.runtime.inspect.v1", id, kind: "patch_plan", value: patch };
    const hydration = state.hydrationPlans.get(id);
    if (hydration) return { schema: "scce.runtime.inspect.v1", id, kind: "hydration_plan", value: hydration };
    const outcome = state.outcomes.get(id);
    if (outcome) return { schema: "scce.runtime.inspect.v1", id, kind: "outcome", value: outcome };
    const dialogueState = state.dialogueStates.get(id);
    if (dialogueState) return { schema: "scce.runtime.inspect.v1", id, kind: "dialogue_state", value: dialogueState };
    return { schema: "scce.runtime.inspect.v1", id, kind: "not_found", value: { id, knownIds: knownIds(state) } };
  }

  function planHydration(input: { turnId?: string; promotionId?: string; records?: SourceCompletionHydrationRecord[] } = {}): ScceRuntimeHydrationPlanResult {
    const promotion = input.promotionId ? state.promotions.get(input.promotionId) : latest(state.promotions);
    const turnResult = input.turnId ? state.turns.get(input.turnId) : latest(state.turns);
    const counts = runtimeCounts(state, promotion, turnResult);
    const contract = createSourceCompletionContract({ counts });
    const validation = validateSourceCompletionContract(contract);
    const dryRunPlan = planSourceCompletionHydration({ records: input.records ?? [], contract });
    const result: ScceRuntimeHydrationPlanResult = {
      schema: "scce.runtime.hydration_plan.v1",
      id: stableId(hasher, "runtime_hydration_plan", { contractId: contract.id, dryRunPlanId: dryRunPlan.id }),
      contract,
      validation,
      dryRunPlan,
      safeToHydrateLater: validation.valid && contract.valid && dryRunPlan.safeToHydrate,
      audit: toJsonValue({ counts, turnId: turnResult?.id ?? null, promotionId: promotion?.replayTraceId ?? null, dryRunPlanId: dryRunPlan.id })
    };
    state.hydrationPlans.set(result.id, result);
    return result;
  }

  function planPatch(input: { turnId?: string; programGraph?: ProgramGraph; stdout?: string; stderr?: string; requestText?: string }): ScceRuntimePatchPlanResult {
    const turnResult = input.turnId ? state.turns.get(input.turnId) : latest(state.turns);
    const programGraph = input.programGraph ?? turnResult?.workspace.program.programGraph;
    if (!programGraph) throw new Error("scce.runtime.planPatch requires a ProgramGraph");
    const repair = createProgramRepairKernel({ hasher });
    const rawRepairPlan = repair.plan({ program: programGraph, stdout: input.stdout, stderr: input.stderr, requestText: input.requestText });
    const promotion = turnResult?.trace.promotionId ? state.promotions.get(turnResult.trace.promotionId) : undefined;
    const repairPlan = observedValidationRepairPlan(rawRepairPlan, promotion);
    const virtualPatch = repairPlan.selectedPatchSet ? repair.applyVirtual({ files: programGraph.files, patchSet: repairPlan.selectedPatchSet }) : undefined;
    const workspaceAffectedFiles = uniqueStrings(turnResult?.workspace.program.patchPlans.flatMap(plan => plan.affectedFiles) ?? []);
    const result: ScceRuntimePatchPlanResult = {
      schema: "scce.runtime.patch_plan.v1",
      id: stableId(hasher, "runtime_patch", { programGraphId: programGraph.id, repairPlan: repairPlan.id }),
      turnId: turnResult?.id,
      programGraphId: programGraph.id,
      workspaceAffectedFiles,
      repairPlan,
      virtualPatch: virtualPatch ? { changed: virtualPatch.changed, audit: virtualPatch.audit } : undefined,
      safeToApplyInTemp: Boolean(repairPlan.selectedPatchSet && !repairPlan.selectedPatchSet.approvalRequired && repairPlan.selectedPatchSet.affectedFiles.every(safeRelativePath)),
      audit: toJsonValue({
        source: "source-only-runtime.planPatch",
        programGraphId: programGraph.id,
        workspaceAffectedFiles,
        selectedPatchSetId: repairPlan.selectedPatchSet?.id ?? null,
        affectedFiles: repairPlan.selectedPatchSet?.affectedFiles ?? [],
        validationPlan: repairPlan.validationPlan
      })
    };
    state.patches.set(result.id, result);
    return result;
  }

  function runLearningStep(input: { turnId?: string; fixtures?: SyntheticToolFixtures; toolCapabilities?: ToolCapability[]; maxPlansToRun?: number; now?: number }): ScceRuntimeLearningStepResult {
    const turnResult = input.turnId ? state.turns.get(input.turnId) : latest(state.turns);
    if (!turnResult) throw new Error("scce.runtime.runLearningStep requires a prior turn");
    const answer = turnResult.workspace;
    const learning = runLearningLoop({
      construct: answer.mouthInput.speakInput.construct,
      field: answer.mouthInput.speakInput.field,
      proofResults: answer.proof.results.map(item => item.result),
      entailments: [answer.entailment],
      proofClaims: answer.proof.claims,
      proofEvidence: answer.proof.evidence,
      evidence: answer.mouthInput.speakInput.evidence,
      graph: { nodes: answer.graph.nodes, edges: answer.graph.edges, hyperedges: [] },
      toolCapabilities: input.toolCapabilities ?? defaultSyntheticToolCapabilities(),
      fixtures: input.fixtures,
      maxPlansToRun: input.maxPlansToRun,
      now: input.now ?? clock.now()
    });
    const result: ScceRuntimeLearningStepResult = {
      schema: "scce.runtime.learning_step.v1",
      id: stableId(hasher, "runtime_learning_step", { turnId: turnResult.id, learning: learning.id }),
      turnId: turnResult.id,
      learning,
      toolUseResultIds: learning.acquisitionResults.map(item => item.id),
      updatePlanIds: learning.updatePlans.map(item => item.id),
      validated: learning.validationResults.every(item => item.rejectionReasons.length === 0),
      audit: toJsonValue({
        source: "source-only-runtime.runLearningStep",
        turnId: turnResult.id,
        gaps: learning.gaps.map(item => item.id),
        acquisitions: learning.acquisitionResults.map(item => item.id),
        updates: learning.updatePlans.map(item => item.id)
      })
    };
    state.learningSteps.set(result.id, result);
    const firstToolResultId = result.toolUseResultIds[0];
    if (turnResult && firstToolResultId) {
      turnResult.trace.toolUseResultId = firstToolResultId;
      turnResult.trace.validation = validateSourceOnlyTurnTrace(turnResult.trace);
    }
    return result;
  }

  function recordOutcome(input: ScceRuntimeOutcomeInput): ScceRuntimeOutcomeResult {
    const patch = input.patchPlanId ? state.patches.get(input.patchPlanId) : undefined;
    const turn = input.turnId ? state.turns.get(input.turnId) : (!patch ? latest(state.turns) : undefined);
    const target = patch
      ? { kind: "patch_plan" as const, id: patch.id }
      : { kind: "turn" as const, id: turn?.id ?? "" };
    if (!target.id) throw new Error("scce.runtime.recordOutcome requires an existing turn or patch plan");
    const successScore = outcomeSuccessScore(input);
    const calibrationPoints = outcomeCalibrationPoints({ input, patch, turn, successScore });
    const calibrationModel = calibrationModelFromRuntimeOutcomes([...state.outcomes.values()], calibrationPoints, input.now ?? clock.now());
    const patchRankSignal = patch ? patchOutcomeSignal(patch, successScore) : undefined;
    const dialogueTurn = turn ?? (patch?.turnId ? state.turns.get(patch.turnId) : undefined);
    const outcomeDialogueState = dialogueStateFromOutcome(input, dialogueTurn);
    const result: ScceRuntimeOutcomeResult = {
      schema: "scce.runtime.outcome_record.v1",
      id: stableId(hasher, "runtime_outcome", { target, status: input.status, tests: input.tests ?? null, feedbackTextHash: input.feedbackText ? hashText(hasher, input.feedbackText) : null, now: input.now ?? clock.now() }),
      target,
      status: input.status,
      successScore,
      calibrationPoints,
      calibrationModel,
      patchRankSignal,
      correctionRuleIds: (input.correctionRules ?? []).map(rule => rule.id),
      reversible: true,
      audit: toJsonValue({
        source: "source-only-runtime.recordOutcome",
        target,
        status: input.status,
        tests: input.tests ?? null,
        feedbackTextHash: input.feedbackText ? hashText(hasher, input.feedbackText) : null,
        calibrationPointCount: calibrationPoints.length,
        calibrationModelId: calibrationModel?.id ?? null,
        patchRankSignal: patchRankSignal ?? null,
        dialogueStateId: outcomeDialogueState?.turnId ?? null,
        reversible: true
      })
    };
    state.outcomes.set(result.id, result);
    if (outcomeDialogueState) {
      state.dialogueStates.set(outcomeDialogueState.conversationId, outcomeDialogueState);
      state.dialogueStates.set(outcomeDialogueState.turnId, outcomeDialogueState);
    }
    return result;
  }

  return {
    ingest: ingestFixture,
    ingestFixture,
    promote: promoteWorkspace,
    promoteWorkspace,
    simulateTurn,
    runSourceOnlyTurn: simulateTurn,
    turn: simulateTurn,
    inspect,
    inspectSourceOnlyTurn: inspect,
    planHydration,
    planPatch,
    runLearningStep,
    recordOutcome
  };
}

export function createScceRuntime(options: { idFactory?: IdFactory; hasher?: Hasher; now?: () => number } = {}): InMemoryScceRuntime {
  return createInMemoryScceRuntime(options);
}

function validateSourceOnlyTurnTrace(trace: SourceOnlyTurnSimulationTrace): { valid: boolean; diagnostics: string[] } {
  const diagnostics: string[] = [];
  const required: Array<[string, unknown]> = [
    ["inputId", trace.inputId],
    ["constructId", trace.constructId],
    ["proofVerdictId", trace.proofVerdictId],
    ["runtimeModeId", trace.runtimeModeId],
    ["walshSurfaceEnergySelectedCandidateId", trace.walshSurfaceEnergySelectedCandidateId],
    ["mouthTraceId", trace.mouthTraceId],
    ["dialogueStateId", trace.dialogueStateId],
    ["dialoguePolicyDecisionId", trace.dialoguePolicyDecisionId],
    ["pragmaticsCriticId", trace.pragmaticsCriticId],
    ["answerTextHash", trace.answerTextHash]
  ];
  for (const [fieldId, value] of required) if (!value) diagnostics.push(`runtime.trace.missing:${fieldId}`);
  if (trace.simulation !== true || trace.hydratedRuntime !== false || trace.serverPath !== false) diagnostics.push("runtime.trace.source_only_mode_missing");
  if (!trace.evidenceIds.length) diagnostics.push("runtime.trace.evidence_ids_missing");
  if (!trace.sourceRefs.length) diagnostics.push("runtime.trace.source_refs_missing");
  if (!trace.scoreTraces.length) diagnostics.push("runtime.trace.score_traces_missing");
  if (!trace.calibrationStatus) diagnostics.push("runtime.trace.calibration_status_missing");
  if (!trace.truthState) diagnostics.push("runtime.trace.truth_state_missing");
  if (!trace.evidenceForce) diagnostics.push("runtime.trace.evidence_force_missing");
  if (!trace.guardFlags) diagnostics.push("runtime.trace.guard_flags_missing");
  if (trace.calibration?.calibrationStatus !== trace.calibrationStatus) diagnostics.push("runtime.trace.calibration_status_mismatch");
  if (trace.graphAlphaPpfSummary && !trace.graphAlphaPpfSummaryId) diagnostics.push("runtime.trace.ppf_summary_id_missing");
  if (trace.graphAlphaPpfSummary && !trace.graphAlphaPpfSummary.ppfTopNodeIds.length && trace.graphAlphaPpfSummary.nodeCount > 0) diagnostics.push("runtime.trace.ppf_summary_missing");
  return { valid: diagnostics.length === 0, diagnostics };
}

export function validateScceRuntimeTurnTrace(trace: SourceOnlyTurnSimulationTrace): { valid: boolean; diagnostics: string[] } {
  return validateSourceOnlyTurnTrace(trace);
}

function observedValidationRepairPlan(plan: RepairPlan, promotion: WorkspaceCorePromotionResult | undefined): RepairPlan {
  const commands = promotion?.records.commands ?? [];
  if (!commands.length) return plan;
  const observed = commands.map(record => ({ record, command: commandFromText(record.command.command), kind: record.command.kind }));
  const observedBuild = observed.find(item => item.kind === "eng.command.build")?.command;
  const observedTest = observed.find(item => item.kind === "eng.command.validation")?.command;
  if (!observedBuild && !observedTest) return plan;
  let buildUsed = false;
  let testUsed = false;
  const validationPlan = plan.validationPlan.map((item, index) => {
    if (item.commandSource !== "program.validation.command.source_derived") return item;
    const selected = !buildUsed && observedBuild ? observedBuild : !testUsed && observedTest ? observedTest : observedBuild ?? observedTest;
    if (!selected) return item;
    if (selected === observedBuild) buildUsed = true;
    if (selected === observedTest) testUsed = true;
    return {
      ...item,
      id: `${item.id}.observed.${index}`,
      command: selected,
      commandSource: "program.validation.command.observed"
    };
  });
  return {
    ...plan,
    validationPlan,
    buildCommand: observedBuild ?? plan.buildCommand,
    testCommand: observedTest ?? plan.testCommand,
    audit: toJsonValue({ ...jsonRecord(plan.audit), validationPlan, observedCommandRecordIds: commands.map(record => record.id) })
  };
}

function commandFromText(text: string): ProgramGraph["build"] {
  const parts = splitCommandText(text);
  return { command: parts[0] ?? text, args: parts.slice(1), cwd: "." };
}

function splitCommandText(text: string): string[] {
  const out: string[] = [];
  let current = "";
  let quote = "";
  for (const ch of text.trim()) {
    if ((ch === "\"" || ch === "'") && !quote) {
      quote = ch;
      continue;
    }
    if (quote && ch === quote) {
      quote = "";
      continue;
    }
    if (!quote && ch.trim() === "") {
      if (current) {
        out.push(current);
        current = "";
      }
      continue;
    }
    current += ch;
  }
  if (current) out.push(current);
  return out;
}

function sourceVersionFor(input: { file: ScceRuntimeFixtureFile; workspace: WorkspaceCoreWorkspaceRef; idFactory: IdFactory; now: number }): SourceVersion {
  const bytes = new TextEncoder().encode(input.file.text);
  const contentHash = input.idFactory.contentHash(bytes);
  const sourceId = input.idFactory.sourceId(input.workspace.corpusId, input.file.path);
  return {
    sourceId,
    sourceVersionId: input.idFactory.sourceVersionId(bytes),
    namespace: input.workspace.corpusId,
    canonicalUri: input.file.path,
    contentHash,
    mediaType: input.file.mediaType,
    observedAt: input.now,
    byteLength: bytes.byteLength,
    trust: 0.9,
    metadata: toJsonValue({ ...(jsonRecord(input.file.metadata)), workspaceId: input.workspace.id })
  };
}

function evidenceSpanFor(input: { file: ScceRuntimeFixtureFile; sourceVersion: SourceVersion; idFactory: IdFactory; now: number }): EvidenceSpan {
  const bytes = new TextEncoder().encode(input.file.text);
  const contentHash = input.idFactory.contentHash(bytes);
  return {
    id: input.idFactory.evidenceId({ sourceVersionId: input.sourceVersion.sourceVersionId, byteStart: 0, byteEnd: bytes.byteLength, spanHash: contentHash }),
    sourceId: input.sourceVersion.sourceId,
    sourceVersionId: input.sourceVersion.sourceVersionId,
    chunkId: input.idFactory.chunkId({ sourceVersionId: input.sourceVersion.sourceVersionId, byteStart: 0, byteEnd: bytes.byteLength, chunkHash: contentHash }),
    contentHash,
    mediaType: input.file.mediaType,
    byteStart: 0,
    byteEnd: bytes.byteLength,
    charStart: 0,
    charEnd: input.file.text.length,
    text: input.file.text,
    textPreview: input.file.text.slice(0, 320),
    languageHints: {},
    scriptHints: {},
    trustVector: toJsonValue({ trust: 0.9, forceClass: "direct_evidence" }),
    provenance: toJsonValue({ uri: input.file.path, metadata: input.file.metadata ?? null }),
    features: featureSet(input.file.text, 512),
    status: "promoted",
    alpha: 0.9,
    observedAt: input.now
  };
}

function scoreTracesFromSpokenOutput(answer: WorkspaceKernelAnswerResult): ScoreTrace[] {
  const walsh = jsonRecord(answer.spoken.realizationTrace.walshSurfaceEnergy);
  const traces = [
    ...scoreTraceArray(walsh.selectedScoreTrace),
    ...scoreTraceArray(walsh.emittedScoreTrace),
    ...jsonArray(walsh.ranked).flatMap(row => scoreTraceArray(jsonRecord(row).scoreTrace))
  ];
  const out = new Map<string, ScoreTrace>();
  for (const trace of traces) out.set(trace.id, trace);
  return [...out.values()];
}

function scoreTraceArray(value: JsonValue | undefined): ScoreTrace[] {
  return jsonArray(value)
    .map(scoreTraceFromJson)
    .filter((trace): trace is ScoreTrace => Boolean(trace));
}

function scoreTraceFromJson(value: JsonValue | undefined): ScoreTrace | undefined {
  const record = jsonRecord(value);
  const range = jsonArray(record.range);
  if (
    typeof record.id !== "string" ||
    !runtimeScoreKind(record.kind) ||
    typeof record.value !== "number" ||
    range.length !== 2 ||
    typeof range[0] !== "number" ||
    typeof range[1] !== "number" ||
    typeof record.meaning !== "string" ||
    typeof record.calibrated !== "boolean"
  ) return undefined;
  const inputs = jsonStringArray(record.inputs);
  const provenance = jsonStringArray(record.provenance);
  const failureModes = jsonStringArray(record.failureModes);
  return {
    id: record.id,
    kind: record.kind,
    value: record.value,
    range: [range[0], range[1]],
    meaning: record.meaning,
    inputs,
    provenance,
    calibrated: record.calibrated,
    calibrationId: typeof record.calibrationId === "string" ? record.calibrationId : undefined,
    failureModes
  };
}

function graphLearningReport(input: { graph: { nodes: GraphNode[]; edges: GraphEdge[] }; typedObservationCount: number; hasher: Hasher; now: number }): RuntimeGraphLearningReport {
  const { nodes, edges } = input.graph;
  const featureIds = ["bias", "source_alpha", "target_alpha", "feature_overlap", "same_type", "relation_prior", "source_out_degree", "target_in_degree", "evidence_bound"];
  const relationIds = uniqueStrings(edges.map(edge => String(edge.relationId)));
  const emptyModel = { schema: "scce.runtime.graph_link_model.v1" as const, featureIds, weights: featureIds.map(() => 0), relationIds, createdAt: input.now };
  if (nodes.length < 2 || edges.length < 2) {
    return {
      schema: "scce.runtime.graph_learning_report.v2",
      id: stableId(input.hasher, "graph_learning", { nodes: nodes.length, edges: edges.length, typedObservationCount: input.typedObservationCount }),
      trainingStatus: "insufficient_graph",
      model: emptyModel,
      linkPrediction: { positiveEdgeCount: edges.length, negativeEdgeCount: 0, heldOutCount: 0, learnedAuc: 0.5, lexicalBaselineAuc: 0.5, learnedAucAboveLexicalBaseline: false },
      evidenceConstructAlignment: { evidenceLinkedEdgeCount: edges.filter(edge => edge.evidenceIds.length).length, typedObservationCount: input.typedObservationCount, sourceBoundRatio: edges.length ? edges.filter(edge => edge.evidenceIds.length).length / edges.length : 0 },
      temporalPrediction: { temporallyScopedEdgeCount: edges.filter(edge => edge.temporalScope.validFrom > 0 || edge.temporalScope.validTo !== undefined).length, freshEdgeRatio: 0 },
      trace: toJsonValue({ source: "source-only-runtime.graph_learning", status: "insufficient_graph" })
    };
  }
  const positives = edges.map(edge => ({ edge, label: true }));
  const negatives = negativeEdgeSamples(nodes, edges).map(edge => ({ edge, label: false }));
  const samples = [...positives, ...negatives];
  const split = Math.max(1, Math.floor(samples.length * 0.75));
  const train = samples.slice(0, split);
  const heldOut = samples.slice(split);
  const weights = trainGraphLinkWeights(train, nodes, edges, featureIds.length);
  const learnedScores = heldOut.map(sample => ({ label: sample.label, score: sigmoid(dot(weights, graphLinkFeatures(sample.edge, nodes, edges))) }));
  const baselineScores = heldOut.map(sample => ({ label: sample.label, score: lexicalGraphBaseline(sample.edge, nodes) }));
  const learnedAuc = auc(learnedScores);
  const lexicalBaselineAuc = auc(baselineScores);
  const evidenceLinkedEdgeCount = edges.filter(edge => edge.evidenceIds.length).length;
  const freshEdges = edges.filter(edge => Math.max(0, input.now - edge.updatedAt) <= 1000 * 60 * 60 * 24 * 180).length;
  return {
    schema: "scce.runtime.graph_learning_report.v2",
    id: stableId(input.hasher, "graph_learning", { nodes: nodes.map(node => String(node.id)), edges: edges.map(edge => String(edge.id)), weights }),
    trainingStatus: "trained_cpu_local",
    model: { ...emptyModel, weights: weights.map(value => Number(value.toFixed(6))) },
    linkPrediction: {
      positiveEdgeCount: positives.length,
      negativeEdgeCount: negatives.length,
      heldOutCount: heldOut.length,
      learnedAuc,
      lexicalBaselineAuc,
      learnedAucAboveLexicalBaseline: learnedAuc > lexicalBaselineAuc
    },
    evidenceConstructAlignment: {
      evidenceLinkedEdgeCount,
      typedObservationCount: input.typedObservationCount,
      sourceBoundRatio: clamp01(evidenceLinkedEdgeCount / Math.max(1, edges.length))
    },
    temporalPrediction: {
      temporallyScopedEdgeCount: edges.filter(edge => edge.temporalScope.validFrom > 0 || edge.temporalScope.validTo !== undefined).length,
      freshEdgeRatio: clamp01(freshEdges / Math.max(1, edges.length))
    },
    trace: toJsonValue({
      source: "source-only-runtime.graph_learning",
      objectiveIds: ["L_link", "L_align", "L_temporal"],
      status: "trained_cpu_local",
      featureIds,
      relationIds,
      heldOutCount: heldOut.length
    })
  };
}

function negativeEdgeSamples(nodes: readonly GraphNode[], edges: readonly GraphEdge[]): GraphEdge[] {
  const existing = new Set(edges.map(edge => `${edge.source}\u001f${edge.relationId}\u001f${edge.target}`));
  return edges.map((edge, index) => {
    const target = firstNegativeTarget(nodes, edge, existing, index);
    return { ...edge, id: `${String(edge.id)}:negative:${index}` as never, target };
  }).filter(edge => !existing.has(`${edge.source}\u001f${edge.relationId}\u001f${edge.target}`));
}

function firstNegativeTarget(nodes: readonly GraphNode[], edge: GraphEdge, existing: ReadonlySet<string>, salt: number): NodeId {
  for (let offset = 1; offset <= nodes.length; offset++) {
    const candidate = nodes[(salt + offset) % nodes.length]?.id;
    if (candidate && candidate !== edge.target && !existing.has(`${edge.source}\u001f${edge.relationId}\u001f${candidate}`)) return candidate;
  }
  return nodes.find(node => node.id !== edge.target)?.id ?? edge.target;
}

function trainGraphLinkWeights(samples: ReadonlyArray<{ edge: GraphEdge; label: boolean }>, nodes: readonly GraphNode[], edges: readonly GraphEdge[], featureCount: number): number[] {
  const weights = Array.from({ length: featureCount }, () => 0);
  for (let epoch = 0; epoch < 24; epoch++) {
    const rate = 0.28 / (1 + epoch * 0.08);
    for (const sample of samples) {
      const features = graphLinkFeatures(sample.edge, nodes, edges);
      const prediction = sigmoid(dot(weights, features));
      const error = (sample.label ? 1 : 0) - prediction;
      for (let i = 0; i < weights.length; i++) weights[i] = (weights[i] ?? 0) + rate * error * (features[i] ?? 0);
    }
  }
  return weights;
}

function graphLinkFeatures(edge: GraphEdge, nodes: readonly GraphNode[], edges: readonly GraphEdge[]): number[] {
  const byId = new Map(nodes.map(node => [node.id, node]));
  const source = byId.get(edge.source);
  const target = byId.get(edge.target);
  const relationCount = edges.filter(item => item.relationId === edge.relationId).length;
  const sourceOutDegree = edges.filter(item => item.source === edge.source).length;
  const targetInDegree = edges.filter(item => item.target === edge.target).length;
  return [
    1,
    clamp01(source?.alpha ?? 0),
    clamp01(target?.alpha ?? 0),
    source && target ? weightedJaccard(source.features, target.features) : 0,
    source && target && source.typeId === target.typeId ? 1 : 0,
    clamp01(relationCount / Math.max(1, edges.length)),
    clamp01(sourceOutDegree / Math.max(1, nodes.length)),
    clamp01(targetInDegree / Math.max(1, nodes.length)),
    edge.evidenceIds.length ? 1 : 0
  ];
}

function lexicalGraphBaseline(edge: GraphEdge, nodes: readonly GraphNode[]): number {
  const byId = new Map(nodes.map(node => [node.id, node]));
  const source = byId.get(edge.source);
  const target = byId.get(edge.target);
  return source && target ? weightedJaccard(source.features, target.features) : 0;
}

function auc(scores: ReadonlyArray<{ label: boolean; score: number }>): number {
  const positives = scores.filter(item => item.label);
  const negatives = scores.filter(item => !item.label);
  if (!positives.length || !negatives.length) return 0.5;
  let concordantMass = 0;
  for (const positive of positives) {
    for (const negative of negatives) {
      if (positive.score > negative.score) concordantMass += 1;
      else if (positive.score === negative.score) concordantMass += 0.5;
    }
  }
  return clamp01(concordantMass / Math.max(1, positives.length * negatives.length));
}

function sigmoid(value: number): number {
  return 1 / (1 + Math.exp(-Math.max(-32, Math.min(32, value))));
}

function dot(left: readonly number[], right: readonly number[]): number {
  const n = Math.max(left.length, right.length);
  let out = 0;
  for (let i = 0; i < n; i++) out += (left[i] ?? 0) * (right[i] ?? 0);
  return out;
}

function sourceOnlyTurnTrace(input: { id: string; inputId: string; promotion: WorkspaceCorePromotionResult; answer: WorkspaceKernelAnswerResult; hasher: Hasher }): SourceOnlyTurnSimulationTrace {
  const graph = input.answer.graph;
  const proofVerdictId = input.answer.proof.results[0]?.result.verdict ?? input.answer.entailment.verdict;
  const selectedCandidateId = input.answer.spoken.realizationTrace.selected.id;
  const graphAlphaPpfSummary = {
    id: stableId(input.hasher, "graph_alpha_ppf_summary", { graph: graph.audit, ppfTopNodeIds: graph.ppfTopNodeIds }),
    nodeCount: graph.nodes.length,
    edgeCount: graph.edges.length,
    seedCount: graph.field?.seeds.length ?? 0,
    activeCount: graph.field?.active.length ?? 0,
    ppfTopNodeIds: graph.ppfTopNodeIds
  };
  const scoreTraces = scoreTracesFromSpokenOutput(input.answer);
  const launch = launchContractForTurn({
    entailment: input.answer.entailment,
    evidence: input.answer.mouthInput.speakInput.evidence,
    scoreTraces,
    preservationChecked: Boolean(input.answer.spoken.realizationTrace.preservation),
    unsupportedContentBlocked: input.answer.mouthInput.unsupported || input.answer.statusId === "workspace.kernel.answer.unsupported",
    now: input.answer.mouthInput.speakInput.evidence.reduce((max, span) => Math.max(max, span.observedAt), 0) || Date.now()
  });
  const trace: SourceOnlyTurnSimulationTrace = {
    schema: "scce.runtime.turn_trace.v1",
    id: input.id,
    turnId: input.id,
    inputId: input.inputId,
    runtimeModeId: "runtime.mode.source_only_in_memory",
    simulation: true,
    hydratedRuntime: false,
    serverPath: false,
    promotionId: input.promotion.replayTraceId,
    constructId: String(input.answer.mouthInput.speakInput.construct.id),
    evidenceIds: input.answer.mouthInput.speakInput.evidence.map(item => String(item.id)),
    proofVerdictId,
    graphAlphaPpfSummaryId: graphAlphaPpfSummary.id,
    graphAlphaPpfSummary,
    learningGapIds: input.answer.learning.gaps.map(item => item.id),
    learningNeedIds: input.answer.learning.needs.map(item => item.id),
    programGraphId: input.answer.program.programGraph?.id,
    walshSurfaceEnergySelectedCandidateId: selectedCandidateId,
    mouthTraceId: stableId(input.hasher, "mouth_trace", { selectedCandidateId, planHash: input.answer.spoken.realizationTrace.planHash }),
    dialogueStateId: input.answer.dialogueState.turnId,
    dialoguePolicyDecisionId: input.answer.dialoguePolicyDecision.id,
    pragmaticsCriticId: input.answer.pragmatics.selected.criticId,
    sourceRefs: input.promotion.mouthContext.sourceRefs,
    warnings: [
      ...(input.answer.statusId === "workspace.kernel.answer.unsupported" ? ["runtime.turn.unsupported_workspace_coupling"] : []),
      ...input.answer.proof.sourceBoundFailures.map(item => item.reasonId)
    ],
    unsupportedRecords: input.promotion.contract.rejectedRecords.map(item => toJsonValue(item)),
    answerTextHash: hashText(input.hasher, input.answer.spoken.text),
    scoreTraces: launch.scoreTraces,
    calibrationStatus: launch.calibrationStatus,
    calibration: launch.calibration,
    truthState: launch.truthState,
    evidenceForce: launch.evidenceForce,
    guardFlags: launch.guardFlags,
    validation: { valid: true, diagnostics: [] }
  };
  return { ...trace, validation: validateSourceOnlyTurnTrace(trace) };
}

function runtimeCounts(state: RuntimeState, promotion: WorkspaceCorePromotionResult | undefined, turnResult: SourceOnlyTurnSimulationResult | undefined): SourceCompletionRuntimeCounts {
  const latestIngest = latest(state.ingests);
  const learningRecords = [...state.learningSteps.values()].reduce((sum, item) => sum + item.learning.hydration.records.length, 0);
  const programArtifactRecords = turnResult?.workspace.program.programGraph?.hydration
    ? turnResult.workspace.program.programGraph.hydration.files.length + turnResult.workspace.program.programGraph.hydration.emissions.length
    : 0;
  return {
    scce2ImportRecords: 0,
    sourceVersions: latestIngest?.sourceVersions.length ?? 0,
    evidenceSpans: latestIngest?.evidence.length ?? promotion?.mouthContext.evidence.length ?? 0,
    graphNodes: (latestIngest?.graph.nodes.length ?? 0) + (promotion?.graph.nodes.length ?? 0),
    graphEdges: (latestIngest?.graph.edges.length ?? 0) + (promotion?.graph.edges.length ?? 0),
    graphHyperedges: 0,
    graphLearningReports: latestIngest?.graphLearning ? 1 : 0,
    languageMemoryRecords: 0,
    typedObservations: latestIngest?.typedProjections.reduce((sum, item) => sum + item.observations.length, 0) ?? 0,
    workspaceCoreRecords: promotion ? Object.values(promotion.records).reduce((sum, records) => sum + records.length, 0) : 0,
    proofTraces: turnResult?.workspace.proof.results.length ?? 0,
    mouthTraces: turnResult ? 1 : 0,
    walshSurfaceEnergyTraces: turnResult ? 1 : 0,
    learningLoopRecords: learningRecords,
    programArtifactRecords,
    developerIntelligenceRecords: promotion?.records.symbols.length ?? 0,
    runtimeTurnTraces: state.turns.size,
    runtimeOutcomeRecords: state.outcomes.size,
    dialogueStateRecords: state.dialogueStates.size
  };
}

function dialogueStateFromOutcome(input: ScceRuntimeOutcomeInput, turn: SourceOnlyTurnSimulationResult | undefined): DialogueState | undefined {
  if (!turn) return undefined;
  const feedback = dialogueFeedbackFromOutcome(input);
  if (!feedback) return undefined;
  return updateDialogueState({
    conversationId: turn.workspace.dialogueState.conversationId,
    turnId: `${turn.workspace.dialogueState.turnId}.outcome.${hashText(createHasher(), canonicalStringify({ status: input.status, feedbackText: input.feedbackText ?? "", tests: input.tests ?? null })).slice(0, 12)}`,
    requestText: turn.answer,
    previousState: turn.workspace.dialogueState,
    answerGraph: turn.workspace.answerGraph,
    feedback
  });
}

function dialogueFeedbackFromOutcome(input: ScceRuntimeOutcomeInput): DialogueFeedback | undefined {
  if (!input.feedbackText && !input.correctionRules?.length && !input.tests) return undefined;
  const status: DialogueFeedback["status"] =
    input.status === "accepted" || input.status === "succeeded" ? "accepted" :
      input.status === "corrected" ? "corrected" :
        input.status === "rejected" || input.status === "failed" || input.status === "rolled_back" ? "rejected" : undefined;
  return {
    status,
    feedbackText: input.feedbackText,
    rejectedPhrases: input.correctionRules?.flatMap(rule => [rule.pattern, rule.replacement].filter((value): value is string => Boolean(value))) ?? [],
    styleDelta: input.status === "corrected" || input.status === "rejected" || input.status === "failed"
      ? {
        [INTERACTION_FEATURE_IDS.responseLead]: 0.04,
        [INTERACTION_FEATURE_IDS.hedgeAversion]: 0.04,
        [INTERACTION_FEATURE_IDS.caveatTolerance]: -0.02
      }
      : input.status === "accepted" || input.status === "succeeded"
        ? { [INTERACTION_FEATURE_IDS.responseLead]: 0.02 }
        : undefined
  };
}

function outcomeSuccessScore(input: ScceRuntimeOutcomeInput): number {
  if (input.tests) {
    const total = Math.max(1, input.tests.total ?? ((input.tests.failed ?? 0) + (input.tests.passed ? 1 : 0)));
    const failed = Math.max(0, input.tests.failed ?? (input.tests.passed ? 0 : 1));
    return clamp01(input.tests.passed ? 1 - failed / total : 0.15 * (1 - failed / total));
  }
  if (input.status === "accepted" || input.status === "succeeded") return 1;
  if (input.status === "corrected") return 0.62;
  if (input.status === "rolled_back") return 0.35;
  return 0;
}

function outcomeCalibrationPoints(input: {
  input: ScceRuntimeOutcomeInput;
  patch?: ScceRuntimePatchPlanResult;
  turn?: SourceOnlyTurnSimulationResult;
  successScore: number;
}): ScceRuntimeOutcomeResult["calibrationPoints"] {
  const outcome = input.successScore >= 0.5;
  if (input.patch?.repairPlan.selectedPatchSet) {
    return [{
      taskClass: "runtime.patch_plan",
      raw: clamp01(input.patch.repairPlan.selectedPatchSet.confidence),
      outcome,
      sourceTraceId: input.patch.repairPlan.selectedPatchSet.id
    }];
  }
  const turnScore = input.turn?.trace.calibration?.rawScore;
  if (typeof turnScore === "number") {
    return [{
      taskClass: "runtime.turn.answer",
      raw: clamp01(turnScore),
      outcome,
      sourceTraceId: input.turn?.trace.id
    }];
  }
  return [];
}

function calibrationModelFromRuntimeOutcomes(existing: readonly ScceRuntimeOutcomeResult[], current: readonly ScceRuntimeOutcomeResult["calibrationPoints"][number][], now: number): CalibrationModel | undefined {
  const byTask = new Map<string, CalibrationPoint[]>();
  for (const point of [...existing.flatMap(item => item.calibrationPoints), ...current]) {
    byTask.set(point.taskClass, [...(byTask.get(point.taskClass) ?? []), { raw: point.raw, outcome: point.outcome }]);
  }
  const selected = [...byTask.entries()].sort((left, right) => right[1].length - left[1].length || left[0].localeCompare(right[0]))[0];
  if (!selected || selected[1].length < 2) return undefined;
  return buildCalibrationModel({
    id: `cal.runtime.${selected[0]}.${selected[1].length}`,
    taskClass: selected[0],
    points: selected[1],
    binCount: Math.min(10, Math.max(2, selected[1].length)),
    createdAt: now
  });
}

function calibrationModelSetFromRuntimeOutcomes(outcomes: readonly ScceRuntimeOutcomeResult[], now: number): CalibrationModelSet {
  const observations = outcomes.flatMap(outcome => outcome.calibrationPoints.flatMap(point => runtimeCalibrationObservationsFromPoint(outcome, point, now)));
  return buildCalibrationModelSet({ observations, minPoints: 2, createdAt: now });
}

function runtimeCalibrationObservationsFromPoint(
  outcome: ScceRuntimeOutcomeResult,
  point: ScceRuntimeOutcomeResult["calibrationPoints"][number],
  now: number
) {
  const taskClass = point.taskClass === "runtime.patch_plan"
    ? CALIBRATION_TASK_CLASS_IDS.codeAnswer
    : CALIBRATION_TASK_CLASS_IDS.workspaceAnswer;
  const targets = point.taskClass === "runtime.patch_plan"
    ? [
        { calibrationId: CALIBRATION_IDS.codeRoleConfidence, subsystemId: CALIBRATION_SUBSYSTEM_IDS.code },
        { calibrationId: CALIBRATION_IDS.candidateMass, subsystemId: CALIBRATION_SUBSYSTEM_IDS.candidate }
      ]
    : [
        { calibrationId: CALIBRATION_IDS.workspaceAnswerConfidence, subsystemId: CALIBRATION_SUBSYSTEM_IDS.workspace },
        { calibrationId: CALIBRATION_IDS.dialoguePragmaticsScore, subsystemId: CALIBRATION_SUBSYSTEM_IDS.dialogue },
        { calibrationId: CALIBRATION_IDS.mouthSurfaceFit, subsystemId: CALIBRATION_SUBSYSTEM_IDS.mouth }
      ];
  return targets.map(target => calibrationObservationRecord({
    calibrationId: target.calibrationId,
    subsystemId: target.subsystemId,
    taskClass,
    rawScore: point.raw,
    outcome: point.outcome,
    finalOutcome: point.outcome ? "outcome.succeeded" : "outcome.failed",
    sourceTraceId: point.sourceTraceId,
    sourceRecordId: outcome.id,
    metadata: toJsonValue({ source: "source-only-runtime.outcome", outcomeId: outcome.id, status: outcome.status, target: outcome.target }),
    createdAt: now,
    idSeed: `${outcome.id}:${point.taskClass}:${target.calibrationId}:${point.raw}:${point.outcome}`
  }));
}

function patchOutcomeSignal(patch: ScceRuntimePatchPlanResult, successScore: number): ScceRuntimeOutcomeResult["patchRankSignal"] {
  const patchSet = patch.repairPlan.selectedPatchSet;
  const previousScore = clamp01(patchSet?.confidence ?? 0);
  const adjustment = successScore >= 0.5 ? 0.14 * successScore : -0.24 * (1 - successScore);
  return {
    patchSetId: patchSet?.id,
    previousScore,
    adjustedScore: clamp01(previousScore + adjustment),
    regressionRiskDelta: successScore >= 0.5 ? -0.08 * successScore : 0.22 * (1 - successScore),
    lossKind: "patch-rank"
  };
}

function sourceRefFromSource(source: WorkspaceCoreSourceFileInput): WorkspaceCoreSourceRef[] {
  const evidenceSpanId = source.evidenceIds?.[0];
  return evidenceSpanId ? [{ path: source.path, lineStart: 1, evidenceSpanId, contentHash: source.contentHash }] : [];
}

function knownIds(state: RuntimeState): string[] {
  return [
    ...state.ingests.keys(),
    ...state.promotions.keys(),
    ...state.turns.keys(),
    ...state.learningSteps.keys(),
    ...state.patches.keys(),
    ...state.hydrationPlans.keys(),
    ...state.outcomes.keys(),
    ...state.dialogueStates.keys()
  ].sort();
}

function latest<T>(map: Map<string, T>): T | undefined {
  let value: T | undefined;
  for (const item of map.values()) value = item;
  return value;
}

function dedupeById<T extends { id: unknown }>(items: readonly T[]): T[] {
  const out = new Map<string, T>();
  for (const item of items) out.set(String(item.id), item);
  return [...out.values()];
}

function countStrings(values: readonly string[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const value of values) out[value] = (out[value] ?? 0) + 1;
  return out;
}

function uniqueStrings(values: readonly string[]): string[] {
  return [...new Set(values.filter(Boolean))].sort();
}

function safeRelativePath(value: string): boolean {
  const normalized = value.split("\\").join("/");
  return Boolean(normalized) && !normalized.startsWith("/") && !normalized.includes("../") && normalized.indexOf(":") < 0;
}

function stableId(hasher: Hasher, prefix: string, value: unknown): string {
  return `${prefix}_${hashText(hasher, canonicalStringify(value)).slice(0, 32)}`;
}

function hashText(hasher: Hasher, value: string): string {
  return hasher.digestHex(value);
}

function jsonRecord(value: JsonValue | undefined): Record<string, JsonValue> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, JsonValue> : {};
}

function jsonArray(value: JsonValue | undefined): JsonValue[] {
  return Array.isArray(value) ? value : [];
}

function jsonStringArray(value: JsonValue | undefined): string[] {
  return jsonArray(value).filter((item): item is string => typeof item === "string");
}

function runtimeScoreKind(value: JsonValue | undefined): value is ScoreTrace["kind"] {
  return value === "feature" ||
    value === "guard" ||
    value === "fallback" ||
    value === "estimator" ||
    value === "calibrated_probability" ||
    value === "algebraic_invariant" ||
    value === "provisional_heuristic";
}
