import { beforeEach, describe, expect, it } from "vitest";
import {
  clearCorpusIdentitySignals,
  createClock,
  createHasher,
  createIdFactory,
  createLanguageInductionEngine,
  createLanguageMemoryRuntime,
  languageMemoryPatternsFromInducedLanguageModel,
  primeCorpusIdentitySignals,
  proseRelationMetadata,
  type LanguageProfile
} from "../index.js";
import { declaredEntitySurfacesFromMetadata, learnedEntitySurfacesFromLanguageMemory, observedEntitySurfacesFromInducedLanguageModel, surfaceEntityRuns } from "../kernel-answer-primitives.js";

describe("surface entity spans use observed labels", () => {
  beforeEach(() => clearCorpusIdentitySignals());

  it("matches lowercase labels and leaves incidental words and unlabelled capitalization alone", () => {
    expect(surfaceEntityRuns("ada visited london with alice.", ["ada", "london"])).toEqual(["ada", "london"]);
    expect(surfaceEntityRuns("ada visited paris with Alice.", ["ada", "london"])).toEqual(["ada"]);
    expect(surfaceEntityRuns("Ada visited London with Alice.")).toEqual([]);
  });

  it("uses only entity fillers learned in the current profile scope", () => {
    const hasher = createHasher();
    const clock = createClock({ fixedTime: 172_000, stepMs: 1 });
    const ids = createIdFactory({ clock, hasher, deterministicReplay: true, namespace: "entity-surface-learning" });
    const sourceVersionId = ids.sourceVersionId("ada visited london");
    const documents = [{
      id: "document.entity-slots",
      sourceVersionId,
      evidenceIds: ["evidence.entity-slots" as never],
      text: [
        "ada visited london", "ada visited paris", "ada visited berlin", "ada visited madrid",
        "eve visited london", "eve visited paris", "eve visited berlin", "eve visited madrid"
      ].join(". ")
    }];
    const model = createLanguageInductionEngine({ hasher }).induce({ documents });
    const preparedLabels = observedEntitySurfacesFromInducedLanguageModel(model, ["evidence.entity-slots"]);
    expect(preparedLabels).toContain("ada");
    expect(preparedLabels).toContain("london");
    expect(observedEntitySurfacesFromInducedLanguageModel(model, ["evidence.other-source"])).toEqual([]);
    const profile: LanguageProfile = {
      id: "profile.entity-slots",
      sourceVersionId,
      scripts: [{ script: "script:Latn", mass: 1 }],
      symbolShapes: [],
      charNgrams: [],
      direction: "ltr",
      entropy: 0.5,
      createdAt: 172_000
    };
    const projection = languageMemoryPatternsFromInducedLanguageModel({ model, profiles: [profile], idFactory: ids, updatedAt: 172_000 });
    const memory = createLanguageMemoryRuntime({ hasher, idFactory: ids }).hydrate({
      models: [], observations: [], units: [], patterns: projection.patterns, semanticFrames: []
    });
    const scopedMemory = {
      ...memory,
      scope: {
        ...memory.scope,
        mode: "cluster" as const,
        profileIds: [profile.id],
        sourceVersionIds: [String(sourceVersionId)],
        purityProven: true
      }
    };
    const labels = learnedEntitySurfacesFromLanguageMemory(scopedMemory);
    expect(labels).toContain("ada");
    expect(labels).toContain("london");
    const observed = surfaceEntityRuns("ada visited london; incidental words remain unknown.", labels);
    expect(observed).toContain("ada");
    expect(observed).toContain("london");
    expect(observed).not.toContain("incidental");
    expect(observed).not.toContain("words");
    const unknowns = surfaceEntityRuns("ada met Alice near obelisk.", labels);
    expect(unknowns).toContain("ada");
    expect(unknowns).not.toContain("Alice");
    expect(unknowns).not.toContain("obelisk");
    expect(surfaceEntityRuns("Ada visited London.", [])).toEqual([]);
    const rawIngestRelations = proseRelationMetadata("ada encountered london.", { entitySurfaces: preparedLabels }) as unknown as Array<{ participants: Array<{ value: string }> }>;
    expect(rawIngestRelations[0]?.participants.map(participant => participant.value)).toEqual(["ada", "london"]);

    const otherProfile = { ...scopedMemory, scope: { ...scopedMemory.scope, profileIds: ["profile.other"] } };
    expect(learnedEntitySurfacesFromLanguageMemory(otherProfile)).toEqual([]);
  });

  it("matches declared source identities independent of case", () => {
    clearCorpusIdentitySignals();
    primeCorpusIdentitySignals({
      closedClass: new Set(),
      identities: new Set(["ada lovelace", "london"]),
      spread: new Map(),
      concentration: 0
    });
    try {
      expect(surfaceEntityRuns("ada lovelace visited london.")).toEqual(["ada lovelace", "london"]);
      expect(surfaceEntityRuns("incidental words and Alice.")).toEqual([]);
    } finally {
      clearCorpusIdentitySignals();
    }
  });

  it("uses declared source metadata labels and ignores unrelated title-case words", () => {
    const labels = declaredEntitySurfacesFromMetadata({
      title: "ada lovelace",
      identity: "london",
      sourceIdentity: { title: "ignored duplicate" }
    });
    expect(surfaceEntityRuns("ada lovelace visited london with Alice.", labels)).toEqual(["ada lovelace", "london"]);
  });
});
