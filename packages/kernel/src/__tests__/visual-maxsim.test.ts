// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
import { describe, expect, it } from "vitest";
import { maxSimScore } from "../runtime-graph-retrieval.js";

describe("late-interaction MaxSim", () => {
  it("picks the best-matching region, not the average", () => {
    expect(maxSimScore([1, 0], [[0, 1], [0.6, 0.8], [1, 0]])).toBeCloseTo(1);
    expect(maxSimScore([1, 0], [[0, 1]])).toBeCloseTo(0);
    expect(maxSimScore([1, 0], [])).toBe(0);
  });
});
