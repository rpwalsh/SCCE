// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
import { describe, expect, it } from "vitest";
import { createLanguageMemoryRuntime } from "../language-memory-runtime.js";
import { languageSurfaceTrigrams } from "../language.js";
import { createClock, createHasher } from "../primitives.js";
import { createSurfaceLanguageRuntime } from "../surface-language-runtime.js";
import type { NgramObservation, ScceKernelDeps } from "../storage.js";
import type { LanguageProfile } from "../types.js";

const NOT_WARM = /hydrated runtime unavailable: resident .* was not warmed/u;
const CACHE_BUDGET_BYTES = 512 * 1024;

describe("surface language cache entry sizing", () => {
  it.each(["identity", "cluster"] as const)("does not repopulate an invalidated %s cache from an older hydration", async scope => {
    const fixture = await runtimeFixture({ observations: 40, gateHydration: true });
    const hydrate = () => scope === "identity" ? fixture.hydrate("language.alpha") : fixture.hydrateCluster();
    const resident = () => scope === "identity" ? fixture.resident("language.alpha") : fixture.residentCluster();
    const obsolete = hydrate();
    await fixture.hydrationStarted;
    fixture.invalidate();
    fixture.releaseHydration();
    await obsolete;
    await expect(resident()).rejects.toThrow(NOT_WARM);
    const fresh = await hydrate();
    expect(fixture.hydrations).toBe(2);
    expect(await resident()).toBe(fresh);
  });

  it("does not join an obsolete in-flight identity hydration after invalidation", async () => {
    const fixture = await runtimeFixture({ observations: 40, gateHydration: true });
    const obsolete = fixture.hydrate("language.alpha");
    await fixture.hydrationStarted;
    fixture.invalidate();
    const fresh = fixture.hydrate("language.alpha");
    fixture.releaseHydration();
    const [oldValue, newValue] = await Promise.all([obsolete, fresh]);
    expect(fixture.hydrations).toBe(2);
    expect(newValue).not.toBe(oldValue);
    expect(await fixture.resident("language.alpha")).toBe(newValue);
  });

  it("weighs an entry by the records it holds, not by the heap measured while it hydrated", async () => {
    // The heap delta is measured across a hydration that runs for a minute while the process serves other turns,
    // so it charged one entry for everything anything else allocated in that window: four entries claimed 4,669MB
    // of a 5GB bound for about 70MB of records, nothing could be cached beside anything else, and 38 lookups
    // produced 0 hits.
    const light = await runtimeFixture({ observations: 40, retainedHeapBytes: 16 * 1024 * 1024 });
    const first = await light.hydrate("language.alpha");
    await light.hydrate("language.beta");

    expect(await light.resident("language.alpha")).toBe(first);
    expect(light.hydrations).toBe(2);

    // The same bound, the same two keys, no measured heap at all: records alone push the pair over it and the
    // older entry goes. What an entry weighs is its content, so content is what can evict it.
    const heavy = await runtimeFixture({ observations: 4000, retainedHeapBytes: 0 });
    await heavy.hydrate("language.alpha");
    await heavy.hydrate("language.beta");

    await expect(heavy.resident("language.alpha")).rejects.toThrow(NOT_WARM);
  });

  it("hydrates one language key once for concurrent requests and hands both the same result", async () => {
    // A cold hydration runs 60-80s and a turn arrives every 20-30s, so every turn found an empty cache and started
    // its own copy of the same work, then abandoned it at its stage budget with no models at all.
    const fixture = await runtimeFixture({ observations: 40, gateHydration: true });

    const left = fixture.hydrate("language.alpha");
    const right = fixture.hydrate("language.alpha");
    fixture.releaseHydration();
    const [leftValue, rightValue] = await Promise.all([left, right]);

    expect(fixture.hydrations).toBe(1);
    expect(rightValue).toBe(leftValue);
  });

  it("loads an identity continuation population once for a warm language cache entry", async () => {
    const fixture = await runtimeFixture({ observations: 40, languageId: "language.fixture" });

    await fixture.hydrate("language.fixture");
    await fixture.hydrate("language.fixture");

    expect(fixture.populationReads).toBe(1);
  });

  it("shares one population read across concurrent role hydrations of the same language", async () => {
    const fixture = await runtimeFixture({ observations: 40, languageId: "language.fixture", gatePopulation: true });
    const left = fixture.hydrateRole("role.left");
    const right = fixture.hydrateRole("role.right");
    fixture.releaseHydration();
    const [leftValue, rightValue] = await Promise.all([left, right]);
    expect(fixture.populationReads).toBe(1);
    expect(leftValue.state.continuationPopulation).toBeDefined();
    expect(rightValue.state.continuationPopulation).toBe(leftValue.state.continuationPopulation);
    fixture.invalidate();
    await fixture.hydrateRole("role.right");
    expect(fixture.populationReads).toBe(2);
  });

  it("retries a failed population read on a later hydration", async () => {
    const fixture = await runtimeFixture({ observations: 40, languageId: "language.fixture", failPopulationOnce: true });
    expect((await fixture.hydrateRole("role.first")).state.continuationPopulation).toBeUndefined();
    expect((await fixture.hydrateRole("role.second")).state.continuationPopulation).toBeDefined();
    expect(fixture.populationReads).toBe(2);
  });
});

async function runtimeFixture(options: {
  observations: number;
  retainedHeapBytes?: number;
  gateHydration?: boolean;
  gatePopulation?: boolean;
  failPopulationOnce?: boolean;
  languageId?: string;
}) {
  const retained: string[] = [];
  let hydrations = 0;
  let populationReads = 0;
  let openGate = () => {};
  const gate = new Promise<void>(resolve => { openGate = resolve; });
  let markHydrationStarted = () => {};
  const hydrationStarted = new Promise<void>(resolve => { markHydrationStarted = resolve; });
  const profile: LanguageProfile = {
    id: "profile.fixture",
    sourceVersionId: "source.fixture" as never,
    scripts: [{ script: "script:Latn", mass: 1 }],
    symbolShapes: [],
    charNgrams: languageSurfaceTrigrams("fixture language fixture language").map(ngram => ({ ngram, count: 2 })),
    direction: "ltr",
    entropy: 1,
    createdAt: 1
  };
  const storage = {
    brainImports: { active: async () => ({ activeImportRunIds: [] }) },
    evidence: { getEvidenceBatch: async () => [] },
    languageMemory: {
      continuationPopulation: async ({ languageId }: { languageId: string }) => {
        populationReads += 1;
        if (options.gatePopulation) await gate;
        if (options.failPopulationOnce && populationReads === 1) throw new Error("transient population read failure");
        return { languageId, modelCount: 1, continuationCounts: {} };
      },
      listNgramModels: async () => {
        hydrations += 1;
        markHydrationStarted();
        if (options.retainedHeapBytes) retained.push("h".repeat(options.retainedHeapBytes));
        if (options.gateHydration) await gate;
        return [];
      },
      listNgramObservations: async () => fixtureObservations(options.observations),
      listLanguageUnits: async () => [],
      listLanguagePatterns: async () => [],
      listSemanticFrames: async () => []
    },
    segmentationPopulations: { listRecent: async () => [] },
    model: { listLanguageProfiles: async () => [profile] }
  } as unknown as ScceKernelDeps["storage"];
  const hasher = createHasher();
  const runtime = createSurfaceLanguageRuntime({
    deps: { storage, corpusRegistry: [] },
    languageMemoryRuntime: createLanguageMemoryRuntime({ hasher }),
    clock: createClock({ fixedTime: 0, stepMs: 100 }),
    hasher,
    cacheMs: 10_000_000,
    profileLimit: 32,
    surfaceLanguageMemoryCacheMaxEntries: 100,
    surfaceLanguageMemoryCacheMaxEstimatedBytes: CACHE_BUDGET_BYTES,
    languageResolver: () => ({ profile: () => options.languageId, corpus: () => options.languageId })
  });
  const cluster = await runtime.surfaceLanguageClusterCached("fixture language");

  return {
    get hydrations() { return hydrations; },
    get populationReads() { return populationReads; },
    hydrationStarted,
    releaseHydration: () => openGate(),
    invalidate: () => runtime.invalidate(),
    hydrateCluster: () => runtime.hydrateSurfaceLanguageMemoryCached(12, cluster, "fixture"),
    residentCluster: () => runtime.hydrateSurfaceLanguageMemoryCached(12, cluster, "fixture", undefined, "", { residentOnly: true }),
    hydrateRole: (roleId: string) =>
      runtime.hydrateSurfaceLanguageMemoryCached(12, cluster, "language-scoped", roleId, "", { languageId: options.languageId }),
    hydrate: (languageId: string) =>
      runtime.hydrateSurfaceLanguageMemoryCached(12, cluster, "language-scoped", undefined, "", { languageId: options.languageId ?? languageId }),
    resident: (languageId: string) =>
      runtime.hydrateSurfaceLanguageMemoryCached(12, cluster, "language-scoped", undefined, "", { languageId: options.languageId ?? languageId, residentOnly: true })
  };
}

function fixtureObservations(count: number): NgramObservation[] {
  const symbols = ["alpha", "beta", "gamma", "delta", "epsilon"];
  const rows: NgramObservation[] = [];
  for (let index = 0; index < count; index += 1) {
    rows.push({
      id: `ngram_observation.${index}`,
      streamId: "stream.fixture",
      languageHint: "fixture",
      order: 1,
      history: [],
      symbol: `${symbols[index % symbols.length]}${Math.floor(index / symbols.length)}`,
      count: 10 + index,
      fieldWeight: 1,
      observedAt: 1,
      metadata: { profileId: "profile.fixture" }
    });
  }
  return rows;
}
