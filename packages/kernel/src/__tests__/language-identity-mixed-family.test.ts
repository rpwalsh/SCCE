// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
import { expect, it } from "vitest";
import { discoverLanguageIdentities, selectLanguageIdentityForSurface, type LanguageProfileSignature } from "../language-identity.js";
import { createHasher } from "../primitives.js";

const hasher = createHasher();
const populations = [
  { words: ["the", "and", "with", "from", "which", "this"], fresh: "the and with from" },
  { words: ["els", "amb", "dels", "que", "per", "això", "de", "la"], fresh: "els amb dels això" },
  { words: ["los", "con", "del", "que", "para", "esto", "de", "la"], fresh: "los con del esto" }
];
function signatures() {
  return populations.flatMap((population, group) => Array.from({ length: 8 }, (_, index): LanguageProfileSignature => ({
    id: `profile.${group}.${index}`, sourceVersionId: `source.${group}.${index}`, family: "dialogue", scripts: [{ script: "script:Latn", mass: 1 }], direction: "ltr",
    topContinuation: [...population.words.map((word, position) => [word, 100 - position] as [string, number]), [`opaque${group}x${index}`, 1]]
  })));
}
it("separates measured EN/CA/ES signatures inside one Latin dialogue family without locale labels", () => {
  const input = signatures(), found = discoverLanguageIdentities({ signatures: input, hasher, now: 1 });
  const ids = populations.map((_, group) => found.assignments.get(`profile.${group}.0`));
  expect(new Set(ids).size).toBe(3);
  for (const [group, population] of populations.entries()) {
    const id = ids[group]!;
    expect(input.filter(profile => profile.id.startsWith(`profile.${group}.`)).every(profile => found.assignments.get(profile.id) === id)).toBe(true);
    expect(selectLanguageIdentityForSurface(found.identities, population.fresh)?.identity.id).toBe(id);
    expect(found.identities.find(identity => identity.id === id)?.families.map(row => row.family)).toEqual(["dialogue"]);
  }
  const reverse = discoverLanguageIdentities({ signatures: [...input].reverse(), hasher, now: 1 });
  expect([...reverse.assignments].sort()).toEqual([...found.assignments].sort());
});

it("keeps one shared-language population together despite unrelated per-document topics", () => {
  const common = populations[0]!.words;
  const input: LanguageProfileSignature[] = Array.from({ length: 24 }, (_, index) => ({ id: `topic.${index}`, family: "dialogue",
    scripts: [{ script: "script:Latn", mass: 1 }], direction: "ltr", topContinuation: [...common.map(word => [word, 100] as [string, number]),
      [`topic${index % 4}`, 10], [`private${index}`, 1]] }));
  const found = discoverLanguageIdentities({ signatures: input, hasher, now: 1 });
  expect(found.identities).toHaveLength(1);
  expect(new Set(found.assignments.values()).size).toBe(1);
});
