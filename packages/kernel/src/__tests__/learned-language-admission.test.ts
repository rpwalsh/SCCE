// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
import { describe, expect, it } from "vitest";
import { createLanguageMemoryRuntime } from "../language-memory-runtime.js";
import { buildLanguageProfileClusters, languageSurfaceTrigrams, selectLanguageProfileClusterForSurface, selectLearnedLanguageProfileCluster } from "../language.js";
import { createClock, createHasher } from "../primitives.js";
import { createSurfaceLanguageRuntime } from "../surface-language-runtime.js";
import type { ScceKernelDeps } from "../storage.js";
import type { LanguageProfile } from "../types.js";

// A turn that selects no language cluster hydrates an explicitly empty language memory, so whatever decides "which
// cluster" also decides whether the mouth gets any learned language at all. selectLanguageProfileClusterForSurface
// abstains whenever the top two clusters score within MIN_SURFACE_SELECTION_MARGIN -- an honest answer to "does this
// surface distinctively belong to X", and a catastrophic one to "what language does this turn speak". Measured on the
// live brain before this split: every ordinary turn realized with models=0 patterns=0 units=0 against 226,992 stored
// units, 15,627 patterns and 22,502 profiles.
describe("a turn speaks the language this memory has learned", () => {
  it("resolves a cluster for a surface that matches none distinctively", async () => {
    const fixture = runtimeFixture();

    // Trigrams shared with no profile: the discrimination has nothing to go on and abstains.
    expect(selectLanguageProfileClusterForSurface(
      buildLanguageProfileClusters(fixture.profiles),
      "zzz qqq zzz qqq"
    )).toBeUndefined();

    await expect(fixture.runtime.surfaceLanguageClusterCached("zzz qqq zzz qqq"))
      .resolves.toBeDefined();
  });

  it("hydrates that cluster's learned material rather than an empty state", async () => {
    const fixture = runtimeFixture();
    const cluster = await fixture.runtime.surfaceLanguageClusterCached("zzz qqq zzz qqq");
    const hydrated = await fixture.runtime.hydrateSurfaceLanguageMemoryCached(12, cluster);

    expect(hydrated.state.scope.mode).toBe("cluster");
    expect(hydrated.units.length).toBeGreaterThan(0);
  });

  it("still resolves nothing when no profile owns learned material", async () => {
    // A profile row exists for every ingested source version. Naming the biggest of those "the language" is the guess
    // that source-bound cognition forbids, and it is what the surface-free warmup guard has always tested for.
    const unlearned = runtimeFixture({ charNgrams: [], entropy: 0 });

    expect(selectLearnedLanguageProfileCluster(buildLanguageProfileClusters(unlearned.profiles)))
      .toBeUndefined();
    await expect(unlearned.runtime.surfaceLanguageClusterCached("zzz qqq zzz qqq"))
      .resolves.toBeUndefined();
  });
});

function runtimeFixture(overrides: Partial<LanguageProfile> = {}) {
  const profile: LanguageProfile = {
    id: "profile.learned",
    sourceVersionId: "source.learned" as never,
    scripts: [{ script: "script:Latn", mass: 1 }],
    symbolShapes: [],
    charNgrams: languageSurfaceTrigrams("learned language learned language").map(ngram => ({ ngram, count: 2 })),
    direction: "ltr",
    entropy: 1,
    createdAt: 1,
    ...overrides
  };
  const unit = {
    id: "unit.learned",
    profileId: profile.id,
    surface: "learned",
    unitJson: { surface: "learned" },
    createdAt: 1
  };
  const storage = {
    brainImports: { active: async () => ({ activeImportRunIds: [] }) },
    evidence: { getEvidenceBatch: async () => [] },
    languageMemory: {
      listNgramModels: async () => [],
      listNgramObservations: async () => [],
      listLanguageUnits: async () => [unit],
      listLanguagePatterns: async () => [],
      listSemanticFrames: async () => []
    },
    model: { listLanguageProfiles: async () => [profile] }
  } as unknown as ScceKernelDeps["storage"];
  const hasher = createHasher();

  return {
    profiles: [profile],
    runtime: createSurfaceLanguageRuntime({
      deps: { storage, corpusRegistry: [] },
      languageMemoryRuntime: createLanguageMemoryRuntime({ hasher }),
      clock: createClock({ fixedTime: 0, stepMs: 100 }),
      hasher,
      cacheMs: 10_000,
      profileLimit: 32
    })
  };
}
