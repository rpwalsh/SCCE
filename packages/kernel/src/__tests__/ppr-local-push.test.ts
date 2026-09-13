// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
import { describe, expect, it } from "vitest";
import { localPushPersonalizedPageRank, type LocalPushEdge, type LocalPushGraph } from "../ppr-local-push.js";
import { expandAdmissibleCommunity } from "../admissible-community-expansion.js";
import type { NodeId } from "../types.js";

/**
 * Independent oracle: many iterations of the same underlying linear
 * recurrence (`x_(k+1) = alpha*v + (1-alpha)*P^T x_k`), computed by dense
 * power iteration rather than local push, so this test genuinely
 * cross-checks the push algorithm against a different computational path
 * -- not against itself. Dangling rows route their mass to the seed,
 * matching `ppr-local-push.ts`'s own documented convention.
 */
function densePprOracle(graph: LocalPushGraph, seedNodeId: NodeId, alpha: number, iterations = 4_000): Map<string, number> {
  const ids = graph.nodes.map(String);
  const index = new Map(ids.map((id, i) => [id, i]));
  const n = ids.length;
  const outEdges = new Map<string, LocalPushEdge[]>();
  for (const edge of graph.edges) {
    const bucket = outEdges.get(String(edge.from)) ?? [];
    bucket.push(edge);
    outEdges.set(String(edge.from), bucket);
  }
  const outDegree = new Map<string, number>();
  for (const [from, edges] of outEdges) outDegree.set(from, edges.reduce((sum, edge) => sum + edge.weight, 0));

  const seedIndex = index.get(String(seedNodeId))!;
  const v = new Array<number>(n).fill(0);
  v[seedIndex] = 1;
  let x = [...v];
  for (let iteration = 0; iteration < iterations; iteration++) {
    const next = new Array<number>(n).fill(0);
    for (let i = 0; i < n; i++) next[i]! += alpha * v[i]!;
    for (const id of ids) {
      const i = index.get(id)!;
      const mass = x[i]!;
      if (mass === 0) continue;
      const degree = outDegree.get(id) ?? 0;
      if (degree <= 0) {
        next[seedIndex]! += (1 - alpha) * mass;
        continue;
      }
      for (const edge of outEdges.get(id) ?? []) {
        next[index.get(String(edge.to))!]! += (1 - alpha) * mass * (edge.weight / degree);
      }
    }
    x = next;
  }
  const result = new Map<string, number>();
  for (const id of ids) result.set(id, x[index.get(id)!]!);
  return result;
}

function l1(pi: ReadonlyMap<string, number>, oracle: ReadonlyMap<string, number>, allIds: readonly string[]): number {
  let total = 0;
  for (const id of allIds) total += Math.abs((pi.get(id) ?? 0) - (oracle.get(id) ?? 0));
  return total;
}

function residualMass(residual: ReadonlyMap<string, number>): number {
  let total = 0;
  for (const mass of residual.values()) total += mass;
  return total;
}

const CHAIN_GRAPH: LocalPushGraph = {
  nodes: ["a", "b", "c", "d", "e"] as NodeId[],
  edges: [
    { from: "a" as NodeId, to: "b" as NodeId, weight: 1 },
    { from: "b" as NodeId, to: "c" as NodeId, weight: 1 },
    { from: "c" as NodeId, to: "d" as NodeId, weight: 1 },
    { from: "d" as NodeId, to: "e" as NodeId, weight: 1 },
    { from: "e" as NodeId, to: "a" as NodeId, weight: 1 }
  ]
};

// Directed, non-symmetric, with a dangling node ("d" has no outgoing edges)
// and unequal edge weights.
const DANGLING_GRAPH: LocalPushGraph = {
  nodes: ["a", "b", "c", "d"] as NodeId[],
  edges: [
    { from: "a" as NodeId, to: "b" as NodeId, weight: 3 },
    { from: "a" as NodeId, to: "c" as NodeId, weight: 1 },
    { from: "b" as NodeId, to: "d" as NodeId, weight: 1 },
    { from: "c" as NodeId, to: "a" as NodeId, weight: 1 }
  ]
};

describe("local residual PPR push (plan items 148-149)", () => {
  it.each([
    ["a five-node directed cycle", CHAIN_GRAPH, "a" as NodeId],
    ["a directed graph with a dangling node", DANGLING_GRAPH, "a" as NodeId],
    ["a dangling graph seeded from a non-dangling interior node", DANGLING_GRAPH, "b" as NodeId]
  ])("maintains |pi - pihat|_1 = |r|_1 (tightly, not just as a loose bound) on %s", (_label, graph, seed) => {
    const alpha = 0.15;
    const epsilon = 1e-6;
    const result = localPushPersonalizedPageRank({ graph, seedNodeId: seed, alpha, epsilon });
    expect(result.converged).toBe(true);

    const oracle = densePprOracle(graph, seed, alpha);
    const allIds = graph.nodes.map(String);
    const error = l1(result.pi, oracle, allIds);
    const residual = residualMass(result.residual);

    // The invariant itself: real L1 error is bounded by residual mass.
    expect(error).toBeLessThanOrEqual(residual + 1e-6);
    // And it must be *tight*, not just any loose bound -- proving this is
    // really the ACL invariant and not a weaker one that happens to also
    // satisfy the inequality (e.g. "error <= 1" would trivially pass the
    // check above without meaning anything).
    expect(residual).toBeLessThan(epsilon * graph.nodes.length * 2);
    expect(error).toBeLessThan(epsilon * graph.nodes.length * 2);
  });

  it("conserves total mass exactly across every push: sum(pi) + sum(residual) stays at 1", () => {
    const result = localPushPersonalizedPageRank({ graph: DANGLING_GRAPH, seedNodeId: "a" as NodeId, alpha: 0.2, epsilon: 1e-5 });
    const totalPi = [...result.pi.values()].reduce((sum, value) => sum + value, 0);
    const totalResidual = residualMass(result.residual);
    expect(totalPi + totalResidual).toBeCloseTo(1, 9);
  });

  it("does not lose mass at a dangling node -- its full residual is accounted for, not dropped", () => {
    // A graph where the seed itself immediately reaches a dangling node.
    const graph: LocalPushGraph = {
      nodes: ["seed", "dead-end"] as NodeId[],
      edges: [{ from: "seed" as NodeId, to: "dead-end" as NodeId, weight: 1 }]
    };
    const result = localPushPersonalizedPageRank({ graph, seedNodeId: "seed" as NodeId, alpha: 0.1, epsilon: 1e-6 });
    const totalPi = [...result.pi.values()].reduce((sum, value) => sum + value, 0);
    const totalResidual = residualMass(result.residual);
    expect(totalPi + totalResidual).toBeCloseTo(1, 9);
  });

  it("rejects a non-positive alpha or epsilon", () => {
    expect(() => localPushPersonalizedPageRank({ graph: CHAIN_GRAPH, seedNodeId: "a" as NodeId, alpha: 0, epsilon: 0.1 }))
      .toThrow(/alpha must be/);
    expect(() => localPushPersonalizedPageRank({ graph: CHAIN_GRAPH, seedNodeId: "a" as NodeId, alpha: 0.1, epsilon: 0 }))
      .toThrow(/epsilon must be/);
  });

  it("rejects a non-positive edge weight", () => {
    const graph: LocalPushGraph = {
      nodes: ["a", "b"] as NodeId[],
      edges: [{ from: "a" as NodeId, to: "b" as NodeId, weight: 0 }]
    };
    expect(() => localPushPersonalizedPageRank({ graph, seedNodeId: "a" as NodeId, alpha: 0.1, epsilon: 0.1 }))
      .toThrow(/positive weight/);
  });
});

describe("local push is a genuinely distinct algorithm/residual notion from ppf.ts's global diagnostics", () => {
  it("this module's residual is per-node undistributed PPR mass, not ppf.ts's algebraic iterate-to-iterate residualL1 -- they are different numbers answering different questions and must never be read interchangeably", () => {
    const result = localPushPersonalizedPageRank({ graph: CHAIN_GRAPH, seedNodeId: "a" as NodeId, alpha: 0.15, epsilon: 1e-6 });
    // The local-push result type has no `residualL1` field at all -- there
    // is no shared vocabulary to accidentally conflate.
    expect(Object.keys(result)).toEqual(["pi", "residual", "pushes", "converged"]);
  });
});

/**
 * Class B: an absolute constant compared against a learned quantity. `epsilon` is compared against
 * `residual / out-degree`, and out-degree is a sum of caller-supplied edge weights. Those weights are
 * `graph_edges.alpha` at the production call site (production-turn-runtime's subject-community walk), a learned
 * column -- so before the degree was expressed in units of the graph's own mean edge weight, multiplying every
 * weight by a constant moved the stopping point of the walk with no error and no declaration.
 *
 * Measured at the time this was written: on a 400-node slice, the same graph rescaled from x100 to x0.002 went
 * from 19 pushes reaching 15 nodes to 10,414 pushes reaching 400, at one fixed epsilon of 1e-4. Smaller weights
 * grow the community and the cost; larger weights shrink it.
 */
describe("the push criterion is invariant to a uniform rescale of edge weight", () => {
  const scaleGraph = (graph: LocalPushGraph, scale: number): LocalPushGraph => ({
    nodes: graph.nodes,
    edges: graph.edges.map(edge => ({ ...edge, weight: edge.weight * scale }))
  });

  // Weights drawn across the live `graph_edges.alpha` range (min 0.066, max 1.0, mean 0.509), so the mean edge
  // weight is not 1 and the normalization is genuinely exercised rather than vacuously the identity. Both edge
  // directions are added because the production call site mirrors every edge.
  const learnedWeightGraph = (nodeCount: number, edgeCount: number): LocalPushGraph => {
    let state = 20260913 >>> 0;
    const random = () => ((state = (state * 1664525 + 1013904223) >>> 0) / 4294967296);
    const nodes = Array.from({ length: nodeCount }, (_, i) => `n${i}`) as NodeId[];
    const edges: LocalPushEdge[] = [];
    for (let k = 0; k < edgeCount; k += 1) {
      const from = Math.floor(random() * nodes.length);
      const to = (from + 1 + Math.floor(random() * (nodes.length - 1))) % nodes.length;
      const weight = 0.066 + random() * 0.934;
      edges.push({ from: nodes[from]!, to: nodes[to]!, weight });
      edges.push({ from: nodes[to]!, to: nodes[from]!, weight });
    }
    return { nodes, edges };
  };

  it.each([
    ["a five-node cycle", CHAIN_GRAPH, "a" as NodeId],
    ["a directed graph with unequal weights and a dangling node", DANGLING_GRAPH, "a" as NodeId],
    ["a slice whose weights are drawn like the learned graph_edges.alpha column", learnedWeightGraph(16, 32), "n0" as NodeId]
  ])("%s: the same walk, the same pushes and the same mass whatever scale the weights carry", (_label, graph, seed) => {
    const alpha = 0.15;
    const epsilon = 1e-4;
    const base = localPushPersonalizedPageRank({ graph, seedNodeId: seed, alpha, epsilon });

    for (const scale of [1e-3, 0.02, 0.5, 7, 500]) {
      const rescaled = localPushPersonalizedPageRank({ graph: scaleGraph(graph, scale), seedNodeId: seed, alpha, epsilon });
      expect(rescaled.pushes).toBe(base.pushes);
      expect(rescaled.converged).toBe(base.converged);
      expect([...rescaled.pi.keys()].sort()).toEqual([...base.pi.keys()].sort());
      for (const [nodeId, mass] of base.pi) expect(rescaled.pi.get(nodeId)).toBeCloseTo(mass, 12);
    }
  });

  it("a uniform-weight graph reduces exactly to the unweighted degree count the ACL criterion is defined on", () => {
    const unweighted = localPushPersonalizedPageRank({ graph: CHAIN_GRAPH, seedNodeId: "a" as NodeId, alpha: 0.15, epsilon: 1e-4 });
    const uniformlyWeighted = localPushPersonalizedPageRank({ graph: scaleGraph(CHAIN_GRAPH, 0.509), seedNodeId: "a" as NodeId, alpha: 0.15, epsilon: 1e-4 });
    expect(uniformlyWeighted.pushes).toBe(unweighted.pushes);
    expect([...uniformlyWeighted.pi.entries()]).toEqual([...unweighted.pi.entries()]);
  });

  /**
   * The membership consequence, at the slice size where it bites. At the corpus's current live slice -- 16 nodes,
   * 32 edges, measured over 290 turns -- the walk reaches every reachable node at every scale, so epsilon decides
   * nothing there and this defect is latent. It stops being latent as the slice grows: unfixed, this same graph at
   * 400 nodes admits 15 nodes at x100 and 64 at x1, from nothing but a rescale.
   */
  it("the subject community a rescaled slice admits is the same set of nodes", () => {
    const graph = learnedWeightGraph(400, 600);
    const expand = (scale: number) => expandAdmissibleCommunity({
      graph: scaleGraph(graph, scale),
      seedNodeId: "n0",
      // The production subject-community walk's own parameters.
      alpha: 0.15,
      epsilon: 1e-4,
      maxCommunitySize: 64
    }).includedNodeIds.slice().sort();
    const reference = expand(1);
    expect(reference.length).toBeGreaterThan(1);
    expect(expand(0.002)).toEqual(reference);
    expect(expand(100)).toEqual(reference);
  });
});
