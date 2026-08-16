import { describe, expect, it } from "vitest";
import { createCounterfactualCognition } from "../counterfactual-cognition.js";
import type { GraphEdge, GraphNode, GraphSnapshot } from "../types.js";

describe("structural causal model licensing (plan items 163-164)", () => {
  it("licenses a real interventional effect when the explanatory subgraph is a genuine acyclic mechanism DAG", () => {
    const nodes = [graphNode("node_a", 0.9), graphNode("node_b", 0.8), graphNode("node_c", 0.7)];
    const edges = [graphEdge("edge_ab", "node_a", "node_b", 0.8, 1), graphEdge("edge_bc", "node_b", "node_c", 0.7, 1)];
    const graph: GraphSnapshot = { nodes, edges, hyperedges: [] };
    const world = createCounterfactualCognition().simulate({
      graph,
      query: {
        targetFeatures: [],
        interventions: [{ id: "iv_a", nodeId: "node_a" as GraphEdge["source"], value: 1, operator: "set", confidence: 0.9, reason: "test" }],
        horizon: 4,
        maxPaths: 16
      }
    });

    expect(world.structural.licensed).toBe(true);
    expect(world.structural.variableIds).toEqual(["node_a", "node_b", "node_c"]);
    expect(world.structural.effect).toBeDefined();
    const effectByNode = new Map(world.structural.effect!.map(item => [String(item.nodeId), item]));
    // The do-operator overrides node_a's own mechanism entirely, so its
    // counterfactual value is exactly the intervention's value, not merely
    // influenced toward it.
    expect(effectByNode.get("node_a")!.counterfactual).toBe(1);
    expect(Number.isFinite(effectByNode.get("node_b")!.counterfactual)).toBe(true);
    expect(Number.isFinite(effectByNode.get("node_c")!.counterfactual)).toBe(true);

    const constraint = world.constraints.find(item => item.id === "structural-license");
    expect(constraint).toBeDefined();
    expect(constraint!.passed).toBe(true);
    expect(constraint!.pressure).toBe(0);
  });

  it("refuses to license an interventional effect when the explanatory subgraph contains a real feedback cycle", () => {
    const nodes = [graphNode("node_a", 0.9), graphNode("node_b", 0.8), graphNode("node_c", 0.7)];
    const edges = [
      graphEdge("edge_ab", "node_a", "node_b", 0.8, 1),
      graphEdge("edge_bc", "node_b", "node_c", 0.7, 1),
      // Closes a real feedback loop back to the intervened variable -- no
      // valid DAG of structural equations exists over {a, b, c} once this
      // edge is included, even though the BFS explanatory path itself
      // (a -> b -> c) never revisits a node.
      graphEdge("edge_ca", "node_c", "node_a", 0.6, 1)
    ];
    const graph: GraphSnapshot = { nodes, edges, hyperedges: [] };
    const world = createCounterfactualCognition().simulate({
      graph,
      query: {
        targetFeatures: [],
        interventions: [{ id: "iv_a", nodeId: "node_a" as GraphEdge["source"], value: 1, operator: "set", confidence: 0.9, reason: "test" }],
        horizon: 4,
        maxPaths: 16
      }
    });

    expect(world.structural.licensed).toBe(false);
    expect(world.structural.reason).toContain("cycle");
    expect(world.structural.effect).toBeUndefined();

    // The associational diffusion effect (world.effect) is still reported
    // as before -- only the *licensed interventional* claim is withheld.
    expect(world.effect.length).toBeGreaterThan(0);

    const constraint = world.constraints.find(item => item.id === "structural-license");
    expect(constraint).toBeDefined();
    expect(constraint!.passed).toBe(false);
    expect(constraint!.pressure).toBeGreaterThan(0);
  });

  it("declines to license an effect over fewer than two relevant variables rather than fabricating a single-node model", () => {
    const nodes = [graphNode("node_solo", 0.9)];
    const graph: GraphSnapshot = { nodes, edges: [], hyperedges: [] };
    const world = createCounterfactualCognition().simulate({
      graph,
      query: {
        targetFeatures: [],
        interventions: [{ id: "iv_solo", nodeId: "node_solo" as GraphEdge["source"], value: 1, operator: "set", confidence: 0.9, reason: "test" }],
        horizon: 2,
        maxPaths: 4
      }
    });

    expect(world.structural.licensed).toBe(false);
    expect(world.structural.effect).toBeUndefined();
  });
});

function graphNode(id: string, alpha: number): GraphNode {
  return {
    id: id as GraphNode["id"],
    typeId: "test.dimension" as GraphNode["typeId"],
    representation: { id },
    alpha,
    evidenceIds: ["evidence-shared" as GraphNode["evidenceIds"][number]],
    features: [],
    createdAt: 1,
    updatedAt: 1,
    metadata: {}
  };
}

function graphEdge(id: string, source: string, target: string, weight: number, polarity: number): GraphEdge {
  return {
    id: id as GraphEdge["id"],
    source: source as GraphEdge["source"],
    target: target as GraphEdge["target"],
    relationId: "test.relation" as GraphEdge["relationId"],
    alpha: 0.9,
    weight,
    temporalScope: { validFrom: 0 },
    evidenceIds: ["evidence-shared" as GraphEdge["evidenceIds"][number]],
    createdAt: 1,
    updatedAt: 1,
    metadata: { polarity }
  };
}
