import { describe, expect, it } from "vitest";
import { fitFtrlCalibration } from "../sparse-ranking-calibration.js";
import { createFtrlProximalRanker, createSparseVector, createTypedSparseFeatureId } from "../sparse-ranking.js";
import type { SparseRankingComparisonExample, InformationLabel } from "../index.js";

describe("fitFtrlCalibration and calibrated score() (plan item 33)", () => {
  const featureX = createTypedSparseFeatureId({ familyId: "test", value: "x" });
  const good = createSparseVector([{ id: featureX, value: 1 }]);
  const bad = createSparseVector([{ id: featureX, value: -1 }]);

  function example(index: number): SparseRankingComparisonExample {
    return {
      id: `example:${index}`,
      taskClass: "test.task.v1",
      featureSchemaId: "test.schema.v1",
      recordedAt: index,
      candidates: [good, bad],
      preferredIndex: 0,
      weight: 1,
      source: "proof_certification",
      informationLabel: fixtureInformationLabel()
    };
  }

  it("returns undefined with too few examples or a single-class label set", () => {
    const ranker = createFtrlProximalRanker({ modelId: "model:test", featureSchemaId: "test.schema.v1" });
    expect(fitFtrlCalibration({ ranker, examples: [example(0)], calibrationId: "cal:1" })).toBeUndefined();

    const singleClass: SparseRankingComparisonExample[] = Array.from({ length: 20 }, (_, index) => ({
      id: `single:${index}`,
      taskClass: "test.task.v1",
      featureSchemaId: "test.schema.v1",
      recordedAt: index,
      candidates: [good],
      preferredIndex: 0,
      weight: 1,
      source: "proof_certification",
      informationLabel: fixtureInformationLabel()
    }));
    expect(fitFtrlCalibration({ ranker, examples: singleClass, calibrationId: "cal:2" })).toBeUndefined();
  });

  it("fits a real calibration and score() applies it, replacing the uncalibrated marker", () => {
    const trainedRanker = createFtrlProximalRanker({ modelId: "model:test", featureSchemaId: "test.schema.v1" });
    const examples = Array.from({ length: 20 }, (_, index) => example(index));
    for (const ex of examples) trainedRanker.updatePair({ preferred: good, rejected: bad, weight: 1 });

    const uncalibratedScore = trainedRanker.score(good);
    expect(uncalibratedScore.reliability).toBe("uncalibrated");
    expect(uncalibratedScore.calibrationId).toBeUndefined();

    const calibration = fitFtrlCalibration({ ranker: trainedRanker, examples, calibrationId: "cal:real" });
    expect(calibration).toBeDefined();
    expect(calibration!.method).toBe("platt");
    // The trained ranker already separates good (label 1) from bad
    // (label 0) with a large positive raw-score gap, so Platt scaling
    // must learn a positive slope to preserve that ordering.
    expect(calibration!.slope).toBeGreaterThan(0);

    const calibratedRanker = createFtrlProximalRanker({
      modelId: "model:test",
      featureSchemaId: "test.schema.v1",
      state: trainedRanker.snapshot(),
      calibration: calibration!
    });
    const calibratedScore = calibratedRanker.score(good);
    expect(calibratedScore.reliability).toBe("calibrated");
    expect(calibratedScore.calibrationId).toBe("cal:real");
    expect(calibratedScore.rawScore).toBeCloseTo(uncalibratedScore.rawScore);
    // Calibrated probability for the clearly-preferred candidate should
    // be high confidence, not just barely above 0.5.
    expect(calibratedScore.probability).toBeGreaterThan(0.8);
  });
});

function fixtureInformationLabel(): InformationLabel {
  return {
    exportClass: "public",
    tenantId: "fixture-tenant",
    principals: [],
    compartments: [],
    mergePolicy: "isolated"
  } as InformationLabel;
}
