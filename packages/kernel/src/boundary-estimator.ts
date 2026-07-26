import { clamp01, createHasher, toJsonValue } from "./primitives.js";
import type { Hasher, JsonValue } from "./types.js";

export const BOUNDARY_ESTIMATOR_SCHEMA = "scce.boundary_estimator.v1" as const;
export const BOUNDARY_STATISTICS_SCHEMA = "scce.boundary_statistics.v1" as const;

export interface BoundaryFeatureVector {
  whitespaceAdjacent: number;
  punctuationAdjacent: number;
  lineBreakAdjacent: number;
  scriptTransition: number;
  structuralBoundary: number;
  localTransitionEntropy: number;
  repeatedContextSupport: number;
}

export interface BoundaryObservation {
  features: BoundaryFeatureVector;
  positiveMass: number;
  negativeMass: number;
}

export interface BoundaryStatisticsRow {
  key: string;
  featuresFixed: number[];
  positiveMass: number;
  negativeMass: number;
}

export interface BoundarySufficientStatistics {
  schema: typeof BOUNDARY_STATISTICS_SCHEMA;
  populationId: string;
  featureOrder: readonly string[];
  scale: number;
  rows: BoundaryStatisticsRow[];
  positiveMass: number;
  negativeMass: number;
  sourceDocumentIds: string[];
  id: string;
  audit: JsonValue;
}

export interface BoundaryEstimatorModel {
  schema: typeof BOUNDARY_ESTIMATOR_SCHEMA;
  id: string;
  populationId: string;
  featureOrder: readonly string[];
  weights: number[];
  intercept: number;
  trainingStatisticsId: string;
  iterations: number;
  l2: number;
  calibration: {
    examples: number;
    positiveMass: number;
    negativeMass: number;
    logLoss: number;
  };
  audit: JsonValue;
}

const FEATURE_ORDER: readonly (keyof BoundaryFeatureVector)[] = [
  "whitespaceAdjacent",
  "punctuationAdjacent",
  "lineBreakAdjacent",
  "scriptTransition",
  "structuralBoundary",
  "localTransitionEntropy",
  "repeatedContextSupport"
] as const;
const FIXED_SCALE = 1_000_000;
const MASS_SCALE = 1_024;

export function compileBoundaryStatistics(input: {
  populationId: string;
  observations: readonly BoundaryObservation[];
  sourceDocumentIds?: readonly string[];
  hasher?: Hasher;
}): BoundarySufficientStatistics {
  const hasher = input.hasher ?? createHasher();
  const rows = new Map<string, BoundaryStatisticsRow>();
  for (const observation of input.observations) {
    const featuresFixed = featureArray(observation.features)
      .map(value => Math.round(clamp01(value) * FIXED_SCALE));
    const key = featuresFixed.join(":");
    const current = rows.get(key) ?? {
      key,
      featuresFixed,
      positiveMass: 0,
      negativeMass: 0
    };
    current.positiveMass = safeAdd(current.positiveMass, fixedMass(observation.positiveMass));
    current.negativeMass = safeAdd(current.negativeMass, fixedMass(observation.negativeMass));
    rows.set(key, current);
  }
  const ordered = [...rows.values()]
    .filter(row => row.positiveMass + row.negativeMass > 0)
    .sort((left, right) => left.key.localeCompare(right.key));
  const sourceDocumentIds = [...new Set(input.sourceDocumentIds ?? [])].sort();
  const canonical = {
    schema: BOUNDARY_STATISTICS_SCHEMA,
    populationId: input.populationId,
    featureOrder: FEATURE_ORDER,
    scale: FIXED_SCALE,
    rows: ordered,
    sourceDocumentIds
  };
  const id = `boundary_statistics.${hasher.digestHex(JSON.stringify(canonical)).slice(0, 40)}`;
  return {
    ...canonical,
    id,
    positiveMass: ordered.reduce((sum, row) => sum + row.positiveMass, 0),
    negativeMass: ordered.reduce((sum, row) => sum + row.negativeMass, 0),
    audit: toJsonValue({
      compiler: "kernel.boundary_statistics.v1",
      exactIntegerMass: true,
      canonicalRowOrder: true,
      rows: ordered.length,
      sourceDocuments: sourceDocumentIds.length
    })
  };
}

export function mergeBoundaryStatistics(
  statistics: readonly BoundarySufficientStatistics[],
  hasher: Hasher = createHasher()
): BoundarySufficientStatistics {
  if (!statistics.length) {
    return compileBoundaryStatistics({
      populationId: "population.unassigned",
      observations: [],
      hasher
    });
  }
  const populationId = statistics[0]!.populationId;
  if (statistics.some(item =>
    item.schema !== BOUNDARY_STATISTICS_SCHEMA
    || item.populationId !== populationId
    || item.scale !== FIXED_SCALE
    || item.featureOrder.join("\u001f") !== FEATURE_ORDER.join("\u001f"))) {
    throw new Error("boundary statistics merge requires one schema and population");
  }
  const rows = new Map<string, BoundaryStatisticsRow>();
  for (const statistic of [...statistics].sort((left, right) => left.id.localeCompare(right.id))) {
    for (const row of statistic.rows) {
      const current = rows.get(row.key) ?? {
        key: row.key,
        featuresFixed: [...row.featuresFixed],
        positiveMass: 0,
        negativeMass: 0
      };
      current.positiveMass = safeAdd(current.positiveMass, row.positiveMass);
      current.negativeMass = safeAdd(current.negativeMass, row.negativeMass);
      rows.set(row.key, current);
    }
  }
  const observations: BoundaryObservation[] = [...rows.values()]
    .sort((left, right) => left.key.localeCompare(right.key))
    .map(row => ({
      features: featureRecord(row.featuresFixed.map(value => value / FIXED_SCALE)),
      positiveMass: row.positiveMass / MASS_SCALE,
      negativeMass: row.negativeMass / MASS_SCALE
    }));
  return compileBoundaryStatistics({
    populationId,
    observations,
    sourceDocumentIds: statistics.flatMap(item => item.sourceDocumentIds),
    hasher
  });
}

export function fitBoundaryEstimator(input: {
  statistics: BoundarySufficientStatistics;
  iterations?: number;
  learningRate?: number;
  l2?: number;
  hasher?: Hasher;
}): BoundaryEstimatorModel {
  const hasher = input.hasher ?? createHasher();
  const iterations = Math.max(1, Math.min(512, Math.floor(input.iterations ?? 96)));
  const learningRate = Math.max(1e-5, Math.min(1, input.learningRate ?? 0.18));
  const l2 = Math.max(0, Math.min(10, input.l2 ?? 0.02));
  const weights = new Array<number>(FEATURE_ORDER.length).fill(0);
  const totalPositive = input.statistics.positiveMass / MASS_SCALE;
  const totalNegative = input.statistics.negativeMass / MASS_SCALE;
  const totalMass = Math.max(1, totalPositive + totalNegative);
  let intercept = Math.log((totalPositive + 0.5) / (totalNegative + 0.5));

  for (let iteration = 0; iteration < iterations; iteration += 1) {
    const gradients = new Array<number>(weights.length).fill(0);
    let interceptGradient = 0;
    for (const row of input.statistics.rows) {
      const features = row.featuresFixed.map(value => value / FIXED_SCALE);
      const positive = row.positiveMass / MASS_SCALE;
      const negative = row.negativeMass / MASS_SCALE;
      const mass = positive + negative;
      if (mass <= 0) continue;
      const predicted = sigmoid(intercept + dot(weights, features));
      const residual = predicted * mass - positive;
      interceptGradient += residual;
      for (let index = 0; index < gradients.length; index += 1) {
        gradients[index] = gradients[index]! + residual * (features[index] ?? 0);
      }
    }
    intercept = quantize(intercept - learningRate * interceptGradient / totalMass);
    for (let index = 0; index < weights.length; index += 1) {
      const regularized = gradients[index]! / totalMass + l2 * weights[index]!;
      weights[index] = quantize(weights[index]! - learningRate * regularized);
    }
  }
  const logLoss = boundaryLogLoss(input.statistics, weights, intercept);
  const canonical = {
    schema: BOUNDARY_ESTIMATOR_SCHEMA,
    populationId: input.statistics.populationId,
    featureOrder: FEATURE_ORDER,
    weights,
    intercept,
    trainingStatisticsId: input.statistics.id,
    iterations,
    l2,
    calibration: {
      examples: input.statistics.rows.length,
      positiveMass: totalPositive,
      negativeMass: totalNegative,
      logLoss
    }
  };
  return {
    ...canonical,
    id: `boundary_estimator.${hasher.digestHex(JSON.stringify(canonical)).slice(0, 40)}`,
    audit: toJsonValue({
      trainer: "kernel.boundary_estimator.logistic.v1",
      deterministicCanonicalRows: true,
      quantizedParameters: true,
      learningRate
    })
  };
}

export function scoreBoundary(
  model: BoundaryEstimatorModel,
  features: BoundaryFeatureVector
): number {
  if (model.schema !== BOUNDARY_ESTIMATOR_SCHEMA
    || model.featureOrder.join("\u001f") !== FEATURE_ORDER.join("\u001f")
    || model.weights.length !== FEATURE_ORDER.length) {
    throw new Error("incompatible boundary estimator model");
  }
  return clamp01(sigmoid(model.intercept + dot(model.weights, featureArray(features))));
}

function boundaryLogLoss(
  statistics: BoundarySufficientStatistics,
  weights: readonly number[],
  intercept: number
): number {
  let loss = 0;
  let mass = 0;
  for (const row of statistics.rows) {
    const positive = row.positiveMass / MASS_SCALE;
    const negative = row.negativeMass / MASS_SCALE;
    const predicted = Math.min(1 - 1e-12, Math.max(1e-12, sigmoid(
      intercept + dot(weights, row.featuresFixed.map(value => value / FIXED_SCALE))
    )));
    loss += -positive * Math.log(predicted) - negative * Math.log(1 - predicted);
    mass += positive + negative;
  }
  return quantize(loss / Math.max(1, mass));
}

function featureArray(features: BoundaryFeatureVector): number[] {
  return FEATURE_ORDER.map(key => features[key]);
}

function featureRecord(values: readonly number[]): BoundaryFeatureVector {
  return {
    whitespaceAdjacent: values[0] ?? 0,
    punctuationAdjacent: values[1] ?? 0,
    lineBreakAdjacent: values[2] ?? 0,
    scriptTransition: values[3] ?? 0,
    structuralBoundary: values[4] ?? 0,
    localTransitionEntropy: values[5] ?? 0,
    repeatedContextSupport: values[6] ?? 0
  };
}

function dot(left: readonly number[], right: readonly number[]): number {
  let sum = 0;
  let compensation = 0;
  for (let index = 0; index < Math.max(left.length, right.length); index += 1) {
    const product = (left[index] ?? 0) * (right[index] ?? 0);
    const adjusted = product - compensation;
    const next = sum + adjusted;
    compensation = (next - sum) - adjusted;
    sum = next;
  }
  return sum;
}

function sigmoid(value: number): number {
  if (value >= 0) {
    const inverse = Math.exp(-Math.min(60, value));
    return 1 / (1 + inverse);
  }
  const exponent = Math.exp(Math.max(-60, value));
  return exponent / (1 + exponent);
}

function quantize(value: number): number {
  return Math.round(value * 1_000_000_000_000) / 1_000_000_000_000;
}

function fixedMass(value: number): number {
  if (!Number.isFinite(value)) throw new Error("boundary observation mass must be finite");
  const fixed = Math.round(Math.max(0, value) * MASS_SCALE);
  if (!Number.isSafeInteger(fixed)) throw new Error("boundary observation mass exceeds exact integer range");
  return fixed;
}

function safeAdd(left: number, right: number): number {
  const sum = left + right;
  if (!Number.isSafeInteger(left) || !Number.isSafeInteger(right) || !Number.isSafeInteger(sum)) {
    throw new Error("boundary sufficient statistics exceed exact integer range");
  }
  return sum;
}
