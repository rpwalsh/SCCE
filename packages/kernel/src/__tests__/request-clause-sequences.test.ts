// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
//
// A request that frames a quotation puts the frame and the quotation in one sentence, because a colon does not
// end a sentence. Measured on seven cloze rows: the answering span is retrieved and ranked first and the
// near-duplicate test still refuses it, because the frame's pairs are in the denominator and in no corpus
// sentence.
import { describe, expect, it } from "vitest";
import { splitSurfaceClauses, splitSurfaceSentences } from "../surface-linguistics.js";
import { requestSentenceSequences, surfaceRequestOrderedAdjacentPairFraction } from "../local-evidence-runtime.js";

const FRAME = "Complete this sentence from the source documents, answering with the missing text only: ";
const QUOTED = "Three are held at Harvard University, one at the University of Oklahoma, and one at the ____.";
const SOURCE = "Three are held at Harvard University, one at the University of Oklahoma, and one at the United States Air Force Academy.";

describe("clause boundaries", () => {
  it("divides a framed request into the frame and what it introduces", () => {
    const parts = splitSurfaceClauses(FRAME + QUOTED);
    expect(parts.length).toBe(2);
    expect(parts[1]).toContain("Harvard University");
    expect(parts[0]).not.toContain("Harvard");
  });

  it("returns nothing when there is no clause boundary to divide on", () => {
    expect(splitSurfaceClauses("Ada Lovelace was born in 1815.")).toEqual([]);
  });

  it("does not end a sentence -- that stays the sentence splitter's job", () => {
    expect(splitSurfaceSentences(FRAME + QUOTED).length).toBe(1);
  });
});

describe("request sequences", () => {
  it("offers the quoted clause as a sequence of its own", () => {
    const sequences = requestSentenceSequences(FRAME + QUOTED);
    const quoted = sequences.find(sequence => sequence.includes("harvard") && !sequence.includes("complete"));
    expect(quoted).toBeDefined();
    expect(sequences.some(sequence => sequence.includes("complete"))).toBe(true);
  });

  it("is still empty for an interrogative request, so no question-shaped workload can reach this", () => {
    expect(requestSentenceSequences("What is the boiling point of tungsten?")).toEqual([]);
    expect(requestSentenceSequences("Who won the 1998 FIFA World Cup?")).toEqual([]);
  });

  it("lets the source sentence reach the coverage floor it could not reach whole", () => {
    const sequences = requestSentenceSequences(FRAME + QUOTED);
    const whole = sequences.find(sequence => sequence.includes("complete"))!;
    const quoted = sequences.find(sequence => sequence.includes("harvard") && !sequence.includes("complete"))!;
    const wholeFraction = surfaceRequestOrderedAdjacentPairFraction(SOURCE, whole);
    const quotedFraction = surfaceRequestOrderedAdjacentPairFraction(SOURCE, quoted);
    expect(wholeFraction).toBeLessThan(0.5);
    expect(quotedFraction).toBeGreaterThanOrEqual(0.5);
  });
});
