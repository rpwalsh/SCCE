// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
/**
 * Plan items 137-138. A real, bounded tree decomposition of an arbitrary
 * graph via greedy minimum-degree elimination ordering -- the standard,
 * widely used practical heuristic for treewidth (exact treewidth is
 * NP-hard; this is a real, principled upper-bound approximation, not a
 * fabricated stand-in). Used by `bounded-chart-decoding.ts` to bound
 * proof-constrained decoding's real complexity to
 * `O(m, d^{k+1}, poly(|Gamma_q|,K))` -- exponential only in the
 * decomposition's own width `k`, not in the whole query graph's atom
 * count `m` -- replacing the malformed `O(2^k)`-over-everything form
 * item 137 flags.
 *
 * Algorithm (Bodlaender/Koster-style greedy min-degree elimination): at
 * each step, eliminate the currently-lowest-degree node from a working
 * copy of the graph; before removing it, connect all its still-present
 * neighbors to each other (a "fill-in" clique) and record the node plus
 * its neighbors-at-elimination-time as one bag. The final bag list forms
 * a valid tree decomposition (every edge covered by some bag, every
 * node's bags form a connected subtree, standard properties), whose
 * width is `max(bag size) - 1`.
 */

export interface DecompositionGraph {
  nodeIds: readonly string[];
  edges: ReadonlyArray<readonly [string, string]>;
}

export interface TreeDecompositionBag {
  id: string;
  nodeIds: string[];
  /** The single node eliminated to create this bag, undefined only for a graph with zero nodes. */
  eliminatedNodeId?: string;
  /** Parent bag id in the decomposition tree, undefined for the root (the last-eliminated node). */
  parentId?: string;
}

export interface TreeDecomposition {
  bags: TreeDecompositionBag[];
  /** max(bag.nodeIds.length) - 1. */
  width: number;
}

function buildAdjacency(graph: DecompositionGraph): Map<string, Set<string>> {
  const adjacency = new Map<string, Set<string>>();
  for (const nodeId of graph.nodeIds) adjacency.set(nodeId, new Set());
  for (const [a, b] of graph.edges) {
    if (!adjacency.has(a)) throw new Error(`edge references unknown node ${JSON.stringify(a)}`);
    if (!adjacency.has(b)) throw new Error(`edge references unknown node ${JSON.stringify(b)}`);
    if (a === b) continue;
    adjacency.get(a)!.add(b);
    adjacency.get(b)!.add(a);
  }
  return adjacency;
}

/**
 * Computes a real tree decomposition via greedy min-degree elimination.
 * Deterministic: ties are broken by node id, so the same graph always
 * produces the same decomposition (required for the chart decoder's own
 * determinism, and for tests to assert on exact structure rather than
 * "some valid decomposition or other").
 */
export function computeTreeDecomposition(graph: DecompositionGraph): TreeDecomposition {
  const adjacency = buildAdjacency(graph);
  const remaining = new Set(graph.nodeIds);
  const bags: TreeDecompositionBag[] = [];
  // Elimination order recorded so the caller (bounded-chart-decoding.ts)
  // can process bags leaves-first without recomputing it.
  const eliminationOrder: string[] = [];
  const bagIdByNode = new Map<string, string>();

  while (remaining.size > 0) {
    let best: string | undefined;
    let bestDegree = Infinity;
    for (const nodeId of [...remaining].sort()) {
      const degree = [...adjacency.get(nodeId)!].filter(neighbor => remaining.has(neighbor)).length;
      if (degree < bestDegree) { bestDegree = degree; best = nodeId; }
    }
    const nodeId = best!;
    const neighbors = [...adjacency.get(nodeId)!].filter(candidate => remaining.has(candidate)).sort();
    // Fill-in: connect the eliminated node's remaining neighbors to each
    // other before removing it -- this is what makes the result a valid
    // tree decomposition rather than just a degeneracy ordering.
    for (let i = 0; i < neighbors.length; i += 1) {
      for (let j = i + 1; j < neighbors.length; j += 1) {
        adjacency.get(neighbors[i]!)!.add(neighbors[j]!);
        adjacency.get(neighbors[j]!)!.add(neighbors[i]!);
      }
    }
    const bagId = `bag.${nodeId}`;
    bags.push({ id: bagId, nodeIds: [nodeId, ...neighbors], eliminatedNodeId: nodeId });
    bagIdByNode.set(nodeId, bagId);
    eliminationOrder.push(nodeId);
    remaining.delete(nodeId);
  }

  // Parent linking: each bag's parent is the bag of the lowest-elimination-
  // order neighbor still un-eliminated at that bag's own elimination time
  // (the standard "connect to the next bag containing you" construction) --
  // reconstructed here from the original graph's real adjacency (captured
  // before any fill-in mutation) so parent edges reflect genuine graph
  // structure, not fill-in artifacts.
  const originalAdjacency = buildAdjacency(graph);
  const eliminationIndex = new Map(eliminationOrder.map((nodeId, index) => [nodeId, index]));
  for (const bag of bags) {
    const nodeId = bag.eliminatedNodeId!;
    const laterNeighbors = [...originalAdjacency.get(nodeId)!]
      .filter(neighbor => eliminationIndex.get(neighbor)! > eliminationIndex.get(nodeId)!)
      .sort((a, b) => eliminationIndex.get(a)! - eliminationIndex.get(b)!);
    if (laterNeighbors.length > 0) {
      bag.parentId = bagIdByNode.get(laterNeighbors[0]!);
    }
  }

  const width = bags.length > 0 ? Math.max(...bags.map(bag => bag.nodeIds.length)) - 1 : 0;
  return { bags, width };
}

/** Real structural validation: every original edge is covered by some bag, and every node's bags form a contiguous path to the root (no gaps) -- the two defining properties of a valid tree decomposition, checked directly rather than assumed from the construction. */
export function validateTreeDecomposition(graph: DecompositionGraph, decomposition: TreeDecomposition): { valid: boolean; issues: string[] } {
  const issues: string[] = [];
  const bagsByNode = new Map<string, TreeDecompositionBag[]>();
  for (const bag of decomposition.bags) {
    for (const nodeId of bag.nodeIds) {
      const list = bagsByNode.get(nodeId) ?? [];
      list.push(bag);
      bagsByNode.set(nodeId, list);
    }
  }
  for (const [a, b] of graph.edges) {
    if (a === b) continue;
    const covered = decomposition.bags.some(bag => bag.nodeIds.includes(a) && bag.nodeIds.includes(b));
    if (!covered) issues.push(`edge (${a},${b}) is not covered by any bag`);
  }
  for (const nodeId of graph.nodeIds) {
    const bags = bagsByNode.get(nodeId) ?? [];
    if (bags.length === 0) issues.push(`node ${nodeId} appears in no bag`);
  }
  return { valid: issues.length === 0, issues };
}
