// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
import { describe, expect, it } from "vitest";
import { createInMemoryDialogueMemoryStore } from "../dialogue-learning.js";
import {
  activateCognitiveOperatorsWithOutcomeSupport,
  persistOperatorOutcome
} from "../operator-outcome-loop.js";
import {
  COGNITIVE_OPERATOR_IDS,
  deriveTurnRequirementField
} from "../turn-requirements.js";

describe("operator outcome feedback loop", () => {
  it("persists typed action deltas and changes the next turn's operator routing", async () => {
    const store = createInMemoryDialogueMemoryStore();
    const field = deriveTurnRequirementField({
      requestText: "opaque request",
      explicitRequirements: [{
        dimension: "actionCommitment",
        value: 0.9,
        semanticRoleId: "role.fixture.action",
        learnedFrameOrPatternId: "frame.fixture.action"
      }]
    });
    const before = await activateCognitiveOperatorsWithOutcomeSupport({
      requirementField: field,
      store,
      conversationId: "conversation.feedback"
    });
    const beforeAction = before.find(row => row.operatorId === COGNITIVE_OPERATOR_IDS.actionPlanning);
    expect(beforeAction).toBeDefined();

    await persistOperatorOutcome(store, {
      conversationId: "conversation.feedback",
      actionId: "action.fixture.1",
      capabilityId: "capability.fixture",
      operatorIds: [COGNITIVE_OPERATOR_IDS.actionPlanning],
      typedInputState: { phase: "before" },
      predictedDelta: { state: "ready" },
      actualDelta: { state: "blocked" },
      outcome: false,
      rawScore: 1,
      createdAt: 1
    });
    await store.putCalibrationObservation({
      ...(await store.listCalibrationObservations({ sourceRecordId: "action.fixture.1" }))[0]!,
      id: "calibration.observation.unrelated",
      calibrationId: "calibration.unrelated",
      outcome: true,
      rawScore: 1,
      sourceRecordId: "unrelated.fixture"
    });

    const stored = await store.listCalibrationObservations({ sourceRecordId: "action.fixture.1" });
    expect(stored).toHaveLength(1);
    expect(stored[0]?.metadata).toMatchObject({
      schema: "scce.operator.outcome_observation.v1",
      typedInputState: { phase: "before" },
      predictedDelta: { state: "ready" },
      actualDelta: { state: "blocked" },
      operatorIds: [COGNITIVE_OPERATOR_IDS.actionPlanning]
    });

    const after = await activateCognitiveOperatorsWithOutcomeSupport({
      requirementField: field,
      store,
      conversationId: "conversation.feedback"
    });
    const afterAction = after.find(row => row.operatorId === COGNITIVE_OPERATOR_IDS.actionPlanning);
    expect(afterAction?.support.outcome).toBe(-1);
    expect(afterAction?.activation).toBeLessThan(beforeAction!.activation);
  });
});
