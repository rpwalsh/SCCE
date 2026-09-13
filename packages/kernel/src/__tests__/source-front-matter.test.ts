// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
import { describe, expect, it } from "vitest";
import { spanIsSourceFrontMatter } from "../local-evidence-runtime.js";
import { isStructuralResidueSurface, structuralResidueMeasurement } from "../structural-residue.js";
import type { EvidenceId, EvidenceSpan, SourceVersionId } from "../types.js";

/**
 * A source that names itself opens with its apparatus. The answer-of-last-resort lanes read the opening block of
 * whatever was admitted, so "Where does Jonathan Harker travel to in Dracula?" was answered with the Project
 * Gutenberg licence header and "What is the name of the ship in Treasure Island?" with the chapter index.
 */
describe("a source's front matter is not an answer about the source", () => {
  const licence = "The Project Gutenberg eBook of Dracula This eBook is for the use of anyone anywhere in the United "
    + "States and most other parts of the world at no cost and with almost no restrictions whatsoever. You may copy "
    + "it, give it away or re-use it under the terms of the Project Gutenberg License included with this eBook.";

  it("holds of the opening block of a source with an identity of its own, and of nothing an article opens with", () => {
    // Measured on the live corpus 2026-09-13: of 21,915 promoted Wikipedia opening blocks, 0 carry an identity
    // distinct from their title, so this predicate cannot reach an article's definitional lead. Of the 55 promoted
    // Gutenberg opening blocks, 30 do -- including every one of the nine benchmark books.
    expect(spanIsSourceFrontMatter(bookOpening)).toBe(true);
    expect(spanIsSourceFrontMatter(bookInterior)).toBe(false);
    expect(spanIsSourceFrontMatter(articleOpening)).toBe(false);
  });

  it("is not already covered by the structural-residue surface measure", () => {
    // The two mechanisms are complementary and neither subsumes the other: a licence header is fluent prose, so
    // the surface measure reads it as a statement. Keeping the assertion here means a future merge of the two
    // cannot quietly drop this material.
    expect(isStructuralResidueSurface(licence)).toBe(false);
    expect(structuralResidueMeasurement(licence).score).toBeLessThan(0.02);
  });
});

const bookOpening = span({ id: "evidence:book:opening", charStart: 0, identity: "bram stoker harker mina helsing lucy seward" });
const bookInterior = span({ id: "evidence:book:interior", charStart: 64704, identity: "bram stoker harker mina helsing lucy seward" });
const articleOpening = span({ id: "evidence:article:opening", charStart: 0, identity: "" });

function span(input: { id: string; charStart: number; identity: string }): EvidenceSpan {
  return {
    id: input.id as EvidenceId,
    sourceVersionId: `${input.id}:v1` as SourceVersionId,
    text: "unused",
    textPreview: "unused",
    status: "promoted",
    alpha: 0.9,
    charStart: input.charStart,
    features: [],
    provenance: {
      uri: `fixture://${input.id}`,
      title: "dracula",
      ...(input.identity ? { identity: input.identity } : {}),
      sourceVersionId: `${input.id}:v1`,
      byteRange: [0, 6],
      charRange: [input.charStart, input.charStart + 6],
      metadata: { title: "dracula" }
    }
  } as unknown as EvidenceSpan;
}
