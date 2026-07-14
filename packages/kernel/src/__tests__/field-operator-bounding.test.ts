import { describe, expect, it } from "vitest";
import { createAlphaFieldEngine, type GraphEdge, type GraphNode } from "../index.js";

describe("bounded field operator matrices", () => {
  it("recomputes induced degrees when the operator window omits graph neighbors", () => {
    const nodes = Array.from({ length: 64 }, (_, index) => node(index));
    const edges: GraphEdge[] = [];
    for (let source = 0; source < nodes.length; source++) {
      for (let target = source + 1; target < nodes.length; target++) {
        edges.push(edge(source, target));
      }
    }

    const field = createAlphaFieldEngine().activate({
      text: "anchor",
      nodes,
      edges
    });
    const diagnostics = field.ppfDiagnostics as {
      fieldOperators?: {
        heat?: { energy?: number; residual?: number };
        wave?: { energy?: number; momentum?: number };
        spectral?: { residual?: number };
      };
    };

    expect(field.alphaTrace.laplacian.nodes).toHaveLength(64);
    expect(diagnostics.fieldOperators).toBeDefined();
    expect(Number.isFinite(diagnostics.fieldOperators?.heat?.energy)).toBe(true);
    expect(Number.isFinite(diagnostics.fieldOperators?.heat?.residual)).toBe(true);
    expect(Number.isFinite(diagnostics.fieldOperators?.wave?.energy)).toBe(true);
    expect(Number.isFinite(diagnostics.fieldOperators?.wave?.momentum)).toBe(true);
    expect(Number.isFinite(diagnostics.fieldOperators?.spectral?.residual)).toBe(true);
  });
});

function node(index: number): GraphNode {
  return {
    id: `node.${index}` as GraphNode["id"],
    typeId: "type.fixture" as GraphNode["typeId"],
    representation: { index },
    alpha: 1,
    evidenceIds: [],
    features: ["sym:anchor"],
    createdAt: 1,
    updatedAt: 1,
    metadata: {}
  };
}

function edge(source: number, target: number): GraphEdge {
  return {
    id: `edge.${source}.${target}` as GraphEdge["id"],
    source: `node.${source}` as GraphEdge["source"],
    target: `node.${target}` as GraphEdge["target"],
    relationId: "relation.fixture" as GraphEdge["relationId"],
    alpha: 1,
    weight: 1,
    temporalScope: { validFrom: 0 },
    evidenceIds: ["evidence.fixture" as GraphEdge["evidenceIds"][number]],
    createdAt: 1,
    updatedAt: 1,
    metadata: { modalityAgreement: 1, utility: 1 }
  };
}
