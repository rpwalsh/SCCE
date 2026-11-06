// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
import { describe, expect, it } from "vitest";
import { surfaceLanguageCacheBudgetForHeap } from "../runtime-language-memory-budget.js";

const GiB = 1024 ** 3;
describe("Node surface language memory resource allowance", () => {
  it("caps an 8 GiB cache request using the actual 3 GiB process heap and current resident state", () => {
    expect(surfaceLanguageCacheBudgetForHeap({ heapLimitBytes: 3 * GiB, residentHeapBytes: GiB, requestedBytes: 8 * GiB })).toBe(GiB);
    expect(surfaceLanguageCacheBudgetForHeap({ heapLimitBytes: 3 * GiB, residentHeapBytes: 2 * GiB })).toBe(GiB / 2);
  });
  it("honors a smaller caller allowance and declines retention when no heap headroom remains", () => {
    expect(surfaceLanguageCacheBudgetForHeap({ heapLimitBytes: 3 * GiB, residentHeapBytes: GiB, requestedBytes: 1024 })).toBe(1024);
    expect(surfaceLanguageCacheBudgetForHeap({ heapLimitBytes: GiB, residentHeapBytes: 2 * GiB })).toBe(0);
    expect(surfaceLanguageCacheBudgetForHeap({ heapLimitBytes: GiB, residentHeapBytes: 0, requestedBytes: 0 })).toBe(0);
  });
  it.each([NaN, Infinity, -1])("rejects invalid resource limits (%s)", value => {
    expect(() => surfaceLanguageCacheBudgetForHeap({ heapLimitBytes: value, residentHeapBytes: 0 })).toThrow(/finite nonnegative/);
    expect(() => surfaceLanguageCacheBudgetForHeap({ heapLimitBytes: GiB, residentHeapBytes: value })).toThrow(/finite nonnegative/);
    expect(() => surfaceLanguageCacheBudgetForHeap({ heapLimitBytes: GiB, residentHeapBytes: 0, requestedBytes: value })).toThrow(/finite nonnegative/);
  });
});
