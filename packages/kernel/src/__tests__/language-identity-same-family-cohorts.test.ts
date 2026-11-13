// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
import { expect, it } from "vitest";
import { discoverLanguageIdentities, type LanguageProfileSignature } from "../language-identity.js";
import { createHasher } from "../primitives.js";

it("joins statistically compatible topic cohorts within one family while preserving a different language in that family", () => {
  const shared = Array.from({ length: 12 }, (_, index) => `shared${index}`);
  const foreign = Array.from({ length: 12 }, (_, index) => `foreign${index}`);
  const group = (prefix: string, family: string, count: number, words: string[]): LanguageProfileSignature[] => Array.from({ length: count }, (_, index) => ({
    id: `${prefix}.${index}`, sourceVersionId: `source.${prefix}.${index}`, family, scripts: [{ script: "script:Latn", mass: 1 }], direction: "ltr",
    topContinuation: [...words.map((word, position) => [word, 1000 - position] as [string, number]), [`private${prefix}${index}`, 1]]
  }));
  const signatures = [
    ...group("base", "independent", 20, shared),
    ...group("first", "dialogue", 8, [...shared, ...Array.from({ length: 18 }, (_, index) => `first${index}`)]),
    ...group("second", "dialogue", 2, [...shared, ...Array.from({ length: 18 }, (_, index) => `second${index}`)]),
    ...group("foreign", "dialogue", 8, foreign)
  ];
  const discover = (rows: LanguageProfileSignature[]) => discoverLanguageIdentities({ signatures: rows, hasher: createHasher(), now: 1 });
  const result = discover(signatures);
  expect(result.assignments.get("second.0")).toBe(result.assignments.get("base.0"));
  expect(result.assignments.get("first.0")).toBe(result.assignments.get("base.0"));
  expect(result.assignments.get("foreign.0")).not.toBe(result.assignments.get("base.0"));
  expect(result.identities).toHaveLength(2);
  expect([...discover([...signatures].reverse()).assignments].sort()).toEqual([...result.assignments].sort());
  expect(signatures.filter(row => row.family === "dialogue").every(row => result.assignments.has(row.id))).toBe(true);
});
