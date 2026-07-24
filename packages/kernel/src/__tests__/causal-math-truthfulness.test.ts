import { describe, expect, it } from "vitest";
import { createPfaceEstimator } from "../causal-estimation.js";
import { createCausalDiscoveryEngine } from "../causal.js";
import { assessStabilityAdjustedSupport, createCausalMath, mediatorPathRedundancyPruning } from "../causal-math.js";
import type { FieldState, GraphEdge, GraphNode } from "../types.js";

describe("causal math truthfulness contracts", () => {
  it("derives temporal association mass from the injected replay clock", () => {
    const { nodes, edges } = graphFixture();
    const old = createCausalDiscoveryEngine({ now: () => 1 }).discover({
      nodes,
      edges,
      activeNodeIds: [nodes[0]!.id]
    });
    const later = createCausalDiscoveryEngine({ now: () => 1 + 1000 * 60 * 60 * 24 * 365 }).discover({
      nodes,
      edges,
      activeNodeIds: [nodes[0]!.id]
    });

    expect(old[0]!.mass).toBeGreaterThan(later[0]!.mass);
    expect(createCausalDiscoveryEngine({ now: () => 1 }).discover({
      nodes,
      edges,
      activeNodeIds: [nodes[0]!.id]
    })).toEqual(old);
  });

  it("does not identify a numerical causal effect from graph-only inputs", () => {
    const { nodes, edges, field } = graphFixture();
    const estimate = createPfaceEstimator().estimate({
      nodes,
      edges,
      field,
      treatment: nodes[0]!.id,
      outcome: nodes[2]!.id,
      homogeneityVerified: true
    });

    expect(estimate).toBeDefined();
    expect(estimate).toMatchObject({
      numericalEffectStatus: "not_identified",
      numericalEffect: null,
      structuralAdjustmentHypothesis: {
        kind: "frontdoor_candidate",
        assumptionsVerified: false
      }
    });
    expect(estimate!.graphEffectHeuristic).toBeGreaterThan(-1);
    expect(estimate!.graphEffectHeuristic).toBeLessThan(1);
    expect(estimate!.reason).toContain("numerical causal effect not identified");
    expect(JSON.stringify(estimate)).not.toMatch(/pearlAte|pfaceAte|doIdentified|observationalAdjustment|theorem/);
  });

  it("separates sampled uncertainty from the spectral stability penalty", () => {
    const manySamples = assessStabilityAdjustedSupport({
      supportSamples: new Array<number>(32).fill(0.9),
      projectedSupport: 0.8,
      sinTheta: 0.1,
      sampledSupportThreshold: 0.65,
      stabilityAdjustedSupportThreshold: 0.65
    });
    const oneSample = assessStabilityAdjustedSupport({
      supportSamples: [0.9],
      projectedSupport: 0.8,
      sinTheta: 0.1,
      sampledSupportThreshold: 0.65,
      stabilityAdjustedSupportThreshold: 0.65
    });

    expect(manySamples.sampledSupportLcb).toBeGreaterThan(oneSample.sampledSupportLcb);
    expect(manySamples.spectralStabilityPenalty).toBeCloseTo(0.1);
    expect(manySamples.stabilityAdjustedSupport).toBeCloseTo(0.7);
    expect(oneSample.stabilityAdjustedSupport).toBe(manySamples.stabilityAdjustedSupport);
    expect(manySamples.accepted).toBe(true);
    expect(oneSample.accepted).toBe(false);
    expect(manySamples).not.toHaveProperty("massLcb");
    expect(manySamples).not.toHaveProperty("faithfulnessLcb");
  });

  it("labels graph path pruning as redundancy rather than conditional-independence screening", () => {
    const { nodes, edges } = graphFixture();
    const result = mediatorPathRedundancyPruning({ nodes, edges });
    const api = createCausalMath();

    expect(result.prunedEdges).toHaveLength(1);
    expect(result.prunedEdges[0]).toMatchObject({
      edge: { id: edges[0]!.id },
      mediator: { id: nodes[1]!.id },
      redundancyScore: 0.8,
      reason: "redundant-direct-edge-via-supported-mediator-path"
    });
    expect(result.audit).toMatchObject({
      method: "mediator_path_redundancy_pruning",
      conditionalIndependenceTested: false
    });
    expect(api.mediatorPathRedundancyPruning).toBe(mediatorPathRedundancyPruning);
    expect(api).not.toHaveProperty("reichenbachScreening");
  });
});

function graphFixture(): { nodes: GraphNode[]; edges: GraphEdge[]; field: FieldState } {
  const nodes = [
    graphNode("x", 0.4),
    graphNode("z", 0.6),
    graphNode("y", 0.7)
  ];
  const edges = [
    graphEdge("x-y", "x", "y", 0.5),
    graphEdge("x-z", "x", "z", 0.8),
    graphEdge("z-y", "z", "y", 0.8)
  ];
  const matrix = {
    nodes: nodes.map(node => String(node.id)),
    values: [[0, 0, 0], [0, 0, 0], [0, 0, 0]]
  };
  const field: FieldState = {
    requestFeatures: [],
    seeds: [],
    active: [],
    ppf: [
      { nodeId: nodes[0]!.id, mass: 0.2 },
      { nodeId: nodes[1]!.id, mass: 0.6 },
      { nodeId: nodes[2]!.id, mass: 0.2 }
    ],
    alphaTrace: {
      alpha: 0.5,
      thresholds: { virtual: 0.2, visible: 0.4, bonded: 0.6, structural: 0.8 },
      relations: [],
      adjacency: matrix,
      laplacian: matrix,
      normalizedLaplacian: matrix,
      surfaces: { pressure: 0, drift: 0, contradiction: 0, bond: 0.5, risk: 0, actionability: 0 },
      contradictionMass: 0,
      bondedLeakage: 0
    },
    causalMass: []
  };
  return { nodes, edges, field };
}

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

function graphEdge(id: string, source: string, target: string, weight: number): GraphEdge {
  return {
    id: id as GraphEdge["id"],
    source: source as GraphEdge["source"],
    target: target as GraphEdge["target"],
    relationId: "test.relation" as GraphEdge["relationId"],
    alpha: 1,
    weight,
    temporalScope: { validFrom: 0 },
    evidenceIds: ["evidence-shared" as GraphEdge["evidenceIds"][number]],
    createdAt: 1,
    updatedAt: 1,
    metadata: {}
  };
}
