// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
import { describe, expect, it } from "vitest";
import { knownLanguageFrom, readImage } from "../visual-eye.js";
import {
  FONT,
  bigramsOf,
  editSimilarity,
  frequenciesOf,
  renderTextPageWith,
  sampleWords,
  syntheticLanguage,
  wrapWords
} from "./page-fixtures.js";

// Where a reading actually goes wrong, held here so it cannot quietly move.
//
// The other tests in this suite read short pages of samples that happen to identify, and they read them
// exactly. That made it look as though the whole path were solved. It is not: on a page of the same size drawn
// from a different sample, the same font reads at 0.376. What these tests establish is WHICH stage loses it.
//
// Geometry and inventory are exact -- every letter of the script falls in exactly one cluster and no cluster
// carries two letters, at every page size measured. What is wrong on a short page is the assignment of clusters
// to symbols, because 264 symbols over a 64-cell bigram table do not identify the substitution. That is
// starvation in identification, and it is the stage the script memory supplies from a page already read.

const WEIGHTS = syntheticLanguage(20260918);
const CORPUS = sampleWords(WEIGHTS, 4242, 4000);
const LANGUAGE = knownLanguageFrom(bigramsOf(CORPUS), frequenciesOf(CORPUS));
const OPTIONS = { outerIterations: 150, epsilon: 0.05 };

/** Read a page and report, per true letter, which signs its instances landed in. */
function clustersPerLetter(words: number, seed: number) {
  const lines = wrapWords(sampleWords(WEIGHTS, seed, words), 8);
  const reading = readImage(renderTextPageWith(FONT, lines), LANGUAGE, OPTIONS);
  const truth = lines.map(line => [...line.replace(/ /g, "")]);
  const perLetter = new Map<string, Set<number>>();
  const perSign = new Map<number, Set<string>>();
  let alignedLines = 0;
  for (let i = 0; i < Math.min(reading.signs.lines.length, truth.length); i++) {
    const read = reading.signs.lines[i]!;
    const actual = truth[i]!;
    // A line the segmenter got the wrong length for cannot be compared position by position.
    if (read.length !== actual.length) continue;
    alignedLines += 1;
    for (let j = 0; j < read.length; j++) {
      const letter = actual[j]!;
      const sign = read[j]!;
      (perLetter.get(letter) ?? perLetter.set(letter, new Set()).get(letter)!).add(sign);
      (perSign.get(sign) ?? perSign.set(sign, new Set()).get(sign)!).add(letter);
    }
  }
  const similarity = editSimilarity(reading.lines.flat(), truth.flat());
  return { reading, perLetter, perSign, alignedLines, lines: truth.length, similarity };
}

describe("the eye's inventory is exact; what a sign MEANS is the hard part", () => {
  it("puts every instance of a letter in one cluster, and no letter in a cluster with another", () => {
    for (const words of [60, 240]) {
      const measured = clustersPerLetter(words, 991);
      // Every letter of the script appears.
      expect(measured.perLetter.size).toBe(Object.keys(FONT).length);
      for (const [letter, signs] of measured.perLetter) {
        expect(signs.size, `letter ${letter} at ${words} words split across clusters`).toBe(1);
      }
      for (const [sign, letters] of measured.perSign) {
        expect(letters.size, `sign ${sign} at ${words} words welded two letters`).toBe(1);
      }
    }
  });

  it("identifies a short page badly and a longer one well, on the same font", () => {
    // Starvation, not a broken stage. The short page's own statistics do not pin the substitution.
    const short = clustersPerLetter(60, 991);
    const long = clustersPerLetter(240, 991);
    expect(short.similarity).toBeLessThan(0.55);
    expect(long.similarity).toBeGreaterThan(0.75);
    expect(long.similarity).toBeGreaterThan(short.similarity);
  });

  it("segments a short page perfectly, so nothing there is a segmentation failure", () => {
    const short = clustersPerLetter(60, 991);
    expect(short.alignedLines).toBe(short.lines);
    // And with segmentation and clustering both exact, whatever it got wrong it got wrong at assignment.
    expect(short.similarity).toBeLessThan(1);
  });

  it("reports more signs than the script has only where lines mis-segment", () => {
    const long = clustersPerLetter(240, 991);
    // A few lines the segmenter gets the wrong length for; their marks are where the extra signs come from.
    expect(long.alignedLines).toBeLessThan(long.lines);
    expect(long.reading.signCount).toBeGreaterThan(Object.keys(FONT).length);
    // But every sign that appears on a correctly segmented line is still one letter's own.
    expect(long.perSign.size).toBe(Object.keys(FONT).length);
  });
});
