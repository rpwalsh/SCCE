import { clamp01, createHasher, toJsonValue } from "./primitives.js";
import type { Hasher, JsonValue } from "./types.js";
import { canonicalNormalizationContract } from "./normalization-contract.js";

export const BOUNDARY_ESTIMATOR_SCHEMA = "scce.boundary_estimator.v2" as const;
export const BOUNDARY_ESTIMATOR_MIXTURE_SCHEMA = "scce.boundary_estimator_mixture.v2" as const;
export const BOUNDARY_STATISTICS_SCHEMA = "scce.boundary_statistics.v2" as const;

export interface BoundaryFeatureVector {
  whitespaceAdjacent: number;
  punctuationAdjacent: number;
  lineBreakAdjacent: number;
  scriptTransition: number;
  structuralBoundary: number;
  localTransitionEntropy: number;
  repeatedContextSupport: number;
  crossDocumentRecurrence: number;
  predictiveCompressionGain: number;
  stableSubstitutionSupport: number;
  exactPhraseRecurrence: number;
  constructionReuse: number;
}

export type BoundarySupervision = "independent_anchor" | "latent_marginal";

export type BoundarySignalKind =
  | "cross_document_recurrence"
  | "predictive_compression"
  | "stable_substitution"
  | "structured_anchor"
  | "exact_repeated_phrase"
  | "construction_reuse"
  | "external_anchor"
  | "packed_forest_marginal";

export interface BoundaryObservation {
  sourceDocumentId: string;
  features: BoundaryFeatureVector;
  positiveMass: number;
  negativeMass: number;
  supervision: BoundarySupervision;
  signalKind: BoundarySignalKind;
  signalId: string;
}

export interface BoundaryStatisticsRow {
  key: string;
  featuresFixed: number[];
  anchoredPositiveMass: number;
  anchoredNegativeMass: number;
  latentPositiveMass: number;
  latentNegativeMass: number;
  positiveMass: number;
  negativeMass: number;
}

export interface BoundarySufficientStatistics {
  schema: typeof BOUNDARY_STATISTICS_SCHEMA;
  populationId: string;
  normalizationContractId: string;
  featureOrder: readonly string[];
  scale: number;
  rows: BoundaryStatisticsRow[];
  positiveMass: number;
  negativeMass: number;
  anchoredMass: number;
  latentMass: number;
  sourceDocumentIds: string[];
  id: string;
  audit: JsonValue;
}

export interface BoundaryCalibrationReport {
  method: "platt_heldout" | "identity_no_holdout";
  slope: number;
  intercept: number;
  heldoutStatisticsId?: string;
  heldoutSourceDocumentIds: string[];
  examples: number;
  mass: number;
  logLoss: number | null;
  brier: number | null;
  expectedCalibrationError: number | null;
  anchorPrecision: number | null;
  anchorRecall: number | null;
  predictiveCompressionGainNats: number | null;
  shardCount: number;
  shardLogLossStdDev: number | null;
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
  training: {
    examples: number;
    positiveMass: number;
    negativeMass: number;
    logLoss: number;
  };
  calibration: BoundaryCalibrationReport;
  audit: JsonValue;
}

export interface BoundaryEstimatorMixture {
  schema: typeof BOUNDARY_ESTIMATOR_MIXTURE_SCHEMA;
  id: string;
  populationModelId: string;
  components: Array<{
    populationId: string;
    weight: number;
    estimator: BoundaryEstimatorModel;
  }>;
}

export type BoundaryEstimatorState = BoundaryEstimatorModel | BoundaryEstimatorMixture;

const FEATURE_ORDER: readonly (keyof BoundaryFeatureVector)[] = [
  "whitespaceAdjacent",
  "punctuationAdjacent",
  "lineBreakAdjacent",
  "scriptTransition",
  "structuralBoundary",
  "localTransitionEntropy",
  "repeatedContextSupport",
  "crossDocumentRecurrence",
  "predictiveCompressionGain",
  "stableSubstitutionSupport",
  "exactPhraseRecurrence",
  "constructionReuse"
] as const;
const FIXED_SCALE = 1_000_000;
const MASS_SCALE = 1_024;

export function compileBoundaryStatistics(input: {
  populationId: string;
  observations: readonly BoundaryObservation[];
  sourceDocumentIds?: readonly string[];
  normalizationContractId?: string;
  hasher?: Hasher;
}): BoundarySufficientStatistics {
  const hasher = input.hasher ?? createHasher();
  const normalizationContractId = input.normalizationContractId
    ?? canonicalNormalizationContract(hasher).id;
  const rows = new Map<string, BoundaryStatisticsRow>();
  const signalKinds = new Set<BoundarySignalKind>();
  const signalIds = new Set<string>();
  for (const observation of input.observations) {
    validateObservation(observation);
    signalKinds.add(observation.signalKind);
    signalIds.add(observation.signalId);
    const featuresFixed = featureArray(observation.features)
      .map(value => Math.round(clamp01(value) * FIXED_SCALE));
    const key = featuresFixed.join(":");
    const current = rows.get(key) ?? emptyStatisticsRow(key, featuresFixed);
    const positive = fixedMass(observation.positiveMass);
    const negative = fixedMass(observation.negativeMass);
    if (observation.supervision === "independent_anchor") {
      current.anchoredPositiveMass = safeAdd(current.anchoredPositiveMass, positive);
      current.anchoredNegativeMass = safeAdd(current.anchoredNegativeMass, negative);
    } else {
      current.latentPositiveMass = safeAdd(current.latentPositiveMass, positive);
      current.latentNegativeMass = safeAdd(current.latentNegativeMass, negative);
    }
    current.positiveMass = safeAdd(current.positiveMass, positive);
    current.negativeMass = safeAdd(current.negativeMass, negative);
    rows.set(key, current);
  }
  const ordered = [...rows.values()]
    .filter(row => row.positiveMass + row.negativeMass > 0)
    .sort((left, right) => left.key.localeCompare(right.key));
  const sourceDocumentIds = [...new Set(input.sourceDocumentIds ?? [])].sort();
  const canonical = {
    schema: BOUNDARY_STATISTICS_SCHEMA,
    populationId: input.populationId,
    normalizationContractId,
    featureOrder: FEATURE_ORDER,
    scale: FIXED_SCALE,
    rows: ordered,
    sourceDocumentIds
  };
  const id = `boundary_statistics.${hasher.digestHex(JSON.stringify(canonical)).slice(0, 40)}`;
  const anchoredMass = ordered.reduce((sum, row) =>
    sum + row.anchoredPositiveMass + row.anchoredNegativeMass, 0);
  const latentMass = ordered.reduce((sum, row) =>
    sum + row.latentPositiveMass + row.latentNegativeMass, 0);
  return {
    ...canonical,
    id,
    positiveMass: ordered.reduce((sum, row) => sum + row.positiveMass, 0),
    negativeMass: ordered.reduce((sum, row) => sum + row.negativeMass, 0),
    anchoredMass,
    latentMass,
    audit: toJsonValue({
      compiler: "kernel.boundary_statistics.v2",
      normalizationContractId,
      exactIntegerMass: true,
      canonicalRowOrder: true,
      detectorDecisionsAcceptedAsLabels: false,
      rows: ordered.length,
      signals: signalIds.size,
      signalKinds: [...signalKinds].sort(),
      anchoredMass,
      latentMass,
      sourceDocuments: sourceDocumentIds.length
    })
  };
}

export function mergeBoundaryStatistics(
  statistics: readonly BoundarySufficientStatistics[],
  hasher: Hasher = createHasher(),
  targetPopulationId?: string
): BoundarySufficientStatistics {
  if (!statistics.length) {
    return compileBoundaryStatistics({
      populationId: targetPopulationId ?? "population.unassigned",
      observations: [],
      hasher
    });
  }
  const populationId = statistics[0]!.populationId;
  if (statistics.some(item =>
    item.schema !== BOUNDARY_STATISTICS_SCHEMA
    || item.populationId !== populationId
    || item.normalizationContractId !== statistics[0]!.normalizationContractId
    || item.scale !== FIXED_SCALE
    || item.featureOrder.join("\u001f") !== FEATURE_ORDER.join("\u001f"))) {
    throw new Error("boundary statistics merge requires one schema and population");
  }
  const rows = new Map<string, BoundaryStatisticsRow>();
  for (const statistic of [...statistics].sort((left, right) => left.id.localeCompare(right.id))) {
    for (const row of statistic.rows) {
      const current = rows.get(row.key) ?? emptyStatisticsRow(row.key, [...row.featuresFixed]);
      current.anchoredPositiveMass = safeAdd(current.anchoredPositiveMass, row.anchoredPositiveMass);
      current.anchoredNegativeMass = safeAdd(current.anchoredNegativeMass, row.anchoredNegativeMass);
      current.latentPositiveMass = safeAdd(current.latentPositiveMass, row.latentPositiveMass);
      current.latentNegativeMass = safeAdd(current.latentNegativeMass, row.latentNegativeMass);
      current.positiveMass = safeAdd(current.positiveMass, row.positiveMass);
      current.negativeMass = safeAdd(current.negativeMass, row.negativeMass);
      rows.set(row.key, current);
    }
  }
  const observations: BoundaryObservation[] = [];
  for (const row of [...rows.values()].sort((left, right) => left.key.localeCompare(right.key))) {
    const features = featureRecord(row.featuresFixed.map(value => value / FIXED_SCALE));
    if (row.anchoredPositiveMass + row.anchoredNegativeMass > 0) {
      observations.push({
        sourceDocumentId: statistics.flatMap(item => item.sourceDocumentIds)[0] ?? "document.merged",
        features,
        positiveMass: row.anchoredPositiveMass / MASS_SCALE,
        negativeMass: row.anchoredNegativeMass / MASS_SCALE,
        supervision: "independent_anchor",
        signalKind: "external_anchor",
        signalId: `merged.anchor.${row.key}`
      });
    }
    if (row.latentPositiveMass + row.latentNegativeMass > 0) {
      observations.push({
        sourceDocumentId: statistics.flatMap(item => item.sourceDocumentIds)[0] ?? "document.merged",
        features,
        positiveMass: row.latentPositiveMass / MASS_SCALE,
        negativeMass: row.latentNegativeMass / MASS_SCALE,
        supervision: "latent_marginal",
        signalKind: "packed_forest_marginal",
        signalId: `merged.latent.${row.key}`
      });
    }
  }
  return compileBoundaryStatistics({
    populationId: targetPopulationId ?? populationId,
    observations,
    sourceDocumentIds: statistics.flatMap(item => item.sourceDocumentIds),
    normalizationContractId: statistics[0]!.normalizationContractId,
    hasher
  });
}

export function fitBoundaryEstimator(input: {
  statistics: BoundarySufficientStatistics;
  calibrationStatistics?: BoundarySufficientStatistics;
  calibrationShards?: readonly BoundarySufficientStatistics[];
  iterations?: number;
  learningRate?: number;
  l2?: number;
  hasher?: Hasher;
}): BoundaryEstimatorModel {
  const hasher = input.hasher ?? createHasher();
  validateSourceDisjoint(input.statistics, input.calibrationStatistics);
  for (const shard of input.calibrationShards ?? []) {
    validateSourceDisjoint(input.statistics, shard);
  }
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

  const trainingLogLoss = rawBoundaryLogLoss(input.statistics, weights, intercept);
  const calibration = fitHeldoutCalibration({
    statistics: input.calibrationStatistics,
    shards: input.calibrationShards ?? [],
    weights,
    intercept
  });
  const canonical = {
    schema: BOUNDARY_ESTIMATOR_SCHEMA,
    populationId: input.statistics.populationId,
    featureOrder: FEATURE_ORDER,
    weights,
    intercept,
    trainingStatisticsId: input.statistics.id,
    iterations,
    l2,
    training: {
      examples: input.statistics.rows.length,
      positiveMass: totalPositive,
      negativeMass: totalNegative,
      logLoss: trainingLogLoss
    },
    calibration
  };
  return {
    ...canonical,
    id: `boundary_estimator.${hasher.digestHex(JSON.stringify(canonical)).slice(0, 40)}`,
    audit: toJsonValue({
      trainer: "kernel.boundary_estimator.logistic_platt.v2",
      deterministicCanonicalRows: true,
      quantizedParameters: true,
      learnedFinalCoefficientsOnly: true,
      latentMarginalsAccepted: input.statistics.latentMass > 0,
      heldoutCalibration: calibration.method === "platt_heldout",
      sourceDisjointCalibration: true,
      learningRate
    })
  };
}

export function scoreBoundary(
  model: BoundaryEstimatorModel,
  features: BoundaryFeatureVector
): number {
  validateModel(model);
  const rawLogit = model.intercept + dot(model.weights, featureArray(features));
  return clamp01(sigmoid(
    model.calibration.slope * rawLogit + model.calibration.intercept
  ));
}

export function scoreBoundaryState(
  state: BoundaryEstimatorState,
  features: BoundaryFeatureVector
): number {
  if (state.schema === BOUNDARY_ESTIMATOR_SCHEMA) return scoreBoundary(state, features);
  if (state.schema !== BOUNDARY_ESTIMATOR_MIXTURE_SCHEMA || state.components.length === 0) {
    throw new Error("incompatible boundary estimator state");
  }
  const totalWeight = state.components.reduce((sum, component) =>
    sum + Math.max(0, component.weight), 0);
  if (totalWeight <= 0) throw new Error("boundary estimator mixture has no positive mass");
  return clamp01(state.components.reduce((sum, component) =>
    sum + Math.max(0, component.weight) * scoreBoundary(component.estimator, features), 0) / totalWeight);
}

export function boundaryNegativeLogLikelihood(
  model: BoundaryEstimatorModel,
  statistics: BoundarySufficientStatistics
): { negativeLogLikelihood: number; mass: number; averageLogLoss: number } {
  validateModel(model);
  let negativeLogLikelihood = 0;
  let mass = 0;
  for (const row of statistics.rows) {
    const positive = row.positiveMass / MASS_SCALE;
    const negative = row.negativeMass / MASS_SCALE;
    const features = featureRecord(row.featuresFixed.map(value => value / FIXED_SCALE));
    const predicted = clampProbability(scoreBoundary(model, features));
    negativeLogLikelihood += -positive * Math.log(predicted) - negative * Math.log(1 - predicted);
    mass += positive + negative;
  }
  return {
    negativeLogLikelihood: quantize(negativeLogLikelihood),
    mass: quantize(mass),
    averageLogLoss: quantize(negativeLogLikelihood / Math.max(1, mass))
  };
}

function fitHeldoutCalibration(input: {
  statistics?: BoundarySufficientStatistics;
  shards: readonly BoundarySufficientStatistics[];
  weights: readonly number[];
  intercept: number;
}): BoundaryCalibrationReport {
  const statistics = input.statistics;
  if (!statistics || statistics.positiveMass + statistics.negativeMass <= 0) {
    return {
      method: "identity_no_holdout",
      slope: 1,
      intercept: 0,
      heldoutSourceDocumentIds: [],
      examples: 0,
      mass: 0,
      logLoss: null,
      brier: null,
      expectedCalibrationError: null,
      anchorPrecision: null,
      anchorRecall: null,
      predictiveCompressionGainNats: null,
      shardCount: 0,
      shardLogLossStdDev: null
    };
  }
  let slope = 1;
  let calibrationIntercept = 0;
  const mass = Math.max(1, (statistics.positiveMass + statistics.negativeMass) / MASS_SCALE);
  for (let iteration = 0; iteration < 160; iteration += 1) {
    let slopeGradient = 0;
    let interceptGradient = 0;
    for (const row of statistics.rows) {
      const positive = row.positiveMass / MASS_SCALE;
      const negative = row.negativeMass / MASS_SCALE;
      const rowMass = positive + negative;
      if (rowMass <= 0) continue;
      const rawLogit = input.intercept + dot(
        input.weights,
        row.featuresFixed.map(value => value / FIXED_SCALE)
      );
      const residual = sigmoid(slope * rawLogit + calibrationIntercept) * rowMass - positive;
      slopeGradient += residual * rawLogit;
      interceptGradient += residual;
    }
    slope = quantize(Math.min(10, Math.max(0.05, slope - 0.08 * slopeGradient / mass)));
    calibrationIntercept = quantize(calibrationIntercept - 0.08 * interceptGradient / mass);
  }
  const metrics = calibrationMetrics(statistics, input.weights, input.intercept, slope, calibrationIntercept);
  const shardLosses = input.shards
    .filter(shard => shard.positiveMass + shard.negativeMass > 0)
    .map(shard => calibrationMetrics(
      shard,
      input.weights,
      input.intercept,
      slope,
      calibrationIntercept
    ).logLoss);
  return {
    method: "platt_heldout",
    slope,
    intercept: calibrationIntercept,
    heldoutStatisticsId: statistics.id,
    heldoutSourceDocumentIds: [...statistics.sourceDocumentIds],
    examples: statistics.rows.length,
    mass: metrics.mass,
    logLoss: metrics.logLoss,
    brier: metrics.brier,
    expectedCalibrationError: metrics.expectedCalibrationError,
    anchorPrecision: metrics.anchorPrecision,
    anchorRecall: metrics.anchorRecall,
    predictiveCompressionGainNats: metrics.predictiveCompressionGainNats,
    shardCount: shardLosses.length,
    shardLogLossStdDev: shardLosses.length
      ? quantize(standardDeviation(shardLosses))
      : null
  };
}

function calibrationMetrics(
  statistics: BoundarySufficientStatistics,
  weights: readonly number[],
  rawIntercept: number,
  slope: number,
  calibrationIntercept: number
): {
  mass: number;
  logLoss: number;
  brier: number;
  expectedCalibrationError: number;
  anchorPrecision: number | null;
  anchorRecall: number | null;
  predictiveCompressionGainNats: number;
} {
  let logLoss = 0;
  let brier = 0;
  let mass = 0;
  let truePositive = 0;
  let falsePositive = 0;
  let falseNegative = 0;
  const bins = Array.from({ length: 10 }, () => ({ predicted: 0, positive: 0, mass: 0 }));
  for (const row of statistics.rows) {
    const positive = row.positiveMass / MASS_SCALE;
    const negative = row.negativeMass / MASS_SCALE;
    const rowMass = positive + negative;
    if (rowMass <= 0) continue;
    const rawLogit = rawIntercept + dot(weights, row.featuresFixed.map(value => value / FIXED_SCALE));
    const predicted = clampProbability(sigmoid(slope * rawLogit + calibrationIntercept));
    logLoss += -positive * Math.log(predicted) - negative * Math.log(1 - predicted);
    brier += positive * (1 - predicted) ** 2 + negative * predicted ** 2;
    mass += rowMass;
    const bin = bins[Math.min(9, Math.floor(predicted * 10))]!;
    bin.predicted += predicted * rowMass;
    bin.positive += positive;
    bin.mass += rowMass;
    const anchorPositive = row.anchoredPositiveMass / MASS_SCALE;
    const anchorNegative = row.anchoredNegativeMass / MASS_SCALE;
    if (predicted >= 0.5) {
      truePositive += anchorPositive;
      falsePositive += anchorNegative;
    } else {
      falseNegative += anchorPositive;
    }
  }
  let ece = 0;
  for (const bin of bins) {
    if (bin.mass <= 0) continue;
    ece += bin.mass / Math.max(1, mass)
      * Math.abs(bin.predicted / bin.mass - bin.positive / bin.mass);
  }
  const positiveRate = statistics.positiveMass
    / Math.max(1, statistics.positiveMass + statistics.negativeMass);
  const neutral = Math.min(1 - 1e-12, Math.max(1e-12, positiveRate));
  const baselineLogLoss = (
    -(statistics.positiveMass / MASS_SCALE) * Math.log(neutral)
    -(statistics.negativeMass / MASS_SCALE) * Math.log(1 - neutral)
  ) / Math.max(1, mass);
  const averageLogLoss = logLoss / Math.max(1, mass);
  return {
    mass: quantize(mass),
    logLoss: quantize(averageLogLoss),
    brier: quantize(brier / Math.max(1, mass)),
    expectedCalibrationError: quantize(ece),
    anchorPrecision: truePositive + falsePositive > 0
      ? quantize(truePositive / (truePositive + falsePositive))
      : null,
    anchorRecall: truePositive + falseNegative > 0
      ? quantize(truePositive / (truePositive + falseNegative))
      : null,
    predictiveCompressionGainNats: quantize(baselineLogLoss - averageLogLoss)
  };
}

function rawBoundaryLogLoss(
  statistics: BoundarySufficientStatistics,
  weights: readonly number[],
  intercept: number
): number {
  let negativeLogLikelihood = 0;
  let mass = 0;
  for (const row of statistics.rows) {
    const positive = row.positiveMass / MASS_SCALE;
    const negative = row.negativeMass / MASS_SCALE;
    const predicted = clampProbability(sigmoid(
      intercept + dot(weights, row.featuresFixed.map(value => value / FIXED_SCALE))
    ));
    negativeLogLikelihood += -positive * Math.log(predicted) - negative * Math.log(1 - predicted);
    mass += positive + negative;
  }
  return quantize(negativeLogLikelihood / Math.max(1, mass));
}

function validateObservation(observation: BoundaryObservation): void {
  if (!observation.sourceDocumentId.trim()) throw new Error("boundary observation requires sourceDocumentId");
  if (!observation.signalId.trim()) throw new Error("boundary observation requires signalId");
  if (observation.signalId.includes("candidate_detector")
    || observation.signalId.includes("bootstrap_endpoint")) {
    throw new Error("candidate detector decisions cannot supervise boundary learning");
  }
  if (observation.supervision === "latent_marginal"
    && observation.signalKind !== "packed_forest_marginal") {
    throw new Error("latent boundary supervision must come from a packed-forest marginal");
  }
  if (observation.supervision === "independent_anchor"
    && observation.signalKind === "packed_forest_marginal") {
    throw new Error("packed-forest marginals are not independent anchors");
  }
}

function validateSourceDisjoint(
  training: BoundarySufficientStatistics,
  heldout?: BoundarySufficientStatistics
): void {
  if (!heldout) return;
  const trainingSources = new Set(training.sourceDocumentIds);
  const overlap = heldout.sourceDocumentIds.filter(source => trainingSources.has(source));
  if (overlap.length) {
    throw new Error(`boundary calibration sources overlap training sources: ${overlap.join(",")}`);
  }
}

function validateModel(model: BoundaryEstimatorModel): void {
  if (model.schema !== BOUNDARY_ESTIMATOR_SCHEMA
    || model.featureOrder.join("\u001f") !== FEATURE_ORDER.join("\u001f")
    || model.weights.length !== FEATURE_ORDER.length) {
    throw new Error("incompatible boundary estimator model");
  }
}

function emptyStatisticsRow(key: string, featuresFixed: number[]): BoundaryStatisticsRow {
  return {
    key,
    featuresFixed,
    anchoredPositiveMass: 0,
    anchoredNegativeMass: 0,
    latentPositiveMass: 0,
    latentNegativeMass: 0,
    positiveMass: 0,
    negativeMass: 0
  };
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
    repeatedContextSupport: values[6] ?? 0,
    crossDocumentRecurrence: values[7] ?? 0,
    predictiveCompressionGain: values[8] ?? 0,
    stableSubstitutionSupport: values[9] ?? 0,
    exactPhraseRecurrence: values[10] ?? 0,
    constructionReuse: values[11] ?? 0
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

function standardDeviation(values: readonly number[]): number {
  if (!values.length) return 0;
  const average = values.reduce((sum, value) => sum + value, 0) / values.length;
  return Math.sqrt(values.reduce((sum, value) => sum + (value - average) ** 2, 0) / values.length);
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

function clampProbability(value: number): number {
  return Math.min(1 - 1e-12, Math.max(1e-12, clamp01(value)));
}
