// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
import { describe, expect, it } from "vitest";
import { featureSet } from "../primitives.js";
import { localEvidenceAnswerClaimSurface, proposeSourceExactEvidenceAnswer } from "../local-evidence-runtime.js";
import type { ContentHash, EvidenceId, EvidenceSpan, SourceId, SourceVersionId } from "../types.js";

function evidenceSpan(input: { id: string; title: string; text: string }): EvidenceSpan {
  const sourceVersionId = `source:${input.id}:v1` as SourceVersionId;
  const uri = `fixture://wiki/${input.id}`;
  return {
    id: input.id as EvidenceId,
    sourceId: `source:${input.id}` as SourceId,
    sourceVersionId,
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
    trustVector: { trust: 0.94, sourceTrust: 0.94, structuralConfidence: 0.94, forceClass: "direct_evidence" },
    provenance: { namespace: "local", source: "typed-quantity-candidate-test", title: input.title, uri, canonicalUri: uri, sourceVersionId, byteRange: [0, input.text.length], charRange: [0, input.text.length] },
    features: featureSet(input.text, 256),
    status: "promoted",
    alpha: 0.97,
    observedAt: 1000
  };
}

describe("typed quantity propagation into candidate generation", () => {
  const lead = "Mount Everest is the highest mountain above sea level, located in the Mahalangur Himal sub-range of the Himalayas.";
  // Names the unit and carries more of the request's words, but measures nothing: no compiled quantity constraint.
  const unitless = "Surveys have quoted how tall the mountain is in metres and in feet since the nineteenth century.";
  // Carries a quantity constraint whose unit matches the request's; the number is formatted differently from the request.
  const typed = "The elevation of 8848 metres was established by the 1955 survey of India.";
  const source = evidenceSpan({
    id: "everest-typed-quantity",
    title: "Mount Everest",
    text: `${lead} ${unitless} ${typed} The summit lies on the border between Nepal and China.`
  });

  it("a unitless candidate loses to one whose compiled proposition carries the request's unit", () => {
    const proposal = proposeSourceExactEvidenceAnswer({
      requestText: "Is Mount Everest 8,848 metres tall?",
      selectedEvidence: [source]
    });
    expect(proposal).toBeDefined();
    expect(localEvidenceAnswerClaimSurface(proposal!)).toContain("8848 metres");
  });

  it("a request without a quantity leaves the existing ordering untouched", () => {
    const proposal = proposeSourceExactEvidenceAnswer({
      requestText: "What is Mount Everest?",
      selectedEvidence: [source]
    });
    expect(proposal).toBeDefined();
    expect(localEvidenceAnswerClaimSurface(proposal!)).toContain("highest mountain");
  });

  it("a number whose following word is not request content does not become a unit requirement", () => {
    const apollo = evidenceSpan({
      id: "apollo-11-number-control",
      title: "Apollo 11",
      text: "Apollo 11 was the American spaceflight that first landed humans on the Moon. Neil Armstrong commanded Apollo 11. The mission launched Apollo 11 in July 1969 from Kennedy Space Center."
    });
    const proposal = proposeSourceExactEvidenceAnswer({
      requestText: "Who commanded Apollo 11?",
      selectedEvidence: [apollo]
    });
    expect(proposal).toBeDefined();
    expect(localEvidenceAnswerClaimSurface(proposal!)).toContain("Neil Armstrong commanded");
  });
});
