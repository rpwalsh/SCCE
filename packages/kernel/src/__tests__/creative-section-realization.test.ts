import { describe, expect, it } from "vitest";
import { realizeCreativeSection } from "../creative-section-realization.js";
import { createLanguageMemoryRuntime, renderContinuationSentences, type LanguageGenerationInput } from "../language-memory-runtime.js";
import type { LanguageUnitRecord } from "../storage.js";
import { sourceDerivedCasingHints } from "../surface-linguistics.js";
import type { NarrativeConditioning } from "../document-generation-session.js";

describe("creative section realization handoff", () => {
  it("carries committed typed state separately from the prior surface and never speaks its opaque IDs", () => {
    const runtime = createLanguageMemoryRuntime();
    const state = runtime.hydrateFromImportedBrain({ importRunId: "run.opaque", models: [], observations: [], units: [], patterns: [], semanticFrames: [] });
    const conditioning: NarrativeConditioning = {
      establishedFacts: [{ subjectId: "人物.甲", factId: "状态.乙", value: { "位置": "丙" } }],
      openSetupIds: ["伏线.丁"]
    };
    let generatedInput: LanguageGenerationInput | undefined;
    const generate = runtime.generate.bind(runtime);
    runtime.generate = input => {
      generatedInput = input;
      return generate(input);
    };
    const realized = realizeCreativeSection({
      languageMemory: runtime,
      state,
      requestText: "계속 이어지는 이야기",
      sectionGoal: "다음 장면",
      priorSurfaceTexts: ["이전 장면에서 새로운 길이 나타났다."],
      narrativeConditioning: conditioning
    });
    expect(generatedInput?.frames?.[0]?.narrativeConditioning).toBe(conditioning);
    const lexicalInput = JSON.stringify({
      context: generatedInput?.contextSymbols,
      atoms: generatedInput?.frames?.[0]?.propositionAtoms,
      terms: generatedInput?.frames?.[0]?.requiredTerms,
      vocabulary: generatedInput?.frames?.[0]?.topicVocabulary
    });
    for (const id of ["人物.甲", "状态.乙", "伏线.丁"]) expect(lexicalInput).not.toContain(id);
    expect(lexicalInput).toContain("나타났다");
    expect(realized.accepted).toBe(false);
  });

  it("uses typed narrative values to choose an attested learned surface without speaking opaque state ids", () => {
    const runtime = createLanguageMemoryRuntime();
    const state = runtime.hydrateFromImportedBrain({
      importRunId: "run.conditioned-surface",
      models: [], observations: [], patterns: [], semanticFrames: [],
      units: [
        learnedPhrase("unit.lantern", "The lantern glowed beside the harbor."),
        learnedPhrase("unit.compass", "The compass turned toward the ridge.")
      ]
    });
    const generateUnder = (value: string) => runtime.generate({
      state,
      contextSymbols: ["scene"],
      frames: [{
        id: "frame.conditioned",
        role: "answer",
        force: "creative",
        narrativeConditioning: {
          establishedFacts: [{ subjectId: "entity.protagonist", factId: "state.carried_object", value }],
          openSetupIds: ["setup.unspoken"]
        }
      }],
      generationExtent: 24
    });

    const lantern = generateUnder("lantern");
    const compass = generateUnder("compass");

    expect(lantern.text).toContain("lantern");
    expect(lantern.text).not.toContain("compass");
    expect(compass.text).toContain("compass");
    expect(compass.text).not.toContain("lantern");
    expect(lantern.text).not.toContain("entity.protagonist");
    expect(lantern.text).not.toContain("state.carried_object");
    expect(lantern.text).not.toContain("setup.unspoken");
    expect(lantern.text).not.toBe(compass.text);
    expect(JSON.stringify(lantern.audit)).toContain("narrativeConditioning");
  });
});

function learnedPhrase(id: string, text: string): LanguageUnitRecord {
  return {
    id,
    profileId: "profile.fixture",
    sourceVersionId: "source.fixture" as never,
    script: "script.fixture",
    unitKind: "phrase",
    text,
    features: [],
    competenceVector: [],
    alpha: 1,
    evidenceIds: ["evidence.fixture" as never],
    metadata: null
  };
}

describe("source-derived continuation casing", () => {
  it("recovers short names and acronyms from attested interiors in any cased script", () => {
    const hints = sourceDerivedCasingHints(["За рекой Ю встречает РАН. Потом Ю видит РАН."]);
    expect(hints).toMatchObject({ "ю": "Ю", "ран": "РАН" });
    expect(hints).not.toHaveProperty("потом");
    expect(renderContinuationSentences([["там", "ю", "видит", "ран", "."]], hints))
      .toBe("Там Ю видит РАН.");
  });

  it("does not give one Latin token a built-in capitalization rule", () => {
    expect(renderContinuationSentences([["x", "i", "y", "."]])).toBe("X i y.");
    const hints = sourceDerivedCasingHints(["x I y."]);
    expect(renderContinuationSentences([["x", "i", "y", "."]], hints)).toBe("X I y.");
  });

  it("abstains on conflicting casing and ignores inherited object properties", () => {
    const hints = sourceDerivedCasingHints(["x Ю y. z ю w."]);
    expect(hints).not.toHaveProperty("ю");
    expect(renderContinuationSentences([["x", "constructor", "."]], {})).toBe("X constructor.");
  });
});
