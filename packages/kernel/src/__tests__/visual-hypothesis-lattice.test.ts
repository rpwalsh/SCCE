// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
import { describe, expect, it } from "vitest";
import {
  calibrateEvidence,
  describeDisagreement,
  dominates,
  jitteredPositions,
  permutedIdentities,
  pruneByDomination,
  shuffledOrder,
  type Interpretation
} from "../visual-hypothesis-lattice.js";
import { knownLanguageFrom, readImageWithAlternatives } from "../visual-eye.js";
import {
  bigramsOf,
  frequenciesOf,
  noise,
  renderTextPage,
  sampleWords,
  syntheticLanguage,
  wrapWords
} from "./page-fixtures.js";
import type { GrayImage } from "../visual-page-analysis.js";

// The claim: where the marks admit two explanations, both are kept and the disagreement is reported, rather
// than one being chosen silently. And every claim about the marks is scored against the same measurement taken
// with its structure destroyed, so confidence in "these fall into lines" and in "this reads like the language"
// are quoted in one currency.

const WEIGHTS = syntheticLanguage(20260918);
const CORPUS = sampleWords(WEIGHTS, 4242, 4000);
const LANGUAGE = knownLanguageFrom(bigramsOf(CORPUS), frequenciesOf(CORPUS));
const PAGE_LINES = wrapWords(sampleWords(WEIGHTS, 777, 60), 8);
const OPTIONS = { outerIterations: 150, epsilon: 0.05, nullDraws: 24 };

const channel = (name: string, z: number) => ({
  name, observed: z, nullMean: 0, nullSpread: 1, z, tail: 0.02, samples: 24
});
const interpretation = (
  label: string,
  codeLength: number,
  zs: readonly [string, number][],
  choices: Record<string, string> = {},
  contradictions = 0
): Interpretation => ({
  label, choices, text: label, codeLength, contradictions,
  evidence: zs.map(([name, z]) => channel(name, z))
});

function blankPaper(): GrayImage {
  const width = 240;
  const height = 160;
  const jitter = noise(5);
  const data = new Uint8Array(width * height);
  for (let i = 0; i < data.length; i++) data[i] = 200 + jitter();
  return { width, height, data };
}

describe("scoring a claim against the structure it claims", () => {
  it("reports a standard score and an empirical tail, and never a probability of zero", () => {
    const evidence = calibrateEvidence("lines", 10, [1, 2, 1, 2, 1, 2, 1, 2]);
    expect(evidence.z).toBeGreaterThan(5);
    // Add-one corrected: with eight draws none of which reached it, the tail is 1/9, not 0.
    expect(evidence.tail).toBeCloseTo(1 / 9, 6);
    expect(evidence.samples).toBe(8);
  });

  it("gives an unremarkable observation no support at all", () => {
    const evidence = calibrateEvidence("lines", 1.5, [1, 2, 1, 2, 1, 2]);
    expect(Math.abs(evidence.z)).toBeLessThan(1.1);
    expect(evidence.tail).toBeGreaterThan(0.4);
  });

  it("builds nulls that destroy one structure and leave the rest", () => {
    const order = [1, 2, 3, 4, 5, 6, 7, 8];
    const shuffled = shuffledOrder(order, 9);
    // Shuffling destroys the order and keeps the multiset, so a claim about adjacency loses its support and a
    // claim about which signs are present does not.
    expect([...shuffled].sort((a, b) => a - b)).toEqual(order);
    expect(shuffled).not.toEqual(order);
    // Permuting identities keeps the order and relabels, so it is the null for a claim about identity.
    const signs = [0, 1, 0, 2, 1, 2, 0];
    const permuted = permutedIdentities(signs, 3);
    expect(permuted).toHaveLength(signs.length);
    expect(new Set(permuted).size).toBe(new Set(signs).size);
    // Jitter moves positions by at most their own scale, destroying banding.
    const jittered = jitteredPositions([0, 100, 200], 10, 4);
    jittered.forEach((value, index) => expect(Math.abs(value - [0, 100, 200][index]!)).toBeLessThanOrEqual(10));
    // Every null is reproducible from its seed.
    expect(shuffledOrder(order, 9)).toEqual(shuffled);
  });
});

describe("keeping the alternatives instead of choosing between them", () => {
  it("discards a reading only when another is at least as good everywhere and better somewhere", () => {
    const strong = interpretation("strong", 100, [["lines", 5], ["language", 4]]);
    const weak = interpretation("weak", 120, [["lines", 3], ["language", 2]]);
    expect(dominates(strong, weak)).toBe(true);
    expect(dominates(weak, strong)).toBe(false);

    // Cheaper but less supported: neither dominates, so both stand.
    const cheapButUnsupported = interpretation("cheap", 80, [["lines", 1], ["language", 1]]);
    expect(dominates(cheapButUnsupported, strong)).toBe(false);
    expect(dominates(strong, cheapButUnsupported)).toBe(false);

    // Equal in every respect is not domination either, or both would discard each other.
    const twin = interpretation("twin", 100, [["lines", 5], ["language", 4]]);
    expect(dominates(strong, twin)).toBe(false);

    // A reading that never measured a channel the other did cannot dominate it: that evidence is unaccounted for.
    const silent = interpretation("silent", 50, [["lines", 9]]);
    expect(dominates(silent, strong)).toBe(false);
  });

  it("reports what the surviving readings disagree about", () => {
    const lattice = pruneByDomination([
      interpretation("a", 100, [["lines", 4]], { orientation: "rows", granularity: "signs" }),
      interpretation("b", 90, [["lines", 2]], { orientation: "rows", granularity: "units" }),
      interpretation("c", 400, [["lines", 1]], { orientation: "columns", granularity: "signs" })
    ]);
    expect(lattice.readings.length).toBeGreaterThanOrEqual(2);
    expect(lattice.dominated).toHaveLength(1);
    const questions = lattice.undecided.map(item => item.question);
    // They agree on the axis and differ on the granularity, and that is what is said.
    expect(questions).toContain("granularity");
    expect(questions).not.toContain("orientation");
    expect(describeDisagreement(lattice)).toContain("granularity");
  });

  it("says nothing about disagreement when one reading dominates", () => {
    const lattice = pruneByDomination([
      interpretation("best", 100, [["lines", 5]], { orientation: "rows" }),
      interpretation("worse", 200, [["lines", 1]], { orientation: "columns" })
    ]);
    expect(lattice.readings).toHaveLength(1);
    expect(lattice.undecided).toHaveLength(0);
    expect(describeDisagreement(lattice)).toBeUndefined();
  });
});

describe("the lattice on real pages", () => {
  it("settles an ordinary page to a single reading, with both claims strongly supported", () => {
    const lattice = readImageWithAlternatives(renderTextPage(PAGE_LINES), LANGUAGE, OPTIONS);
    // A page with this much writing leaves nothing to argue about: every other reading is dominated.
    expect(lattice.readings).toHaveLength(1);
    expect(lattice.dominated.length).toBeGreaterThan(0);
    expect(lattice.undecided).toHaveLength(0);
    expect(describeDisagreement(lattice)).toBeUndefined();
    const best = lattice.readings[0]!;
    const lines = best.evidence.find(e => e.name === "lines")!;
    const fit = best.evidence.find(e => e.name === "language")!;
    // The banding and the reading are both far outside what destroying them leaves behind.
    expect(lines.z).toBeGreaterThan(1);
    expect(fit.z).toBeGreaterThan(1);
    expect(fit.tail).toBeLessThan(0.1);
    expect(best.contradictions).toBe(0);
  });

  it("keeps both readings of a single line, and says what they turn on", () => {
    // One line carries no evidence about which way the lines run or where a word ends, so the axis and the
    // grouping are genuinely open. This is the case the lattice exists for: it says so instead of guessing.
    const lattice = readImageWithAlternatives(renderTextPage([PAGE_LINES[0]!]), LANGUAGE, OPTIONS);
    expect(lattice.readings.length).toBeGreaterThan(1);
    const said = describeDisagreement(lattice)!;
    expect(said).toContain("readings stand");
    const questions = lattice.undecided.map(item => item.question);
    expect(questions.length).toBeGreaterThan(0);
    // Whatever is still open, every surviving reading accounts for every mark it found.
    for (const reading of lattice.readings) expect(reading.contradictions).toBe(0);
  });

  it("finds no support on a page that carries no writing", () => {
    const lattice = readImageWithAlternatives(blankPaper(), LANGUAGE, OPTIONS);
    for (const reading of lattice.readings) {
      const fit = reading.evidence.find(e => e.name === "language")!;
      // Shuffling the order of noise changes nothing, because there was no order to destroy.
      expect(fit.tail).toBeGreaterThan(0.05);
    }
  });
});
