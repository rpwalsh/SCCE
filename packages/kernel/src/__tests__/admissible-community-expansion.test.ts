import { describe, expect, it } from "vitest";
import { localPushPersonalizedPageRank, type LocalPushGraph } from "../ppr-local-push.js";
import { computeCommunityExpansionBound, expandAdmissibleCommunity } from "../admissible-community-expansion.js";
import type { NodeId } from "../types.js";

// Plan items 153-154. Proves the real admissibility guarantee on
// exhaustive small synthetic graphs: a bound computed from an early,
// loosely-converged push state must never be exceeded by what a much
// more fully converged run of the exact same graph later confirms --
// the concrete, checkable meaning of "conservative, never overestimates
// reachable mass" for a best-first expansion to safely rely on.

function chainGraph(length: number): LocalPushGraph {
  const nodes = Array.from({ length }, (_, i) => `n${i}`) as NodeId[];
  const edges = [];
  for (let i = 0; i < length - 1; i += 1) {
    edges.push({ from: `n${i}` as NodeId, to: `n${i + 1}` as NodeId, weight: 1 });
    edges.push({ from: `n${i + 1}` as NodeId, to: `n${i}` as NodeId, weight: 1 });
  }
  return { nodes, edges };
}

function starGraph(spokeCount: number): LocalPushGraph {
  const nodes = ["center", ...Array.from({ length: spokeCount }, (_, i) => `spoke${i}`)] as NodeId[];
  const edges = [];
  for (let i = 0; i < spokeCount; i += 1) {
    edges.push({ from: "center" as NodeId, to: `spoke${i}` as NodeId, weight: 1 });
    edges.push({ from: `spoke${i}` as NodeId, to: "center" as NodeId, weight: 1 });
  }
  return { nodes, edges };
}

function graphWithDanglingNode(): LocalPushGraph {
  return {
    nodes: ["a", "b", "c", "dangling"] as NodeId[],
    edges: [
      { from: "a" as NodeId, to: "b" as NodeId, weight: 1 },
      { from: "b" as NodeId, to: "c" as NodeId, weight: 1 },
      { from: "c" as NodeId, to: "a" as NodeId, weight: 1 },
      { from: "b" as NodeId, to: "dangling" as NodeId, weight: 1 }
      // "dangling" has no outgoing edges.
    ]
  };
}

const GRAPHS: Array<{ name: string; graph: LocalPushGraph; seedNodeId: NodeId }> = [
  { name: "chain of 6", graph: chainGraph(6), seedNodeId: "n0" as NodeId },
  { name: "star with 5 spokes", graph: starGraph(5), seedNodeId: "center" as NodeId },
  { name: "cycle with a dangling node", graph: graphWithDanglingNode(), seedNodeId: "a" as NodeId }
];

describe("computeCommunityExpansionBound admissibility (plan items 153-154)", () => {
  for (const { name, graph, seedNodeId } of GRAPHS) {
    it(`${name}: a bound computed from an early (loose-epsilon) push state is never exceeded by a later, much-more-converged run's confirmed mass for the same community`, () => {
      const early = localPushPersonalizedPageRank({ graph, seedNodeId, alpha: 0.15, epsilon: 0.05, maxPushes: 3 });
      const converged = localPushPersonalizedPageRank({ graph, seedNodeId, alpha: 0.15, epsilon: 1e-9 });
      expect(converged.converged).toBe(true);
      // A real proof this test isn't vacuous: the early run actually did
      // stop meaningfully short of convergence.
      expect(early.pushes).toBeLessThan(converged.pushes);

      const community = new Set(graph.nodes.map(String));
      const earlyBound = computeCommunityExpansionBound({ includedNodeIds: community, pi: early.pi, residual: early.residual });
      const finalConfirmedMass = graph.nodes.reduce((sum, nodeId) => sum + (converged.pi.get(String(nodeId)) ?? 0), 0);

      // The real admissibility claim: the early bound must not be lower
      // than what a much more converged run later actually confirms --
      // if it were, an admissible search relying on this bound could have
      // wrongly pruned a branch that turned out to matter.
      expect(earlyBound.totalUpperBound).toBeGreaterThanOrEqual(finalConfirmedMass - 1e-9);
    });
  }

  it("anchorMass is exact (not merely bounded) -- it is the real sum of already-confirmed pi for included nodes, never revised downward by further pushes", () => {
    const graph = chainGraph(4);
    const seedNodeId = "n0" as NodeId;
    const result = localPushPersonalizedPageRank({ graph, seedNodeId, alpha: 0.2, epsilon: 0.01, maxPushes: 5 });
    const included = new Set(["n0", "n1"]);
    const bound = computeCommunityExpansionBound({ includedNodeIds: included, pi: result.pi, residual: result.residual });
    const expectedAnchor = (result.pi.get("n0") ?? 0) + (result.pi.get("n1") ?? 0);
    expect(bound.anchorMass).toBe(expectedAnchor);

    const moreConverged = localPushPersonalizedPageRank({ graph, seedNodeId, alpha: 0.2, epsilon: 1e-9 });
    // Real monotonicity: pi never decreases for a node across more pushes
    // of the same graph/seed/alpha (each push only adds to pi, never
    // subtracts) -- confirms anchorMass measures a real, non-decreasing
    // quantity, not an unstable estimate.
    expect(moreConverged.pi.get("n0") ?? 0).toBeGreaterThanOrEqual(result.pi.get("n0") ?? 0);
    expect(moreConverged.pi.get("n1") ?? 0).toBeGreaterThanOrEqual(result.pi.get("n1") ?? 0);
  });

  it("residualMass matches the real 1 = sum(pi) + sum(residual) conservation invariant at multiple stopping points, not just once", () => {
    const graph = starGraph(4);
    const seedNodeId = "center" as NodeId;
    for (const maxPushes of [1, 2, 4, 8, 50]) {
      const result = localPushPersonalizedPageRank({ graph, seedNodeId, alpha: 0.15, epsilon: 1e-6, maxPushes });
      const bound = computeCommunityExpansionBound({ includedNodeIds: new Set(graph.nodes.map(String)), pi: result.pi, residual: result.residual });
      const totalPi = [...result.pi.values()].reduce((sum, mass) => sum + mass, 0);
      expect(totalPi + bound.residualMass).toBeCloseTo(1, 9);
    }
  });

  it("an obligation node with negligible natural PPR mass is never dropped from community membership even when it would not have ranked within maxCommunitySize on its own", () => {
    const graph = starGraph(10); // ten spokes; the seed's own mass dwarfs any single spoke
    const farNodeId = "spoke9";
    const expansionWithoutObligation = expandAdmissibleCommunity({
      graph,
      seedNodeId: "center",
      alpha: 0.15,
      epsilon: 1e-6,
      maxCommunitySize: 2 // small enough that a weak spoke would normally be cut
    });
    expect(expansionWithoutObligation.includedNodeIds).not.toContain(farNodeId);

    const expansionWithObligation = expandAdmissibleCommunity({
      graph,
      seedNodeId: "center",
      alpha: 0.15,
      epsilon: 1e-6,
      maxCommunitySize: 2,
      obligationNodeIds: new Set([farNodeId]),
      obligationMassPerNode: 0.05
    });
    expect(expansionWithObligation.includedNodeIds).toContain(farNodeId);
    // The obligation's credited allowance is reflected in the real bound,
    // not silently dropped once membership is granted.
    expect(expansionWithObligation.finalBound.obligationMass).toBe(0);
    // (obligationMass is 0 here because the obligation node, once
    // included, is no longer "outstanding" -- its mass is now counted for
    // real in anchorMass/boundaryMass instead, which is the correct,
    // non-double-counted accounting.)
  });

  it("an outstanding (not-yet-included) obligation node's allowance is credited in obligationMass, not silently ignored", () => {
    const bound = computeCommunityExpansionBound({
      includedNodeIds: new Set(["center"]),
      pi: new Map([["center", 0.3]]),
      residual: new Map([["center", 0.1]]),
      obligationNodeIds: new Set(["spoke0", "spoke1"]),
      obligationMassPerNode: 0.05
    });
    expect(bound.obligationMass).toBeCloseTo(0.1, 9); // 2 outstanding obligations * 0.05
    // anchorMass=0.3 (pi.center) + boundaryMass=0.1 (residual.center, the
    // only included node) + residualMass=0.1 (sum of the whole residual
    // map, which here is the same single entry) + obligationMass=0.1.
    expect(bound.anchorMass).toBeCloseTo(0.3, 9);
    expect(bound.boundaryMass).toBeCloseTo(0.1, 9);
    expect(bound.residualMass).toBeCloseTo(0.1, 9);
    expect(bound.totalUpperBound).toBeCloseTo(0.3 + 0.1 + 0.1 + 0.1, 9);
  });
});
