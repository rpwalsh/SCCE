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
  repeatedContextSupport: 0.6,
  crossDocumentRecurrence: 0.8,
  predictiveCompressionGain: 0.7,
  stableSubstitutionSupport: 0.4,
  exactPhraseRecurrence: 0.8,
  constructionReuse: 0.5
};

const negative: BoundaryFeatureVector = {
  whitespaceAdjacent: 0,
  punctuationAdjacent: 0,
  lineBreakAdjacent: 0,
  scriptTransition: 0,
  structuralBoundary: 0,
  localTransitionEntropy: 0.1,
  repeatedContextSupport: 0.8,
  crossDocumentRecurrence: 0,
  predictiveCompressionGain: 0,
  stableSubstitutionSupport: 0,
  exactPhraseRecurrence: 0,
  constructionReuse: 0
};

describe("corpus-fitted boundary estimator", () => {
  const hasher = createHasher();

  it("merges exact sufficient statistics independently of shard order", () => {
    const first = compileBoundaryStatistics({
      populationId: "population.test",
      observations: [anchored("doc.a", positive, 7, 1, "a")],
      sourceDocumentIds: ["doc.a"],
      hasher
    });
    const second = compileBoundaryStatistics({
      populationId: "population.test",
      observations: [anchored("doc.b", negative, 1, 9, "b")],
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
        anchored("doc.train", positive, 40, 1, "positive"),
        anchored("doc.train", negative, 1, 40, "negative")
      ],
      sourceDocumentIds: ["doc.train"],
      hasher
    });
    const calibrationStatistics = compileBoundaryStatistics({
      populationId: "population.test",
      observations: [
        anchored("doc.holdout", positive, 20, 1, "positive"),
        anchored("doc.holdout", negative, 1, 20, "negative")
      ],
      sourceDocumentIds: ["doc.holdout"],
      hasher
    });
    const model = fitBoundaryEstimator({
      statistics,
      calibrationStatistics,
      calibrationShards: [calibrationStatistics],
      hasher,
      iterations: 160
    });

    expect(scoreBoundary(model, positive)).toBeGreaterThan(0.75);
    expect(scoreBoundary(model, negative)).toBeLessThan(0.25);
    expect(model.trainingStatisticsId).toBe(statistics.id);
    expect(model.calibration.method).toBe("platt_heldout");
    expect(model.calibration.logLoss).not.toBeNull();
    expect(model.calibration.logLoss!).toBeLessThan(0.4);
    expect(model.calibration.brier!).toBeLessThan(0.2);
    expect(model.calibration.expectedCalibrationError!).toBeLessThan(0.25);
  });

  it("rejects detector decisions as supervision and overlapping calibration sources", () => {
    expect(() => compileBoundaryStatistics({
      populationId: "population.test",
      observations: [{
        ...anchored("doc.a", positive, 1, 0, "bad"),
        signalId: "candidate_detector.endpoint"
      }],
      hasher
    })).toThrow(/cannot supervise/);
    const statistics = compileBoundaryStatistics({
      populationId: "population.test",
      observations: [anchored("doc.a", positive, 1, 0, "train")],
      sourceDocumentIds: ["doc.a"],
      hasher
    });
    expect(() => fitBoundaryEstimator({
      statistics,
      calibrationStatistics: statistics,
      hasher
    })).toThrow(/overlap/);
  });
});

function anchored(
  sourceDocumentId: string,
  features: BoundaryFeatureVector,
  positiveMass: number,
  negativeMass: number,
  signalId: string
) {
  return {
    sourceDocumentId,
    features,
    positiveMass,
    negativeMass,
    supervision: "independent_anchor" as const,
    signalKind: "external_anchor" as const,
    signalId
  };
}
