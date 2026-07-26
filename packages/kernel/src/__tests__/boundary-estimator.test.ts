import { describe, expect, it } from "vitest";
import {
  compileBoundaryStatistics,
  createHasher,
  fitBoundaryEstimator,
  mergeBoundaryStatistics,
  scoreBoundary,
  type BoundaryFeatureVector
} from "../index.js";

const positive: BoundaryFeatureVector = {
  whitespaceAdjacent: 1,
  punctuationAdjacent: 1,
  lineBreakAdjacent: 0,
  scriptTransition: 0,
  structuralBoundary: 1,
  localTransitionEntropy: 0.8,
  repeatedContextSupport: 0.6
};

const negative: BoundaryFeatureVector = {
  whitespaceAdjacent: 0,
  punctuationAdjacent: 0,
  lineBreakAdjacent: 0,
  scriptTransition: 0,
  structuralBoundary: 0,
  localTransitionEntropy: 0.1,
  repeatedContextSupport: 0.8
};

describe("corpus-fitted boundary estimator", () => {
  const hasher = createHasher();

  it("merges exact sufficient statistics independently of shard order", () => {
    const first = compileBoundaryStatistics({
      populationId: "population.test",
      observations: [{ features: positive, positiveMass: 7, negativeMass: 1 }],
      sourceDocumentIds: ["doc.a"],
      hasher
    });
    const second = compileBoundaryStatistics({
      populationId: "population.test",
      observations: [{ features: negative, positiveMass: 1, negativeMass: 9 }],
      sourceDocumentIds: ["doc.b"],
      hasher
    });
    const left = mergeBoundaryStatistics([first, second], hasher);
    const right = mergeBoundaryStatistics([second, first], hasher);

    expect(left).toEqual(right);
    expect(fitBoundaryEstimator({ statistics: left, hasher }))
      .toEqual(fitBoundaryEstimator({ statistics: right, hasher }));
  });

  it("learns boundary preference from weighted corpus evidence instead of fixed coefficients", () => {
    const statistics = compileBoundaryStatistics({
      populationId: "population.test",
      observations: [
        { features: positive, positiveMass: 40, negativeMass: 1 },
        { features: negative, positiveMass: 1, negativeMass: 40 }
      ],
      hasher
    });
    const model = fitBoundaryEstimator({ statistics, hasher, iterations: 160 });

    expect(scoreBoundary(model, positive)).toBeGreaterThan(0.75);
    expect(scoreBoundary(model, negative)).toBeLessThan(0.25);
    expect(model.trainingStatisticsId).toBe(statistics.id);
    expect(model.calibration.logLoss).toBeLessThan(0.4);
  });
});
