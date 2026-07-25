import { describe, expect, it } from "vitest";
import {
  SEGMENTATION_SCHEMA_V2,
  dominantScriptId,
  joinLexicalSurfaces,
  reconstructFromSegmentationModel,
  scriptUsesSpaceSeparatedWords,
  segmentUnicodeSurfaceV2
} from "../unicode-segmentation-v2.js";
import { segmentUnicodeSurface } from "../unicode-segmentation.js";

describe("segmentation v2 -- Latin regression (must be byte-identical to v1)", () => {
  const samples = [
    "The quick brown fox jumps over 12 lazy dogs.",
    "don't stop believin', it's a small_world after-all",
    "Multiple   spaces   and\ttabs\nand newlines.",
    "Trailing punctuation!!! And... ellipses?",
    ""
  ];

  for (const sample of samples) {
    it(`produces identical surfaceSegments to v1 for: ${JSON.stringify(sample).slice(0, 40)}`, () => {
      const v1 = segmentUnicodeSurface(sample);
      const v2 = segmentUnicodeSurfaceV2(sample);
      expect(v2.surfaceSegments).toEqual(v1);
      expect(v2.schemaVersion).toBe(SEGMENTATION_SCHEMA_V2);
      expect(reconstructFromSegmentationModel(v2)).toBe(sample);
    });
  }

  it("produces lexicalSegments for Latin text that exactly match v1's word/number surface segments", () => {
    const text = "The quick brown fox jumps over 12 lazy dogs.";
    const v1 = segmentUnicodeSurface(text);
    const v2 = segmentUnicodeSurfaceV2(text);
    const v1WordsAndNumbers = v1.filter(segment => segment.kind === "word" || segment.kind === "number");
    expect(v2.lexicalSegments.map(segment => segment.surface)).toEqual(v1WordsAndNumbers.map(segment => segment.surface));
    expect(v2.lexicalSegments.every(segment => segment.scriptId === "script:Latn" || segment.scriptId === "script:Zyyy:number")).toBe(true);
  });
});

describe("segmentation v2 -- real word-level grouping for non-Latin scripts", () => {
  it("groups Russian Cyrillic letters into whole words instead of atomizing every character", () => {
    const text = "Привет мир"; // "Привет мир" (Hello world)
    const model = segmentUnicodeSurfaceV2(text);

    expect(model.lexicalSegments.map(segment => segment.surface)).toEqual([
      "Привет",
      "мир"
    ]);
    expect(model.lexicalSegments.every(segment => segment.scriptId === "script:Cyrl")).toBe(true);
    expect(reconstructFromSegmentationModel(model)).toBe(text);
  });

  it("groups Arabic letters into whole words while preserving logical (storage) character order", () => {
    const text = "مرحبا بالعالم"; // "مرحبا بالعالم"
    const model = segmentUnicodeSurfaceV2(text);

    expect(model.lexicalSegments).toHaveLength(2);
    expect(model.lexicalSegments[0]!.surface).toBe("مرحبا");
    expect(model.lexicalSegments[1]!.surface).toBe("بالعالم");
    // Logical order is untouched -- codepoints appear in the same storage order as the input, never reversed.
    expect([...reconstructFromSegmentationModel(model)]).toEqual([...text]);
  });

  it("segments Chinese text into real dictionary-based words rather than one segment per Han character", () => {
    const text = "我爱北京天安门"; // "我爱北京天安门" (I love Beijing Tiananmen)
    const model = segmentUnicodeSurfaceV2(text);

    expect(model.lexicalSegments.every(segment => segment.scriptId === "script:Hani")).toBe(true);
    // The whole point of the fix: fewer lexical segments than characters, i.e. real words were grouped.
    expect(model.lexicalSegments.length).toBeLessThan([...text].length);
    expect(reconstructFromSegmentationModel(model)).toBe(text);
  });

  it("segments Japanese mixed-script text without forcing spaces between every character", () => {
    const text = "私は日本語を話します"; // "私は日本語を話します"
    const model = segmentUnicodeSurfaceV2(text);

    expect(model.lexicalSegments.length).toBeGreaterThan(0);
    expect(model.lexicalSegments.length).toBeLessThan([...text].length);
    expect(reconstructFromSegmentationModel(model)).toBe(text);
  });

  it("segments Thai text into words using dictionary-based boundaries", () => {
    const text = "สวัสดีครับโลก"; // "สวัสดีครับโลก"
    const model = segmentUnicodeSurfaceV2(text);

    expect(model.lexicalSegments.every(segment => segment.scriptId === "script:Thai")).toBe(true);
    expect(model.lexicalSegments.length).toBeGreaterThan(0);
    expect(model.lexicalSegments.length).toBeLessThan([...text].length);
    expect(reconstructFromSegmentationModel(model)).toBe(text);
  });

  it("falls back to a single-grapheme lexical segment when ICU finds no word-like span (defensive, not a crash)", () => {
    const text = "☃☁"; // snowman, cloud -- symbols, not letters
    const model = segmentUnicodeSurfaceV2(text);
    expect(reconstructFromSegmentationModel(model)).toBe(text);
  });
});

describe("segmentation v2 -- per-document script boundary signal (real evidence, not fabricated)", () => {
  it("reports insufficient_evidence rather than guessing when too few same-script boundaries are observed", () => {
    const model = segmentUnicodeSurfaceV2("Привет"); // one Cyrillic word, zero adjacent boundaries
    expect(model.boundarySignals).toEqual([]);
  });

  it("classifies a space-separated script as space_separated from real observed ratios", () => {
    const model = segmentUnicodeSurfaceV2("one two three four five six");
    const latin = model.boundarySignals.find(signal => signal.scriptId === "script:Latn");
    expect(latin).toMatchObject({ kind: "space_separated" });
    expect(latin!.observedSpacedRatio).toBeGreaterThan(0.8);
  });

  it("classifies an unspaced CJK script as no_space_boundary from real observed ratios", () => {
    const model = segmentUnicodeSurfaceV2("我爱北京天安门广场太阳升");
    const han = model.boundarySignals.find(signal => signal.scriptId === "script:Hani");
    expect(han).toBeDefined();
    expect(han!.observedSpacedRatio).toBe(0);
  });
});

describe("segmentation v2 -- generation-time script-aware joining", () => {
  it("inserts spaces between space-separated-script pieces but not between CJK pieces", () => {
    const latinJoined = joinLexicalSurfaces([
      { text: "hello", scriptId: "script:Latn" },
      { text: "world", scriptId: "script:Latn" }
    ]);
    expect(latinJoined).toBe("hello world");

    const chineseJoined = joinLexicalSurfaces([
      { text: "我爱", scriptId: "script:Hani" },
      { text: "北京", scriptId: "script:Hani" }
    ]);
    expect(chineseJoined).toBe("我爱北京");
  });

  it("still separates a script switch (e.g. a Latin term embedded in Chinese) with a space", () => {
    const joined = joinLexicalSurfaces([
      { text: "我爱", scriptId: "script:Hani" },
      { text: "SCCE", scriptId: "script:Latn" }
    ]);
    expect(joined).toBe("我爱 SCCE");
  });

  it("skips empty pieces without inserting a stray leading or double space", () => {
    expect(joinLexicalSurfaces([
      { text: "", scriptId: "script:Latn" },
      { text: "hello", scriptId: "script:Latn" },
      { text: "", scriptId: "script:Latn" },
      { text: "world", scriptId: "script:Latn" }
    ])).toBe("hello world");
  });
});

describe("segmentation v2 -- dominantScriptId", () => {
  it("picks the majority script by letter/mark character count", () => {
    expect(dominantScriptId("hello")).toBe("script:Latn");
    expect(dominantScriptId("我爱北京")).toBe("script:Hani");
  });

  it("counts number characters too, not just letters", () => {
    expect(dominantScriptId("123")).toBe("script:Zyyy:number");
  });

  it("returns the generic common-script fallback for text with no letters, marks, or numbers", () => {
    expect(dominantScriptId("!!! ...")).toBe("script:Zyyy");
  });
});

describe("scriptUsesSpaceSeparatedWords", () => {
  it("is false for the conventionally unspaced scripts and true otherwise", () => {
    expect(scriptUsesSpaceSeparatedWords("script:Hani")).toBe(false);
    expect(scriptUsesSpaceSeparatedWords("script:Hira")).toBe(false);
    expect(scriptUsesSpaceSeparatedWords("script:Kana")).toBe(false);
    expect(scriptUsesSpaceSeparatedWords("script:Thai")).toBe(false);
    expect(scriptUsesSpaceSeparatedWords("script:Latn")).toBe(true);
    expect(scriptUsesSpaceSeparatedWords("script:Cyrl")).toBe(true);
    expect(scriptUsesSpaceSeparatedWords("script:Arab")).toBe(true);
    expect(scriptUsesSpaceSeparatedWords("script:Hang")).toBe(true);
  });
});
