// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
import { describe, expect, it } from "vitest";
import { CALIBRATION_IDS } from "../calibration-spine.js";
import { persistDialogueOutcomeAndLearn } from "../dialogue-learning.js";

// CALIBRATION_IDS.evidenceAlpha was declared with no producer and no consumer: a registered slot nothing wrote
// to, while evidenceAlpha itself decided the alpha stamped on every span ever ingested.
//
// The producer does NOT belong in the ingestor. A calibration observation needs a raw score and a label; the
// ingestor has the score and can never have the label, because whether a span was worth learning is only
// revealed when something cites it and a person grades the answer. Rows written at ingest would never be
// labelled. Nor does anything need duplicating: alpha is already durable on the span. Score and label first
// exist together at grading, so that is where the observation is made.

const RESULT = {
  id: "trace_fixture",
  evidenceIds: ["evidence_a", "evidence_b"],
  finalText: "an answer",
  selected: { textHash: "hash_answer", score: 0.9 },
  criticResults: [],
  state: {
    conversationId: "conversation_fixture",
    turnId: "turn_fixture",
    communicativeActId: "act.answer",
    userStyleProfile: undefined
  },
  policyDecision: {
    targetProfileId: "profile_fixture",
    selectedActionIds: ["action.answer"],
    rankedActions: []
  }
} as never;

function store() {
  const written: Record<string, unknown[]> = {
    outcomes: [], corrections: [], snapshots: [], patterns: [], calibrations: []
  };
  return {
    written,
    store: {
      async putConversationOutcome(record: unknown) { written.outcomes.push(record); },
      async putUserCorrection(record: unknown) { written.corrections.push(record); },
      async putStyleSnapshot(record: unknown) { written.snapshots.push(record); },
      async putTargetProfilePattern(record: unknown) { written.patterns.push(record); },
      async putCalibrationObservation(record: unknown) { written.calibrations.push(record); },
      async listCalibrationObservations() { return written.calibrations; },
      async putInteractionState() { /* not exercised */ },
      async putDialoguePolicyDecision() { /* not exercised */ },
      async putResponseCandidate() { /* not exercised */ }
    } as never
  };
}

describe("evidence alpha gets its label where the label exists", () => {
  it("emits one observation per cited span, scored by the alpha the ingestor measured", async () => {
    const fixture = store();
    const { calibrationObservations } = await persistDialogueOutcomeAndLearn({
      store: fixture.store,
      result: RESULT,
      promptText: "a question",
      accepted: true,
      taskClass: "task.general_cognition",
      citedEvidence: [
        { id: "evidence_a", alpha: 0.81, status: "promoted" },
        { id: "evidence_b", alpha: 0.42, status: "quarantined" }
      ],
      now: 1_000
    });

    const alphaObservations = calibrationObservations
      .filter(observation => observation.calibrationId === CALIBRATION_IDS.evidenceAlpha);
    expect(alphaObservations).toHaveLength(2);

    // The raw score is the span's own ingest-time alpha, carried through unaltered.
    expect(alphaObservations.map(observation => observation.rawScore).sort()).toEqual([0.42, 0.81]);
    // And the label is this grade, identical for every span the same answer cited.
    for (const observation of alphaObservations) {
      expect(observation.outcome).toBe(true);
      expect(observation.accepted).toBe(true);
      expect(observation.sourceTraceId).toBe("trace_fixture");
    }
  });

  it("labels the same spans false when the answer was rejected", async () => {
    const fixture = store();
    const { calibrationObservations } = await persistDialogueOutcomeAndLearn({
      store: fixture.store,
      result: RESULT,
      promptText: "a question",
      rejected: true,
      citedEvidence: [{ id: "evidence_a", alpha: 0.81 }],
      now: 1_000
    });
    const alpha = calibrationObservations.find(o => o.calibrationId === CALIBRATION_IDS.evidenceAlpha);
    expect(alpha).toBeDefined();
    expect(alpha!.outcome).toBe(false);
    expect(alpha!.rejected).toBe(true);
  });

  it("records that the sample is conditioned on retrieval", async () => {
    // Only spans that were RETRIEVED can ever be labelled, so anything fitting on these learns about alpha
    // among spans retrieval already surfaced. That conditioning is written down rather than left to be
    // rediscovered by whoever fits the model.
    const fixture = store();
    const { calibrationObservations } = await persistDialogueOutcomeAndLearn({
      store: fixture.store,
      result: RESULT,
      promptText: "a question",
      accepted: true,
      citedEvidence: [{ id: "evidence_a", alpha: 0.7, status: "promoted" }],
      now: 1_000
    });
    const alpha = calibrationObservations.find(o => o.calibrationId === CALIBRATION_IDS.evidenceAlpha)!;
    const metadata = alpha.metadata as Record<string, unknown>;
    expect(metadata.conditionedOnRetrieval).toBe(true);
    expect(metadata.evidenceId).toBe("evidence_a");
    expect(metadata.evidenceStatus).toBe("promoted");
  });

  it("emits nothing when the answer cited nothing, rather than inventing a sample", async () => {
    const fixture = store();
    const { calibrationObservations } = await persistDialogueOutcomeAndLearn({
      store: fixture.store,
      result: RESULT,
      promptText: "a question",
      accepted: true,
      now: 1_000
    });
    expect(calibrationObservations.filter(o => o.calibrationId === CALIBRATION_IDS.evidenceAlpha)).toHaveLength(0);
  });
});
