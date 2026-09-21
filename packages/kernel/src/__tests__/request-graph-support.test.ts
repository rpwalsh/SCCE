// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
import { describe, expect, it } from "vitest";
import { requestOperatorGraphSupport, summarizeRequestGraphSupport } from "../request-authority.js";
import { COGNITIVE_OPERATOR_IDS } from "../turn-requirements.js";
import { projectTypedIncidencesForActivation } from "../typed-incidence-graph.js";
import type { EvidenceSpan, FieldState, GraphSlice, Hyperedge } from "../types.js";

const evidence = [{ id: "ev", sourceId: "page", sourceVersionId: "revision", provenance: { sourceFamilyId: "wikimedia:wikipedia" } }] as unknown as EvidenceSpan[];
const field = { causalMass: [] } as unknown as FieldState;
const relation = (id: string, members: string[], timed = false): Hyperedge => ({
  schema: "scce.hyperedge.v2", id, relationId: `relation.${id}`,
  participantPorts: members.map((nodeId, index) => ({ portId: `port.${index}`, roleId: `role.${index}`, nodeId,
    valueKind: "fixture", realization: "observed", evidenceIds: ["ev"] })),
  memberNodeIds: members, qualifiers: {}, modality: {}, evidenceIds: ["ev"], weightVector: { alpha: 1 },
  temporalScope: timed ? { status: "known", validFrom: 1_000 } : { status: "unknown", uncertainty: 1 },
  provenanceRefs: ["ev"], createdAt: 1_700_000_000_000, updatedAt: 1_700_000_000_000
} as unknown as Hyperedge);
const slice = (hyperedges: Hyperedge[]): GraphSlice => ({ nodes: [], edges: [], hyperedges, bounded: true, query: {} });

describe("graph structure returned to operator selection", () => {
  it("uses evidenced hyperedges and open-ended validity without multiplying incidence projections", () => {
    const graph = slice([relation("first", ["a", "b"], true), relation("second", ["b", "c"])]);
    const support = requestOperatorGraphSupport({ graph, evidence, field });
    expect(support[COGNITIVE_OPERATOR_IDS.graphPropagation]).toBeGreaterThan(0);
    expect(support[COGNITIVE_OPERATOR_IDS.temporalAnalysis]).toBeGreaterThan(0);
    expect(support[COGNITIVE_OPERATOR_IDS.relationComposition]).toBeGreaterThan(0);
    const projection = projectTypedIncidencesForActivation(graph);
    const projected = { ...graph, nodes: projection.nodes, edges: projection.edges };
    expect(requestOperatorGraphSupport({ graph: projected, evidence, field })).toEqual(support);
    expect(summarizeRequestGraphSupport(projected, evidence).graphObjectIds).toEqual(["first", "second"]);
  });

  it("does not treat disconnected relations or duplicate witnesses as a compositional path", () => {
    for (const graph of [slice([relation("a", ["x", "y"]), relation("b", ["z", "w"])]),
      slice([relation("a", ["x", "y"]), relation("copy", ["x", "y"])])]) {
      expect(requestOperatorGraphSupport({ graph, evidence, field })[COGNITIVE_OPERATOR_IDS.relationComposition]).toBe(0);
    }
  });

  it("counts independent source families instead of revisions and derivatives", () => {
    const copies = Array.from({ length: 10 }, (_, i) => ({ ...evidence[0]!, id: `ev.${i}`, sourceVersionId: `revision.${i}` })) as EvidenceSpan[];
    const graph = slice([]);
    expect(requestOperatorGraphSupport({ graph, evidence: copies, field })[COGNITIVE_OPERATOR_IDS.sourceSynthesis]).toBe(0);
    copies[1] = { ...copies[1]!, provenance: { sourceFamilyId: "independent:source" } };
    expect(requestOperatorGraphSupport({ graph, evidence: copies, field })[COGNITIVE_OPERATOR_IDS.sourceSynthesis]).toBeGreaterThan(0);
  });

  it("ignores graph objects whose evidence was not admitted and never uses observation time as validity", () => {
    const graph = slice([relation("unproven", ["x", "y"], true)]);
    expect(summarizeRequestGraphSupport(graph, []).graphObjectIds).toEqual([]);
    const unknown = slice([relation("unknown", ["a", "b"])]);
    expect(requestOperatorGraphSupport({ graph: unknown, evidence, field })[COGNITIVE_OPERATOR_IDS.temporalAnalysis]).toBe(0);
    expect(summarizeRequestGraphSupport(unknown, evidence).temporalObjectIds).toEqual([]);
  });

  it("preserves observed port evidence and separates direct evidence from graph-linked support", () => {
    const portOnly = { ...relation("ports", ["a", "b"], true), evidenceIds: [] };
    const extra = { ...evidence[0]!, id: "unconnected" as EvidenceSpan["id"], sourceId: "another-source" as EvidenceSpan["sourceId"], provenance: { sourceFamilyId: "unconnected-family" } };
    const summary = summarizeRequestGraphSupport(slice([portOnly]), [...evidence, extra]);
    expect(summary.graphObjectIds).toEqual(["ports"]);
    expect(summary.graphEvidenceIds).toEqual(["ev"]);
    expect(summary.graphSourceFamilyIds).toEqual(["wikimedia:wikipedia"]);
    expect(summary.evidenceIds).toContain("unconnected");
    const empty = summarizeRequestGraphSupport(slice([]), evidence);
    expect(empty.graphEvidenceIds).toEqual([]);
    expect(empty.evidenceIds).toEqual(["ev"]);
  });
});
