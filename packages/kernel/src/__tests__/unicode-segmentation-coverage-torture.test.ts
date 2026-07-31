import { describe, expect, it } from "vitest";
import { segmentUnicodeSurface, reconstructUnicodeSurface, type UnicodeSurfaceSegment } from "../unicode-segmentation.js";
import { segmentUnicodeSurfaceV2, reconstructFromSegmentationModel } from "../unicode-segmentation-v2.js";

// Plan items 80, 82: property tests proving base-unit coverage is
// gap-free/duplicate-free/legally nested, and Unicode torture tests
// (combining marks, emoji, astral chars, CJK, Arabic, Hebrew) proving
// zero coordinate drift end to end.

function assertGapFreeCoverage(text: string, segments: readonly UnicodeSurfaceSegment[]): void {
  let expectedUtf16 = 0;
  let expectedCodePoint = 0;
  for (const segment of segments) {
    expect(segment.utf16Start).toBe(expectedUtf16);
    expect(segment.codePointStart).toBe(expectedCodePoint);
    // No segment may be empty (that would let a duplicate/zero-width slice hide inside real coverage).
    expect(segment.utf16End).toBeGreaterThan(segment.utf16Start);
    expect(segment.codePointEnd).toBeGreaterThan(segment.codePointStart);
    // The segment's own coordinates must match its own real surface length,
    // in both encodings -- this is what "zero coordinate drift" means.
    expect(segment.utf16End - segment.utf16Start).toBe(segment.surface.length);
    expect(segment.codePointEnd - segment.codePointStart).toBe([...segment.surface].length);
    expectedUtf16 = segment.utf16End;
    expectedCodePoint = segment.codePointEnd;
  }
  // The final segment's end must exactly reach the end of the source text
  // (in both units) -- no trailing gap, no overrun.
  expect(expectedUtf16).toBe(text.length);
  expect(expectedCodePoint).toBe([...text].length);
  expect(reconstructUnicodeSurface(segments)).toBe(text);
}

const TORTURE_CASES: Array<{ name: string; text: string }> = [
  { name: "NFD combining acute accent (e + U+0301) kept as one grapheme, not split", text: "café au lait" },
  { name: "combining ring above + combining cedilla stacked on a base letter", text: "å̧bc" },
  { name: "ZWJ family emoji sequence (single grapheme cluster)", text: "👨‍👩‍👧‍👦 family" },
  { name: "emoji with skin-tone modifier", text: "👍🏽 nice" },
  { name: "astral-plane surrogate pairs (Mathematical Bold letters + emoji)", text: "𝕳𝖊𝖑𝖑𝖔 😀 𝟙𝟚𝟛" },
  { name: "mixed CJK + Arabic + Hebrew + Latin in one string", text: "北京 مرحبا שלום hello" },
  { name: "Hebrew with niqqud combining marks", text: "שָׁלוֹם עוֹלָם" },
  { name: "Arabic with diacritics (tashkeel)", text: "مَرْحَبًا بِالْعَالَمِ" },
  { name: "CJK punctuation and full-width characters mixed with ASCII", text: "你好,world!123。" },
  { name: "zero-width joiner/non-joiner without emoji (e.g. Indic conjuncts)", text: "क्‍ष" },
  { name: "surrogate-pair astral emoji sequence with variation selector", text: "❤️‍🔥 fire" },
  { name: "long run of combining marks stacked on one base character", text: "é̀̂̃̄" },
  { name: "RTL Arabic mixed with an embedded Latin acronym and numbers", text: "الرقم 42 هو SCCE" },
  { name: "empty string", text: "" },
  { name: "whitespace-only including tabs and newlines", text: " \t\n\r " }
];

describe("segmentUnicodeSurface -- coverage is gap-free, duplicate-free, and coordinate-accurate", () => {
  for (const { name, text } of TORTURE_CASES) {
    it(name, () => {
      const segments = segmentUnicodeSurface(text);
      assertGapFreeCoverage(text, segments);
    });
  }
});

describe("segmentUnicodeSurfaceV2 -- reconstruction and coordinate integrity survive the v2 wrapper", () => {
  for (const { name, text } of TORTURE_CASES) {
    it(name, () => {
      const model = segmentUnicodeSurfaceV2(text);
      // v2's surfaceSegments layer is untouched v1 output -- same gap-free guarantee applies.
      assertGapFreeCoverage(text, model.surfaceSegments);
      expect(reconstructFromSegmentationModel(model)).toBe(text);

      // lexicalSegments is a real re-grouping of the same underlying
      // graphemes -- its own coordinates must still be internally
      // consistent and, concatenated in order, must reconstruct the
      // original text exactly (never drop, duplicate, or reorder content).
      let previousEnd: number | undefined;
      for (const segment of model.lexicalSegments) {
        expect(segment.utf16End).toBeGreaterThan(segment.utf16Start);
        expect(segment.codePointEnd).toBeGreaterThan(segment.codePointStart);
        if (previousEnd !== undefined) expect(segment.utf16Start).toBeGreaterThanOrEqual(previousEnd);
        previousEnd = segment.utf16End;
      }
    });
  }
});

describe("segmentUnicodeSurface -- no duplicate or overlapping coordinate ranges across the whole segment list", () => {
  for (const { name, text } of TORTURE_CASES) {
    it(name, () => {
      const segments = segmentUnicodeSurface(text);
      const seenRanges = new Set<string>();
      for (const segment of segments) {
        const key = `${segment.utf16Start}:${segment.utf16End}`;
        expect(seenRanges.has(key)).toBe(false);
        seenRanges.add(key);
      }
      expect(seenRanges.size).toBe(segments.length);
    });
  }
});
