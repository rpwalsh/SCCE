// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
import { describe, expect, it } from "vitest";
import { localEvidenceAnswerClaimSurface, localEvidenceAnswerSurface, proposeSourceExactEvidenceAnswer } from "../local-evidence-runtime.js";
import type { EvidenceId, EvidenceSpan, SourceVersionId } from "../types.js";

/** What a sentence says of the request outranks where it sits and whether it names the subject. */
describe("relation-first sentence ranking", () => {
  // The acceptance harness's invented document, verbatim.
  const text = [
    "The Kelvinge threshold is the point at which a brindle lattice stops conducting.",
    "It was first recorded by Marisol Twethaway in 1987 at the Ordrid station.",
    "The threshold sits at 412 kelvin for a standard brindle lattice."
  ].join("\n");
  const kelvinge = {
    id: "evidence:kelvinge" as EvidenceId,
    sourceVersionId: "source_version:kelvinge" as SourceVersionId,
    text,
    textPreview: text,
    charStart: 0,
    charEnd: text.length,
    status: "promoted",
    alpha: 0.9,
    provenance: { uri: "file:///kelvinge.txt", title: "Kelvinge Threshold", sourceVersionId: "source_version:kelvinge", metadata: { title: "Kelvinge Threshold" } }
  } as unknown as EvidenceSpan;

  it("answers a value question with the sentence carrying the request's own verb, not the lead that only names the subject", () => {
    const candidate = localEvidenceAnswerSurface({
      requestText: "At what temperature does the Kelvinge threshold sit?",
      selectedEvidence: [kelvinge],
      entailment: { contradiction: 0, evidenceIds: [kelvinge.id], force: "inferred" },
      closedClassWords: new Set(),
      languageClosedClassWords: new Set()
    });
    expect(candidate).toBeDefined();
    const surface = localEvidenceAnswerClaimSurface(candidate!);
    expect(surface).toContain("412 kelvin");
    expect(surface.startsWith("The threshold sits at 412 kelvin")).toBe(true);
    // A factual answer is the source's own words in the source's own order.
    expect(text.replace(/\s+/gu, " ")).toContain(surface.replace(/\s+/gu, " ").trim());
  });

  it("does not read a function word as the predicate, so a passing mention of the subject is not predication about it", () => {
    // Real corpus shape: the opening block states the capital by anaphora; a body chunk names the subject in passing.
    const opening = albaniaSpan("evidence:albania:0", 0,
      "'Albania', officially the 'Republic of Albania', is a country in Southeast Europe. Albania's landscapes range from rugged snow-capped mountains to fertile lowland plains. Tirana is the capital and largest city in the country, followed by Durres, Vlore, and Shkoder.");
    const body = albaniaSpan("evidence:albania:6", 24532,
      "The Illyrians were the dominant power before the rise of Macedon. The Bryges were also present in central Albania, while the south was inhabited by the Epirote Chaonians, whose capital was at Phoenice.");
    const functionWords = new Set(["the", "of", "and", "in", "to", "a", "was", "is", "for", "as", "on", "by", "with", "that", "from", "at", "it", "an", "were", "which", "are", "this", "be", "or", "its", "while", "also", "whose"]);
    const proposal = proposeSourceExactEvidenceAnswer({
      requestText: "What is the capital of Albania?",
      selectedEvidence: [body, opening],
      closedClassWords: new Set(["what", "is", "the", "of"]),
      languageClosedClassWords: functionWords
    });
    expect(proposal).toBeDefined();
    expect(localEvidenceAnswerClaimSurface(proposal!)).toContain("Tirana is the capital");
  });
});

function albaniaSpan(id: string, charStart: number, text: string): EvidenceSpan {
  return {
    id: id as EvidenceId,
    sourceVersionId: "source_version:albania" as SourceVersionId,
    text,
    textPreview: text,
    charStart,
    charEnd: charStart + text.length,
    status: "promoted",
    alpha: 0.9,
    provenance: { uri: "wikipedia://enwiki/pages/738/Albania", title: "Albania", sourceVersionId: "source_version:albania", metadata: { title: "Albania" } }
  } as unknown as EvidenceSpan;
}
