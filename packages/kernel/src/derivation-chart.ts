import type { ProofLicenseCarrier, ProofLicenseSemiring } from "./proof-license-semiring.js";

/**
 * Plan items 131-132, 136, 139. A packed graph-derivation forest chart:
 * one cell per distinct (coverage, discourse-state, population) key
 * (proof-license state lives inside the semiring carrier at each cell, so
 * the full key space matches the plan's "graph boundary, discourse state,
 * population, required coverage, and proof-license state"). Built on
 * `proof-license-semiring.ts` rather than inventing a parallel scoring
 * mechanism -- combining two cells is exactly the semiring's `multiply`,
 * so pruning of unsupported combinations (item 136) and correct
 * proof-license tracking come from that module, not reimplemented here.
 *
 * Shared-subderivation storage (item 132) is structural, not a rule this
 * module has to remember: a chart is a `Map` keyed by chart-key id, so
 * there is exactly one cell per distinct key ever, and k-best extraction
 * memoizes per cell rather than re-walking a shared sub-derivation.
 */

export interface ChartKey {
  /** Canonical, already-sorted coverage-set signature (e.g. sorted comma-joined covered-atom ids). */
  coverage: string;
  discourseStateId: string;
  populationId: string;
}

export function chartKeyId(key: ChartKey): string {
  return `${key.coverage}${key.discourseStateId}${key.populationId}`;
}

export interface ChartBackpointer {
  ruleId: string;
  leftKeyId?: string;
  rightKeyId?: string;
}

export interface ChartCell<S> {
  key: ChartKey;
  carrier: ProofLicenseCarrier<S>;
  backpointers: ChartBackpointer[];
}

export interface DerivationChart<S> {
  cells: Map<string, ChartCell<S>>;
}

export function emptyDerivationChart<S>(): DerivationChart<S> {
  return { cells: new Map() };
}

export interface InsertDerivationInput<S> {
  key: ChartKey;
  carrier: ProofLicenseCarrier<S>;
  backpointer: ChartBackpointer;
}

function backpointerKey(backpointer: ChartBackpointer): string {
  return `${backpointer.ruleId}${backpointer.leftKeyId ?? ""}${backpointer.rightKeyId ?? ""}`;
}

/**
 * Inserts a derivation at `key`. A cell already present at this exact key
 * is combined via the semiring's `add` (alternative derivations of the
 * same cell) rather than stored as a second, duplicate cell -- this is
 * the literal meaning of "no duplicate identical work" for insertion.
 */
export function insertDerivation<S>(
  chart: DerivationChart<S>,
  semiring: ProofLicenseSemiring<S>,
  input: InsertDerivationInput<S>
): DerivationChart<S> {
  const keyId = chartKeyId(input.key);
  const existing = chart.cells.get(keyId);
  const cells = new Map(chart.cells);
  if (!existing) {
    cells.set(keyId, { key: input.key, carrier: input.carrier, backpointers: [input.backpointer] });
    return { cells };
  }
  const combinedCarrier = semiring.add(existing.carrier, input.carrier);
  const seen = new Set(existing.backpointers.map(backpointerKey));
  const backpointers = seen.has(backpointerKey(input.backpointer))
    ? existing.backpointers
    : [...existing.backpointers, input.backpointer];
  cells.set(keyId, { key: existing.key, carrier: combinedCarrier, backpointers });
  return { cells };
}

export interface CombineCellsInput {
  left: ChartKey;
  right: ChartKey;
  resultKey: ChartKey;
  ruleId: string;
}

function coverageSet(coverage: string): Set<string> {
  return new Set(coverage.split(",").filter(Boolean));
}

/**
 * Combines two existing cells under a rule via the semiring's `multiply`.
 * Refuses (no-op, same as an unsupported combination) when the two cells'
 * coverage sets overlap -- exactly the reason real chart parsing requires
 * combined constituents' spans to partition rather than overlap: without
 * this, the same underlying fact could be pulled into a wider derivation
 * through two different sub-branches and end up double-counted in the
 * extracted trace, which is real evidence duplication, not "graph-complete
 * decoding". If the combination is unsupported (overlapping coverage, the
 * semiring's own incompatible-proof-license rejection, or the result
 * simply carries no supported state) it is never inserted into the chart
 * at all -- pruned *inside* decoding, not flagged after the fact (item
 * 136): there is no intermediate "insert then filter" step.
 */
export function combineCells<S>(
  chart: DerivationChart<S>,
  semiring: ProofLicenseSemiring<S>,
  input: CombineCellsInput
): DerivationChart<S> {
  const leftCell = chart.cells.get(chartKeyId(input.left));
  const rightCell = chart.cells.get(chartKeyId(input.right));
  if (!leftCell || !rightCell) return chart;
  const leftCoverage = coverageSet(input.left.coverage);
  const rightCoverage = coverageSet(input.right.coverage);
  for (const item of leftCoverage) if (rightCoverage.has(item)) return chart;
  const combined = semiring.multiply(leftCell.carrier, rightCell.carrier);
  if (combined.size === 0) return chart;
  return insertDerivation(chart, semiring, {
    key: input.resultKey,
    carrier: combined,
    backpointer: { ruleId: input.ruleId, leftKeyId: chartKeyId(input.left), rightKeyId: chartKeyId(input.right) }
  });
}

export function chartCell<S>(chart: DerivationChart<S>, key: ChartKey): ChartCell<S> | undefined {
  return chart.cells.get(chartKeyId(key));
}

export interface ExtractedDerivation {
  ruleIds: string[];
  /** Every base-case (leaf, no-backpointer-parents) cell this derivation actually traces back to -- the real "nothing was flattened away" evidence for item 139. */
  leafKeyIds: string[];
}

/**
 * Walks backpointers from `goalKey`, memoized per cell -- a cell shared by
 * two different larger derivations is walked once, its result reused, not
 * recomputed (the extraction half of item 132's "no duplicate identical
 * work"). Bounded by `maxDerivations` (a real, finite k-best cap, not an
 * unbounded enumeration of every combinatorial path).
 */
export function extractDerivations<S>(
  chart: DerivationChart<S>,
  goalKey: ChartKey,
  maxDerivations = 16
): ExtractedDerivation[] {
  const memo = new Map<string, ExtractedDerivation[]>();

  function walk(keyId: string): ExtractedDerivation[] {
    const cached = memo.get(keyId);
    if (cached) return cached;
    const cell = chart.cells.get(keyId);
    if (!cell) return [];
    const out: ExtractedDerivation[] = [];
    outer: for (const backpointer of cell.backpointers) {
      if (!backpointer.leftKeyId && !backpointer.rightKeyId) {
        out.push({ ruleIds: [backpointer.ruleId], leafKeyIds: [keyId] });
        if (out.length >= maxDerivations) break;
        continue;
      }
      const leftDerivations = backpointer.leftKeyId ? walk(backpointer.leftKeyId) : [{ ruleIds: [], leafKeyIds: [] }];
      const rightDerivations = backpointer.rightKeyId ? walk(backpointer.rightKeyId) : [{ ruleIds: [], leafKeyIds: [] }];
      for (const left of leftDerivations) {
        for (const right of rightDerivations) {
          out.push({
            ruleIds: [...left.ruleIds, ...right.ruleIds, backpointer.ruleId],
            leafKeyIds: [...left.leafKeyIds, ...right.leafKeyIds]
          });
          if (out.length >= maxDerivations) break outer;
        }
      }
    }
    const bounded = out.slice(0, maxDerivations);
    memo.set(keyId, bounded);
    return bounded;
  }

  return walk(chartKeyId(goalKey));
}
