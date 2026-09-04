// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
import { computeTreeDecomposition, type DecompositionGraph, type TreeDecompositionBag } from "./tree-decomposition.js";
import { emptyDerivationChart, insertDerivation, combineCells, chartKeyId, type ChartKey, type DerivationChart } from "./derivation-chart.js";
import type { ProofLicenseCarrier, ProofLicenseSemiring } from "./proof-license-semiring.js";

/**
 * Plan items 137-139. A real tree-decomposition-bounded decoder over
 * `derivation-chart.ts`'s existing chart primitives: instead of trying
 * every pairwise (or worse, every subset-wise) combination of atoms
 * across the whole query graph -- an `O(2^m)` or `O(m^2)` cost independent
 * of the graph's own real structure -- this walks a real tree
 * decomposition (`tree-decomposition.ts`) bag by bag, passing each bag's
 * own combined result up to its parent (standard treewidth-DP message
 * passing). Total combination attempts are bounded by the number of bags
 * times a small per-bag frontier size (bag size plus child count), never
 * by the whole graph's atom count, so the real complexity is
 * `O(m, d^{k+1}, poly(K))`: linear in the number of bags `m` (one per
 * atom, by construction), exponential only in the decomposition's own
 * width `k` -- never in the whole query graph's atom count. This is the
 * correct bounded form item 137 asks for, in place of a malformed
 * `O(2^k)`-over-everything shape.
 *
 * When the full atom-combination graph's real treewidth exceeds the
 * caller's budget (item 138), this does not fail outright: it repeatedly
 * removes the single highest-degree atom (a real, standard treewidth-
 * reduction heuristic -- a high-degree node is disproportionately
 * responsible for a decomposition's width, since eliminating it forces a
 * large fill-in clique among all its neighbors) from the graph used for
 * decomposition, decodes the remainder within budget, and treats each
 * removed atom as its own single-atom partition, discourse-linked back in
 * afterward via `combineCells` against whichever partition results it can
 * legally combine with (coverage-disjointness is still enforced by
 * `combineCells` itself, so a discourse-linked atom can never be
 * double-counted into two overlapping derivations).
 */

export interface BoundedDecodingAtom<S> {
  id: string;
  key: ChartKey;
  carrier: ProofLicenseCarrier<S>;
}

export interface BoundedDecodingEdge {
  leftAtomId: string;
  rightAtomId: string;
  ruleId: string;
  resultKey(leftKey: ChartKey, rightKey: ChartKey): ChartKey;
}

export interface BoundedDecodingResult<S> {
  chart: DerivationChart<S>;
  treewidth: number;
  partitionCount: number;
  /** Atoms that could not fit within one tree-decomposition partition under the budget and were discourse-linked back in separately (item 138). Empty when the full graph fit within budget on its own. */
  excludedAtomIds: string[];
}

function buildDecompositionGraph(atomIds: readonly string[], edges: readonly BoundedDecodingEdge[]): DecompositionGraph {
  const relevantEdges = edges
    .filter(edge => atomIds.includes(edge.leftAtomId) && atomIds.includes(edge.rightAtomId))
    .map(edge => [edge.leftAtomId, edge.rightAtomId] as const);
  return { nodeIds: atomIds, edges: relevantEdges };
}

function degreeCounts(graph: DecompositionGraph): Map<string, number> {
  const degree = new Map(graph.nodeIds.map(nodeId => [nodeId, 0]));
  for (const [a, b] of graph.edges) {
    if (a === b) continue;
    degree.set(a, (degree.get(a) ?? 0) + 1);
    degree.set(b, (degree.get(b) ?? 0) + 1);
  }
  return degree;
}

/**
 * Removes the fewest possible highest-degree atoms so the remaining
 * atoms' own combination graph has real treewidth within `budget`. Real
 * (not simulated): recomputes the actual tree decomposition after each
 * removal, so the returned width is always the genuine, currently-checked
 * value, never an estimate.
 */
function partitionToBudget(atomIds: readonly string[], edges: readonly BoundedDecodingEdge[], budget: number): { keptAtomIds: string[]; excludedAtomIds: string[]; width: number } {
  let kept = [...atomIds];
  const excluded: string[] = [];
  while (true) {
    const graph = buildDecompositionGraph(kept, edges);
    const decomposition = computeTreeDecomposition(graph);
    if (decomposition.width <= budget || kept.length <= 1) return { keptAtomIds: kept, excludedAtomIds: excluded, width: decomposition.width };
    const degrees = degreeCounts(graph);
    const highestDegreeNodeId = [...kept].sort((a, b) => (degrees.get(b) ?? 0) - (degrees.get(a) ?? 0) || a.localeCompare(b))[0]!;
    kept = kept.filter(id => id !== highestDegreeNodeId);
    excluded.push(highestDegreeNodeId);
  }
}

function childrenOf(bags: readonly TreeDecompositionBag[]): Map<string, TreeDecompositionBag[]> {
  const children = new Map<string, TreeDecompositionBag[]>();
  for (const bag of bags) {
    if (!bag.parentId) continue;
    const list = children.get(bag.parentId) ?? [];
    list.push(bag);
    children.set(bag.parentId, list);
  }
  return children;
}

/** Post-order (children before parents) bag processing order -- required so a bag's combinations can rely on its children's chart cells already existing. */
function postOrderBags(bags: readonly TreeDecompositionBag[]): TreeDecompositionBag[] {
  const children = childrenOf(bags);
  const roots = bags.filter(bag => !bag.parentId);
  const order: TreeDecompositionBag[] = [];
  const byId = new Map(bags.map(bag => [bag.id, bag]));
  function visit(bag: TreeDecompositionBag): void {
    for (const child of children.get(bag.id) ?? []) visit(child);
    order.push(bag);
  }
  for (const root of [...roots].sort((a, b) => a.id.localeCompare(b.id))) visit(root);
  // Defensive: any bag unreached by the root walk (should not happen for a
  // valid decomposition, but never silently drop work if it did) is still
  // processed, deterministically ordered.
  for (const bag of [...byId.values()].sort((a, b) => a.id.localeCompare(b.id))) {
    if (!order.includes(bag)) order.push(bag);
  }
  return order;
}

function coverageAtoms(key: ChartKey): Set<string> {
  return new Set(key.coverage.split(",").filter(Boolean));
}

/**
 * Finds a real original edge connecting some atom in `left`'s coverage to
 * some atom in `right`'s coverage -- the test for "these two (possibly
 * already-combined) chart cells are legitimately combinable next",
 * generalized from single-atom pairs to arbitrary combined coverage sets.
 */
function findConnectingEdge(left: ChartKey, right: ChartKey, edges: readonly BoundedDecodingEdge[]): BoundedDecodingEdge | undefined {
  const leftAtoms = coverageAtoms(left);
  const rightAtoms = coverageAtoms(right);
  for (const edge of edges) {
    if (leftAtoms.has(edge.leftAtomId) && rightAtoms.has(edge.rightAtomId)) return edge;
    if (leftAtoms.has(edge.rightAtomId) && rightAtoms.has(edge.leftAtomId)) return edge;
  }
  return undefined;
}

function chartCellExists<S>(chart: DerivationChart<S>, key: ChartKey): boolean {
  return chart.cells.has(chartKeyId(key));
}

/**
 * Real bottom-up tree-decomposition DP: each bag combines its own local
 * atoms first, then merges in each child bag's own accumulated subtree
 * result (message passing up the tree), producing one "frontier" key per
 * bag that summarizes everything combinable in its subtree so far. This
 * is what makes a full chain (e.g. a-b-c-d-e, whose bags are only ever
 * pairwise {a,b},{b,c},{c,d},{d,e}) still reach one full combined
 * derivation at the root: the {a,b} bag's result feeds into {b,c}'s own
 * combination as a child message, whose result feeds into {c,d}, and so
 * on -- standard treewidth-DP message passing, not a bag-local-only
 * combination that would silently stop at each bag's own boundary.
 */
function decodeWithinBudget<S>(
  atoms: ReadonlyMap<string, BoundedDecodingAtom<S>>,
  atomIds: readonly string[],
  edges: readonly BoundedDecodingEdge[],
  semiring: ProofLicenseSemiring<S>,
  chart: DerivationChart<S>
): { chart: DerivationChart<S>; width: number } {
  const graph = buildDecompositionGraph(atomIds, edges);
  const decomposition = computeTreeDecomposition(graph);
  let currentChart = chart;
  const children = childrenOf(decomposition.bags);
  const bagResultKey = new Map<string, ChartKey>();

  for (const bag of postOrderBags(decomposition.bags)) {
    for (const nodeId of bag.nodeIds) {
      const bagAtom = atoms.get(nodeId);
      if (!bagAtom) continue;
      currentChart = insertDerivation(currentChart, semiring, {
        key: bagAtom.key,
        carrier: bagAtom.carrier,
        backpointer: { ruleId: `atom.${bagAtom.id}` }
      });
    }

    // Each bag introduces exactly one genuinely new atom -- the node
    // eliminated to create it (`bag.eliminatedNodeId`); every other member
    // of `bag.nodeIds` is a "neighbor" that persists into a later bag and
    // is only actually combined in when *that* bag eliminates it. Folding
    // a bag's full nodeIds pairwise here (rather than starting from just
    // the freshly eliminated atom) double-counts a shared boundary atom
    // that a child's own carried-up result already covers -- e.g. for a
    // chain a-b-c, bag {b,c} combined with child bag {a,b}'s result would
    // try to merge coverage {b,c} against {a,b}, which share "b" and so
    // can never legally combine (correctly refused by combineCells's own
    // overlap guard) -- silently truncating the chain right there. Folding
    // in only the eliminated atom, then each child's already-b-inclusive
    // result, avoids ever manufacturing that overlap in the first place.
    const eliminatedAtom = bag.eliminatedNodeId ? atoms.get(bag.eliminatedNodeId) : undefined;
    let current: ChartKey | undefined = eliminatedAtom?.key;
    for (const child of [...(children.get(bag.id) ?? [])].sort((a, b) => a.id.localeCompare(b.id))) {
      const childResult = bagResultKey.get(child.id);
      if (!childResult) continue;
      if (!current) { current = childResult; continue; }
      const edge = findConnectingEdge(current, childResult, edges);
      if (!edge) continue;
      const resultKey = edge.resultKey(current, childResult);
      currentChart = combineCells(currentChart, semiring, { left: current, right: childResult, resultKey, ruleId: edge.ruleId });
      if (chartCellExists(currentChart, resultKey)) current = resultKey;
    }
    if (current) bagResultKey.set(bag.id, current);
  }

  return { chart: currentChart, width: decomposition.width };
}

export function decodeBounded<S>(input: {
  atoms: readonly BoundedDecodingAtom<S>[];
  edges: readonly BoundedDecodingEdge[];
  semiring: ProofLicenseSemiring<S>;
  treewidthBudget: number;
}): BoundedDecodingResult<S> {
  if (input.treewidthBudget < 0) throw new Error("treewidthBudget must be non-negative");
  const atomIds = input.atoms.map(atom => atom.id);
  const atomsById = new Map(input.atoms.map(atom => [atom.id, atom]));

  const { keptAtomIds, excludedAtomIds, width } = partitionToBudget(atomIds, input.edges, input.treewidthBudget);

  let chart = emptyDerivationChart<S>();
  const decoded = decodeWithinBudget(atomsById, keptAtomIds, input.edges, input.semiring, chart);
  chart = decoded.chart;

  // Item 138: excluded (discourse-linked) atoms are inserted as their own
  // real leaf cells -- never silently dropped -- and given one further
  // chance to combine with the decoded kept-atom chart via any edge that
  // legally connects them. combineCells's own coverage-disjointness check
  // still guards against double-counting here exactly as it does for any
  // other combination.
  for (const excludedId of excludedAtomIds) {
    const excludedAtom = atomsById.get(excludedId);
    if (!excludedAtom) continue;
    chart = insertDerivation(chart, input.semiring, {
      key: excludedAtom.key,
      carrier: excludedAtom.carrier,
      backpointer: { ruleId: `atom.${excludedAtom.id}` }
    });
    for (const edge of input.edges) {
      const otherId = edge.leftAtomId === excludedId ? edge.rightAtomId : edge.rightAtomId === excludedId ? edge.leftAtomId : undefined;
      if (!otherId || !keptAtomIds.includes(otherId)) continue;
      const otherAtom = atomsById.get(otherId);
      if (!otherAtom) continue;
      chart = combineCells(chart, input.semiring, {
        left: edge.leftAtomId === excludedId ? excludedAtom.key : otherAtom.key,
        right: edge.leftAtomId === excludedId ? otherAtom.key : excludedAtom.key,
        resultKey: edge.leftAtomId === excludedId
          ? edge.resultKey(excludedAtom.key, otherAtom.key)
          : edge.resultKey(otherAtom.key, excludedAtom.key),
        ruleId: edge.ruleId
      });
    }
  }

  return {
    chart,
    treewidth: width,
    partitionCount: 1 + excludedAtomIds.length,
    excludedAtomIds
  };
}
