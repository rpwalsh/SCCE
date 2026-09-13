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
});

async function runtimeFixture(options: {
  observations: number;
  retainedHeapBytes?: number;
  gateHydration?: boolean;
}) {
  const retained: string[] = [];
  let hydrations = 0;
  let openGate = () => {};
  const gate = new Promise<void>(resolve => { openGate = resolve; });
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
      listNgramModels: async () => {
        hydrations += 1;
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
    surfaceLanguageMemoryCacheMaxEstimatedBytes: CACHE_BUDGET_BYTES
  });
  const cluster = await runtime.surfaceLanguageClusterCached("fixture language");

  return {
    get hydrations() { return hydrations; },
    releaseHydration: () => openGate(),
    hydrate: (languageId: string) =>
      runtime.hydrateSurfaceLanguageMemoryCached(12, cluster, "language-scoped", undefined, "", { languageId }),
    resident: (languageId: string) =>
      runtime.hydrateSurfaceLanguageMemoryCached(12, cluster, "language-scoped", undefined, "", { languageId, residentOnly: true })
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
