import { describe, expect, it } from "vitest";
import {
  createHasher,
  createIdFactory,
  createClock,
  createLanguageInductionEngine,
  createLanguageMemoryRuntime,
  languageMemoryPatternsFromInducedLanguageModel,
  type LanguageProfile
} from "../index.js";

describe("induced language model memory projection", () => {
  it("projects persisted induction models into runtime-visible language patterns", () => {
    const hasher = createHasher();
    const clock = createClock({ fixedTime: 170_000, stepMs: 1 });
    const idFactory = createIdFactory({ clock, hasher, deterministicReplay: true, namespace: "language-induction-memory" });
    const sourceVersionId = idFactory.sourceVersionId("cat chased mouse. dog chased ball.");
    const model = createLanguageInductionEngine({ hasher }).induce({
      documents: [{
        id: "doc.training",
        sourceVersionId,
        evidenceIds: ["evidence.training" as never],
        text: [
          "cat chased mouse.", "dog chased mouse.", "cat chased ball.", "dog chased ball.",
          "cat chased mouse.", "dog chased ball.", "cat chased ball.", "dog chased mouse."
        ].join(" ")
      }]
    });
    const profile: LanguageProfile = {
      id: "profile.training",
      sourceVersionId,
      scripts: [{ script: "script:Latn", mass: 1 }],
      symbolShapes: [],
      charNgrams: [{ ngram: "cat", count: 2 }],
      direction: "ltr",
      entropy: 0.5,
      createdAt: 170_000
    };

    const projection = languageMemoryPatternsFromInducedLanguageModel({
      model,
      profiles: [profile],
      idFactory,
      updatedAt: 170_000,
      sourceSystem: "training"
    });

    expect(projection.skippedReason).toBeUndefined();
    expect(projection.profileIds).toEqual([profile.id]);
    expect(projection.patterns.length).toBeGreaterThan(0);
    expect(projection.patterns.every(pattern => pattern.profileId === profile.id)).toBe(true);
    expect(projection.patterns.some(pattern => pattern.patternKind === "syntax")).toBe(true);
    expect(projection.patterns.some(pattern => pattern.patternKind === "semantic_role")).toBe(true);

    const state = createLanguageMemoryRuntime({ hasher, idFactory }).hydrate({
      models: [],
      observations: [],
      units: [],
      patterns: projection.patterns,
      semanticFrames: []
    });
    expect(state.importedPatterns.length).toBe(projection.patterns.length);
    expect(state.importedLanguagePriorCount).toBeGreaterThan(0);
    expect(state.joinPrograms).toHaveLength(1);
    expect(state.joinPrograms[0]?.id).toBe(model.joinProgram.id);
  });

  it("does not project an induction model onto unrelated language profiles", () => {
    const hasher = createHasher();
    const clock = createClock({ fixedTime: 171_000, stepMs: 1 });
    const idFactory = createIdFactory({ clock, hasher, deterministicReplay: true, namespace: "language-induction-memory-skip" });
    const sourceVersionId = idFactory.sourceVersionId("alpha beta gamma");
    const model = createLanguageInductionEngine({ hasher }).induce({
      documents: [{ id: "doc.training", sourceVersionId, text: "alpha beta gamma alpha beta gamma" }]
    });
    const unrelated: LanguageProfile = {
      id: "profile.unrelated",
      sourceVersionId: idFactory.sourceVersionId("unrelated"),
      scripts: [{ script: "script:Latn", mass: 1 }],
      symbolShapes: [],
      charNgrams: [],
      direction: "ltr",
      entropy: 0.5,
      createdAt: 171_000
    };

    const projection = languageMemoryPatternsFromInducedLanguageModel({
      model,
      profiles: [unrelated],
      idFactory,
      updatedAt: 171_000
    });

    expect(projection.patterns).toEqual([]);
    expect(projection.skippedReason).toBe("no_matching_profiles");
  });
});
