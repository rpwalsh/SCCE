// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
import { describe, expect, it } from "vitest";
import {
  createHasher,
  createIdFactory,
  createClock,
  createLanguageInductionEngine,
  createLanguageMemoryRuntime,
  hydrateLanguageSegmentationWitness,
  languageMemoryPatternsFromInducedLanguageModel,
  INDUCED_LANGUAGE_MEMORY_COMPONENT_RECIPE_ID,
  LANGUAGE_SEGMENTATION_WITNESS_MANIFEST_PATTERN_SCHEMA,
  LANGUAGE_SEGMENTATION_WITNESS_REFERENCE_SCHEMA,
  SOURCE_SEGMENTATION_WITNESS_SCHEMA,
  validateSourceSegmentationWitness,
  type LanguageProfile
} from "../index.js";

describe("induced language model memory projection", () => {
  it("publishes semantic replay factors for every source-backed syntax component", () => {
    const hasher = createHasher();
    const clock = createClock({ fixedTime: 169_000, stepMs: 1 });
    const idFactory = createIdFactory({ clock, hasher, deterministicReplay: true, namespace: "semantic-replay-pair" });
    const sourceVersionId = idFactory.sourceVersionId("....");
    const model = createLanguageInductionEngine({ hasher }).induce({
      documents: [{ id: "doc.punctuation", sourceVersionId, evidenceIds: ["evidence.punctuation" as never], text: "...." }]
    });
    expect(model.semanticInductionFactors).toBeDefined();
    expect(model.semanticFrames).toEqual([]);
    expect(model.graphBoundConstructions).toEqual([]);
    expect(model.lexicalClasses).toEqual([]);
    expect(model.relationHypothesisModel.observationCount).toBe(0);
    const profile: LanguageProfile = { id: "profile.punctuation", sourceVersionId,
      scripts: [{ script: "script:Zyyy", mass: 1 }], symbolShapes: [], charNgrams: [], direction: "ltr", entropy: 0, createdAt: 169_000 };
    const projection = languageMemoryPatternsFromInducedLanguageModel({ model, profiles: [profile], idFactory, updatedAt: 169_000 });
    expect(projection.patterns.some(pattern => pattern.patternKind === "syntax")).toBe(true);
    const semantic = projection.patterns.find(pattern =>
      (pattern.patternJson as { schema?: string }).schema === "scce.induced_language_model.semantic_memory.v1");
    expect(semantic?.patternJson).toMatchObject({
      modelId: model.id,
      semanticInductionProjection: { schema: "scce.semantic_induction_projection.v1" }
    });
  });

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
    const syntaxJson = projection.patterns.find(pattern => pattern.patternKind === "syntax")!.patternJson as Record<string, unknown>;
    const reference = syntaxJson.segmentationWitness as Record<string, unknown>;
    expect(reference).toEqual({
      schema: LANGUAGE_SEGMENTATION_WITNESS_REFERENCE_SCHEMA,
      manifestPatternId: expect.any(String)
    });
    const manifest = projection.patterns.find(pattern => pattern.id === reference.manifestPatternId)!;
    expect(manifest.patternJson).toMatchObject({
      schema: LANGUAGE_SEGMENTATION_WITNESS_MANIFEST_PATTERN_SCHEMA,
      witnessSchema: model.segmentationWitness.schema
    });
    const sourceWitnessRows = projection.patterns.filter(pattern =>
      (pattern.patternJson as { schema?: string }).schema === SOURCE_SEGMENTATION_WITNESS_SCHEMA);
    expect(sourceWitnessRows).toHaveLength(model.segmentationWitness.populations.flatMap(population => population.documents).length);
    for (const row of sourceWitnessRows) {
      validateSourceSegmentationWitness(row.patternJson);
      expect(row.patternJson).not.toHaveProperty("componentRecipe");
      expect(row.patternJson).not.toHaveProperty("profileId");
    }
    expect(manifest.patternJson).not.toHaveProperty("componentRecipe");
    expect(manifest.patternJson).not.toHaveProperty("profileId");
    const cold = JSON.parse(JSON.stringify({ reference, manifest, sourceWitnessRows })) as {
      reference: unknown;
      manifest: typeof manifest;
      sourceWitnessRows: typeof sourceWitnessRows;
    };
    const restored = hydrateLanguageSegmentationWitness({
      reference: cold.reference,
      manifest: cold.manifest,
      sourceWitnesses: cold.sourceWitnessRows,
      hasher
    });
    expect(restored).toEqual(model.segmentationWitness);
    expect(() => hydrateLanguageSegmentationWitness({
      reference: cold.reference,
      manifest: cold.manifest,
      sourceWitnesses: cold.sourceWitnessRows.slice(1),
      hasher
    })).toThrow("exactly match");
    const changed = structuredClone(cold.sourceWitnessRows);
    (changed[0]!.patternJson as { text: string }).text += " changed";
    expect(() => hydrateLanguageSegmentationWitness({
      reference: cold.reference,
      manifest: cold.manifest,
      sourceWitnesses: changed,
      hasher
    })).toThrow();
    const movedManifest = { ...cold.manifest, profileId: "profile.tampered" };
    expect(() => hydrateLanguageSegmentationWitness({
      reference: cold.reference,
      manifest: movedManifest,
      sourceWitnesses: cold.sourceWitnessRows,
      hasher
    })).toThrow("archive identity changed");
    expect(JSON.stringify(reference)).not.toContain(model.segmentationWitness.populations[0]!.documents[0]!.text);
    expect(syntaxJson).not.toHaveProperty("joinProgram");

    const state = createLanguageMemoryRuntime({ hasher, idFactory }).hydrate({
      models: [],
      observations: [],
      units: [],
      patterns: projection.patterns,
      semanticFrames: []
    });
    expect(state.importedPatterns.length).toBe(projection.patterns.length - sourceWitnessRows.length - 1);
    expect(state.importedLanguagePriorCount).toBeGreaterThan(0);
    expect(state).not.toHaveProperty("joinPrograms");
  });

  it("publishes one archive owner and points every profile syntax row at that same manifest", () => {
    const hasher = createHasher();
    const clock = createClock({ fixedTime: 170_500 });
    const idFactory = createIdFactory({ clock, hasher, deterministicReplay: true, namespace: "language-witness-multi-profile" });
    const sourceVersionId = idFactory.sourceVersionId("alpha beta alpha beta");
    const model = createLanguageInductionEngine({ hasher }).induce({
      documents: [{ id: "doc.multi", sourceVersionId, text: "alpha beta alpha beta" }]
    });
    const common: Omit<LanguageProfile, "id"> = {
      sourceVersionId,
      scripts: [{ script: "script:Latn", mass: 1 }],
      symbolShapes: [], charNgrams: [], direction: "ltr", entropy: 0.5, createdAt: 170_500
    };
    const projection = languageMemoryPatternsFromInducedLanguageModel({
      model,
      profiles: [{ ...common, id: "profile.z" }, { ...common, id: "profile.a" }],
      idFactory,
      updatedAt: 170_500
    });
    const syntaxRows = projection.patterns.filter(pattern => pattern.patternKind === "syntax");
    expect(syntaxRows).toHaveLength(2);
    const references = syntaxRows.map(row => (row.patternJson as Record<string, unknown>).segmentationWitness as { manifestPatternId: string });
    expect(new Set(references.map(reference => reference.manifestPatternId)).size).toBe(1);
    const manifestRows = projection.patterns.filter(row =>
      (row.patternJson as { schema?: string }).schema === LANGUAGE_SEGMENTATION_WITNESS_MANIFEST_PATTERN_SCHEMA);
    expect(manifestRows).toHaveLength(1);
    expect(manifestRows[0]!.profileId).toBe("profile.a");
    expect(manifestRows[0]!.id).toBe(references[0]!.manifestPatternId);
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

  it("keeps rebuilt segmentation witnesses source-scoped and versioned without a JOIN compatibility field", () => {
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
    const otherSourceVersionId = "source-version.other" as never;
    const oldOtherScopeModel = engine.induce({ documents: [{ id: "doc.other", sourceVersionId: otherSourceVersionId, text: "one two one two" }] });
    const otherProfile: LanguageProfile = { ...profile, id: "profile.other", sourceVersionId: otherSourceVersionId };
    const sameScopeProjection = languageMemoryPatternsFromInducedLanguageModel({ model: oldSameScopeModel, profiles: [profile], idFactory, updatedAt: 172_000 });
    const otherScopeProjection = languageMemoryPatternsFromInducedLanguageModel({ model: oldOtherScopeModel, profiles: [otherProfile], idFactory, updatedAt: 172_000 });
    const syntaxJson = syntax!.patternJson as Record<string, unknown>;
    expect(syntaxJson.componentRecipe).toBe(INDUCED_LANGUAGE_MEMORY_COMPONENT_RECIPE_ID);
    expect(syntaxJson).not.toHaveProperty("joinProgram");
    const witnessId = (projected: typeof projection) => {
      const json = projected.patterns.find(pattern => pattern.patternKind === "syntax")!.patternJson as Record<string, unknown>;
      const manifestId = (json.segmentationWitness as { manifestPatternId: string }).manifestPatternId;
      return (projected.patterns.find(pattern => pattern.id === manifestId)!.patternJson as { id: string }).id;
    };
    expect(witnessId(projection)).toBe(model.segmentationWitness.id);
    const projectedWitnessIds = [projection, sameScopeProjection, otherScopeProjection].map(witnessId);
    expect(new Set(projectedWitnessIds).size).toBe(3);
  });
});
