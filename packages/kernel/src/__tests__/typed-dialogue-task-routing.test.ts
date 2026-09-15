// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
import { describe, expect, it } from "vitest";
import {
  CALIBRATION_TASK_CLASS_IDS,
  calibrationObservationsFromDialogueOutcome,
  realizeDialogueResponse,
  type DialogueAnswerGraphLike
} from "../index.js";

describe("typed dialogue task routing", () => {
  it("does not classify an opaque non-English task by surface vocabulary", () => {
    const result = realizeDialogueResponse({
      requestText: "Expliquez ceci en détail, s'il vous plaît.",
      statePatch: { activeTask: "任务.opaque.7" },
      answerGraph: graph()
    });

    const observations = calibrationObservationsFromDialogueOutcome({
      result,
      outcome: { id: "outcome.opaque", responseHash: "hash", accepted: true, failedConstraintRefs: [], scoreTraceRefs: [], createdAt: new Date(0).toISOString() }
    });

    expect(observations[0]?.taskClass).toBe(CALIBRATION_TASK_CLASS_IDS.dialogueOutcome);
  });

  it("uses the task class selected by the typed request path", () => {
    const result = realizeDialogueResponse({
      requestText: "建造一个新组件。",
      statePatch: { taskClassId: CALIBRATION_TASK_CLASS_IDS.workspaceAnswer },
      answerGraph: graph()
    });

    const observations = calibrationObservationsFromDialogueOutcome({
      result,
      outcome: { id: "outcome.typed", responseHash: "hash", accepted: true, failedConstraintRefs: [], scoreTraceRefs: [], createdAt: new Date(0).toISOString() }
    });

    expect(observations[0]?.taskClass).toBe(CALIBRATION_TASK_CLASS_IDS.workspaceAnswer);
    expect(observations.some(item => item.calibrationId === "workspace.answer_confidence")).toBe(true);
  });
});

function graph(): DialogueAnswerGraphLike {
  return {
    id: "answer_graph.typed_task",
    claims: [{ id: "claim.typed_task", surface: "Δx = 1", certified: true }],
    supportLinks: [{ claimId: "claim.typed_task", evidenceId: "evidence.typed_task" }],
    caveats: [],
    actions: [],
    uncertainty: { unsupported: false, missingEvidenceCount: 0, contradictionCount: 0, gapCount: 0 }
  };
}
