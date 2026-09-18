// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
import { describe, expect, it } from "vitest";
import { createHasher } from "../primitives.js";
import { discoverLanguageIdentities, majorityClosedClass, type LanguageProfileSignature } from "../language-identity.js";

// Identity discovery counts documents and Kneser-Ney wants text per model, so one artifact cannot serve both:
// while the discovery population was the trained-shard profiles, a brain of 1,695 sources had 17 documents and
// discovered nothing. These checks pin the population dependency that made page signatures necessary.

const FUNCTION_WORDS = ["the", "of", "and", "to", "in", "a", "is", "was"];

/** One document's signature: the shared function words every document carries, plus its own content words. */
function signature(index: number): LanguageProfileSignature {
  const content = [`content${index}`, `topic${index}`, `name${index}`];
  return {
    id: `profile-${String(index).padStart(3, "0")}`,
    family: "corpus:wikipedia",
    scripts: [{ script: "script:Latn", mass: 1 }],
    direction: "ltr",
    topContinuation: [...FUNCTION_WORDS.map((word, at) => [word, 1000 - at] as [string, number]), ...content.map(word => [word, 5] as [string, number])]
  };
}

describe("the closed class is a property of the document population", () => {
  it("keeps the words a majority of documents carry and drops each document's own content", () => {
    const closedClass = majorityClosedClass(Array.from({ length: 13 }, (_, index) => signature(index)));
    expect(closedClass.map(row => row.word).sort()).toEqual([...FUNCTION_WORDS].sort());
    expect(closedClass.every(row => row.documentShare === 1)).toBe(true);
    expect(closedClass.some(row => row.word.startsWith("content"))).toBe(false);
  });

  it("cannot separate function words from content words on a single document", () => {
    // Every word of one document is carried by every document of that population, content words included.
    const closedClass = majorityClosedClass([signature(0)]);
    expect(closedClass.some(row => row.word.startsWith("content"))).toBe(true);
  });

  it("gives an identity a usable closed class only once the population is large enough", () => {
    const discover = (count: number) => discoverLanguageIdentities({
      signatures: Array.from({ length: count }, (_, index) => signature(index)),
      hasher: createHasher(),
      now: 1_700_000_000_000
    });
    // A single document still yields an identity; what it cannot yield is a closed class that excludes that
    // document's own subject matter. Population size decides the quality of the class, not its existence.
    const one = discover(1);
    const many = discover(13);
    expect(many.identities.length).toBeGreaterThan(0);
    const manyWords = many.identities.flatMap(identity => identity.closedClass.map(row => row.word));
    expect(manyWords.length).toBeGreaterThan(0);
    expect(manyWords.some(word => word.startsWith("content") || word.startsWith("topic"))).toBe(false);
    // Below the family floor there is no closed class at all -- which is the live failure this change fixes:
    // a brain whose discovery population is its trained shards sits under the floor and learns nothing.
    const oneWords = one.identities.flatMap(identity => identity.closedClass.map(row => row.word));
    expect(oneWords).toEqual([]);
  });

  it("sharpens as the population grows, because a content word cannot reach a majority", () => {
    const share = (count: number) => {
      const closedClass = majorityClosedClass(Array.from({ length: count }, (_, index) => signature(index)));
      return closedClass.filter(row => row.word.startsWith("content") || row.word.startsWith("topic")).length;
    };
    expect(share(1)).toBeGreaterThan(0);
    expect(share(5)).toBe(0);
    expect(share(50)).toBe(0);
  });
});
