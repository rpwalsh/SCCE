// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
import { describe, expect, it } from "vitest";
import { transposeImage, type GrayImage } from "../visual-page-analysis.js";
import { knownLanguageFrom, readImage } from "../visual-eye.js";
import {
  JOINED_FONT,
  BLOCK_FONT,
  bigramsOf,
  editSimilarity,
  frequenciesOf,
  MIRROR_FONT,
  noise,
  renderTextPage,
  renderTextPageWith,
  sampleWords,
  syntheticLanguage,
  wrapWords
} from "./page-fixtures.js";

// The claim: one entry point takes a picture of writing and returns text, deciding for itself which axis the
// writing runs along, whether a cell holds several strokes, which direction the line runs and whether a mirrored
// mark is the same sign -- with no font, no key, no labels and no model. The same call reads a page of an
// alphabet, the same page written in columns, and a square-cell script whose characters are built from
// disconnected strokes, and it refuses a page that carries no writing at all.

const WEIGHTS = syntheticLanguage(20260918);
const CORPUS = sampleWords(WEIGHTS, 4242, 4000);
const LANGUAGE = knownLanguageFrom(bigramsOf(CORPUS), frequenciesOf(CORPUS));
const PAGE_LINES = wrapWords(sampleWords(WEIGHTS, 777, 60), 8);
const TRUTH = [...PAGE_LINES.join(" ").replace(/ /g, "")];
/** The same passage set solid, as a script with no word dividers writes it. */
const SOLID_LINES = PAGE_LINES.map(line => line.replace(/ /g, ""));
const OPTIONS = { outerIterations: 150, epsilon: 0.05 };

function blankPaper(): GrayImage {
  const width = 240;
  const height = 160;
  const jitter = noise(5);
  const data = new Uint8Array(width * height);
  for (let i = 0; i < data.length; i++) data[i] = 200 + jitter();
  return { width, height, data };
}

describe("SCCE's eye: a picture of writing becomes text", () => {
  it("reads a page of an alphabet exactly, choosing rows and one mark per grapheme", () => {
    const reading = readImage(renderTextPage(PAGE_LINES), LANGUAGE, OPTIONS);
    expect(reading.abstained).toBe(false);
    expect(reading.orientation).toBe("rows");
    expect(reading.grouping).toBe("marks");
    expect(reading.signCount).toBe(new Set(TRUTH).size);
    expect(editSimilarity(reading.lines.flat(), TRUTH)).toBe(1);
  });

  it("reads the same passage written in columns, finding the axis without being told", () => {
    // A genuinely column-written capture: the eye has to discover that the writing runs down the page.
    const reading = readImage(transposeImage(renderTextPage(PAGE_LINES)), LANGUAGE, OPTIONS);
    expect(reading.orientation).toBe("columns");
    expect(reading.abstained).toBe(false);
    expect(editSimilarity(reading.lines.flat(), TRUTH)).toBe(1);
  });

  it("finds the axis from the page's geometry, before any language is consulted", () => {
    const reading = readImage(renderTextPage(PAGE_LINES), LANGUAGE, OPTIONS);
    const rows = reading.layoutEvidence.find(e => e.orientation === "rows" && e.grouping === "marks")!;
    const columns = reading.layoutEvidence.find(e => e.orientation === "columns" && e.grouping === "marks")!;
    // On the axis the writing runs along, the marks fall into the bands that were written...
    expect(rows.linesFound).toBe(true);
    expect(rows.lineCount).toBe(PAGE_LINES.length);
    // ...and across it they do not separate at all, which is the evidence, and needs no language to see.
    expect(columns.linesFound).toBe(false);
    expect(rows.lineMargin).toBeGreaterThan(columns.lineMargin);
  });

  it("reads a square-cell script by finding the lattice its strokes sit on", () => {
    const reading = readImage(renderTextPageWith(BLOCK_FONT, SOLID_LINES), LANGUAGE, OPTIONS);
    const solidTruth = [...SOLID_LINES.join("")];
    // Every character here is several disconnected strokes, so one mark per grapheme over-segments it...
    const marks = reading.layoutEvidence.find(e => e.grouping === "marks" && e.orientation === "rows")!;
    expect(marks.glyphCount).toBeGreaterThan(solidTruth.length * 2);
    // ...and the eye takes the cell grouping instead, because a cell measurably holds more than one mark.
    expect(reading.grouping).toBe("cells");
    expect(reading.glyphCount).toBe(solidTruth.length);
    expect(reading.signCount).toBe(new Set(solidTruth).size);
    expect(reading.abstained).toBe(false);
    expect(editSimilarity(reading.lines.flat(), solidTruth)).toBe(1);
  });

  it("recovers a right-to-left page with no word dividers", () => {
    const laidOut = SOLID_LINES.map(line => [...line].reverse().join(""));
    const reading = readImage(renderTextPage(laidOut), LANGUAGE, OPTIONS);
    expect(reading.reversed).toBe(true);
    expect(reading.directionMargin).toBeGreaterThan(0);
    // A thin stroke clipped by the local threshold can split one mark in two, which costs an insertion and
    // nothing else -- so the reading is graded by edit distance rather than by position.
    expect(editSimilarity(reading.lines.flat(), TRUTH)).toBeGreaterThan(0.95);
  });

  it("reads a page whose every mark is mirrored, since shape identity is internal to the page", () => {
    const reading = readImage(renderTextPageWith(MIRROR_FONT, PAGE_LINES), LANGUAGE, OPTIONS);
    expect(reading.abstained).toBe(false);
    expect(reading.signCount).toBe(new Set(TRUTH).size);
    expect(editSimilarity(reading.lines.flat(), TRUTH)).toBe(1);
  });

  it("refuses a page that carries no writing, and says why", () => {
    const reading = readImage(blankPaper(), LANGUAGE, OPTIONS);
    expect(reading.abstained).toBe(true);
    // Either honest reason may fire first -- the marks cannot be told apart, or they never repeat -- so the
    // test pins that a reason is given and that the evidence behind it holds, not which gate got there first.
    expect(reading.abstainedBecause).toBeTruthy();
    // The evidence behind it: blank paper's marks cannot be told apart at all, so there is no inventory. A
    // written page's marks can. (The reading chosen for noise is the cheapest one, which lumps every mark into
    // a single sign -- so counting how often that sign recurs says nothing; whether the marks DIFFER does.)
    expect(reading.signs.inventory.distinguishable).toBe(false);
    const written = readImage(renderTextPage(PAGE_LINES), LANGUAGE, OPTIONS);
    expect(written.signs.inventory.distinguishable).toBe(true);
    expect(written.abstained).toBe(false);
  });
});

describe("scripts that join or stack their letters, where a component is not a grapheme", () => {
  const SOLID_TRUTH = [...PAGE_LINES.map(l => l.replace(/ /g, "")).join("")];

  it("cuts a cursively joined word into its letters, and reads it", () => {
    // Every letter hangs from a full-width headline set solid, so a whole word arrives as ONE component --
    // what Devanagari does with its shirorekha and Arabic does along its baseline.
    const image = renderTextPageWith(JOINED_FONT, SOLID_LINES, [], 0);
    const reading = readImage(image, LANGUAGE, OPTIONS);
    const asMarks = reading.layoutEvidence.find(e => e.grouping === "marks" && e.orientation === "rows")!;
    // Taking components as graphemes finds a handful of word-blobs, not letters...
    expect(asMarks.glyphCount).toBeLessThan(SOLID_TRUTH.length / 10);
    // ...and the lattice cuts them apart, into exactly the letters that were written.
    expect(reading.grouping).toBe("cells");
    expect(reading.glyphCount).toBe(SOLID_TRUTH.length);
    expect(reading.signCount).toBe(new Set(SOLID_TRUTH).size);
    expect(editSimilarity(reading.lines.flat(), SOLID_TRUTH)).toBe(1);
  });

  it("refuses to fold mirrored letters together when both forms share a line", () => {
    // This hand is mirror-symmetric by construction: H and E, T and W, R and D are reflections of each other.
    // Folding them would shrink the inventory, and a smaller inventory always scores better per symbol, so
    // likelihood alone folds them and the reading collapses. Mirror variants of ONE sign segregate by line,
    // because a script that mirrors its glyphs mirrors a whole line of them; these interleave, so they stand.
    const reading = readImage(renderTextPageWith(JOINED_FONT, SOLID_LINES, [], 0), LANGUAGE, OPTIONS);
    expect(reading.mirrorFolded).toBe(false);
    expect(reading.signCount).toBe(new Set(SOLID_TRUTH).size);
  });
});
