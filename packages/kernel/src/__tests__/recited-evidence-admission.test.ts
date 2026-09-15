// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
import { describe, expect, it } from "vitest";
import { recitedEvidenceAdmissibility } from "../production-turn-runtime.js";
import { structuralResidueScore } from "../structural-residue.js";
import { isUnparsedMarkupText } from "../local-evidence-runtime.js";
import type { ContentHash, EvidenceId, EvidenceSpan, SourceId, SourceVersionId } from "../index.js";

// Verbatim from the 2026-09-13 chat probe: the surface mouth.contradiction_fallback spoke on all five turns.
const ABBA_REFERENCE_ENTRY =
  "-essential-influential-melancholy ABBA's Essential, Influential Melancholy]. NPR, 23 May 2015 * "
  + "[https://www.smithsonianmag.com/arts-culture/whats-behind-abbas-staying-power-180969709/ "
  + "What's Behind ABBA's Staying Power?";

const ABBA_PROSE =
  "ABBA were a Swedish pop group formed in Stockholm in 1972, and they became one of the most commercially "
  + "successful acts in the history of popular music.";

const APOLLO_PROSE =
  "Apollo 11 was the American spaceflight that first landed humans on the Moon, on 20 July 1969, with Neil "
  + "Armstrong and Buzz Aldrin landing the module Eagle.";

function span(input: { id: string; title: string; text: string }): EvidenceSpan {
  return {
    id: input.id as EvidenceId,
    sourceId: `source:${input.id}` as SourceId,
    sourceVersionId: `source_version:${input.id}` as SourceVersionId,
    chunkId: `chunk:${input.id}` as EvidenceSpan["chunkId"],
    contentHash: `hash:${input.id}` as ContentHash,
    mediaType: "text/plain",
    byteStart: 0,
    byteEnd: input.text.length,
    charStart: 0,
    charEnd: input.text.length,
    text: input.text,
    textPreview: input.text,
    languageHints: { language: "fixture" },
    scriptHints: { script: "Latn" },
    trustVector: { trust: 0.9, sourceTrust: 0.9, structuralConfidence: 0.9, forceClass: "direct_evidence" },
    provenance: { namespace: "local", source: "recited-evidence-admission-test", title: input.title, uri: `https://example.invalid/${input.id}` },
    features: [],
    status: "promoted",
    alpha: 0.8,
    observedAt: 1000
  } as EvidenceSpan;
}

const referenceSpan = span({ id: "evidence.abba.references", title: "ABBA", text: ABBA_REFERENCE_ENTRY });
const proseSpan = span({ id: "evidence.abba.lead", title: "ABBA", text: ABBA_PROSE });
const apolloSpan = span({ id: "evidence.apollo", title: "Apollo 11", text: APOLLO_PROSE });

describe("recited evidence admission", () => {
  it("refuses a reference-list entry for a request that shares no content with it", () => {
    // Neither existing gate sees it: no markup literal, and one reference line repeats no bigram so the residue
    // score is exactly 0. What refuses it is the coverage the primary path requires.
    expect(isUnparsedMarkupText(ABBA_REFERENCE_ENTRY)).toBe(false);
    expect(structuralResidueScore(ABBA_REFERENCE_ENTRY)).toBe(0);
    expect(recitedEvidenceAdmissibility({ surface: ABBA_REFERENCE_ENTRY, span: referenceSpan, requestText: "whats up" })).toBe("uncovered");
  });

  it("still admits a prose sentence about the source the request asks about", () => {
    expect(recitedEvidenceAdmissibility({ surface: ABBA_PROSE, span: proseSpan, requestText: "what is ABBA known for in popular music?" })).toBe("admissible");
  });

  it("still admits ordinary prose evidence that contradicts the request's premise", () => {
    // The case this fallback exists for: the false premise ("Mars") is absent from the evidence by construction.
    expect(recitedEvidenceAdmissibility({ surface: APOLLO_PROSE, span: apolloSpan, requestText: "Why did Apollo 11 land on Mars?" })).toBe("admissible");
  });

  it("refuses apparatus and unparsed markup ahead of coverage", () => {
    const table = "[\"CITEREFMasten2003\"] = 1, [\"CITEREFMcMahonNelmes2006\"] = 1, [\"CITEREFMcQuaid1994\"] = 1,";
    const tableSpan = span({ id: "evidence.tungsten", title: "Tungsten", text: table });
    expect(recitedEvidenceAdmissibility({ surface: table, span: tableSpan, requestText: "What is the boiling point of tungsten?" })).toBe("apparatus");
    const markup = "{{Infobox element | symbol = W | boiling point == 5930 }}";
    const markupSpan = span({ id: "evidence.markup", title: "Tungsten", text: markup });
    expect(recitedEvidenceAdmissibility({ surface: markup, span: markupSpan, requestText: "What is the boiling point of tungsten?" })).toBe("markup");
  });
});
