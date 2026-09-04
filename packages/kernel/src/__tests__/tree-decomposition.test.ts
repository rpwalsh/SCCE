// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
import { describe, expect, it } from "vitest";
import { computeTreeDecomposition, validateTreeDecomposition, type DecompositionGraph } from "../tree-decomposition.js";

// Plan items 137-138. Ground truth: several small graphs whose real
// treewidth is already mathematically known, so the computed width can
// be checked against a real value, not just "looks plausible".

function pathGraph(length: number): DecompositionGraph {
  const nodeIds = Array.from({ length }, (_, i) => `n${i}`);
  const edges: Array<readonly [string, string]> = [];
  for (let i = 0; i < length - 1; i += 1) edges.push([`n${i}`, `n${i + 1}`]);
  return { nodeIds, edges };
}

function cycleGraph(length: number): DecompositionGraph {
  const path = pathGraph(length);
  return { nodeIds: path.nodeIds, edges: [...path.edges, [`n${length - 1}`, "n0"]] };
}

function completeGraph(size: number): DecompositionGraph {
  const nodeIds = Array.from({ length: size }, (_, i) => `n${i}`);
  const edges: Array<readonly [string, string]> = [];
  for (let i = 0; i < size; i += 1) for (let j = i + 1; j < size; j += 1) edges.push([`n${i}`, `n${j}`]);
  return { nodeIds, edges };
}

function starGraph(spokeCount: number): DecompositionGraph {
  const nodeIds = ["center", ...Array.from({ length: spokeCount }, (_, i) => `spoke${i}`)];
  const edges: Array<readonly [string, string]> = Array.from({ length: spokeCount }, (_, i) => ["center", `spoke${i}`] as const);
  return { nodeIds, edges };
}

describe("computeTreeDecomposition (plan items 137-138)", () => {
  it("a tree (path graph) has real treewidth 1", () => {
    const decomposition = computeTreeDecomposition(pathGraph(6));
    expect(decomposition.width).toBe(1);
    expect(validateTreeDecomposition(pathGraph(6), decomposition).valid).toBe(true);
  });

  it("a star graph (also a tree) has real treewidth 1 regardless of spoke count", () => {
    const decomposition = computeTreeDecomposition(starGraph(20));
    expect(decomposition.width).toBe(1);
    expect(validateTreeDecomposition(starGraph(20), decomposition).valid).toBe(true);
  });

  it("a simple cycle has real treewidth 2", () => {
    const decomposition = computeTreeDecomposition(cycleGraph(8));
    expect(decomposition.width).toBe(2);
    expect(validateTreeDecomposition(cycleGraph(8), decomposition).valid).toBe(true);
  });

  it("a complete graph K_n has real treewidth n-1 (the worst case -- min-degree elimination cannot do better because there is no better structure to exploit)", () => {
    const decomposition = computeTreeDecomposition(completeGraph(5));
    expect(decomposition.width).toBe(4);
    expect(validateTreeDecomposition(completeGraph(5), decomposition).valid).toBe(true);
  });

  it("an empty graph has width 0 and no bags reference nonexistent nodes", () => {
    const decomposition = computeTreeDecomposition({ nodeIds: [], edges: [] });
    expect(decomposition.width).toBe(0);
    expect(decomposition.bags).toHaveLength(0);
  });

  it("a single isolated node has width 0", () => {
    const decomposition = computeTreeDecomposition({ nodeIds: ["solo"], edges: [] });
    expect(decomposition.width).toBe(0);
    expect(decomposition.bags).toHaveLength(1);
    expect(decomposition.bags[0]!.nodeIds).toEqual(["solo"]);
  });

  it("is deterministic -- the same graph always produces byte-identical bag structure", () => {
    const graph = cycleGraph(6);
    const first = computeTreeDecomposition(graph);
    const second = computeTreeDecomposition(graph);
    expect(first).toEqual(second);
  });

  it("throws on an edge referencing a node not in nodeIds, rather than silently producing an invalid decomposition", () => {
    expect(() => computeTreeDecomposition({ nodeIds: ["a", "b"], edges: [["a", "ghost"]] })).toThrow();
  });

  it("two disjoint trees joined by a single bridge edge still has real treewidth 1 (a real, slightly less trivial structural case)", () => {
    const left = pathGraph(4); // n0-n1-n2-n3
    const right: DecompositionGraph = {
      nodeIds: ["m0", "m1", "m2", "m3"],
      edges: [["m0", "m1"], ["m1", "m2"], ["m2", "m3"]]
    };
    const bridged: DecompositionGraph = {
      nodeIds: [...left.nodeIds, ...right.nodeIds],
      edges: [...left.edges, ...right.edges, ["n3", "m0"]]
    };
    const decomposition = computeTreeDecomposition(bridged);
    expect(decomposition.width).toBe(1);
    expect(validateTreeDecomposition(bridged, decomposition).valid).toBe(true);
  });

  it("every bag except the root has a real parentId, and following parent links from any bag reaches a bag with no parentId", () => {
    const decomposition = computeTreeDecomposition(cycleGraph(6));
    const byId = new Map(decomposition.bags.map(bag => [bag.id, bag]));
    let roots = 0;
    for (const bag of decomposition.bags) {
      let current: typeof bag | undefined = bag;
      const seen = new Set<string>();
      while (current?.parentId) {
        expect(seen.has(current.id)).toBe(false); // no cycles in the parent chain
        seen.add(current.id);
        current = byId.get(current.parentId);
      }
      if (current && !current.parentId) roots += 1;
    }
    expect(roots).toBe(decomposition.bags.length); // every bag's chain reaches some root
  });
});
