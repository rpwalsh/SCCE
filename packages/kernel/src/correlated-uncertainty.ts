import { clamp01 } from "./primitives.js";

/**
 * Plan items 167-168. A structured representation for combining two or
 * more confidence/probability scalars WITHOUT silently assuming they are
 * statistically independent. Naive `a * b` picks one specific point out of
 * a whole range of honest possibilities: if the two quantities happen to
 * be measuring overlapping evidence (two hops of the same causal chain, two
 * scores derived from the same underlying signal), the true joint value can
 * be as high as `min(a, b)` (full positive dependence -- one is redundant
 * with the other) or as low as `max(0, a + b - 1)` (full negative
 * dependence -- these are the Frechet-Hoeffding bounds on P(A n B) given
 * only the marginals P(A)=a, P(B)=b, with no assumption about how A and B
 * relate). `a * b` always lies inside that interval, but reporting it alone
 * silently discards the fact that the true value could be anywhere else in
 * the range -- exactly the kind of overclaimed-or-underclaimed confidence
 * this codebase's honesty discipline elsewhere (assistant-force.ts,
 * walsh-surface-energy.ts) already refuses to allow for answer text.
 */

export interface UncertaintyInterval {
  lower: number;
  upper: number;
}

/**
 * The single-scalar reduction to use when a caller genuinely needs one
 * number (e.g. to rank/prune candidates). The midpoint is used rather than
 * either bound so the reduction does not systematically over- or
 * under-claim relative to the true (unknown) correlation -- picking the
 * lower bound always would systematically underclaim whenever the
 * quantities really are correlated; picking the upper bound always would
 * systematically overclaim whenever they really are independent or
 * negatively correlated.
 */
export function midpointConfidence(interval: UncertaintyInterval): number {
  return (interval.lower + interval.upper) / 2;
}

/**
 * Extends an already-accumulated correlated-confidence interval with one
 * more marginal confidence scalar, via the Frechet-Hoeffding bounds -- the
 * core primitive both `combineCorrelatedConfidence` and
 * `chainCorrelatedConfidence` reduce to.
 */
export function extendCorrelatedConfidence(interval: UncertaintyInterval, next: number): UncertaintyInterval {
  const value = clamp01(next);
  return {
    lower: Math.max(0, interval.lower + value - 1),
    upper: Math.min(interval.upper, value)
  };
}

/** Frechet-Hoeffding bounds for combining two confidence scalars with unknown (possibly correlated) dependence. */
export function combineCorrelatedConfidence(a: number, b: number): UncertaintyInterval {
  const clampedA = clamp01(a);
  return extendCorrelatedConfidence({ lower: clampedA, upper: clampedA }, b);
}

/**
 * Chains `extendCorrelatedConfidence` across an ordered sequence of
 * confidence scalars (e.g. one per hop of a causal path) without ever
 * collapsing to their independent product -- the honest upper bound after
 * chaining is always the minimum of the sequence (a chain's confidence
 * cannot honestly exceed its least-confident link, even under the most
 * favorable possible correlation), which is frequently well above what
 * naive multiplication would report for a long chain.
 */
export function chainCorrelatedConfidence(sequence: readonly number[]): UncertaintyInterval {
  if (!sequence.length) return { lower: 1, upper: 1 };
  const first = clamp01(sequence[0]!);
  let interval: UncertaintyInterval = { lower: first, upper: first };
  for (let index = 1; index < sequence.length; index++) {
    interval = extendCorrelatedConfidence(interval, sequence[index]!);
  }
  return interval;
}

/**
 * The alternative structured-uncertainty representation plan item 167
 * offers: a finite set of named, mutually exclusive hypotheses each
 * carrying an explicit probability mass, rather than one collapsed scalar.
 */
export interface FiniteHypothesis {
  id: string;
  mass: number;
}

export interface FiniteHypothesisSet {
  hypotheses: FiniteHypothesis[];
  /** Mass not assigned to any named hypothesis -- "something else, unmodeled" -- rather than forcing named hypotheses to fabricate coverage of the full space. */
  unallocatedMass: number;
}

/** Builds a valid FiniteHypothesisSet from raw masses: negative masses are floored at 0, and masses summing above 1 are rescaled down rather than left to silently overclaim total certainty. */
export function normalizeHypothesisSet(raw: readonly FiniteHypothesis[]): FiniteHypothesisSet {
  const floored = raw.map(hypothesis => ({ id: hypothesis.id, mass: Math.max(0, hypothesis.mass) }));
  const total = floored.reduce((sum, hypothesis) => sum + hypothesis.mass, 0);
  if (total <= 1) return { hypotheses: floored, unallocatedMass: clamp01(1 - total) };
  return { hypotheses: floored.map(hypothesis => ({ id: hypothesis.id, mass: hypothesis.mass / total })), unallocatedMass: 0 };
}

export function mostLikelyHypothesis(set: FiniteHypothesisSet): FiniteHypothesis | undefined {
  return [...set.hypotheses].sort((left, right) => right.mass - left.mass || left.id.localeCompare(right.id))[0];
}
