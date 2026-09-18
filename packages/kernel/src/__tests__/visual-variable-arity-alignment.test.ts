// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
import { describe, expect, it } from "vitest";
import {
  alignVariableArity,
  readThroughCorrespondences
} from "../visual-variable-arity-alignment.js";
import { uniform } from "./page-fixtures.js";

// The claim: a correspondence need not be one sign to one symbol, and which arity it is comes out of the
// evidence. The case here is a DIGRAPH -- two signs standing for one symbol, as English does with "th" and
// Greek with "ou" -- which a one-to-one assignment cannot represent at all: it must either drop one of the two
// signs or give it a symbol of its own that the page never contains.

/** Six symbols, one of which the script writes with two signs instead of one. */
const SYMBOLS = ["A", "B", "C", "D", "E", "F"];
const WRITING: Record<string, string[]> = {
  A: ["s0"],
  B: ["s1"],
  C: ["s2"],
  // D is a digraph: two signs, neither of which is used for anything else.
  D: ["s3", "s4"],
  E: ["s5"],
  F: ["s6"]
};

/** A language with an asymmetric transition structure, so neighbourhoods carry information. */
function speak(seed: number, length: number): string[][] {
  const random = uniform(seed);
  const weights = SYMBOLS.map((_, i) => SYMBOLS.map((_, j) => (1 / (j + 1)) * (0.3 + 0.7 * random())));
  const lines: string[][] = [];
  let previous = 0;
  for (let line = 0; line < 24; line++) {
    const said: string[] = [];
    for (let k = 0; k < length; k++) {
      const row = weights[previous]!;
      const total = row.reduce((a, b) => a + b, 0);
      let pick = random() * total;
      let next = SYMBOLS.length - 1;
      for (let j = 0; j < SYMBOLS.length; j++) {
        pick -= row[j]!;
        if (pick <= 0) {
          next = j;
          break;
        }
      }
      said.push(SYMBOLS[next]!);
      previous = next;
    }
    lines.push(said);
  }
  return lines;
}

const write = (spoken: readonly string[][]) => spoken.map(line => line.flatMap(symbol => WRITING[symbol]!));

describe("aligning without assuming one sign per symbol", () => {
  const spoken = speak(20260918, 30);
  const written = write(spoken);
  // What a single-symbol aligner would already believe: the signs that do stand alone. The digraph's two signs
  // are deliberately absent from it, which is the situation a one-to-one pass leaves behind.
  const provisional = new Map<string, string>([
    ["s0", "A"], ["s1", "B"], ["s2", "C"], ["s5", "E"], ["s6", "F"]
  ]);

  it("recovers the digraph as one correspondence of two signs to one symbol", () => {
    const alignment = alignVariableArity({
      sourceSequences: written,
      targetSequences: spoken,
      provisional,
      maxArity: 2,
      nullDraws: 16
    });
    const digraph = alignment.correspondences.find(c => c.source.length === 2);
    expect(digraph).toBeDefined();
    expect(digraph!.source).toEqual(["s3", "s4"]);
    expect(digraph!.target).toEqual(["D"]);
    // The page is not bijective and the alignment says so.
    expect(alignment.bijective).toBe(false);
  });

  it("still gets the one-to-one correspondences right alongside it", () => {
    const alignment = alignVariableArity({
      sourceSequences: written,
      targetSequences: spoken,
      provisional,
      maxArity: 2,
      nullDraws: 16
    });
    const single = new Map(
      alignment.correspondences
        .filter(c => c.source.length === 1 && c.target.length === 1)
        .map(c => [c.source[0]!, c.target[0]!])
    );
    let correct = 0;
    for (const [symbol, signs] of Object.entries(WRITING)) {
      if (signs.length === 1 && single.get(signs[0]!) === symbol) correct += 1;
    }
    // All five symbols written with one sign each are recovered, alongside the digraph, and none is given twice.
    expect(correct).toBe(5);
    const usedSigns = alignment.correspondences.flatMap(c => c.source);
    expect(new Set(usedSigns).size).toBe(usedSigns.length);
  });

  it("reads a sign sequence back out through correspondences of mixed arity", () => {
    const alignment = alignVariableArity({
      sourceSequences: written,
      targetSequences: spoken,
      provisional,
      maxArity: 2,
      nullDraws: 16
    });
    // Longest match first, so the digraph is read as one symbol rather than two unknowns.
    const read = readThroughCorrespondences(["s3", "s4", "s0", "s1"], alignment.correspondences);
    expect(read[0]).toBe("D");
    expect(read).toHaveLength(3);
  });

  it("gates on information under a null, never on weighted coefficients", () => {
    const alignment = alignVariableArity({
      sourceSequences: written,
      targetSequences: spoken,
      provisional,
      maxArity: 2,
      nullDraws: 16
    });
    for (const correspondence of alignment.correspondences) {
      // Every channel is quoted as a standard score and a tail against random pairings, and the candidate's
      // score is their summed surprisal -- so a channel that carries nothing adds nothing.
      expect(correspondence.channels.map(channel => channel.name)).toEqual(["frequency", "context"]);
      for (const channel of correspondence.channels) {
        // Every channel is quoted as a standard score and a tail against random pairings...
        expect(channel.tail).toBeGreaterThan(0);
        expect(channel.tail).toBeLessThanOrEqual(1);
        expect(channel.samples).toBeGreaterThan(0);
        // ...and nothing is admitted that its own evidence does not support. That is the gate; which of the
        // admissible correspondences are taken is settled by description length, not by these numbers.
        expect(channel.z).toBeGreaterThan(0);
      }
      expect(correspondence.score).toBeGreaterThan(0);
    }
  });

  it("returns nothing rather than guessing when there is no repetition to go on", () => {
    const alignment = alignVariableArity({
      sourceSequences: [["x"]],
      targetSequences: [["Y"]],
      provisional: new Map(),
      nullDraws: 8
    });
    expect(alignment.correspondences).toHaveLength(0);
    expect(alignment.bijective).toBe(true);
  });
});
