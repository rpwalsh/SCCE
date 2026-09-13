// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
import { afterEach, describe, expect, it } from "vitest";
import {
  clearCorpusIdentitySignals,
  concentrationThreshold,
  contentRuns,
  corpusNamedIdentities,
  corpusNamedRuns,
  primeCorpusIdentitySignals
} from "../corpus-identity.js";

function prime(input: {
  closedClass?: Iterable<string>;
  identities?: Iterable<string>;
  spread?: Iterable<readonly [string, number]>;
  concentration?: number;
}): void {
  primeCorpusIdentitySignals({
    closedClass: new Set(input.closedClass ?? []),
    identities: new Set(input.identities ?? []),
    spread: new Map(input.spread ?? []),
    concentration: input.concentration ?? 0
  });
}

afterEach(() => clearCorpusIdentitySignals());

describe("corpus identity arbiter", () => {
  it("names a run the corpus carries as a whole source identity", () => {
    prime({ closedClass: ["what", "is"], identities: ["moby dick"] });

    expect(corpusNamedIdentities("What is Moby Dick?")).toEqual(["moby dick"]);
    expect(corpusNamedRuns("What is Moby Dick?")).toEqual(["moby dick"]);
  });

  it("does not name a run that is merely contained in a longer identity", () => {
    // The corpus is titled with "explain" and holds an article whose title contains it. Matched by containment,
    // every request about the Marcos family named the verb, which then anchored retrieval and discourse binding.
    prime({ closedClass: ["of", "the"], identities: ["explain"] });

    expect(corpusNamedIdentities("unexplained wealth of the marcos family")).toEqual([]);
    expect(corpusNamedRuns("unexplained wealth of the marcos family"))
      .toEqual(["unexplained wealth", "marcos family"]);

    // The other direction of the same rule: a request run sitting inside one of the corpus's titles is not that
    // title, so an unrelated request does not inherit the article's subject.
    prime({ closedClass: ["of", "the"], identities: ["unexplained wealth of the marcos family"] });
    expect(corpusNamedIdentities("explain relativity")).toEqual([]);
  });

  it("names nothing for a title built only of units the language uses as scaffolding", () => {
    // The corpus really does hold a source titled "a", so containment reported it as the subject of every request.
    prime({ closedClass: ["what", "is", "a"], identities: ["a"] });

    expect(corpusNamedIdentities("what is a quasar")).toEqual([]);
    expect(corpusNamedRuns("what is a quasar")).toEqual(["quasar"]);
  });

  it("matches identities at unit boundaries where the writing system supplies them, by containment where it does not", () => {
    prime({ identities: ["相対性理論"] });
    expect(corpusNamedIdentities("相対性理論とは何ですか"))
      .toEqual(["相対性理論"]);

    // The same title inside a spaced request is not a unit of it, so boundaries decide once the writing system
    // supplies them.
    prime({ closedClass: ["the"], identities: ["相対性理論"] });
    expect(corpusNamedIdentities("the 相対性理論とは何ですか question"))
      .toEqual([]);
  });

  it("returns maximal content runs and their units, never every sub-run", () => {
    const closedClass = new Set(["the", "of"]);

    expect(contentRuns("the quick brown fox of the lazy dog", closedClass))
      .toEqual(["quick brown fox", "quick", "brown", "fox", "lazy dog", "lazy", "dog"]);

    // Linear, not quadratic: one coding request enumerated 299 sub-runs and measured every one of them against
    // the database inside a single turn.
    const units = Array.from({ length: 60 }, (_, index) => `unit${index}`);
    expect(contentRuns(units.join(" "), closedClass)).toHaveLength(units.length + 1);
  });

  it("splits a spread distribution at the corpus's own Otsu boundary", () => {
    const documented = Array.from({ length: 200 }, () => 2);
    const merelyUsed = Array.from({ length: 200 }, () => 100);

    const threshold = concentrationThreshold([...documented, ...merelyUsed], 1);

    expect(documented.every(value => value <= threshold)).toBe(true);
    expect(merelyUsed.every(value => value > threshold)).toBe(true);
    expect(concentrationThreshold([], 1)).toBe(0);
    expect(concentrationThreshold([7], 1)).toBe(0);
  });

  it("thresholds a distribution far larger than the argument limit without overflowing the stack", () => {
    const distribution = Array.from({ length: 200_000 }, (_, index) => (index % 50) + 1);

    const threshold = concentrationThreshold(distribution, 1);

    expect(Number.isFinite(threshold)).toBe(true);
    expect(threshold).toBeGreaterThan(0);
  });
});
