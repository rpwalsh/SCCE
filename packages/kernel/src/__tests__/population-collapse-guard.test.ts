import { describe, expect, it } from "vitest";
import {
  evaluatePopulationCollapseGuard,
  jensenShannonDistance,
  jensenShannonDivergence
} from "../population-collapse-guard.js";

describe("Jensen-Shannon divergence (plan item 104)", () => {
  it("is zero for identical distributions", () => {
    expect(jensenShannonDivergence([1, 2, 3, 4], [1, 2, 3, 4])).toBeCloseTo(0, 9);
  });

  it("is symmetric", () => {
    const left = [5, 0, 1, 0];
    const right = [0, 4, 0, 2];
    expect(jensenShannonDivergence(left, right)).toBeCloseTo(jensenShannonDivergence(right, left), 12);
  });

  it("is bounded in [0, 1] (log2 base) for disjoint-support distributions", () => {
    const divergence = jensenShannonDivergence([10, 0, 0], [0, 0, 10]);
    expect(divergence).toBeCloseTo(1, 9);
  });

  it("jensenShannonDistance is the square root of the divergence and satisfies the triangle inequality on a real triple", () => {
    const a = [10, 0, 0, 0];
    const b = [0, 10, 0, 0];
    const c = [0, 0, 10, 0];
    expect(jensenShannonDistance(a, b)).toBeCloseTo(Math.sqrt(jensenShannonDivergence(a, b)), 12);
    expect(jensenShannonDistance(a, c)).toBeLessThanOrEqual(jensenShannonDistance(a, b) + jensenShannonDistance(b, c) + 1e-9);
  });

  it("handles all-zero distributions without dividing by zero", () => {
    expect(jensenShannonDivergence([0, 0, 0], [0, 0, 0])).toBe(0);
  });
});

describe("population collapse guard (plan item 105): distinct registers/scripts with superficial overlap stay separate", () => {
  it("keeps two genuinely distinct feature distributions separate even when they share overlap features with equal weight", () => {
    // Simulated feature vectors over a shared feature space:
    // index 0-1: shared "overlap" features (e.g. digits, punctuation) --
    //   present with equal weight in both, the superficial overlap.
    // index 2-4: register/script-specific dominant features, entirely
    //   disjoint between the two populations -- the real signal.
    const formalEnglishProse = [5, 5, 40, 30, 20, 0, 0, 0];
    const russianCyrillicChat = [5, 5, 0, 0, 0, 25, 35, 30];

    const result = evaluatePopulationCollapseGuard(formalEnglishProse, russianCyrillicChat);
    expect(result.distinct).toBe(true);
    expect(result.divergence).toBeGreaterThan(0.3);
  });

  it("treats two samples of the same underlying population as one, not artificially split", () => {
    const sampleA = [12, 8, 30, 25, 15, 0, 0, 0];
    const sampleB = [10, 9, 32, 24, 14, 0, 0, 0];
    const result = evaluatePopulationCollapseGuard(sampleA, sampleB);
    expect(result.distinct).toBe(false);
    expect(result.divergence).toBeLessThan(result.minimumDivergence);
  });

  it("the distinctness threshold is configurable and monotonic in the divergence value", () => {
    const left = [8, 2, 0];
    const right = [2, 8, 0];
    const lenient = evaluatePopulationCollapseGuard(left, right, { minimumDivergence: 0.9 });
    const strict = evaluatePopulationCollapseGuard(left, right, { minimumDivergence: 0.01 });
    expect(lenient.divergence).toBe(strict.divergence);
    expect(strict.distinct).toBe(true);
    expect(lenient.distinct).toBe(false);
  });
});
