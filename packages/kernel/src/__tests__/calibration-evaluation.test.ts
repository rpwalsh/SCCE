import { describe, expect, it } from "vitest";
import {
  CALIBRATION_IDS,
  CALIBRATION_SUBSYSTEM_IDS,
  CALIBRATION_TASK_CLASS_IDS,
  calibrationObservationRecord,
  fitAndEvaluateCalibrationObservations,
  type CalibrationObservationRecord
} from "../index.js";

describe("source-disjoint calibration evaluation", () => {
  it("fits only on source-disjoint observations and evaluates the untouched holdout", () => {
    const observations = representativeFixture();
    const output = fitAndEvaluateCalibrationObservations({
      observations,
      datasetId: "fixture.source-disjoint.v1",
      seed: "fixture-seed",
      holdoutFraction: 0.25,
      minimumFitPoints: 4,
      minimumHoldoutPoints: 4,
      binCount: 4,
      createdAt: 1_000
    });

    expect(output.report.schema).toBe("scce.calibration.holdout_report.v1");
    expect(output.report.evaluatedModelCount).toBe(1);
    expect(output.report.insufficientModelCount).toBe(0);
    expect(output.report.claimBoundary).toBe("supplied_source_disjoint_holdout_only");
    const result = output.report.results[0]!;
    expect(result.status).toBe("evaluated");
    expect(result.split.fitObservationIds).not.toHaveLength(0);
    expect(result.split.holdoutObservationIds).not.toHaveLength(0);
    expect(intersection(result.split.fitSourceGroupIds, result.split.holdoutSourceGroupIds)).toEqual([]);
    expect(intersection(result.split.fitObservationIds, result.split.holdoutObservationIds)).toEqual([]);
    expect(result.rawMetrics?.sampleCount).toBe(result.split.holdoutObservationIds.length);
    expect(result.calibratedMetrics?.brier).toBeLessThanOrEqual(result.rawMetrics!.brier);
    expect(Object.keys(output.modelSet.models)).toEqual([
      `${CALIBRATION_IDS.proofSupport}|${CALIBRATION_TASK_CLASS_IDS.sourceBoundQa}`
    ]);
  });

  it("is independent of input order for a fixed dataset identity and seed", () => {
    const observations = representativeFixture();
    const input = {
      datasetId: "fixture.deterministic.v1",
      seed: "fixed-seed",
      minimumFitPoints: 4,
      minimumHoldoutPoints: 4,
      createdAt: 2_000
    } as const;
    const forward = fitAndEvaluateCalibrationObservations({ observations, ...input });
    const reverse = fitAndEvaluateCalibrationObservations({ observations: [...observations].reverse(), ...input });

    expect(reverse.report.inputHash).toBe(forward.report.inputHash);
    expect(reverse.report.id).toBe(forward.report.id);
    expect(reverse.report.results).toEqual(forward.report.results);
    expect(reverse.modelSet).toEqual(forward.modelSet);
  });

  it("refuses to describe a single source group as evaluated", () => {
    const observations = representativeFixture().map(observation => ({
      ...observation,
      sourceRecordId: "source.shared"
    }));
    const output = fitAndEvaluateCalibrationObservations({
      observations,
      datasetId: "fixture.leaky.v1",
      minimumFitPoints: 2,
      minimumHoldoutPoints: 2,
      createdAt: 3_000
    });

    expect(output.report.evaluatedModelCount).toBe(0);
    expect(output.report.results[0]?.status).toBe("insufficient_data");
    expect(output.report.results[0]?.reasons).toContain("fewer_than_two_source_groups");
    expect(output.modelSet.models).toEqual({});
  });

  it("rejects duplicate observation identities", () => {
    const observation = representativeFixture()[0]!;
    expect(() => fitAndEvaluateCalibrationObservations({
      observations: [observation, observation],
      datasetId: "fixture.duplicates.v1",
      createdAt: 4_000
    })).toThrow(/duplicate calibration observation id/u);
  });

  it("does not manufacture source disjointness from whitespace or Unicode variants", () => {
    const observations = representativeFixture().map((observation, index) => ({
      ...observation,
      sourceRecordId: index % 2 === 0 ? "source.\u00e9" : " source.e\u0301 "
    }));
    const output = fitAndEvaluateCalibrationObservations({
      observations,
      datasetId: "fixture.canonical-source.v1",
      minimumFitPoints: 2,
      minimumHoldoutPoints: 2,
      createdAt: 4_100
    });

    expect(output.report.sourceGroupCount).toBe(1);
    expect(output.report.evaluatedModelCount).toBe(0);
    expect(output.report.results[0]?.reasons).toContain("fewer_than_two_source_groups");
  });

  it("rejects observation identities that collide after canonicalization", () => {
    const [first, second] = representativeFixture();
    expect(() => fitAndEvaluateCalibrationObservations({
      observations: [
        { ...first!, id: "observation.\u00e9" },
        { ...second!, id: " observation.e\u0301 " }
      ],
      datasetId: "fixture.canonical-identity.v1",
      createdAt: 4_200
    })).toThrow(/duplicate calibration observation id after canonicalization/u);
  });

  it("requires an explicit source grouping key and a boolean outcome", () => {
    const observation = representativeFixture()[0]!;
    expect(() => fitAndEvaluateCalibrationObservations({
      observations: [{ ...observation, sourceRecordId: undefined }],
      datasetId: "fixture.missing-source.v1",
      createdAt: 5_000
    })).toThrow(/source-disjoint grouping key/u);
    expect(() => fitAndEvaluateCalibrationObservations({
      observations: [{ ...observation, outcome: 1 as unknown as boolean }],
      datasetId: "fixture.numeric-outcome.v1",
      createdAt: 5_000
    })).toThrow(/outcome must be boolean/u);
    expect(() => fitAndEvaluateCalibrationObservations({
      observations: [{ ...observation, taskClass: "task|ambiguous" }],
      datasetId: "fixture.ambiguous-key.v1",
      createdAt: 5_000
    })).toThrow(/cannot contain '\|'/u);
  });

  it("binds model identity to fitted values and outcomes", () => {
    const observations = representativeFixture();
    const common = {
      datasetId: "fixture.content-identity.v1",
      seed: "content-identity",
      minimumFitPoints: 4,
      minimumHoldoutPoints: 4,
      createdAt: 6_000
    } as const;
    const original = fitAndEvaluateCalibrationObservations({ observations, ...common });
    const changed = fitAndEvaluateCalibrationObservations({
      observations: observations.map((observation, index) => index === 0 ? { ...observation, outcome: !observation.outcome } : observation),
      ...common
    });

    expect(Object.values(changed.modelSet.models)[0]?.id).not.toBe(Object.values(original.modelSet.models)[0]?.id);
    expect(changed.modelSet.id).not.toBe(original.modelSet.id);
  });
});

function representativeFixture(): CalibrationObservationRecord[] {
  const observations: CalibrationObservationRecord[] = [];
  for (let group = 0; group < 12; group++) {
    for (const outcome of [false, true]) {
      observations.push(calibrationObservationRecord({
        calibrationId: CALIBRATION_IDS.proofSupport,
        subsystemId: CALIBRATION_SUBSYSTEM_IDS.proof,
        taskClass: CALIBRATION_TASK_CLASS_IDS.sourceBoundQa,
        rawScore: outcome ? 0.9 - group * 0.002 : 0.1 + group * 0.002,
        outcome,
        sourceRecordId: `source.${group}`,
        sourceTraceId: `trace.${group}`,
        finalOutcome: outcome ? "outcome.supported" : "outcome.unsupported",
        createdAt: group * 10 + (outcome ? 1 : 0),
        idSeed: `observation.${group}.${outcome}`
      }));
    }
  }
  return observations;
}

function intersection(left: readonly string[], right: readonly string[]): string[] {
  const rightSet = new Set(right);
  return left.filter(value => rightSet.has(value));
}
