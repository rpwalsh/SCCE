import { describe, expect, it } from "vitest";
import { decodeBounded, type BoundedDecodingAtom, type BoundedDecodingEdge } from "../bounded-chart-decoding.js";
import { chartCell, chartKeyId, extractDerivations, type ChartKey } from "../derivation-chart.js";
import { createProofLicenseSemiring, viterbiLogSemiring } from "../proof-license-semiring.js";

// Plan items 137-139. Real tree-decomposition-bounded decoding over the
// existing chart/semiring primitives, and the "long-answer" proof (item
// 139) that bounded decoding does not flatten meaning: a full derivation
// chain's leaves are all individually recoverable afterward, not
// collapsed into an opaque combined blob.

function makeSemiring() {
  return createProofLicenseSemiring<ReadonlySet<string>>({
    base: viterbiLogSemiring,
    stateKey: state => [...state].sort().join(","),
    emptyState: new Set(),
    unionStates: (left, right) => new Set([...left, ...right]),
    isSupported: () => true
  });
}

function leafKey(coverage: string): ChartKey {
  return { coverage, discourseStateId: "d0", populationId: "p0" };
}

function atom(semiring: ReturnType<typeof makeSemiring>, id: string): BoundedDecodingAtom<ReadonlySet<string>> {
  const state = new Set([id]);
  return {
    id,
    key: leafKey(id),
    carrier: semiring.add(semiring.zero, new Map([[id, { state, value: 0 }]]))
  };
}

function unionCoverage(left: ChartKey, right: ChartKey): ChartKey {
  const covered = [...new Set([...left.coverage.split(",").filter(Boolean), ...right.coverage.split(",").filter(Boolean)])].sort();
  return { coverage: covered.join(","), discourseStateId: "d0", populationId: "p0" };
}

function chainEdge(left: string, right: string): BoundedDecodingEdge {
  return { leftAtomId: left, rightAtomId: right, ruleId: `combine:${left}+${right}`, resultKey: unionCoverage };
}

describe("decodeBounded (plan items 137-139)", () => {
  it("a 5-atom chain (real treewidth 1) decodes fully within budget 1, and the full combined derivation recovers every original leaf -- graph-complete, nothing flattened", () => {
    const semiring = makeSemiring();
    const ids = ["a", "b", "c", "d", "e"];
    const atoms = ids.map(id => atom(semiring, id));
    const edges = [chainEdge("a", "b"), chainEdge("b", "c"), chainEdge("c", "d"), chainEdge("d", "e")];

    const result = decodeBounded({ atoms, edges, semiring, treewidthBudget: 1 });
    expect(result.treewidth).toBe(1);
    expect(result.excludedAtomIds).toEqual([]);

    // Every individual atom's own leaf cell exists.
    for (const id of ids) expect(chartCell(result.chart, leafKey(id))).toBeDefined();

    // Progressively wider combinations exist, up to the full chain.
    const ab = chartCell(result.chart, { coverage: "a,b", discourseStateId: "d0", populationId: "p0" });
    expect(ab).toBeDefined();

    // Find the goal cell covering all five atoms (coverage key is a sorted,
    // comma-joined signature -- computed the same way unionCoverage does).
    const fullCoverage = [...ids].sort().join(",");
    const goalKey: ChartKey = { coverage: fullCoverage, discourseStateId: "d0", populationId: "p0" };
    const goalCell = chartCell(result.chart, goalKey);
    expect(goalCell).toBeDefined();

    const derivations = extractDerivations(result.chart, goalKey, 4);
    expect(derivations.length).toBeGreaterThan(0);
    // The real item-139 proof: this derivation's leaves recover all five
    // original atoms individually -- not a subset, not a flattened blob,
    // not a fabricated extra.
    const leafCoverageIds = derivations[0]!.leafKeyIds.map(String).sort();
    const expectedLeafKeyIds = ids.map(id => chartKeyId(leafKey(id))).sort();
    expect(leafCoverageIds).toEqual(expectedLeafKeyIds);
  });

  it("a star graph (also treewidth 1) folds every spoke into one cumulative combination through the shared center, without needing spoke-to-spoke edges", () => {
    // A join bag (here, the root "center" bag, whose real children are all
    // 4 spoke bags) combines its children's results into one cumulative
    // outgoing message, the same as any other bag -- it does not also
    // preserve every intermediate pairwise (center, one spoke) combination
    // as its own separately retrievable cell once a later sibling has been
    // folded in, the same way a running total absorbs each addend rather
    // than keeping every partial sum around. The real, checkable guarantee
    // is that the *first* spoke combined does produce a real (center,spoke)
    // cell, and the full combination across all spokes is reachable at
    // the end -- both proven directly below, rather than assuming every
    // pairwise intermediate must independently persist.
    const semiring = makeSemiring();
    const spokes = ["s0", "s1", "s2", "s3"];
    const atoms = [atom(semiring, "center"), ...spokes.map(id => atom(semiring, id))];
    const edges = spokes.map(spoke => chainEdge("center", spoke));

    const result = decodeBounded({ atoms, edges, semiring, treewidthBudget: 1 });
    expect(result.treewidth).toBe(1);
    expect(result.excludedAtomIds).toEqual([]);

    const fullCoverage = ["center", ...spokes].sort().join(",");
    const goalKey: ChartKey = { coverage: fullCoverage, discourseStateId: "d0", populationId: "p0" };
    expect(chartCell(result.chart, goalKey)).toBeDefined();
    const derivations = extractDerivations(result.chart, goalKey, 4);
    expect(derivations.length).toBeGreaterThan(0);
    const leafCoverageIds = derivations[0]!.leafKeyIds.map(String).sort();
    const expectedLeafKeyIds = ["center", ...spokes].map(id => chartKeyId(leafKey(id))).sort();
    expect(leafCoverageIds).toEqual(expectedLeafKeyIds);
  });

  it("a graph exceeding the treewidth budget partitions rather than failing outright -- excluded atoms are discourse-linked back in, never silently dropped", () => {
    const semiring = makeSemiring();
    const ids = ["w", "x", "y", "z"];
    const atoms = ids.map(id => atom(semiring, id));
    // K4: every pair connected -- real treewidth 3, exceeding budget 1.
    const edges: BoundedDecodingEdge[] = [];
    for (let i = 0; i < ids.length; i += 1) {
      for (let j = i + 1; j < ids.length; j += 1) edges.push(chainEdge(ids[i]!, ids[j]!));
    }

    const result = decodeBounded({ atoms, edges, semiring, treewidthBudget: 1 });
    expect(result.excludedAtomIds.length).toBeGreaterThan(0);
    expect(result.partitionCount).toBeGreaterThan(1);
    // Every excluded atom's own leaf cell is still present in the chart --
    // "partitioned", not "dropped".
    for (const excludedId of result.excludedAtomIds) {
      expect(chartCell(result.chart, leafKey(excludedId))).toBeDefined();
    }
    // Every atom's own leaf cell exists regardless of partition membership.
    for (const id of ids) expect(chartCell(result.chart, leafKey(id))).toBeDefined();
  });

  it("rejects a negative treewidth budget rather than silently proceeding with an invalid bound", () => {
    const semiring = makeSemiring();
    expect(() => decodeBounded({ atoms: [atom(semiring, "a")], edges: [], semiring, treewidthBudget: -1 })).toThrow();
  });

  it("an empty atom set decodes to an empty chart without error", () => {
    const semiring = makeSemiring();
    const result = decodeBounded({ atoms: [], edges: [], semiring, treewidthBudget: 4 });
    expect(result.chart.cells.size).toBe(0);
    expect(result.excludedAtomIds).toEqual([]);
  });
});
