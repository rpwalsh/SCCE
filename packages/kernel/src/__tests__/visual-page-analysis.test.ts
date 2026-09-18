// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
import { describe, expect, it } from "vitest";
import { analyzePage, binarize, otsuValueSplit, type GrayImage } from "../visual-page-analysis.js";
import { glyphProfile, profileDistance, shapeDistance, shapeSignature } from "../visual-shape-signature.js";
import { INK, invert, PAPER, renderTextPage, rotate, SCALE } from "./page-fixtures.js";

// The claim: a page of marks becomes lines, words and individual glyphs with no trained model and no tuned
// constant -- thresholds are Otsu splits of the page's own histograms. Proven on a rendered page with noise,
// specks, inverted polarity and skew. The font and renderer are test scaffolding in ./page-fixtures.

const shapeOf = (layout: ReturnType<typeof analyzePage>) =>
  layout.lines.map(line => line.words.map(word => word.glyphs.length));

describe("reading a page of marks into lines, words and glyphs with no model", () => {
  const LINES = ["HELLO WORLD", "THE RED DOOR"] as const;
  const EXPECTED = [[5, 5], [3, 3, 4]];

  it("segments a noisy page into exactly the lines, words and glyphs that were written", () => {
    const layout = analyzePage(renderTextPage(LINES));
    expect(shapeOf(layout)).toEqual(EXPECTED);
    // An upright page must measure as upright: the estimator reads baselines, not the text block's shape.
    expect(Math.abs(layout.skewRadians)).toBeLessThan(0.02);
    // One population of marks is not split into marks and specks.
    expect(layout.scaleSplit.accepted).toBe(false);
  });

  it("reports a truly isolated speck rather than discarding it, and keeps the marks intact", () => {
    // Placed clear of every mark's x-range, so they belong to nothing.
    const specks: [number, number][] = [[1, 2], [2, 10], [72, 3]];
    const layout = analyzePage(renderTextPage(LINES, specks));
    expect(shapeOf(layout)).toEqual(EXPECTED);
    expect(layout.speckles).toHaveLength(specks.length);
    expect(layout.scaleSplit.accepted).toBe(true);
    const glyphAreas = layout.lines.flatMap(l => l.words.flatMap(w => w.glyphs.map(g => g.area)));
    for (const speck of layout.speckles) expect(Math.min(...glyphAreas)).toBeGreaterThan(speck.area);
  });

  it("attaches a small mark above a letter to that letter, which is what Arabic dots and accents require", () => {
    // A dot directly above the H of HELLO. Arabic separates several letters by dots alone, so a small component
    // that belongs to a mark must join it rather than be cleaned away.
    const layout = analyzePage(renderTextPage(LINES, [[7, 4]]));
    // Still twenty glyphs: the dot did not become a glyph of its own, and nothing was discarded.
    expect(shapeOf(layout)).toEqual(EXPECTED);
    expect(layout.speckles).toHaveLength(0);
    const first = layout.lines[0]!.words[0]!.glyphs[0]!;
    const plain = analyzePage(renderTextPage(LINES)).lines[0]!.words[0]!.glyphs[0]!;
    // The dot became part of the letter: its box reaches up to the mark and it carries the extra ink.
    expect(first.y0).toBeLessThan(plain.y0);
    expect(first.area).toBeGreaterThan(plain.area);
  });

  it("measures ink polarity instead of assuming dark marks, so light text on a dark ground reads the same", () => {
    const normal = analyzePage(renderTextPage(LINES));
    const inverted = analyzePage(invert(renderTextPage(LINES)));
    expect(normal.mask.inkIsBright).toBe(false);
    expect(inverted.mask.inkIsBright).toBe(true);
    expect(shapeOf(inverted)).toEqual(shapeOf(normal));
  });

  it("reads a skewed capture: the skew is measured and layout is grouped in deskewed space", () => {
    const radians = 3 * (Math.PI / 180);
    const layout = analyzePage(rotate(renderTextPage(LINES), radians));
    // Recovered to within the estimator's own angular resolution (one stroke width across the page).
    expect(Math.abs(Math.abs(layout.skewRadians) - radians)).toBeLessThan(0.02);
    expect(shapeOf(layout)).toEqual(EXPECTED);
  });

  it("recovers glyphs a zoning profile identifies perfectly, on a grid it measured rather than chose", () => {
    const layout = analyzePage(renderTextPage(LINES));
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
    const image = renderTextPage(LINES);
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
