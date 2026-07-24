export interface ConformalCausalRiskInterval {
  method: "finite_sample_absolute_residual_envelope";
  lower: number;
  upper: number;
  targetCoverage: number;
  calibrationCount: number;
  finiteSampleRank: number;
  nonconformityQuantile: number;
  contrastRadiusMultiplier: number;
  parameterConfidenceInterval: false;
  causalIdentificationEvidence: false;
  interpretation: "outcome-noise sensitivity envelope, not a parameter confidence interval";
}

export interface ConformalCausalRiskInput {
  pointEstimate: number;
  absoluteResiduals: readonly number[];
  targetCoverage: number;
  contrastRadiusMultiplier: number;
}

export type ConformalCausalRiskResult =
  | { status: "calibrated"; interval: ConformalCausalRiskInterval }
  | { status: "rejected"; reasons: string[] };

/**
 * Builds a finite-sample empirical nonconformity envelope around an identified
 * point estimate. This interval describes observed outcome-noise sensitivity.
 * It is deliberately not called a confidence interval and cannot identify a
 * causal effect.
 */
export function createConformalCausalRiskInterval(
  input: ConformalCausalRiskInput
): ConformalCausalRiskResult {
  const reasons: string[] = [];
  if (!Number.isFinite(input.pointEstimate)) reasons.push("point_estimate_must_be_finite");
  if (!(input.targetCoverage > 0 && input.targetCoverage < 1)) {
    reasons.push("target_coverage_must_be_between_zero_and_one");
  }
  if (!(input.contrastRadiusMultiplier > 0) || !Number.isFinite(input.contrastRadiusMultiplier)) {
    reasons.push("contrast_radius_multiplier_must_be_positive_and_finite");
  }
  if (input.absoluteResiduals.length === 0) reasons.push("calibration_residuals_required");
  if (input.absoluteResiduals.some(value => !Number.isFinite(value) || value < 0)) {
    reasons.push("calibration_residuals_must_be_finite_and_nonnegative");
  }
  if (reasons.length) return { status: "rejected", reasons };

  const sorted = [...input.absoluteResiduals].sort((left, right) => left - right);
  const oneBasedRank = Math.min(
    sorted.length,
    Math.ceil((sorted.length + 1) * input.targetCoverage)
  );
  const nonconformityQuantile = sorted[oneBasedRank - 1]!;
  const radius = nonconformityQuantile * input.contrastRadiusMultiplier;
  return {
    status: "calibrated",
    interval: {
      method: "finite_sample_absolute_residual_envelope",
      lower: input.pointEstimate - radius,
      upper: input.pointEstimate + radius,
      targetCoverage: input.targetCoverage,
      calibrationCount: sorted.length,
      finiteSampleRank: oneBasedRank,
      nonconformityQuantile,
      contrastRadiusMultiplier: input.contrastRadiusMultiplier,
      parameterConfidenceInterval: false,
      causalIdentificationEvidence: false,
      interpretation: "outcome-noise sensitivity envelope, not a parameter confidence interval"
    }
  };
}
