// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
import { describe, expect, it } from "vitest";
import { createCorrectionObservation } from "../correction-observation.js";
import { createCorrectionEngine } from "../translation-correction-engine.js";
import { userCorrectionFromOutcome } from "../dialogue-learning.js";

describe("shared correction observations", () => {
  it("retains dialogue and translation identities while preserving specialized term data", () => {
    const alignment = createCorrectionEngine({ clock: { now: () => 10 } }).recordFeedback({
      episodeId: "turn.translation" as never,
      sourceLanguage: "lang.source",
      targetLanguage: "lang.target",
      sourceText: "source value",
      generatedTranslation: "prior value",
      correctedTranslation: "corrected value",
      protectedTerms: ["value"],
      changedTerms: [{ original: "prior", corrected: "corrected", reason: "owner" }],
      sourceProfileId: "model.source",
      targetProfileId: "model.target",
      evidenceIds: []
    });
    const observation = createCorrectionObservation({
      target: { kind: "translation", id: alignment.id },
      prior: { surface: alignment.previousOutput },
      corrected: { surface: alignment.correctedOutput },
      scope: {
        conversationId: "conversation.correction",
        turnId: "turn.translation",
        sourceLanguage: alignment.sourceLanguage,
        targetLanguage: alignment.targetLanguage,
        sourceProfileId: alignment.sourceProfileId,
        targetProfileId: alignment.targetProfileId
      },
      confidence: alignment.alpha,
      cause: {
        id: "cause.translation_surface_correction.v1",
        kind: "translation_surface_correction",
        provenance: { changedTerms: alignment.changedTerms, protectedTerms: alignment.protectedTerms }
      },
      provenance: { sourceRecordId: "outcome.translation", evidenceIds: [] },
      affectedModelIds: [alignment.sourceProfileId, alignment.targetProfileId]
    });
    const correction = userCorrectionFromOutcome({
      outcome: {
        id: "outcome.dialogue",
        conversationId: "conversation.correction",
        turnId: "turn.translation",
        promptHash: "prompt.hash",
        responseHash: "response.hash",
        requestedConstraintRefs: [],
        satisfiedConstraintRefs: [],
        failedConstraintRefs: [],
        scoreTraceRefs: [],
        createdAt: "2026-01-01T00:00:00.000Z"
      },
      correctionText: alignment.correctedOutput,
      correctionObservation: observation,
      now: 10
    });

    expect(correction.preferenceDeltaJson).toMatchObject({
      correctionObservation: {
        schema: "scce.correction.observation.v1",
        target: { kind: "translation", id: alignment.id },
        prior: { surfaceId: expect.any(String) },
        corrected: { surfaceId: expect.any(String) },
        scope: { conversationId: "conversation.correction", targetLanguage: "lang.target" },
        affectedModelIds: ["model.source", "model.target"]
      }
    });
    expect(observation.cause.provenance).toMatchObject({
      changedTerms: [{ original: "prior", corrected: "corrected" }]
    });
  });
});
