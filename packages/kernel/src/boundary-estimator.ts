// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
import { clamp01, createHasher, toJsonValue } from "./primitives.js";
import type { Hasher, JsonValue } from "./types.js";
import { canonicalNormalizationContract } from "./normalization-contract.js";
import { boundaryFitDot as dot, boundaryFitSigmoid as sigmoid, boundaryFitQuantize as quantize,
  BoundaryGradientPass, BoundaryCalibrationPass, BoundaryMetricsPass } from "./boundary-fit-math.js";

export const BOUNDARY_ESTIMATOR_SCHEMA = "scce.boundary_estimator.v2" as const;
export const BOUNDARY_ESTIMATOR_MIXTURE_SCHEMA = "scce.boundary_estimator_mixture.v2" as const;
export const BOUNDARY_STATISTICS_SCHEMA = "scce.boundary_statistics.v2" as const;
export const BOUNDARY_ESTIMATOR_INFERENCE_SCHEMA = "scce.boundary_estimator_inference.v1" as const;

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
    estimator: BoundaryEstimatorScoringModel;
  }>;
}

export interface BoundaryEstimatorInferenceModel extends Omit<BoundaryEstimatorModel, "schema" | "calibration"> {
  schema: typeof BOUNDARY_ESTIMATOR_INFERENCE_SCHEMA;
  sourceInventory: { id: string; count: number };
  calibration: Omit<BoundaryCalibrationReport, "heldoutSourceDocumentIds"> & { heldoutSourceInventory?: { id: string; count: number } };
}

export type BoundaryEstimatorScoringModel = BoundaryEstimatorModel | BoundaryEstimatorInferenceModel;
export type BoundaryEstimatorState = BoundaryEstimatorScoringModel | BoundaryEstimatorMixture;

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
export const BOUNDARY_FEATURE_ORDER = FEATURE_ORDER;
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
  return finalizeBoundaryStatistics({ populationId: input.populationId, normalizationContractId, rows: rows.values(),
    sourceDocumentIds: input.sourceDocumentIds ?? [], signalKinds, signalCount: signalIds.size }, hasher);
}

function finalizeBoundaryStatistics(input: {
  populationId: string;
  normalizationContractId: string;
  rows: Iterable<BoundaryStatisticsRow>;
  sourceDocumentIds: readonly string[];
  signalKinds: ReadonlySet<BoundarySignalKind>;
  signalCount: number;
}, hasher: Hasher): BoundarySufficientStatistics {
  const ordered = [...input.rows]
    .filter(row => row.positiveMass + row.negativeMass > 0)
    .sort((left, right) => left.key.localeCompare(right.key));
  const sourceDocumentIds = [...new Set(input.sourceDocumentIds)].sort();
  const normalizationContractId = input.normalizationContractId;
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
      signals: input.signalCount,
      signalKinds: [...input.signalKinds].sort(),
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
  let canonicalRows = true;
  for (const statistic of [...statistics].sort((left, right) => left.id.localeCompare(right.id))) {
    let previousKey: string | undefined;
    for (const row of statistic.rows) {
      const fixed = row.featuresFixed;
      canonicalRows = canonicalRows
        && fixed.length === FEATURE_ORDER.length
        && fixed.every(value => Number.isSafeInteger(value) && value >= 0 && value <= FIXED_SCALE)
        && row.key === fixed.join(":")
        && (previousKey === undefined || previousKey.localeCompare(row.key) < 0)
        && [row.anchoredPositiveMass, row.anchoredNegativeMass, row.latentPositiveMass, row.latentNegativeMass,
          row.positiveMass, row.negativeMass].every(value => Number.isSafeInteger(value) && value >= 0)
        && row.positiveMass === row.anchoredPositiveMass + row.latentPositiveMass
        && row.negativeMass === row.anchoredNegativeMass + row.latentNegativeMass;
      previousKey = row.key;
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
  const compiledRows = new Map<string, BoundaryStatisticsRow>();
  const signalKinds = new Set<BoundarySignalKind>();
  const sourceDocumentIds = statistics.flatMap(item => item.sourceDocumentIds);
  const sourceDocumentId = sourceDocumentIds[0] ?? "document.merged";
  let signalCount = 0;
  if (canonicalRows) {
    for (const row of rows.values()) {
      if (row.anchoredPositiveMass + row.anchoredNegativeMass > 0) {
        validateObservationIdentity(sourceDocumentId, `merged.anchor.${row.key}`);
        signalKinds.add("external_anchor");
        signalCount++;
      }
      if (row.latentPositiveMass + row.latentNegativeMass > 0) {
        validateObservationIdentity(sourceDocumentId, `merged.latent.${row.key}`);
        signalKinds.add("packed_forest_marginal");
        signalCount++;
      }
    }
    return finalizeBoundaryStatistics({
      populationId: targetPopulationId ?? populationId,
      rows: rows.values(),
      sourceDocumentIds,
      normalizationContractId: statistics[0]!.normalizationContractId ?? canonicalNormalizationContract(hasher).id,
      signalKinds,
      signalCount
    }, hasher);
  }
  for (const row of [...rows.values()].sort((left, right) => left.key.localeCompare(right.key))) {
    const featuresFixed = FEATURE_ORDER.map((_, index) =>
      Math.round(clamp01((row.featuresFixed[index] ?? 0) / FIXED_SCALE) * FIXED_SCALE));
    const key = featuresFixed.join(":");
    const current = compiledRows.get(key) ?? emptyStatisticsRow(key, featuresFixed);
    if (row.anchoredPositiveMass + row.anchoredNegativeMass > 0) {
      validateObservationIdentity(sourceDocumentId, `merged.anchor.${row.key}`);
      const positive = fixedMass(row.anchoredPositiveMass / MASS_SCALE);
      const negative = fixedMass(row.anchoredNegativeMass / MASS_SCALE);
      current.anchoredPositiveMass = safeAdd(current.anchoredPositiveMass, positive);
      current.anchoredNegativeMass = safeAdd(current.anchoredNegativeMass, negative);
      current.positiveMass = safeAdd(current.positiveMass, positive);
      current.negativeMass = safeAdd(current.negativeMass, negative);
      signalKinds.add("external_anchor");
      signalCount++;
    }
    if (row.latentPositiveMass + row.latentNegativeMass > 0) {
      validateObservationIdentity(sourceDocumentId, `merged.latent.${row.key}`);
      const positive = fixedMass(row.latentPositiveMass / MASS_SCALE);
      const negative = fixedMass(row.latentNegativeMass / MASS_SCALE);
      current.latentPositiveMass = safeAdd(current.latentPositiveMass, positive);
      current.latentNegativeMass = safeAdd(current.latentNegativeMass, negative);
      current.positiveMass = safeAdd(current.positiveMass, positive);
      current.negativeMass = safeAdd(current.negativeMass, negative);
      signalKinds.add("packed_forest_marginal");
      signalCount++;
    }
    compiledRows.set(key, current);
  }
  return finalizeBoundaryStatistics({
    populationId: targetPopulationId ?? populationId,
    rows: compiledRows.values(),
    sourceDocumentIds,
    normalizationContractId: statistics[0]!.normalizationContractId ?? canonicalNormalizationContract(hasher).id,
    signalKinds,
    signalCount
  }, hasher);
}

export interface BoundaryEstimatorFitInput {
  statistics: BoundarySufficientStatistics;
  calibrationStatistics?: BoundarySufficientStatistics;
  calibrationShards?: readonly BoundarySufficientStatistics[];
  iterations?: number;
  learningRate?: number;
  l2?: number;
  hasher?: Hasher;
}

interface BoundaryFitSettings { iterations: number; learningRate: number; l2: number }
interface BoundaryFitNumerics {
  weights: number[];
  intercept: number;
  trainingLogLoss: number;
  calibration: Omit<BoundaryCalibrationReport, "heldoutStatisticsId" | "heldoutSourceDocumentIds">;
}

let numericalFitComputations = 0;
export function boundaryEstimatorNumericalFitCount(): number { return numericalFitComputations; }

/** Numerical reuse is private to one fitter; source validation and model identity are rebuilt on every request. */
export function createBoundaryEstimatorNumericalFitter(hasher: Hasher = createHasher()): (input: Omit<BoundaryEstimatorFitInput, "hasher">) => BoundaryEstimatorModel {
  const numerics = new Map<string, BoundaryFitNumerics>();
  return input => fitBoundaryEstimatorInternal({ ...input, hasher }, numerics);
}

export function fitBoundaryEstimator(input: BoundaryEstimatorFitInput): BoundaryEstimatorModel {
  return fitBoundaryEstimatorInternal(input);
}

function fitBoundaryEstimatorInternal(input: BoundaryEstimatorFitInput, numericalFits?: Map<string, BoundaryFitNumerics>): BoundaryEstimatorModel {
  const hasher = input.hasher ?? createHasher();
  validateSourceDisjoint(input.statistics, input.calibrationStatistics);
  for (const shard of input.calibrationShards ?? []) {
    validateSourceDisjoint(input.statistics, shard);
  }
  const iterations = Math.max(1, Math.min(512, Math.floor(input.iterations ?? 96)));
  const learningRate = Math.max(1e-5, Math.min(1, input.learningRate ?? 0.18));
  const l2 = Math.max(0, Math.min(10, input.l2 ?? 0.02));
  const settings = { iterations, learningRate, l2 };
  const key = numericalFits ? numericalFitKey(input, settings) : undefined;
  let numerical = key === undefined ? undefined : numericalFits?.get(key);
  if (!numerical) {
    numerical = computeBoundaryFitNumerics(input, settings);
    if (key !== undefined) numericalFits?.set(key, numerical);
  }
  const weights = [...numerical.weights];
  const intercept = numerical.intercept;
  const totalPositive = input.statistics.positiveMass / MASS_SCALE;
  const totalNegative = input.statistics.negativeMass / MASS_SCALE;
  const { method, slope, intercept: calibrationIntercept, ...metrics } = numerical.calibration;
  const calibration: BoundaryCalibrationReport = { method, slope, intercept: calibrationIntercept,
    ...(method === "platt_heldout" ? { heldoutStatisticsId: input.calibrationStatistics!.id } : {}),
    heldoutSourceDocumentIds: method === "platt_heldout" ? [...input.calibrationStatistics!.sourceDocumentIds] : [], ...metrics };
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
      logLoss: numerical.trainingLogLoss
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

function numericalFitKey(input: BoundaryEstimatorFitInput, settings: BoundaryFitSettings): string | undefined {
  const material = (statistics: BoundarySufficientStatistics | undefined) => {
    if (!statistics) return undefined;
    const { id: _id, populationId: _population, audit: _audit, ...values } = statistics;
    return values;
  };
  let finite = true;
  const key = JSON.stringify({ statistics: material(input.statistics), calibrationStatistics: material(input.calibrationStatistics),
    calibrationShards: (input.calibrationShards ?? []).map(material), settings }, (_key, value: unknown) => {
    if (typeof value === "number" && (!Number.isFinite(value) || Object.is(value, -0))) finite = false;
    return value;
  });
  // This value is only a lookup key in one short-lived fitter. The canonical
  // material itself has exactly the same equality semantics as its SHA-256,
  // without paying to hash a potentially large statistics payload each time.
  return finite ? key : undefined;
}

function computeBoundaryFitNumerics(input: BoundaryEstimatorFitInput, settings: BoundaryFitSettings): BoundaryFitNumerics {
  numericalFitComputations++;
  const { iterations, learningRate, l2 } = settings;
  const weights = new Array<number>(FEATURE_ORDER.length).fill(0);
  const totalPositive = input.statistics.positiveMass / MASS_SCALE;
  const totalNegative = input.statistics.negativeMass / MASS_SCALE;
  const totalMass = Math.max(1, totalPositive + totalNegative);
  let intercept = Math.log((totalPositive + 0.5) / (totalNegative + 0.5));

  // Flat typed arrays through the descent, for the reason buildOperatorRoutingModels already records: a
  // record-per-row form reallocates inside the loop and pointer-chases every feature. This descent is
  // iterations x rows x features -- the nesting IS the gradient, so it stays -- but everything avoidable inside
  // it is hoisted. The features are FIXED, so their scaling is done once rather than re-divided and
  // re-allocated per row on all 96 iterations; rows carrying no mass are dropped once; and the innermost loop
  // reads contiguous memory with no bounds-fallback. Measured before this: the fit was 30% of train.compile,
  // its scaling closure another 16%, and the collector 7%.
  //
  // The arithmetic is unchanged and rows are visited in the same order, so the fitted weights are identical.
  const featureCount = weights.length;
  const usable = input.statistics.rows.filter(row => row.positiveMass + row.negativeMass > 0);
  const rowFeatures = new Float64Array(usable.length * featureCount);
  const rowPositive = new Float64Array(usable.length);
  const rowMass = new Float64Array(usable.length);
  for (let r = 0; r < usable.length; r += 1) {
    const row = usable[r]!;
    for (let f = 0; f < featureCount; f += 1) {
      rowFeatures[r * featureCount + f] = (row.featuresFixed[f] ?? 0) / FIXED_SCALE;
    }
    rowPositive[r] = row.positiveMass / MASS_SCALE;
    rowMass[r] = row.positiveMass / MASS_SCALE + row.negativeMass / MASS_SCALE;
  }

  const gradient = new BoundaryGradientPass(weights, intercept);
  for (let iteration = 0; iteration < iterations; iteration += 1) {
    gradient.begin();
    for (let r = 0; r < usable.length; r += 1) {
      const base = r * featureCount;
      gradient.add(rowFeatures, base, rowPositive[r]!, rowMass[r]!);
    }
    gradient.finish(totalMass, learningRate, l2);
  }
  intercept = gradient.intercept;

  const trainingLogLoss = rawBoundaryLogLoss(input.statistics, weights, intercept);
  const calibration = fitHeldoutCalibration({
    statistics: input.calibrationStatistics,
    shards: input.calibrationShards ?? [],
    weights,
    intercept
  });
  const { heldoutStatisticsId: _heldoutId, heldoutSourceDocumentIds: _sources, ...values } = calibration;
  return { weights, intercept, trainingLogLoss, calibration: values };
}

export function scoreBoundary(
  model: BoundaryEstimatorScoringModel,
  features: BoundaryFeatureVector
): number {
  validateModel(model);
  const rawLogit = model.intercept + dotFeatureRecord(model.weights, features);
  return clamp01(sigmoid(
    model.calibration.slope * rawLogit + model.calibration.intercept
  ));
}

export function scoreBoundaryState(
  state: BoundaryEstimatorState,
  features: BoundaryFeatureVector
): number {
  if (state.schema === BOUNDARY_ESTIMATOR_SCHEMA || state.schema === BOUNDARY_ESTIMATOR_INFERENCE_SCHEMA) return scoreBoundary(state, features);
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
  model: BoundaryEstimatorScoringModel,
  statistics: BoundarySufficientStatistics
): { negativeLogLikelihood: number; mass: number; averageLogLoss: number } {
  validateModel(model);
  let negativeLogLikelihood = 0;
  let mass = 0;
  for (const row of statistics.rows) {
    const positive = row.positiveMass / MASS_SCALE;
    const negative = row.negativeMass / MASS_SCALE;
    const rawLogit = model.intercept + dotFixedFeatureRow(model.weights, row.featuresFixed);
    const predicted = clampProbability(clamp01(sigmoid(model.calibration.slope * rawLogit + model.calibration.intercept)));
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
  const calibrationPass = new BoundaryCalibrationPass();
  const mass = Math.max(1, (statistics.positiveMass + statistics.negativeMass) / MASS_SCALE);
  const rows = statistics.rows.filter(row => row.positiveMass + row.negativeMass > 0);
  const rawLogits = new Float64Array(rows.length);
  const positives = new Float64Array(rows.length);
  const masses = new Float64Array(rows.length);
  for (let index = 0; index < rows.length; index++) {
    const row = rows[index]!;
    positives[index] = row.positiveMass / MASS_SCALE;
    masses[index] = row.positiveMass / MASS_SCALE + row.negativeMass / MASS_SCALE;
    rawLogits[index] = input.intercept + dot(input.weights, row.featuresFixed.map(value => value / FIXED_SCALE));
  }
  for (let iteration = 0; iteration < 160; iteration += 1) {
    calibrationPass.begin();
    for (let index = 0; index < rows.length; index++) {
      calibrationPass.add(rawLogits[index]!, positives[index]!, masses[index]!);
    }
    calibrationPass.finish(mass);
  }
  const slope = calibrationPass.slope;
  const calibrationIntercept = calibrationPass.intercept;
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
  const pass = new BoundaryMetricsPass(weights, rawIntercept, slope, calibrationIntercept);
  for (const row of statistics.rows) pass.add(row);
  return pass.finish(statistics.positiveMass, statistics.negativeMass);
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
  validateObservationIdentity(observation.sourceDocumentId, observation.signalId);
  if (observation.supervision === "latent_marginal"
    && observation.signalKind !== "packed_forest_marginal") {
    throw new Error("latent boundary supervision must come from a packed-forest marginal");
  }
  if (observation.supervision === "independent_anchor"
    && observation.signalKind === "packed_forest_marginal") {
    throw new Error("packed-forest marginals are not independent anchors");
  }
}

function validateObservationIdentity(sourceDocumentId: string, signalId: string): void {
  if (!sourceDocumentId.trim()) throw new Error("boundary observation requires sourceDocumentId");
  if (!signalId.trim()) throw new Error("boundary observation requires signalId");
  if (signalId.includes("candidate_detector") || signalId.includes("bootstrap_endpoint")) {
    throw new Error("candidate detector decisions cannot supervise boundary learning");
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

function validateModel(model: BoundaryEstimatorScoringModel): void {
  if ((model.schema !== BOUNDARY_ESTIMATOR_SCHEMA && model.schema !== BOUNDARY_ESTIMATOR_INFERENCE_SCHEMA)
    || model.featureOrder.length !== FEATURE_ORDER.length
    || model.weights.length !== FEATURE_ORDER.length) {
    throw new Error("incompatible boundary estimator model");
  }
  for (let index = 0; index < FEATURE_ORDER.length; index++) {
    if (model.featureOrder[index] !== FEATURE_ORDER[index]) throw new Error("incompatible boundary estimator model");
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

function dotFeatureRecord(weights: readonly number[], features: BoundaryFeatureVector): number {
  let sum = 0;
  let compensation = 0;
  for (let index = 0; index < FEATURE_ORDER.length; index++) {
    const product = (weights[index] ?? 0) * (features[FEATURE_ORDER[index]!] ?? 0);
    const adjusted = product - compensation;
    const next = sum + adjusted;
    compensation = (next - sum) - adjusted;
    sum = next;
  }
  return sum;
}

function dotFixedFeatureRow(weights: readonly number[], featuresFixed: readonly number[]): number {
  let sum = 0;
  let compensation = 0;
  for (let index = 0; index < FEATURE_ORDER.length; index++) {
    const scaled = index < featuresFixed.length && index in featuresFixed ? featuresFixed[index]! / FIXED_SCALE : 0;
    const product = (weights[index] ?? 0) * scaled;
    const adjusted = product - compensation;
    const next = sum + adjusted;
    compensation = (next - sum) - adjusted;
    sum = next;
  }
  return sum;
}

function standardDeviation(values: readonly number[]): number {
  if (!values.length) return 0;
  const average = values.reduce((sum, value) => sum + value, 0) / values.length;
  return Math.sqrt(values.reduce((sum, value) => sum + (value - average) ** 2, 0) / values.length);
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
