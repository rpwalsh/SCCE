// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
import {
  CALIBRATION_IDS,
  CALIBRATION_SUBSYSTEM_IDS,
  CALIBRATION_TASK_CLASS_IDS,
  calibrationObservationRecord,
  type CalibrationObservationRecord
} from "./calibration-spine.js";
import {
  activateCognitiveOperators,
  type ActivateCognitiveOperatorsInput,
  type CognitiveOperatorId
} from "./turn-requirements.js";
import { operatorOutcomeSupportFromCalibrationObservations } from "./turn-request-control.js";
import type { DialogueMemoryStore } from "./storage.js";
import { clamp01, toJsonValue } from "./primitives.js";
import type { JsonValue } from "./types.js";

/** The state observed around one operator-backed action. */
export interface OperatorOutcomeInput {
  conversationId: string;
  actionId: string;
  capabilityId: string;
  operatorIds: readonly CognitiveOperatorId[];
  typedInputState: JsonValue;
  predictedDelta: JsonValue;
  actualDelta: JsonValue;
  outcome: boolean;
  rawScore?: number;
  sourceTraceId?: string;
  createdAt?: number;
}

/** Encode action feedback in the existing calibration record so the durable store and learner stay one lane. */
export function operatorOutcomeCalibrationObservation(input: OperatorOutcomeInput): CalibrationObservationRecord {
  return calibrationObservationRecord({
    calibrationId: CALIBRATION_IDS.operatorOutcome,
    subsystemId: CALIBRATION_SUBSYSTEM_IDS.operator,
    taskClass: CALIBRATION_TASK_CLASS_IDS.generalCognition,
    rawScore: clamp01(input.rawScore ?? (input.outcome ? 1 : 0)),
    outcome: input.outcome,
    finalOutcome: input.outcome ? "operator.outcome.accepted" : "operator.outcome.rejected",
    sourceTraceId: input.sourceTraceId,
    sourceRecordId: input.actionId,
    metadata: toJsonValue({
      schema: "scce.operator.outcome_observation.v1",
      conversationId: input.conversationId,
      actionId: input.actionId,
      capabilityId: input.capabilityId,
      operatorIds: [...input.operatorIds],
      typedInputState: input.typedInputState,
      predictedDelta: input.predictedDelta,
      actualDelta: input.actualDelta
    }),
    createdAt: input.createdAt,
    idSeed: `operator-outcome:${input.actionId}`
  });
}

/** Persist action feedback through the existing durable calibration store. */
export async function persistOperatorOutcome(
  store: Pick<DialogueMemoryStore, "putCalibrationObservation"> | undefined,
  input: OperatorOutcomeInput
): Promise<CalibrationObservationRecord | undefined> {
  if (!store) return undefined;
  const observation = operatorOutcomeCalibrationObservation(input);
  await store.putCalibrationObservation(observation);
  return observation;
}

/** Replay only this conversation's recorded action outcomes for the next routing decision. */
export async function operatorOutcomeSupportForConversation(
  store: Pick<DialogueMemoryStore, "listCalibrationObservations">,
  conversationId: string,
  limit = 256
): Promise<Partial<Record<CognitiveOperatorId, number>>> {
  const observations = await store.listCalibrationObservations({ limit: Math.max(1, Math.min(2_000, Math.floor(limit))) });
  return operatorOutcomeSupportFromCalibrationObservations(observations, conversationId);
}

/** Route a later turn with the persisted outcome support folded into the existing activation equation. */
export async function activateCognitiveOperatorsWithOutcomeSupport(
  input: ActivateCognitiveOperatorsInput & {
    store: Pick<DialogueMemoryStore, "listCalibrationObservations">;
    conversationId: string;
    outcomeLimit?: number;
  }
) {
  const prior = await operatorOutcomeSupportForConversation(input.store, input.conversationId, input.outcomeLimit);
  return activateCognitiveOperators({
    ...input,
    outcomeSupport: { ...prior, ...input.outcomeSupport }
  });
}
