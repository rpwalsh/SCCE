// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.

/** Reserve an equal share of remaining heap for the next hydration and turn work, outside the resident cache. */
export function surfaceLanguageCacheBudgetForHeap(input: {
  heapLimitBytes: number;
  residentHeapBytes: number;
  requestedBytes?: number;
}): number {
  if (![input.heapLimitBytes, input.residentHeapBytes, ...(input.requestedBytes === undefined ? [] : [input.requestedBytes])]
    .every(value => Number.isFinite(value) && value >= 0)) {
    throw new Error("language cache heap budget inputs must be finite nonnegative byte counts");
  }
  const capacity = Math.floor(Math.max(0, input.heapLimitBytes - input.residentHeapBytes) / 2);
  return Math.min(input.requestedBytes ?? capacity, capacity);
}
