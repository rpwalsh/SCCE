import { describe, expect, it } from "vitest";
import { buildCalibrationModel } from "../scoring/calibration.js";
import { calibrationObservationRecord } from "../calibration-spine.js";
import { createCcrEngine, type CcrInput } from "../ccr.js";
import { targetProfilePatternRecord } from "../dialogue-learning.js";
import { createIdFactory } from "../ids.js";
import { createAlignmentEngine } from "../multilingual-alignment.js";
import {
  applyUserCorrection,
  buildLanguageProfile,
  trainLexicalAlignment,
  validateRoundTrip,
  type MultilingualTranslationMemory
} from "../multilingual-translation.js";
import { createClock, createHasher } from "../primitives.js";
import { createCorrectionEngine, type TranslationFeedback } from "../translation-correction-engine.js";
import type { Clock, EpisodeId } from "../types.js";

describe("semantic runtime deterministic replay", () => {
  it("keeps CCR recency scoring stable under an injected clock", () => {
    const first = createCcrEngine({ clock: fixedClock() }).run(ccrInput());
    const second = createCcrEngine({ clock: fixedClock() }).run(ccrInput());

    expect(second.l1).toEqual(first.l1);
    expect(second.audit).toEqual(first.audit);
  });

  it("replays calibration and dialogue record timestamps and identities exactly", () => {
    const observationInput = {
      calibrationId: "fixture.calibration",
      subsystemId: "fixture.subsystem",
      taskClass: "fixture.task",
      rawScore: 0.75,
      outcome: true
    };
    const firstObservation = calibrationObservationRecord({ ...observationInput, clock: fixedClock() });
    const secondObservation = calibrationObservationRecord({ ...observationInput, clock: fixedClock() });
    const firstModel = buildCalibrationModel({
      id: "fixture.model",
      taskClass: "fixture.task",
      points: [{ raw: 0.75, outcome: true }],
      clock: fixedClock()
    });
    const secondModel = buildCalibrationModel({
      id: "fixture.model",
      taskClass: "fixture.task",
      points: [{ raw: 0.75, outcome: true }],
      clock: fixedClock()
    });
    const firstPattern = targetProfilePatternRecord({
      targetProfileId: "profile.fixture",
      patternFamilyId: "pattern.fixture",
      patternJson: { value: 1 },
      clock: fixedClock()
    });
    const secondPattern = targetProfilePatternRecord({
      targetProfileId: "profile.fixture",
      patternFamilyId: "pattern.fixture",
      patternJson: { value: 1 },
      clock: fixedClock()
    });

    expect(secondObservation).toEqual(firstObservation);
    expect(secondModel).toEqual(firstModel);
    expect(secondPattern).toEqual(firstPattern);
  });

  it("replays multilingual alignments, corrections, and round trips with Clock and IdFactory", () => {
    const firstRuntime = replayRuntime();
    const secondRuntime = replayRuntime();
    const corpus = {
      sourceLanguage: "lang.source",
      targetLanguage: "lang.target",
      sentencePairs: [{ sourceText: "alpha 42", targetText: "beta 42" }],
      corpusType: "parallel_sentences" as const,
      evidenceIds: []
    };
    const firstAlignment = createAlignmentEngine(firstRuntime).trainLexicalAlignment(corpus);
    const secondAlignment = createAlignmentEngine(secondRuntime).trainLexicalAlignment(corpus);
    const sourceProfile = buildLanguageProfile("alpha 42");
    const targetProfile = buildLanguageProfile("beta 42");
    const firstLexical = trainLexicalAlignment(
      "alpha 42",
      "beta 42",
      sourceProfile,
      targetProfile,
      [],
      replayRuntime()
    );
    const secondLexical = trainLexicalAlignment(
      "alpha 42",
      "beta 42",
      sourceProfile,
      targetProfile,
      [],
      replayRuntime()
    );
    const firstMemory: MultilingualTranslationMemory = { lexicalAlignments: [], corrections: [] };
    const secondMemory: MultilingualTranslationMemory = { lexicalAlignments: [], corrections: [] };
    const firstCorrection = applyUserCorrection(
      firstMemory,
      "alpha 42",
      "beta 42",
      "gamma 42",
      sourceProfile.id,
      targetProfile.id,
      ["42"],
      replayRuntime()
    );
    const secondCorrection = applyUserCorrection(
      secondMemory,
      "alpha 42",
      "beta 42",
      "gamma 42",
      sourceProfile.id,
      targetProfile.id,
      ["42"],
      replayRuntime()
    );
    const firstRoundTrip = validateRoundTrip("alpha 42", "alpha 42", replayRuntime());
    const secondRoundTrip = validateRoundTrip("alpha 42", "alpha 42", replayRuntime());
    const firstFeedback = createCorrectionEngine(replayRuntime()).recordFeedback(feedback());
    const secondFeedback = createCorrectionEngine(replayRuntime()).recordFeedback(feedback());

    expect(secondAlignment).toEqual(firstAlignment);
    expect(secondLexical).toEqual(firstLexical);
    expect(secondCorrection).toEqual(firstCorrection);
    expect(secondRoundTrip).toEqual(firstRoundTrip);
    expect(secondFeedback).toEqual(firstFeedback);
  });
});

function fixedClock(): Clock {
  return createClock({ fixedTime: 1_750_000_000_000, stepMs: 1 });
}

function replayRuntime() {
  const clock = fixedClock();
  return {
    clock,
    idFactory: createIdFactory({
      clock,
      hasher: createHasher(),
      namespace: "semantic-replay-test",
      runSeed: "fixed",
      deterministicReplay: true
    })
  };
}

function feedback(): TranslationFeedback {
  return {
    episodeId: "episode.fixture" as EpisodeId,
    sourceLanguage: "lang.source",
    targetLanguage: "lang.target",
    sourceText: "alpha 42",
    generatedTranslation: "beta 42",
    correctedTranslation: "gamma 42",
    protectedTerms: ["42"],
    changedTerms: [{ original: "beta", corrected: "gamma", reason: "fixture" }],
    sourceProfileId: "profile.source",
    targetProfileId: "profile.target",
    evidenceIds: []
  };
}

function ccrInput(): CcrInput {
  return {
    text: "alpha",
    evidence: [{
      id: "evidence.fixture",
      sourceId: "source.fixture",
      sourceVersionId: "source-version.fixture",
      chunkId: "chunk.fixture",
      byteStart: 0,
      byteEnd: 5,
      text: "alpha.",
      textPreview: "alpha.",
      mediaType: "text/plain",
      status: "promoted",
      observedAt: 1_740_000_000_000,
      features: ["alpha"],
      alpha: 0.9,
      metadata: {}
    } as never],
    nodes: [],
    edges: [],
    field: {
      seeds: [],
      active: [],
      ppf: [],
      causalMass: [],
      alphaTrace: {
        normalizedLaplacian: { values: [[1]] },
        laplacian: { values: [[1]] },
        surfaces: { bond: 1 }
      }
    } as never,
    entailment: {
      force: "observed",
      contradiction: 0,
      claim: { features: ["alpha"] }
    } as never
  };
}
