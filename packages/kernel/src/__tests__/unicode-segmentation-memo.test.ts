// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
import { describe, expect, it } from "vitest";
import { reconstructUnicodeSurface, segmentUnicodeSurface, unicodeLexicalSegments } from "../unicode-segmentation.js";

// Measured on wiki ingest: 19,742,757 characters segmented, 1,047,231 distinct. Segmentation is pure, so the
// repeat is wasted work -- but a memo must not change a single segmentation or let callers corrupt each other.

const samples = [
  "Tirana is the capital and largest city of Albania.",
  "Ada Lovelace wrote the first algorithm intended for a machine.",
  "417-431 is two numbers; 3.14 is one.",
  "日本語のテキストは空白で区切られない。",
  "  leading and trailing whitespace\t\n",
  "Ελληνικά and Ελληνικά again",
  ""
];

describe("memoized segmentation is the same segmentation", () => {
  it("returns identical segments on a repeat call", () => {
    for (const text of samples) {
      const first = segmentUnicodeSurface(text);
      const second = segmentUnicodeSurface(text);
      expect(second).toEqual(first);
      expect(reconstructUnicodeSurface(second)).toBe(text);
    }
  });

  it("gives each caller its own array, so one caller's filtering cannot shorten another's", () => {
    const text = samples[0]!;
    const first = segmentUnicodeSurface(text);
    const second = segmentUnicodeSurface(text);
    expect(second).not.toBe(first);
    const length = second.length;
    first.length = 0;
    expect(segmentUnicodeSurface(text)).toHaveLength(length);
  });

  it("freezes shared segments, so a mutation fails loudly instead of corrupting another caller", () => {
    const text = samples[1]!;
    segmentUnicodeSurface(text);
    const segments = segmentUnicodeSurface(text);
    expect(Object.isFrozen(segments[0])).toBe(true);
    expect(() => { (segments[0] as { surface: string }).surface = "clobbered"; }).toThrow(TypeError);
    expect(reconstructUnicodeSurface(segmentUnicodeSurface(text))).toBe(text);
  });

  it("still reconstructs exactly after the budget is exceeded and the memo is cleared", () => {
    const long = "a b c ".repeat(200_000);
    expect(reconstructUnicodeSurface(segmentUnicodeSurface(long))).toBe(long);
    for (const text of samples) expect(reconstructUnicodeSurface(segmentUnicodeSurface(text))).toBe(text);
  });

  it("keeps the derived views consistent with the memoized segmentation", () => {
    const text = samples[2]!;
    const before = unicodeLexicalSegments(text);
    segmentUnicodeSurface(text);
    expect(unicodeLexicalSegments(text)).toEqual(before);
    expect(before.every(segment => segment.kind === "word" || segment.kind === "grapheme" || segment.kind === "number")).toBe(true);
  });
});
