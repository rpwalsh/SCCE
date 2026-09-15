import { describe, expect, it } from "vitest";

import { createProofCarryingAnswer } from "../proof-carrying-answer.js";
import { evidenceLineage, evidenceProofBoundaries } from "../proof-boundary.js";
import { featureSet } from "../primitives.js";
import type { EvidenceSpan, SourceVersionId } from "../types.js";

describe("source-authority lineage at the proof boundary", () => {
  it("collapses a chain of derived copies into one truth witness", () => {
    const root = assertedSpan("sv.root", "publisher:root");
    const copy = assertedSpan("sv.copy", "publisher:copy", "sv.root");
    const repackaged = assertedSpan("sv.repackaged", "publisher:repackaged", "sv.copy");
    const spans = [root, copy, repackaged];

    expect(spans.map(span => evidenceLineage(span, spans).identity)).toEqual([
      "sv.root",
      "sv.root",
      "sv.root"
    ]);
    expect(evidenceProofBoundaries(spans).every(boundary => !boundary.certifiesFactualProof)).toBe(true);
  });

  it("collapses cyclic ancestry instead of allowing the cycle to self-corroborate", () => {
    const left = assertedSpan("sv.left", "publisher:left", "sv.right");
    const right = assertedSpan("sv.right", "publisher:right", "sv.left");
    const spans = [left, right];
    const leftLineage = evidenceLineage(left, spans);
    const rightLineage = evidenceLineage(right, spans);

    expect(leftLineage.cyclic).toBe(true);
    expect(rightLineage.cyclic).toBe(true);
    expect(leftLineage.identity).toBe(rightLineage.identity);
    expect(evidenceProofBoundaries(spans).every(boundary => !boundary.certifiesFactualProof)).toBe(true);
  });

  it("still lets genuinely independent owner-supplied documents corroborate", () => {
    const first = assertedSpan("sv.document-a", "publisher:a");
    const second = assertedSpan("sv.document-b", "publisher:b");
    const boundaries = evidenceProofBoundaries([first, second]);

    expect(boundaries.every(boundary => boundary.certifiesFactualProof)).toBe(true);
    expect(boundaries.every(boundary => boundary.reason === "proof-boundary.independent-source-assertion-corroboration")).toBe(true);
  });

  it("keeps a corroborated derivative lineage to one citable witness", () => {
    const original = assertedSpan("sv.mixed-root", "publisher:root");
    const derivative = assertedSpan("sv.mixed-copy", "publisher:copy", "sv.mixed-root");
    const independent = assertedSpan("sv.mixed-independent", "publisher:independent");
    const boundaries = evidenceProofBoundaries([original, derivative, independent]);

    expect(boundaries.filter(boundary => boundary.certifiesFactualProof)).toHaveLength(2);
    expect(boundaries.find(boundary => boundary.evidenceId === derivative.id)).toMatchObject({
      certifiesFactualProof: false,
      reason: "proof-boundary.dependent-source-assertion"
    });
  });

  it("does not let a derivative relabel manufacture an independent family", () => {
    const original = assertedSpan("sv.match-root", "publisher:shared");
    const relabeled = assertedSpan("sv.match-copy", "publisher:derived", "sv.match-root");
    const independent = assertedSpan("sv.match-independent", "publisher:shared");
    const boundaries = evidenceProofBoundaries([original, relabeled, independent]);
    expect(boundaries.every(boundary => !boundary.certifiesFactualProof)).toBe(true);
  });

  it("keeps one source assertion qualified rather than turning it into unqualified P", () => {
    const assertion = assertedSpan("sv.single", "publisher:single");
    const boundary = evidenceProofBoundaries([assertion])[0];

    expect(boundary?.certifiesFactualProof).toBe(false);
    expect(boundary?.reason).toBe("proof-boundary.source-assertion-not-promoted");
  });

  it("does not let PCA launder one source assertion into a direct quote", () => {
    const assertion = assertedSpan("sv.pca-single", "publisher:pca-single");
    const report = createProofCarryingAnswer().certify({
      answer: assertion.text,
      evidence: [assertion],
      force: "observed"
    });

    expect(report.admitted).toHaveLength(0);
    expect(report.certificates[0]?.kind).toBe("rejected");
    expect(report.audit).toMatchObject({
      excludedEvidence: [{ evidenceId: assertion.id, reason: "proof-boundary.source-assertion-not-promoted" }]
    });
  });
});

function assertedSpan(version: string, independenceGroup: string, parent?: string): EvidenceSpan {
  const text = "The documentary source asserts the same proposition for this fixture.";
  const byteLength = Buffer.byteLength(text, "utf8");
  const derivation = parent
    ? {
        kind: "extracted-text" as const,
        transformId: "fixture.derivation",
        derivedFromSourceVersionId: parent as SourceVersionId,
        originalCoordinateSpace: "extracted-text-utf8" as const,
        redactionMap: []
      }
    : undefined;
  return {
    id: `evidence:${version}` as EvidenceSpan["id"],
    sourceId: `source:${version}` as EvidenceSpan["sourceId"],
    sourceVersionId: version as SourceVersionId,
    chunkId: `chunk:${version}` as EvidenceSpan["chunkId"],
    contentHash: `hash:${version}` as EvidenceSpan["contentHash"],
    mediaType: "text/plain",
    byteStart: 0,
    byteEnd: byteLength,
    charStart: 0,
    charEnd: [...text].length,
    text,
    textPreview: text,
    languageHints: {},
    scriptHints: {},
    trustVector: {
      sourceTrust: {
        identity: 0.95,
        integrity: 0.95,
        parserReliability: 0.95,
        directness: 0.95,
        authority: 0.95,
        freshness: 0.95,
        independenceGroup,
        accessScope: "owner_private",
        licenseStatus: "owner_authorized"
      }
    },
    provenance: {
      provenanceClass: "direct_evidence",
      epistemicState: "asserted",
      uri: `fixture://${version}`,
      sourceVersionId: version,
      byteRange: [0, byteLength],
      charRange: [0, [...text].length],
      ...(derivation ? { sourceVersionDerivation: derivation } : {})
    },
    features: featureSet(text, 128),
    status: "promoted",
    alpha: 0.9,
    observedAt: 1
  };
}
