import { describe, expect, it } from "vitest";
import { createLanguageMemoryRuntime } from "../language-memory-runtime.js";
import { languageSurfaceTrigrams } from "../language.js";
import { createClock, createHasher } from "../primitives.js";
import { createSurfaceLanguageRuntime } from "../surface-language-runtime.js";
import type { ScceKernelDeps, SemanticFrameRecord } from "../storage.js";
import type { SegmentationPopulationModelRecord } from "../segmentation-population-persistence.js";
import type { LanguageProfile } from "../types.js";

describe("surface language resident-only cache", () => {
  it("reuses expired warmed language, frame, and source-profile entries without durable calls", async () => {
    const fixture = runtimeFixture();

    const language = await fixture.runtime.hydrateSurfaceLanguageMemoryCached(
      12,
      undefined,
      "source-surface-ambiguous-or-no-signal"
    );
    const frames = await fixture.runtime.requestSemanticFrames("alpha");
    const profiles = await fixture.runtime.sourceOwnedLanguageProfilesCached(["fixture"]);
    const durableCallsAfterWarmup = fixture.totalDurableCalls();

    const residentLanguage = await fixture.runtime.hydrateSurfaceLanguageMemoryCached(
      12,
      undefined,
      "source-surface-ambiguous-or-no-signal",
      undefined,
      "",
      { residentOnly: true }
    );
    const residentFrames = await fixture.runtime.requestSemanticFrames(
      "alpha",
      { residentOnly: true }
    );
    const residentProfiles = await fixture.runtime.sourceOwnedLanguageProfilesCached(
      ["fixture"],
      { residentOnly: true }
    );

    expect(residentLanguage).toBe(language);
    expect(residentFrames.map(frame => frame.id)).toEqual(frames.map(frame => frame.id));
    expect(residentProfiles.profiles).toBe(profiles.profiles);
    expect(fixture.totalDurableCalls()).toBe(durableCallsAfterWarmup);
  });

  it("fails explicitly on an unwarmed resident-only request without durable calls", async () => {
    const fixture = runtimeFixture();
    const notWarm = /hydrated runtime unavailable: resident .* was not warmed/u;

    await expect(fixture.runtime.hydrateSurfaceLanguageMemoryCached(
      12,
      undefined,
      "source-surface-ambiguous-or-no-signal",
      undefined,
      "",
      { residentOnly: true }
    )).rejects.toThrow(notWarm);
    await expect(fixture.runtime.requestSemanticFrames(
      "alpha",
      { residentOnly: true }
    )).rejects.toThrow(notWarm);
    await expect(fixture.runtime.sourceOwnedLanguageProfilesCached(
      ["fixture"],
      { residentOnly: true }
    )).rejects.toThrow(notWarm);

    expect(fixture.totalDurableCalls()).toBe(0);
  });

  it("resolves a never-queried alias from the warmed general profile generation without durable calls", async () => {
    const fixture = runtimeFixture();
    await fixture.runtime.surfaceLanguageProfilesCached();
    const durableCallsAfterWarmup = fixture.totalDurableCalls();

    const residentProfiles = await fixture.runtime.sourceOwnedLanguageProfilesCached(
      ["fixture"],
      { residentOnly: true }
    );

    expect(residentProfiles.profiles.map(profile => profile.id)).toEqual(["profile.fixture"]);
    expect(residentProfiles.clusters).toHaveLength(1);
    expect(fixture.totalDurableCalls()).toBe(durableCallsAfterWarmup);
  });

  it("retrieves surface candidates from the durable trigram index instead of the recent-profile window", async () => {
    const fixture = runtimeFixture();

    const cluster = await fixture.runtime.surfaceLanguageClusterCached("fixture language");

    expect(cluster?.profileIds).toEqual(["profile.fixture"]);
    expect(fixture.profileQueries.at(-1)).toMatchObject({
      limit: 32,
      referencedByLanguageMemory: true
    });
    expect(fixture.profileQueries.at(-1)?.surfaceNgrams).toContain("fix");
  });

  it("hydrates the learned segmentation population selected for the surface profile", async () => {
    const fixture = runtimeFixture();
    const cluster = await fixture.runtime.surfaceLanguageClusterCached("fixture language");
    const hydrated = await fixture.runtime.hydrateSurfaceLanguageMemoryCached(
      12,
      cluster,
      "source-cluster-selected"
    );

    expect(hydrated.segmentationPopulationModels.map(record => record.id))
      .toEqual(["segmentation_population.fixture"]);
    expect(fixture.populationQueries).toEqual([{
      profileIds: ["profile.fixture"],
      limit: 12
    }]);
  });
});

function runtimeFixture() {
  const calls = {
    active: 0,
    evidence: 0,
    frames: 0,
    models: 0,
    observations: 0,
    patterns: 0,
    populations: 0,
    profiles: 0,
    units: 0
  };
  const profileQueries: Array<{ surfaceNgrams?: readonly string[]; limit?: number; referencedByLanguageMemory?: boolean }> = [];
  const populationQueries: Array<{ profileIds?: readonly string[]; limit?: number }> = [];
  const profile: LanguageProfile = {
    id: "profile.fixture",
    sourceVersionId: "source.fixture" as never,
    discoveredNames: [{
      surface: "fixture",
      evidenceRefs: [],
      sourceVersionRefs: ["source.fixture" as never],
      confidence: 1
    }],
    scripts: [{ script: "script:Latn", mass: 1 }],
    symbolShapes: [],
    charNgrams: languageSurfaceTrigrams("fixture language fixture language")
      .map(ngram => ({ ngram, count: 2 })),
    direction: "ltr",
    entropy: 1,
    createdAt: 1
  };
  const frame: SemanticFrameRecord = {
    id: "frame.alpha",
    frameJson: { surface: "alpha", text: "alpha" },
    embedding: [],
    evidenceIds: [],
    alpha: 1,
    createdAt: 1
  };
  const populationRecord: SegmentationPopulationModelRecord = {
    id: "segmentation_population.fixture",
    model: {
      schema: "scce.segmentation_population_model.v3",
      id: "segmentation_population.fixture",
      rootPopulationId: "population.fixture",
      populations: [],
      assignments: [],
      assignmentIndex: {},
      selection: {
        fitDocumentIds: [],
        modelSelectionDocumentIds: [],
        mergeGuardDocumentIds: [],
        finalEvaluationDocumentIds: [],
        sourceFamilyDisjoint: true,
        holdoutDocumentIds: [],
        candidates: [],
        selectedPopulationCount: 0,
        baselineDescriptionNats: 0,
        selectedDescriptionNats: 0,
        mdlGainNats: 0,
        finalEvaluationNats: 0
      },
      audit: {}
    },
    trainingPlanId: "training.fixture",
    profileIds: ["profile.fixture"],
    sourceVersionIds: ["source.fixture" as never],
    createdAt: 1,
    informationLabel: {
      tenantId: "tenant.fixture",
      principals: [],
      compartments: [],
      exportClass: "internal",
      mergePolicy: "same_owner"
    }
  };
  const storage = {
    brainImports: {
      active: async () => {
        calls.active += 1;
        return { activeImportRunIds: [] };
      }
    },
    evidence: {
      getEvidenceBatch: async () => {
        calls.evidence += 1;
        return [];
      }
    },
    languageMemory: {
      listNgramModels: async () => {
        calls.models += 1;
        return [];
      },
      listNgramObservations: async () => {
        calls.observations += 1;
        return [];
      },
      listLanguageUnits: async () => {
        calls.units += 1;
        return [];
      },
      listLanguagePatterns: async () => {
        calls.patterns += 1;
        return [];
      },
      listSemanticFrames: async () => {
        calls.frames += 1;
        return [frame];
      }
    },
    segmentationPopulations: {
      listRecent: async (query: { profileIds?: readonly string[]; limit?: number }) => {
        calls.populations += 1;
        populationQueries.push(query);
        return [populationRecord];
      }
    },
    model: {
      listLanguageProfiles: async (query: { surfaceNgrams?: readonly string[]; limit?: number; referencedByLanguageMemory?: boolean }) => {
        calls.profiles += 1;
        profileQueries.push(query);
        return [profile];
      }
    }
  } as unknown as ScceKernelDeps["storage"];
  const clock = createClock({ fixedTime: 0, stepMs: 100 });
  const hasher = createHasher();
  const runtime = createSurfaceLanguageRuntime({
    deps: { storage, corpusRegistry: [] },
    languageMemoryRuntime: createLanguageMemoryRuntime({ hasher }),
    clock,
    hasher,
    cacheMs: 10,
    profileLimit: 32
  });

  return {
    runtime,
    profileQueries,
    populationQueries,
    totalDurableCalls: () => Object.values(calls).reduce((sum, count) => sum + count, 0)
  };
}
