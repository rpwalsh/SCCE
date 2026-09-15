// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
import { afterEach, describe, expect, it } from "vitest";
import { clearFreeFormLexicon, primeFreeFormLexicon } from "../free-form-lexicon.js";
import { createIdFactory } from "../ids.js";
import { createLanguageMemoryRuntime } from "../language-memory-runtime.js";
import { languageSurfaceTrigrams } from "../language.js";
import { createNgramMemoryCompiler } from "../ngram-memory.js";
import { clearNumericTokenStatisticsCache, deriveNumericTokenStatistics, numericTokenDerivationCount, residentNumericTokenStatistics } from "../numeric-token-statistics.js";
import { createClock, createHasher, featureSet } from "../primitives.js";
import type { ScceKernelDeps } from "../storage.js";
import { createSurfaceLanguageRuntime } from "../surface-language-runtime.js";
import type { EvidenceSpan, LanguageProfile } from "../types.js";

const probes = ["metres", "tonnes", "survey", "the", ",", "."];

function decisions(statistics: ReturnType<typeof residentNumericTokenStatistics>): string[] {
  return probes.map(symbol => `${symbol}:${statistics.unit(symbol)}:${statistics.separator(symbol)}`);
}

function corpus(seed: number, unit: string, noun: string): string {
  const lines: string[] = [];
  for (let i = 0; i < 30; i++) {
    lines.push(`The ${noun} survey measured ${(i * 37 + seed) % 900 + 12} ${unit} across the valley.`);
    lines.push(`Records list 1,${String(100 + i * 7 + seed)}.${i % 9} ${unit} for the ${noun}.`);
  }
  return lines.join(" ");
}

afterEach(() => {
  clearFreeFormLexicon();
  clearNumericTokenStatisticsCache();
});

describe("numeric token counts are derived where models are admitted", () => {
  it("derives the scoped models at hydration and none of the records scoping drops", async () => {
    clearNumericTokenStatisticsCache();
    const fixture = runtimeFixture();
    expect(fixture.records).toHaveLength(2);

    const cluster = await fixture.runtime.surfaceLanguageClusterCached("fixture language survey");
    const hydrated = await fixture.runtime.hydrateSurfaceLanguageMemoryCached(12, cluster, "source-cluster-selected");

    expect(hydrated.state.models.length).toBeGreaterThan(0);
    // Only what survived scoping: the second profile's record was loaded and dropped, and was never derived.
    expect(hydrated.state.models.length).toBeLessThan(fixture.records.length);
    expect(numericTokenDerivationCount()).toBe(hydrated.state.models.length);

    const derivedAtHydration = numericTokenDerivationCount();
    primeFreeFormLexicon(hydrated.state.models);
    const turn = decisions(residentNumericTokenStatistics());
    expect(numericTokenDerivationCount()).toBe(derivedAtHydration);

    expect(turn).toEqual(decisions(deriveNumericTokenStatistics(hydrated.state.models)));
  });

  it("derives nothing on a warm second hydration of the same scope", async () => {
    clearNumericTokenStatisticsCache();
    const fixture = runtimeFixture();
    const cluster = await fixture.runtime.surfaceLanguageClusterCached("fixture language survey");
    await fixture.runtime.hydrateSurfaceLanguageMemoryCached(12, cluster, "source-cluster-selected");
    const derivedAtHydration = numericTokenDerivationCount();
    expect(derivedAtHydration).toBeGreaterThan(0);

    const warm = await fixture.runtime.hydrateSurfaceLanguageMemoryCached(12, cluster, "source-cluster-selected");
    primeFreeFormLexicon(warm.state.models);
    residentNumericTokenStatistics();

    expect(numericTokenDerivationCount()).toBe(derivedAtHydration);
  });
});

function runtimeFixture() {
  const hasher = createHasher();
  const compiler = createNgramMemoryCompiler({
    hasher,
    idFactory: createIdFactory({ clock: createClock({ fixedTime: 1 }), hasher, deterministicReplay: true })
  });
  const members = [
    { id: "profile.fixture", surface: "fixture language survey", text: corpus(1, "metres", "valley") },
    { id: "profile.other", surface: "qelari venatu morrow", text: corpus(2, "tonnes", "qelari") }
  ];
  const profiles = members.map(member => profile(member.id, member.surface));
  const records = members.flatMap((member, index) => compiler.compile({
    streamId: `stream.${member.id}`,
    profile: profiles[index]!,
    sourceVersionId: profiles[index]!.sourceVersionId,
    text: member.text,
    evidence: [span(`evidence.${member.id}`, member.text)],
    createdAt: 1
  }).models);

  const storage = {
    brainImports: { active: async () => ({ activeImportRunIds: [] }) },
    evidence: { getEvidenceBatch: async () => [] },
    languageMemory: {
      listNgramModels: async () => records,
      listNgramObservations: async () => [],
      listLanguageUnits: async () => [],
      listLanguagePatterns: async () => [],
      listSemanticFrames: async () => []
    },
    segmentationPopulations: { listRecent: async () => [] },
    model: { listLanguageProfiles: async () => profiles }
  } as unknown as ScceKernelDeps["storage"];

  return {
    records,
    runtime: createSurfaceLanguageRuntime({
      deps: { storage, corpusRegistry: [] },
      languageMemoryRuntime: createLanguageMemoryRuntime({ hasher }),
      clock: createClock({ fixedTime: 0, stepMs: 100 }),
      hasher,
      cacheMs: 10_000_000,
      profileLimit: 32
    })
  };
}

function profile(id: string, surface: string): LanguageProfile {
  return {
    id,
    sourceVersionId: `source.${id}` as LanguageProfile["sourceVersionId"],
    discoveredNames: [{ surface, evidenceRefs: [], sourceVersionRefs: [`source.${id}` as never], confidence: 1 }],
    scripts: [{ script: "script:Latn", mass: 1 }],
    symbolShapes: [],
    charNgrams: languageSurfaceTrigrams(`${surface} ${surface}`).map(ngram => ({ ngram, count: 2 })),
    direction: "ltr",
    entropy: 1,
    createdAt: 1
  };
}

function span(id: string, text: string): EvidenceSpan {
  return {
    id: id as EvidenceSpan["id"],
    sourceId: `source.${id}` as EvidenceSpan["sourceId"],
    sourceVersionId: `source-version.${id}` as EvidenceSpan["sourceVersionId"],
    chunkId: `chunk.${id}` as EvidenceSpan["chunkId"],
    contentHash: `hash.${id}` as EvidenceSpan["contentHash"],
    mediaType: "text/plain",
    byteStart: 0,
    byteEnd: new TextEncoder().encode(text).byteLength,
    charStart: 0,
    charEnd: text.length,
    text,
    textPreview: text.slice(0, 64),
    languageHints: {},
    scriptHints: {},
    trustVector: { trust: 0.9, forceClass: "direct_evidence" },
    provenance: { source: "numeric-token-counts-hydration.test" },
    features: featureSet(text, 256),
    status: "promoted",
    alpha: 0.9,
    observedAt: 1
  };
}
