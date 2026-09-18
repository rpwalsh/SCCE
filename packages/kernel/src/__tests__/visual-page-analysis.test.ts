// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
import { describe, expect, it } from "vitest";
import { analyzePage, binarize, otsuValueSplit, type GrayImage } from "../visual-page-analysis.js";
import { glyphProfile, profileDistance, shapeDistance, shapeSignature } from "../visual-shape-signature.js";

// The claim: a page of marks becomes lines, words and individual glyphs with no trained model and no tuned
// constant -- thresholds are Otsu splits of the page's own histograms. Proven on a rendered page with noise,
// specks, inverted polarity and skew. The font here is test scaffolding: production code never sees it.

const FONT: Record<string, readonly string[]> = {
  H: ["#...#", "#...#", "#...#", "#####", "#...#", "#...#", "#...#"],
  E: ["#####", "#....", "#....", "####.", "#....", "#....", "#####"],
  L: ["#....", "#....", "#....", "#....", "#....", "#....", "#####"],
  O: [".###.", "#...#", "#...#", "#...#", "#...#", "#...#", ".###."],
  T: ["#####", "..#..", "..#..", "..#..", "..#..", "..#..", "..#.."],
  W: ["#...#", "#...#", "#...#", "#.#.#", "#.#.#", "##.##", "#...#"],
  R: ["####.", "#...#", "#...#", "####.", "#.#..", "#..#.", "#...#"],
  D: ["####.", "#...#", "#...#", "#...#", "#...#", "#...#", "####."]
};

const SCALE = 3;
const GLYPH_W = 5;
const GLYPH_H = 7;
const LETTER_GAP = 1;
const WORD_GAP = 4;
const LINE_GAP = 6;
const MARGIN = 6;
const PAPER = 235;
const INK = 35;

function noise(seed: number): () => number {
  let s = seed;
  return () => {
    s = (s * 1103515245 + 12345) & 0x7fffffff;
    return ((s % 17) - 8);
  };
}

/** Render lines of words as a grayscale page, plus isolated single-pixel specks in the margin. */
function renderPage(lines: readonly string[], specks: readonly [number, number][] = []): GrayImage {
  const cols = Math.max(...lines.map(l => {
    const words = l.split(" ");
    const letters = words.reduce((a, w) => a + w.length, 0);
    return letters * GLYPH_W + (letters - words.length) * LETTER_GAP + (words.length - 1) * WORD_GAP;
  }));
  const width = (cols + 2 * MARGIN) * SCALE;
  const height = (lines.length * GLYPH_H + (lines.length - 1) * LINE_GAP + 2 * MARGIN) * SCALE;
  const data = new Uint8Array(width * height);
  const jitter = noise(99);
  for (let i = 0; i < data.length; i++) data[i] = PAPER + jitter();

  const plot = (fx: number, fy: number) => {
    for (let dy = 0; dy < SCALE; dy++) {
      for (let dx = 0; dx < SCALE; dx++) {
        const x = fx * SCALE + dx;
        const y = fy * SCALE + dy;
        if (x >= 0 && y >= 0 && x < width && y < height) data[y * width + x] = INK + jitter();
      }
    }
  };

  lines.forEach((line, li) => {
    const top = MARGIN + li * (GLYPH_H + LINE_GAP);
    let cursor = MARGIN;
    line.split(" ").forEach((word, wi) => {
      if (wi > 0) cursor += WORD_GAP;
      [...word].forEach((ch, ci) => {
        if (ci > 0) cursor += LETTER_GAP;
        const glyph = FONT[ch]!;
        glyph.forEach((row, ry) => [...row].forEach((cell, rx) => {
          if (cell === "#") plot(cursor + rx, top + ry);
        }));
        cursor += GLYPH_W;
      });
    });
  });

  for (const [sx, sy] of specks) plot(sx, sy);
  return { width, height, data };
}

function invert(image: GrayImage): GrayImage {
  const data = new Uint8Array(image.width * image.height);
  for (let i = 0; i < data.length; i++) data[i] = 255 - image.data[i]!;
  return { width: image.width, height: image.height, data };
}

/** Rotate about the centre with nearest-neighbour sampling: a genuinely skewed capture, not a relabelled one. */
function rotate(image: GrayImage, radians: number): GrayImage {
  const { width, height } = image;
  const data = new Uint8Array(width * height).fill(PAPER);
  const cx = width / 2;
  const cy = height / 2;
  const cos = Math.cos(-radians);
  const sin = Math.sin(-radians);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const dx = x - cx;
      const dy = y - cy;
      const sxf = Math.round(cx + dx * cos - dy * sin);
      const syf = Math.round(cy + dx * sin + dy * cos);
      if (sxf < 0 || syf < 0 || sxf >= width || syf >= height) continue;
      data[y * width + x] = image.data[syf * width + sxf]!;
    }
  }
  return { width, height, data };
}

const shapeOf = (layout: ReturnType<typeof analyzePage>) =>
  layout.lines.map(line => line.words.map(word => word.glyphs.length));

describe("reading a page of marks into lines, words and glyphs with no model", () => {
  const LINES = ["HELLO WORLD", "THE RED DOOR"] as const;
  const EXPECTED = [[5, 5], [3, 3, 4]];

  it("segments a noisy page into exactly the lines, words and glyphs that were written", () => {
    const layout = analyzePage(renderPage(LINES));
    expect(shapeOf(layout)).toEqual(EXPECTED);
    // An upright page must measure as upright: the estimator reads baselines, not the text block's shape.
    expect(Math.abs(layout.skewRadians)).toBeLessThan(0.02);
    // One population of marks is not split into marks and specks.
    expect(layout.scaleSplit.accepted).toBe(false);
  });

  it("separates specks from marks by their measured area, and reports rather than discards them", () => {
    const specks: [number, number][] = [[2, 2], [3, 30], [60, 3]];
    const layout = analyzePage(renderPage(LINES, specks));
    // The marks still segment correctly...
    expect(shapeOf(layout)).toEqual(EXPECTED);
    // ...and every speck is accounted for in the open, not silently dropped.
    expect(layout.speckles).toHaveLength(specks.length);
    expect(layout.scaleSplit.accepted).toBe(true);
    const glyphAreas = layout.lines.flatMap(l => l.words.flatMap(w => w.glyphs.map(g => g.area)));
    for (const speck of layout.speckles) expect(Math.min(...glyphAreas)).toBeGreaterThan(speck.area);
  });

  it("measures ink polarity instead of assuming dark marks, so light text on a dark ground reads the same", () => {
    const normal = analyzePage(renderPage(LINES));
    const inverted = analyzePage(invert(renderPage(LINES)));
    expect(normal.mask.inkIsBright).toBe(false);
    expect(inverted.mask.inkIsBright).toBe(true);
    expect(shapeOf(inverted)).toEqual(shapeOf(normal));
  });

  it("reads a skewed capture: the skew is measured and layout is grouped in deskewed space", () => {
    const radians = 3 * (Math.PI / 180);
    const layout = analyzePage(rotate(renderPage(LINES), radians));
    // Recovered to within the estimator's own angular resolution (one stroke width across the page).
    expect(Math.abs(Math.abs(layout.skewRadians) - radians)).toBeLessThan(0.02);
    expect(shapeOf(layout)).toEqual(EXPECTED);
  });

  it("recovers glyphs a zoning profile identifies perfectly, on a grid it measured rather than chose", () => {
    const layout = analyzePage(renderPage(LINES));
    const glyphs = layout.lines.flatMap(l => l.words.flatMap(w => w.glyphs));
    expect(glyphs).toHaveLength(20);
    // Measured glyph extent over measured stroke width recovers the font's own 5x7 design grid, unprompted.
    expect(layout.glyphGrid).toEqual({ cols: 5, rows: 7 });

    const letters = [..."HELLOWORLD", ..."THEREDDOOR"];
    const pairsBy = (distance: (i: number, j: number) => number) => {
      const same: number[] = [];
      const different: number[] = [];
      for (let i = 0; i < letters.length; i++) {
        for (let j = i + 1; j < letters.length; j++) {
          (letters[i] === letters[j] ? same : different).push(distance(i, j));
        }
      }
      const worstSame = Math.max(...same);
      return { worstSame, overlap: different.filter(d => d <= worstSame).length, pairs: different.length };
    };

    const profiles = glyphs.map(g => glyphProfile(g.raster, layout.glyphGrid.cols, layout.glyphGrid.rows));
    const byProfile = pairsBy((i, j) => profileDistance(profiles[i]!, profiles[j]!));
    // The classifier property on glyphs cut from a rendered page: no two different letters are as close as the
    // two furthest-apart prints of one letter. A nearest-profile match therefore never picks the wrong letter.
    expect(byProfile.overlap).toBe(0);

    // Pinning why the identity feature is the profile and not the Hu invariants: Hu is the right answer for a
    // mark at unknown orientation, but rotation invariance discards what separates letters, so it genuinely
    // confuses them here. If anyone swaps the identity feature back to Hu, this is the measurement that says no.
    const signatures = glyphs.map(g => shapeSignature(g.raster));
    const byHu = pairsBy((i, j) => shapeDistance(signatures[i]!, signatures[j]!));
    expect(byHu.overlap).toBeGreaterThan(0);
    expect(byProfile.overlap).toBeLessThan(byHu.overlap);
  });

  it("binarizes from the page's own histogram, recovering the written ink fraction", () => {
    const image = renderPage(LINES);
    const mask = binarize(image);
    const inkPixels = mask.ink.reduce((a, b) => a + b, 0);
    let trueInk = 0;
    for (let i = 0; i < image.data.length; i++) if (image.data[i]! < (PAPER + INK) / 2) trueInk += 1;
    // Within a few percent of the ink actually written -- no leakage of noisy paper into the mark class.
    expect(Math.abs(inkPixels - trueInk) / trueInk).toBeLessThan(0.05);
    expect(mask.strokeWidth).toBe(SCALE);
  });

  it("splits values by Otsu with no binning and reports how two-class the data really is", () => {
    const bimodal = otsuValueSplit([1, 1, 2, 2, 50, 51, 52]);
    expect(bimodal.cut).toBeGreaterThan(2);
    expect(bimodal.cut).toBeLessThan(50);
    const flat = otsuValueSplit([5, 5, 5, 5]);
    expect(flat.separability).toBe(0);
    // Otsu always finds a cut; the separability is what tells you whether to believe it.
    expect(bimodal.separability).toBeGreaterThan(flat.separability);
  });
});
