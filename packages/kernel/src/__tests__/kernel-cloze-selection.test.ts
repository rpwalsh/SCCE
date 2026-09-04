// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
import { describe, expect, it } from "vitest";
import { featureSet, type ContentHash, type EvidenceId, type EvidenceSpan, type SourceId, type SourceVersionId } from "../index.js";
import { sourceAnchoredEvidenceForRequest, sourceIdentityAdmissibleEvidenceForRequest } from "../local-evidence-runtime.js";

const CLOZE_PROMPT = "She became fascinated with the machine and used her relationship with ____ to visit Babbage as often as she could.";

const GOLD_TEXT = "Later that month, Babbage invited Lovelace to see the prototype for his difference engine. "
  + "She became fascinated with the machine and used her relationship with Somerville to visit Babbage as often as she could. "
  + "Babbage was impressed by Lovelace's intellect and analytic skills.";

// Ordinary prose sharing a couple of the request's words, but not the sentence.
const DECOY_TEXT = "Schopenhauer became fascinated with philosophy early in life. "
  + "His relationship with Hegel was hostile, and he could often be found lecturing to an empty room as a result.";

function span(input: { id: string; title: string; text: string }): EvidenceSpan {
  const contentHash = `hash:${input.id}` as ContentHash;
  const sourceVersionId = `source:${input.id}:v1` as SourceVersionId;
  return {
    id: input.id as EvidenceId,
    sourceId: `source:${input.id}` as SourceId,
    sourceVersionId,
    chunkId: `chunk:${input.id}` as EvidenceSpan["chunkId"],
    contentHash,
    mediaType: "text/plain",
    byteStart: 0,
    byteEnd: input.text.length,
    charStart: 0,
    charEnd: input.text.length,
    text: input.text,
    textPreview: input.text,
    languageHints: { language: "fixture" },
    scriptHints: { script: "Latn" },
    trustVector: { trust: 0.94, sourceTrust: 0.94, structuralConfidence: 0.94, forceClass: "direct_evidence" },
    provenance: { namespace: "local", source: "kernel-cloze-selection-test", title: input.title, uri: `fixture://wiki/${input.id}`, canonicalUri: `fixture://wiki/${input.id}`, sourceVersionId, byteRange: [0, input.text.length], charRange: [0, input.text.length] },
    features: featureSet(input.text, 256),
    status: "promoted",
    alpha: 0.9,
    observedAt: 6000
  } as EvidenceSpan;
}

describe("cloze near-duplicate selection", () => {
  const gold = span({ id: "evidence:ada-fascinated", title: "Ada Lovelace", text: GOLD_TEXT });
  const decoy = span({ id: "evidence:schopenhauer", title: "Arthur Schopenhauer", text: DECOY_TEXT });

  it("prefers the span whose sentence the request near-duplicates over wrong-topic word matches", () => {
    const anchored = sourceAnchoredEvidenceForRequest(CLOZE_PROMPT, [decoy, gold]);
    expect(anchored.required).toBe(true);
    expect(anchored.evidence.map(s => String(s.id))).toEqual([String(gold.id)]);
  });

  it("does not admit a wrong-topic title through a lowercase word read as an initialism ('as' is not 'A.S.')", () => {
    // "...visit Babbage as often..." must not admit Arthur Schopenhauer.
    const admitted = sourceIdentityAdmissibleEvidenceForRequest(CLOZE_PROMPT, [decoy], new Set());
    expect(admitted.evidence).toEqual([]);
  });

  it("ignores a request echo: a session span restating the request is not a source", () => {
    const echo = span({ id: "evidence_session_echo", title: "", text: CLOZE_PROMPT });
    const anchored = sourceAnchoredEvidenceForRequest(CLOZE_PROMPT, [echo, gold]);
    expect(anchored.evidence.map(s => String(s.id))).toEqual([String(gold.id)]);
  });

  it("keeps question-shaped requests off the near-duplicate path even when they quote a long title", () => {
    const lead = span({
      id: "evidence:ds9-lead",
      title: "Star Trek: Deep Space Nine",
      text: "'Star Trek: Deep Space Nine' is an American science-fiction television series. Avery Brooks stars as Benjamin Sisko, the commander of the station."
    });
    const anchored = sourceAnchoredEvidenceForRequest("Who played Benjamin Sisko in 'Star Trek: Deep Space Nine'?", [lead]);
    // The span may be admitted through the normal anchor path, but the
    // near-duplicate route must not have hijacked selection: the title
    // words alone must not count as a duplicated sentence.
    expect(anchored.required).toBe(true);
    expect(anchored.evidence.length).toBeGreaterThan(0);
  });
});
