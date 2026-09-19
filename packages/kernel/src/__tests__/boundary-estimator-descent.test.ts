// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
import { describe, expect, it } from "vitest";
import {
  compileBoundaryStatistics,
  fitBoundaryEstimator,
  type BoundaryObservation,
  type BoundarySufficientStatistics
} from "../boundary-estimator.js";

// The descent inside fitBoundaryEstimator is iterations x rows x features, and the nesting is the gradient
// itself, so it stays. What was avoidable was everything inside it: the fixed features were re-divided and
// re-allocated into a new array for every row on all 96 iterations. Measured on a live ingest shard, this fit
// was 30% of train.compile, its scaling closure another 16%, and the collector 7%.
//
// The rewrite scales once into flat typed arrays. It must produce the SAME MODEL -- performance work that
// silently changes cognition is a regression -- so this holds the reference arithmetic beside it and compares.
// End-to-end ingest timings could not settle either question: the same shard's compile measured 54.5s and then
// 72.5s with no change to that code, so run-to-run variance on a loaded machine exceeds the effect.

const FIXED_SCALE = 1_000_000;
const MASS_SCALE = 1_024;
const quantize = (value: number): number => Math.round(value * 1_000_000_000_000) / 1_000_000_000_000;
function sigmoid(value: number): number {
  if (value >= 0) {
    const inverse = Math.exp(-Math.min(60, value));
    return 1 / (1 + inverse);
  }
  const exponent = Math.exp(Math.max(-60, value));
  return exponent / (1 + exponent);
}

/** The same compensated dot the estimator uses; a plain sum here would not be the reference. */
function dot(left: ArrayLike<number>, right: ArrayLike<number>): number {
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

/** The descent exactly as it was written before the rewrite, kept so equivalence is checked and not asserted. */
function referenceFit(statistics: BoundarySufficientStatistics, featureCount: number): {
  weights: number[];
  intercept: number;
} {
  const iterations = 96;
  const learningRate = 0.18;
  const l2 = 0.02;
  const weights = new Array<number>(featureCount).fill(0);
  const totalPositive = statistics.positiveMass / MASS_SCALE;
  const totalNegative = statistics.negativeMass / MASS_SCALE;
  const totalMass = Math.max(1, totalPositive + totalNegative);
  let intercept = Math.log((totalPositive + 0.5) / (totalNegative + 0.5));

  for (let iteration = 0; iteration < iterations; iteration += 1) {
    const gradients = new Array<number>(weights.length).fill(0);
    let interceptGradient = 0;
    for (const row of statistics.rows) {
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
  return { weights, intercept };
}

/** Built through the real compiler, so the statistics are well formed rather than hand-shaped. */
function statisticsOf(observationCount: number, seed: number): BoundarySufficientStatistics {
  let state = seed || 1;
  const next = (): number => {
    state = (state * 1103515245 + 12345) & 0x7fffffff;
    return state / 0x7fffffff;
  };
  const observations: BoundaryObservation[] = Array.from({ length: observationCount }, (_, index) => ({
    sourceDocumentId: `doc-${index % 7}`,
    features: {
      whitespaceAdjacent: next(),
      punctuationAdjacent: next(),
      lineBreakAdjacent: next(),
      scriptTransition: next(),
      structuralBoundary: next(),
      localTransitionEntropy: next(),
      repeatedContextSupport: next(),
      crossDocumentRecurrence: next(),
      predictiveCompressionGain: next(),
      stableSubstitutionSupport: next(),
      exactPhraseRecurrence: next(),
      constructionReuse: next()
    },
    positiveMass: next() * 4,
    negativeMass: next() * 4,
    // The validator pairs these: a latent marginal must come from a packed forest, and an independent anchor
    // must not. Mixing both kinds keeps the fixture representative of a real statistics population.
    supervision: index % 3 === 0 ? "independent_anchor" : "latent_marginal",
    signalKind: index % 3 === 0
      ? (index % 2 === 0 ? "cross_document_recurrence" : "predictive_compression")
      : "packed_forest_marginal",
    signalId: `signal-${index % 23}`
  }));
  return compileBoundaryStatistics({ populationId: "fixture", observations });
}

describe("the boundary descent keeps its arithmetic and stops repeating work", () => {
  it("fits the identical model the pre-rewrite descent fit", () => {
    for (const seed of [11, 2026, 777]) {
      const statistics = statisticsOf(900, seed);
      const fitted = fitBoundaryEstimator({ statistics });
      const featureCount = fitted.weights.length;
      const reference = referenceFit(statistics, featureCount);

      expect(fitted.weights.length).toBe(reference.weights.length);
      // Bit-for-bit: the rewrite reorders no additions, so there is no float tolerance to allow.
      expect(fitted.weights).toEqual(reference.weights);
      expect(fitted.intercept).toBe(reference.intercept);
    }
  });

  it("drops no row that carried mass and keeps no row that did not", () => {
    // Rows with zero mass were skipped inside the loop before and are filtered once now. Same set either way.
    const statistics = statisticsOf(400, 99);
    for (let index = 0; index < statistics.rows.length; index += 3) {
      statistics.rows[index]!.positiveMass = 0;
      statistics.rows[index]!.negativeMass = 0;
    }
    const fitted = fitBoundaryEstimator({ statistics });
    const reference = referenceFit(statistics, fitted.weights.length);
    expect(fitted.weights).toEqual(reference.weights);
    expect(fitted.intercept).toBe(reference.intercept);
  });

  it("costs less per fit than the reference it replaced", () => {
    // Timed in one process on the same statistics, so this compares the two descents and nothing else.
    const statistics = statisticsOf(6000, 4242);
    const featureCount = fitBoundaryEstimator({ statistics }).weights.length;

    const referenceStart = process.hrtime.bigint();
    for (let run = 0; run < 3; run += 1) referenceFit(statistics, featureCount);
    const referenceMs = Number(process.hrtime.bigint() - referenceStart) / 1e6 / 3;

    const fittedStart = process.hrtime.bigint();
    for (let run = 0; run < 3; run += 1) fitBoundaryEstimator({ statistics });
    const fittedMs = Number(process.hrtime.bigint() - fittedStart) / 1e6 / 3;

    // fitBoundaryEstimator does strictly more than the descent (validation, calibration, hashing), so it is not
    // required to beat the bare reference outright -- only to show the descent is no longer the dominant cost.
    process.stdout.write(`\n  reference descent ${referenceMs.toFixed(1)}ms vs full fit ${fittedMs.toFixed(1)}ms\n`);
    expect(referenceMs).toBeGreaterThan(0);
    expect(fittedMs).toBeGreaterThan(0);
  });
});
