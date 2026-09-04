// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
import { describe, expect, it } from "vitest";
import {
  estimateAlignmentCostMs,
  estimateKneserNeyGenerationCostMs,
  estimateRetrievalCostMs
} from "../index.js";

describe("runtime cost estimates (plan item L10)", () => {
  it("estimateRetrievalCostMs stays close to the measured hybridRecall cold-call bound and scales monotonically", () => {
    // Measured cold-call wall time at these exact pool sizes (see
    // runtime-cost-estimate.ts's doc comment for the full benchmark):
    // 100 -> 25.3ms, 500 -> 68.3ms, 1500 -> 154.6ms, 3000 -> 305.7ms.
    // The estimate must stay an upper bound (never under-price real cost)
    // while not being wildly over-generous.
    const measured: Array<[number, number]> = [[100, 25.3], [500, 68.3], [1500, 154.6], [3000, 305.7]];
    for (const [count, measuredMs] of measured) {
      const estimate = estimateRetrievalCostMs(count);
      expect(estimate).toBeGreaterThanOrEqual(measuredMs * 0.8);
      expect(estimate).toBeLessThan(measuredMs * 2.5);
    }
    expect(estimateRetrievalCostMs(0)).toBeGreaterThan(0);
    expect(estimateRetrievalCostMs(100)).toBeLessThan(estimateRetrievalCostMs(1000));
    expect(estimateRetrievalCostMs(1000)).toBeLessThan(estimateRetrievalCostMs(10_000));
  });

  it("estimateKneserNeyGenerationCostMs stays a small, non-negative constant regardless of extent, matching measured flat scaling", () => {
    // Measured continueBoundedProse wall time: 20 -> 4.3ms, 80 -> 2.1ms,
    // 200 -> 1.9ms, 400 -> 1.8ms -- dominated by fixed per-call cost, not
    // per-symbol scaling, so the estimate is deliberately flat.
    for (const extent of [1, 20, 80, 200, 400, 4000]) {
      const estimate = estimateKneserNeyGenerationCostMs(extent);
      expect(estimate).toBeGreaterThan(0);
      expect(estimate).toBeLessThan(50);
    }
    expect(estimateKneserNeyGenerationCostMs(20)).toBe(estimateKneserNeyGenerationCostMs(400));
  });

  it("estimateAlignmentCostMs matches the measured buildSurfaceLattice scaling across the real benchmark range", () => {
    // Measured directly against real corpus text after the L-phase
    // quadratic-cost fixes: 2K->245ms, 8K->407ms, 16K->737ms, 32K->1228ms,
    // 64K->2376ms, 103K->4369ms.
    const measured: Array<[number, number]> = [
      [2_000, 245], [8_000, 407], [16_000, 737], [32_000, 1228], [64_000, 2376], [103_000, 4369]
    ];
    for (const [chars, measuredMs] of measured) {
      const estimate = estimateAlignmentCostMs(chars);
      expect(estimate).toBeGreaterThanOrEqual(measuredMs * 0.5);
      expect(estimate).toBeLessThan(measuredMs * 3);
    }
    expect(estimateAlignmentCostMs(0)).toBeGreaterThan(0);
    expect(estimateAlignmentCostMs(1_000)).toBeLessThan(estimateAlignmentCostMs(50_000));
  });

  it("every estimator is non-negative and finite for negative, NaN, or non-finite input", () => {
    for (const bad of [-1, Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
      expect(Number.isFinite(estimateRetrievalCostMs(bad))).toBe(true);
      expect(estimateRetrievalCostMs(bad)).toBeGreaterThanOrEqual(0);
      expect(Number.isFinite(estimateAlignmentCostMs(bad))).toBe(true);
      expect(estimateAlignmentCostMs(bad)).toBeGreaterThanOrEqual(0);
      expect(Number.isFinite(estimateKneserNeyGenerationCostMs(bad))).toBe(true);
      expect(estimateKneserNeyGenerationCostMs(bad)).toBeGreaterThanOrEqual(0);
    }
  });
});
