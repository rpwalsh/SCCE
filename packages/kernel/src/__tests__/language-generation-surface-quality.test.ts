import { describe, expect, it } from "vitest";

import {
  languageGenerationSurfaceAdequate,
  type LanguageGenerationResult
} from "../language-memory-runtime.js";
import { resolveLearnedCreativeGenerationExtent } from "../mouth.js";

describe("learned language generation surface quality", () => {
  it("rejects a diverse but fragment-heavy learned continuation", () => {
    const text = "albert einstein fighting dragons and the. her, of not - “ to in,. was a. ’ with the you by me her as it to in i.";

    expect(languageGenerationSurfaceAdequate(generation(text, 0.18))).toBe(false);
  });

  it("admits complete multilingual discourse without English word rules", () => {
    const text = "용은 깊은 계곡을 건넜다. 과학자는 별빛을 따라 산 정상으로 올랐다. 두 사람은 새벽이 올 때까지 서로의 계획을 시험했다.";

    expect(languageGenerationSurfaceAdequate(generation(text, 0.06))).toBe(true);
  });

  it("propagates a learned absolute response extent beyond the old 48-symbol cap", () => {
    const requestText = "write a 20 page short story about albert einstein fighting dragons";
    const unitStart = [...requestText.slice(0, requestText.indexOf("page"))].length;

    expect(resolveLearnedCreativeGenerationExtent({
      requestText,
      hints: [{
        unitSurface: "page",
        wordsPerUnit: 250,
        requestSpan: {
          charStart: unitStart,
          charEnd: unitStart + [..."page"].length
        },
        sourcePatternId: "pattern.fixture.page-extent"
      }],
      plannedExtent: 48
    })).toBe(256);
  });
});

function generation(text: string, repetitionPenalty: number): LanguageGenerationResult {
  const symbols = text.match(/[\p{Letter}\p{Mark}\p{Number}]+|[^\s]/gu) ?? [];
  return {
    text,
    symbols,
    phrasesUsed: ["source-trained fixture"],
    discourse: {
      text,
      moves: [{
        id: "move.fixture",
        role: "learned_continuation",
        text,
        sourcePieceIds: ["unit.fixture"],
        frameIds: [],
        atomIds: [],
        support: 0.8,
        information: 1,
        symbolCount: symbols.length
      }],
      boundaries: [],
      steps: [],
      generationStepCount: 1,
      stopReason: "source_exhausted",
      requiredTermIdsCovered: [],
      propositionAtomIdsCovered: [],
      scoreOrderTextHash: "hash.fixture",
      anchorCoverage: 1,
      cohesion: 0.8,
      repetitionPenalty,
      discourseScore: 0.8,
      fluency: {
        beamWidth: 1,
        beamExpansions: 1,
        candidateMoveCount: 1,
        selectedBeamScore: 0.8,
        selectedUnitIds: ["move.fixture"],
        latentCoherence: 0.8,
        ngramMeanActivation: 0.8,
        priorSupport: 0.8,
        coverageGain: 0.8,
        repetitionPenalty,
        symbolCount: symbols.length
      }
    },
    importedNgramModelIdsUsed: ["model.fixture"],
    importedObservationIdsUsed: [],
    importedLanguageUnitIdsUsed: ["unit.fixture"],
    importedPhrasePatternIdsUsed: [],
    importedSemanticFrameIdsUsed: [],
    orderUsage: [],
    averageInformation: 1,
    confidence: 0.8,
    competence: {
      scriptRecognition: 0.8,
      segmentationQuality: 0.8,
      lexicalCoverage: 0.8,
      phraseFluency: 0.8,
      syntacticCoverage: 0.8,
      semanticFrameCoverage: 0.8,
      translationAlignment: 0.8,
      entailmentReliability: 0.8,
      generationReliability: 0.8,
      correctionStability: 0.8,
      localizationReliability: 0.8
    },
    stoppedBy: "source_exhausted",
    audit: {}
  };
}
