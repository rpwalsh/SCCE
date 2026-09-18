// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
import { describe, expect, it } from "vitest";
import { induceUnits, segmentByUnits, unitsOf } from "../visual-unit-induction.js";
import { uniform } from "./page-fixtures.js";

// The claim: what counts as ONE unit of a script is discovered, not declared. A page whose signs spell out
// recurring words is described more briefly if those words are units, and a page whose signs are independent is
// not -- so the same code returns words for the first and bare signs for the second, with nothing said about
// which script either is. This is the bridge to logographic writing: Egyptian, Mayan and Aztec spend one sign
// on a morpheme or a word, and an alphabet spends one on a sound, and neither is assumed.

/** A vocabulary of multi-sign "words" over an alphabet of base signs. */
const VOCABULARY: readonly (readonly number[])[] = [
  [0, 1],
  [2, 3, 4],
  [5, 6],
  [1, 7, 2],
  [3, 0],
  [6, 4, 5]
];

function writeWords(seed: number, count: number): number[][] {
  const random = uniform(seed);
  const lines: number[][] = [];
  for (let line = 0; line < 12; line++) {
    const signs: number[] = [];
    for (let w = 0; w < count; w++) {
      signs.push(...VOCABULARY[Math.floor(random() * VOCABULARY.length)]!);
    }
    lines.push(signs);
  }
  return lines;
}

/** The same alphabet, but every sign drawn independently: there are no words to find. */
function writeIndependent(seed: number, length: number): number[][] {
  const random = uniform(seed);
  const lines: number[][] = [];
  for (let line = 0; line < 12; line++) {
    const signs: number[] = [];
    for (let i = 0; i < length; i++) signs.push(Math.floor(random() * 8));
    lines.push(signs);
  }
  return lines;
}

describe("discovering what counts as one unit, by what makes the page shortest", () => {
  it("promotes recurring sign groups to units, and they are the words that were written", () => {
    const page = writeWords(31337, 14);
    const inventory = induceUnits(page);

    // Describing the page got shorter, which is the only reason any unit was admitted.
    expect(inventory.codeLength).toBeLessThan(inventory.baseCodeLength);

    const composites = inventory.units.filter(unit => unit.signs.length > 1).map(unit => unit.signs.join(","));
    const written = VOCABULARY.map(word => word.join(","));
    const found = written.filter(word => composites.includes(word));
    // Every word is recovered as a unit, with no dictionary and no notion of a word boundary -- and nothing
    // else is: the inventory is exactly the vocabulary, so no spurious group paid for itself.
    expect(found).toHaveLength(written.length);
    expect(composites).toHaveLength(written.length);
    // And every unit it admitted pays for itself in description length.
    for (const unit of inventory.units) expect(unit.savedNats).toBeGreaterThanOrEqual(0);
  });

  it("segments the page back into those units, recovering the boundaries it was never shown", () => {
    const page = writeWords(31337, 14);
    const inventory = induceUnits(page);
    const segmented = unitsOf(page, inventory);
    expect(segmented).toHaveLength(page.length);
    // Segmentation is lossless: the units of a line put the line back together exactly.
    segmented.forEach((pieces, line) => {
      expect(pieces.flat()).toEqual([...page[line]!]);
    });
    // Every piece is exactly one of the words written, so the granularity recovered is the one used.
    const pieces = segmented.flat();
    const written = new Set(VOCABULARY.map(word => word.join(",")));
    expect(pieces.filter(piece => written.has(piece.join(",")))).toHaveLength(pieces.length);
  });

  it("finds no units where the signs are independent, instead of inventing them", () => {
    const page = writeIndependent(99, 40);
    const inventory = induceUnits(page);
    const composites = inventory.units.filter(unit => unit.signs.length > 1);
    // Nothing recurs beyond chance, so nothing pays for itself and the base signs stand alone. A likelihood
    // would have merged them anyway: fewer symbols always reads better per symbol. Description length does not.
    expect(composites).toHaveLength(0);
    expect(inventory.codeLength).toBe(inventory.baseCodeLength);
  });

  it("segments by dynamic programming, taking the cheapest cover of the sequence", () => {
    const cost = new Map<string, number>([
      ["1", 3], ["2", 3], ["3", 3],
      ["1,2", 1],
      ["2,3", 5]
    ]);
    // 1,2 then 3 costs 1 + 3 = 4; 1 then 2,3 costs 3 + 5 = 8. The cheaper cover wins, not the greedier one.
    expect(segmentByUnits([1, 2, 3], cost, 2)).toEqual([[1, 2], [3]]);
  });

  it("falls back to bare signs when no cover exists, rather than failing", () => {
    const cost = new Map<string, number>([["9,9", 1]]);
    expect(segmentByUnits([1, 2], cost, 2)).toEqual([[1], [2]]);
  });
});
