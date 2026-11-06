// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
import { describe, expect, it } from "vitest";
import { estimateRuntimeGraphSliceBytes, fitRuntimeGraphSliceToBudget, type RuntimeGraphSliceValue } from "../runtime-graph-cache.js";

describe("graph slice resource allowance", () => {
  it("fits oversized small slices below the former count floors", () => {
    const value = {
      graph: { nodes: [{ id: "node", typeId: "type", features: [], evidenceIds: ["evidence"], representation: {}, metadata: {} }], edges: [], hyperedges: [], query: {} },
      evidence: [{ id: "evidence", sourceId: "source", sourceVersionId: "version", text: "x".repeat(100_000), features: [] }]
    } as unknown as RuntimeGraphSliceValue;
    const budget = 4096;
    expect(estimateRuntimeGraphSliceBytes(value)).toBeGreaterThan(budget);
    expect(estimateRuntimeGraphSliceBytes(fitRuntimeGraphSliceToBudget(value, budget))).toBeLessThanOrEqual(budget);
  });

  it("reports an impossible allowance instead of returning an oversized empty slice", () => {
    const empty = { graph: { nodes: [], edges: [], hyperedges: [], query: {} }, evidence: [] } as unknown as RuntimeGraphSliceValue;
    expect(() => fitRuntimeGraphSliceToBudget(empty, 1)).toThrow(RangeError);
    expect(() => fitRuntimeGraphSliceToBudget(empty, Number.NaN)).toThrow(RangeError);
  });
});
