import { canonicalStringify, createHasher, toJsonValue } from "./primitives.js";
import type { SparseFusedTransportPlan } from "./sparse-fused-transport.js";
import type { Hasher, JsonValue } from "./types.js";

export const ALIGNMENT_CALIBRATION_SCHEMA =
  "scce.alignment_calibration_model.v1" as const;

export interface AlignmentCalibrationFeatures {
  objective: number;
  feature: number;
  structural: number;
  ordering: number;
  crossDocument: number;
  anchorIndependence: number;
  cycleRecall: number;
  unsupportedAdditionRate: number;
  marginalResidual: number;
}

export interface AlignmentCalibrationObservation {
  id: string;
  sourceFamilyId: string;
  partition: "fit" | "holdout";
  outcome: boolean;
  features: AlignmentCalibrationFeatures;
}

export interface AlignmentCalibrationMetrics {
  count: number;
  logLoss: number;
  brierScore: number;
  expectedCalibrationError: number;
  binCount: number;
}

export interface AlignmentCalibrationModel {
  schema: typeof ALIGNMENT_CALIBRATION_SCHEMA;
  id: string;
  status: "calibrated" | "insufficient_data";
  featureNames: (keyof AlignmentCalibrationFeatures)[];
  intercept: number;
  weights: number[];
  fitSourceFamilyIds: string[];
  holdoutSourceFamilyIds: string[];
  fitCount: number;
  holdoutCount: number;
  holdoutMetrics: AlignmentCalibrationMetrics | null;
  reasons: string[];
  audit: JsonValue;
}

const FEATURE_NAMES: (keyof AlignmentCalibrationFeatures)[] = [
  "objective",
  "feature",
  "structural",
  "ordering",
  "crossDocument",
  "anchorIndependence",
  "cycleRecall",
  "unsupportedAdditionRate",
  "marginalResidual"
];

export function alignmentCalibrationFeatures(input: {
  plan: SparseFusedTransportPlan;
  independentAnchorSourceFamilies: number;
  cycleRecall: number;
  unsupportedAdditionRate: number;
}): AlignmentCalibrationFeatures {
  const final = input.plan.iterations.at(-1);
  if (!final) throw new Error("alignment calibration requires a completed plan trace");
  return {
    objective: finite(final.objective, "objective"),
    feature: finite(final.feature, "feature"),
    structural: finite(final.structural, "structural"),
    ordering: finite(final.ordering, "ordering"),
    crossDocument: finite(final.crossDocument, "crossDocument"),
    anchorIndependence: Math.log1p(Math.max(
      0,
      Math.floor(input.independentAnchorSourceFamilies)
    )),
    cycleRecall: unit(input.cycleRecall, "cycleRecall"),
    unsupportedAdditionRate: unit(
      input.unsupportedAdditionRate,
      "unsupportedAdditionRate"
    ),
    marginalResidual: finite(
      final.surfaceMarginalResidual + final.graphMarginalResidual,
      "marginalResidual"
    )
  };
}

export function compileAlignmentCalibrationModel(input: {
  observations: readonly AlignmentCalibrationObservation[];
  minimumFitCount?: number;
  minimumHoldoutCount?: number;
  binCount?: number;
  hasher?: Hasher;
}): AlignmentCalibrationModel {
  const hasher = input.hasher ?? createHasher();
  const observations = canonicalObservations(input.observations);
  const fit = observations.filter(row => row.partition === "fit");
  const holdout = observations.filter(row => row.partition === "holdout");
  const fitSourceFamilyIds = families(fit);
  const holdoutSourceFamilyIds = families(holdout);
  const overlap = fitSourceFamilyIds.filter(id =>
    holdoutSourceFamilyIds.includes(id));
  if (overlap.length) {
    throw new Error(`alignment calibration source families cross partitions: ${
      overlap.join(",")
    }`);
  }
  const minimumFitCount = bounded(input.minimumFitCount, 8, 100_000, 32);
  const minimumHoldoutCount = bounded(input.minimumHoldoutCount, 8, 100_000, 32);
  const binCount = bounded(input.binCount, 2, 50, 10);
  const reasons: string[] = [];
  if (fit.length < minimumFitCount) reasons.push("fit_count_below_minimum");
  if (holdout.length < minimumHoldoutCount) reasons.push("holdout_count_below_minimum");
  if (!hasBothOutcomes(fit)) reasons.push("fit_requires_positive_and_negative_labels");
  if (!hasBothOutcomes(holdout)) reasons.push("holdout_requires_positive_and_negative_labels");
  const fitted = reasons.length
    ? { intercept: 0, weights: FEATURE_NAMES.map(() => 0) }
    : fitLogistic(fit);
  const holdoutMetrics = reasons.length
    ? null
    : calibrationMetrics(holdout.map(row => ({
      predicted: calibratedAlignmentProbabilityFromFeatures(fitted, row.features),
      actual: row.outcome
    })), binCount);
  const canonical = {
    schema: ALIGNMENT_CALIBRATION_SCHEMA,
    status: reasons.length ? "insufficient_data" as const : "calibrated" as const,
    featureNames: FEATURE_NAMES,
    intercept: fitted.intercept,
    weights: fitted.weights,
    fitSourceFamilyIds,
    holdoutSourceFamilyIds,
    fitCount: fit.length,
    holdoutCount: holdout.length,
    holdoutMetrics,
    reasons
  };
  return {
    ...canonical,
    id: `alignment_calibration.${hasher.digestHex(
      canonicalStringify(canonical)
    ).slice(0, 40)}`,
    audit: toJsonValue({
      compiler: "kernel.alignment_calibration.logistic.v1",
      sourceFamilyDisjoint: true,
      holdoutUntouchedDuringFit: true,
      metrics: ["log_loss", "brier_score", "expected_calibration_error"],
      calibrated: canonical.status === "calibrated"
    })
  };
}

export function calibratedAlignmentProbability(input: {
  model: AlignmentCalibrationModel;
  features: AlignmentCalibrationFeatures;
}): number | null {
  if (input.model.status !== "calibrated") return null;
  return calibratedAlignmentProbabilityFromFeatures(input.model, input.features);
}

function fitLogistic(observations: readonly AlignmentCalibrationObservation[]): {
  intercept: number;
  weights: number[];
} {
  let intercept = 0;
  const weights = FEATURE_NAMES.map(() => 0);
  const means = FEATURE_NAMES.map(name => mean(observations.map(row =>
    row.features[name])));
  const scales = FEATURE_NAMES.map((name, index) => Math.max(
    1e-6,
    Math.sqrt(mean(observations.map(row =>
      (row.features[name] - means[index]!) ** 2)))
  ));
  for (let iteration = 0; iteration < 400; iteration++) {
    let interceptGradient = 0;
    const gradients = weights.map(() => 0);
    for (const row of observations) {
      const vector = FEATURE_NAMES.map((name, index) =>
        (row.features[name] - means[index]!) / scales[index]!);
      const probability = sigmoid(intercept + dot(weights, vector));
      const error = probability - (row.outcome ? 1 : 0);
      interceptGradient += error;
      for (let index = 0; index < gradients.length; index++) {
        gradients[index]! += error * vector[index]!;
      }
    }
    const rate = 0.08 / Math.sqrt(iteration + 1);
    intercept -= rate * interceptGradient / observations.length;
    for (let index = 0; index < weights.length; index++) {
      weights[index]! -= rate * (
        gradients[index]! / observations.length + 1e-3 * weights[index]!
      );
    }
  }
  const rawWeights = weights.map((weight, index) => weight / scales[index]!);
  return {
    intercept: quantize(intercept - dot(rawWeights, means)),
    weights: rawWeights.map(quantize)
  };
}

function calibratedAlignmentProbabilityFromFeatures(
  model: Pick<AlignmentCalibrationModel, "intercept" | "weights">,
  features: AlignmentCalibrationFeatures
): number {
  return sigmoid(model.intercept + dot(
    model.weights,
    FEATURE_NAMES.map(name => features[name])
  ));
}

function calibrationMetrics(
  rows: readonly { predicted: number; actual: boolean }[],
  binCount: number
): AlignmentCalibrationMetrics {
  const epsilon = 1e-12;
  const logLoss = mean(rows.map(row => {
    const probability = Math.max(epsilon, Math.min(1 - epsilon, row.predicted));
    return row.actual ? -Math.log(probability) : -Math.log(1 - probability);
  }));
  const brierScore = mean(rows.map(row =>
    (row.predicted - (row.actual ? 1 : 0)) ** 2));
  let expectedCalibrationError = 0;
  for (let bin = 0; bin < binCount; bin++) {
    const lower = bin / binCount;
    const upper = (bin + 1) / binCount;
    const members = rows.filter(row =>
      row.predicted >= lower
      && (bin === binCount - 1 ? row.predicted <= upper : row.predicted < upper));
    if (!members.length) continue;
    expectedCalibrationError += members.length / rows.length * Math.abs(
      mean(members.map(row => row.predicted))
      - mean(members.map(row => row.actual ? 1 : 0))
    );
  }
  return {
    count: rows.length,
    logLoss: quantize(logLoss),
    brierScore: quantize(brierScore),
    expectedCalibrationError: quantize(expectedCalibrationError),
    binCount
  };
}

function canonicalObservations(
  observations: readonly AlignmentCalibrationObservation[]
): AlignmentCalibrationObservation[] {
  const seen = new Set<string>();
  return [...observations].map(row => {
    if (!row.id || !row.sourceFamilyId) {
      throw new Error("alignment calibration observations require identity");
    }
    if (seen.has(row.id)) throw new Error(`duplicate alignment calibration ${row.id}`);
    seen.add(row.id);
    for (const name of FEATURE_NAMES) finite(row.features[name], name);
    return { ...row, features: { ...row.features } };
  }).sort((left, right) => left.id.localeCompare(right.id));
}

function families(rows: readonly AlignmentCalibrationObservation[]): string[] {
  return [...new Set(rows.map(row => row.sourceFamilyId))].sort();
}

function hasBothOutcomes(rows: readonly AlignmentCalibrationObservation[]): boolean {
  return rows.some(row => row.outcome) && rows.some(row => !row.outcome);
}

function sigmoid(value: number): number {
  if (value >= 0) return 1 / (1 + Math.exp(-Math.min(80, value)));
  const exp = Math.exp(Math.max(-80, value));
  return exp / (1 + exp);
}

function dot(left: readonly number[], right: readonly number[]): number {
  return left.reduce((sum, value, index) => sum + value * (right[index] ?? 0), 0);
}

function mean(values: readonly number[]): number {
  return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : 0;
}

function finite(value: number, name: string): number {
  if (!Number.isFinite(value)) throw new Error(`${name} must be finite`);
  return value;
}

function unit(value: number, name: string): number {
  finite(value, name);
  if (value < 0 || value > 1) throw new Error(`${name} must be in [0,1]`);
  return value;
}

function bounded(
  value: number | undefined,
  minimum: number,
  maximum: number,
  fallback: number
): number {
  return Math.max(minimum, Math.min(maximum, Math.floor(value ?? fallback)));
}

function quantize(value: number): number {
  return Math.round(value * 1_000_000_000_000) / 1_000_000_000_000;
}
