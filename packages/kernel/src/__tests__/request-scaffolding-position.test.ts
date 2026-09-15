// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
import { afterEach, describe, expect, it } from "vitest";
import { deriveClosedClassWords, requestClosedClassWords } from "../closed-class-words.js";
import { clearCorpusIdentitySignals, primeCorpusIdentitySignals } from "../corpus-identity.js";
import { requestContentEvidenceUnits } from "../local-evidence-runtime.js";
import type { LanguageContinuationPopulation } from "../storage.js";

afterEach(() => clearCorpusIdentitySignals());

// The corpus decides scaffolding, so where the interrogative stands in the request may not change the answer.
describe("request scaffolding is decided by the corpus, not by the word's position", () => {
  it("discounts an interrogative the corpus ranks wherever it stands, first, sixth or last", () => {
    const population = fixturePopulation("language.fixture", ["which", "what"], { country: 1, indigenous: 1, people: 1, capital: 1, kenya: 1 });
    primeCorpusIdentitySignals({
      closedClass: deriveClosedClassWords({ continuationPopulation: population }),
      identities: new Set(["ainu people", "kenya"]),
      spread: new Map(),
      concentration: 0
    });

    const sixth = "The Ainu people are indigenous to which country?";
    const closedSixth = requestClosedClassWords({ requestText: sixth, continuationPopulation: population });
    expect(closedSixth.has("which")).toBe(true);
    expect(coverage(sixth, closedSixth)).not.toContain("which");
    expect(coverage(sixth, closedSixth)).toEqual(["ainu", "people", "indigenous", "country"]);

    const last = "The capital of Kenya is what?";
    const closedLast = requestClosedClassWords({ requestText: last, continuationPopulation: population });
    expect(closedLast.has("what")).toBe(true);
    expect(coverage(last, closedLast)).not.toContain("what");
    expect(coverage(last, closedLast)).toEqual(["capital", "kenya"]);
  });

  it("keeps a relation the corpus does not rank as scaffolding, in any position", () => {
    const population = fixturePopulation("language.fixture", ["when", "which"], { born: 1, capital: 1, peru: 1 });
    primeCorpusIdentitySignals({
      closedClass: deriveClosedClassWords({ continuationPopulation: population }),
      identities: new Set(["albert einstein", "peru"]),
      spread: new Map(),
      concentration: 0
    });

    const trailing = "When was Albert Einstein born?";
    const closedTrailing = requestClosedClassWords({ requestText: trailing, continuationPopulation: population });
    expect(closedTrailing.has("when")).toBe(true);
    expect(closedTrailing.has("born")).toBe(false);
    expect(coverage(trailing, closedTrailing)).toContain("born");

    const middle = "Which capital does Peru have?";
    const closedMiddle = requestClosedClassWords({ requestText: middle, continuationPopulation: population });
    expect(closedMiddle.has("capital")).toBe(false);
    expect(coverage(middle, closedMiddle)).toContain("capital");
  });

  it("reads the same corpus signal in a language whose scaffolding is its own", () => {
    const population = fixturePopulation("language.fixture-fr", ["quelle", "dans"], { capitale: 1, nation: 1, france: 1 });
    primeCorpusIdentitySignals({
      closedClass: deriveClosedClassWords({ continuationPopulation: population }),
      identities: new Set(["france"]),
      spread: new Map(),
      concentration: 0
    });

    const request = "La capitale de la France est dans quelle nation?";
    const closed = requestClosedClassWords({ requestText: request, continuationPopulation: population });
    expect(closed.has("quelle")).toBe(true);
    expect(closed.has("dans")).toBe(true);
    expect(closed.has("capitale")).toBe(false);
    expect(coverage(request, closed)).toEqual(["capitale", "france", "nation"]);
  });
});

function coverage(requestText: string, closed: ReadonlySet<string>): string[] {
  return requestContentEvidenceUnits(requestText).filter(unit => !closed.has(unit));
}

function fixturePopulation(
  languageId: string,
  leading: readonly string[],
  tail: Record<string, number>
): LanguageContinuationPopulation {
  const continuationCounts: Record<string, number> = {};
  for (let index = 0; index < 192; index += 1) {
    const first = String.fromCharCode(97 + Math.floor(index / 26));
    const second = String.fromCharCode(97 + (index % 26));
    continuationCounts[`fixture${first}${second}`] = 10_000 - index;
  }
  for (let index = 0; index < leading.length; index += 1) continuationCounts[leading[index]!] = 20_000 - index;
  for (const [symbol, count] of Object.entries(tail)) continuationCounts[symbol] = count;
  return { languageId, modelCount: 2_000, continuationCounts };
}
