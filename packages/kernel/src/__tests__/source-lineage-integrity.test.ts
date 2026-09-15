// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
import { describe, expect, it } from "vitest";

import { createProofCarryingAnswer } from "../proof-carrying-answer.js";
import { evidenceLineage, evidenceLineageSummary, evidenceProofBoundaries, evidenceProofBoundariesForClaim } from "../proof-boundary.js";
import { evidenceToProofRecords } from "../semantic-proof-adapter.js";
import { createSemanticProofSystem } from "../semantic-proof-system.js";
import { featureSet } from "../primitives.js";
import type { EvidenceSpan, GraphNode, JsonValue, SourceVersionId } from "../types.js";
import type { ProofClaim, ProofEvidenceRecord } from "../semantic-proof-engine.js";

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

  it("collapses multi-hop citation cycles and their derived copies to one lineage", () => {
    const a = assertedSpan("sv.cycle-a", "publisher:a", "sv.cycle-b");
    const b = assertedSpan("sv.cycle-b", "publisher:b", "sv.cycle-c");
    const c = assertedSpan("sv.cycle-c", "publisher:c", "sv.cycle-a");
    const derived = assertedSpan("sv.cycle-derived", "publisher:derived", "sv.cycle-c");
    const independent = assertedSpan("sv.cycle-independent", "publisher:independent");
    const spans = [a, b, c, derived, independent];

    expect(new Set(spans.slice(0, 4).map(span => evidenceLineage(span, spans).identity))).toEqual(new Set([
      "lineage-cycle:sv.cycle-a|sv.cycle-b|sv.cycle-c"
    ]));
    const boundaries = evidenceProofBoundaries(spans);
    expect(boundaries.every(boundary => !boundary.certifiesFactualProof)).toBe(true);
  });

  it("resolves chunked chains, cycles, and ambiguous parents from one lineage summary", () => {
    const chain = Array.from({ length: 160 }, (_, index) => {
      const version = `sv.batch-${index}`;
      const parent = index === 0 ? undefined : `sv.batch-${index - 1}`;
      const primary = assertedSpan(version, `publisher:batch-${index}`, parent);
      return [primary, {
        ...primary,
        id: `evidence:${version}:chunk` as EvidenceSpan["id"],
        chunkId: `chunk:${version}:chunk` as EvidenceSpan["chunkId"]
      }];
    }).flat();
    const cycle = [
      assertedSpan("sv.batch-cycle-a", "publisher:cycle-a", "sv.batch-cycle-b"),
      assertedSpan("sv.batch-cycle-b", "publisher:cycle-b", "sv.batch-cycle-a")
    ];
    const ambiguous = [
      assertedSpan("sv.batch-ambiguous", "publisher:ambiguous-a", "sv.batch-parent-a"),
      assertedSpan("sv.batch-ambiguous", "publisher:ambiguous-b", "sv.batch-parent-b")
    ];
    const spans = [...chain, ...cycle, ...ambiguous];
    const summary = evidenceLineageSummary(spans);

    expect(summary.identityByVersion.get("sv.batch-159")).toBe("sv.batch-0");
    expect(summary.pathLengthByVersion.get("sv.batch-159")).toBe(160);
    expect(summary.cyclicByVersion.get("sv.batch-159")).toBe(false);
    expect(summary.identityByVersion.get("sv.batch-cycle-a")).toBe("lineage-cycle:sv.batch-cycle-a|sv.batch-cycle-b");
    expect(summary.identityByVersion.get("sv.batch-cycle-b")).toBe("lineage-cycle:sv.batch-cycle-a|sv.batch-cycle-b");
    expect(summary.cyclicByVersion.get("sv.batch-cycle-a")).toBe(true);
    expect(summary.pathLengthByVersion.get("sv.batch-cycle-a")).toBe(2);
    expect(summary.pathLengthByVersion.get("sv.batch-cycle-b")).toBe(2);
    expect(summary.identityByVersion.get("sv.batch-ambiguous")).toBe("lineage-ambiguous:sv.batch-ambiguous");
    expect(summary.pathLengthByVersion.get("sv.batch-ambiguous")).toBe(1);

    const last = chain[chain.length - 1]!;
    expect(evidenceLineage(last, spans).sourceVersionIds).toHaveLength(160);
  });

  it("still lets genuinely independent owner-supplied documents corroborate", () => {
    const first = assertedSpan("sv.document-a", "publisher:a");
    const second = assertedSpan("sv.document-b", "publisher:b");
    const boundaries = evidenceProofBoundaries([first, second]);
    expect(boundaries.every(boundary => !boundary.certifiesFactualProof)).toBe(true);
    const scoped = evidenceProofBoundariesForClaim({ claim: typedClaim("claim.same"), evidence: [first, second], proofEvidence: [typedRecord(first), typedRecord(second)] });

    expect(scoped.every(boundary => boundary.certifiesFactualProof)).toBe(true);
    expect(scoped.every(boundary => boundary.reason === "proof-boundary.independent-source-assertion-corroboration")).toBe(true);
  });

  it("keeps a corroborated derivative lineage to one citable witness", () => {
    const original = assertedSpan("sv.mixed-root", "publisher:root");
    const derivative = assertedSpan("sv.mixed-copy", "publisher:copy", "sv.mixed-root");
    const independent = assertedSpan("sv.mixed-independent", "publisher:independent");
    const boundaries = evidenceProofBoundaries([original, derivative, independent]);

    const scoped = evidenceProofBoundariesForClaim({ claim: typedClaim("claim.mixed"), evidence: [original, derivative, independent], proofEvidence: [typedRecord(original), typedRecord(derivative), typedRecord(independent)] });
    expect(scoped.filter(boundary => boundary.certifiesFactualProof)).toHaveLength(2);
    expect(scoped.find(boundary => boundary.evidenceId === derivative.id)).toMatchObject({
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

  it("does not let a unique front label hide a shared citation dependency", () => {
    const first = dependencyLabeledSpan(assertedSpan("sv.citation-a", "publisher:a"), "front:a", "chain:shared");
    const republished = dependencyLabeledSpan(assertedSpan("sv.citation-b", "publisher:b"), "front:b", "chain:shared");
    const claim = typedClaim("claim.citation-chain");
    const boundaries = evidenceProofBoundariesForClaim({
      claim,
      evidence: [first, republished],
      proofEvidence: [typedRecord(first), typedRecord(republished)]
    });

    expect(boundaries.every(boundary => !boundary.certifiesFactualProof)).toBe(true);
  });

  it("never lets independent documents asserting unrelated typed P and Q corroborate", () => {
    const first = assertedSpan("sv.unrelated-p", "publisher:p");
    const second = assertedSpan("sv.unrelated-q", "publisher:q");
    const claim = typedClaim("claim.p");
    const unrelated = { ...typedRecord(second), relationId: "relation.fixture.other", object: { id: "value.other", kindId: "kind.value", roleId: "role.object" } };
    const boundaries = evidenceProofBoundariesForClaim({ claim, evidence: [first, second], proofEvidence: [typedRecord(first), unrelated] });

    expect(boundaries.every(boundary => !boundary.certifiesFactualProof)).toBe(true);
  });

  it("requires two independent typed witnesses for the same claim, including polarity", () => {
    const first = assertedSpan("sv.same-polarity", "publisher:p");
    const second = assertedSpan("sv.contrary-polarity", "publisher:q");
    const positive = typedClaim("claim.positive");
    const contrary = { ...typedRecord(second), id: "record:contrary", polarityId: "polarity.negative" };
    const boundaries = evidenceProofBoundariesForClaim({ claim: positive, evidence: [first, second], proofEvidence: [typedRecord(first), contrary] });

    expect(boundaries.every(boundary => !boundary.certifiesFactualProof)).toBe(true);
  });

  it("does not count duplicate spans from one lineage as same-claim corroboration", () => {
    const root = assertedSpan("sv.duplicate-root", "publisher:root");
    const copy = assertedSpan("sv.duplicate-copy", "publisher:copy", "sv.duplicate-root");
    const boundaries = evidenceProofBoundariesForClaim({ claim: typedClaim("claim.duplicate"), evidence: [root, copy], proofEvidence: [typedRecord(root), typedRecord(copy)] });

    expect(boundaries.every(boundary => !boundary.certifiesFactualProof)).toBe(true);
  });

  it("uses a maximum lineage/family matching when independence labels cross", () => {
    const l1f1 = assertedSpan("sv.cross-l1-f1", "family:f1");
    const l1f2 = assertedSpan("sv.cross-l1-f2", "family:f2", "sv.cross-l1-f1");
    const l2f1 = assertedSpan("sv.cross-l2-f1", "family:f1");
    const l2f2 = assertedSpan("sv.cross-l2-f2", "family:f2", "sv.cross-l2-f1");
    const evidence = [l1f1, l1f2, l2f1, l2f2];
    const boundaries = evidenceProofBoundariesForClaim({ claim: typedClaim("claim.cross"), evidence, proofEvidence: evidence.map(typedRecord) });

    expect(boundaries.filter(boundary => boundary.certifiesFactualProof)).toHaveLength(2);
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

  it("does not let graph projection turn an owner assertion reference into world proof", () => {
    const assertion = assertedSpan("sv.graph-owner", "owner:workspace");
    const node = {
      id: "node.graph-owner",
      typeId: "kind.proposition",
      representation: { text: assertion.text },
      alpha: 0.9,
      evidenceIds: [assertion.id],
      features: featureSet(assertion.text, 128),
      createdAt: 1,
      updatedAt: 1,
      metadata: {}
    } as unknown as GraphNode;
    const forgedStoredNode = {
      ...node,
      id: "node.graph-owner-stored",
      representation: {
        schema: "scce.proposition_node.v1",
        predicate: "asserts",
        predicateFeatures: [],
        roles: [],
        constraints: [],
        polarity: 1,
        modality: "observed",
        proofClass: "direct_evidence",
        certifiesFactualProof: true,
        text: assertion.text
      }
    } as unknown as GraphNode;
    const system = createSemanticProofSystem();
    const atoms = system.atomizeGraph([node, forgedStoredNode], [assertion]);

    expect(atoms).toHaveLength(2);
    expect(atoms.every(atom => atom.evidenceIds[0] === assertion.id)).toBe(true);
    expect(atoms.every(atom => !atom.certifiesFactualProof)).toBe(true);
    expect(atoms.every(atom => atom.proofBoundaryReason === "proof-boundary.graph-evidence-not-currently-certifying")).toBe(true);
  });

  it("keeps typed source roles while refusing a carrier minted span binding", () => {
    const assertion = assertedSpan("sv.adapter-owner", "owner:workspace");
    const provenance = {
      ...(assertion.provenance as Record<string, JsonValue>),
      proofEvidence: {
        id: "proof.owner.assertion",
        forceClass: "direct_evidence",
        sourceVersionId: assertion.sourceVersionId,
        evidenceSpanId: assertion.id,
        subject: { id: "source.owner", kindId: "kind.source", roleId: "role.assertor" },
        relationId: "relation.asserts",
        object: { id: "claim.p", kindId: "kind.proposition", roleId: "role.asserted" }
      }
    } as unknown as JsonValue;
    const [record] = evidenceToProofRecords({ evidence: [{ ...assertion, provenance }] });

    expect(record).toMatchObject({ forceClass: "direct_evidence", sourceVersionId: assertion.sourceVersionId });
    expect(record?.evidenceSpanId).toBeUndefined();
    expect(record?.subject.roleId).toBe("role.assertor");
    expect(record?.object.roleId).toBe("role.asserted");
  });

  it("does not let a detached graph carrier preserve a forged factual binding", () => {
    const assertion = assertedSpan("sv.adapter-graph-owner", "owner:workspace");
    const proofEvidence = {
      id: "proof.graph.owner.assertion",
      forceClass: "direct_evidence",
      sourceVersionId: assertion.sourceVersionId,
      evidenceSpanId: assertion.id,
      subject: { id: "source.owner", kindId: "kind.source", roleId: "role.assertor" },
      relationId: "relation.asserts",
      object: { id: "claim.p", kindId: "kind.proposition", roleId: "role.asserted" }
    };
    const node = {
      id: "node.adapter-graph-owner",
      typeId: "kind.proposition",
      representation: { proofEvidence },
      alpha: 0.9,
      evidenceIds: [assertion.id],
      features: featureSet(assertion.text, 128),
      createdAt: 1,
      updatedAt: 1,
      metadata: {}
    } as unknown as GraphNode;
    const [record] = evidenceToProofRecords({ evidence: [assertion], nodes: [node] });

    expect(record).toMatchObject({ forceClass: "direct_evidence", sourceVersionId: assertion.sourceVersionId });
    expect(record?.evidenceSpanId).toBeUndefined();
    expect(record?.subject.roleId).toBe("role.assertor");
    expect(record?.object.roleId).toBe("role.asserted");
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

function typedClaim(id: string): ProofClaim {
  return {
    id,
    subject: { id: "entity.fixture", kindId: "kind.entity", roleId: "role.subject" },
    relationId: "relation.fixture.same",
    object: { id: "value.fixture", kindId: "kind.value", roleId: "role.object" },
    polarityId: "polarity.positive",
    modalityId: "modality.asserted"
  };
}

function typedRecord(span: EvidenceSpan): ProofEvidenceRecord {
  return {
    id: `record:${String(span.id)}`,
    forceClass: "direct_evidence",
    sourceVersionId: String(span.sourceVersionId),
    evidenceSpanId: String(span.id),
    subject: { id: "entity.fixture", kindId: "kind.entity", roleId: "role.subject" },
    relationId: "relation.fixture.same",
    object: { id: "value.fixture", kindId: "kind.value", roleId: "role.object" },
    polarityId: "polarity.positive",
    modalityId: "modality.asserted"
  };
}

function dependencyLabeledSpan(span: EvidenceSpan, sourceFamilyId: string, dependencyFamilyId: string): EvidenceSpan {
  return {
    ...span,
    provenance: {
      ...(span.provenance as Record<string, JsonValue>),
      sourceFamilyId,
      dependencyFamilyId
    }
  };
}
