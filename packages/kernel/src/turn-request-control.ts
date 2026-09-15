// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
import { CALIBRATION_IDS, CALIBRATION_TASK_CLASS_IDS } from "./calibration-spine.js";
import {
  jsonRecord,
  kernelNumber,
  kernelString
} from "./kernel-answer-primitives.js";
import { toJsonValue } from "./primitives.js";
import type { CalibrationObservationRecord } from "./calibration-spine.js";
import { explicitAuthorityRequirements } from "./request-authority.js";
import {
  COGNITIVE_OPERATOR_IDS,
  TURN_REQUIREMENT_DIMENSIONS,
  type CognitiveOperatorId,
  type ExplicitTurnRequirement,
  type TurnRequirementField
} from "./turn-requirements.js";
import type {
  EpisodeId,
  JsonValue,
  OwnerInput,
  RequestedAuthority
} from "./types.js";

function calibrationTaskClassForAuthority(authority: RequestedAuthority): string {
  if (authority === "creative") return CALIBRATION_TASK_CLASS_IDS.creativeGeneration;
  if (authority === "program") return CALIBRATION_TASK_CLASS_IDS.codeAnswer;
  if (authority === "action") return CALIBRATION_TASK_CLASS_IDS.workspaceAnswer;
  if (authority === "reasoned" || authority === "translation") return CALIBRATION_TASK_CLASS_IDS.dialogueOutcome;
  return CALIBRATION_TASK_CLASS_IDS.sourceBoundQa;
}

export function calibrationTaskClassForRequirements(
  requirements: TurnRequirementField,
  authority: RequestedAuthority
): string {
  if (requirements.executableArtifactDemand >= 0.6) {
    return authority === "action" ? CALIBRATION_TASK_CLASS_IDS.workspaceAnswer : CALIBRATION_TASK_CLASS_IDS.codeAnswer;
  }
  if (requirements.noveltyDemand >= 0.6) return CALIBRATION_TASK_CLASS_IDS.creativeGeneration;
  if (requirements.surfaceTransformation >= 0.6 && requirements.semanticPreservation >= 0.6) {
    return CALIBRATION_TASK_CLASS_IDS.translation;
  }
  if (
    requirements.inferentialDepth >= 0.5
    || requirements.causalReasoningDemand >= 0.5
    || requirements.temporalReasoningDemand >= 0.5
    || requirements.counterfactualDemand >= 0.5
  ) {
    return CALIBRATION_TASK_CLASS_IDS.generalCognition;
  }
  return calibrationTaskClassForAuthority(authority);
}

export function explicitTurnRequirementsFromInput(
  input: OwnerInput,
  authority?: RequestedAuthority
): ExplicitTurnRequirement[] {
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
  return [
    ...explicit,
    ...explicitAuthorityRequirements({
      requestText: input.text,
      authority,
      sourceId: "OwnerInput.requestedAuthority"
    })
  ];
}

export function requirementContextFromMetadata(
  metadata: JsonValue | undefined
): Partial<Record<(typeof TURN_REQUIREMENT_DIMENSIONS)[number], number>> {
  const root = jsonRecord(metadata);
  const context = jsonRecord(root.requirementContext);
  const out: Partial<Record<(typeof TURN_REQUIREMENT_DIMENSIONS)[number], number>> = {};
  for (const dimension of TURN_REQUIREMENT_DIMENSIONS) {
    const value = context[dimension];
    if (typeof value === "number" && Number.isFinite(value)) {
      out[dimension] = Math.max(-4, Math.min(4, value));
    }
  }
  return out;
}

export interface EvidenceAccessPolicy {
  /** Whether repository and construction evidence may participate in this turn's retrieval routes. */
  readonly sourceCodeEvidenceAllowed: boolean;
  /** Whether this operator set requires source code as the evidence substrate. */
  readonly sourceCodeEvidenceRequired: boolean;
}

/**
 * Maps already-selected cognitive operators to physical evidence access. This
 * is a serving policy, not a second interpretation of request text: every
 * domain reaches it through the same typed operator state.
 */
export function evidenceAccessPolicyForOperators(operatorIds: readonly CognitiveOperatorId[]): EvidenceAccessPolicy {
  const active = new Set(operatorIds);
  const sourceCodeEvidenceRequired = active.has(COGNITIVE_OPERATOR_IDS.programPlanning)
    || active.has(COGNITIVE_OPERATOR_IDS.workspaceRepair);
  return {
    sourceCodeEvidenceAllowed: sourceCodeEvidenceRequired,
    sourceCodeEvidenceRequired
  };
}

export function operatorOutcomeSupport(
  metadata: JsonValue | undefined
): Partial<Record<CognitiveOperatorId, number>> {
  const root = jsonRecord(metadata);
  const support = jsonRecord(root.operatorOutcomeSupport);
  const out: Partial<Record<CognitiveOperatorId, number>> = {};
  for (const operatorId of Object.values(COGNITIVE_OPERATOR_IDS)) {
    const value = support[operatorId];
    if (typeof value === "number" && Number.isFinite(value)) {
      out[operatorId] = Math.max(-1, Math.min(1, value));
    }
  }
  return out;
}

/**
 * Replays only operator outcomes that were actually recorded for this
 * conversation.  Calibration metadata is an audit boundary: malformed rows,
 * unknown operators, and rows without a finite score are ignored rather than
 * becoming an inferred signal.  A successful observation contributes its
 * recorded score; a failed observation contributes the negative score.
 */
export function operatorOutcomeSupportFromCalibrationObservations(
  observations: readonly CalibrationObservationRecord[],
  conversationId: string
): Partial<Record<CognitiveOperatorId, number>> {
  const sums = new Map<CognitiveOperatorId, { weighted: number; weight: number }>();
  for (const observation of observations) {
    if (observation.calibrationId !== CALIBRATION_IDS.operatorOutcome) continue;
    if (!Number.isFinite(observation.rawScore)) continue;
    const metadata = jsonRecord(observation.metadata);
    if (kernelString(metadata.schema) !== "scce.operator.outcome_observation.v1") continue;
    if (kernelString(metadata.conversationId) !== conversationId) continue;
    const operatorIds = Array.isArray(metadata.operatorIds)
      ? metadata.operatorIds.filter((value): value is string => typeof value === "string")
      : [];
    const score = Math.max(0, Math.min(1, observation.rawScore));
    for (const operatorId of operatorIds) {
      if (!(Object.values(COGNITIVE_OPERATOR_IDS) as string[]).includes(operatorId)) continue;
      const typedOperatorId = operatorId as CognitiveOperatorId;
      const previous = sums.get(typedOperatorId) ?? { weighted: 0, weight: 0 };
      previous.weighted += (observation.outcome ? score : -score);
      previous.weight += 1;
      sums.set(typedOperatorId, previous);
    }
  }
  return Object.fromEntries([...sums.entries()].map(([operatorId, value]) => [
    operatorId,
    Math.max(-1, Math.min(1, value.weighted / Math.max(1, value.weight)))
  ])) as Partial<Record<CognitiveOperatorId, number>>;
}

function isTurnRequirementDimension(value: string): value is (typeof TURN_REQUIREMENT_DIMENSIONS)[number] {
  return (TURN_REQUIREMENT_DIMENSIONS as readonly string[]).includes(value);
}

export function requestedAuthorityFromTurnInput(
  input: OwnerInput,
  translationTarget?: string
): RequestedAuthority | undefined {
  if (isRequestedAuthority(input.requestedAuthority)) return input.requestedAuthority;
  const metadata = jsonRecord(input.metadata);
  const nested = jsonRecord(metadata.request);
  const explicit = metadata.requestedAuthority ?? nested.requestedAuthority;
  if (isRequestedAuthority(explicit)) return explicit;
  return translationTarget ? "translation" : undefined;
}

function isRequestedAuthority(value: unknown): value is RequestedAuthority {
  return value === "factual"
    || value === "reasoned"
    || value === "creative"
    || value === "translation"
    || value === "program"
    || value === "action";
}

export function evaluationQuestionId(metadata: JsonValue | undefined, episodeId: EpisodeId): string {
  const record = jsonRecord(metadata);
  return kernelString(record.questionId)
    ?? kernelString(record.benchmarkTaskId)
    ?? kernelString(jsonRecord(record.evaluation).questionId)
    ?? String(episodeId);
}
