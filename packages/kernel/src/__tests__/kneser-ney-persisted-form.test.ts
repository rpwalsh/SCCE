// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
import { describe, expect, it, vi } from "vitest";
import {
  deriveKneserNeyContextTables,
  kneserNeyMaterializationCounts,
  kneserNeyProbability,
  materializeKneserNey,
  persistedKneserNey,
  predictKneserNey,
  trainKneserNey
} from "../kneser-ney.js";
import { createIdFactory } from "../ids.js";
import { createLanguageMemoryRuntime } from "../language-memory-runtime.js";
import { languageSurfaceTrigrams } from "../language.js";
import { createNgramMemoryCompiler } from "../ngram-memory.js";
import { createClock, createHasher, featureSet } from "../primitives.js";
import type { EvidenceSpan, LanguageProfile } from "../types.js";

const DERIVED_KEYS = ["contextCounts", "contextContinuationTypes", "successorIndex", "successorOverflowCounts", "backoffWeights", "baseContinuations"];

function corpus(): string {
  const lines: string[] = [];
  for (let i = 0; i < 40; i++) {
    lines.push(`The valley survey measured ${(i * 37) % 900 + 12} metres across the valley.`);
    lines.push(`Records list 1,${String(100 + i * 7)}.${i % 9} metres for the valley.`);
  }
  return lines.join(" ");
}

describe("a persisted Kneser-Ney model carries its sufficient statistics only", () => {
  it("copies core statistics without allocating entry-pair lists and preserves own prototype-named counts", () => {
    const trained = trainKneserNey(["constructor", "toString", "valueOf", "constructor"], { order: 3 });
    const stored = JSON.parse(JSON.stringify(persistedKneserNey(trained)));
    Object.defineProperty(stored.counts, "__proto__", { value: 7, enumerable: true });
    stored.counts.invalid = "untrusted numeric text";
    stored.counts.nonfinite = Infinity;
    stored.counts.negativeZero = -0;
    const expected = Object.fromEntries(Object.entries(stored.counts).map(([key, raw]) => [key,
      typeof raw === "number" && Number.isFinite(raw) ? raw : 0]));
    const statistics = new Set([stored.counts, stored.continuationCounts, stored.unigramCounts]);
    const entries = Object.entries;
    const guarded = vi.spyOn(Object, "entries").mockImplementation(value => {
      if (statistics.has(value)) throw Error("allocated an entry-pair list for canonical model statistics");
      return entries(value);
    });
    try {
      const model = materializeKneserNey(stored)!;
      expect(model.counts).toEqual(expected);
      expect(Object.getPrototypeOf(model.counts)).toBe(Object.prototype);
      expect(Object.getOwnPropertyDescriptor(model.counts, "__proto__")).toEqual({ value: 7, writable: true, enumerable: true, configurable: true });
      expect(Object.is(model.counts.negativeZero, -0)).toBe(true);
      stored.counts.constructor = 999;
      expect(model.counts.constructor).toBe(trained.counts.constructor);
    } finally { guarded.mockRestore(); }
  });

  it.each([2, 3, 4])("defers order %i derived tables until inference and preserves every probability exactly", order => {
    const trained = trainKneserNey(`${corpus()} 船長 は 海 を 見る。 船長 は 船 を 見る。`, { order, vocabularyLimit: 4000 });
    const stored = JSON.parse(JSON.stringify(persistedKneserNey(trained)));
    const before = kneserNeyMaterializationCounts();
    const lazy = materializeKneserNey(stored)!;
    expect(lazy.observedSymbolCount).toBe(trained.observedSymbolCount);
    expect(lazy.continuationCounts).toEqual(trained.continuationCounts);
    expect(persistedKneserNey(lazy)).toEqual(stored);
    expect(kneserNeyMaterializationCounts()).toEqual(before);
    stored.counts = {};
    stored.continuationCounts = {};
    stored.vocabulary.length = 0;
    for (const context of [[], ["the"], ["the", "valley"], ["records"], ["metres", "for"], ["船長"], ["unseen-context"]]) {
      for (const symbol of [...trained.vocabulary, "unseen-symbol"]) {
        expect(kneserNeyProbability(lazy, context, symbol)).toBe(kneserNeyProbability(trained, context, symbol));
      }
      expect(predictKneserNey(lazy, context, 12)).toEqual(predictKneserNey(trained, context, 12));
    }
    expect(kneserNeyMaterializationCounts()).toEqual({ contextTables: before.contextTables + 1, runtimeIndexes: before.runtimeIndexes + 1 });
    expect(lazy).toEqual(trained);
  });

  for (const order of [2, 3, 4]) {
    it(`order ${order}: materializing the persisted form reproduces the trained model exactly`, () => {
      const model = trainKneserNey(corpus(), { order, vocabularyLimit: 4000 });
      const persisted = persistedKneserNey(model);
      for (const key of DERIVED_KEYS) expect(persisted).not.toHaveProperty(key);
      const stored = JSON.parse(JSON.stringify(persisted));
      const materialized = materializeKneserNey(stored);
      expect(materialized).toEqual(model);
      expect(JSON.stringify(stored).length).toBeLessThan(JSON.stringify(model).length);
      for (const context of [["the"], ["the", "valley"], ["records"], ["metres", "for"]]) {
        expect(predictKneserNey(materialized!, context, 5)).toEqual(predictKneserNey(model, context, 5));
      }
    });
  }

  it("derives the context tables the trainer computed", () => {
    const model = trainKneserNey(corpus(), { order: 4 });
    expect(deriveKneserNeyContextTables(model.counts)).toEqual({
      contextCounts: model.contextCounts,
      contextContinuationTypes: model.contextContinuationTypes
    });
  });

  it("still reads the older full record unchanged", () => {
    const model = trainKneserNey(corpus(), { order: 3 });
    expect(materializeKneserNey(JSON.parse(JSON.stringify(model)))).toEqual(model);
  });

  it("the compiler writes the persisted form and hydration compiles it back", () => {
    const hasher = createHasher();
    const compiler = createNgramMemoryCompiler({
      hasher,
      idFactory: createIdFactory({ clock: createClock({ fixedTime: 1 }), hasher, deterministicReplay: true })
    });
    const languageProfile = profile("profile.persisted", "fixture language survey");
    const records = compiler.compile({
      streamId: "stream.persisted",
      profile: languageProfile,
      sourceVersionId: languageProfile.sourceVersionId,
      text: corpus(),
      evidence: [span("evidence.persisted", corpus())],
      createdAt: 1
    }).models;
    expect(records.length).toBeGreaterThan(0);
    for (const record of records) {
      const stored = (record.modelJson as Record<string, unknown>).model as Record<string, unknown>;
      expect(stored).toHaveProperty("counts");
      expect(stored).toHaveProperty("continuationCounts");
      for (const key of DERIVED_KEYS) expect(stored).not.toHaveProperty(key);
    }
    const state = createLanguageMemoryRuntime({ hasher }).hydrateFromImportedBrain({
      models: records, observations: [], units: [], patterns: [], semanticFrames: [], constructionEvidence: []
    });
    expect(state.models.length).toBe(records.length);
    for (const model of state.models) {
      expect(Object.keys(model.successorIndex).length).toBeGreaterThan(0);
      expect(Object.keys(model.contextCounts).length).toBeGreaterThan(0);
      expect(Object.keys(model.backoffWeights).length).toBeGreaterThan(0);
    }
  });
});

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
    provenance: { source: "kneser-ney-persisted-form.test" },
    features: featureSet(text, 256),
    status: "promoted",
    alpha: 0.9,
    observedAt: 1
  };
}
