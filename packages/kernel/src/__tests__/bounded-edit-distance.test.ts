import { describe, expect, it } from "vitest";
import { boundedEditDistance } from "../kernel-answer-primitives.js";

/** Unbanded full-matrix Levenshtein: the oracle the banded version must match. */
function fullEditDistance(left: string, right: string): number {
  let previous = Array.from({ length: right.length + 1 }, (_, index) => index);
  for (let i = 1; i <= left.length; i++) {
    const current = [i];
    for (let j = 1; j <= right.length; j++) {
      const cost = left[i - 1] === right[j - 1] ? 0 : 1;
      current[j] = Math.min((previous[j] ?? 0) + 1, (current[j - 1] ?? 0) + 1, (previous[j - 1] ?? 0) + cost);
    }
    previous = current;
  }
  return previous[right.length] ?? 0;
}

/** Deterministic PRNG so a failure names a reproducible seed. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

describe("boundedEditDistance (banded)", () => {
  it("matches the full-matrix oracle for every distance within the bound", () => {
    const random = mulberry32(20260818);
    const alphabet = "abcdefg";
    for (let round = 0; round < 3000; round++) {
      const leftLength = Math.floor(random() * 14);
      const left = Array.from({ length: leftLength }, () => alphabet[Math.floor(random() * alphabet.length)]).join("");
      // Bias right toward being an edit of left, so small distances are common.
      const right = random() < 0.5
        ? left.slice(0, Math.max(0, leftLength - Math.floor(random() * 3))) + (random() < 0.5 ? "x" : "")
        : Array.from({ length: Math.floor(random() * 14) }, () => alphabet[Math.floor(random() * alphabet.length)]).join("");
      for (const maxDistance of [1, 2, 3, 5]) {
        const truth = fullEditDistance(left, right);
        const banded = boundedEditDistance(left, right, maxDistance);
        const expected = truth <= maxDistance ? truth : maxDistance + 1;
        expect(banded, `left=${JSON.stringify(left)} right=${JSON.stringify(right)} max=${maxDistance}`).toBe(expected);
      }
    }
  });

  it("handles empty strings and identical strings exactly", () => {
    expect(boundedEditDistance("", "", 3)).toBe(0);
    expect(boundedEditDistance("", "ab", 3)).toBe(2);
    expect(boundedEditDistance("abc", "", 3)).toBe(3);
    expect(boundedEditDistance("engine", "engine", 3)).toBe(0);
  });

  it("reports anything past the bound as maxDistance + 1, including the length shortcut", () => {
    expect(boundedEditDistance("a", "abcdefgh", 3)).toBe(4);
    expect(boundedEditDistance("kitten", "sitting", 2)).toBe(3); // true distance 3 > 2
    expect(boundedEditDistance("kitten", "sitting", 3)).toBe(3);
  });
});
