// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
import { describe, expect, it } from "vitest";
import { createClock, createHasher } from "../primitives.js";
import { createIdFactory } from "../ids.js";
import { createTypedIngestProjector, graphFromStructuredSemanticCandidates } from "../typed-ingest.js";
import { compileRelationPromotionModel, relationPromotionCanScore } from "../relation-promotion.js";
import type { EvidenceSpan } from "../types.js";

const hasher = createHasher();
const ids = createIdFactory({ clock: createClock({ fixedTime: 1 }), hasher, deterministicReplay: true });

function fixture() {
  const text = "city,population\nHarbor,42\nRidge,17";
  const sourceId = ids.sourceId("local_corpus", "fixture://cities.csv");
  const sourceVersionId = ids.sourceVersionId(text);
  const contentHash = ids.contentHash(text);
  const byteEnd = Buffer.byteLength(text);
  const evidence: EvidenceSpan = {
    id: ids.evidenceId({ sourceVersionId, byteStart: 0, byteEnd, spanHash: contentHash }),
    sourceId, sourceVersionId, contentHash,
    chunkId: ids.chunkId({ sourceVersionId, byteStart: 0, byteEnd, chunkHash: contentHash }),
    mediaType: "text/csv", byteStart: 0, byteEnd, charStart: 0, charEnd: [...text].length,
    text, textPreview: text, features: [], languageHints: {}, scriptHints: {}, trustVector: {},
    provenance: { sourceFamilyId: "owner.single-document" }, alpha: 1, status: "promoted", observedAt: 1
  };
  const projection = createTypedIngestProjector({ idFactory: ids, hasher }).project({ sourceId, sourceVersionId, uri: "fixture://cities.csv", mediaType: "text/csv", text, metadata: {}, evidence: [evidence], observedAt: 1 });
  const candidate = projection.semanticCandidates.find(row => row.kind === "table_cell")!;
  expect(candidate).toBeDefined();
  return { projection, candidate, evidence };
}

describe("source-owned observation admission", () => {
  it("scores reusable relations when fit and heldout partitions can exist without a four-source quota", () => {
    expect(relationPromotionCanScore(1)).toBe(false);
    expect(relationPromotionCanScore(2)).toBe(true);
    expect(relationPromotionCanScore(3)).toBe(true);
  });
  it("retains a one-document typed observation without claiming reusable relation promotion", () => {
    const { projection, candidate } = fixture();
    const promotion = compileRelationPromotionModel({ candidates: projection.semanticCandidates });
    expect(promotion.decisions.every(decision => !decision.promoted)).toBe(true);
    const binding = projection.graphProjectionBindings.find(row => row.candidateId === candidate.id);
    expect(binding?.admission).toBe("source_observation");
    const node = projection.graphNodes.find(row => String(row.id) === binding?.relationNodeId);
    expect(node?.metadata).toMatchObject({ admissionState: "source_observed", promoted: false });
    expect(projection.graphHyperedges.some(row => String(row.id) === binding?.hyperedgeId)).toBe(true);
  });

  it.each(["missing_observation", "missing_evidence", "wrong_version", "changed_bytes", "changed_value", "changed_identity", "changed_time", "unlicensed_assumption"])("rejects a direct candidate with %s", fault => {
    const { projection, candidate, evidence } = fixture();
    const proposal = structuredClone(candidate);
    const span = structuredClone(evidence);
    if (fault === "wrong_version") span.sourceVersionId = ids.sourceVersionId("other-version");
    if (fault === "changed_bytes") span.text += " forged";
    if (fault === "changed_value") proposal.participants[0]!.value = "forged-value";
    if (fault === "changed_identity") proposal.provenance.participantIdentityIds[0] = "forged-identity";
    if (fault === "changed_time") proposal.temporalCoordinates = { ...proposal.temporalCoordinates, observedTime: 999 };
    if (fault === "unlicensed_assumption") proposal.provenance.assumptions.push("invented");
    const graph = graphFromStructuredSemanticCandidates({ candidates: [proposal], observations: fault === "missing_observation" ? [] : projection.observations, evidence: fault === "missing_evidence" ? [] : [span], ids, hasher, observedAt: 1 });
    expect(graph.hyperedges).toEqual([]);
  });

  it("does not let a forged duplicate reuse a valid candidate identity", () => {
    const { projection, candidate, evidence } = fixture();
    const forged = structuredClone(candidate);
    forged.participants[0]!.value = "forged-value";
    const graph = graphFromStructuredSemanticCandidates({ candidates: [candidate, forged], observations: projection.observations, evidence: [evidence], ids, hasher, observedAt: 1 });
    expect(graph.hyperedges).toHaveLength(1);
    expect(graph.bindings).toHaveLength(1);
  });
});
