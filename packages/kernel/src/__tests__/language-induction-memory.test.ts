// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
import { describe, expect, it } from "vitest";
import {
  createHasher,
  createIdFactory,
  createClock,
  createLanguageInductionEngine,
  createLanguageMemoryRuntime,
  languageMemoryPatternsFromInducedLanguageModel,
  toJsonValue,
  INDUCED_LANGUAGE_MEMORY_COMPONENT_RECIPE_ID,
  type JsonValue,
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
    const restarted = languageMemoryPatternsFromInducedLanguageModel({ model, profiles: [profile],
      idFactory: createIdFactory({ clock, hasher, deterministicReplay: true, namespace: "another-caller-after-restart" }), updatedAt: 170_000, sourceSystem: "training" });
    expect(restarted.patterns).toEqual(projection.patterns);

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

  it("keeps a rebuilt syntax projection and other source scopes while ignoring same-scope legacy versions", () => {
    const hasher = createHasher();
    const idFactory = createIdFactory({ clock: createClock({ fixedTime: 172_000 }), hasher, deterministicReplay: true, namespace: "syntax-projection-revision" });
    const sourceVersionId = idFactory.sourceVersionId("rebuilt-source");
    const profile: LanguageProfile = {
      id: "profile.rebuilt",
      sourceVersionId,
      scripts: [{ script: "script:Latn", mass: 1 }],
      symbolShapes: [],
      charNgrams: [],
      direction: "ltr",
      entropy: 0.5,
      createdAt: 172_000
    };
    const engine = createLanguageInductionEngine({ hasher, vocabularyLimit: 512 });
    const model = engine.induce({ documents: [{ id: "doc.current", sourceVersionId, text: "alpha beta alpha beta" }] });
    const projection = languageMemoryPatternsFromInducedLanguageModel({ model, profiles: [profile], idFactory, updatedAt: 172_000, sourceSystem: "training" });
    const syntax = projection.patterns.find(pattern => pattern.patternKind === "syntax");
    expect(syntax).toBeDefined();
    const oldSameScopeModel = engine.induce({ documents: [{ id: "doc.old", sourceVersionId, text: "red green red green" }] });
    const oldOtherScopeModel = engine.induce({ documents: [{ id: "doc.other", sourceVersionId: "source-version.other" as never, text: "one two one two" }] });
    const syntaxJson = syntax!.patternJson as Record<string, JsonValue>;
    const legacySameScope = { ...syntax!, id: "syntax.legacy.same-scope", patternJson: toJsonValue({ ...syntaxJson,
      componentRecipe: "kernel.induced_language_memory_projection.v2", joinProgram: oldSameScopeModel.joinProgram }) };
    const legacyOtherScope = { ...syntax!, id: "syntax.legacy.other-scope", patternJson: toJsonValue({ ...syntaxJson,
      sourceVersionId: "source-version.other", componentRecipe: "kernel.induced_language_memory_projection.v2", joinProgram: oldOtherScopeModel.joinProgram }) };
    const state = createLanguageMemoryRuntime({ hasher, idFactory }).hydrate({
      models: [], observations: [], units: [], patterns: [...projection.patterns, legacySameScope, legacyOtherScope], semanticFrames: []
    });
    expect(syntaxJson.componentRecipe).toBe(INDUCED_LANGUAGE_MEMORY_COMPONENT_RECIPE_ID);
    expect(state.joinPrograms.map(item => item.id).sort()).toEqual([model.joinProgram.id, oldOtherScopeModel.joinProgram.id].sort());
  });
});
