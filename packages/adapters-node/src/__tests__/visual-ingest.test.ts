import { describe, expect, it } from "vitest";
import { meanVector, normalizeVector, tileRegions } from "../visual-ingest.js";

describe("visual evidence helpers", () => {
  it("tiles an image into the whole box plus an n×n grid that covers it exactly", () => {
    const boxes = tileRegions(100, 60, 2);
    expect(boxes[0]).toEqual([0, 0, 100, 60]);
    expect(boxes).toHaveLength(5);
    const area = boxes.slice(1).reduce((sum, [x1, y1, x2, y2]) => sum + (x2 - x1) * (y2 - y1), 0);
    expect(area).toBe(100 * 60);
  });

  it("normalizes vectors so cosine equals dot product", () => {
    const vector = normalizeVector([3, 4]);
    expect(vector[0]).toBeCloseTo(0.6);
    expect(vector[1]).toBeCloseTo(0.8);
    expect(normalizeVector([0, 0])).toEqual([0, 0]);
  });

  it("averages page vectors into a renormalized document vector", () => {
    const mean = meanVector([[1, 0], [0, 1]]);
    expect(mean[0]).toBeCloseTo(Math.SQRT1_2);
    expect(mean[1]).toBeCloseTo(Math.SQRT1_2);
    expect(meanVector([])).toEqual([]);
  });

});
