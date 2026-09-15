// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
import { describe, expect, it } from "vitest";
import {
  CALIBRATION_TASK_CLASS_IDS,
  calibrationObservationsFromDialogueOutcome,
  buildTurnDialogueBridge,
  realizeDialogueResponse,
  type DialogueAnswerGraphLike,
  type TurnResult,
  type EpisodeId
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

  it.each([
    CALIBRATION_TASK_CLASS_IDS.codeAnswer,
    CALIBRATION_TASK_CLASS_IDS.creativeGeneration,
    CALIBRATION_TASK_CLASS_IDS.translation
  ])("carries an opaque kernel task receipt into bridge outcome routing (%s)", taskClass => {
    const bridge = buildTurnDialogueBridge({
      requestText: "Ø§Ø´Ø±Ø­ Ð´Ð°Ð½Ð½Ñ‹Ðµ.",
      conversationId: "conversation.typed-routing",
      result: minimalTurnResult(taskClass),
      calibrationTaskClass: CALIBRATION_TASK_CLASS_IDS.dialogueOutcome
    });
    const observations = calibrationObservationsFromDialogueOutcome({
      result: bridge.pragmatics,
      outcome: { id: `outcome.${taskClass}`, responseHash: "hash", accepted: true, failedConstraintRefs: [], scoreTraceRefs: [], createdAt: new Date(0).toISOString() }
    });

    expect(bridge.pragmatics.state.taskClassId).toBe(taskClass);
    expect(observations[0]?.taskClass).toBe(taskClass);
  });
});

function minimalTurnResult(calibrationTaskClass: string): TurnResult {
  return {
    episodeId: "episode.typed-routing" as EpisodeId,
    answer: "ÐžÑ‚Ð²ÐµÑ‚.",
    epistemicForce: "observed",
    calibrationTaskClass,
    evidence: [],
    field: {} as TurnResult["field"],
    entailment: { contradiction: 0 } as TurnResult["entailment"],
    constructGraph: {
      id: "construct.typed-routing" as TurnResult["constructGraph"]["id"],
      episodeId: "episode.typed-routing" as EpisodeId,
      forceVector: {},
      nodes: [],
      edges: [],
      artifacts: []
    },
    validationGraph: {} as TurnResult["validationGraph"],
    emissionGraph: {} as TurnResult["emissionGraph"],
    forecast: {} as TurnResult["forecast"],
    learningNeeds: [],
    scoreTraces: [],
    calibrationStatus: "uncalibrated",
    truthState: {
      symbolicState: "truth.insufficient_evidence",
      beliefLower: 0,
      plausibilityUpper: 0,
      supportMass: 0,
      contradictionMass: 0,
      uncertaintyMass: 1,
      validityInterval: null,
      evidenceForce: "unknown",
      freshness: 0,
      sourceDiversity: 0
    },
    evidenceForce: "unknown",
    guardFlags: {
      requireEvidence: true,
      blockCertifiedFact: true,
      allowInference: false,
      allowCreative: false,
      exposeContradiction: false,
      sourceBacked: false,
      missingEvidence: true,
      contradictionPresent: false,
      preservationChecked: true,
      unsupportedContentBlocked: true
    },
    events: []
  };
}

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
