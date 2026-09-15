// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
import { afterEach, describe, expect, it } from "vitest";
import { clearFreeFormLexicon, primeFreeFormLexicon } from "../free-form-lexicon.js";
import { createIdFactory } from "../ids.js";
import { createLanguageMemoryRuntime } from "../language-memory-runtime.js";
import { createNgramMemoryCompiler } from "../ngram-memory.js";
import { clearNumericTokenStatisticsCache, deriveNumericTokenStatistics, numericTokenDerivationCount, residentNumericTokenStatistics } from "../numeric-token-statistics.js";
import { createClock, createHasher, featureSet } from "../primitives.js";
import type { EvidenceSpan, LanguageProfile } from "../types.js";

const probes = ["metres", "tonnes", "survey", "the", ",", "."];

function decisions(statistics: ReturnType<typeof residentNumericTokenStatistics>): string[] {
  return probes.map(symbol => `${symbol}:${statistics.unit(symbol)}:${statistics.separator(symbol)}`);
}

function corpus(seed: number, unit: string): string {
  const lines: string[] = [];
  for (let i = 0; i < 30; i++) {
    lines.push(`The survey measured ${(i * 37 + seed) % 900 + 12} ${unit} across the valley in the north.`);
    lines.push(`Records list 1,${String(100 + i * 7 + seed)}.${i % 9} ${unit} for the river.`);
  }
  return lines.join(" ");
}

function hydratedState(streamId: string, text: string) {
  const hasher = createHasher();
  const compiler = createNgramMemoryCompiler({
    hasher,
    idFactory: createIdFactory({ clock: createClock({ fixedTime: 1 }), hasher, deterministicReplay: true })
  });
  const learned = profile(`profile.${streamId}`, `source.${streamId}`);
  const evidence = span(`evidence.${streamId}`, text);
  const compiled = compiler.compile({
    streamId,
    profile: learned,
    sourceVersionId: learned.sourceVersionId,
    text,
    evidence: [evidence],
    createdAt: 1
  });
  return createLanguageMemoryRuntime({ hasher }).hydrate({ models: compiled.models });
}

afterEach(() => {
  clearFreeFormLexicon();
  clearNumericTokenStatisticsCache();
});

describe("numeric token counts are derived where models are hydrated", () => {
  it("leaves a turn that primes the lexicon with nothing left to derive", () => {
    clearNumericTokenStatisticsCache();
    const state = hydratedState("stream.numeric", corpus(1, "metres"));
    expect(state.models.length).toBeGreaterThan(0);

    const afterHydration = numericTokenDerivationCount();
    expect(afterHydration).toBe(state.models.length);

    primeFreeFormLexicon(state.models);
    const turn = decisions(residentNumericTokenStatistics());
    expect(numericTokenDerivationCount()).toBe(afterHydration);

    expect(turn).toEqual(decisions(deriveNumericTokenStatistics(state.models)));
  });

  it("re-hydrating the same persisted records derives nothing a second time", () => {
    clearNumericTokenStatisticsCache();
    const first = hydratedState("stream.repeat", corpus(2, "tonnes"));
    const afterFirst = numericTokenDerivationCount();
    expect(afterFirst).toBe(first.models.length);

    const second = hydratedState("stream.repeat", corpus(2, "tonnes"));
    expect(numericTokenDerivationCount()).toBe(afterFirst);

    primeFreeFormLexicon(second.models);
    residentNumericTokenStatistics();
    expect(numericTokenDerivationCount()).toBe(afterFirst);
  });
});

function profile(id: string, sourceVersionId: string): LanguageProfile {
  return {
    id,
    sourceVersionId: sourceVersionId as LanguageProfile["sourceVersionId"],
    scripts: [{ script: "script:Latn", mass: 1 }],
    symbolShapes: [],
    charNgrams: [{ ngram: "the", count: 1 }],
    direction: "ltr",
    entropy: 0.2,
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
    textPreview: text,
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
