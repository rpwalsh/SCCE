import { describe, expect, it } from "vitest";
import {
  chainCorrelatedConfidence,
  combineCorrelatedConfidence,
  midpointConfidence,
  mostLikelyHypothesis,
  normalizeHypothesisSet
} from "../correlated-uncertainty.js";

describe("combineCorrelatedConfidence", () => {
  it("returns the real Frechet-Hoeffding bounds, not the independent-assumption product", () => {
    const interval = combineCorrelatedConfidence(0.9, 0.4);
    expect(interval.lower).toBeCloseTo(0.3, 10);
    expect(interval.upper).toBeCloseTo(0.4, 10);
    const independentProduct = 0.9 * 0.4;
    expect(independentProduct).toBeGreaterThanOrEqual(interval.lower);
    expect(independentProduct).toBeLessThanOrEqual(interval.upper);
  });

  it("does not collapse two fully-correlated (same-evidence-derived) confidences to their independent product", () => {
    // Two scores measuring the same underlying claim twice (e.g. two hops
    // of a causal chain built from overlapping evidence) can be fully
    // redundant -- the true joint probability in that case is min(a, b),
    // not a * b. Item 168's requirement: the representation must retain
    // this possibility rather than silently reporting the lower,
    // independence-assumed value as if it were certain.
    const interval = combineCorrelatedConfidence(0.9, 0.9);
    const independentProduct = 0.9 * 0.9;
    expect(interval.upper).toBeCloseTo(0.9, 10);
    expect(interval.upper).toBeGreaterThan(independentProduct);
    expect(interval.lower).toBeLessThan(interval.upper);
  });

  it("clamps out-of-range inputs into [0,1] before combining", () => {
    const interval = combineCorrelatedConfidence(1.4, -0.2);
    expect(interval.lower).toBeGreaterThanOrEqual(0);
    expect(interval.upper).toBeLessThanOrEqual(1);
  });
});

describe("chainCorrelatedConfidence", () => {
  it("bounds a chain's confidence by its weakest link, not the shrinking independent product", () => {
    const sequence = [0.9, 0.9, 0.9, 0.9, 0.9];
    const interval = chainCorrelatedConfidence(sequence);
    const naiveIndependentProduct = sequence.reduce((product, value) => product * value, 1);
    expect(interval.upper).toBeCloseTo(Math.min(...sequence), 10);
    expect(interval.upper).toBeGreaterThan(naiveIndependentProduct);
    expect(midpointConfidence(interval)).toBeGreaterThan(naiveIndependentProduct);
  });

  it("returns a degenerate certain interval for an empty sequence", () => {
    expect(chainCorrelatedConfidence([])).toEqual({ lower: 1, upper: 1 });
  });

  it("narrows toward 0 for a long chain of only moderately confident links, without ever exceeding any single link", () => {
    const interval = chainCorrelatedConfidence([0.6, 0.6, 0.6, 0.6, 0.6, 0.6]);
    expect(interval.lower).toBeGreaterThanOrEqual(0);
    expect(interval.upper).toBeLessThanOrEqual(0.6);
  });
});

describe("midpointConfidence", () => {
  it("is the unbiased single-scalar reduction of an interval", () => {
    expect(midpointConfidence({ lower: 0.2, upper: 0.8 })).toBeCloseTo(0.5, 10);
  });
});

describe("finite hypothesis sets", () => {
  it("normalizes masses that sum to less than 1 by reporting unallocated mass, not fabricating coverage", () => {
    const set = normalizeHypothesisSet([{ id: "a", mass: 0.3 }, { id: "b", mass: 0.2 }]);
    expect(set.hypotheses).toEqual([{ id: "a", mass: 0.3 }, { id: "b", mass: 0.2 }]);
    expect(set.unallocatedMass).toBeCloseTo(0.5, 10);
  });

  it("rescales masses that sum above 1 rather than overclaiming total certainty", () => {
    const set = normalizeHypothesisSet([{ id: "a", mass: 0.8 }, { id: "b", mass: 0.4 }]);
    expect(set.unallocatedMass).toBe(0);
    const total = set.hypotheses.reduce((sum, hypothesis) => sum + hypothesis.mass, 0);
    expect(total).toBeCloseTo(1, 10);
    expect(set.hypotheses.find(hypothesis => hypothesis.id === "a")!.mass).toBeGreaterThan(
      set.hypotheses.find(hypothesis => hypothesis.id === "b")!.mass
    );
  });

  it("floors negative masses at 0", () => {
    const set = normalizeHypothesisSet([{ id: "a", mass: -0.5 }, { id: "b", mass: 0.5 }]);
    expect(set.hypotheses.find(hypothesis => hypothesis.id === "a")!.mass).toBe(0);
  });

  it("picks the highest-mass hypothesis deterministically, breaking ties by id", () => {
    const set = normalizeHypothesisSet([{ id: "b", mass: 0.3 }, { id: "a", mass: 0.3 }]);
    expect(mostLikelyHypothesis(set)?.id).toBe("a");
  });

  it("returns undefined for an empty hypothesis set", () => {
    expect(mostLikelyHypothesis(normalizeHypothesisSet([]))).toBeUndefined();
  });
});
