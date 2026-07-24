import type { EpistemicForce, EvidenceId, EvidenceSpan, FieldState, JsonValue, RequestedAuthority, SemanticEntailmentResult } from "./types.js";
import type { InventionConstruct } from "./prediction.js";
import {
  COGNITIVE_OPERATOR_IDS,
  type ActivatedOperator,
  type CognitiveOperatorId,
  type TurnRequirementField
} from "./turn-requirements.js";
import type { ClaimBasis, CognitiveProposal } from "./cognitive-planner.js";
import type { CcrResult } from "./ccr.js";
import {
  PATCH_TRANSACTION_PLAN_SCHEMA,
  verifyPatchTransactionPlan,
  type PatchTransactionPlan
} from "./patch-transaction.js";
import { canonicalStringify, clamp01, featureSet, mean, toJsonValue, weightedJaccard } from "./primitives.js";
import { estimatorScore, featureScore, provisionalHeuristicScore, type ScoreTrace } from "./scoring/score-trace.js";
import { type CalibrationModel, calibratedScoreTrace } from "./scoring/calibration.js";
import {
  CALIBRATION_IDS,
  CALIBRATION_TASK_CLASS_IDS,
  calibrateRuntimeScore,
  creativeBootstrapScore,
  creativePreferenceScore,
  type CalibrationModelSet,
  type CreativePreferenceFeatureVector
} from "./calibration-spine.js";
import { boltzmannDistribution, freeEnergyObjective, leastActionPath } from "./equation-operators.js";
import { candidateCompatibleWithAuthority } from "./request-authority.js";
import type { CandidateField, CandidateQuality, CandidateSurface } from "./candidate-contract.js";
export type { CandidateField, CandidateQuality, CandidateSurface } from "./candidate-contract.js";

export interface CandidateGenerationInput {
  requestText: string;
  entailment: SemanticEntailmentResult;
  evidence: EvidenceSpan[];
  field: FieldState;
  ccr: CcrResult;
  proofAnswer: string;
  learningNeeds: string[];
  locale?: string;
  calibrationModel?: CalibrationModel;
  calibrationModels?: CalibrationModelSet;
  calibrationTaskClass?: string;
  requestedAuthority?: RequestedAuthority;
  inventionCandidates?: readonly InventionConstruct[];
  requirementField?: TurnRequirementField;
  operatorActivations?: readonly ActivatedOperator[];
  cognitiveProposals?: readonly CognitiveProposal[];
  dialogueState?: JsonValue;
  workspacePlans?: readonly JsonValue[];
  actionPlans?: readonly JsonValue[];
}

export function createCandidateEngine() {
  return {
    generate(input: CandidateGenerationInput): CandidateField {
      const proposalCandidates = (input.cognitiveProposals ?? [])
        .map((proposal, index) => proposalCandidate(input, proposal, index))
        .filter((candidate): candidate is CandidateSurface => Boolean(candidate));
      const hasCompatibleCognitiveProposal = input.requestedAuthority
        ? proposalCandidates.some(candidate => candidateCompatibleWithAuthority(candidate, input.requestedAuthority!))
        : proposalCandidates.length > 0;
      const supportedCandidates = [
        ...(input.requestedAuthority === "factual" && input.evidence.length > 0
          || operatorSupported(input, [COGNITIVE_OPERATOR_IDS.semanticProof, COGNITIVE_OPERATOR_IDS.evidenceActivation, COGNITIVE_OPERATOR_IDS.clarification])
          ? [proofAnswer(input)]
          : []),
        ...(operatorSupported(input, [COGNITIVE_OPERATOR_IDS.sourceSynthesis, COGNITIVE_OPERATOR_IDS.evidenceActivation, COGNITIVE_OPERATOR_IDS.semanticProof])
          ? [ccrCandidate(input)]
          : []),
        ...proposalCandidates,
        ...(operatorSupported(input, [COGNITIVE_OPERATOR_IDS.workspaceRepair, COGNITIVE_OPERATOR_IDS.programPlanning])
          ? (input.workspacePlans ?? []).map((plan, index) => workspacePlanCandidate(input, plan, index))
          : []),
        ...(operatorSupported(input, [COGNITIVE_OPERATOR_IDS.actionPlanning])
          ? (input.actionPlans ?? []).map((plan, index) => actionPlanCandidate(input, plan, index))
          : []),
        ...(operatorSupported(input, [COGNITIVE_OPERATOR_IDS.dialogueContinuation, COGNITIVE_OPERATOR_IDS.clarification])
          ? [dialogueStateCandidate(input)]
          : []),
        ...(!hasCompatibleCognitiveProposal && operatorSupported(input, [
          COGNITIVE_OPERATOR_IDS.graphPropagation,
          COGNITIVE_OPERATOR_IDS.relationComposition,
          COGNITIVE_OPERATOR_IDS.temporalAnalysis,
          COGNITIVE_OPERATOR_IDS.causalAnalysis,
          COGNITIVE_OPERATOR_IDS.counterfactualConstruction,
          COGNITIVE_OPERATOR_IDS.analogy
        ]) ? [graphInferenceCandidate(input)] : []),
        ...(!hasCompatibleCognitiveProposal
          && operatorSupported(input, [COGNITIVE_OPERATOR_IDS.invention])
          && (input.requirementField === undefined
            || input.requestedAuthority === "creative"
            || operatorExplicitlyActive(input, [COGNITIVE_OPERATOR_IDS.invention]))
          ? (input.inventionCandidates ?? []).map((construct, index) => creativeCandidate(input, construct, index))
          : []),
      ].filter((candidate): candidate is CandidateSurface => Boolean(candidate));
      const fallbackCandidates = supportedCandidates.length === 0
        ? [proofAnswer(input)]
        : [];
      const candidates = supportedCandidates.length > 0 ? supportedCandidates : fallbackCandidates;
      const candidateOperators = candidateOperatorRows(candidates, input.requestedAuthority, input.calibrationModels, input.requirementField);
      const rawTotal = candidates.reduce((sum, candidate) => sum + candidateMass(candidate), 0);
      const scoreTrace = candidates.flatMap(candidate => candidate.scoreTrace ?? []);
      const unnormalizedRawMass = candidates.map(candidate => {
        const base = rawTotal > 0 ? candidateMass(candidate) / rawTotal : 1 / Math.max(1, candidates.length);
        const operator = candidateOperators.find(row => row.candidateId === candidate.id);
        if (input.requestedAuthority === "creative") {
          return {
            candidateId: candidate.id,
            mass: operator?.boltzmannProbability ?? base,
            reason: `${massReason(candidate)} creativeSelection=${(operator?.selectionScore ?? 0).toFixed(3)} temperature=0.280`
          };
        }
        return {
          candidateId: candidate.id,
          mass: clamp01(base * 0.68 + (operator?.boltzmannProbability ?? base) * 0.32),
          reason: `${massReason(candidate)} freeEnergy=${(operator?.freeEnergy ?? 0).toFixed(3)} leastAction=${(operator?.leastActionCost ?? 0).toFixed(3)}`
        };
      });
      const rawMassTotal = unnormalizedRawMass.reduce((sum, item) => sum + item.mass, 0);
      const rawMass = unnormalizedRawMass.map(item => ({ ...item, mass: rawMassTotal > 0 ? item.mass / rawMassTotal : item.mass }));
      const taskClass = input.calibrationTaskClass ?? (input.requestedAuthority === "creative"
        ? CALIBRATION_TASK_CLASS_IDS.creativeGeneration
        : input.requirementField ? CALIBRATION_TASK_CLASS_IDS.generalCognition : CALIBRATION_TASK_CLASS_IDS.sourceBoundQa);
      const calibratedMass = rawMass.map(item => {
        const calibrated = calibrateRuntimeScore({
          raw: item.mass,
          calibrationId: CALIBRATION_IDS.candidateMass,
          taskClass,
          modelSet: input.calibrationModels,
          fallbackModel: taskClass === CALIBRATION_TASK_CLASS_IDS.creativeGeneration ? undefined : input.calibrationModel,
          meaning: `calibrated candidate mass (${item.candidateId})`,
          provenance: ["candidate.ts:generate"],
          inputs: ["surfaceMass", "forceWeight", "support", "faithfulness", item.candidateId]
        });
        return { ...item, calibrated };
      });
      const calibratedTotal = calibratedMass.reduce((sum, item) => sum + item.calibrated.value, 0);
      const surfaceMass = calibratedMass.map(item => ({
        candidateId: item.candidateId,
        mass: calibratedTotal > 0 ? item.calibrated.value / calibratedTotal : item.mass,
        rawMass: item.mass,
        calibrated: item.calibrated.calibrated,
        calibrationId: item.calibrated.modelId,
        reason: item.reason
      })).sort((a, b) => b.mass - a.mass);
      const calibratedTraces: ScoreTrace[] = input.calibrationModel && taskClass !== CALIBRATION_TASK_CLASS_IDS.creativeGeneration
        ? surfaceMass.map(item => calibratedScoreTrace({
            raw: item.rawMass,
            model: input.calibrationModel!,
            meaning: `calibrated candidate mass (${item.candidateId})`,
            provenance: ["candidate.ts:generate"],
            inputs: ["surfaceMass", "forceWeight", "support", "faithfulness"]
          }))
        : calibratedMass.map(item => item.calibrated.scoreTrace).filter((trace): trace is ScoreTrace => Boolean(trace));
      const allTraces = [...scoreTrace, ...calibratedTraces];
      return {
        candidates,
        surfaceMass,
        scoreTrace: allTraces,
        audit: toJsonValue({
          candidates: candidates.map(compactCandidate),
          surfaceMass,
          rawMass,
          candidateOperators,
          operatorRoutingFallback: supportedCandidates.length === 0,
          scoreTrace: allTraces
        })
      };
    }
  };
}

function operatorSupported(input: CandidateGenerationInput, compatible: readonly CognitiveOperatorId[]): boolean {
  const routingEnabled = input.requirementField !== undefined || input.operatorActivations !== undefined;
  if (!routingEnabled) return true;
  const activeOperators = (input.operatorActivations ?? []).filter(operator => operator.active && operator.activation > 0);
  // A bootstrap brain can yield no active operator at all. Preserve the
  // pre-requirement safety lane only when the planner also produced no
  // proposal; once any operator or proposal exists, routing is strict.
  if (activeOperators.length === 0) return (input.cognitiveProposals?.length ?? 0) === 0;
  const compatibleIds = new Set<CognitiveOperatorId>(compatible);
  return activeOperators.some(operator => compatibleIds.has(operator.operatorId));
}

function operatorExplicitlyActive(input: CandidateGenerationInput, compatible: readonly CognitiveOperatorId[]): boolean {
  const compatibleIds = new Set<CognitiveOperatorId>(compatible);
  return (input.operatorActivations ?? []).some(operator =>
    operator.active && operator.activation > 0 && compatibleIds.has(operator.operatorId)
  );
}

function workspacePlanCandidate(
  input: CandidateGenerationInput,
  value: JsonValue,
  candidateIndex: number
): CandidateSurface | undefined {
  const plan = verifiedWorkspacePlan(value);
  if (!plan) return workspaceArtifactCandidate(input, value, candidateIndex);
  const paths = plan.operations.map(operation => operation.path);
  const quality = planCandidateQuality(input, {
    requirementCoverage: operatorActivation(input, [COGNITIVE_OPERATOR_IDS.workspaceRepair, COGNITIVE_OPERATOR_IDS.programPlanning]),
    executableCompleteness: 0.82,
    usefulness: 0.86,
    structure: 0.92,
    uncertaintyCalibration: 1
  });
  return {
    id: `workspace-plan:${plan.planHash}:${candidateIndex}`,
    kind: "workspace-proposal",
    answer: workspacePatchPlanSurface(plan),
    force: "conjectured",
    evidenceIds: [],
    scores: scoresFromQuality(input, quality),
    quality,
    proposalId: `workspace-plan:${plan.planHash}`,
    constructIds: [],
    claimBases: ["conjectured"],
    satisfiedRequirementIds: [],
    missedRequirementIds: [],
    boundaries: ["workspace-plan-not-authorized", "workspace-plan-not-executed"],
    audit: toJsonValue({
      source: "workspace.patch_transaction_plan",
      schemaVersion: plan.schemaVersion,
      planHash: plan.planHash,
      operations: plan.operations.map(operation => ({ kind: operation.kind, path: operation.path })),
      authorizationGranted: false,
      executionState: "not_executed",
      semanticFrame: {
        frameId: "semantic.workspace.patch_plan.v1",
        planId: plan.planHash,
        roleBindings: {
          operationIds: plan.operations.map((operation, index) => `${operation.kind}:${index}`),
          targetIds: paths
        },
        stateIds: ["state.authorization.absent.v1", "state.execution.pending.v1"]
      }
    })
  };
}

/**
 * A workspace proposal is already a complete, hash-verified transaction plan.
 * Keep its user-facing representation structural: the manifest carries the
 * proof identity and operation hashes, while each materialized file body is
 * copied byte-for-byte from the selected plan. No language-specific narration
 * is introduced here and the plan remains unauthorized and unexecuted.
 */
function workspacePatchPlanSurface(plan: PatchTransactionPlan): string {
  const manifest = {
    schemaVersion: plan.schemaVersion,
    planHash: plan.planHash,
    operations: plan.operations.map(operation => ({
      kind: operation.kind,
      path: operation.path,
      beforeContentHash: operation.beforeContentHash,
      afterContentHash: operation.afterContentHash
    }))
  };
  const materializedFiles = plan.operations.flatMap(operation => {
    if (operation.kind === "delete") return [];
    const content = operation.content.endsWith("\n") ? operation.content : `${operation.content}\n`;
    return [`\`${operation.path}\`\n\n\`\`\`\n${content}\`\`\``];
  });
  return [
    `\`\`\`json\n${JSON.stringify(manifest, null, 2)}\n\`\`\``,
    ...materializedFiles
  ].join("\n\n");
}

function workspaceArtifactCandidate(
  input: CandidateGenerationInput,
  value: JsonValue,
  candidateIndex: number
): CandidateSurface | undefined {
  const artifact = jsonRecord(value);
  if (artifact.schema !== "scce.workspace.proposed_artifact.v1") return undefined;
  const path = safeRelativePlanPath(artifact.path);
  const contentHash = cleanPlanToken(artifact.contentHash);
  const mediaType = cleanPlanToken(artifact.mediaType);
  const role = cleanPlanToken(artifact.role);
  if (!path || !contentHash || !mediaType || !role) return undefined;
  const quality = planCandidateQuality(input, {
    requirementCoverage: operatorActivation(input, [COGNITIVE_OPERATOR_IDS.workspaceRepair, COGNITIVE_OPERATOR_IDS.programPlanning]),
    executableCompleteness: 0.46,
    usefulness: 0.72,
    structure: 0.78,
    uncertaintyCalibration: 1
  });
  const proposalId = `workspace-artifact:${hash32(canonicalStringify({ path, contentHash, mediaType, role })).toString(16)}`;
  return {
    id: `${proposalId}:${candidateIndex}`,
    kind: "workspace-proposal",
    answer: "",
    force: "conjectured",
    evidenceIds: [],
    scores: scoresFromQuality(input, quality),
    quality,
    proposalId,
    constructIds: [],
    claimBases: ["conjectured"],
    satisfiedRequirementIds: [],
    missedRequirementIds: [],
    boundaries: ["workspace-artifact-not-byte-validated", "workspace-plan-not-authorized", "workspace-plan-not-executed"],
    audit: toJsonValue({
      source: "workspace.proposed_artifact",
      schema: artifact.schema,
      path,
      contentHash,
      mediaType,
      role,
      exactContentValidated: false,
      authorizationGranted: false,
      executionState: "not_executed",
      semanticFrame: {
        frameId: "semantic.workspace.artifact_proposal.v1",
        artifactId: proposalId,
        roleBindings: { targetId: path, contentId: contentHash, mediaTypeId: mediaType, roleId: role },
        stateIds: [
          "state.content_validation.absent.v1",
          "state.authorization.absent.v1",
          "state.execution.pending.v1"
        ]
      }
    })
  };
}

function verifiedWorkspacePlan(value: JsonValue): PatchTransactionPlan | undefined {
  const row = jsonRecord(value);
  if (row.schemaVersion !== PATCH_TRANSACTION_PLAN_SCHEMA) return undefined;
  try {
    const plan = value as unknown as PatchTransactionPlan;
    verifyPatchTransactionPlan(plan);
    return plan;
  } catch {
    return undefined;
  }
}

function actionPlanCandidate(
  input: CandidateGenerationInput,
  value: JsonValue,
  candidateIndex: number
): CandidateSurface | undefined {
  const plan = jsonRecord(value);
  const id = cleanPlanToken(plan.id);
  const capabilityId = cleanPlanToken(plan.capabilityId);
  const phase = cleanPlanToken(plan.phase);
  if (!id || !capabilityId || plan.status !== "planned" || !["read", "prepare", "commit"].includes(phase ?? "")) return undefined;
  const permission = jsonRecord(plan.permission);
  const suppliedPreview = cleanIncomingSurface(plan.previewSurface);
  const answer = suppliedPreview || actionPlanSurface({
    requestText: input.requestText,
    planId: id,
    capabilityId,
    phase: phase as "read" | "prepare" | "commit",
    input: jsonRecord(plan.input),
    permission
  });
  const quality = planCandidateQuality(input, {
    requirementCoverage: operatorActivation(input, [COGNITIVE_OPERATOR_IDS.actionPlanning]),
    executableCompleteness: 0.68,
    usefulness: 0.78,
    structure: 0.84,
    uncertaintyCalibration: 1
  });
  return {
    id: `action-plan:${id}:${candidateIndex}`,
    kind: "action-preview",
    answer,
    force: "conjectured",
    evidenceIds: [],
    scores: scoresFromQuality(input, quality),
    quality,
    proposalId: `action-plan:${id}`,
    constructIds: [],
    claimBases: ["conjectured"],
    satisfiedRequirementIds: [],
    missedRequirementIds: [],
    boundaries: ["action-plan-not-executed", ...(permission.allowed === false ? ["action-not-authorized"] : [])],
    audit: toJsonValue({
      source: "capability.plan",
      planId: id,
      capabilityId,
      phase,
      status: "planned",
      permission: toJsonValue(permission),
      actionReceiptId: null,
      executionState: "not_executed",
      semanticFrame: {
        frameId: "semantic.action.preview.v1",
        actionId: id,
        roleBindings: { capabilityId, phaseId: phase },
        stateIds: [
          ...(permission.allowed === false ? ["state.authorization.absent.v1"] : []),
          "state.execution.pending.v1"
        ],
        surfaceOriginId: suppliedPreview
          ? "surface.action.preview.input.v1"
          : "surface.action.preview.structural.v1"
      }
    })
  };
}

/**
 * Capability plans do not always carry a learned prose preview. Preserve the
 * selected meaning as a structural, non-executing artifact built only from
 * the request and the governed plan. This keeps realization language-neutral
 * and prevents an admitted action candidate from becoming an empty utterance.
 */
function actionPlanSurface(input: {
  requestText: string;
  planId: string;
  capabilityId: string;
  phase: "read" | "prepare" | "commit";
  input: Record<string, JsonValue | undefined>;
  permission: Record<string, JsonValue | undefined>;
}): string {
  const allowedOperations = stringArray(input.input.allowedOperations);
  const objectiveSurface = input.requestText.normalize("NFKC").trim().slice(0, 4096);
  const mode = cleanPlanToken(input.permission.mode) ?? null;
  const allowed = typeof input.permission.allowed === "boolean" ? input.permission.allowed : null;
  const dryRun = typeof input.permission.dryRun === "boolean" ? input.permission.dryRun : null;
  const plan = {
    artifactKind: "action-preview",
    planId: input.planId,
    capabilityId: input.capabilityId,
    phase: input.phase,
    status: "planned",
    objectiveSurface,
    allowedOperations,
    permission: { allowed, dryRun, mode },
    executionState: "not_executed"
  };
  return `\`\`\`json\n${JSON.stringify(plan, null, 2)}\n\`\`\``;
}

function dialogueStateCandidate(input: CandidateGenerationInput): CandidateSurface | undefined {
  const state = jsonRecord(input.dialogueState);
  const turnId = cleanPlanToken(state.turnId);
  const unresolvedSlots = stringArray(state.unresolvedSlots);
  if (!turnId || unresolvedSlots.length === 0) return undefined;
  const quality = planCandidateQuality(input, {
    requirementCoverage: operatorActivation(input, [COGNITIVE_OPERATOR_IDS.dialogueContinuation, COGNITIVE_OPERATOR_IDS.clarification]),
    executableCompleteness: 0.15,
    dialogueContinuity: 1,
    usefulness: 0.72,
    structure: 0.8,
    uncertaintyCalibration: 1
  });
  return {
    id: `dialogue-plan:${turnId}`,
    kind: "dialogue-continuation",
    answer: "",
    force: "unknown",
    evidenceIds: [],
    scores: scoresFromQuality(input, quality),
    quality,
    proposalId: `dialogue-plan:${turnId}`,
    constructIds: [],
    claimBases: ["learned_prior"],
    satisfiedRequirementIds: [],
    missedRequirementIds: unresolvedSlots,
    boundaries: ["dialogue-state-unresolved"],
    audit: toJsonValue({
      source: "dialogue.state",
      turnId,
      activeTask: typeof state.activeTask === "string" ? state.activeTask : null,
      unresolvedSlotIds: unresolvedSlots,
      continuityLinkIds: stringArray(state.continuityLinks),
      semanticFrame: {
        frameId: "semantic.dialogue.continuation.v1",
        turnId,
        roleBindings: {
          activeTaskId: typeof state.activeTask === "string" ? state.activeTask : null,
          unresolvedSlotIds: unresolvedSlots,
          continuityLinkIds: stringArray(state.continuityLinks)
        },
        stateIds: ["state.dialogue.slot_resolution.pending.v1"]
      }
    })
  };
}

function planCandidateQuality(
  input: CandidateGenerationInput,
  patch: Partial<CandidateQuality>
): CandidateQuality {
  return finiteCandidateQuality({
    requirementCoverage: 0.6,
    truthSupport: 1,
    sourceFidelity: 1,
    novelty: 0.3,
    semanticPreservation: 1,
    transformationQuality: 0.5,
    inferentialContinuity: 0.7,
    explanatoryPower: 0.55,
    executableCompleteness: 0.5,
    dialogueContinuity: dialogueContinuityFromState(input.dialogueState),
    languageQuality: 0.82,
    usefulness: 0.7,
    coherence: 0.9,
    uncertaintyCalibration: 1,
    formatFit: 0.8,
    styleFit: 0.7,
    directness: 0.9,
    structure: 0.8,
    repetition: 0,
    contradiction: 0,
    unsupportedFactRate: 0,
    fakeFactualAuthority: 0,
    staleSourceRisk: 0,
    testWeakening: 0,
    telemetryLeak: 0,
    ...patch
  });
}

function scoresFromQuality(input: CandidateGenerationInput, quality: CandidateQuality): CandidateSurface["scores"] {
  return {
    support: quality.truthSupport,
    contradiction: quality.contradiction,
    faithfulness: quality.sourceFidelity,
    alphaPressure: clamp01(input.field.alphaTrace.surfaces.pressure),
    actionability: quality.usefulness,
    evidenceCoverage: quality.sourceFidelity,
    novelty: quality.novelty,
    realizability: quality.languageQuality,
    constraintCoverage: quality.requirementCoverage,
    graphCoherence: quality.coherence,
    languageRealizability: quality.languageQuality,
    usefulness: quality.usefulness,
    risk: clamp01(Math.max(quality.contradiction, quality.unsupportedFactRate)),
    repetition: quality.repetition,
    unsupportedFactualAssertion: quality.unsupportedFactRate
  };
}

function operatorActivation(input: CandidateGenerationInput, ids: readonly CognitiveOperatorId[]): number {
  if (input.requirementField === undefined && input.operatorActivations === undefined) return 1;
  const accepted = new Set<CognitiveOperatorId>(ids);
  return clamp01(Math.max(0, ...(input.operatorActivations ?? [])
    .filter(operator => operator.active && accepted.has(operator.operatorId))
    .map(operator => operator.activation)));
}

function dialogueContinuityFromState(value: JsonValue | undefined): number {
  const state = jsonRecord(value);
  if (!Object.keys(state).length) return 0.5;
  const links = stringArray(state.continuityLinks).length;
  const unresolved = stringArray(state.unresolvedSlots).length;
  const taskSupport = typeof state.activeTask === "string" && state.activeTask.trim() ? 0.2 : 0;
  return clamp01(0.45 + taskSupport + Math.min(0.3, links * 0.1) - Math.min(0.3, unresolved * 0.08));
}

function cleanPlanToken(value: JsonValue | undefined): string | undefined {
  if (typeof value !== "string") return undefined;
  const clean = value.replace(/\s+/gu, " ").trim();
  return clean && clean.length <= 240 ? clean : undefined;
}

function safeRelativePlanPath(value: JsonValue | undefined): string | undefined {
  const clean = cleanPlanToken(value)?.replace(/\\/gu, "/");
  if (!clean || clean.startsWith("/") || /^[A-Za-z]:\//u.test(clean)) return undefined;
  const segments = clean.split("/");
  if (segments.some(segment => !segment || segment === "." || segment === "..")) return undefined;
  return clean;
}

function stringArray(value: JsonValue | undefined): string[] {
  if (!Array.isArray(value)) return [];
  return value.map(cleanPlanToken).filter((item): item is string => Boolean(item)).slice(0, 64);
}

function proofAnswer(input: {
  requestText: string;
  entailment: SemanticEntailmentResult;
  evidence: EvidenceSpan[];
  field: FieldState;
  proofAnswer: string;
  locale?: string;
  requestedAuthority?: RequestedAuthority;
}): CandidateSurface {
  const answer = normalizeCandidateAnswer(input.proofAnswer, input);
  const proof = input.entailment.proof;
  const proofRoute = normalizedSemanticProofRoute(proof);
  return {
    id: candidateId("proof", input.entailment, answer),
    kind: "proof-answer",
    answer,
    force: evidenceBoundForce(input.entailment.force, input.entailment.evidenceIds, input.requestedAuthority),
    evidenceIds: input.entailment.evidenceIds,
    scores: baseScores(input),
    boundaries: input.entailment.boundaries,
    audit: toJsonValue({
      source: "semantic-proof",
      proofId: proof.id,
      semanticFrame: {
        frameId: "semantic.answer.proof.v1",
        claimId: proof.claimId,
        evidenceIds: input.entailment.evidenceIds,
        transformIds: proofRoute.transformIds,
        forceId: input.entailment.force,
        surfaceOriginId: answer ? "surface.semantic_proof.input.v1" : null
      }
    }),
    scoreTrace: [
      featureScore({
        value: input.entailment.support,
        range: [0, 1],
        meaning: "proof-backed candidate support",
        inputs: ["entailment.support"],
        provenance: ["candidate.ts:proofAnswer"]
      })
    ]
  };
}

function normalizeCandidateAnswer(answer: string, input: { requestText: string; entailment: SemanticEntailmentResult; evidence: EvidenceSpan[] }): string {
  const clean = cleanIncomingSurface(stripSurfaceRealizerArtifacts(answer));
  const request = input.requestText.replace(/\s+/g, " ").trim();
  const onlyEcho = clean && request && (clean === request || clean.toLocaleLowerCase() === request.toLocaleLowerCase());
  const proofRoute = normalizedSemanticProofRoute(input.entailment.proof);
  const proofHasRoute = input.entailment.evidenceIds.length > 0
    || proofRoute.transformIds.length > 0
    || proofRoute.edgeCount > 0;
  if (!proofHasRoute || !clean || onlyEcho || containsSurfaceRealizerTelemetry(answer) || containsProofDiagnosticSurface(clean)) {
    return boundEvidenceSurface(input.entailment.evidenceIds, input.evidence);
  }
  return clean;
}

function normalizedSemanticProofRoute(proof: SemanticEntailmentResult["proof"]): { transformIds: string[]; edgeCount: number } {
  const legacy = proof as unknown as { transformIds?: unknown; proofGraph?: { edges?: unknown } };
  const transformIds = Array.isArray(legacy.transformIds)
    ? legacy.transformIds.filter((value): value is string => typeof value === "string" && value.trim().length > 0)
    : [];
  return {
    transformIds,
    edgeCount: Array.isArray(legacy.proofGraph?.edges) ? legacy.proofGraph.edges.length : 0
  };
}

function stripSurfaceRealizerArtifacts(text: string): string {
  let out = text.replace(/\{[^{}]*scce\.surface\.realizer[^{}]*\}/giu, " ");
  const markers = ["surface.point=", "surface.limit=", "surface.grounding="];
  while (true) {
    const starts = markers.map(marker => out.indexOf(marker)).filter(index => index >= 0).sort((a, b) => a - b);
    const start = starts[0];
    if (start === undefined) break;
    const nextMarker = markers
      .map(marker => out.indexOf(marker, start + 1))
      .filter(index => index >= 0)
      .sort((a, b) => a - b)[0];
    const sentenceEnd = out.indexOf(". ", start);
    const end = nextMarker ?? (sentenceEnd >= 0 ? sentenceEnd + 2 : out.length);
    out = `${out.slice(0, start)} ${out.slice(end)}`;
  }
  return out;
}

function containsSurfaceRealizerTelemetry(answer: string): boolean {
  const lower = answer.toLocaleLowerCase();
  return lower.includes("scce.surface.realizer") ||
    lower.includes("surface.point=") ||
    lower.includes("surface.limit=") ||
    lower.includes("surface.grounding=") ||
    lower.includes("surface.ref=");
}

function containsProofDiagnosticSurface(answer: string): boolean {
  const lower = answer.toLocaleLowerCase();
  return lower.includes("hoeffding") ||
    lower.includes("faithfulness-lcb") ||
    lower.includes("proofid") ||
    lower.includes("proof_");
}

function looksStructuredTelemetry(answer: string): boolean {
  const trimmed = answer.trim();
  return (trimmed.startsWith("{") || trimmed.includes("{\"schema\"")) && (trimmed.includes("\"schema\"") || trimmed.includes("candidateKind") || trimmed.includes("proofId"));
}

function looksControlSurface(answer: string): boolean {
  const trimmed = answer.trim();
  return /^i18n[:.]/iu.test(trimmed)
    || /^\[?scce[:.]/iu.test(trimmed)
    || /^surface\.[\p{L}\p{N}_.-]+(?:=|$)/iu.test(trimmed);
}

function cleanIncomingSurface(value: JsonValue | undefined): string {
  if (typeof value !== "string") return "";
  const clean = value.replace(/\s+/gu, " ").trim();
  return clean
    && !looksStructuredTelemetry(clean)
    && !looksControlSurface(clean)
    && !containsProofDiagnosticSurface(clean)
    ? clean
    : "";
}

function boundEvidenceSurface(evidenceIds: readonly EvidenceId[], evidence: readonly EvidenceSpan[]): string {
  const boundIds = new Set(evidenceIds.map(String));
  for (const span of evidence) {
    if (!boundIds.has(String(span.id))) continue;
    const surface = cleanIncomingSurface(span.text) || cleanIncomingSurface(span.textPreview);
    if (surface) return surface;
  }
  return "";
}

function ccrCandidate(input: {
  requestText: string;
  entailment: SemanticEntailmentResult;
  evidence: EvidenceSpan[];
  field: FieldState;
  ccr: CcrResult;
  locale?: string;
  requestedAuthority?: RequestedAuthority;
}): CandidateSurface | undefined {
  if (!input.ccr.accepted) return undefined;
  return {
    id: candidateId("ccr", input.entailment, input.ccr.l3.answer),
    kind: "ccr-extractive",
    answer: input.ccr.l3.answer,
    force: evidenceBoundForce(input.entailment.force, input.entailment.evidenceIds, input.requestedAuthority),
    evidenceIds: input.entailment.evidenceIds,
    scores: {
      ...baseScores(input),
      support: clamp01(input.entailment.support * 0.8 + mean(input.ccr.l2.survivors.map(item => item.score)) * 0.2),
      faithfulness: clamp01(input.entailment.faithfulnessLcb * 0.6 + mean(input.ccr.l3.sentences.map(item => item.lcb)) * 0.4),
      realizability: 0.95
    },
    boundaries: input.ccr.l3.abstentions,
    audit: input.ccr.audit,
    scoreTrace: [
      provisionalHeuristicScore({
        value: clamp01(input.entailment.support * 0.8 + mean(input.ccr.l2.survivors.map(item => item.score)) * 0.2),
        range: [0, 1],
        meaning: "ccr support blend",
        inputs: ["entailment.support", "ccr.l2.survivor.score"],
        provenance: ["candidate.ts:ccrCandidate"],
        failureModes: ["domain_shift", "sparse_ccr_survivors"]
      })
    ]
  };
}

function graphInferenceCandidate(input: {
  requestText: string;
  entailment: SemanticEntailmentResult;
  evidence: EvidenceSpan[];
  field: FieldState;
  locale?: string;
  requestedAuthority?: RequestedAuthority;
}): CandidateSurface | undefined {
  if (!input.entailment.evidenceIds.length && input.entailment.support < 0.34) return undefined;
  const top = input.field.causalMass.slice(0, 8);
  const answer = cleanGraphInferenceSurface(input);
  return {
    id: candidateId("graph", input.entailment, answer),
    kind: "graph-inference",
    answer,
    force: input.entailment.force === "invented" && input.requestedAuthority === "creative" ? "invented" : "inferred",
    evidenceIds: input.entailment.evidenceIds,
    scores: {
      ...baseScores(input),
      support: clamp01(mean(top.map(item => item.mass)) * 0.5 + input.entailment.support * 0.5),
      novelty: 0.52,
      realizability: 0.72
    },
    boundaries: [...input.entailment.boundaries, "graph-inference-not-direct-proof"],
    audit: toJsonValue({
      causalMass: top,
      semanticFrame: {
        frameId: "semantic.answer.graph_inference.v1",
        claimId: input.entailment.claim.id,
        evidenceIds: input.entailment.evidenceIds,
        causalNodeIds: top.map(item => item.nodeId),
        forceId: input.entailment.force,
        surfaceOriginId: answer ? "surface.graph.claim_or_evidence.v1" : null
      }
    }),
    scoreTrace: [
      provisionalHeuristicScore({
        value: clamp01(mean(top.map(item => item.mass)) * 0.5 + input.entailment.support * 0.5),
        range: [0, 1],
        meaning: "graph inference support blend",
        inputs: ["causalMass.mean", "entailment.support"],
        provenance: ["candidate.ts:graphInferenceCandidate"],
        failureModes: ["noisy_graph_density", "stale_causal_mass"]
      })
    ]
  };
}

function cleanGraphInferenceSurface(input: {
  entailment: SemanticEntailmentResult;
  evidence: EvidenceSpan[];
}): string {
  const legacyProof = input.entailment.proof as unknown as { claim?: { text?: unknown } };
  const legacyClaimText = typeof legacyProof.claim?.text === "string" ? legacyProof.claim.text : "";
  const claim = cleanIncomingSurface(input.entailment.claim?.text ?? legacyClaimText);
  if (claim) return claim;
  return boundEvidenceSurface(input.entailment.evidenceIds, input.evidence);
}

function proposalCandidate(
  input: {
    entailment: SemanticEntailmentResult;
    evidence: EvidenceSpan[];
    field: FieldState;
    requirementField?: TurnRequirementField;
    operatorActivations?: readonly ActivatedOperator[];
    dialogueState?: JsonValue;
  },
  proposal: CognitiveProposal,
  candidateIndex: number
): CandidateSurface | undefined {
  const kind = candidateKindFromProposal(proposal);
  const force = epistemicForceFromProposal(proposal);
  const evidenceById = new Map(input.evidence.map(span => [String(span.id), span.id]));
  const declaredEvidenceIds = [
    ...proposal.evidenceIds,
    ...proposal.claims.flatMap(claim => claim.evidenceIds),
    ...proposal.relations.flatMap(relation => relation.evidenceIds),
    ...proposal.steps.flatMap(step => step.evidenceIds)
  ];
  let evidenceIds = [...new Set(declaredEvidenceIds.map(String))]
    .map(id => evidenceById.get(String(id)))
    .filter((id): id is EvidenceId => Boolean(id));
  const proposalAnswer = proposalSurface(proposal);
  let answer = proposalAnswer;
  let surfaceOriginId = proposalAnswer ? "surface.cognitive_proposal.input.v1" : undefined;
  if (!answer && reasonedProposalCanUseBoundEvidence(kind, proposal, input.entailment, input.evidence)) {
    const proofEvidenceIds = input.entailment.evidenceIds
      .map(id => evidenceById.get(String(id)))
      .filter((id): id is EvidenceId => Boolean(id));
    const boundFromProof = evidenceIds.length > 0 || proofEvidenceIds.length > 0;
    const fallbackEvidenceIds = evidenceIds.length
      ? evidenceIds
      : proofEvidenceIds.length
        ? proofEvidenceIds
        : input.evidence.map(span => span.id);
    const evidenceSurface = boundEvidenceSurface(fallbackEvidenceIds, input.evidence);
    if (evidenceSurface) {
      answer = evidenceSurface;
      evidenceIds = [...new Set([...evidenceIds, ...fallbackEvidenceIds].map(String))]
        .map(id => evidenceById.get(id))
        .filter((id): id is EvidenceId => Boolean(id));
      surfaceOriginId = boundFromProof
        ? "surface.cognitive_proposal.bound_proof_evidence.v1"
        : "surface.cognitive_proposal.bound_selected_evidence.v1";
    }
  }
  const quality = candidateQualityFromProposal(input, proposal, answer);
  const constructIds = [...new Set(proposal.constructIds)];
  return {
    id: `proposal:${proposal.id}:${candidateIndex}`,
    kind,
    answer,
    force,
    evidenceIds,
    scores: {
      support: quality.truthSupport,
      contradiction: quality.contradiction,
      faithfulness: quality.sourceFidelity,
      alphaPressure: clamp01(input.field.alphaTrace.surfaces.pressure),
      actionability: quality.usefulness,
      evidenceCoverage: quality.sourceFidelity,
      novelty: quality.novelty,
      realizability: quality.languageQuality,
      constraintCoverage: quality.requirementCoverage,
      graphCoherence: quality.coherence,
      languageRealizability: quality.languageQuality,
      usefulness: quality.usefulness,
      risk: clamp01(Math.max(quality.contradiction, quality.unsupportedFactRate, quality.fakeFactualAuthority)),
      repetition: quality.repetition,
      unsupportedFactualAssertion: quality.unsupportedFactRate
    },
    quality,
    proposalId: proposal.id,
    constructIds,
    claimBases: proposal.claims.map(claim => claim.basis),
    satisfiedRequirementIds: [...proposal.satisfiedRequirementIds],
    missedRequirementIds: [...proposal.missedRequirementIds],
    boundaries: [
      ...(quality.unsupportedFactRate > 0 ? ["unsupported-factual-claim"] : []),
      ...(quality.fakeFactualAuthority > 0 ? ["fake-factual-authority"] : []),
      ...(quality.contradiction > 0.5 ? ["material-contradiction"] : [])
    ],
    audit: toJsonValue({
      source: "cognitive-proposal",
      proposalId: proposal.id,
      operatorIds: proposal.operatorActivations.map(operator => operator.operatorId),
      claimBases: proposal.claims.map(claim => ({
        claimId: claim.id,
        basis: claim.basis,
        evidenceIds: claim.evidenceIds,
        actionReceiptId: claim.actionReceiptId ?? null,
        externallyFactual: claim.externallyFactual,
        trace: claim.trace
      })),
      semanticFrame: {
        frameId: "semantic.cognitive_proposal.v1",
        proposalId: proposal.id,
        candidateKindId: kind,
        claimIds: proposal.claims.map(claim => claim.id),
        relationIds: proposal.relations.map(relation => relation.id),
        stepIds: proposal.steps.map(step => step.id),
        artifactIds: proposal.artifacts.map(artifact => artifact.id),
        semanticFrameIds: proposal.semanticFrameIds,
        surfaceOriginId: surfaceOriginId ?? null,
        surfaceEvidenceIds: surfaceOriginId?.startsWith("surface.cognitive_proposal.bound_")
          ? evidenceIds.map(String)
          : []
      },
      constructIds,
      quality,
      proposalTrace: proposal.trace
    })
  };
}

function reasonedProposalCanUseBoundEvidence(
  kind: CandidateSurface["kind"],
  proposal: CognitiveProposal,
  entailment: SemanticEntailmentResult,
  evidence: readonly EvidenceSpan[]
): boolean {
  if (kind !== "reasoned-synthesis" && kind !== "causal-inference" && kind !== "temporal-inference") return false;
  if (evidence.length === 0 || entailment.support <= entailment.contradiction) return false;
  return proposal.claims.some(claim =>
    claim.basis === "reasoned_inference"
    || claim.basis === "causal_inference"
    || claim.basis === "temporal_inference"
    || claim.basis === "source_synthesis"
    || claim.basis === "direct_evidence"
  );
}

function proposalSurface(proposal: CognitiveProposal): string {
  const claims = proposal.claims
    .map(claim => cleanIncomingSurface(claim.text))
    .filter(Boolean);
  const steps = proposal.steps
    .sort((left, right) => left.order - right.order)
    .map(step => cleanIncomingSurface(step.text))
    .filter(Boolean);
  const surfaces = claims.length ? claims : steps;
  return [...new Set(surfaces)].slice(0, 8).join(" ").trim();
}

function candidateKindFromProposal(proposal: CognitiveProposal): CandidateSurface["kind"] {
  const bases = new Set(proposal.claims.map(claim => claim.basis));
  const operators = new Set(proposal.operatorActivations.filter(row => row.active).map(row => row.operatorId));
  if (bases.has("counterfactual")) return "counterfactual-response";
  if (bases.has("causal_inference")) return "causal-inference";
  if (bases.has("temporal_inference")) return "temporal-inference";
  if (bases.has("translated")) return "translation";
  if (bases.has("invented")) return "creative-candidate";
  if (operators.has("operator.cognition.workspace_repair.v1")) return "workspace-proposal";
  if (operators.has("operator.cognition.action_planning.v1")) return "action-preview";
  if (operators.has("operator.cognition.program_planning.v1") || proposal.artifacts.length > 0) return "program-proposal";
  if (operators.has("operator.cognition.transformation.v1")) return "transformation";
  return "reasoned-synthesis";
}

function epistemicForceFromProposal(proposal: CognitiveProposal): EpistemicForce {
  const bases = new Set(proposal.claims.map(claim => claim.basis));
  if (bases.has("unsupported")) return "unknown";
  if (bases.has("conjectured") || bases.has("counterfactual")) return "conjectured";
  if (bases.has("invented")) return "invented";
  if (proposal.claims.length > 0 && proposal.claims.every(claim => claim.basis === "direct_evidence")) return "observed";
  if (proposal.claims.some(claim => claim.basis === "reasoned_inference" || claim.basis === "causal_inference" || claim.basis === "temporal_inference" || claim.basis === "source_synthesis" || claim.basis === "translated")) return "inferred";
  return "unknown";
}

function candidateQualityFromProposal(
  input: { entailment: SemanticEntailmentResult; requirementField?: TurnRequirementField; dialogueState?: JsonValue },
  proposal: CognitiveProposal,
  answer: string
): CandidateQuality {
  const factual = proposal.claims.filter(claim => claim.externallyFactual);
  const supportedFactual = factual.filter(claim =>
    (claim.basis === "direct_evidence" || claim.basis === "source_synthesis") && claim.evidenceIds.length > 0
    || claim.basis === "reasoned_inference" && (claim.evidenceIds.length > 0 || claim.graphEdgeIds.length > 0)
    || claim.basis === "conjectured"
  );
  const unsupportedFactRate = factual.length ? clamp01((factual.length - supportedFactual.length) / factual.length) : 0;
  const fakeFactualAuthority = proposal.quality.hardFailures.some(failure => failure.includes("fake") || failure.includes("attribution"))
    || factual.some(claim => claim.evidenceIds.length === 0 && claim.basis === "direct_evidence") ? 1 : 0;
  const actionWithoutReceipt = proposal.claims.some(claim => claim.basis === "action_result" && !claim.actionReceiptId);
  const reasoning = proposal.quality.reasoning;
  const invention = proposal.quality.invention;
  const requirementCoverage = clamp01(reasoning.requirementCoverage);
  const sourceFidelity = factual.length ? clamp01(supportedFactual.length / factual.length) : 1;
  const executableCompleteness = proposal.artifacts.length
    ? clamp01(mean(proposal.artifacts.map(artifact => artifact.completion)))
    : clamp01(1 - (input.requirementField?.executableArtifactDemand ?? 0));
  return finiteCandidateQuality({
    requirementCoverage,
    truthSupport: clamp01((1 - unsupportedFactRate) * (1 - input.entailment.contradiction)),
    sourceFidelity,
    novelty: clamp01(invention?.novelty ?? 0.38),
    semanticPreservation: clamp01(1 - (proposal.missedRequirementIds.length ? 0.24 : 0)),
    transformationQuality: clamp01(proposal.claims.some(claim => claim.basis === "translated") ? 0.82 : requirementCoverage),
    inferentialContinuity: clamp01(reasoning.relationContinuity),
    explanatoryPower: clamp01(reasoning.explanatoryPower),
    executableCompleteness,
    dialogueContinuity: clamp01(
      dialogueContinuityFromState(input.dialogueState)
      - Math.max(0, (input.requirementField?.dialogueDependence ?? 0) - requirementCoverage) * 0.5
    ),
    languageQuality: clamp01(invention?.languageRealizability ?? 0.74),
    usefulness: clamp01(reasoning.usefulness),
    coherence: clamp01(1 - reasoning.internalContradiction),
    uncertaintyCalibration: clamp01(proposal.claims.some(claim => claim.basis === "conjectured" || claim.basis === "counterfactual") ? 1 : 1 - unsupportedFactRate),
    formatFit: requirementCoverage,
    styleFit: clamp01(invention?.styleFit ?? 0.7),
    directness: clamp01(proposal.steps.length > 0 ? 0.76 : 0.82),
    structure: clamp01(proposal.relations.length || proposal.steps.length ? 0.86 : 0.68),
    repetition: clamp01(invention?.repetition ?? repeatedSurfaceRate(answer)),
    contradiction: clamp01(Math.max(input.entailment.contradiction, reasoning.internalContradiction)),
    unsupportedFactRate,
    fakeFactualAuthority,
    staleSourceRisk: proposal.quality.hardFailures.some(failure => failure.includes("stale")) ? 1 : 0,
    testWeakening: proposal.quality.hardFailures.some(failure => failure.includes("test_weakening")) ? 1 : 0,
    telemetryLeak: looksStructuredTelemetry(answer) ? 1 : actionWithoutReceipt ? 0 : 0
  });
}

function finiteCandidateQuality(quality: CandidateQuality): CandidateQuality {
  const out = { ...quality };
  for (const key of Object.keys(out) as Array<keyof CandidateQuality>) {
    out[key] = clamp01(Number.isFinite(out[key]) ? out[key] : 0);
  }
  return out;
}

function repeatedSurfaceRate(text: string): number {
  const units = (text.toLocaleLowerCase().match(/[\p{L}\p{N}_]+/gu) ?? []);
  if (units.length < 2) return 0;
  return clamp01(1 - new Set(units).size / units.length);
}

function evidenceBoundForce(force: EpistemicForce, evidenceIds: readonly EvidenceId[], authority?: RequestedAuthority): EpistemicForce {
  if (force !== "invented" || authority === "creative") return force;
  return evidenceIds.length > 0 ? "observed" : "unknown";
}

function creativeCandidate(input: {
  entailment: SemanticEntailmentResult;
  evidence: EvidenceSpan[];
  field: FieldState;
  calibrationModels?: CalibrationModelSet;
  calibrationTaskClass?: string;
}, construct: InventionConstruct, candidateIndex: number): CandidateSurface | undefined {
  const answer = construct.proposalSurface.replace(/\s+/gu, " ").trim();
  if (!answer) return undefined;
  const metrics = creativeMetricsFromConstruct(construct);
  const selection = creativePreferenceScore({
    features: metrics,
    modelSet: input.calibrationModels,
    taskClass: CALIBRATION_TASK_CLASS_IDS.creativeGeneration
  });
  const trace = jsonRecord(construct.trace);
  const factualClaimEvidenceIds = factualPremiseEvidenceIds(trace.claimBasis);
  const factualBasisIds = factualClaimEvidenceIds
    ? construct.basisEvidenceIds.filter(id => factualClaimEvidenceIds.has(String(id)))
    : construct.basisEvidenceIds;
  const knownEvidence = new Map(input.evidence.map(span => [String(span.id), span.id]));
  const premiseEvidenceIds = [...new Set(factualBasisIds)]
    .map(id => knownEvidence.get(String(id)))
    .filter((id): id is EvidenceId => Boolean(id));
  const plannerBootstrapScore = finiteNumber(trace.bootstrapScore) ?? creativeBootstrapScore(metrics);
  const scoreTrace = selection.source === "pairwise_preference"
    ? estimatorScore({
        value: Math.max(-64, Math.min(64, selection.score)),
        range: [-65, 65],
        meaning: "creative candidate pairwise preference score",
        inputs: [...creativeFeatureInputs(metrics), `modelHash:${selection.modelHash ?? "missing"}`],
        provenance: ["candidate.ts:creativeCandidate", selection.modelId ?? "creative.preference.model.missing"],
        failureModes: ["sparse_preference_pairs", "preference_distribution_shift"]
      })
    : provisionalHeuristicScore({
        value: Math.max(-1, Math.min(1, selection.score)),
        range: [-1.01, 1.01],
        meaning: "bootstrap creative candidate score",
        inputs: creativeFeatureInputs(metrics),
        provenance: ["candidate.ts:creativeCandidate", "SERIOUS_VERSION_MATH_APPENDIX.md:feedback"],
        failureModes: ["bootstrap_coefficients_not_learned", "unobserved_creative_preferences"]
      });
  return {
    id: `creative:${construct.id}:${candidateIndex}`,
    kind: "creative-candidate",
    answer,
    force: "invented",
    evidenceIds: premiseEvidenceIds,
    scores: {
      support: clamp01(construct.supportScore),
      contradiction: clamp01(Math.max(input.entailment.contradiction, metrics.risk)),
      faithfulness: metrics.graphCoherence,
      alphaPressure: clamp01(input.field.alphaTrace.surfaces.pressure),
      actionability: metrics.usefulness,
      evidenceCoverage: construct.basisEvidenceIds.length
        ? clamp01(premiseEvidenceIds.length / construct.basisEvidenceIds.length)
        : 0,
      novelty: metrics.novelty,
      realizability: metrics.languageRealizability,
      constraintCoverage: metrics.constraintCoverage,
      graphCoherence: metrics.graphCoherence,
      languageRealizability: metrics.languageRealizability,
      usefulness: metrics.usefulness,
      risk: metrics.risk,
      repetition: metrics.repetition,
      unsupportedFactualAssertion: metrics.unsupportedFactualAssertion,
      creativeSelectionScore: selection.score
    },
    boundaries: [
      "generated-material-not-evidence",
      ...(metrics.unsupportedFactualAssertion > 0 ? ["unsupported-factual-assertion-penalized"] : []),
      ...(metrics.risk > 0.66 ? ["creative-risk-material"] : [])
    ],
    audit: toJsonValue({
      source: "invention.construct",
      constructId: construct.id,
      proofStatusId: construct.proofStatusId,
      creativeMetrics: metrics,
      bootstrapScore: plannerBootstrapScore,
      selectionScore: selection.score,
      selectionSource: selection.source,
      preferenceModelId: selection.modelId ?? null,
      preferenceModelHash: selection.modelHash ?? null,
      claimBasis: trace.claimBasis ?? null,
      factualPremiseEvidenceIds: premiseEvidenceIds,
      droppedNonFactualBasisEvidenceIds: factualClaimEvidenceIds
        ? construct.basisEvidenceIds.filter(id => !factualClaimEvidenceIds.has(String(id)))
        : [],
      droppedUnknownBasisEvidenceIds: factualBasisIds.filter(id => !knownEvidence.has(String(id))),
      generatedMaterialRequiresEvidence: false,
      fakeCitationForbidden: true
    }),
    scoreTrace: [scoreTrace]
  };
}

function baseScores(input: { requestText: string; entailment: SemanticEntailmentResult; evidence: EvidenceSpan[]; field: FieldState }) {
  const requestFeatures = featureSet(input.requestText, 512);
  const evidenceCoverage = input.evidence.length ? mean(input.evidence.map(span => weightedJaccard(requestFeatures, span.features))) : 0;
  const green = greenPotentialTerms(input.field);
  return {
    support: clamp01(input.entailment.support * 0.82 + green.answerabilityPotential * 0.18),
    contradiction: clamp01(Math.max(input.entailment.contradiction, green.contradictionPotential * 0.42)),
    faithfulness: input.entailment.faithfulnessLcb,
    alphaPressure: clamp01(input.field.alphaTrace.surfaces.pressure * 0.72 + green.fieldEnergy * 0.28),
    actionability: clamp01(input.field.alphaTrace.surfaces.actionability * 0.76 + green.answerabilityPotential * 0.24),
    evidenceCoverage,
    novelty: input.field.alphaTrace.surfaces.drift,
    realizability: clamp01(1 - input.entailment.contradiction - input.field.alphaTrace.surfaces.risk * 0.35 - green.uncertaintyPotential * 0.12)
  };
}

function greenPotentialTerms(field: FieldState): {
  answerabilityPotential: number;
  contradictionPotential: number;
  uncertaintyPotential: number;
  fieldEnergy: number;
} {
  const row = jsonRecord(field.greenPotential);
  return {
    answerabilityPotential: clamp01(numberFromJson(row.answerabilityPotential)),
    contradictionPotential: clamp01(numberFromJson(row.contradictionPotential)),
    uncertaintyPotential: clamp01(numberFromJson(row.uncertaintyPotential)),
    fieldEnergy: clamp01(numberFromJson(row.fieldEnergy))
  };
}

function jsonRecord(value: JsonValue | undefined): Record<string, JsonValue | undefined> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, JsonValue | undefined> : {};
}

function numberFromJson(value: JsonValue | undefined): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function candidateMass(candidate: CandidateSurface): number {
  if (candidate.quality) {
    const q = candidate.quality;
    return clamp01(
      0.16 * q.requirementCoverage +
      0.12 * q.truthSupport +
      0.10 * q.sourceFidelity +
      0.10 * q.novelty +
      0.10 * q.inferentialContinuity +
      0.10 * q.executableCompleteness +
      0.08 * q.languageQuality +
      0.08 * q.usefulness +
      0.08 * q.coherence +
      0.08 * q.uncertaintyCalibration -
      0.22 * q.repetition -
      0.34 * q.contradiction -
      0.52 * q.unsupportedFactRate -
      0.90 * q.fakeFactualAuthority -
      1.00 * q.testWeakening -
      0.70 * q.telemetryLeak
    );
  }
  const s = candidate.scores;
  return clamp01(
    0.24 * forceWeight(candidate.force) +
      0.18 * s.support +
      0.14 * s.faithfulness +
      0.12 * s.alphaPressure +
      0.1 * s.evidenceCoverage +
      0.1 * s.actionability +
      0.08 * s.realizability +
      0.04 * s.novelty -
      0.2 * s.contradiction
  );
}

function candidateOperatorRows(
  candidates: readonly CandidateSurface[],
  requestedAuthority?: RequestedAuthority,
  calibrationModels?: CalibrationModelSet,
  requirementField?: TurnRequirementField
): Array<{
  candidateId: string;
  freeEnergy: number;
  boltzmannProbability: number;
  leastActionCost: number;
  leastActionReachable: boolean;
  selectionScore?: number;
  selectionSource?: string;
}> {
  const energies = candidates.map(candidate => {
    const complexity = Math.log2(2 + surfaceUnitCount(candidate.answer)) / 8;
    const error = clamp01(candidate.scores.contradiction * 0.48 + (1 - candidate.scores.faithfulness) * 0.34 + (1 - candidate.scores.realizability) * 0.18);
    const utility = clamp01(candidate.scores.actionability * 0.44 + candidate.scores.support * 0.36 + candidate.scores.evidenceCoverage * 0.2);
    return freeEnergyObjective({ error, complexity, utility, lambda: 0.26, gamma: 0.34 });
  });
  const creativeSelections = requestedAuthority === "creative"
    ? candidates.map(candidate => creativeAuthorityScore(candidate, calibrationModels))
    : undefined;
  const temperature = requirementField
    ? Math.max(0.08, Math.min(0.45, 0.24 + 0.14 * requirementField.noveltyDemand + 0.08 * requirementField.uncertaintyTolerance - 0.10 * requirementField.externalTruthAuthority - 0.10 * requirementField.actionCommitment))
    : candidates.some(candidate => candidate.force === "invented") ? 0.28 : 0.16;
  const probabilities = creativeSelections
    ? boltzmannDistribution({ energies: creativeSelections.map(item => -item.score), temperature: 0.28 })
    : boltzmannDistribution({ energies, temperature });
  const nodes = ["request", ...candidates.map(candidate => candidate.id)];
  const edges = candidates.map((candidate, index) => ({ source: "request", target: candidate.id, cost: energies[index] ?? 1, id: `candidate.edge.${index}` }));
  return candidates.map((candidate, index) => {
    const path = leastActionPath({ nodes, edges, source: "request", target: candidate.id });
    return {
      candidateId: candidate.id,
      freeEnergy: energies[index] ?? 0,
      boltzmannProbability: probabilities[index] ?? 0,
      leastActionCost: Number.isFinite(path.cost) ? path.cost : 1,
      leastActionReachable: path.reachable,
      selectionScore: creativeSelections?.[index]?.score,
      selectionSource: creativeSelections?.[index]?.source
    };
  });
}

function creativeAuthorityScore(candidate: CandidateSurface, calibrationModels?: CalibrationModelSet): { score: number; source: string } {
  const features = creativeFeaturesFromCandidate(candidate);
  if (features) {
    const selection = creativePreferenceScore({
      features,
      modelSet: calibrationModels,
      taskClass: CALIBRATION_TASK_CLASS_IDS.creativeGeneration
    });
    return { score: selection.score, source: selection.source };
  }
  const telemetryPenalty = looksStructuredTelemetry(candidate.answer) ? 0.48 : 0;
  return {
    score: -0.28 + 0.08 * candidate.scores.actionability + 0.06 * candidate.scores.realizability - 0.2 * candidate.scores.contradiction - telemetryPenalty,
    source: "noncreative_authority_mismatch"
  };
}

function surfaceUnitCount(text: string): number {
  return (text.match(/[\p{L}\p{N}_]+/gu) ?? []).length;
}

function creativeMetricsFromConstruct(construct: InventionConstruct): CreativePreferenceFeatureVector {
  const trace = jsonRecord(construct.trace);
  return {
    constraintCoverage: metric(trace.constraintCoverage, construct.supportScore),
    graphCoherence: metric(trace.graphCoherence, construct.supportScore),
    novelty: metric(trace.novelty, construct.noveltyScore),
    languageRealizability: metric(trace.languageRealizability, 0),
    usefulness: metric(trace.usefulness, construct.supportScore),
    risk: metric(trace.risk, construct.riskScore),
    repetition: metric(trace.repetition, 0),
    unsupportedFactualAssertion: metric(trace.unsupportedFactualAssertion, 0)
  };
}

function creativeFeaturesFromCandidate(candidate: CandidateSurface): CreativePreferenceFeatureVector | undefined {
  const scores = candidate.scores;
  if (candidate.kind !== "creative-candidate") return undefined;
  return {
    constraintCoverage: clamp01(scores.constraintCoverage ?? 0),
    graphCoherence: clamp01(scores.graphCoherence ?? 0),
    novelty: clamp01(scores.novelty),
    languageRealizability: clamp01(scores.languageRealizability ?? scores.realizability),
    usefulness: clamp01(scores.usefulness ?? scores.actionability),
    risk: clamp01(scores.risk ?? scores.contradiction),
    repetition: clamp01(scores.repetition ?? 0),
    unsupportedFactualAssertion: clamp01(scores.unsupportedFactualAssertion ?? 0)
  };
}

function creativeFeatureInputs(features: CreativePreferenceFeatureVector): string[] {
  return [
    `constraintCoverage:${features.constraintCoverage}`,
    `graphCoherence:${features.graphCoherence}`,
    `novelty:${features.novelty}`,
    `languageRealizability:${features.languageRealizability}`,
    `usefulness:${features.usefulness}`,
    `risk:${features.risk}`,
    `repetition:${features.repetition}`,
    `unsupportedFactualAssertion:${features.unsupportedFactualAssertion}`
  ];
}

function metric(value: JsonValue | undefined, fallback: number): number {
  return clamp01(finiteNumber(value) ?? fallback);
}

function finiteNumber(value: JsonValue | undefined): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function factualPremiseEvidenceIds(value: JsonValue | undefined): Set<string> | undefined {
  if (!Array.isArray(value)) return undefined;
  const evidenceIds = new Set<string>();
  for (const item of value) {
    const row = jsonRecord(item);
    const factualPremise = row.kind === "factual_premise" && (row.force === "observed" || row.force === "proved");
    if (!factualPremise || !Array.isArray(row.evidenceIds)) continue;
    for (const evidenceId of row.evidenceIds) if (typeof evidenceId === "string") evidenceIds.add(evidenceId);
  }
  return evidenceIds;
}

function forceWeight(force: EpistemicForce): number {
  if (force === "proved") return 1;
  if (force === "observed") return 0.86;
  if (force === "inferred") return 0.66;
  if (force === "conjectured") return 0.48;
  if (force === "invented") return 0.66;
  return 0.18;
}

function candidateId(kind: string, entailment: SemanticEntailmentResult, answer: string): string {
  return `${kind}:${entailment.proof.id}:${answer.length}:${Math.abs(hash32(answer)).toString(16)}`;
}

function hash32(text: string): number {
  let h = 2166136261;
  for (let i = 0; i < text.length; i++) h = Math.imul(h ^ text.charCodeAt(i), 16777619);
  return h >>> 0;
}

function compactCandidate(candidate: CandidateSurface): JsonValue {
  return toJsonValue({ id: candidate.id, kind: candidate.kind, force: candidate.force, scores: candidate.scores, boundaries: candidate.boundaries, evidenceIds: candidate.evidenceIds });
}

function massReason(candidate: CandidateSurface): string {
  const s = candidate.scores;
  return `force=${candidate.force} support=${s.support.toFixed(3)} faith=${s.faithfulness.toFixed(3)} alpha=${s.alphaPressure.toFixed(3)} contradiction=${s.contradiction.toFixed(3)}`;
}

function proofMetrics(entailment: SemanticEntailmentResult): JsonValue {
  return toJsonValue({
    force: entailment.force,
    support: entailment.support,
    contradiction: entailment.contradiction,
    faithfulnessLcb: entailment.faithfulnessLcb,
    proofId: entailment.proof.id
  });
}

export function structuredSurface(value: JsonValue): string {
  if (!value || typeof value !== "object" || Array.isArray(value)) return String(value ?? "");
  const record = value as Record<string, JsonValue>;
  return canonicalStringify({
    schema: "scce.surface.candidate.v1",
    ...record
  });
}
