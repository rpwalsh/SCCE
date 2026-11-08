// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
import { describe, expect, it } from "vitest";
import { compileLanguageConstructionPattern, SOURCE_EXAMPLE_CONSTRUCTION_STORAGE } from "../language-construction-memory.js";
import { estimateRetainedProgramBytes } from "../retained-program-size.js";
import { createLanguageMemoryRuntime, peekLanguageMemoryConstructionState } from "../language-memory-runtime.js";
import { languageSurfaceTrigrams } from "../language.js";
import { createNgramMemoryCompiler } from "../ngram-memory.js";
import { createIdFactory } from "../ids.js";
import { createClock, createHasher } from "../primitives.js";
import { createSurfaceLanguageRuntime } from "../surface-language-runtime.js";
import type { ScceKernelDeps } from "../storage.js";
import type { EvidenceSpan, LanguageProfile } from "../types.js";

const NOT_WARM = /hydrated runtime unavailable: resident .* was not warmed/u;
const CACHE_BUDGET_BYTES = 512 * 1024;

describe("surface language cache entry sizing", () => {
  it("retains heterogeneous records that fit the allowance instead of extrapolating their largest prefix", async () => {
    const fixture = await runtimeFixture({ modelSymbolCount: 8,
      patternPayloadSizes: [...Array.from({ length: 4 }, () => 32 * 1024), ...Array.from({ length: 96 }, () => 32)] });
    expect(fixture.persistedJsonBytes).toBeLessThan(CACHE_BUDGET_BYTES);
    const value = await fixture.hydrate("language.alpha");
    expect(value.patterns).toHaveLength(100);
    expect(fixture.runtime.cacheOccupancy().languageMemoryEstimatedBytes).toBeLessThan(CACHE_BUDGET_BYTES);
    expect(await fixture.resident("language.alpha")).toBe(value);
    expect(fixture.hydrations).toBe(1);
  });
  it("keeps request-seed setup lazy and reweighs the cache when canonical programs are first used", async () => {
    const fixture = await runtimeFixture({ modelSymbolCount: 8, compactGrammar: true, cacheBudgetBytes: 8 * 1024 * 1024 });
    const seed = await fixture.runtime.hydrateSurfaceLanguageMemoryCached(12, undefined, "request-seed", undefined, "", { languageId: "language.alpha", purpose: "request_seed" });
    expect(peekLanguageMemoryConstructionState(seed.state).bundles).toBeUndefined();
    const deferredBytes = fixture.runtime.cacheOccupancy().languageMemoryEstimatedBytes;
    expect(deferredBytes).toBeGreaterThan(0);
    const bundles = seed.state.importedConstructionBundles;
    expect(bundles).toHaveLength(1);
    const expandedBytes = fixture.runtime.cacheOccupancy().languageMemoryEstimatedBytes;
    expect(expandedBytes).toBeGreaterThan(deferredBytes);
    expect(seed.state.importedConstructionBundles).toBe(bundles);
    const resident = await fixture.runtime.hydrateSurfaceLanguageMemoryCached(12, undefined, "request-seed", undefined, "", { languageId: "language.alpha", purpose: "request_seed", residentOnly: true });
    expect(resident).toBe(seed);
    const pressure = await runtimeFixture({ modelSymbolCount: 8, compactGrammar: true, cacheBudgetBytes: Math.floor((deferredBytes + expandedBytes) / 2) });
    const cold = await pressure.runtime.hydrateSurfaceLanguageMemoryCached(12, undefined, "request-seed", undefined, "", { languageId: "language.alpha", purpose: "request_seed" });
    expect(pressure.runtime.cacheOccupancy().languageMemoryEntries).toBe(1);
    expect(cold.state.importedConstructionBundles).toEqual(bundles);
    expect(pressure.runtime.cacheOccupancy().languageMemoryEntries).toBe(0);
  });
  it("counts expanded source-example programs against the allowance even when compact storage fits", async () => {
    const generous = await runtimeFixture({ modelSymbolCount: 8, compactGrammar: true, cacheBudgetBytes: 8 * 1024 * 1024 });
    const warm = await generous.hydrate("language.alpha");
    expect(warm.state.importedConstructionBundles).toHaveLength(1);
    expect(warm.state.rejectedConstructionPatterns).toEqual([]);
    expect(await generous.resident("language.alpha")).toBe(warm);
    const expandedEstimate = generous.runtime.cacheOccupancy().languageMemoryEstimatedBytes;
    const pressureBudget = Math.floor(expandedEstimate / 2);
    // This is the actual compact compiler output, not a hand-built tiny record hiding a synthetic large object.
    expect(generous.persistedJsonBytes).toBeLessThan(pressureBudget);
    generous.invalidate();
    const aggregateBudget = Math.floor(expandedEstimate * 3 / 2);
    const evicting = await runtimeFixture({ modelSymbolCount: 8, compactGrammar: true, cacheBudgetBytes: aggregateBudget });
    await evicting.hydrate("language.alpha");
    const newest = await evicting.hydrate("language.beta");
    expect(evicting.runtime.cacheOccupancy()).toMatchObject({ languageMemoryEntries: 1 });
    expect(evicting.runtime.cacheOccupancy().languageMemoryEstimatedBytes).toBeLessThanOrEqual(aggregateBudget);
    await expect(evicting.resident("language.alpha")).rejects.toThrow(NOT_WARM);
    expect(await evicting.resident("language.beta")).toBe(newest);
    evicting.invalidate();
    const pressure = await runtimeFixture({ modelSymbolCount: 8, compactGrammar: true, cacheBudgetBytes: pressureBudget });
    const value = await pressure.hydrate("language.alpha");
    expect(value.state.importedConstructionBundles).toHaveLength(1);
    expect(pressure.runtime.cacheOccupancy()).toMatchObject({ languageMemoryEntries: 0, languageMemoryEstimatedBytes: 0 });
    await expect(pressure.resident("language.alpha")).rejects.toThrow(NOT_WARM);
  });

  it("visits a shared compiled bundle once across program and scoped-state aliases", async () => {
    const fixture = await runtimeFixture({ modelSymbolCount: 8, compactGrammar: true });
    const value = await fixture.hydrate("language.alpha");
    const bundle = value.state.importedConstructionBundles[0]!;
    const one = estimateRetainedProgramBytes([bundle]);
    expect(one).toBeGreaterThan(0);
    expect(estimateRetainedProgramBytes([bundle, bundle, bundle])).toBe(one);
    expect(estimateRetainedProgramBytes([bundle], 64)).toBeGreaterThan(64);
    expect(estimateRetainedProgramBytes([bundle], 64)).toBeLessThan(one);
  });

  it("caps tuning requests at the host allowance without sharing entries between kernel runtimes", async () => {
    const left = await runtimeFixture({ modelSymbolCount: 40, cacheBudgetBytes: 8 * 1024 ** 3, hostBudgetBytes: 128 * 1024 });
    const right = await runtimeFixture({ modelSymbolCount: 40, cacheBudgetBytes: 8 * 1024 ** 3, hostBudgetBytes: 128 * 1024 });
    const warm = await left.hydrate("language.alpha");
    expect(left.runtime.cacheOccupancy().languageMemoryMaxEstimatedBytes).toBe(128 * 1024);
    expect(left.runtime.cacheOccupancy().languageMemoryEstimatedBytes).toBeLessThanOrEqual(128 * 1024);
    await expect(right.resident("language.alpha")).rejects.toThrow(NOT_WARM);
    expect(await right.hydrate("language.alpha")).not.toBe(warm);
    left.invalidate();
    expect(right.runtime.cacheOccupancy().languageMemoryEntries).toBe(1);
  });

  it("admits one cold hydration at a time across distinct language keys", async () => {
    const fixture = await runtimeFixture({ modelSymbolCount: 40, gateHydration: true });
    const left = fixture.hydrate("language.alpha");
    const right = fixture.hydrate("language.beta");
    await fixture.hydrationStarted;
    expect(fixture.runtime.cacheOccupancy()).toMatchObject({ activeHydrations: 1, waitingHydrations: 1 });
    fixture.releaseHydration();
    await Promise.all([left, right]);
    expect(fixture.hydrations).toBe(2);
    expect(fixture.runtime.cacheOccupancy()).toMatchObject({ activeHydrations: 0, waitingHydrations: 0 });
  });

  it("does not retain a single hydration larger than the cache allowance", async () => {
    const fixture = await runtimeFixture({ modelSymbolCount: 4000 });
    await fixture.hydrate("language.alpha");
    expect(fixture.runtime.cacheOccupancy().languageMemoryEstimatedBytes).toBeLessThanOrEqual(CACHE_BUDGET_BYTES);
  });

  it("does not repopulate secondary scopes from hydrations queued before invalidation", async () => {
    const fixture = await runtimeFixture({ modelSymbolCount: 40, gateHydration: true });
    const first = fixture.hydrate("language.alpha");
    const queued = fixture.hydrate("language.beta");
    await fixture.hydrationStarted;
    fixture.invalidate();
    fixture.releaseHydration();
    await Promise.all([first, queued]);
    expect(fixture.runtime.cacheOccupancy()).toMatchObject({ languageMemoryEntries: 0, scopedStateReferences: 0 });
  });

  it.each(["profiles", "aliases", "evidence", "frames"] as const)("does not restore invalidated %s metadata from an older read", async kind => {
    const fixture = await runtimeFixture({ modelSymbolCount: 40 });
    fixture.invalidate();
    fixture.blockMetadata();
    const read = (residentOnly = false) => {
      if (kind === "profiles") return fixture.runtime.surfaceLanguageProfilesCached(residentOnly);
      if (kind === "aliases") return fixture.runtime.sourceOwnedLanguageProfilesCached(["fixture"], { residentOnly });
      if (kind === "evidence") return fixture.runtime.evidenceOwnedLanguageProfilesCached(["source.fixture" as never], { residentOnly });
      return fixture.runtime.sourceAnchorSemanticFramesCached({ residentOnly });
    };
    const obsolete = read();
    await fixture.metadataStarted;
    fixture.invalidate();
    fixture.releaseHydration();
    await obsolete;
    if (kind === "aliases" || kind === "frames") await expect(read(true)).rejects.toThrow(NOT_WARM);
    else expect(await read(true)).toMatchObject({ profiles: [] });
  });

  it.each(["identity", "cluster"] as const)("does not repopulate an invalidated %s cache from an older hydration", async scope => {
    const fixture = await runtimeFixture({ modelSymbolCount: 40, gateHydration: true });
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
    const fixture = await runtimeFixture({ modelSymbolCount: 40, gateHydration: true });
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
    const light = await runtimeFixture({ modelSymbolCount: 40, retainedHeapBytes: 16 * 1024 * 1024 });
    const first = await light.hydrate("language.alpha");
    await light.hydrate("language.beta");

    expect(await light.resident("language.alpha")).toBe(first);
    expect(light.hydrations).toBe(2);

    // The same bound, the same two keys, no measured heap at all: records alone push the pair over it and the
    // older entry goes. What an entry weighs is its content, so content is what can evict it.
    const heavy = await runtimeFixture({ modelSymbolCount: 4000, retainedHeapBytes: 0 });
    await heavy.hydrate("language.alpha");
    await heavy.hydrate("language.beta");

    await expect(heavy.resident("language.alpha")).rejects.toThrow(NOT_WARM);
  });

  it("hydrates one language key once for concurrent requests and hands both the same result", async () => {
    // A cold hydration runs 60-80s and a turn arrives every 20-30s, so every turn found an empty cache and started
    // its own copy of the same work, then abandoned it at its stage budget with no models at all.
    const fixture = await runtimeFixture({ modelSymbolCount: 40, gateHydration: true });

    const left = fixture.hydrate("language.alpha");
    const right = fixture.hydrate("language.alpha");
    fixture.releaseHydration();
    const [leftValue, rightValue] = await Promise.all([left, right]);

    expect(fixture.hydrations).toBe(1);
    expect(rightValue).toBe(leftValue);
  });

  it("loads an identity continuation population once for a warm language cache entry", async () => {
    const fixture = await runtimeFixture({ modelSymbolCount: 40, languageId: "language.fixture" });

    await fixture.hydrate("language.fixture");
    await fixture.hydrate("language.fixture");

    expect(fixture.populationReads).toBe(1);
  });

  it("shares one population read across concurrent role hydrations of the same language", async () => {
    const fixture = await runtimeFixture({ modelSymbolCount: 40, languageId: "language.fixture", gatePopulation: true });
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
    const fixture = await runtimeFixture({ modelSymbolCount: 40, languageId: "language.fixture", failPopulationOnce: true });
    expect((await fixture.hydrateRole("role.first")).state.continuationPopulation).toBeUndefined();
    expect((await fixture.hydrateRole("role.second")).state.continuationPopulation).toBeDefined();
    expect(fixture.populationReads).toBe(2);
  });
});

async function runtimeFixture(options: {
  modelSymbolCount: number;
  compactGrammar?: boolean;
  cacheBudgetBytes?: number;
  hostBudgetBytes?: number;
  retainedHeapBytes?: number;
  gateHydration?: boolean;
  gatePopulation?: boolean;
  failPopulationOnce?: boolean;
  languageId?: string;
  patternPayloadSizes?: readonly number[];
}) {
  const retained: string[] = [];
  let hydrations = 0;
  let populationReads = 0;
  let openGate = () => {};
  const gate = new Promise<void>(resolve => { openGate = resolve; });
  let markHydrationStarted = () => {};
  const hydrationStarted = new Promise<void>(resolve => { markHydrationStarted = resolve; });
  let blockMetadata = false;
  let markMetadataStarted = () => {};
  const metadataStarted = new Promise<void>(resolve => { markMetadataStarted = resolve; });
  const metadataGate = async () => {
    if (!blockMetadata) return;
    markMetadataStarted();
    await gate;
  };
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
  const hasher = createHasher();
  const compiler = createNgramMemoryCompiler({ hasher, idFactory: createIdFactory({ hasher, clock: createClock(), deterministicReplay: true }) });
  const compiled = compiler.compile({ streamId: "stream.fixture", sourceSystem: "oss_code", profile,
    sourceVersionId: profile.sourceVersionId, text: Array.from({ length: options.modelSymbolCount }, (_, index) => `symbol${index}`).join(" "),
    evidence: [], createdAt: 1, maxOrder: 3, retainObservations: false });
  const evidence: EvidenceSpan[] = [];
  const patterns = [] as import("../storage.js").LanguagePatternRecord[];
  for (const [index, bytes] of (options.patternPayloadSizes ?? []).entries()) patterns.push({
    id: `pattern.fixture.${index}`, profileId: profile.id, patternKind: "syntax", support: options.patternPayloadSizes!.length - index,
    entropy: 0, patternJson: { schema: "fixture.auxiliary.v1", payload: "p".repeat(bytes) }, evidenceIds: [], updatedAt: 1
  });
  if (options.compactGrammar) {
    const surfaces = Array.from({ length: 24 }, (_, index) => `subject${index} carries object${index}.`);
    const text = surfaces.join("\n");
    const ids = createIdFactory({ hasher, clock: createClock(), deterministicReplay: true });
    const bytes = new TextEncoder().encode(text);
    const contentHash = ids.contentHash(bytes);
    const span: EvidenceSpan = {
      id: ids.evidenceId({ sourceVersionId: profile.sourceVersionId, byteStart: 0, byteEnd: bytes.length, spanHash: contentHash }),
      sourceId: ids.sourceId("fixture", "fixture://compact"), sourceVersionId: profile.sourceVersionId,
      chunkId: ids.chunkId({ sourceVersionId: profile.sourceVersionId, byteStart: 0, byteEnd: bytes.length, chunkHash: contentHash }),
      contentHash, mediaType: "text/plain", byteStart: 0, byteEnd: bytes.length, charStart: 0, charEnd: text.length,
      text, textPreview: text, languageHints: {}, scriptHints: {}, trustVector: {}, provenance: {}, features: [],
      status: "promoted", alpha: 1, observedAt: 1
    };
    let offset = 0;
    const observations = surfaces.map((surface, index) => {
      const subject = `subject${index}`;
      const result = { sourceVersionId: String(span.sourceVersionId), evidenceId: String(span.id),
        surfaceStartCodePoint: offset, surfaceEndCodePoint: offset + surface.length,
        roles: [{ slotIndex: 0, startCodePoint: 0, endCodePoint: subject.length },
          { slotIndex: 1, startCodePoint: subject.length + 1, endCodePoint: subject.length + 8 },
          { slotIndex: 2, startCodePoint: subject.length + 9, endCodePoint: surface.length - 1 }] };
      offset += surface.length + 1;
      return result;
    });
    const grammar = compileLanguageConstructionPattern({ bindingId: "relation.fixture", profileId: profile.id,
      observations, evidence: [span], hasher, updatedAt: 1, storageEncoding: SOURCE_EXAMPLE_CONSTRUCTION_STORAGE });
    if (grammar.status !== "compiled") throw new Error(JSON.stringify(grammar.issues));
    patterns.push(grammar.pattern);
    evidence.push(span);
  }
  const storage = {
    brainImports: { active: async () => ({ activeImportRunIds: [] }) },
    evidence: { getEvidenceBatch: async () => evidence },
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
        return compiled.models;
      },
      listNgramObservations: async () => { throw new Error("serving must not load raw counts"); },
      listLanguageUnits: async () => [],
      listLanguagePatterns: async () => patterns,
      listSemanticFrames: async () => {
        await metadataGate();
        return blockMetadata ? [{ id: "frame.fixture", frameJson: { preview: "fixture" }, embedding: [], evidenceIds: [], alpha: 1, createdAt: 1 }] : [];
      }
    },
    segmentationPopulations: { listRecent: async () => [] },
    model: { listLanguageProfiles: async () => { await metadataGate(); return [profile]; } }
  } as unknown as ScceKernelDeps["storage"];
  const runtime = createSurfaceLanguageRuntime({
    deps: { storage, corpusRegistry: [], surfaceLanguageMemoryCacheMaxEstimatedBytes: options.hostBudgetBytes },
    languageMemoryRuntime: createLanguageMemoryRuntime({ hasher }),
    clock: createClock({ fixedTime: 0, stepMs: 100 }),
    hasher,
    cacheMs: 10_000_000,
    profileLimit: 32,
    surfaceLanguageMemoryCacheMaxEntries: 100,
    surfaceLanguageMemoryCacheMaxEstimatedBytes: options.cacheBudgetBytes ?? CACHE_BUDGET_BYTES,
    languageResolver: () => ({ profile: () => options.languageId, corpus: () => options.languageId })
  });
  const cluster = await runtime.surfaceLanguageClusterCached("fixture language");

  return {
    runtime,
    persistedJsonBytes: JSON.stringify([compiled.models, patterns, evidence]).length,
    blockMetadata: () => { blockMetadata = true; },
    metadataStarted,
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
