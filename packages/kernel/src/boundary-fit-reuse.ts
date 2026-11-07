// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
import { fitBoundaryEstimator, type BoundaryEstimatorModel } from "./boundary-estimator.js";
import { createHasher } from "./primitives.js";
import type { Hasher } from "./types.js";

export type BoundaryEstimatorFitter = (input: Omit<Parameters<typeof fitBoundaryEstimator>[0], "hasher">) => BoundaryEstimatorModel;

/** One compiler pass reuses only identical complete fit inputs and owns immutable results. */
export function createBoundaryEstimatorFitter(hasher: Hasher = createHasher()): BoundaryEstimatorFitter {
  const models = new Map<string, BoundaryEstimatorModel>();
  return input => {
    const key = hasher.digestHex(JSON.stringify(input));
    const cached = models.get(key);
    if (cached) return cached;
    const model = fitBoundaryEstimator({ ...input, hasher });
    const owned = { ...model, featureOrder: [...model.featureOrder] };
    const freeze = (value: unknown): void => {
      if (!value || typeof value !== "object" || Object.isFrozen(value)) return;
      for (const child of Object.values(value)) freeze(child);
      Object.freeze(value);
    };
    freeze(owned);
    models.set(key, owned);
    return owned;
  };
}
