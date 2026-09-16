// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
import { beforeEach, describe, expect, it } from "vitest";
import { createIdFactory } from "../ids.js";
import {
  clearNgramModelCompilationMemo,
  createLanguageMemoryRuntime,
  ngramModelCompilationCount,
  scopeLanguageMemoryStateToCluster
} from "../language-memory-runtime.js";
import { buildLanguageProfileClusters, languageSurfaceTrigrams } from "../language.js";
import { createNgramMemoryCompiler } from "../ngram-memory.js";
import { createClock, createHasher, featureSet } from "../primitives.js";
import type { ScceKernelDeps } from "../storage.js";
import { createSurfaceLanguageRuntime } from "../surface-language-runtime.js";
import type { EvidenceSpan, LanguageProfile } from "../types.js";

beforeEach(() => {
  clearNgramModelCompilationMemo();
});

describe("a record is compiled into a runtime model once, not once per hydration or scoping", () => {
  it("does not recompile a record the gate in front of the hydration already compiled", async () => {
    const fixture = runtimeFixture();
    const cluster = await fixture.runtime.surfaceLanguageClusterCached("fixture language survey");

    const hydrated = await fixture.runtime.hydrateSurfaceLanguageMemoryCached(12, cluster, "source-cluster-selected");

    expect(hydrated.state.models.length).toBeGreaterThan(0);
    // surface-language-runtime's persistedModelsPresent gate compiles records one at a time in front of the
    // hydration that compiles them again. Each loaded record may be compiled at most once across both.
    expect(ngramModelCompilationCount()).toBeLessThanOrEqual(fixture.records.length);
  });

  it("re-scoping an already hydrated state compiles nothing", () => {
    const fixture = runtimeFixture();
    const runtime = createLanguageMemoryRuntime({ hasher: createHasher() });
    const state = runtime.hydrateFromImportedBrain({
      models: fixture.records, observations: [], units: [], patterns: [], semanticFrames: [], constructionEvidence: []
    });
    const compiledAtHydration = ngramModelCompilationCount();
    expect(compiledAtHydration).toBeGreaterThan(0);

    const cluster = buildLanguageProfileClusters(fixture.profiles)[0]!;
    const scoped = scopeLanguageMemoryStateToCluster(state, cluster);
    expect(scoped.models.length).toBeGreaterThan(0);

    // Scoping re-derives models from the retained records; the compiled form is identical, so it must be reused.
    expect(ngramModelCompilationCount()).toBe(compiledAtHydration);
    for (const model of scoped.models) expect(state.models).toContain(model);
  });

  it("a second hydration of the same records compiles nothing", () => {
    const fixture = runtimeFixture();
    const runtime = createLanguageMemoryRuntime({ hasher: createHasher() });
    const input = {
      models: fixture.records, observations: [], units: [], patterns: [], semanticFrames: [], constructionEvidence: []
    };
    const first = runtime.hydrateFromImportedBrain(input);
    const compiledOnce = ngramModelCompilationCount();
    expect(compiledOnce).toBe(fixture.records.length);

    const second = runtime.hydrateFromImportedBrain(input);

    expect(ngramModelCompilationCount()).toBe(compiledOnce);
    expect(second.models).toEqual(first.models);
  });

  it("compiles again when the record's content changes under the same id", () => {
    const fixture = runtimeFixture();
    const runtime = createLanguageMemoryRuntime({ hasher: createHasher() });
    const record = fixture.records[0]!;
    runtime.hydrateFromImportedBrain({ models: [record], observations: [], units: [], patterns: [], semanticFrames: [], constructionEvidence: [] });
    const compiledOnce = ngramModelCompilationCount();

    const rewritten = { ...record, updatedAt: record.updatedAt + 1 };
    const after = runtime.hydrateFromImportedBrain({ models: [rewritten], observations: [], units: [], patterns: [], semanticFrames: [], constructionEvidence: [] });

    expect(ngramModelCompilationCount()).toBe(compiledOnce + 1);
    expect(after.models.length).toBe(1);
  });
});

function corpus(seed: number, unit: string, noun: string): string {
  const lines: string[] = [];
  for (let i = 0; i < 30; i++) {
    lines.push(`The ${noun} survey measured ${(i * 37 + seed) % 900 + 12} ${unit} across the valley.`);
    lines.push(`Records list 1,${String(100 + i * 7 + seed)}.${i % 9} ${unit} for the ${noun}.`);
  }
  return lines.join(" ");
}

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
    profiles,
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
    provenance: { source: "ngram-model-compilation-memo.test" },
    features: featureSet(text, 256),
    status: "promoted",
    alpha: 0.9,
    observedAt: 1
  };
}
