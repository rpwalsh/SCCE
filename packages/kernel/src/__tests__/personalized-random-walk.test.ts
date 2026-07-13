import { describe, expect, it } from "vitest";
import {
  createHasher,
  createIdFactory,
  createClock,
  personalizedPerronFrobenius,
  personalizedRandomWalkWithRestartDenseReference,
  personalizedRandomWalkWithRestartDetailed,
  type RelationTransitionPolicy
} from "../index.js";
import type { GraphEdge, GraphNode, NodeId, RelationId } from "../types.js";

describe("personalized random walk with restart", () => {
  it("matches the closed-form solution for a directed edge with a dangling target", () => {
    const graph = graphFixture(2, [[0, 1, 2]]);
    const result = personalizedRandomWalkWithRestartDetailed({
      ...graph,
      personalization: [{ nodeId: graph.nodes[0]!.id, weight: 1 }],
      relationPolicies: directedPolicies(graph.relations),
      continuationProbability: 0.8,
      tolerance: 1e-13,
      maxIterations: 500
    });
    const mass = byNode(result.rank);
    expect(mass.get(graph.nodes[0]!.id)).toBeCloseTo(5 / 9, 11);
    expect(mass.get(graph.nodes[1]!.id)).toBeCloseTo(4 / 9, 11);
    expect(result.diagnostics.danglingNodes).toBe(1);
    expect(result.diagnostics.converged).toBe(true);
    expect(result.diagnostics.residualL1).toBeLessThanOrEqual(1e-13);
    expect(result.diagnostics.massSum).toBeCloseTo(1, 14);
    expect(result.diagnostics.transitionContributionTrace).toContainEqual(expect.objectContaining({
      from: graph.nodes[0]!.id,
      to: graph.nodes[1]!.id,
      probability: 1
    }));
    expect(result.diagnostics.restartContributionTrace).toEqual([expect.objectContaining({ nodeId: graph.nodes[0]!.id, teleportMass: 1 })]);
    expect(result.diagnostics.restartContributionTrace?.[0]?.restartedMass).toBeCloseTo(0.2, 14);
    expect(result.diagnostics.traceInterpretation).toBe("final_fixed_point_contributions");
  });

  it("routes dangling mass to personalization and never invents a reverse edge", () => {
    const graph = graphFixture(3, [[0, 1, 1]]);
    const reference = personalizedRandomWalkWithRestartDenseReference({
      ...graph,
      personalization: [{ nodeId: graph.nodes[2]!.id, weight: 1 }],
      relationPolicies: directedPolicies(graph.relations),
      restartProbability: 0.2
    });
    expect(reference.transition[0]).toEqual([0, 1, 0]);
    expect(reference.transition[1]).toEqual([0, 0, 1]);
    expect(reference.transition[2]).toEqual([0, 0, 1]);
    expect(reference.diagnostics.explicitReverseTransitions).toBe(0);
    expect(reference.diagnostics.syntheticReverseTransitions).toBe(0);
    expect(reference.diagnostics.danglingPolicy).toBe("personalization");
    expect(reference.diagnostics.relationPolicies).toEqual([{ relationId: String(graph.relations[0]), direction: "directed" }]);
  });

  it("adds reverse transitions only for an explicit reversible policy", () => {
    const graph = graphFixture(3, [[0, 1, 1]]);
    const reference = personalizedRandomWalkWithRestartDenseReference({
      ...graph,
      personalization: [{ nodeId: graph.nodes[2]!.id, weight: 1 }],
      relationPolicies: [{ relationId: graph.relations[0]!, direction: "reversible" }]
    });
    expect(reference.transition[1]).toEqual([1, 0, 0]);
    expect(reference.diagnostics.explicitReverseTransitions).toBe(1);
    expect(reference.diagnostics.relationPolicyCounts.reversible).toBe(1);
  });

  it("reports non-convergence when the L1 tolerance is not reached", () => {
    const graph = graphFixture(2, [[0, 1, 1]]);
    const result = personalizedRandomWalkWithRestartDetailed({
      ...graph,
      personalization: [{ nodeId: graph.nodes[0]!.id, weight: 1 }],
      relationPolicies: directedPolicies(graph.relations),
      continuationProbability: 0.8,
      tolerance: 1e-15,
      maxIterations: 1
    });
    expect(result.diagnostics.iterations).toBe(1);
    expect(result.diagnostics.converged).toBe(false);
    expect(result.diagnostics.residualL1).toBeGreaterThan(1e-15);
  });

  it("matches an independently constructed dense linear-system reference", () => {
    const cases: Array<{ nodeCount: number; edges: Array<[number, number, number]>; prior: number[] }> = [
      { nodeCount: 1, edges: [], prior: [1] },
      { nodeCount: 3, edges: [[0, 1, 0.5], [0, 2, 1.5], [1, 2, 2]], prior: [3, 1, 0] },
      { nodeCount: 4, edges: [[0, 1, 1], [1, 2, 1], [2, 0, 1], [2, 3, 0.2], [3, 3, 0.1]], prior: [1, 0, 2, 1] }
    ];
    for (const testCase of cases) {
      const graph = graphFixture(testCase.nodeCount, testCase.edges);
      const input = {
        ...graph,
        personalization: testCase.prior.map((weight, index) => ({ nodeId: graph.nodes[index]!.id, weight })),
        relationPolicies: directedPolicies(graph.relations),
        continuationProbability: 0.87,
        tolerance: 1e-13,
        maxIterations: 2_000
      };
      const sparse = personalizedRandomWalkWithRestartDetailed(input);
      const dense = personalizedRandomWalkWithRestartDenseReference(input);
      const sparseMass = byNode(sparse.rank);
      for (const item of dense.rank) expect(sparseMass.get(item.nodeId)).toBeCloseTo(item.mass, 11);
      expect(sparse.diagnostics.massSum).toBeCloseTo(1, 13);
      expect(dense.diagnostics.residualL1).toBeLessThan(1e-11);
    }
  });

  it("validates probabilities, weights, node references, and relation declarations", () => {
    const graph = graphFixture(2, [[0, 1, 1]]);
    const base = {
      ...graph,
      personalization: [{ nodeId: graph.nodes[0]!.id, weight: 1 }],
      relationPolicies: directedPolicies(graph.relations)
    };
    expect(() => personalizedRandomWalkWithRestartDetailed({ ...base, continuationProbability: 1 })).toThrow(/continuationProbability/);
    expect(() => personalizedRandomWalkWithRestartDetailed({ ...base, restartProbability: 0 })).toThrow(/restartProbability/);
    expect(() => personalizedRandomWalkWithRestartDetailed({ ...base, continuationProbability: 0.7, restartProbability: 0.4 })).toThrow(/sum to one/);
    expect(() => personalizedRandomWalkWithRestartDetailed({ ...base, relationPolicies: [] })).toThrow(/missing direction policy/);
    expect(() => personalizedRandomWalkWithRestartDetailed({ ...base, relationPolicies: [{ relationId: graph.relations[0]!, direction: "reversible", reverseWeightScale: 0 }] })).toThrow(/greater than zero/);
    expect(() => personalizedRandomWalkWithRestartDetailed({ ...base, edges: [{ ...graph.edges[0]!, weight: -1 }] })).toThrow(/weight.*nonnegative/);
    expect(() => personalizedRandomWalkWithRestartDetailed({ ...base, personalization: [{ nodeId: "missing" as NodeId, weight: 1 }] })).toThrow(/unknown node/);
    expect(() => personalizedRandomWalkWithRestartDetailed({ ...base, personalization: [] })).toThrow(/positive mass/);
  });

  it("retains the old Perron-Frobenius name only as a behavior-compatible alias", () => {
    const graph = graphFixture(2, [[0, 1, 1]]);
    const rank = personalizedPerronFrobenius({
      ...graph,
      personalization: [{ nodeId: graph.nodes[0]!.id, weight: 1 }],
      damping: 0.8
    });
    expect(byNode(rank).get(graph.nodes[0]!.id)).toBeCloseTo(5 / 9, 9);
  });
});

function graphFixture(nodeCount: number, rawEdges: Array<[number, number, number]>): {
  nodes: GraphNode[];
  edges: GraphEdge[];
  relations: RelationId[];
} {
  const ids = createIdFactory({ clock: createClock({ fixedTime: 1_000, stepMs: 1 }), hasher: createHasher(), deterministicReplay: true });
  const nodes = Array.from({ length: nodeCount }, (_, index): GraphNode => ({
    id: ids.nodeId(`node:${index}`),
    typeId: ids.dimensionId("test.node"),
    representation: `node:${index}`,
    alpha: 1,
    evidenceIds: [],
    features: [],
    createdAt: 1_000,
    updatedAt: 1_000,
    metadata: {}
  }));
  const relations = rawEdges.map((_, index) => ids.relationId(`relation:${index}`));
  const edges = rawEdges.map(([source, target, weight], index): GraphEdge => ({
    id: ids.edgeId({ source: nodes[source]!.id, target: nodes[target]!.id, relationId: relations[index]!, provenanceHash: `edge:${index}` }),
    source: nodes[source]!.id,
    target: nodes[target]!.id,
    relationId: relations[index]!,
    alpha: 1,
    weight,
    temporalScope: { validFrom: 0 },
    evidenceIds: [],
    createdAt: 1_000,
    updatedAt: 1_000,
    metadata: {}
  }));
  return { nodes, edges, relations };
}

function directedPolicies(relations: readonly RelationId[]): RelationTransitionPolicy[] {
  return relations.map(relationId => ({ relationId, direction: "directed" }));
}

function byNode(rank: readonly { nodeId: NodeId; mass: number }[]): Map<NodeId, number> {
  return new Map(rank.map(item => [item.nodeId, item.mass]));
}
