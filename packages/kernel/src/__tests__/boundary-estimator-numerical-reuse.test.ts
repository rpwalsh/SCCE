// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
import { expect, it, vi } from "vitest";
import { compileBoundaryStatistics, fitBoundaryEstimator, mergeBoundaryStatistics, type BoundaryFeatureVector, type BoundarySufficientStatistics } from "../boundary-estimator.js";
import * as boundary from "../boundary-estimator.js";
import { createBoundaryEstimatorFitter } from "../boundary-fit-reuse.js";
import { createHasher } from "../primitives.js";

const hasher = createHasher();
const order = compileBoundaryStatistics({ populationId: "feature.order", observations: [] }).featureOrder;
function statistics(source: string): BoundarySufficientStatistics {
  return compileBoundaryStatistics({ populationId: "population.input", sourceDocumentIds: [source], hasher,
    observations: Array.from({ length: 7 }, (_, row) => ({ sourceDocumentId: source,
      features: Object.fromEntries(order.map((feature, index) => [feature, ((index + row) % 7) / 7])) as unknown as BoundaryFeatureVector,
      positiveMass: row + 1, negativeMass: 8 - row, supervision: "independent_anchor", signalKind: "external_anchor", signalId: `${source}.${row}` })) });
}
function input() {
  const training = statistics("source.training");
  const heldout = statistics("source.heldout");
  return { statistics: training, calibrationStatistics: heldout, calibrationShards: [heldout] };
}
function population(value: BoundarySufficientStatistics, populationId: string) {
  return mergeBoundaryStatistics([value], hasher, populationId);
}

it("reuses the numerical solve across provisional/final identities and rebuilds the exact current model", () => {
  const original = input();
  const provisional = { statistics: population(original.statistics, "population.provisional"),
    calibrationStatistics: population(original.calibrationStatistics, "population.provisional"),
    calibrationShards: original.calibrationShards.map(shard => population(shard, "population.provisional")) };
  const final = { statistics: population(original.statistics, "population.final"),
    calibrationStatistics: population(original.calibrationStatistics, "population.final"),
    calibrationShards: original.calibrationShards.map(shard => population(shard, "population.final")) };
  const expected = fitBoundaryEstimator(final);
  const fit = createBoundaryEstimatorFitter(hasher);
  const computations = boundary.boundaryEstimatorNumericalFitCount?.();
  const first = fit(provisional);
  const exponentials = vi.spyOn(Math, "exp");
  try {
    const model = fit(final);
    expect(model).toEqual(expected);
    expect(model.id).not.toBe(first.id);
    expect(model.populationId).toBe(final.statistics.populationId);
    expect(model.trainingStatisticsId).toBe(final.statistics.id);
    expect(model.calibration.heldoutStatisticsId).toBe(final.calibrationStatistics.id);
    expect(model.calibration.heldoutSourceDocumentIds).toEqual(final.calibrationStatistics.sourceDocumentIds);
    expect(model.weights).toEqual(first.weights);
    expect(model).not.toBe(first);
    expect(exponentials.mock.calls.length).toBe(0);
    expect(computations).toBeDefined();
    expect(boundary.boundaryEstimatorNumericalFitCount() - computations!).toBe(1);
    expect(() => { model.weights[0] = 99; }).toThrow();
  } finally { exponentials.mockRestore(); }
});

it("reruns source-disjoint validation even for an identical immutable model cache hit", () => {
  const current = input();
  const fit = createBoundaryEstimatorFitter(hasher);
  const first = fit(current);
  const checks = vi.spyOn(current.calibrationStatistics.sourceDocumentIds, "filter");
  try {
    expect(fit(current)).toBe(first);
    expect(checks).toHaveBeenCalledTimes(2);
  } finally { checks.mockRestore(); }
  current.calibrationStatistics.sourceDocumentIds[0] = current.statistics.sourceDocumentIds[0]!;
  expect(() => fit(current)).toThrow("overlap");
});

it("keeps default hyperparameter equivalence and does not merge signed zero or nonfinite arithmetic", () => {
  const original = input();
  const fit = createBoundaryEstimatorFitter(hasher);
  const first = fit(original);
  const computations = boundary.boundaryEstimatorNumericalFitCount();
  expect(fit({ ...original, iterations: 96, learningRate: 0.18, l2: 0.02 })).toBe(first);
  expect(boundary.boundaryEstimatorNumericalFitCount()).toBe(computations);
  const empty = compileBoundaryStatistics({ populationId: "empty", observations: [] });
  const finite = fit({ statistics: empty });
  for (const positiveMass of [-0, Infinity, NaN]) {
    const statistics = { ...empty, positiveMass };
    const expected = fitBoundaryEstimator({ statistics });
    const start = boundary.boundaryEstimatorNumericalFitCount();
    const actual = fit({ statistics });
    expect(actual).toEqual(expected);
    expect(Object.is(actual.training.positiveMass, positiveMass)).toBe(true);
    expect(actual).not.toBe(finite);
    expect(fit({ statistics })).toEqual(expected);
    expect(boundary.boundaryEstimatorNumericalFitCount() - start).toBe(2);
  }
});

it("never reuses a solve with changed numerical inputs, hyperparameters, source premises, or calibration shards", () => {
  const original = input();
  const changedFeatures = structuredClone(original);
  changedFeatures.statistics.rows[0]!.featuresFixed[0]! += 1;
  const changedMass = structuredClone(original);
  changedMass.statistics.positiveMass += 1024;
  const changedCalibration = structuredClone(original);
  changedCalibration.calibrationStatistics.rows[0]!.anchoredPositiveMass += 1024;
  const changedShard = structuredClone(original);
  changedShard.calibrationShards = [structuredClone(original.calibrationShards[0]!)];
  changedShard.calibrationShards[0]!.rows[0]!.positiveMass += 1024;
  const changedSources = structuredClone(original);
  changedSources.statistics.sourceDocumentIds = ["source.other.training"];
  const reversedRows = structuredClone(original);
  reversedRows.statistics.rows.reverse();
  for (const changed of [changedFeatures, changedMass, changedCalibration, changedShard, changedSources, reversedRows,
    { ...original, iterations: 2 }, { ...original, learningRate: 0.1 }, { ...original, l2: 0.1 },
    { ...original, calibrationShards: [] }]) {
    const expected = fitBoundaryEstimator(changed);
    const fit = createBoundaryEstimatorFitter(hasher);
    fit(original);
    const exponentials = vi.spyOn(Math, "exp");
    try {
      expect(fit(changed)).toEqual(expected);
      expect(exponentials).toHaveBeenCalled();
    } finally { exponentials.mockRestore(); }
  }
});
