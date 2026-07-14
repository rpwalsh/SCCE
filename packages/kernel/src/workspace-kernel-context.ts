import type { IdFactory } from "./ids.js";
import type { CorrectionRuleRecord } from "./storage.js";
import { createIdFactory } from "./ids.js";
import { createAlphaFieldEngine } from "./field.js";
import { createSemanticEntailmentEngine } from "./entailment.js";
import { createProgramGraphBuilder } from "./program.js";
import { createLanguageMemoryRuntime, type LanguageMemoryRuntimeState } from "./language-memory-runtime.js";
import { createCorrectionMemory } from "./correction-memory.js";
import { createMouth, type MouthSemanticInput, type SpeakInput, type SpokenOutput } from "./mouth.js";
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
  RequestedAuthority,
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

/**
 * Source-neutral contract for a semantic program observation bound to one
 * complete durable workspace revision. Adapters retain their typed program
 * payload while the kernel owns the revision and execution-state boundary.
 */
export interface WorkspaceSemanticProgramObservation<TProgram = unknown> {
  schema: "scce.workspace_kernel.semantic_program_observation.v1";
  id: string;
  workspace: WorkspaceCoreWorkspaceRef;
  workspaceRevision: {
    workspaceId: string;
    revisionId: string;
    revisionHash: string;
    workspaceUpdatedAt: number;
  };
  analyzer: {
    id: string;
    version: string;
  };
  semanticRevisionHash: string;
  program: TProgram;
  execution: { state: "not_executed" };
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
  requestedAuthority?: RequestedAuthority;
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
  const answerSurface = semanticWorkspaceMaterial({
    source,
    requestText,
    proof,
    learning,
    program: undefined,
    suppliedSurface: options.answerSurface
  });
  const field = graph.field ?? createAlphaFieldEngine().activate({
    text: requestText || answerSurface,
    nodes: graph.nodes,
    edges: graph.edges,
    seedPriors: workspaceEvidenceSeedPriors(graph.nodes)
  });
  const construct = constructForWorkspaceAnswer({
    source,
    proof,
    learning,
    requestText,
    idFactory: deps.idFactory,
    episodeId: deps.idFactory.episodeId()
  });
  const certifyingClaims = proof.results.filter(item => item.result.verdict === "certified").map(item => item.claim);
  const entailment = createSemanticEntailmentEngine({ idFactory: deps.idFactory, hasher: deps.hasher }).check({
    text: answerSurface || requestText,
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
  const finalSurface = semanticWorkspaceMaterial({
    source,
    requestText,
    proof,
    learning,
    program,
    suppliedSurface: options.answerSurface
  });
  const answerGraph = workspaceAnswerActionGraph({
    source,
    proof,
    learning,
    program,
    answerTrace: finalTrace,
    unsupported: Boolean(options.unsupported),
    hasher: deps.hasher
  });
  const finalConstruct = constructForWorkspaceAnswer({
    source,
    proof,
    learning,
    requestText,
    idFactory: deps.idFactory,
    episodeId: deps.idFactory.episodeId(),
    program,
    answerGraph
  });
  const finalEntailment = finalSurface === answerSurface ? entailment : createSemanticEntailmentEngine({ idFactory: deps.idFactory, hasher: deps.hasher }).check({
    text: finalSurface || requestText,
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
  const semanticInput = workspaceMouthSemanticInput({
    authority: options.requestedAuthority ?? "reasoned",
    source,
    proof,
    learning,
    program,
    answerGraph,
    requestText,
    unsupported: Boolean(options.unsupported)
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
    candidateTexts: semanticDialogueSurfaces(answerGraph, finalSurface),
    calibrationModels: options.calibrationModels,
    calibrationTaskClass: CALIBRATION_TASK_CLASS_IDS.workspaceAnswer
  });
  return {
    schema: "scce.workspace_kernel.mouth_input.v1",
    speakInput: {
      construct: finalConstruct,
      field,
      languageProfile: languageProfileFor(source, deps.clock.now()),
      evidence: mouthContextFrom(source).evidence,
      entailment: finalEntailment,
      languageMemory,
      answerDraft: "",
      semanticInput,
      requestedAuthority: options.requestedAuthority ?? "reasoned",
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
    answerSurface: finalSurface,
    answerTrace: finalTrace,
    unsupported: Boolean(options.unsupported),
    audit: toJsonValue({
      source: "workspace-kernel-context.mouth-input",
      unsupported: Boolean(options.unsupported),
      answerSurfaceHash: deps.hasher.digestHex(finalSurface),
      answerTrace: finalTrace,
      answerGraphId: answerGraph.id,
      dialogueStateId: pragmatics.state.turnId,
      dialoguePolicyDecisionId: pragmatics.policyDecision.id,
      pragmaticsCriticId: pragmatics.selected.criticId,
      constructId: String(finalConstruct.id),
      entailmentForce: finalEntailment.force,
      semanticSlotCount: semanticInput.slots.length,
      semanticRelationCount: semanticInput.relations?.length ?? 0
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

function semanticWorkspaceMaterial(input: {
  source: WorkspaceCoreContextSource;
  requestText: string;
  proof: WorkspaceProofContext;
  learning: WorkspaceLearningContext;
  program: WorkspaceProgramContext | undefined;
  suppliedSurface?: string;
}): string {
  const supplied = input.suppliedSurface?.replace(/\s+/gu, " ").trim();
  if (supplied) return supplied;
  const material = workspaceAnswerMaterial(input.source, input.learning, input.program);
  const certified = new Set(input.proof.certifiedClaimIds);
  const claimSurfaces = input.proof.claims
    .filter(claim => certified.has(claim.id))
    .flatMap(claim => [claim.subject.surface, claim.object.surface])
    .filter((surface): surface is string => Boolean(surface?.trim()));
  const surfaces = uniqueStrings([
    ...claimSurfaces,
    ...material.symbols.map(record => record.symbolName),
    ...material.capabilities.map(record => `${record.route.method} ${record.route.path}`.trim()),
    ...material.commands.map(record => record.command.command),
    ...material.contradictions.map(record => record.evidenceSpan.text),
    ...material.gaps.flatMap(record => record.affectedFiles),
    ...material.tasks.flatMap(record => record.affectedFiles),
    ...(input.program?.patchPlans.flatMap(plan => plan.affectedFiles) ?? [])
  ]);
  return surfaces.length ? surfaces.join("\n") : input.requestText.trim();
}

function semanticDialogueSurfaces(answerGraph: WorkspaceAnswerActionGraph, semanticMaterial: string): string[] {
  return uniqueStrings([
    ...answerGraph.claims.map(claim => claim.surface),
    ...answerGraph.caveats.map(caveat => caveat.text),
    ...semanticMaterial.split(/\r?\n/gu)
  ]).filter(surface => Boolean(surface.trim()));
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
    surface: claim.object.surface
      || claim.subject.surface
      || input.proof.evidence.find(record => record.relationId === claim.relationId && record.subject.id === claim.subject.id && record.object.id === claim.object.id)?.text
      || "",
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

function workspaceMouthSemanticInput(input: {
  authority: RequestedAuthority;
  source: WorkspaceCoreContextSource;
  proof: WorkspaceProofContext;
  learning: WorkspaceLearningContext;
  program: WorkspaceProgramContext;
  answerGraph: WorkspaceAnswerActionGraph;
  requestText: string;
  unsupported: boolean;
}): MouthSemanticInput {
  const context = mouthContextFrom(input.source);
  const evidenceById = new Map(context.evidence.map(span => [String(span.id), span]));
  const supportByClaim = new Map<string, EvidenceId[]>();
  for (const link of input.answerGraph.supportLinks) {
    const evidenceId = evidenceById.get(link.evidenceId)?.id;
    if (!evidenceId) continue;
    const values = supportByClaim.get(link.claimId) ?? [];
    values.push(evidenceId);
    supportByClaim.set(link.claimId, values);
  }
  const material = workspaceAnswerMaterial(input.source, input.learning, input.program);
  const slots: MouthSemanticInput["slots"] = [
    ...input.answerGraph.claims.filter(claim => Boolean(claim.surface.trim())).map(claim => ({
      id: `mouth.slot.${claim.id}`,
      roleId: claim.certified ? "mouth.role.claim.certified" : "mouth.role.claim.candidate",
      value: toJsonValue({ surface: claim.surface }),
      evidenceIds: supportByClaim.get(claim.id) ?? [],
      sourceId: claim.proofClaimId
    })),
    ...input.answerGraph.caveats.filter(caveat => Boolean(caveat.text.trim())).map(caveat => ({
      id: `mouth.slot.${caveat.id}`,
      roleId: "mouth.role.claim.contradiction",
      value: toJsonValue({ surface: caveat.text }),
      evidenceIds: caveat.sourceRef?.evidenceSpanId && evidenceById.has(caveat.sourceRef.evidenceSpanId)
        ? [evidenceById.get(caveat.sourceRef.evidenceSpanId)!.id]
        : [],
      sourceId: caveat.sourceRef?.path
    })),
    ...material.commands.map(record => ({
      id: `mouth.slot.command.${record.id}`,
      roleId: "mouth.role.action.command",
      value: toJsonValue({ command: record.command.command }),
      evidenceIds: record.sourceRef?.evidenceSpanId && evidenceById.has(record.sourceRef.evidenceSpanId)
        ? [evidenceById.get(record.sourceRef.evidenceSpanId)!.id]
        : [],
      sourceId: record.sourceRef?.path
    })),
    ...material.capabilities.map(record => ({
      id: `mouth.slot.capability.${record.id}`,
      roleId: "mouth.role.action.route",
      value: toJsonValue({ method: record.route.method, path: record.route.path }),
      evidenceIds: record.sourceRef?.evidenceSpanId && evidenceById.has(record.sourceRef.evidenceSpanId)
        ? [evidenceById.get(record.sourceRef.evidenceSpanId)!.id]
        : [],
      sourceId: record.sourceRef?.path
    })),
    ...material.symbols.map(record => ({
      id: `mouth.slot.symbol.${record.id}`,
      roleId: "mouth.role.code.symbol",
      value: toJsonValue({ symbol: record.symbolName }),
      evidenceIds: record.sourceRef?.evidenceSpanId && evidenceById.has(record.sourceRef.evidenceSpanId)
        ? [evidenceById.get(record.sourceRef.evidenceSpanId)!.id]
        : [],
      sourceId: record.sourceRef?.path
    })),
    ...input.answerGraph.actions.flatMap(action => action.affectedFiles.map((path, index) => ({
      id: `mouth.slot.${action.id}.path.${index}`,
      roleId: "mouth.role.workspace.path",
      value: toJsonValue({ path }),
      evidenceIds: action.evidenceSpanIds.map(id => evidenceById.get(id)?.id).filter((id): id is EvidenceId => Boolean(id)),
      sourceId: action.taskRecordId
    }))),
    ...context.evidence.slice(0, 8).map(span => ({
      id: `mouth.slot.evidence.${String(span.id)}`,
      roleId: "mouth.role.evidence.span",
      value: toJsonValue({ surface: span.text }),
      evidenceIds: [span.id],
      sourceId: String(span.sourceId)
    }))
  ];
  if (slots.length === 0 && input.requestText.trim()) {
    slots.push({
      id: "mouth.slot.request.motion",
      roleId: input.unsupported ? "mouth.role.learning.request" : "mouth.role.request",
      value: toJsonValue({ request: input.requestText.trim() })
    });
  }
  const slotIds = new Set(slots.map(slot => slot.id));
  const relations: NonNullable<MouthSemanticInput["relations"]> = input.answerGraph.supportLinks.flatMap((link, index) => {
    const sourceSlotId = `mouth.slot.${link.claimId}`;
    const targetSlotId = `mouth.slot.evidence.${link.evidenceId}`;
    const evidenceId = evidenceById.get(link.evidenceId)?.id;
    if (!slotIds.has(sourceSlotId) || !slotIds.has(targetSlotId) || !evidenceId) return [];
    return [{
      id: `mouth.relation.support.${index}`,
      relationId: "mouth.relation.evidence_supports_claim",
      sourceSlotId: targetSlotId,
      targetSlotId: sourceSlotId,
      evidenceIds: [evidenceId]
    }];
  });
  return { schema: "scce.mouth.semantic_input.v1", authority: input.authority, slots: slots.slice(0, 24), relations };
}

function constructForWorkspaceAnswer(input: {
  source: WorkspaceCoreContextSource;
  proof: WorkspaceProofContext;
  learning: WorkspaceLearningContext;
  requestText: string;
  idFactory: IdFactory;
  episodeId: ReturnType<IdFactory["episodeId"]>;
  program?: WorkspaceProgramContext;
  answerGraph?: WorkspaceAnswerActionGraph;
}): ConstructGraph {
  const material = workspaceAnswerMaterial(input.source, input.learning, input.program);
  const semanticNodes: ConstructGraph["nodes"] = [
    ...(input.answerGraph?.claims ?? []).filter(claim => Boolean(claim.surface.trim())).map(claim => ({
      id: `construct.${claim.id}`,
      kind: "construct:claim",
      label: claim.surface,
      metadata: toJsonValue({
        proofClaimId: claim.proofClaimId ?? null,
        roleId: claim.roleId,
        certified: claim.certified,
        supportLinks: input.answerGraph?.supportLinks.filter(link => link.claimId === claim.id) ?? []
      })
    })),
    ...material.symbols.map(record => ({
      id: `construct.workspace.symbol.${record.id}`,
      kind: "construct:code_symbol",
      label: record.symbolName,
      metadata: toJsonValue({ sourceRef: record.sourceRef ?? null, evidenceIds: record.graphNode.evidenceIds })
    })),
    ...material.capabilities.map(record => ({
      id: `construct.workspace.capability.${record.id}`,
      kind: "construct:route",
      label: `${record.route.method} ${record.route.path}`.trim(),
      metadata: toJsonValue({ route: record.route, sourceRef: record.sourceRef ?? null, evidenceIds: record.graphNode.evidenceIds })
    })),
    ...material.commands.map(record => ({
      id: `construct.workspace.command.${record.id}`,
      kind: "construct:command",
      label: record.command.command,
      metadata: toJsonValue({ command: record.command, sourceRef: record.sourceRef ?? null, evidenceIds: record.graphNode.evidenceIds })
    })),
    ...material.contradictions.map(record => ({
      id: `construct.workspace.contradiction.${record.id}`,
      kind: "construct:contradiction",
      label: record.evidenceSpan.text,
      metadata: toJsonValue({ sourceRef: record.sourceRef ?? null, evidenceIds: [record.evidenceSpan.id] })
    })),
    ...(input.answerGraph?.actions ?? []).flatMap(action => action.affectedFiles.map((path, index) => ({
      id: `construct.${action.id}.path.${index}`,
      kind: "construct:workspace_path",
      label: path,
      metadata: toJsonValue({ actionId: action.id, taskRecordId: action.taskRecordId, evidenceSpanIds: action.evidenceSpanIds })
    })))
  ];
  const surfaceHash = createHasher().digestHex(JSON.stringify({
    requestText: input.requestText,
    nodeIds: semanticNodes.map(node => node.id),
    labels: semanticNodes.map(node => node.label),
    answerGraphId: input.answerGraph?.id ?? null,
    programGraphId: input.program?.programGraph?.id ?? null
  })).slice(0, 24);
  const answerNodeId = "workspace.kernel.answer";
  const coreNodeId = "workspace.kernel.core_records";
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
        id: answerNodeId,
        kind: "construct:answer",
        label: "",
        metadata: toJsonValue({
          surfaceHash,
          schema: "scce.workspace_kernel.answer.v1",
          requestText: input.requestText,
          answerGraph: input.answerGraph ?? null
        })
      },
      {
        id: coreNodeId,
        kind: "construct:workspace_core",
        label: "",
        metadata: toJsonValue({
          workspaceId: workspaceRefFrom(input.source).id,
          proofClaimCount: input.proof.claims.length,
          learningNeedCount: input.learning.needs.length,
          programGraphId: input.program?.programGraph?.id ?? null
        })
      },
      ...semanticNodes
    ],
    edges: [
      { source: coreNodeId, target: answerNodeId, relation: "supports_semantic_motion", weight: 1 },
      ...semanticNodes.map(node => ({ source: node.id, target: answerNodeId, relation: "contributes_semantic_slot", weight: 1 }))
    ],
    program: input.program?.programGraph,
    artifacts: input.program?.programGraph?.files ?? []
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
