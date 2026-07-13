import { describe, expect, it } from "vitest";
import { solveGreenPotentialField } from "../green-potential.js";
import type { AlphaTrace, DimensionId, EdgeId, EvidenceId, GraphEdge, GraphNode, NodeId, RelationId } from "../types.js";

describe("green potential field", () => {
  it("solves bounded support and contradiction potentials with evidence influence", () => {
    const nodes: GraphNode[] = [
      node("n:query", ["sym:query"], 0.9, ["ev:query"]),
      node("n:claim", ["sym:claim"], 0.7, ["ev:claim"]),
      node("n:remote", ["sym:remote"], 0.2, [])
    ];
    const edges: GraphEdge[] = [
      edge("e:qc", "n:query", "n:claim", 0.9, 0.8, ["ev:claim"]),
      edge("e:cr", "n:claim", "n:remote", 0.2, 0.3, [])
    ];
    const result = solveGreenPotentialField({
      nodes,
      edges,
      requestFeatures: ["sym:query", "sym:claim"],
      seeds: [{ nodeId: nodeId("n:query"), weight: 1, feature: "sym:query" }],
      activeNodeIds: ["n:query", "n:claim"],
      ppf: [{ nodeId: nodeId("n:query"), mass: 0.8 }, { nodeId: nodeId("n:claim"), mass: 0.5 }],
      alphaTrace: alphaTrace()
    });

    expect(result.schema).toBe("scce.green_potential_field.v1");
    expect(result.nodeCount).toBeGreaterThanOrEqual(2);
    expect(result.answerabilityPotential).toBeGreaterThan(0);
    expect(result.contradictionPotential).toBeGreaterThan(0);
    expect(result.evidenceInfluence.some(row => row.evidenceId === "ev:claim" && row.influence > 0)).toBe(true);
    expect(result.topNodes[0]?.nodeId).toMatch(/^n:/u);
  });
});

function node(id: string, features: string[], alpha: number, evidenceIds: string[]): GraphNode {
  return {
    id: nodeId(id),
    typeId: dimensionId("dim:test"),
    representation: { label: id },
    alpha,
    evidenceIds: evidenceIds.map(evidenceId),
    features,
    createdAt: 0,
    updatedAt: 0,
    metadata: {}
  };
}

function edge(id: string, source: string, target: string, weight: number, alpha: number, evidenceIds: string[]): GraphEdge {
  return {
    id: edgeId(id),
    source: nodeId(source),
    target: nodeId(target),
    relationId: relationId("rel:test"),
    alpha,
    weight,
    temporalScope: { validFrom: 0 },
    evidenceIds: evidenceIds.map(evidenceId),
    createdAt: 0,
    updatedAt: 0,
    metadata: {}
  };
}

function nodeId(value: string): NodeId {
  return value as NodeId;
}

function edgeId(value: string): EdgeId {
  return value as EdgeId;
}

function relationId(value: string): RelationId {
  return value as RelationId;
}

function dimensionId(value: string): DimensionId {
  return value as DimensionId;
}

function evidenceId(value: string): EvidenceId {
  return value as EvidenceId;
}

function alphaTrace(): AlphaTrace {
  return {
    alpha: 0.5,
    thresholds: { virtual: 0.2, visible: 0.4, bonded: 0.6, structural: 0.8 },
    relations: [],
    adjacency: { nodes: [], values: [] },
    laplacian: { nodes: [], values: [] },
    normalizedLaplacian: { nodes: [], values: [] },
    surfaces: { pressure: 0.2, drift: 0.1, contradiction: 0.3, bond: 0.4, risk: 0.1, actionability: 0.5 },
    contradictionMass: 0.2,
    bondedLeakage: 0
  };
}
