// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
import { BOUNDARY_ESTIMATOR_INFERENCE_SCHEMA, BOUNDARY_FEATURE_ORDER, BOUNDARY_STATISTICS_SCHEMA,
  type BoundaryEstimatorInferenceModel, type BoundaryEstimatorScoringModel, type BoundaryStatisticsRow } from "./boundary-estimator.js";
import { BoundaryGradientPass, BoundaryCalibrationPass, BoundaryMetricsPass, boundaryFitDot, boundaryFitQuantize } from "./boundary-fit-math.js";
import type { BoundaryStatisticsCursor } from "./corpus-segmentation-cursor.js";
import { createHasher, toJsonValue } from "./primitives.js";
import type { Hasher } from "./types.js";
import { canonicalDigestHex } from "./canonical-json-digest.js";

async function* documents(source: BoundaryStatisticsCursor): AsyncGenerator<string> {
  let previous: string | undefined;
  let count = 0;
  for await (const page of source.sourceDocuments()) for (const id of page) {
    if (!id || previous !== undefined && previous >= id) throw new Error("boundary source inventory is not canonical");
    previous = id; count++; yield id;
  }
  if (count !== source.header.sourceInventory.count) throw new Error("boundary source inventory count changed");
}

async function disjoint(left: BoundaryStatisticsCursor, right?: BoundaryStatisticsCursor): Promise<void> {
  if (!right) return;
  const a = documents(left); const b = documents(right);
  let currentA = await a.next(); let currentB = await b.next();
  try {
    while (!currentA.done || !currentB.done) {
      if (currentA.done) { currentB = await b.next(); continue; }
      if (currentB.done) { currentA = await a.next(); continue; }
      const comparison = currentA.value < currentB.value ? -1 : currentA.value > currentB.value ? 1 : 0;
      if (!comparison) throw new Error("boundary calibration sources overlap training sources");
      if (comparison < 0) currentA = await a.next(); else currentB = await b.next();
    }
  } finally { await a.return(undefined); await b.return(undefined); }
}

export async function forEachCanonicalBoundaryRow(source: BoundaryStatisticsCursor, visit: (row: BoundaryStatisticsRow) => void, validate = true): Promise<void> {
  const header = source.header;
  if (header.schema !== BOUNDARY_STATISTICS_SCHEMA || header.scale !== 1_000_000
    || header.featureOrder.join("\u001f") !== BOUNDARY_FEATURE_ORDER.join("\u001f")) throw new Error("incompatible paged boundary statistics");
  let previous: string | undefined; let count = 0; let positive = 0; let negative = 0;
  for await (const page of source.rows()) for (const row of page) {
    if (validate && (previous !== undefined && previous.localeCompare(row.key) >= 0
      || row.featuresFixed.length !== BOUNDARY_FEATURE_ORDER.length || row.key !== row.featuresFixed.join(":")
      || row.featuresFixed.some(value => !Number.isSafeInteger(value) || value < 0 || value > 1_000_000))) throw new Error("boundary rows are not canonical");
    if (!Number.isSafeInteger(row.positiveMass) || !Number.isSafeInteger(row.negativeMass) || row.positiveMass < 0 || row.negativeMass < 0) throw new Error("invalid boundary row mass");
    previous = row.key; count++; positive += row.positiveMass; negative += row.negativeMass; visit(row);
  }
  if (count !== header.rowCount || positive !== header.positiveMass || negative !== header.negativeMass
    || !Number.isSafeInteger(positive) || !Number.isSafeInteger(negative)) throw new Error("boundary cursor inventory changed");
}

async function metrics(source: BoundaryStatisticsCursor, weights: readonly number[], intercept: number, slope = 1, calibrationIntercept = 0) {
  const pass = new BoundaryMetricsPass(weights, intercept, slope, calibrationIntercept);
  await forEachCanonicalBoundaryRow(source, row => pass.add(row));
  return { ...pass.finish(source.header.positiveMass, source.header.negativeMass), negativeLogLikelihood: boundaryFitQuantize(pass.logLoss) };
}

export async function pagedBoundaryNegativeLogLikelihood(model: BoundaryEstimatorScoringModel, source: BoundaryStatisticsCursor) {
  const value = await metrics(source, model.weights, model.intercept, model.calibration.slope, model.calibration.intercept);
  return { negativeLogLikelihood: value.negativeLogLikelihood, mass: value.mass, averageLogLoss: value.logLoss };
}

export async function fitPagedBoundaryEstimator(input: {
  statistics: BoundaryStatisticsCursor;
  calibrationStatistics?: BoundaryStatisticsCursor;
  calibrationShards?: () => AsyncIterable<BoundaryStatisticsCursor>;
  iterations?: number;
  learningRate?: number;
  l2?: number;
  hasher?: Hasher;
}): Promise<BoundaryEstimatorInferenceModel> {
  const hasher = input.hasher ?? createHasher();
  await disjoint(input.statistics, input.calibrationStatistics);
  if (input.calibrationShards) for await (const shard of input.calibrationShards()) await disjoint(input.statistics, shard);
  const iterations = Math.max(1, Math.min(512, Math.floor(input.iterations ?? 96)));
  const learningRate = Math.max(1e-5, Math.min(1, input.learningRate ?? 0.18));
  const l2 = Math.max(0, Math.min(10, input.l2 ?? 0.02));
  const header = input.statistics.header;
  const positive = header.positiveMass / 1_024; const negative = header.negativeMass / 1_024;
  const totalMass = Math.max(1, positive + negative);
  const gradient = new BoundaryGradientPass(new Array<number>(BOUNDARY_FEATURE_ORDER.length).fill(0), Math.log((positive + 0.5) / (negative + 0.5)));
  const features = new Float64Array(BOUNDARY_FEATURE_ORDER.length);
  for (let iteration = 0; iteration < iterations; iteration++) {
    gradient.begin();
    await forEachCanonicalBoundaryRow(input.statistics, row => {
      if (row.positiveMass + row.negativeMass <= 0) return;
      for (let index = 0; index < features.length; index++) features[index] = (row.featuresFixed[index] ?? 0) / 1_000_000;
      gradient.add(features, 0, row.positiveMass / 1_024, row.positiveMass / 1_024 + row.negativeMass / 1_024);
    }, iteration === 0);
    gradient.finish(totalMass, learningRate, l2);
  }
  const trainingMetrics = await metrics(input.statistics, gradient.weights, gradient.intercept);
  const heldout = input.calibrationStatistics;
  const hasHeldout = heldout !== undefined && heldout.header.positiveMass + heldout.header.negativeMass > 0;
  const calibration = new BoundaryCalibrationPass();
  if (hasHeldout) {
    const mass = Math.max(1, (heldout.header.positiveMass + heldout.header.negativeMass) / 1_024);
    for (let iteration = 0; iteration < 160; iteration++) {
      calibration.begin();
      await forEachCanonicalBoundaryRow(heldout, row => {
        if (row.positiveMass + row.negativeMass <= 0) return;
        for (let index = 0; index < features.length; index++) features[index] = row.featuresFixed[index]! / 1_000_000;
        calibration.add(gradient.intercept + boundaryFitDot(gradient.weights, features), row.positiveMass / 1_024,
          row.positiveMass / 1_024 + row.negativeMass / 1_024);
      }, iteration === 0);
      calibration.finish(mass);
    }
  }
  const heldoutMetrics = hasHeldout ? await metrics(heldout, gradient.weights, gradient.intercept, calibration.slope, calibration.intercept) : undefined;
  let shardCount = 0; let shardSum = 0;
  if (hasHeldout && input.calibrationShards) for await (const shard of input.calibrationShards()) {
    if (shard.header.positiveMass + shard.header.negativeMass <= 0) continue;
    shardSum += (await metrics(shard, gradient.weights, gradient.intercept, calibration.slope, calibration.intercept)).logLoss; shardCount++;
  }
  let shardSquaredError = 0;
  if (shardCount && input.calibrationShards) for await (const shard of input.calibrationShards()) {
    if (shard.header.positiveMass + shard.header.negativeMass <= 0) continue;
    const value = (await metrics(shard, gradient.weights, gradient.intercept, calibration.slope, calibration.intercept)).logLoss;
    shardSquaredError += (value - shardSum / shardCount) ** 2;
  }
  const { negativeLogLikelihood: _likelihood, ...calibrationMetrics } = heldoutMetrics ?? { negativeLogLikelihood: 0,
    mass: 0, logLoss: null, brier: null, expectedCalibrationError: null, anchorPrecision: null,
    anchorRecall: null, predictiveCompressionGainNats: null };
  const canonical = { schema: BOUNDARY_ESTIMATOR_INFERENCE_SCHEMA, populationId: header.populationId,
    featureOrder: BOUNDARY_FEATURE_ORDER, weights: gradient.weights, intercept: gradient.intercept, trainingStatisticsId: header.id,
    sourceInventory: header.sourceInventory, iterations, l2,
    training: { examples: header.rowCount, positiveMass: positive, negativeMass: negative, logLoss: trainingMetrics.logLoss },
    calibration: { method: hasHeldout ? "platt_heldout" as const : "identity_no_holdout" as const,
      slope: calibration.slope, intercept: calibration.intercept,
      ...(hasHeldout ? { heldoutStatisticsId: heldout.header.id, heldoutSourceInventory: heldout.header.sourceInventory } : {}),
      examples: hasHeldout ? heldout.header.rowCount : 0, ...calibrationMetrics,
      shardCount, shardLogLossStdDev: shardCount ? boundaryFitQuantize(Math.sqrt(shardSquaredError / shardCount)) : null } };
  return { ...canonical, id: `boundary_estimator_inference.${canonicalDigestHex(canonical, hasher).slice(0, 40)}`,
    audit: toJsonValue({ trainer: "kernel.boundary_estimator.logistic_platt.v2", deterministicCanonicalRows: true,
      quantizedParameters: true, learnedFinalCoefficientsOnly: true, latentMarginalsAccepted: header.latentMass > 0,
      heldoutCalibration: hasHeldout, sourceDisjointCalibration: true, learningRate, storage: "replayable_canonical_rows" }) };
}
