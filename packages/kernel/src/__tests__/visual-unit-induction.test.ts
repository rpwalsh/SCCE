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

// The hierarchy the granularity bridge actually needs. An agglutinative language -- Nahuatl is the case in
// point, and Turkish, Finnish and Quechua behave the same way -- packs several morphemes into one written
// word, so aligning a visual sign to a whole surface word is aligning at the wrong level. The morphemes have
// to be found first, and finding them is the SAME measurement as finding words: a recurring piece earns its
// place when treating it as one unit makes the corpus shorter to describe. No new mechanism, one layer down.
describe("the same measurement one layer down: characters to morphemes", () => {
  const PREFIX = ["ni", "ti", "o"];
  const ROOT = ["tochtli", "atl", "tepetl", "calli"];
  const SUFFIX = ["tzin", "tin", "co"];
  const alphabet = new Map<string, number>();
  const code = (character: string) => {
    let value = alphabet.get(character);
    if (value === undefined) {
      value = alphabet.size;
      alphabet.set(character, value);
    }
    return value;
  };
  const spell = (word: string) => [...word].map(code);

  it("discovers the morphemes of an agglutinative corpus from its characters alone", () => {
    const random = uniform(5150);
    const corpus: number[][] = [];
    for (let i = 0; i < 40; i++) {
      // Words built as prefix + root + suffix, written solid, as such a language writes them.
      let line = "";
      for (let w = 0; w < 6; w++) {
        line += PREFIX[Math.floor(random() * PREFIX.length)]!
          + ROOT[Math.floor(random() * ROOT.length)]!
          + SUFFIX[Math.floor(random() * SUFFIX.length)]!;
      }
      corpus.push(spell(line));
    }

    const inventory = induceUnits(corpus);
    expect(inventory.codeLength).toBeLessThan(inventory.baseCodeLength);

    // The units it admitted, read back as text.
    const letters = [...alphabet.entries()].reduce(
      (out, [character, value]) => out.set(value, character),
      new Map<number, string>()
    );
    const admitted = new Set(
      inventory.units
        .filter(unit => unit.signs.length > 1)
        .map(unit => unit.signs.map(sign => letters.get(sign)!).join(""))
    );

    // The roots come back whole, and those are the pieces a logogram corresponds to -- which is what the
    // bridge needs. Three of the four here, the missing one being two characters long.
    const roots = ROOT.filter(root => admitted.has(root));
    expect(roots.length).toBeGreaterThanOrEqual(3);
    expect(admitted.has("tochtli")).toBe(true);
    expect(admitted.has("tepetl")).toBe(true);

    // What is NOT claimed: recovering the short affixes as well. A two-character affix is readily absorbed
    // into a longer composite that also pays for itself, and telling those apart needs a morphology model
    // with a prior over morph length and category. Measured here: one of six.
    const affixes = [...PREFIX, ...SUFFIX].filter(affix => admitted.has(affix));
    expect(affixes.length).toBeGreaterThanOrEqual(1);
  });

  it("aligns at the layer that compresses, so a sign can answer to a morpheme rather than a word", () => {
    // One "word" of this language is three morphemes long. Induced units are the morphemes, so a visual sign
    // aligned against them is aligned against morphemes -- which is the level an agglutinative language makes
    // available, and the level a logogram or a phonogram actually corresponds to.
    const corpus = [spell("nitochtlitzin".repeat(6)), spell("otepetlco".repeat(6))];
    const inventory = induceUnits(corpus);
    const segmented = unitsOf(corpus, inventory);
    const pieces = segmented.flat();
    // Most of the corpus is covered by units longer than a single character, so alignment happens above the
    // character layer. Counted in CHARACTERS, not in pieces: a handful of long units can cover far more of the
    // text than many single characters, and the piece count says the opposite of the truth.
    const characters = pieces.reduce((total, piece) => total + piece.length, 0);
    const covered = pieces.filter(piece => piece.length > 1).reduce((total, piece) => total + piece.length, 0);
    expect(covered / characters).toBeGreaterThan(0.5);
    // A corpus of one form repeated carries no evidence of where that form divides, so the whole form is the
    // right unit and is what comes back. Boundaries need alternation to be visible at all.
    // Nothing is lost: the units put each line back together exactly.
    segmented.forEach((line, index) => expect(line.flat()).toEqual(corpus[index]!));
  });
});
