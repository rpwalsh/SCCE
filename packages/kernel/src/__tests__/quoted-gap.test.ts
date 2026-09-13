// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
//
// Rows are verbatim from the live head-to-head run: the request as asked, and the sentence SCCE answered with,
// which scored correct while burying the asked value past its opening.
import { describe, expect, it } from "vitest";
import { quotedSentenceGap } from "../quoted-gap.js";

const FRAME = "Complete this sentence from the source documents, answering with the missing text only: ";

describe("the hole in a quoted sentence", () => {
  it("recovers the missing run from a live row", () => {
    const request = `${FRAME}She became fascinated with the machine and used her relationship with ____ to visit Babbage as often as she could.`;
    const answered = "She became fascinated with the machine and used her relationship with Somerville to visit Babbage as often as she could.";
    expect(quotedSentenceGap(answered, request)).toBe("Somerville");
  });

  it("recovers a multi-word run", () => {
    const request = `${FRAME}Watercolour portrait circa 1840]] Lovelace became close friends with her tutor ____, who introduced her to Charles Babbage in 1833.`;
    const answered = "Watercolour portrait circa 1840 Lovelace became close friends with her tutor Mary Somerville, who introduced her to Charles Babbage in 1833.";
    expect(quotedSentenceGap(answered, request)).toBe("Mary Somerville");
  });

  it("recovers a run from mid-sentence", () => {
    const request = `${FRAME}She danced often and was able to charm many people, and was described by most people as being dainty, although ____, Byron's friend, described her as "a large, coarse-skinned young woman".`;
    const answered = "She danced often and was able to charm many people, and was described by most people as being dainty, although John Hobhouse, Byron's friend, described her as \"a large, coarse-skinned young woman\".";
    expect(quotedSentenceGap(answered, request)).toBe("John Hobhouse");
  });

  it("keeps a run whole across a boundary learned units stopped at", () => {
    // Prior art, production-turn-runtime.ts:4185: an earlier attempt emitted "TrekMovie" where the source reads
    // "TrekMovie.com", because learned units end where the source does not. These boundaries come from where the
    // request stops accounting for the surface, and the run is sliced out of the surface by offset.
    const request = `${FRAME}It was described by ____ as a bold reinvention of the franchise.`;
    const answered = "It was described by TrekMovie.com as a bold reinvention of the franchise.";
    expect(quotedSentenceGap(answered, request)).toBe("TrekMovie.com");
  });

  it("says nothing when the request does not quote the sentence", () => {
    expect(quotedSentenceGap("Athens is the capital and largest city of Greece.", "What is the capital of Greece?")).toBe("");
  });

  it("says nothing when the sentence is the request", () => {
    const sentence = "Lovelace became close friends with her tutor Mary Somerville.";
    expect(quotedSentenceGap(sentence, `${FRAME}${sentence}`)).toBe("");
  });

  it("says nothing when two runs of the same length leave the hole undecided", () => {
    // Two words dropped, far apart and equally long: which one was asked for is not decidable from the pair.
    const request = `${FRAME}The ____ crossed the river and the ____ followed it home.`;
    const answered = "The dog crossed the river and the cat followed it home.";
    expect(quotedSentenceGap(answered, request)).toBe("");
  });

  it("says nothing when the hole is not smaller than the quotation around it", () => {
    expect(quotedSentenceGap("Alpha beta gamma delta epsilon zeta.", `${FRAME}Alpha beta.`)).toBe("");
  });
});
