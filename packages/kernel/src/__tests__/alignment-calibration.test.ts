import { describe, expect, it } from "vitest";
import {
  calibratedAlignmentProbability,
  compileAlignmentCalibrationModel,
  type AlignmentCalibrationObservation
} from "../index.js";

describe("held-out alignment calibration", () => {
  it("fits only on source-family-disjoint labels and reports untouched metrics", () => {
    const observations = [
      ...rows("fit", "family.fit", 40),
      ...rows("holdout", "family.holdout", 40)
    ];
    const model = compileAlignmentCalibrationModel({
      observations,
      minimumFitCount: 32,
      minimumHoldoutCount: 32,
      binCount: 8
    });
    const good = calibratedAlignmentProbability({
      model,
      features: features(0.9)
    });
    const bad = calibratedAlignmentProbability({
      model,
      features: features(0.1)
    });

    expect(model.status).toBe("calibrated");
    expect(model.fitSourceFamilyIds).toEqual(["family.fit"]);
    expect(model.holdoutSourceFamilyIds).toEqual(["family.holdout"]);
    expect(model.holdoutMetrics).toMatchObject({
      count: 40,
      binCount: 8
    });
    expect(model.holdoutMetrics!.logLoss).toBeGreaterThanOrEqual(0);
    expect(model.holdoutMetrics!.brierScore).toBeGreaterThanOrEqual(0);
    expect(model.holdoutMetrics!.expectedCalibrationError)
      .toBeGreaterThanOrEqual(0);
    expect(good).not.toBeNull();
    expect(bad).not.toBeNull();
    expect(good!).toBeGreaterThan(bad!);
  });

  it("rejects family leakage and refuses confidence without labels", () => {
    const overlap = [
      ...rows("fit", "family.same", 8),
      ...rows("holdout", "family.same", 8)
    ];
    expect(() => compileAlignmentCalibrationModel({
      observations: overlap,
      minimumFitCount: 8,
      minimumHoldoutCount: 8
    })).toThrow(/cross partitions/);

    const missing = compileAlignmentCalibrationModel({ observations: [] });
    expect(missing.status).toBe("insufficient_data");
    expect(missing.holdoutMetrics).toBeNull();
    expect(calibratedAlignmentProbability({
      model: missing,
      features: features(0.9)
    })).toBeNull();
  });
});

function rows(
  partition: AlignmentCalibrationObservation["partition"],
  sourceFamilyId: string,
  count: number
): AlignmentCalibrationObservation[] {
  return Array.from({ length: count }, (_, index) => {
    const positive = index % 2 === 0;
    return {
      id: `${partition}.${index}`,
      sourceFamilyId,
      partition,
      outcome: positive,
      features: features(positive ? 0.9 : 0.1)
    };
  });
}

function features(quality: number) {
  return {
    objective: 1 - quality,
    feature: 1 - quality,
    structural: 1 - quality,
    ordering: 1 - quality,
    crossDocument: 1 - quality,
    anchorIndependence: quality * 2,
    cycleRecall: quality,
    unsupportedAdditionRate: 1 - quality,
    marginalResidual: 1 - quality
  };
}
