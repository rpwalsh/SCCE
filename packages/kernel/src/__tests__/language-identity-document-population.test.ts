// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
import { describe, expect, it } from "vitest";
import { createHasher } from "../primitives.js";
import { discoverLanguageIdentities, majorityClosedClass, type LanguageProfileSignature } from "../language-identity.js";
import { selectLanguageIdentityForSurface } from "../language-identity.js";

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

  it("keeps identity assignment when the observed-symbol split is unresolved", () => {
    const discover = (count: number) => discoverLanguageIdentities({
      signatures: Array.from({ length: count }, (_, index) => signature(index)),
      hasher: createHasher(),
      now: 1_700_000_000_000
    });
    // A single signature cannot separate grammatical symbols from its subject matter, but it still gets an identity.
    const one = discover(1);
    const many = discover(13);
    expect(many.identities.length).toBeGreaterThan(0);
    const manyWords = many.identities.flatMap(identity => identity.closedClass.map(row => row.word));
    expect(manyWords.length).toBeGreaterThan(0);
    expect(manyWords.some(word => word.startsWith("content") || word.startsWith("topic"))).toBe(false);
    // Its own subject matter is not labeled a closed class, while the source profile remains assigned and addressable.
    const oneWords = one.identities.flatMap(identity => identity.closedClass.map(row => row.word));
    expect(oneWords).toEqual([]);
  });

  it("keeps a one-profile family identity and its observed symbols without calling them grammar", () => {
    const one = signature(0);
    one.topContinuation = [...one.topContinuation, ["azurite", 4] as const];
    const discovered = discoverLanguageIdentities({ signatures: [one], hasher: createHasher(), now: 1 });
    const identity = discovered.identities[0]!;
    const family = identity.families.find(row => row.family === one.family)!;

    expect(discovered.assignments.get(one.id)).toBe(identity.id);
    expect(identity.profileCount).toBe(1);
    expect(identity.closedClass).toEqual([]);
    expect(identity.evidence).toMatchObject({
      observedProfileCount: 1,
      sampleCount: 1,
      sourceFamilyCount: 1,
      independentSourceFamilyCount: 1,
      status: "source_observed",
      uncertainty: expect.arrayContaining(["language_class_split_unresolved", "cross_family_equivalence_unresolved"])
    });
    expect(identity.evidence?.observedSymbols.map(row => row.symbol)).toContain("azurite");
    expect(family.evidence?.sampleCount).toBe(1);
    expect(selectLanguageIdentityForSurface([identity], "azurite")?.identity).toBe(identity);
  });

  it("counts distinct documents even when compact signatures are identical", () => {
    const first = signature(0);
    const duplicate = { ...first, id: "mirrored-profile" };
    const discovered = discoverLanguageIdentities({ signatures: [first, duplicate], hasher: createHasher(), now: 1 });
    const identity = discovered.identities[0]!;

    expect(identity.profileCount).toBe(2);
    expect(identity.evidence?.observedProfileCount).toBe(2);
    expect(identity.evidence?.sampleCount).toBe(2);
    expect(identity.evidence?.independentSourceFamilyCount).toBe(1);
    expect(identity.evidence?.uncertainty).not.toContain("exact_source_version_duplicates_collapsed");
  });

  it("deduplicates the same exact source version when it appears more than once", () => {
    const first = { ...signature(0), sourceVersionId: "source-version-1" };
    const duplicate = { ...signature(1), id: first.id, sourceVersionId: first.sourceVersionId };
    const discovered = discoverLanguageIdentities({ signatures: [first, duplicate], hasher: createHasher(), now: 1 });
    const identity = discovered.identities[0]!;

    expect(identity.profileCount).toBe(2);
    expect(identity.evidence?.observedProfileCount).toBe(2);
    expect(identity.evidence?.sampleCount).toBe(1);
    expect(identity.evidence?.uncertainty).toContain("exact_source_version_duplicates_collapsed");
  });

  it("routes a second singleton family with the same observed language signature and marks it uncertain", () => {
    const first = signature(0);
    const second = { ...first, id: "other-source-profile", family: "other-corpus" };
    const discovered = discoverLanguageIdentities({ signatures: [first, second], hasher: createHasher(), now: 1 });
    const firstIdentity = discovered.identities.find(identity => discovered.assignments.get(first.id) === identity.id)!;
    const secondIdentity = discovered.identities.find(identity => discovered.assignments.get(second.id) === identity.id)!;

    expect(secondIdentity.id).toBe(firstIdentity.id);
    expect(firstIdentity.profileCount).toBe(2);
    expect(firstIdentity.closedClass).toEqual([]);
    expect(firstIdentity.evidence).toMatchObject({
      sourceFamilyCount: 2,
      independentSourceFamilyCount: 1,
      uncertainty: expect.arrayContaining(["cross_family_equivalence_unresolved", "identical_family_signature_sets_collapsed"])
    });
  });

  it("routes an identical measured signature set to one identity without inflating family independence", () => {
    const original = Array.from({ length: 13 }, (_, index) => signature(index));
    const mirror = original.map((profile, index) => ({ ...profile, id: `mirror-${index}`, family: "mirror" }));
    const discovered = discoverLanguageIdentities({ signatures: [...original, ...mirror], hasher: createHasher(), now: 1 });
    const originalIdentity = discovered.identities.find(identity => discovered.assignments.get("profile-000") === identity.id)!;
    const mirrorIdentity = discovered.identities.find(identity => discovered.assignments.get("mirror-0") === identity.id)!;

    expect(mirrorIdentity.id).toBe(originalIdentity.id);
    expect(originalIdentity.families.map(row => row.family)).toEqual(expect.arrayContaining(["corpus:wikipedia", "mirror"]));
    expect(originalIdentity.evidence?.sourceFamilyCount).toBe(2);
    expect(originalIdentity.evidence?.independentSourceFamilyCount).toBe(1);
    expect(originalIdentity.evidence?.uncertainty).toContain("cross_family_equivalence_unresolved");
    expect(originalIdentity.evidence?.uncertainty).toContain("identical_family_signature_sets_collapsed");
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
