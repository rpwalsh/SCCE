import type { IdFactory } from "./ids.js";
import type { CorrectionRuleRecord } from "./storage.js";
import { createIdFactory } from "./ids.js";
import { createAlphaFieldEngine } from "./field.js";
import { createSemanticEntailmentEngine } from "./entailment.js";
import { createProgramGraphBuilder } from "./program.js";
import { createLanguageMemoryRuntime, type LanguageMemoryRuntimeState } from "./language-memory-runtime.js";
import { createCorrectionMemory } from "./correction-memory.js";
import { createMouth, type SpeakInput, type SpokenOutput } from "./mouth.js";
import { CALIBRATION_TASK_CLASS_IDS, type CalibrationModelSet } from "./calibration-spine.js";
import {
  realizeDialogueResponse,
  type DialogueFeedback,
  type DialoguePolicyDecision,
  type DialoguePragmaticsResult,
  type DialogueState,
  type UserStyleProfile
} from "./dialogue-pragmatics.js";
import { createClock, createHasher, toJsonValue } from "./primitives.js";
import { formatSurfaceMessage } from "./localization.js";
import { PUBLIC_SURFACE_STATUS_TOKENS } from "./surface-quality.js";
import { proveClaim, type ProofClaim, type ProofEvidenceRecord, type SemanticProofResult } from "./semantic-proof-engine.js";
import type {
  ConstructGraph,
  EvidenceId,
  EvidenceSpan,
  FieldState,
  GraphEdge,
  GraphNode,
  Hasher,
  JsonValue,
  LanguageProfile,
  ProgramConstructIntent,
  ProgramGraph,
  SemanticEntailmentResult,
  SourceVersionId
} from "./types.js";
import type { LearningNeed } from "./learning-loop.js";
import type {
  WorkspaceCapabilityRecord,
  WorkspaceCommandRecord,
  WorkspaceContradictionRecord,
  WorkspaceCoreMouthContext,
  WorkspaceCorePromotionResult,
  WorkspaceCoreRecord,
  WorkspaceCoreSourceRef,
  WorkspaceCoreWorkspaceRef,
  WorkspaceGapRecord,
  WorkspaceProgramPlannerInput,
  WorkspaceSymbolGraphRecord,
  WorkspaceTaskRecord
} from "./workspace-core-fusion.js";

export interface WorkspaceGraphContext {
  schema: "scce.workspace_kernel.graph_context.v1";
  workspace: WorkspaceCoreWorkspaceRef;
  nodes: GraphNode[];
  edges: GraphEdge[];
  field?: FieldState;
  activatedRecordIds: string[];
  ppfTopNodeIds: string[];
  audit: JsonValue;
}

export interface WorkspaceProofContext {
  schema: "scce.workspace_kernel.proof_context.v1";
  claims: ProofClaim[];
  evidence: ProofEvidenceRecord[];
  directEvidenceRecordIds: string[];
  unsupportedPriorRecordIds: string[];
  sourceBoundFailures: Array<{ recordId: string; reasonId: string }>;
  results: Array<{ claim: ProofClaim; result: SemanticProofResult }>;
  certifiedClaimIds: string[];
  certifiedEvidenceIds: string[];
  audit: JsonValue;
}

export interface WorkspaceLearningContext {
  schema: "scce.workspace_kernel.learning_context.v1";
  needs: LearningNeed[];
  gaps: WorkspaceGapRecord[];
  prioritizedGapRecordIds: string[];
  audit: JsonValue;
}

export interface WorkspaceProgramContext {
  schema: "scce.workspace_kernel.program_context.v1";
  plannerInputs: WorkspaceProgramPlannerInput[];
  taskRecords: WorkspaceTaskRecord[];
  promotedTaskRecordIds: string[];
  programConstruct?: ConstructGraph;
  programGraph?: ProgramGraph;
  patchPlans: Array<{
    plannerInputId: string;
    workspaceTaskId: string;
    workspaceTaskRecordId: string;
    affectedFiles: string[];
    evidenceSpanIds: string[];
  }>;
  audit: JsonValue;
}

export interface WorkspaceMouthInputContext {
  schema: "scce.workspace_kernel.mouth_input.v1";
  speakInput: SpeakInput;
  graph: WorkspaceGraphContext;
  proof: WorkspaceProofContext;
  learning: WorkspaceLearningContext;
  program: WorkspaceProgramContext;
  answerGraph: WorkspaceAnswerActionGraph;
  dialogueState: DialogueState;
  dialoguePolicyDecision: DialoguePolicyDecision;
  pragmatics: DialoguePragmaticsResult;
  answerSurface: string;
  answerTrace: WorkspaceKernelAnswerTrace;
  unsupported: boolean;
  audit: JsonValue;
}

export interface WorkspaceKernelAnswerTrace {
  schema: "scce.workspace_kernel.answer_trace.v1";
  statusId: "workspace.kernel.answer.ready" | "workspace.kernel.answer.unsupported";
  certifiedClaimIds: string[];
  implementedSymbolIds: string[];
  implementedRouteIds: string[];
  commandRecordIds: string[];
  contradictionRecordIds: string[];
  gapRecordIds: string[];
  taskRecordIds: string[];
  programGraphId?: string;
}

export interface WorkspaceAnswerActionGraph {
  schema: "scce.workspace_kernel.answer_action_graph.v1";
  id: string;
  statusId: WorkspaceKernelAnswerTrace["statusId"];
  claims: Array<{ id: string; proofClaimId?: string; roleId: string; surface: string; certified: boolean }>;
  supportLinks: Array<{ claimId: string; evidenceId: string; sourceRef?: WorkspaceCoreSourceRef; forceClass: string }>;
  caveats: Array<{ id: string; roleId: string; text: string; sourceRef?: WorkspaceCoreSourceRef }>;
  actions: Array<{ id: string; roleId: string; taskRecordId: string; affectedFiles: string[]; evidenceSpanIds: string[] }>;
  uncertainty: { unsupported: boolean; missingEvidenceCount: number; contradictionCount: number; gapCount: number };
  preservation: { protectedEvidenceSpanIds: string[]; protectedSourcePaths: string[]; protectedFilePaths: string[] };
  trace: JsonValue;
}

export interface WorkspaceKernelAnswerResult {
  schema: "scce.workspace_kernel.answer.v1";
  path: "workspace_kernel_context";
  generatedBy: "workspace-kernel-context";
  statusId: "workspace.kernel.answer.ready" | "workspace.kernel.answer.unsupported";
  usedWorkspaceQueryAdapter: false;
  usedReportTemplate: false;
  graph: WorkspaceGraphContext;
  proof: WorkspaceProofContext;
  learning: WorkspaceLearningContext;
  program: WorkspaceProgramContext;
  answerGraph: WorkspaceAnswerActionGraph;
  dialogueState: DialogueState;
  dialoguePolicyDecision: DialoguePolicyDecision;
  pragmatics: DialoguePragmaticsResult;
  mouthInput: WorkspaceMouthInputContext;
  entailment: SemanticEntailmentResult;
  spoken: SpokenOutput;
  answerTrace: WorkspaceKernelAnswerTrace;
  audit: JsonValue;
}

interface RuntimeDeps {
  clock: ReturnType<typeof createClock>;
  hasher: Hasher;
  idFactory: IdFactory;
}

export interface WorkspaceKernelContextOptions {
  requestText?: string;
  createdAt?: number;
  idFactory?: IdFactory;
  hasher?: Hasher;
  languageMemory?: LanguageMemoryRuntimeState;
  maxLength?: number;
  correctionRules?: CorrectionRuleRecord[];
  conversationId?: string;
  targetLanguage?: string;
  dialogueState?: DialogueState;
  dialogueFeedback?: DialogueFeedback;
  userStyleProfile?: Partial<UserStyleProfile>;
  calibrationModels?: CalibrationModelSet;
  /** Structured, source-derived constraints for a coding-request ProgramGraph. */
  programIntentOverride?: Partial<ProgramConstructIntent>;
}

type WorkspaceCoreContextSource = WorkspaceCorePromotionResult | WorkspaceCoreMouthContext;

function workspaceEvidenceSeedPriors(nodes: readonly GraphNode[]): Array<{ nodeId: GraphNode["id"]; weight: number; feature: string }> {
  return nodes
    .map(node => ({
      nodeId: node.id,
      weight: Math.max(0.18, Math.min(1, node.alpha * 0.52)),
      feature: node.evidenceIds.length > 0 ? "workspace-bounded-source-evidence" : "workspace-promoted-graph-prior"
    }))
    .filter(seed => seed.weight > 0)
    .sort((left, right) => right.weight - left.weight || String(left.nodeId).localeCompare(String(right.nodeId)))
    .slice(0, 48);
}

export function workspaceCoreRecordsToGraphContext(source: WorkspaceCoreContextSource, requestText = ""): WorkspaceGraphContext {
  const mouthContext = mouthContextFrom(source);
  const workspace = workspaceRefFrom(source);
  const nodes = [...mouthContext.graphNodes];
  const edges = [...mouthContext.graphEdges];
  const field = requestText.trim() ? createAlphaFieldEngine().activate({
    text: requestText,
    nodes,
    edges,
    seedPriors: workspaceEvidenceSeedPriors(nodes)
  }) : undefined;
  const activeIds = new Set((field?.active ?? []).map(item => String(item.nodeId)));
  const activatedRecordIds = nodes
    .filter(node => activeIds.has(String(node.id)))
    .flatMap(node => recordIdsFromJson(node.metadata))
    .sort();
  return {
    schema: "scce.workspace_kernel.graph_context.v1",
    workspace,
    nodes,
    edges,
    field,
    activatedRecordIds,
    ppfTopNodeIds: (field?.ppf ?? []).slice(0, 16).map(item => String(item.nodeId)),
    audit: toJsonValue({
      source: "workspace-kernel-context.graph",
      nodeCount: nodes.length,
      edgeCount: edges.length,
      seedCount: field?.seeds.length ?? 0,
      activeCount: field?.active.length ?? 0,
      ppfCount: field?.ppf.length ?? 0
    })
  };
}

export function workspaceCoreRecordsToProofContext(source: WorkspaceCoreContextSource): WorkspaceProofContext {
  const mouthContext = mouthContextFrom(source);
  const promotion = promotionFrom(source);
  const generated = promotion ? proofRecordsFromPromotion(promotion) : proofRecordsFromGraph(mouthContext);
  const claims = dedupeById([...mouthContext.proofClaims, ...generated.claims]);
  const evidence = dedupeById([...mouthContext.proofEvidence, ...generated.evidence]);
  const results = claims.map(claim => ({ claim, result: proveClaim({ claim, candidateEvidence: evidence }) }));
  const certifiedClaimIds = results.filter(item => item.result.verdict === "certified").map(item => item.claim.id).sort();
  const certifiedEvidenceIds = uniqueStrings(results.flatMap(item => item.result.certifiedEvidenceIds));
  return {
    schema: "scce.workspace_kernel.proof_context.v1",
    claims,
    evidence,
    directEvidenceRecordIds: generated.directEvidenceRecordIds,
    unsupportedPriorRecordIds: generated.unsupportedPriorRecordIds,
    sourceBoundFailures: generated.sourceBoundFailures,
    results,
    certifiedClaimIds,
    certifiedEvidenceIds,
    audit: toJsonValue({
      source: "workspace-kernel-context.proof",
      claimCount: claims.length,
      evidenceCount: evidence.length,
      certifiedClaimCount: certifiedClaimIds.length,
      certifiedEvidenceCount: certifiedEvidenceIds.length,
      sourceBoundFailureCount: generated.sourceBoundFailures.length,
      unsupportedPriorRecordCount: generated.unsupportedPriorRecordIds.length
    })
  };
}

export function workspaceCoreRecordsToLearningContext(source: WorkspaceCoreContextSource): WorkspaceLearningContext {
  const mouthContext = mouthContextFrom(source);
  const promotion = promotionFrom(source);
  const gaps = promotion?.records.gaps ?? [];
  const needs = dedupeById([...mouthContext.learningNeeds, ...gaps.map(gap => gap.learningNeed)]);
  const prioritizedGapRecordIds = [...gaps]
    .sort((left, right) => right.learningNeed.priority - left.learningNeed.priority || left.id.localeCompare(right.id))
    .map(gap => gap.id);
  return {
    schema: "scce.workspace_kernel.learning_context.v1",
    needs,
    gaps,
    prioritizedGapRecordIds,
    audit: toJsonValue({
      source: "workspace-kernel-context.learning",
      needCount: needs.length,
      gapCount: gaps.length,
      prioritizedGapRecordIds
    })
  };
}

export function workspaceCoreRecordsToProgramContext(
  source: WorkspaceCoreContextSource,
  options: WorkspaceKernelContextOptions & { entailment?: SemanticEntailmentResult; constructionAdmitted?: boolean } = {}
): WorkspaceProgramContext {
  const mouthContext = mouthContextFrom(source);
  const promotion = promotionFrom(source);
  const deps = runtimeDeps(options);
  const plannerInputs = dedupeById(mouthContext.programPlannerInputs);
  const taskRecords = promotion?.records.tasks ?? [];
  const patchPlans = plannerInputs
    .filter(input => Boolean(input.workspaceTaskRecordId) && input.evidenceSpanIds.length > 0)
    .map(input => ({
      plannerInputId: input.id,
      workspaceTaskId: input.workspaceTaskId,
      workspaceTaskRecordId: input.workspaceTaskRecordId!,
      affectedFiles: [...input.affectedFiles].sort(),
      evidenceSpanIds: [...input.evidenceSpanIds].sort()
    }));
  const selected = plannerInputs.find(input => input.workspaceTaskRecordId && input.evidenceSpanIds.length > 0);
  const programIntent = selected
    ? mergeWorkspaceProgramIntent(selected, options.programIntentOverride, mouthContext.evidence)
    : undefined;
  const evidence = evidenceForPlanner(mouthContext.evidence, programIntent);
  const requestText = options.requestText ?? "workspace.kernel.program_context";
  const programConstruct = selected && options.entailment && options.constructionAdmitted !== false
    ? createProgramGraphBuilder({ idFactory: deps.idFactory, hasher: deps.hasher }).build({
      episodeId: deps.idFactory.episodeId(),
      text: requestText,
      createdAt: deps.clock.now(),
      evidence,
      entailment: options.entailment,
      programIntent
    })
    : undefined;
  return {
    schema: "scce.workspace_kernel.program_context.v1",
    plannerInputs,
    taskRecords,
    promotedTaskRecordIds: patchPlans.map(plan => plan.workspaceTaskRecordId),
    programConstruct,
    programGraph: programConstruct?.program,
    patchPlans,
    audit: toJsonValue({
      source: "workspace-kernel-context.program",
      plannerInputCount: plannerInputs.length,
      taskRecordCount: taskRecords.length,
      patchPlanCount: patchPlans.length,
      programGraphId: programConstruct?.program?.id ?? null
    })
  };
}

function mergeWorkspaceProgramIntent(
  selected: WorkspaceProgramPlannerInput,
  override: Partial<ProgramConstructIntent> | undefined,
  availableEvidence: readonly EvidenceSpan[]
): ProgramConstructIntent {
  const base = selected.programIntent;
  const availableEvidenceIds = new Set(availableEvidence.map(span => String(span.id)));
  const overrideEvidenceIds = uniqueStrings(override?.provenanceEvidenceIds ?? []);
  const unboundOverrideEvidenceIds = overrideEvidenceIds.filter(id => !availableEvidenceIds.has(id));
  if (unboundOverrideEvidenceIds.length > 0) {
    throw new Error(`structured program intent evidence is not present in workspace context: ${unboundOverrideEvidenceIds.join(", ")}`);
  }
  return {
    ...base,
    ...override,
    artifactKindIds: uniqueStrings([...(base.artifactKindIds ?? []), ...(override?.artifactKindIds ?? [])]),
    capabilityIds: uniqueStrings([...(base.capabilityIds ?? []), ...(override?.capabilityIds ?? [])]),
    constraints: uniqueStrings([...(base.constraints ?? []), ...(override?.constraints ?? [])]),
    provenanceEvidenceIds: uniqueStrings([...selected.evidenceSpanIds, ...overrideEvidenceIds]),
    metadata: toJsonValue({
      ...objectRecord(base.metadata),
      ...objectRecord(override?.metadata),
      workspaceTaskId: selected.workspaceTaskId,
      workspaceTaskRecordId: selected.workspaceTaskRecordId ?? null,
      plannerInputId: selected.id,
      structuredOverrideApplied: Boolean(override)
    })
  };
}

export function workspaceCoreRecordsToMouthInput(
  source: WorkspaceCoreContextSource,
  options: WorkspaceKernelContextOptions & { answerSurface?: string; unsupported?: boolean } = {}
): WorkspaceMouthInputContext {
  const requestText = options.requestText ?? "";
  const graph = workspaceCoreRecordsToGraphContext(source, requestText);
  const proof = workspaceCoreRecordsToProofContext(source);
  const learning = workspaceCoreRecordsToLearningContext(source);
  const deps = runtimeDeps(options);
  const answerSurface = options.answerSurface ?? workspaceKernelSurface({ source, requestText, graph, proof, learning, program: undefined, unsupported: Boolean(options.unsupported) });
  const field = graph.field ?? createAlphaFieldEngine().activate({
    text: answerSurface,
    nodes: graph.nodes,
    edges: graph.edges,
    seedPriors: workspaceEvidenceSeedPriors(graph.nodes)
  });
  const construct = constructForWorkspaceAnswer({ answerSurface, source, proof, learning, idFactory: deps.idFactory, episodeId: deps.idFactory.episodeId() });
  const certifyingClaims = proof.results.filter(item => item.result.verdict === "certified").map(item => item.claim);
  const entailment = createSemanticEntailmentEngine({ idFactory: deps.idFactory, hasher: deps.hasher }).check({
    text: answerSurface,
    evidence: mouthContextFrom(source).evidence,
    nodes: graph.nodes,
    field,
    construct,
    proofClaims: certifyingClaims,
    proofEvidence: proof.evidence,
    createdAt: deps.clock.now(),
    calibrationModels: options.calibrationModels
  });
  const sourceContradictionCount = promotionFrom(source)?.records.contradictions.length ?? 0;
  const constructionAdmitted = !options.programIntentOverride || (
    !options.unsupported
      && entailment.semanticVerdict === "entailed"
      && entailment.verdict === "entailed"
      && entailment.support > entailment.contradiction
      && sourceContradictionCount === 0
  );
  const program = workspaceCoreRecordsToProgramContext(source, {
    ...options,
    requestText,
    entailment,
    constructionAdmitted,
    idFactory: deps.idFactory,
    hasher: deps.hasher,
    createdAt: deps.clock.now()
  });
  const finalTrace = workspaceKernelAnswerTrace({ source, proof, program, unsupported: Boolean(options.unsupported) });
  const finalSurface = options.answerSurface ?? workspaceKernelSurface({ source, requestText, graph, proof, learning, program, unsupported: Boolean(options.unsupported) });
  const finalConstruct = constructForWorkspaceAnswer({ answerSurface: finalSurface, source, proof, learning, idFactory: deps.idFactory, episodeId: deps.idFactory.episodeId(), program });
  const finalEntailment = finalSurface === answerSurface ? entailment : createSemanticEntailmentEngine({ idFactory: deps.idFactory, hasher: deps.hasher }).check({
    text: finalSurface,
    evidence: mouthContextFrom(source).evidence,
    nodes: graph.nodes,
    field,
    construct: finalConstruct,
    proofClaims: certifyingClaims,
    proofEvidence: proof.evidence,
    createdAt: deps.clock.now(),
    calibrationModels: options.calibrationModels
  });
  const languageRuntime = createLanguageMemoryRuntime({ idFactory: deps.idFactory, hasher: deps.hasher });
  const languageMemory = options.languageMemory ?? languageRuntime.hydrate({ models: [] });
  const answerGraph = workspaceAnswerActionGraph({
    source,
    proof,
    learning,
    program,
    answerTrace: finalTrace,
    unsupported: Boolean(options.unsupported),
    hasher: deps.hasher
  });
  const pragmatics = realizeDialogueResponse({
    conversationId: options.conversationId ?? workspaceRefFrom(source).id,
    turnId: `workspace.turn.${deps.hasher.digestHex(`${requestText}\u001f${finalTrace.statusId}\u001f${answerGraph.id}`).slice(0, 24)}`,
    requestText,
    previousState: options.dialogueState,
    feedback: options.dialogueFeedback,
    statePatch: options.userStyleProfile ? { userStyleProfile: options.userStyleProfile } : undefined,
    answerGraph,
    targetLanguage: options.targetLanguage ?? "und",
    candidateTexts: [finalSurface],
    calibrationModels: options.calibrationModels,
    calibrationTaskClass: CALIBRATION_TASK_CLASS_IDS.workspaceAnswer
  });
  // Dialogue policy may propose a narrower response, but it must not replace the
  // proof/learning/program surface selected by the workspace answer planner.
  const pragmaticSurface = finalSurface;
  const pragmaticConstruct = pragmaticSurface === finalSurface
    ? finalConstruct
    : constructForWorkspaceAnswer({ answerSurface: pragmaticSurface, source, proof, learning, idFactory: deps.idFactory, episodeId: deps.idFactory.episodeId(), program });
  const pragmaticEntailment = pragmaticSurface === finalSurface
    ? finalEntailment
    : createSemanticEntailmentEngine({ idFactory: deps.idFactory, hasher: deps.hasher }).check({
      text: pragmaticSurface,
      evidence: mouthContextFrom(source).evidence,
      nodes: graph.nodes,
      field,
      construct: pragmaticConstruct,
      proofClaims: certifyingClaims,
      proofEvidence: proof.evidence,
      createdAt: deps.clock.now(),
      calibrationModels: options.calibrationModels
    });
  return {
    schema: "scce.workspace_kernel.mouth_input.v1",
    speakInput: {
      construct: pragmaticConstruct,
      field,
      languageProfile: languageProfileFor(source, deps.clock.now()),
      evidence: mouthContextFrom(source).evidence,
      entailment: pragmaticEntailment,
      languageMemory,
      answerDraft: pragmaticSurface,
      targetLanguage: options.targetLanguage ?? "und",
      maxLength: options.maxLength ?? 2000,
      correctionRules: options.correctionRules,
      calibrationModels: options.calibrationModels,
      calibrationTaskClass: CALIBRATION_TASK_CLASS_IDS.workspaceAnswer,
      brainMarker: toJsonValue({
        activeBrainVersion: "workspace-core-records",
        workspaceId: workspaceRefFrom(source).id,
        answerGraphId: answerGraph.id,
        dialogueStateId: pragmatics.state.turnId,
        dialoguePolicyDecisionId: pragmatics.policyDecision.id,
        pragmaticsCriticId: pragmatics.selected.criticId,
        proofClaimCount: proof.claims.length,
        graphNodeCount: graph.nodes.length,
        learningNeedCount: learning.needs.length,
        programPlannerInputCount: program.plannerInputs.length
      })
    },
    graph,
    proof,
    learning,
    program,
    answerGraph,
    dialogueState: pragmatics.state,
    dialoguePolicyDecision: pragmatics.policyDecision,
    pragmatics,
    answerSurface: pragmaticSurface,
    answerTrace: finalTrace,
    unsupported: Boolean(options.unsupported),
    audit: toJsonValue({
      source: "workspace-kernel-context.mouth-input",
      unsupported: Boolean(options.unsupported),
      answerSurfaceHash: deps.hasher.digestHex(pragmaticSurface),
      answerTrace: finalTrace,
      answerGraphId: answerGraph.id,
      dialogueStateId: pragmatics.state.turnId,
      dialoguePolicyDecisionId: pragmatics.policyDecision.id,
      pragmaticsCriticId: pragmatics.selected.criticId,
      constructId: String(pragmaticConstruct.id),
      entailmentForce: pragmaticEntailment.force
    })
  };
}

export async function answerFromWorkspaceCoreContext(input: {
  promotion: WorkspaceCorePromotionResult;
  question: string;
  options?: WorkspaceKernelContextOptions;
}): Promise<WorkspaceKernelAnswerResult> {
  const initialGraph = workspaceCoreRecordsToGraphContext(input.promotion, input.question);
  const initialProof = workspaceCoreRecordsToProofContext(input.promotion);
  const initialLearning = workspaceCoreRecordsToLearningContext(input.promotion);
  const supported = workspaceQuestionCouplesToCore(input.question, initialGraph, initialProof, initialLearning, input.promotion.mouthContext);
  const mouthInput = workspaceCoreRecordsToMouthInput(input.promotion, {
    ...input.options,
    requestText: input.question,
    unsupported: !supported
  });
  const deps = runtimeDeps(input.options);
  const languageRuntime = createLanguageMemoryRuntime({ idFactory: deps.idFactory, hasher: deps.hasher });
  const mouth = createMouth({
    languageMemory: languageRuntime,
    correctionMemory: createCorrectionMemory({ idFactory: deps.idFactory, hasher: deps.hasher }),
    hashText: text => deps.hasher.digestHex(text)
  });
  const spoken = await mouth.speak(mouthInput.speakInput);
  return {
    schema: "scce.workspace_kernel.answer.v1",
    path: "workspace_kernel_context",
    generatedBy: "workspace-kernel-context",
    statusId: supported ? "workspace.kernel.answer.ready" : "workspace.kernel.answer.unsupported",
    usedWorkspaceQueryAdapter: false,
    usedReportTemplate: false,
    graph: mouthInput.graph,
    proof: mouthInput.proof,
    learning: mouthInput.learning,
    program: mouthInput.program,
    answerGraph: mouthInput.answerGraph,
    dialogueState: mouthInput.dialogueState,
    dialoguePolicyDecision: mouthInput.dialoguePolicyDecision,
    pragmatics: mouthInput.pragmatics,
    mouthInput,
    entailment: mouthInput.speakInput.entailment,
    spoken,
    answerTrace: mouthInput.answerTrace,
    audit: toJsonValue({
      source: "workspace-kernel-context.answer",
      statusId: supported ? "workspace.kernel.answer.ready" : "workspace.kernel.answer.unsupported",
      workspaceId: input.promotion.workspaceId,
      usedWorkspaceQueryAdapter: false,
      usedReportTemplate: false,
      selectedSurfacePath: spoken.realizationTrace.selected.path,
      answerGraphId: mouthInput.answerGraph.id,
      dialogueStateId: mouthInput.dialogueState.turnId,
      dialoguePolicyDecisionId: mouthInput.dialoguePolicyDecision.id,
      pragmaticsCriticId: mouthInput.pragmatics.selected.criticId,
      certifiedClaimIds: mouthInput.proof.certifiedClaimIds,
      patchPlanCount: mouthInput.program.patchPlans.length,
      answerTrace: mouthInput.answerTrace
    })
  };
}

function proofRecordsFromPromotion(promotion: WorkspaceCorePromotionResult): {
  claims: ProofClaim[];
  evidence: ProofEvidenceRecord[];
  directEvidenceRecordIds: string[];
  unsupportedPriorRecordIds: string[];
  sourceBoundFailures: Array<{ recordId: string; reasonId: string }>;
} {
  const claims: ProofClaim[] = [];
  const evidence: ProofEvidenceRecord[] = [];
  const directEvidenceRecordIds: string[] = [];
  const unsupportedPriorRecordIds: string[] = [];
  const sourceBoundFailures: Array<{ recordId: string; reasonId: string }> = [];
  const add = (record: WorkspaceCoreRecord, claim: ProofClaim | undefined, proofRecord: ProofEvidenceRecord | undefined) => {
    if (record.forceClass !== "direct_evidence") unsupportedPriorRecordIds.push(record.id);
    if (claim) claims.push(claim);
    if (!proofRecord) {
      sourceBoundFailures.push({ recordId: record.id, reasonId: "workspace.kernel.proof.no_source_bound_record" });
      return;
    }
    evidence.push(proofRecord);
    if (proofRecord.forceClass === "direct_evidence" && proofRecord.sourceVersionId && proofRecord.evidenceSpanId) directEvidenceRecordIds.push(record.id);
    else sourceBoundFailures.push({ recordId: record.id, reasonId: "workspace.kernel.proof.missing_source_span" });
  };
  for (const record of promotion.records.symbols) add(record, symbolClaim(record), symbolEvidence(record));
  for (const record of promotion.records.commands) add(record, commandClaim(record), commandEvidence(record));
  for (const record of promotion.records.capabilities) add(record, capabilityClaim(record), capabilityEvidence(record));
  for (const record of promotion.records.docClaims) {
    add(record, record.proofClaim, record.proofEvidence);
  }
  for (const record of promotion.records.contradictions) {
    add(record, record.proofClaim, contradictionEvidence(record));
  }
  return {
    claims,
    evidence,
    directEvidenceRecordIds: uniqueStrings(directEvidenceRecordIds),
    unsupportedPriorRecordIds: uniqueStrings(unsupportedPriorRecordIds),
    sourceBoundFailures
  };
}

function proofRecordsFromGraph(context: WorkspaceCoreMouthContext): {
  claims: ProofClaim[];
  evidence: ProofEvidenceRecord[];
  directEvidenceRecordIds: string[];
  unsupportedPriorRecordIds: string[];
  sourceBoundFailures: Array<{ recordId: string; reasonId: string }>;
} {
  const claims: ProofClaim[] = [];
  const evidence: ProofEvidenceRecord[] = [];
  for (const node of context.graphNodes) {
    const recordIds = recordIdsFromJson(node.metadata);
    if (!recordIds.length) continue;
    const sourceRef = sourceRefFromNode(node);
    const record = {
      id: recordIds[0]!,
      recordType: "WorkspaceSymbolGraphRecord",
      forceClass: "direct_evidence",
      sourceRef,
      symbolId: String(node.representation),
      symbolName: String(node.representation)
    } as WorkspaceSymbolGraphRecord;
    claims.push(symbolClaim(record));
    const proof = symbolEvidence(record);
    if (proof) evidence.push(proof);
  }
  return { claims, evidence, directEvidenceRecordIds: evidence.map(item => item.id), unsupportedPriorRecordIds: [], sourceBoundFailures: [] };
}

function symbolClaim(record: WorkspaceSymbolGraphRecord): ProofClaim {
  return proofClaim({
    id: `workspace.claim.symbol.${record.id}`,
    subjectId: `workspace.symbol.${record.symbolId}`,
    subjectKindId: "workspace.proof.symbol",
    relationId: "workspace.relation.symbol_declared",
    objectId: record.symbolName,
    objectKindId: "workspace.proof.symbol_name",
    objectSurface: record.symbolName
  });
}

function symbolEvidence(record: WorkspaceSymbolGraphRecord): ProofEvidenceRecord | undefined {
  return proofRecord({
    id: `workspace.proof.symbol.${record.id}`,
    record,
    subjectId: `workspace.symbol.${record.symbolId}`,
    subjectKindId: "workspace.proof.symbol",
    relationId: "workspace.relation.symbol_declared",
    objectId: record.symbolName,
    objectKindId: "workspace.proof.symbol_name",
    objectSurface: record.symbolName,
    text: record.symbolName
  });
}

function commandClaim(record: WorkspaceCommandRecord): ProofClaim {
  return proofClaim({
    id: `workspace.claim.command.${record.id}`,
    subjectId: `workspace.command.${record.actionId}`,
    subjectKindId: "workspace.proof.command",
    relationId: "workspace.relation.command_declared",
    objectId: record.command.name,
    objectKindId: "workspace.proof.command_name",
    objectSurface: record.command.command
  });
}

function commandEvidence(record: WorkspaceCommandRecord): ProofEvidenceRecord | undefined {
  return proofRecord({
    id: `workspace.proof.command.${record.id}`,
    record,
    subjectId: `workspace.command.${record.actionId}`,
    subjectKindId: "workspace.proof.command",
    relationId: "workspace.relation.command_declared",
    objectId: record.command.name,
    objectKindId: "workspace.proof.command_name",
    objectSurface: record.command.command,
    text: record.command.command
  });
}

function capabilityClaim(record: WorkspaceCapabilityRecord): ProofClaim {
  return proofClaim({
    id: `workspace.claim.capability.${record.id}`,
    subjectId: `workspace.capability.${record.capabilityId}`,
    subjectKindId: "workspace.proof.capability",
    relationId: "workspace.relation.route_declared",
    objectId: `${record.route.method}:${record.route.path}`,
    objectKindId: "workspace.proof.route",
    objectSurface: record.route.path
  });
}

function capabilityEvidence(record: WorkspaceCapabilityRecord): ProofEvidenceRecord | undefined {
  return proofRecord({
    id: `workspace.proof.capability.${record.id}`,
    record,
    subjectId: `workspace.capability.${record.capabilityId}`,
    subjectKindId: "workspace.proof.capability",
    relationId: "workspace.relation.route_declared",
    objectId: `${record.route.method}:${record.route.path}`,
    objectKindId: "workspace.proof.route",
    objectSurface: record.route.path,
    text: record.route.path
  });
}

function contradictionEvidence(record: { id: string; forceClass: string; sourceRef?: WorkspaceCoreSourceRef; proofClaim: ProofClaim; evidenceSpan: EvidenceSpan }): ProofEvidenceRecord | undefined {
  return proofRecord({
    id: `workspace.proof.contradiction.${record.id}`,
    record,
    subjectId: record.proofClaim.subject.id ?? record.proofClaim.id,
    subjectKindId: record.proofClaim.subject.kindId,
    relationId: record.proofClaim.relationId,
    objectId: record.proofClaim.object.id ?? record.proofClaim.id,
    objectKindId: record.proofClaim.object.kindId,
    objectSurface: record.proofClaim.object.surface,
    text: record.evidenceSpan.text
  });
}

function proofClaim(input: { id: string; subjectId: string; subjectKindId?: string; relationId: string; objectId: string; objectKindId?: string; objectSurface?: string }): ProofClaim {
  return {
    id: input.id,
    subject: { id: input.subjectId, kindId: input.subjectKindId },
    relationId: input.relationId,
    object: { id: input.objectId, kindId: input.objectKindId, surface: input.objectSurface },
    polarityId: "polarity.positive",
    modalityId: "modality.reported",
    requiredSourceBinding: true
  };
}

function proofRecord(input: {
  id: string;
  record: { forceClass: string; sourceRef?: WorkspaceCoreSourceRef; sourceHash?: string; graphNode?: GraphNode };
  subjectId: string;
  subjectKindId?: string;
  relationId: string;
  objectId: string;
  objectKindId?: string;
  objectSurface?: string;
  text?: string;
}): ProofEvidenceRecord | undefined {
  const sourceRef = sourceRefForProof(input.record);
  if (!sourceRef) return undefined;
  return {
    id: input.id,
    forceClass: input.record.forceClass === "direct_evidence" ? "direct_evidence" : "unknown_prior",
    sourceVersionId: sourceVersionIdFromRef(sourceRef),
    evidenceSpanId: sourceRef.evidenceSpanId,
    subject: { id: input.subjectId, kindId: input.subjectKindId },
    relationId: input.relationId,
    object: { id: input.objectId, kindId: input.objectKindId, surface: input.objectSurface },
    polarityId: "polarity.positive",
    modalityId: "modality.reported",
    text: input.text
  };
}

function sourceRefForProof(record: { sourceRef?: WorkspaceCoreSourceRef; sourceHash?: string; graphNode?: GraphNode }): WorkspaceCoreSourceRef | undefined {
  const ref = record.sourceRef;
  if (!ref) return undefined;
  const rawEvidenceSpanId = ref.evidenceSpanId ?? record.graphNode?.evidenceIds[0];
  const evidenceSpanId = rawEvidenceSpanId ? String(rawEvidenceSpanId) : undefined;
  const contentHash = ref.contentHash ?? record.sourceHash;
  return { ...ref, evidenceSpanId, contentHash };
}

function sourceRefForProofEvidence(evidence: ProofEvidenceRecord | undefined, source: WorkspaceCoreContextSource): WorkspaceCoreSourceRef | undefined {
  if (!evidence?.evidenceSpanId) return undefined;
  return mouthContextFrom(source).sourceRefs.find(ref => ref.evidenceSpanId === evidence.evidenceSpanId);
}

function workspaceKernelSurface(input: {
  source: WorkspaceCoreContextSource;
  requestText: string;
  graph: WorkspaceGraphContext;
  proof: WorkspaceProofContext;
  learning: WorkspaceLearningContext;
  program: WorkspaceProgramContext | undefined;
  unsupported: boolean;
}): string {
  const promotion = promotionFrom(input.source);
  const material = workspaceAnswerMaterial(input.source, input.learning, input.program);
  if (input.unsupported) {
    return [
      formatWorkspaceSurfaceMessage("workspace.answer.unsupported"),
      sourceBoundSummary(material)
    ].filter(Boolean).join(" ");
  }
  const lines: string[] = [];
  const implemented = [
    ...material.symbols.slice(0, 1).map(record => `${record.symbolName} from ${sourceRefLabel(record.sourceRef)}`),
    ...material.capabilities.slice(0, 1).map(record => `${record.route.method} ${record.route.path} from ${sourceRefLabel(record.sourceRef)}`),
    ...material.commands.slice(0, 1).map(record => `command ${record.command.name} (${record.command.command}) from ${sourceRefLabel(record.sourceRef)}`)
  ];
  if (implemented.length) lines.push(formatWorkspaceSurfaceMessage("workspace.answer.implemented", { items: joinHuman(implemented) }));
  const contradiction = material.contradictions[0];
  if (contradiction) lines.push(formatWorkspaceSurfaceMessage("workspace.answer.contradiction", { text: ensurePeriod(contradiction.evidenceSpan.text), source: sourceRefLabel(contradiction.sourceRef) }));
  const gap = material.gaps[0];
  if (gap) lines.push(formatWorkspaceSurfaceMessage("workspace.answer.missing", { kind: displayId(gap.learningNeed.needKindId), files: fileList(gap.affectedFiles, gap.sourcePath) }));
  const task = material.tasks[0];
  if (task) lines.push(formatWorkspaceSurfaceMessage("workspace.answer.fix_first", { kind: displayId(taskFindingKind(task)), files: fileList(task.affectedFiles, task.sourcePath) }));
  if (!lines.length && promotion) lines.push(sourceBoundSummary(material));
  if (!lines.length) lines.push(formatWorkspaceSurfaceMessage("workspace.answer.empty"));
  return lines.join("\n");
}

function workspaceKernelAnswerTrace(input: {
  source: WorkspaceCoreContextSource;
  proof: WorkspaceProofContext;
  program: WorkspaceProgramContext | undefined;
  unsupported: boolean;
}): WorkspaceKernelAnswerTrace {
  const learning = workspaceCoreRecordsToLearningContext(input.source);
  const material = workspaceAnswerMaterial(input.source, learning, input.program);
  return {
    schema: "scce.workspace_kernel.answer_trace.v1",
    statusId: input.unsupported ? "workspace.kernel.answer.unsupported" : "workspace.kernel.answer.ready",
    certifiedClaimIds: input.proof.certifiedClaimIds,
    implementedSymbolIds: material.symbols.map(record => record.id),
    implementedRouteIds: material.capabilities.map(record => record.id),
    commandRecordIds: material.commands.map(record => record.id),
    contradictionRecordIds: material.contradictions.map(record => record.id),
    gapRecordIds: material.gaps.map(record => record.id),
    taskRecordIds: material.tasks.map(record => record.id),
    ...(input.program?.programGraph?.id ? { programGraphId: input.program.programGraph.id } : {})
  };
}

function workspaceAnswerActionGraph(input: {
  source: WorkspaceCoreContextSource;
  proof: WorkspaceProofContext;
  learning: WorkspaceLearningContext;
  program: WorkspaceProgramContext;
  answerTrace: WorkspaceKernelAnswerTrace;
  unsupported: boolean;
  hasher: Hasher;
}): WorkspaceAnswerActionGraph {
  const material = workspaceAnswerMaterial(input.source, input.learning, input.program);
  const certified = new Set(input.proof.certifiedClaimIds);
  const evidenceById = new Map(input.proof.evidence.map(record => [record.id, record]));
  const claims = input.proof.claims.slice(0, 24).map(claim => ({
    id: `answer_graph.claim.${claim.id}`,
    proofClaimId: claim.id,
    roleId: certified.has(claim.id) ? "answer_graph.role.certified_claim" : "answer_graph.role.candidate_claim",
    surface: claim.object.surface || claim.object.id || claim.subject.surface || claim.subject.id || claim.id,
    certified: certified.has(claim.id)
  }));
  const supportLinks = input.proof.results.flatMap(result => result.result.certifiedEvidenceIds.map(evidenceId => {
    const evidence = evidenceById.get(evidenceId);
    return {
      claimId: `answer_graph.claim.${result.claim.id}`,
      evidenceId,
      sourceRef: sourceRefForProofEvidence(evidence, input.source),
      forceClass: evidence?.forceClass ?? "unknown_prior"
    };
  }));
  const caveats = [
    ...material.contradictions.map(record => ({
      id: `answer_graph.caveat.${record.id}`,
      roleId: "answer_graph.role.contradiction",
      text: record.evidenceSpan.text,
      sourceRef: record.sourceRef
    })),
    ...material.gaps.map(record => ({
      id: `answer_graph.caveat.${record.id}`,
      roleId: "answer_graph.role.missing_evidence",
      text: record.learningNeed.needKindId,
      sourceRef: record.sourceRef
    }))
  ].slice(0, 16);
  const actions = input.program.patchPlans.map(plan => ({
    id: `answer_graph.action.${plan.workspaceTaskRecordId}`,
    roleId: "answer_graph.role.patch_plan",
    taskRecordId: plan.workspaceTaskRecordId,
    affectedFiles: plan.affectedFiles,
    evidenceSpanIds: plan.evidenceSpanIds
  })).slice(0, 16);
  const protectedEvidenceSpanIds = uniqueStrings([
    ...supportLinks.map(link => link.evidenceId),
    ...actions.flatMap(action => action.evidenceSpanIds),
    ...material.contradictions.flatMap(record => record.sourceRef?.evidenceSpanId ? [record.sourceRef.evidenceSpanId] : []),
    ...material.gaps.flatMap(record => record.sourceRef?.evidenceSpanId ? [record.sourceRef.evidenceSpanId] : [])
  ]);
  const protectedSourcePaths = uniqueStrings([
    ...supportLinks.flatMap(link => link.sourceRef?.path ? [link.sourceRef.path] : []),
    ...material.symbols.flatMap(record => record.sourceRef?.path ? [record.sourceRef.path] : []),
    ...material.capabilities.flatMap(record => record.sourceRef?.path ? [record.sourceRef.path] : []),
    ...material.commands.flatMap(record => record.sourceRef?.path ? [record.sourceRef.path] : []),
    ...material.contradictions.flatMap(record => record.sourceRef?.path ? [record.sourceRef.path] : []),
    ...material.gaps.flatMap(record => record.sourceRef?.path ? [record.sourceRef.path] : [])
  ]);
  const protectedFilePaths = uniqueStrings(actions.flatMap(action => action.affectedFiles));
  const id = `workspace.answer_graph.${input.hasher.digestHex(JSON.stringify({
    statusId: input.answerTrace.statusId,
    claims: claims.map(claim => claim.id),
    supportLinks: supportLinks.map(link => [link.claimId, link.evidenceId]),
    caveats: caveats.map(caveat => caveat.id),
    actions: actions.map(action => action.id)
  })).slice(0, 24)}`;
  return {
    schema: "scce.workspace_kernel.answer_action_graph.v1",
    id,
    statusId: input.answerTrace.statusId,
    claims,
    supportLinks,
    caveats,
    actions,
    uncertainty: {
      unsupported: input.unsupported,
      missingEvidenceCount: material.gaps.length + input.proof.sourceBoundFailures.length,
      contradictionCount: material.contradictions.length,
      gapCount: material.gaps.length
    },
    preservation: {
      protectedEvidenceSpanIds,
      protectedSourcePaths,
      protectedFilePaths
    },
    trace: toJsonValue({
      source: "workspace-kernel-context.answer_action_graph",
      answerTrace: input.answerTrace,
      claimCount: claims.length,
      supportLinkCount: supportLinks.length,
      caveatCount: caveats.length,
      actionCount: actions.length
    })
  };
}

interface WorkspaceAnswerMaterial {
  symbols: WorkspaceSymbolGraphRecord[];
  capabilities: WorkspaceCapabilityRecord[];
  commands: WorkspaceCommandRecord[];
  contradictions: WorkspaceContradictionRecord[];
  gaps: WorkspaceGapRecord[];
  tasks: WorkspaceTaskRecord[];
}

function workspaceAnswerMaterial(source: WorkspaceCoreContextSource, learning: WorkspaceLearningContext, program: WorkspaceProgramContext | undefined): WorkspaceAnswerMaterial {
  const promotion = promotionFrom(source);
  const taskIds = new Set((program?.patchPlans ?? []).map(plan => plan.workspaceTaskRecordId));
  return {
    symbols: rankedSymbolRecords((promotion?.records.symbols ?? []).filter(sourceBoundRecord)).slice(0, 3),
    capabilities: (promotion?.records.capabilities ?? []).filter(sourceBoundRecord).slice(0, 3),
    commands: rankedCommandRecords((promotion?.records.commands ?? []).filter(sourceBoundRecord)).slice(0, 3),
    contradictions: (promotion?.records.contradictions ?? []).filter(sourceBoundRecord).slice(0, 3),
    gaps: learning.gaps.filter(sourceBoundRecord).slice(0, 3),
    tasks: (promotion?.records.tasks ?? []).filter(record => sourceBoundRecord(record) && (!taskIds.size || taskIds.has(record.id))).slice(0, 3)
  };
}

function sourceBoundRecord(record: { forceClass: string; sourceRef?: WorkspaceCoreSourceRef }): boolean {
  return record.forceClass === "direct_evidence" && Boolean(record.sourceRef?.evidenceSpanId);
}

function sourceBoundSummary(material: WorkspaceAnswerMaterial): string {
  const parts = [
    material.symbols.length ? formatWorkspaceSurfaceMessage("workspace.records.symbols", { count: material.symbols.length }) : "",
    material.capabilities.length ? formatWorkspaceSurfaceMessage("workspace.records.routes", { count: material.capabilities.length }) : "",
    material.commands.length ? formatWorkspaceSurfaceMessage("workspace.records.commands", { count: material.commands.length }) : "",
    material.gaps.length ? formatWorkspaceSurfaceMessage("workspace.records.gaps", { count: material.gaps.length }) : "",
    material.contradictions.length ? formatWorkspaceSurfaceMessage("workspace.records.contradictions", { count: material.contradictions.length }) : "",
    material.tasks.length ? formatWorkspaceSurfaceMessage("workspace.records.tasks", { count: material.tasks.length }) : ""
  ].filter(Boolean);
  return parts.length ? formatWorkspaceSurfaceMessage("workspace.answer.records", { records: joinHuman(parts) }) : formatWorkspaceSurfaceMessage("workspace.answer.no_records");
}

function rankedSymbolRecords(records: readonly WorkspaceSymbolGraphRecord[]): WorkspaceSymbolGraphRecord[] {
  return [...records].sort((left, right) => symbolRecordRank(right) - symbolRecordRank(left) || left.symbolName.localeCompare(right.symbolName) || left.id.localeCompare(right.id));
}

function symbolRecordRank(record: WorkspaceSymbolGraphRecord): number {
  const metadata = objectRecord(record.graphNode.metadata);
  return 8 * jsonArrayLength(metadata.mentionedByDocs) + 2 * jsonArrayLength(metadata.importedBy) + jsonArrayLength(metadata.calledBy) + (record.sourceRef?.evidenceSpanId ? 1 : 0);
}

function rankedCommandRecords(records: readonly WorkspaceCommandRecord[]): WorkspaceCommandRecord[] {
  return [...records].sort((left, right) => (left.sourceRef?.path ?? "").localeCompare(right.sourceRef?.path ?? "") || left.command.name.localeCompare(right.command.name) || left.id.localeCompare(right.id));
}

function jsonArrayLength(value: JsonValue | undefined): number {
  return Array.isArray(value) ? value.length : 0;
}

function sourceRefLabel(ref: WorkspaceCoreSourceRef | undefined): string {
  if (!ref) return formatWorkspaceSurfaceMessage("workspace.source.unknown");
  const line = ref.lineStart ? `:${ref.lineStart}${ref.lineEnd && ref.lineEnd !== ref.lineStart ? `-${ref.lineEnd}` : ""}` : "";
  return `${ref.path}${line}`;
}

function fileList(files: readonly string[], fallback: string | undefined): string {
  const values = files.length ? [...files] : fallback ? [fallback] : [];
  return values.length ? joinHuman(values) : formatWorkspaceSurfaceMessage("workspace.files.analyzed");
}

const WORKSPACE_SURFACE_MESSAGES: Readonly<Record<string, string>> = Object.freeze({
  "workspace.answer.unsupported": PUBLIC_SURFACE_STATUS_TOKENS.workspaceAnswerUnsupported,
  "workspace.answer.implemented": "Implemented: {items}.",
  "workspace.answer.contradiction": "Contradiction: {text} [{source}].",
  "workspace.answer.missing": "Missing: {kind}; files: {files}.",
  "workspace.answer.fix_first": "Fix first: {kind}; files: {files}.",
  "workspace.answer.empty": "No workspace answer material was available.",
  "workspace.answer.records": "Workspace evidence: {records}.",
  "workspace.answer.no_records": "No source-bound workspace records are available.",
  "workspace.records.symbols": "{count} symbols",
  "workspace.records.routes": "{count} routes",
  "workspace.records.commands": "{count} commands",
  "workspace.records.gaps": "{count} gaps",
  "workspace.records.contradictions": "{count} contradictions",
  "workspace.records.tasks": "{count} tasks",
  "workspace.source.unknown": "unknown source",
  "workspace.files.analyzed": "analyzed files"
});

function formatWorkspaceSurfaceMessage(key: string, vars: Record<string, string | number> = {}): string {
  const template = WORKSPACE_SURFACE_MESSAGES[key];
  if (!template) return formatSurfaceMessage(key, vars);
  return template.replace(/\{([A-Za-z0-9_.:-]+)\}/g, (_match, rawKey: string) => String(vars[rawKey] ?? ""));
}

function taskFindingKind(task: WorkspaceTaskRecord): string {
  const metadata = objectRecord(task.programPlannerInput.programIntent.metadata);
  return firstString(metadata.findingKind) ?? task.kind;
}

function displayId(value: string): string {
  return capitalizeFirst(compactSpaces(replaceIdSeparators(stripKnownIdPrefix(value))));
}

function stripKnownIdPrefix(value: string): string {
  const prefixes = ["workspace.need.", "workspace.", "task.", "program.", "source."];
  for (const prefix of prefixes) {
    if (value.startsWith(prefix)) return value.slice(prefix.length);
  }
  return value;
}

function replaceIdSeparators(value: string): string {
  let out = "";
  let pendingSpace = false;
  for (const ch of value) {
    if (ch === "." || ch === "_" || ch === "-") {
      pendingSpace = out.length > 0;
      continue;
    }
    if (pendingSpace) out += " ";
    pendingSpace = false;
    out += ch;
  }
  return out;
}

function compactSpaces(value: string): string {
  let out = "";
  let pendingSpace = false;
  for (const ch of value.trim()) {
    if (isWhitespaceChar(ch)) {
      pendingSpace = out.length > 0;
      continue;
    }
    if (pendingSpace) out += " ";
    pendingSpace = false;
    out += ch;
  }
  return out;
}

function capitalizeFirst(value: string): string {
  if (!value) return value;
  return `${value[0]?.toLocaleUpperCase() ?? ""}${value.slice(1)}`;
}

function ensurePeriod(value: string): string {
  const clean = compactSpaces(value);
  if (!clean) return clean;
  const last = clean[clean.length - 1];
  return last === "." || last === "!" || last === "?" ? clean : `${clean}.`;
}

function joinHuman(values: readonly string[]): string {
  const clean = values.map(compactSpaces).filter(Boolean);
  if (clean.length <= 1) return clean[0] ?? "";
  return clean.join("; ");
}

function constructForWorkspaceAnswer(input: {
  answerSurface: string;
  source: WorkspaceCoreContextSource;
  proof: WorkspaceProofContext;
  learning: WorkspaceLearningContext;
  idFactory: IdFactory;
  episodeId: ReturnType<IdFactory["episodeId"]>;
  program?: WorkspaceProgramContext;
}): ConstructGraph {
  const surfaceHash = createHasher().digestHex(input.answerSurface).slice(0, 24);
  return {
    id: input.idFactory.constructId({ kind: "workspace.kernel.answer", surfaceHash }),
    episodeId: input.episodeId,
    forceVector: toJsonValue({
      constructForce: "WorkspaceKernelAnswer",
      proofClaimIds: input.proof.claims.map(claim => claim.id),
      certifiedClaimIds: input.proof.certifiedClaimIds,
      learningNeedIds: input.learning.needs.map(need => need.id),
      programPlannerInputIds: input.program?.plannerInputs.map(item => item.id) ?? []
    }),
    nodes: [
      {
        id: "workspace.kernel.answer",
        kind: "construct:answer",
        label: "workspace.kernel.answer",
        metadata: toJsonValue({ surfaceHash, schema: "scce.workspace_kernel.answer.v1" })
      },
      {
        id: "workspace.kernel.core_records",
        kind: "construct:workspace_core",
        label: "workspace.kernel.core_records",
        metadata: toJsonValue({
          workspaceId: workspaceRefFrom(input.source).id,
          proofClaimCount: input.proof.claims.length,
          learningNeedCount: input.learning.needs.length,
          programGraphId: input.program?.programGraph?.id ?? null
        })
      }
    ],
    edges: [{ source: "workspace.kernel.core_records", target: "workspace.kernel.answer", relation: "supports_surface", weight: 1 }],
    artifacts: []
  };
}

function workspaceQuestionCouplesToCore(
  question: string,
  graph: WorkspaceGraphContext,
  proof: WorkspaceProofContext,
  learning: WorkspaceLearningContext,
  context: WorkspaceCoreMouthContext
): boolean {
  if (!question.trim()) return false;
  if (!graph.nodes.length && !context.evidence.length) return false;
  const requestSymbols = symbolSet(question);
  const contextSymbols = new Set<string>();
  for (const node of graph.nodes) for (const item of node.features) addFeatureSymbol(contextSymbols, item);
  for (const span of context.evidence) for (const item of span.features) addFeatureSymbol(contextSymbols, item);
  for (const need of learning.needs) {
    for (const symbol of symbolSet(`${need.needKindId} ${need.requiredEvidenceFieldIds.join(" ")} ${need.requiredCapabilityIds.join(" ")}`)) contextSymbols.add(symbol);
  }
  for (const claim of proof.claims) {
    for (const symbol of symbolSet(`${claim.relationId} ${claim.subject.id ?? ""} ${claim.object.id ?? ""} ${claim.object.surface ?? ""}`)) contextSymbols.add(symbol);
  }
  let overlap = 0;
  for (const symbol of requestSymbols) if (contextSymbols.has(symbol)) overlap++;
  return overlap > 0;
}

function evidenceForPlanner(evidence: readonly EvidenceSpan[], intent: ProgramConstructIntent | undefined): EvidenceSpan[] {
  if (!intent) return [];
  const ids = new Set(intent.provenanceEvidenceIds ?? []);
  return evidence.filter(span => ids.has(String(span.id)));
}

function runtimeDeps(options: WorkspaceKernelContextOptions | undefined): RuntimeDeps {
  const hasher = options?.hasher ?? createHasher();
  const clock = createClock({ fixedTime: options?.createdAt ?? 123456, stepMs: 1 });
  const idFactory = options?.idFactory ?? createIdFactory({ clock, hasher, deterministicReplay: true, namespace: "workspace-kernel-context" });
  return { clock, hasher, idFactory };
}

function mouthContextFrom(source: WorkspaceCoreContextSource): WorkspaceCoreMouthContext {
  return source.schema === "scce.workspace_core.mouth_context.v1" ? source : source.mouthContext;
}

function promotionFrom(source: WorkspaceCoreContextSource): WorkspaceCorePromotionResult | undefined {
  return source.schema === "scce.workspace_core.promotion.v1" ? source : undefined;
}

function workspaceRefFrom(source: WorkspaceCoreContextSource): WorkspaceCoreWorkspaceRef {
  const promotion = promotionFrom(source);
  if (promotion) return { id: promotion.workspaceId, corpusId: promotion.corpusId, rootPath: promotion.mouthContext.sourceRefs[0]?.path ?? promotion.workspaceId };
  const context = mouthContextFrom(source);
  return { id: "workspace.context", corpusId: "workspace.context", rootPath: context.sourceRefs[0]?.path ?? "" };
}

function languageProfileFor(source: WorkspaceCoreContextSource, createdAt: number): LanguageProfile {
  const first = mouthContextFrom(source).evidence[0]?.sourceVersionId ?? "workspace.source_version.none" as SourceVersionId;
  return {
    id: "und",
    sourceVersionId: first,
    scripts: [{ script: "und", mass: 1 }],
    symbolShapes: [],
    charNgrams: [],
    direction: "unknown",
    entropy: 0,
    createdAt
  };
}

function sourceVersionIdFromRef(ref: WorkspaceCoreSourceRef): string | undefined {
  if (!ref.contentHash) return undefined;
  return `workspace.source_version.${createHasher().digestHex(`${ref.path}\u001f${ref.contentHash}`).slice(0, 32)}`;
}

function sourceRefFromNode(node: GraphNode): WorkspaceCoreSourceRef | undefined {
  const metadata = objectRecord(node.metadata);
  const sourcePath = firstString(metadata.sourcePath, metadata.path);
  if (!sourcePath) return undefined;
  return {
    path: sourcePath,
    evidenceSpanId: firstString(metadata.evidenceSpanId),
    contentHash: firstString(metadata.contentHash, metadata.sourceHash)
  };
}

function recordIdsFromJson(value: JsonValue): string[] {
  const out = new Set<string>();
  const visit = (current: JsonValue | undefined) => {
    if (!current || typeof current !== "object") return;
    if (Array.isArray(current)) {
      for (const item of current) visit(item);
      return;
    }
    const record = current as Record<string, JsonValue>;
    for (const key of ["recordId", "coreRecordId", "workspaceTaskRecordId"]) {
      const raw = record[key];
      if (typeof raw === "string" && raw) out.add(raw);
    }
    for (const nested of Object.values(record)) visit(nested);
  };
  visit(value);
  return [...out].sort();
}

function objectRecord(value: JsonValue | undefined): Record<string, JsonValue> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, JsonValue> : {};
}

function firstString(...values: readonly unknown[]): string | undefined {
  for (const value of values) if (typeof value === "string" && value.trim()) return value;
  return undefined;
}

function dedupeById<T extends { id: string }>(items: readonly T[]): T[] {
  const byId = new Map<string, T>();
  for (const item of items) if (!byId.has(item.id)) byId.set(item.id, item);
  return [...byId.values()].sort((left, right) => left.id.localeCompare(right.id));
}

function uniqueStrings(values: readonly string[]): string[] {
  return [...new Set(values.filter(Boolean))].sort();
}

function addFeatureSymbol(out: Set<string>, feature: string): void {
  if (!feature.startsWith("sym:")) return;
  const symbol = feature.slice(4);
  if (symbol.length > 3) out.add(symbol);
}

function symbolSet(text: string): Set<string> {
  const out = new Set<string>();
  let current = "";
  for (const ch of text.normalize("NFKC").toLocaleLowerCase()) {
    if (isSymbolChar(ch)) current += ch;
    else if (current) {
      if (current.length > 3) out.add(current);
      current = "";
    }
  }
  if (current.length > 3) out.add(current);
  return out;
}

function isSymbolChar(ch: string): boolean {
  if (!ch) return false;
  const cp = ch.codePointAt(0) ?? 0;
  return cp === 95 || cp === 36 || cp >= 48 && cp <= 57 || cp >= 65 && cp <= 90 || cp >= 97 && cp <= 122 || cp > 127 && ch.trim() !== "";
}

function isWhitespaceChar(ch: string): boolean {
  return ch.trim() === "";
}
