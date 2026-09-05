// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
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

  it("retrieves surface candidates from durable memory-referenced profiles, not the recent-profile window", async () => {
    const fixture = runtimeFixture();

    const cluster = await fixture.runtime.surfaceLanguageClusterCached("fixture language");

    // Global-first: the whole-memory durable set answers without a
    // per-surface trigram query (measured 2.7s/turn to return nothing);
    // the trigram query remains only as the global-miss fallback.
    expect(cluster?.profileIds).toEqual(["profile.fixture"]);
    expect(fixture.profileQueries.at(-1)).toMatchObject({
      referencedByLanguageMemory: true
    });
    expect(fixture.profileQueries.at(-1)?.surfaceNgrams).toBeUndefined();
  });

  it("evicts the oldest entry instead of growing without bound once the request-text-keyed caches exceed their configured size", async () => {
    // Real bug: surfaceLanguageMemoryCache and surfaceCandidateProfileCache
    // are keyed (in part) by a hash of arbitrary request/surface text, so a
    // long-lived process answering many distinct questions grew these Maps
    // by one entry per distinct question forever -- confirmed as the cause
    // of a real OOM crash on both a long-running server and a long test
    // run. maxEntries is set to 2 here so the test can prove eviction with
    // three calls instead of the real 500/2000-entry production default.
    const fixture = runtimeFixture({ cacheMs: 10_000_000, surfaceLanguageMemoryCacheMaxEntries: 2, surfaceCandidateProfileCacheMaxEntries: 2 });

    // The request surface no longer participates in the cache key at all --
    // hydration content depends only on (cluster, role, reason), and the
    // surface-dependent scoping is re-run against the cached payload -- so
    // distinct questions can no longer grow this Map by one entry each.
    // That closes the original growth vector outright; what remains to
    // prove is that the eviction machinery still bounds the entries that
    // legitimately differ, so distinct entries are created here through the
    // unscoped-reason key dimension instead of the request text.
    await fixture.runtime.hydrateSurfaceLanguageMemoryCached(12, undefined, "first-reason", undefined, "any request");
    await fixture.runtime.hydrateSurfaceLanguageMemoryCached(12, undefined, "second-reason", undefined, "any request");
    const callsBeforeThird = fixture.totalDurableCalls();
    // Re-hydrating the second entry (still within the 2-entry cap) must not
    // trigger a new durable read -- proves the cache itself still works,
    // not just that it evicts everything. The request text differs on
    // purpose: it must NOT cause a miss.
    await fixture.runtime.hydrateSurfaceLanguageMemoryCached(12, undefined, "second-reason", undefined, "a different question entirely");
    expect(fixture.totalDurableCalls()).toBe(callsBeforeThird);

    // A third distinct entry exceeds the 2-entry cap and must evict the
    // first (the oldest), forcing a real durable re-read the next time it
    // is asked for -- if the Map were unbounded, this would still be served
    // from cache with zero new durable calls.
    await fixture.runtime.hydrateSurfaceLanguageMemoryCached(12, undefined, "third-reason", undefined, "any request");
    const callsBeforeReaskingFirst = fixture.totalDurableCalls();
    await fixture.runtime.hydrateSurfaceLanguageMemoryCached(12, undefined, "first-reason", undefined, "any request");
    expect(fixture.totalDurableCalls()).toBeGreaterThan(callsBeforeReaskingFirst);
  });

  it("evicts on aggregate size even when the entry count is far under its cap", async () => {
    // Real bug, crashed a live 7GB-heap server twice. The entry-count
    // bound above treats every resident language cluster as the same
    // size, but ONE cluster hydration is hundreds of MB of live heap
    // (measured: 42MB of models+units JSON becomes 365MB of heap once
    // parsed and Kneser-Ney-indexed), so a 500-entry cap permits tens of
    // GB. Two earlier attempts at this bound still OOM'd: the first
    // JSON.stringify'd the whole models array, which throws RangeError
    // above V8's ~512MB string cap and was caught into a 0-byte
    // measurement -- so every entry weighed nothing and nothing was ever
    // evicted; the second measured JSON bytes but budgeted them as if
    // they were heap bytes, permitting ~9x too much. maxEntries is left
    // high here precisely so that ONLY the size bound can explain the
    // eviction.
    const fixture = runtimeFixture({
      cacheMs: 10_000_000,
      surfaceLanguageMemoryCacheMaxEntries: 100,
      surfaceLanguageMemoryCacheMaxEstimatedBytes: 1
    });

    // A cluster-scoped hydration, so the entry actually carries records:
    // the unscoped path returns empty arrays and would weigh nothing no
    // matter how the estimate is computed.
    const cluster = await fixture.runtime.surfaceLanguageClusterCached("fixture language");
    await fixture.runtime.hydrateSurfaceLanguageMemoryCached(12, cluster, "source-cluster-selected", undefined, "first request");
    // A second, distinct entry (the unscoped key) pushes the aggregate over
    // the 1-byte budget and must evict the cluster-scoped entry. Request
    // text cannot create the second entry any more -- it is no longer part
    // of the key -- so the key's reason dimension carries it.
    await fixture.runtime.hydrateSurfaceLanguageMemoryCached(12, undefined, "budget-pressure", undefined, "second request");

    // Only one entry may remain resident, so re-asking the older one
    // must force a real durable re-read even though the entry count
    // never came near its 100-entry cap.
    const callsBeforeReaskingFirst = fixture.totalDurableCalls();
    await fixture.runtime.hydrateSurfaceLanguageMemoryCached(12, cluster, "source-cluster-selected", undefined, "first request");
    expect(fixture.totalDurableCalls()).toBeGreaterThan(callsBeforeReaskingFirst);
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

function runtimeFixture(cacheOverrides: { cacheMs?: number; surfaceLanguageMemoryCacheMaxEntries?: number; surfaceCandidateProfileCacheMaxEntries?: number; surfaceLanguageMemoryCacheMaxEstimatedBytes?: number } = {}) {
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
      collapseGuard: [],
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
    profileLimit: 32,
    ...cacheOverrides
  });

  return {
    runtime,
    profileQueries,
    populationQueries,
    totalDurableCalls: () => Object.values(calls).reduce((sum, count) => sum + count, 0)
  };
}
