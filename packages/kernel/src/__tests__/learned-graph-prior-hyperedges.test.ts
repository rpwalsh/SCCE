// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
import { describe, expect, it } from "vitest";
import { structuredHyperedgeEdges } from "../learned-graph-prior-runtime.js";
import type { GraphNode, Hyperedge } from "../types.js";

function node(id: string, representation: string): GraphNode {
  return { id: id as GraphNode["id"], typeId: "dimension.fixture" as GraphNode["typeId"], representation, alpha: 0.8, evidenceIds: [], features: [], createdAt: 1, updatedAt: 1, metadata: {} };
}

function hyperedge(id: string, modality: Record<string, string | boolean>, nodeIds: string[]): Hyperedge {
  return {
    schema: "scce.hyperedge.v2",
    id: id as Hyperedge["id"],
    relationId: "relation.fixture" as Hyperedge["relationId"],
    participantPorts: nodeIds.map((nodeId, index) => ({ portId: `port.${index}`, roleId: `role.${index}`, nodeId: nodeId as GraphNode["id"], valueKind: "surface", realization: "observed", evidenceIds: ["evidence.1"] as Hyperedge["evidenceIds"] })),
    memberNodeIds: nodeIds as GraphNode["id"][],
    qualifiers: {},
    modality,
    evidenceIds: ["evidence.1"] as Hyperedge["evidenceIds"],
    weightVector: { alpha: 0.7 },
    temporalScope: {},
    provenanceRefs: ["evidence.1"],
    createdAt: 1,
    updatedAt: 1
  };
}

describe("structured hyperedges as answer facts", () => {
  const nodes = new Map([["n.ada", node("n.ada", "Ada Lovelace")], ["n.target", node("n.target", "Ada Lovelace")], ["n.chunk", node("n.chunk", "chunk")]]);

  it("turns a promoted structured relation into one fact per further participant, keyed on the hyperedge relation", () => {
    const edges = structuredHyperedgeEdges([hyperedge("h.link", { extractionChannel: "source_declared_structured", candidateKind: "link" }, ["n.ada", "n.target"])], nodes);
    expect(edges).toHaveLength(1);
    expect(edges[0]).toMatchObject({ source: "n.ada", target: "n.target", relationId: "relation.fixture", alpha: 0.7, evidenceIds: ["evidence.1"] });
    expect(JSON.stringify(edges[0]!.metadata)).toContain("\"predicate\":\"link\"");
  });

  it("ignores chunk feature bags and relations whose participants are not in the slice", () => {
    expect(structuredHyperedgeEdges([hyperedge("h.bag", { sourceObserved: true }, ["n.chunk", "n.ada"])], nodes)).toEqual([]);
    expect(structuredHyperedgeEdges([hyperedge("h.missing", { extractionChannel: "anchor_derived" }, ["n.ada", "n.absent"])], nodes)).toEqual([]);
  });
});
