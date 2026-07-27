import { describe, expect, it } from "vitest";
import {
  chartCell,
  chartKeyId,
  combineCells,
  emptyDerivationChart,
  extractDerivations,
  insertDerivation,
  type ChartKey
} from "../derivation-chart.js";
import { createProofLicenseSemiring, viterbiLogSemiring } from "../proof-license-semiring.js";

// A small, real proof-license state: the set of atom ids this derivation
// depends on. "a" and "x" are mutually exclusive, matching the same
// convention used in proof-license-semiring.test.ts.
function makeSemiring() {
  return createProofLicenseSemiring<ReadonlySet<string>>({
    base: viterbiLogSemiring,
    stateKey: state => [...state].sort().join(","),
    emptyState: new Set(),
    unionStates: (left, right) => {
      const unioned = new Set([...left, ...right]);
      return unioned.has("a") && unioned.has("x") ? undefined : unioned;
    },
    isSupported: state => !state.has("banned")
  });
}

function leafKey(coverage: string): ChartKey {
  return { coverage, discourseStateId: "d0", populationId: "p0" };
}

function singletonCarrier(semiring: ReturnType<typeof makeSemiring>, state: ReadonlySet<string>, value: number) {
  return semiring.add(semiring.zero, new Map([[[...state].sort().join(","), { state, value }]]));
}

describe("packed derivation chart (plan items 131-132, 136)", () => {
  it("inserting two derivations at the same key combines them via the semiring's add, never storing a duplicate cell", () => {
    const semiring = makeSemiring();
    let chart = emptyDerivationChart<ReadonlySet<string>>();
    const key = leafKey("fact:1");
    chart = insertDerivation(chart, semiring, {
      key,
      carrier: singletonCarrier(semiring, new Set(["b"]), -1),
      backpointer: { ruleId: "lex:1" }
    });
    chart = insertDerivation(chart, semiring, {
      key,
      carrier: singletonCarrier(semiring, new Set(["b"]), -0.5),
      backpointer: { ruleId: "lex:2" }
    });
    expect(chart.cells.size).toBe(1);
    const cell = chartCell(chart, key)!;
    expect(cell.backpointers.map(bp => bp.ruleId).sort()).toEqual(["lex:1", "lex:2"]);
    // viterbi add = max(-1, -0.5) = -0.5
    expect(cell.carrier.get("b")?.value).toBeCloseTo(-0.5, 12);
  });

  it("combining two cells produces a new cell via the semiring's multiply, with a backpointer to both sources", () => {
    const semiring = makeSemiring();
    let chart = emptyDerivationChart<ReadonlySet<string>>();
    const left = leafKey("fact:1");
    const right = leafKey("fact:2");
    chart = insertDerivation(chart, semiring, { key: left, carrier: singletonCarrier(semiring, new Set(["b"]), -1), backpointer: { ruleId: "lex:1" } });
    chart = insertDerivation(chart, semiring, { key: right, carrier: singletonCarrier(semiring, new Set(["c"]), -2), backpointer: { ruleId: "lex:2" } });

    const combinedKey: ChartKey = { coverage: "fact:1,fact:2", discourseStateId: "d0", populationId: "p0" };
    chart = combineCells(chart, semiring, { left, right, resultKey: combinedKey, ruleId: "combine:1" });

    const cell = chartCell(chart, combinedKey)!;
    expect(cell).toBeDefined();
    expect(cell.backpointers).toEqual([{ ruleId: "combine:1", leftKeyId: expect.any(String), rightKeyId: expect.any(String) }]);
    // multiply: -1 + -2 = -3, unioned state {b,c}
    expect(cell.carrier.get("b,c")?.value).toBeCloseTo(-3, 12);
  });

  it("prunes an unsupported combination inside decoding -- it is never inserted into the chart at all, not merely flagged", () => {
    const semiring = makeSemiring();
    let chart = emptyDerivationChart<ReadonlySet<string>>();
    const left = leafKey("fact:a");
    const right = leafKey("fact:x");
    // "a" and "x" are mutually exclusive proof requirements.
    chart = insertDerivation(chart, semiring, { key: left, carrier: singletonCarrier(semiring, new Set(["a"]), 0), backpointer: { ruleId: "lex:a" } });
    chart = insertDerivation(chart, semiring, { key: right, carrier: singletonCarrier(semiring, new Set(["x"]), 0), backpointer: { ruleId: "lex:x" } });

    const cellsBefore = chart.cells.size;
    const combinedKey: ChartKey = { coverage: "fact:a,fact:x", discourseStateId: "d0", populationId: "p0" };
    chart = combineCells(chart, semiring, { left, right, resultKey: combinedKey, ruleId: "combine:invalid" });

    expect(chart.cells.size).toBe(cellsBefore);
    expect(chartCell(chart, combinedKey)).toBeUndefined();
  });

  it("combining against a nonexistent cell is a real no-op, not a crash", () => {
    const semiring = makeSemiring();
    const chart = emptyDerivationChart<ReadonlySet<string>>();
    const result = combineCells(chart, semiring, {
      left: leafKey("missing:1"),
      right: leafKey("missing:2"),
      resultKey: leafKey("result"),
      ruleId: "combine:x"
    });
    expect(result.cells.size).toBe(0);
  });
});

describe("k-best extraction reuses shared sub-derivations rather than recomputing them (plan item 132)", () => {
  it("refuses to combine two branches whose coverage already overlaps -- this would double-count the shared fact", () => {
    // Real chart parsing requires combined constituents' coverage to
    // partition, not overlap -- exactly like requiring disjoint spans in
    // CYK parsing. Two branches that both already depend on "shared:fact"
    // cannot be validly combined into one wider derivation: doing so
    // would make that fact appear twice in the extracted trace, which is
    // real evidence duplication, not "graph-complete decoding".
    const semiring = makeSemiring();
    let chart = emptyDerivationChart<ReadonlySet<string>>();
    const shared = leafKey("shared:fact");
    const branchA = leafKey("branch:a");
    const branchB = leafKey("branch:b");
    chart = insertDerivation(chart, semiring, { key: shared, carrier: singletonCarrier(semiring, new Set(["s"]), 0), backpointer: { ruleId: "lex:shared" } });
    chart = insertDerivation(chart, semiring, { key: branchA, carrier: singletonCarrier(semiring, new Set(["p"]), 0), backpointer: { ruleId: "lex:a" } });
    chart = insertDerivation(chart, semiring, { key: branchB, carrier: singletonCarrier(semiring, new Set(["q"]), 0), backpointer: { ruleId: "lex:b" } });

    const leftGoal: ChartKey = { coverage: "shared:fact,branch:a", discourseStateId: "d0", populationId: "p0" };
    chart = combineCells(chart, semiring, { left: shared, right: branchA, resultKey: leftGoal, ruleId: "combine:left" });
    const rightGoal: ChartKey = { coverage: "shared:fact,branch:b", discourseStateId: "d0", populationId: "p0" };
    chart = combineCells(chart, semiring, { left: shared, right: branchB, resultKey: rightGoal, ruleId: "combine:right" });

    const cellsBeforeInvalidCombine = chart.cells.size;
    const topGoal: ChartKey = { coverage: "shared:fact,branch:a,branch:b", discourseStateId: "d0", populationId: "p0" };
    chart = combineCells(chart, semiring, { left: leftGoal, right: rightGoal, resultKey: topGoal, ruleId: "combine:top" });

    expect(chart.cells.size).toBe(cellsBeforeInvalidCombine);
    expect(chartCell(chart, topGoal)).toBeUndefined();
  });

  it("the same underlying cell is stored exactly once and reused by two separate, non-overlapping final goals -- the real shared-storage guarantee", () => {
    const semiring = makeSemiring();
    let chart = emptyDerivationChart<ReadonlySet<string>>();
    const shared = leafKey("shared:fact");
    const branchA = leafKey("branch:a");
    const branchB = leafKey("branch:b");
    chart = insertDerivation(chart, semiring, { key: shared, carrier: singletonCarrier(semiring, new Set(["s"]), 0), backpointer: { ruleId: "lex:shared" } });
    chart = insertDerivation(chart, semiring, { key: branchA, carrier: singletonCarrier(semiring, new Set(["p"]), 0), backpointer: { ruleId: "lex:a" } });
    chart = insertDerivation(chart, semiring, { key: branchB, carrier: singletonCarrier(semiring, new Set(["q"]), 0), backpointer: { ruleId: "lex:b" } });

    // Two independent final goals, each combining the *same* stored
    // "shared" cell with a different, disjoint branch -- neither combine
    // touches the other, so neither is invalid, and "shared" is read from
    // the chart (never re-inserted or recomputed) both times.
    const goalA: ChartKey = { coverage: "shared:fact,branch:a", discourseStateId: "d0", populationId: "p0" };
    chart = combineCells(chart, semiring, { left: shared, right: branchA, resultKey: goalA, ruleId: "combine:a" });
    const goalB: ChartKey = { coverage: "shared:fact,branch:b", discourseStateId: "d0", populationId: "p0" };
    chart = combineCells(chart, semiring, { left: shared, right: branchB, resultKey: goalB, ruleId: "combine:b" });

    // Exactly one cell for "shared", plus one each for branchA/branchB/
    // goalA/goalB -- five total, never a duplicate "shared" entry despite
    // being used twice.
    expect(chart.cells.size).toBe(5);

    const derivationsA = extractDerivations(chart, goalA);
    const derivationsB = extractDerivations(chart, goalB);
    // Each individual derivation is internally consistent (no fact
    // double-counted within it) and the real "nothing flattened" proof
    // (item 139): both original leaves it depends on are individually
    // recoverable, not collapsed into an opaque combined blob.
    expect(derivationsA[0]!.leafKeyIds.sort()).toEqual([shared, branchA].map(chartKeyId).sort());
    expect(derivationsB[0]!.leafKeyIds.sort()).toEqual([shared, branchB].map(chartKeyId).sort());
  });

  it("bounds the number of extracted derivations at maxDerivations, a real finite cap", () => {
    const semiring = makeSemiring();
    let chart = emptyDerivationChart<ReadonlySet<string>>();
    const key = leafKey("multi");
    for (let index = 0; index < 10; index++) {
      chart = insertDerivation(chart, semiring, {
        key,
        carrier: singletonCarrier(semiring, new Set([`b${index}`]), -index),
        backpointer: { ruleId: `lex:${index}` }
      });
    }
    const derivations = extractDerivations(chart, key, 4);
    expect(derivations.length).toBeLessThanOrEqual(4);
  });

  it("returns no derivations for a goal key that was never inserted", () => {
    const semiring = makeSemiring();
    const chart = emptyDerivationChart<ReadonlySet<string>>();
    expect(extractDerivations(chart, leafKey("never-inserted"))).toEqual([]);
  });
});
