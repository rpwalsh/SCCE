import { clamp01 } from "./primitives.js";

/**
 * Plan items 104-105. Jensen-Shannon divergence between two feature-weight
 * distributions over the same (aligned) feature space, plus a guard that
 * uses it to decide whether two candidate populations are genuinely
 * distinct or should be treated as one. Inputs are raw non-negative
 * weights (e.g. feature counts), not pre-normalized probabilities --
 * matching `primitives.ts`'s `entropy()` convention -- normalized
 * internally. Uses log2 (bits), so divergence is bounded in `[0, 1]` and
 * `sqrt(divergence)` (the Jensen-Shannon *distance*) is a real metric.
 *
 * This is deliberately a general statistical primitive, not wired into
 * any specific caller yet -- `segmentation-population.ts` and
 * `opaque-role-induction.ts` already have their own MDL-based population
 * selection with source-family-disjoint held-out evaluation, which is a
 * stronger guarantee than a JS-divergence threshold alone. This module
 * exists for callers (construction-grammar population selection per item
 * 104, or any future population-style clustering) that need a symmetric,
 * bounded divergence measure specifically, not a replacement for MDL
 * selection where that already exists.
 */

export interface PopulationCollapseGuardResult {
  divergence: number;
  distance: number;
  distinct: boolean;
  minimumDivergence: number;
}

const DEFAULT_MINIMUM_DIVERGENCE = 0.05;

export function jensenShannonDivergence(left: readonly number[], right: readonly number[]): number {
  const width = Math.max(left.length, right.length);
  const p = normalizedWeights(left, width);
  const q = normalizedWeights(right, width);
  const m = p.map((value, index) => (value + q[index]!) / 2);
  return clamp01(0.5 * klDivergenceBits(p, m) + 0.5 * klDivergenceBits(q, m));
}

export function jensenShannonDistance(left: readonly number[], right: readonly number[]): number {
  return Math.sqrt(jensenShannonDivergence(left, right));
}

export function evaluatePopulationCollapseGuard(
  left: readonly number[],
  right: readonly number[],
  options: { minimumDivergence?: number } = {}
): PopulationCollapseGuardResult {
  const minimumDivergence = options.minimumDivergence ?? DEFAULT_MINIMUM_DIVERGENCE;
  const divergence = jensenShannonDivergence(left, right);
  return {
    divergence,
    distance: Math.sqrt(divergence),
    distinct: divergence >= minimumDivergence,
    minimumDivergence
  };
}

function normalizedWeights(values: readonly number[], width: number): number[] {
  const padded = Array.from({ length: width }, (_, index) => Math.max(0, values[index] ?? 0));
  const total = padded.reduce((sum, value) => sum + value, 0);
  if (total <= 0) return padded.map(() => 0);
  return padded.map(value => value / total);
}

function klDivergenceBits(p: readonly number[], m: readonly number[]): number {
  let divergence = 0;
  for (let index = 0; index < p.length; index++) {
    const pi = p[index]!;
    if (pi <= 0) continue;
    const mi = m[index]!;
    // mi === 0 is unreachable whenever pi > 0, since m = (p+q)/2 >= p/2 > 0
    // at that index -- kept as an explicit guard rather than a silent NaN.
    if (mi <= 0) throw new Error("jensenShannonDivergence: unreachable zero mixture density under positive component density");
    divergence += pi * Math.log2(pi / mi);
  }
  return divergence;
}
