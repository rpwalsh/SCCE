// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
import { createBoundaryEstimatorNumericalFitter, type BoundaryEstimatorFitInput, type BoundaryEstimatorModel } from "./boundary-estimator.js";
import { createHasher } from "./primitives.js";
import type { Hasher } from "./types.js";

export type BoundaryEstimatorFitter = (input: Omit<BoundaryEstimatorFitInput, "hasher">) => BoundaryEstimatorModel;

/** One compiler pass shares validated numerical fits and owns immutable identical model records. */
export function createBoundaryEstimatorFitter(hasher: Hasher = createHasher()): BoundaryEstimatorFitter {
  const models = new Map<string, BoundaryEstimatorModel>();
  const fit = createBoundaryEstimatorNumericalFitter(hasher);
  return input => {
    const model = fit(input);
    const key = JSON.stringify(model, (_key, value: unknown) => typeof value === "number" && (!Number.isFinite(value) || Object.is(value, -0))
      ? { number: String(value), negativeZero: Object.is(value, -0) } : value);
    const cached = models.get(key);
    if (cached) return cached;
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
