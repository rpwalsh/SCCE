// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
import { describe, expect, it } from "vitest";
import { sourceIdentityAdmissibleEvidenceForRequest } from "../local-evidence-runtime.js";
import type { EvidenceId, EvidenceSpan, SourceVersionId } from "../types.js";

/** The request's interrogative head is not content a titled source has to contain. */
describe("source identity admission fit", () => {
  // Real corpus shape: the opening block states the capital and never says "that"; later chunks do.
  const opening = span("evidence:albania:0", 0,
    "'Albania', officially the 'Republic of Albania', is a country in Southeast Europe. Albania's landscapes range from rugged snow-capped mountains to fertile lowland plains. Tirana is the capital and largest city in the country, followed by Durres, Vlore, and Shkoder.");
  const history = span("evidence:albania:2", 8173,
    "The Illyrian Ardiaei tribe ruled over most of northern Albania. Durres was the capital of a province that the Romans held until the partition.");

  it("admits the titled opening block that states the answer, not only chunks containing a word resembling the question word", () => {
    const admitted = sourceIdentityAdmissibleEvidenceForRequest("What is the capital of Albania?", [opening, history]).evidence.map(item => String(item.id));
    expect(admitted).toContain("evidence:albania:0");
    expect(admitted).toContain("evidence:albania:2");
  });

  it("still refuses a titled chunk that carries none of what the request asks", () => {
    const unrelated = span("evidence:albania:9", 40000, "Albania participated in the Eurovision Song Contest for the first time in 2004.");
    const admitted = sourceIdentityAdmissibleEvidenceForRequest("What is the capital of Albania?", [opening, unrelated]).evidence.map(item => String(item.id));
    expect(admitted).toContain("evidence:albania:0");
    expect(admitted).not.toContain("evidence:albania:9");
  });
});

function span(id: string, charStart: number, text: string): EvidenceSpan {
  return {
    id: id as EvidenceId,
    sourceVersionId: "source_version:albania" as SourceVersionId,
    text,
    textPreview: text,
    charStart,
    charEnd: charStart + text.length,
    status: "promoted",
    alpha: 0.9,
    provenance: { uri: "wikipedia://enwiki/pages/738/Albania", title: "Albania", sourceVersionId: "source_version:albania", charRange: [charStart, charStart + text.length], metadata: { title: "Albania" } }
  } as unknown as EvidenceSpan;
}
