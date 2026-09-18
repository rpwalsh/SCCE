// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
import { describe, expect, it } from "vitest";
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

// How much of a page one sign is worth is settled on the ordinary reading path, not in a separate pass. An
// alphabet spends one sign per symbol and keeps its signs, because a unit inventory would have to pay for
// itself and cannot. A script that spends two marks on one sound -- a syllabary, as Linear B and the Cypriot
// script do -- is read in those units instead, because there the units are what pay.

const WEIGHTS = syntheticLanguage(20260918);
const CORPUS = sampleWords(WEIGHTS, 4242, 4000);
const LANGUAGE = knownLanguageFrom(bigramsOf(CORPUS), frequenciesOf(CORPUS));
const OPTIONS = { outerIterations: 150, epsilon: 0.05 };

/** Each symbol of the language written as a fixed PAIR of marks, the way a syllabary spends two on one. */
const AS_PAIRS: Record<string, string> = {
  H: "HE", E: "LO", L: "TW", O: "RD", T: "HO", W: "LE", R: "TD", D: "RW"
};

describe("how much of a page one sign is worth, decided on the reading path", () => {
  it("keeps single signs for an alphabet, because units would have to pay for themselves", () => {
    const lines = wrapWords(sampleWords(WEIGHTS, 777, 60), 8);
    const truth = [...lines.join(" ").replace(/ /g, "")];
    const reading = readImage(renderTextPage(lines), LANGUAGE, OPTIONS);
    expect(reading.granularity).toBe("signs");
    expect(reading.unitCount).toBe(0);
    // And the page still reads exactly, which is the point of not coarsening it.
    expect(editSimilarity(reading.lines.flat(), truth)).toBe(1);
  });

  it("reads a script that spends two marks on one symbol in those units instead", () => {
    const spoken = wrapWords(sampleWords(WEIGHTS, 777, 40), 6);
    const written = spoken.map(line => [...line].map(ch => (ch === " " ? " " : AS_PAIRS[ch]!)).join(""));
    const symbols = [...spoken.join(" ").replace(/ /g, "")];

    const reading = readImage(renderTextPage(written), LANGUAGE, OPTIONS);
    // Twice as many marks on the page as there are symbols behind them.
    expect(reading.glyphCount).toBe(symbols.length * 2);
    // And the page is read in units rather than one mark at a time: the units are what pay here.
    expect(reading.granularity).toBe("units");
    expect(reading.unitCount).toBeGreaterThan(0);
    expect(reading.unitCount).toBeLessThan(reading.glyphCount);

    // What is NOT claimed: that those units are the script's own. Description length finds units that
    // COMPRESS, and a frequent pair of symbols written as four marks compresses too, so the inventory comes
    // back larger than the eight pairs actually used -- measured, 13 to 16 units, and more text does not
    // converge it because those longer runs genuinely do recur. With more units than the language has symbols
    // a one-to-one key cannot exist, and the reading lands near 0.4.
    //
    // The missing step is joining this to the variable-arity aligner, which exists and handles exactly a
    // many-units-to-fewer-symbols correspondence; the two are not yet composed. Until they are, this asserts
    // the granularity is chosen correctly and does not pretend the reading is right.
    expect(editSimilarity(reading.lines.flat(), symbols)).toBeGreaterThan(0.25);
  });
});
