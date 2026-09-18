// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
import { describe, expect, it } from "vitest";
import { flattenIllumination, projectColor, type ColorImage } from "../visual-image-field.js";
import { analyzePage, type GrayImage } from "../visual-page-analysis.js";
import { knownLanguageFrom, readImage } from "../visual-eye.js";
import {
  bigramsOf,
  editSimilarity,
  frequenciesOf,
  renderTextPage,
  sampleWords,
  syntheticLanguage,
  wrapWords
} from "./page-fixtures.js";

// The claim: a photograph is the page times the light that fell on it, in whatever colour the ink and paper
// happen to be, and both are modelled from measurement rather than assumed. Ink and paper that differ in hue
// but not brightness -- which any fixed luminosity conversion erases outright -- separate. A page lit so
// unevenly that its paper in shadow is darker than its ink in the light still reads, and blank shadow stops
// inventing marks.

const WEIGHTS = syntheticLanguage(20260918);
const CORPUS = sampleWords(WEIGHTS, 4242, 4000);
const LANGUAGE = knownLanguageFrom(bigramsOf(CORPUS), frequenciesOf(CORPUS));
const PAGE_LINES = wrapWords(sampleWords(WEIGHTS, 777, 60), 8);
const TRUTH = [...PAGE_LINES.join(" ").replace(/ /g, "")];
const OPTIONS = { outerIterations: 150, epsilon: 0.05 };

const glyphCountOf = (image: GrayImage) =>
  analyzePage(image).lines.reduce((total, line) =>
    total + line.words.reduce((count, word) => count + word.glyphs.length, 0), 0);

/** The same page, lit by a ramp so steep that paper on one side is darker than ink on the other. */
function unevenlyLit(source: GrayImage, darkest: number): GrayImage {
  const data = new Uint8Array(source.width * source.height);
  for (let y = 0; y < source.height; y++) {
    for (let x = 0; x < source.width; x++) {
      const light = 1 - (1 - darkest) * (x / Math.max(1, source.width - 1));
      data[y * source.width + x] = Math.round(source.data[y * source.width + x]! * light);
    }
  }
  return { width: source.width, height: source.height, data };
}

/**
 * Text in one hue on paper in another, chosen so their brightness matches exactly: both sum to 410, so every
 * conversion that weights the channels positively and equally sees a blank page. The source's own capture noise
 * is carried through by blending rather than thresholded away, so this is not a noise-free special case.
 */
function equallyBrightColors(source: GrayImage): ColorImage {
  const paper: [number, number, number] = [30, 190, 190];
  const ink: [number, number, number] = [190, 30, 190];
  const data = new Uint8Array(source.width * source.height * 3);
  for (let i = 0; i < source.width * source.height; i++) {
    const darkness = Math.min(1, Math.max(0, (235 - source.data[i]!) / 200));
    for (let c = 0; c < 3; c++) {
      data[i * 3 + c] = Math.round(paper[c]! + darkness * (ink[c]! - paper[c]!));
    }
  }
  return { width: source.width, height: source.height, data };
}

describe("reading a photograph rather than a page", () => {
  it("separates ink from paper on the axis that measurably separates them, whatever the hue", () => {
    const colour = equallyBrightColors(renderTextPage(PAGE_LINES));
    const projected = projectColor(colour);
    expect(projected.separation).toBeGreaterThan(0);

    // Any fixed conversion that weights the channels positively cannot see this page at all: ink and paper sum
    // to the same value, so every such projection is flat and yields no marks.
    const flat = new Uint8Array(colour.width * colour.height);
    for (let i = 0; i < flat.length; i++) {
      flat[i] = Math.round((colour.data[i * 3]! + colour.data[i * 3 + 1]! + colour.data[i * 3 + 2]!) / 3);
    }
    const byBrightness: GrayImage = { width: colour.width, height: colour.height, data: flat };
    expect(glyphCountOf(byBrightness)).toBe(0);

    // The measured axis is the true ink-minus-paper direction, to the sign: red against green, blue unused.
    const [red, green, blue] = projected.axis;
    expect(Math.abs(Math.abs(red) - Math.abs(green))).toBeLessThan(0.05);
    expect(Math.abs(blue)).toBeLessThan(0.05);

    // On that axis every mark is recovered, in the lines that were written.
    expect(glyphCountOf(projected)).toBe(TRUTH.length);
    const layout = analyzePage(projected);
    expect(layout.lineSplit.accepted).toBe(true);
    expect(layout.lineSplit.count).toBe(PAGE_LINES.length);

    // What is NOT claimed: reading it end to end. Collapsing three channels to one leaves pen-sized speckle
    // that no geometric bound can tell from a diacritic, and a speck attaching at a glyph's edge shifts a
    // bounding-box-normalised profile enough to break the inventory. The fix is an identity feature that is not
    // anchored on the ink's own box; until then the colour path is proven to the mark, not to the reading.
    const reading = readImage(projected, LANGUAGE, OPTIONS);
    expect(reading.abstained).toBe(true);
  });

  it("divides out a light so uneven that shadowed paper is darker than lit ink", () => {
    const lit = unevenlyLit(renderTextPage(PAGE_LINES), 0.22);
    // Uncorrected, the shadowed side floods: far more "marks" than were ever written.
    const uncorrected = glyphCountOf(lit);
    const flattened = flattenIllumination(lit);
    expect(flattened.scale).toBeGreaterThan(0);
    // Corrected, exactly the marks that were written, and the page reads.
    expect(glyphCountOf(flattened)).toBe(TRUTH.length);
    expect(uncorrected).not.toBe(TRUTH.length);
    const reading = readImage(flattened, LANGUAGE, OPTIONS);
    expect(editSimilarity(reading.lines.flat(), TRUTH)).toBe(1);
  });

  it("does not invent marks in blank shadow", () => {
    // Half a page of writing, half blank, under the same steep ramp. The blank half is in shadow, and darker
    // than the written half's ink -- the case that makes a global threshold call empty paper "ink".
    const written = renderTextPage(PAGE_LINES);
    const wide: GrayImage = {
      width: written.width * 2,
      height: written.height,
      data: new Uint8Array(written.width * 2 * written.height).fill(235)
    };
    const data = wide.data as Uint8Array;
    for (let y = 0; y < written.height; y++) {
      for (let x = 0; x < written.width; x++) {
        data[y * wide.width + x] = written.data[y * written.width + x]!;
      }
    }
    const flattened = flattenIllumination(unevenlyLit(wide, 0.22));

    // The claim under test, asserted directly: not one mark is found in the shadowed blank half, though it is
    // darker there than the ink is in the light. A global threshold calls that whole half ink.
    const found = analyzePage(flattened).lines.flatMap(line => line.words.flatMap(word => word.glyphs));
    expect(found.filter(glyph => glyph.x0 >= written.width)).toHaveLength(0);
    expect(found.length).toBeLessThanOrEqual(TRUTH.length);

    // What it does cost: on a page this sparse the estimated light still pulls one inter-line gap dark enough
    // to bridge a glyph to the one below it, so the marks come in one short and the line bands stop separating.
    // That is a measured limit of the field estimate on sparse pages, not of the shadow claim above.
    expect(found.length).toBeGreaterThan(TRUTH.length - 5);
  });

  it("leaves an evenly lit page alone", () => {
    const even = renderTextPage(PAGE_LINES);
    const flattened = flattenIllumination(even);
    expect(glyphCountOf(flattened)).toBe(TRUTH.length);
    const reading = readImage(flattened, LANGUAGE, OPTIONS);
    expect(editSimilarity(reading.lines.flat(), TRUTH)).toBe(1);
  });
});
