import { describe, expect, it } from "vitest";

import { localeFromMetadata } from "../localization.js";
import { symbolizeData } from "../primitives.js";
import {
  reconstructUnicodeSurface,
  segmentUnicodeSurface,
  unicodeSymbolSegments
} from "../unicode-segmentation.js";

describe("reversible Unicode segmentation", () => {
  it("keeps Han text as reversible grapheme symbols", () => {
    const text = "\u672a\u6765\u79d1\u6280";
    expect(symbolizeData(text)).toEqual(["\u672a", "\u6765", "\u79d1", "\u6280"]);
    assertReversible(text);
  });

  it("keeps Hangul syllables and source whitespace reversible", () => {
    const text = "\uc548\ub155\ud558\uc138\uc694 \uc138\uacc4";
    expect(symbolizeData(text)).toEqual(["\uc548", "\ub155", "\ud558", "\uc138", "\uc694", "\uc138", "\uacc4"]);
    expect(segmentUnicodeSurface(text).some(segment => segment.kind === "whitespace")).toBe(true);
    assertReversible(text);
  });

  it("keeps Kana text as reversible grapheme symbols", () => {
    const text = "\u30ab\u30bf\u30ab\u30ca\u3068\u3072\u3089\u304c\u306a";
    expect(symbolizeData(text)).toEqual([
      "\u30ab", "\u30bf", "\u30ab", "\u30ca", "\u3068", "\u3072", "\u3089", "\u304c", "\u306a"
    ]);
    assertReversible(text);
  });

  it("keeps Arabic base letters and combining marks in reversible graphemes", () => {
    const text = "\u0627\u064e\u0644\u0652\u0639\u064e\u0631\u064e\u0628\u0650\u064a\u064e\u0651\u0629\u064f";
    expect(symbolizeData(text)).toEqual([
      "\u0627\u064e",
      "\u0644\u0652",
      "\u0639\u064e",
      "\u0631\u064e",
      "\u0628\u0650",
      "\u064a\u064e\u0651",
      "\u0629\u064f"
    ]);
    assertReversible(text);
  });

  it("preserves Latin words while separating adjacent mixed-script symbols", () => {
    const text = "Agentic AI\uc640\u672a\u6765\u060c \u0627\u0644\u0639\u0631\u0628\u064a\u0629 v2.0";
    expect(unicodeSymbolSegments(text).map(segment => segment.normalized)).toEqual([
      "agentic",
      "ai",
      "\uc640",
      "\u672a",
      "\u6765",
      "\u060c",
      "\u0627",
      "\u0644",
      "\u0639",
      "\u0631",
      "\u0628",
      "\u064a",
      "\u0629",
      "v2",
      ".",
      "0"
    ]);
    expect(symbolizeData("_agent")).toEqual(["_agent"]);
    expect(symbolizeData("can't L\u2019annee")).toEqual(["can't", "l\u2019annee"]);
    assertReversible(text);
  });

  it("does not infer a locale from the request script", () => {
    expect(localeFromMetadata(undefined, "\u672a\u6765")).toBe("und");
    expect(localeFromMetadata(undefined, "\uc548\ub155\ud558\uc138\uc694")).toBe("und");
    expect(localeFromMetadata(undefined, "\u0627\u0644\u0639\u0631\u0628\u064a\u0629")).toBe("und");
    expect(localeFromMetadata({ locale: "ar" }, "\u672a\u6765")).toBe("ar");
  });
});

function assertReversible(text: string): void {
  const segments = segmentUnicodeSurface(text);
  expect(reconstructUnicodeSurface(segments)).toBe(text);
  let previousUtf16End = 0;
  let previousCodePointEnd = 0;
  const codePoints = [...text];
  for (const segment of segments) {
    expect(segment.utf16Start).toBe(previousUtf16End);
    expect(segment.codePointStart).toBe(previousCodePointEnd);
    expect(text.slice(segment.utf16Start, segment.utf16End)).toBe(segment.surface);
    expect(codePoints.slice(segment.codePointStart, segment.codePointEnd).join("")).toBe(segment.surface);
    previousUtf16End = segment.utf16End;
    previousCodePointEnd = segment.codePointEnd;
  }
  expect(previousUtf16End).toBe(text.length);
  expect(previousCodePointEnd).toBe(codePoints.length);
}
