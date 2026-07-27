import { describe, expect, it } from "vitest";
import { localPushPersonalizedPageRank, type LocalPushEdge, type LocalPushGraph } from "../ppr-local-push.js";
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
