// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
import { assertPreregisteredTaskClassIds } from "./evaluation-task-classes.js";
import {
  estimateClassEffectLCB,
  holmBonferroniCorrection,
  type ClassEffectEstimate,
  type EstimateClassEffectOptions,
  type PairedResultRecord
} from "./paired-evaluation-statistics.js";

/**
 * Plan items 235, 238-239. The real evaluation release gate: combines
 * items 232-234's already-real, already-tested paired-result statistics
 * (cluster-bootstrap LCB per task class, Holm-Bonferroni correction --
 * neither reimplemented here) with three additional metrics named by
 * item 235 -- unsupported-rate, exact-anchor-accuracy, cycle-accuracy --
 * as genuine hard requirements. A hard requirement here means exactly
 * one thing: if any of it fails, `passed` is `false` and the specific
 * failing reason is named -- there is no "advisory" path that records a
 * metric without it being able to fail the gate.
 *
 * This module does not itself compute the three named metrics from a
 * live evaluation run (that requires actually running one, plan item
 * 240 -- separate, real, execution-dependent work). It takes them as
 * real numeric inputs from whatever real computation produced them (e.g.
 * `walsh-surface-energy.ts`'s existing real `unsupportedRate`
 * computation for the first) and enforces the thresholds.
 */

export interface ReleaseGateMetrics {
  unsupportedRate: number;
  exactAnchorAccuracy: number;
  cycleAccuracy: number;
}

export interface ReleaseGateThresholds {
  maxUnsupportedRate: number;
  minExactAnchorAccuracy: number;
  minCycleAccuracy: number;
  /** Passed through to `estimateClassEffectLCB`/`holmBonferroniCorrection`; the class effect requirement is skipped when omitted. */
  classEffect?: {
    alpha: number;
    lcbOptions: EstimateClassEffectOptions;
  };
}

export interface ReleaseGateFailure {
  id: string;
  reason: string;
}

export interface ReleaseGateResult {
  passed: boolean;
  failures: ReleaseGateFailure[];
  metrics: ReleaseGateMetrics;
  classEffects?: ClassEffectEstimate[];
}

function clamp01Metric(value: number, name: string): number {
  if (!Number.isFinite(value) || value < 0 || value > 1) {
    throw new RangeError(`${name} must be a finite number in [0, 1]; received ${value}`);
  }
  return value;
}

/**
 * Real threshold validation: an out-of-range threshold (e.g.
 * `maxUnsupportedRate: 2`, which no real measured rate could ever
 * exceed) makes the gate structurally unable to fail regardless of the
 * measured metric -- a caller misconfiguration, not a legitimate "gate
 * assessed and passed" outcome. Thrown, matching `clamp01Metric`'s own
 * convention: invalid inputs are a programming error, distinct from a
 * real measured metric genuinely missing a valid threshold (a `failures`
 * entry).
 */
function validateThresholds(thresholds: ReleaseGateThresholds): void {
  clamp01Metric(thresholds.maxUnsupportedRate, "maxUnsupportedRate");
  clamp01Metric(thresholds.minExactAnchorAccuracy, "minExactAnchorAccuracy");
  clamp01Metric(thresholds.minCycleAccuracy, "minCycleAccuracy");
  if (thresholds.classEffect) {
    if (!Number.isFinite(thresholds.classEffect.alpha) || thresholds.classEffect.alpha <= 0 || thresholds.classEffect.alpha >= 1) {
      throw new RangeError(`classEffect.alpha must be a finite number in (0, 1); received ${thresholds.classEffect.alpha}`);
    }
  }
}

/**
 * The real, hard gate decision. Every check below either passes or
 * produces a named failure -- there is no soft/advisory outcome. Class-
 * effect significance (when `thresholds.classEffect` is supplied) is a
 * hard requirement too: any task class whose Holm-corrected null
 * (`mu_c <= 0`) is not rejected fails the gate, not merely gets flagged.
 */
export function evaluateReleaseGate(
  metrics: ReleaseGateMetrics,
  thresholds: ReleaseGateThresholds,
  pairedResults?: readonly PairedResultRecord[]
): ReleaseGateResult {
  clamp01Metric(metrics.unsupportedRate, "unsupportedRate");
  clamp01Metric(metrics.exactAnchorAccuracy, "exactAnchorAccuracy");
  clamp01Metric(metrics.cycleAccuracy, "cycleAccuracy");
  validateThresholds(thresholds);
  // A configured classEffect requirement with no pairedResults to
  // evaluate it against must not silently skip the check and return
  // passed:true -- that's a real caller misconfiguration (asked for a
  // hard requirement, supplied none of the data it needs), not a
  // legitimate "no class-effect issue found" outcome.
  if (thresholds.classEffect && !pairedResults) {
    throw new Error("thresholds.classEffect is configured but no pairedResults were supplied -- the class-effect requirement cannot be evaluated");
  }

  const failures: ReleaseGateFailure[] = [];
  if (metrics.unsupportedRate > thresholds.maxUnsupportedRate) {
    failures.push({ id: "unsupported_rate", reason: `unsupported rate ${metrics.unsupportedRate} exceeds hard maximum ${thresholds.maxUnsupportedRate}` });
  }
  if (metrics.exactAnchorAccuracy < thresholds.minExactAnchorAccuracy) {
    failures.push({ id: "exact_anchor_accuracy", reason: `exact anchor accuracy ${metrics.exactAnchorAccuracy} below hard minimum ${thresholds.minExactAnchorAccuracy}` });
  }
  if (metrics.cycleAccuracy < thresholds.minCycleAccuracy) {
    failures.push({ id: "cycle_accuracy", reason: `cycle accuracy ${metrics.cycleAccuracy} below hard minimum ${thresholds.minCycleAccuracy}` });
  }

  let classEffects: ClassEffectEstimate[] | undefined;
  if (thresholds.classEffect && pairedResults) {
    assertPreregisteredTaskClassIds([...new Set(pairedResults.map(record => record.taskFamilyId))]);
    classEffects = estimateClassEffectLCB(pairedResults, thresholds.classEffect.lcbOptions);
    const corrected = holmBonferroniCorrection(
      classEffects.map(estimate => ({ id: estimate.taskFamilyId, pValue: estimate.pValue })),
      thresholds.classEffect.alpha
    );
    const correctedById = new Map(corrected.map(result => [result.id, result]));
    for (const estimate of classEffects) {
      const correction = correctedById.get(estimate.taskFamilyId)!;
      if (!correction.reject) {
        failures.push({
          id: `class_effect:${estimate.taskFamilyId}`,
          reason: `task class ${estimate.taskFamilyId} does not reject the null effect after Holm-Bonferroni correction (p=${estimate.pValue}, required <= ${correction.requiredThreshold})`
        });
      }
    }
  }

  return { passed: failures.length === 0, failures, metrics, ...(classEffects ? { classEffects } : {}) };
}
