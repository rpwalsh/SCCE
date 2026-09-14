// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
import { afterEach, describe, expect, it } from "vitest";
import { deriveClosedClassWords, requestClosedClassWords } from "../closed-class-words.js";
import { clearCorpusIdentitySignals, primeCorpusIdentitySignals } from "../corpus-identity.js";
import { createLanguageMemoryRuntime, markLanguageMemoryStateUnscoped, scopeLanguageMemoryStateToLanguage } from "../language-memory-runtime.js";
import { evidenceForRequest } from "../local-evidence-runtime.js";
import type { LanguageContinuationPopulation } from "../storage.js";
import type { EvidenceId, EvidenceSpan, SourceVersionId } from "../types.js";

afterEach(() => clearCorpusIdentitySignals());

describe("identity-scoped continuation population", () => {
  it("supplies corpus scaffolding without turning lower-ranked relations or subjects into scaffolding", () => {
    const population = fixturePopulation("language.fixture", ["which", "is"]);
    const functionSymbols = deriveClosedClassWords({ continuationPopulation: population });
    primeCorpusIdentitySignals({
      closedClass: functionSymbols,
      identities: new Set(["gondor"]),
      spread: new Map(),
      concentration: 0
    });

    const closed = requestClosedClassWords({
      requestText: "which country is gondor",
      continuationPopulation: population
    });

    expect(closed.has("which")).toBe(true);
    expect(closed.has("is")).toBe(false);
    expect(closed.has("country")).toBe(false);
    expect(closed.has("gondor")).toBe(false);
    const languageClosed = deriveClosedClassWords({ continuationPopulation: population });
    expect(languageClosed.has("born")).toBe(false);
    expect(languageClosed.has("country")).toBe(false);
    expect(languageClosed.has("dentist")).toBe(false);
  });

  it("does not treat a sparse population as a learned closed class", () => {
    const population: LanguageContinuationPopulation = {
      languageId: "language.sparse",
      modelCount: 1,
      continuationCounts: { dentist: 1 }
    };

    expect([...deriveClosedClassWords({ continuationPopulation: population })]).toEqual([]);
  });

  it("measures population completeness before ranked case variants collapse", () => {
    const population: LanguageContinuationPopulation = {
      languageId: "language.case-variants",
      modelCount: 2,
      continuationCounts: { which: 100, A: 99, a: 98, born: 1 }
    };

    const words = deriveClosedClassWords({ continuationPopulation: population, limit: 3 });
    expect(words.has("which")).toBe(true);
    expect(words.has("a")).toBe(true);
    expect(words.has("born")).toBe(false);
  });

  it("keeps a population only in its matching language scope and clears it when unscoped", () => {
    const population = fixturePopulation("language.alpha", ["which"]);
    const base = createLanguageMemoryRuntime().hydrate({ models: [], observations: [], units: [], patterns: [] });
    const state = { ...base, continuationPopulation: population };
    const resolver = { profile: () => undefined, corpus: () => undefined };

    expect(scopeLanguageMemoryStateToLanguage(state, "language.alpha", resolver).continuationPopulation).toBe(population);
    expect(scopeLanguageMemoryStateToLanguage(state, "language.beta", resolver).continuationPopulation).toBeUndefined();
    expect(markLanguageMemoryStateUnscoped(state, "fixture").continuationPopulation).toBeUndefined();
  });

  it("makes a corpus-known request opener reach the existing answerhood ordering", () => {
    const request = "which captain of the Pequod?";
    const population = fixturePopulation("language.fixture", ["which", "the"]);
    const functionSymbols = deriveClosedClassWords({ continuationPopulation: population });
    primeCorpusIdentitySignals({
      closedClass: functionSymbols,
      identities: new Set(["pequod"]),
      spread: new Map(),
      concentration: 0
    });
    const closed = requestClosedClassWords({ requestText: request, continuationPopulation: population });
    const scattered = span("scattered", 0.95, "Is this the Pequod? A sailor spoke of the weather. The captain was below and would not be disturbed.");
    const answering = span("answering", 0.5, "Captain Ahab of the Pequod stood upon his quarter-deck, and the crew waited.");

    expect(String(evidenceForRequest(request, [scattered, answering])[0]?.id)).toBe("evidence:scattered");
    expect(String(evidenceForRequest(request, [scattered, answering], new Set(), new Set(), new Set(), closed)[0]?.id))
      .toBe("evidence:answering");
  });
});

function fixturePopulation(languageId: string, leading: readonly string[]): LanguageContinuationPopulation {
  const continuationCounts: Record<string, number> = {};
  for (let index = 0; index < 192; index += 1) {
    const first = String.fromCharCode(97 + Math.floor(index / 26));
    const second = String.fromCharCode(97 + (index % 26));
    continuationCounts[`fixture${first}${second}`] = 10_000 - index;
  }
  for (let index = 0; index < leading.length; index += 1) continuationCounts[leading[index]!] = 20_000 - index;
  continuationCounts.born = 1;
  continuationCounts.country = 1;
  continuationCounts.dentist = 1;
  return { languageId, modelCount: 2_000, continuationCounts };
}

function span(id: string, alpha: number, text: string): EvidenceSpan {
  return {
    id: `evidence:${id}` as EvidenceId,
    sourceVersionId: `version:${id}` as SourceVersionId,
    text,
    textPreview: text,
    status: "promoted",
    alpha,
    charStart: 100,
    features: [],
    provenance: {
      uri: `fixture://${id}`,
      title: "Pequod",
      identity: "pequod ahab sailor",
      sourceVersionId: `version:${id}`,
      byteRange: [0, text.length],
      charRange: [100, 100 + text.length]
    }
  } as unknown as EvidenceSpan;
}
