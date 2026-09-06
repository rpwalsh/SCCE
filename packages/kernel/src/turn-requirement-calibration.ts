// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
import {
  DEFAULT_TURN_REQUIREMENT_MODEL,
  TURN_REQUIREMENT_DIMENSIONS,
  type LearnedRequirementActivation,
  type TurnRequirementCoefficientModel,
  type TurnRequirementDimension
} from "./turn-requirements.js";

/**
 * The turn requirement model calibrates itself from its own turns instead of shipping empty forever.
 *
 * `DEFAULT_TURN_REQUIREMENT_MODEL` is an uncalibrated bootstrap whose `activationWeights` are `{}`, and nothing ever
 * supplied a learned one. With no learned frame activating, every dimension of every request resolved to its -1.4
 * intercept -- sigmoid(-1.4) = 0.198 -- which sits below every gate the cognitive draft producers use (0.5, 0.55).
 * The consequence was not a poor estimate but a dead subsystem: no request in the system's history could reach a
 * reasoning lane, and no amount of ingestion or training would ever change that, because nothing was learning here.
 *
 * The supervision is structural and already computed. A request's distinct corpus subjects, its explicit
 * requirements and its code signal say what the turn demanded, independently of any learned activation. Those are
 * the teacher; the activations that fired on the same turn are the students. Each turn takes one bounded gradient
 * step, so a frame that keeps co-occurring with composition demand gradually comes to predict it on its own and the
 * structural bootstrap stops being the only thing holding the estimate up.
 *
 * Deliberately online and per-activation rather than a batch fit: there is no offline corpus of labelled requests to
 * fit against, the labels arrive one turn at a time, and a turn may not spend a database round trip on training
 * (the runtime's own latency contract). Weights are bounded and decay toward zero so a rare activation cannot
 * dominate, and the intercepts are never touched -- they are the prior this corrects against, not a parameter.
 */

export const TURN_REQUIREMENT_CALIBRATION = {
  /** Step size for one turn's update. Small enough that a single odd turn cannot move a dimension through a gate. */
  learningRate: 0.08,
  /** Per-weight bound, in logit units. Two saturated activations can carry a dimension across its gate; one cannot. */
  weightCeiling: 1.25,
  /** Multiplicative decay applied to a touched weight each step, so unsupported weight bleeds off. */
  decay: 0.997,
  /** Below this, a weight is dropped rather than stored, which keeps the persisted model bounded. */
  minimumRetainedWeight: 0.01,
  /** Most activations any single turn may update, so a pathological turn cannot rewrite the model. */
  maxActivationsPerStep: 24
} as const;

export interface TurnRequirementObservation {
  activations: readonly LearnedRequirementActivation[];
  /** Structurally derived demand per dimension, in [0,1]. Dimensions absent here are not supervised this turn. */
  targets: Partial<Record<TurnRequirementDimension, number>>;
  /** What the model actually produced this turn, in [0,1]. */
  predicted: Partial<Record<TurnRequirementDimension, number>>;
}

const clampWeight = (value: number): number =>
  Math.max(-TURN_REQUIREMENT_CALIBRATION.weightCeiling, Math.min(TURN_REQUIREMENT_CALIBRATION.weightCeiling, value));

/** The persisted key for one activation, matching what `modelActivationWeight` looks up first. */
export function activationWeightKey(activation: LearnedRequirementActivation): string {
  return `${activation.kind}:${activation.id}`;
}

/**
 * One bounded step of logistic gradient descent per supervised dimension.
 *
 * For a logistic model the gradient of log-loss with respect to an activation's weight is exactly
 * (predicted - target) * activation, which is why no separate derivative is needed here: the error is already in
 * probability space and the update is linear in the activation strength.
 */
export function calibrateTurnRequirementModel(
  model: TurnRequirementCoefficientModel,
  observation: TurnRequirementObservation
): TurnRequirementCoefficientModel {
  const activations = observation.activations
    .filter(activation => Number.isFinite(activation.activation) && activation.activation > 0)
    .slice(0, TURN_REQUIREMENT_CALIBRATION.maxActivationsPerStep);
  if (!activations.length) return model;

  let changed = false;
  const activationWeights: Record<string, Record<string, number>> = {};
  for (const dimension of TURN_REQUIREMENT_DIMENSIONS) {
    const existing = model.activationWeights[dimension];
    if (existing) activationWeights[dimension] = { ...existing };
  }

  for (const dimension of TURN_REQUIREMENT_DIMENSIONS) {
    const target = observation.targets[dimension];
    const predicted = observation.predicted[dimension];
    if (target === undefined || predicted === undefined) continue;
    if (!Number.isFinite(target) || !Number.isFinite(predicted)) continue;
    const error = predicted - target;
    if (Math.abs(error) < 0.02) continue;
    const weights = activationWeights[dimension] ?? {};
    for (const activation of activations) {
      const key = activationWeightKey(activation);
      const previous = Number.isFinite(weights[key]) ? weights[key]! : 0;
      const stepped = previous * TURN_REQUIREMENT_CALIBRATION.decay
        - TURN_REQUIREMENT_CALIBRATION.learningRate * error * activation.activation;
      const bounded = clampWeight(stepped);
      if (Math.abs(bounded) < TURN_REQUIREMENT_CALIBRATION.minimumRetainedWeight) {
        if (weights[key] !== undefined) { delete weights[key]; changed = true; }
        continue;
      }
      if (weights[key] !== bounded) { weights[key] = bounded; changed = true; }
    }
    if (Object.keys(weights).length) activationWeights[dimension] = weights;
    else delete activationWeights[dimension];
  }

  if (!changed) return model;
  return {
    ...model,
    activationWeights,
    version: model.version + 1,
    // The model stops describing itself as an uncalibrated bootstrap the moment it has learned anything at all.
    reliability: "calibrated"
  };
}

/** The model a runtime should start from: the stored one when it exists, the bootstrap when it does not. Pure. */
export function turnRequirementModelFromState(stored: unknown): TurnRequirementCoefficientModel {
  if (!stored || typeof stored !== "object" || Array.isArray(stored)) return DEFAULT_TURN_REQUIREMENT_MODEL;
  const candidate = stored as Partial<TurnRequirementCoefficientModel>;
  if (candidate.schema !== DEFAULT_TURN_REQUIREMENT_MODEL.schema) return DEFAULT_TURN_REQUIREMENT_MODEL;
  if (!candidate.intercepts || typeof candidate.intercepts !== "object") return DEFAULT_TURN_REQUIREMENT_MODEL;
  return {
    ...DEFAULT_TURN_REQUIREMENT_MODEL,
    ...candidate,
    intercepts: { ...DEFAULT_TURN_REQUIREMENT_MODEL.intercepts, ...candidate.intercepts },
    activationWeights: candidate.activationWeights && typeof candidate.activationWeights === "object"
      ? candidate.activationWeights
      : {}
  } as TurnRequirementCoefficientModel;
}

/** How many weights the model carries, for reporting whether calibration is actually happening. Pure. */
export function turnRequirementModelWeightCount(model: TurnRequirementCoefficientModel): number {
  return Object.values(model.activationWeights)
    .reduce((sum, weights) => sum + Object.keys(weights ?? {}).length, 0);
}
