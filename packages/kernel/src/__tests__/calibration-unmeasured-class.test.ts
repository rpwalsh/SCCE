// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
import { describe, expect, it } from "vitest";
import {
  CALIBRATION_IDS,
  CALIBRATION_SUBSYSTEM_IDS,
  CALIBRATION_TASK_CLASS_IDS,
  buildCalibrationModelSet,
  calibrateRuntimeScore,
  type CalibrationObservationRecord
} from "../calibration-spine.js";
import { createClock, createHasher, createIdFactory, createSemanticEntailmentEngine } from "../index.js";
import type { FieldState } from "../types.js";

/**
 * The two live rolling windows for `proof.support` measured from
 * `scce3_runtime.calibration_observations` on 2026-09-16: the requested class
 * `task.source_bound_qa` has zero rows in both, and the sibling class the window
 * does carry grew by one row between the correct turn (14:58 PDT) and the wrong
 * one (17:17 PDT). Raw scores are the live values.
 */
const SIBLING_RAW_SCORES_AT_CORRECT_TURN = [
  0, 0.030674753462205866, 0.2737027339837594, 0.28565300390656334,
  0.37923730255470633, 0.45, 0.55, 0.75, 1
] as const;
const LIVE_POSITIVE_RAW = 0.75;
/** The one row that arrived between the two turns. It is the correct turn's own calibrated output, logged back. */
const ROW_THAT_ARRIVED_BETWEEN_TURNS = 0.6499999999999999;
/** `proof.support` raw support for "When was Ada Lovelace born?", byte-identical in both traces' proof stages. */
const ADA_RAW_SUPPORT = 0.66;

function observations(rawScores: readonly number[], taskClass: string): CalibrationObservationRecord[] {
  return rawScores.map((rawScore, index) => ({
    schema: "scce.calibration.observation.v1",
    id: `calibration.observation.${taskClass}.${index}`,
    calibrationId: CALIBRATION_IDS.proofSupport,
    subsystemId: CALIBRATION_SUBSYSTEM_IDS.proof,
    taskClass,
    rawScore,
    outcome: rawScore === LIVE_POSITIVE_RAW,
    finalOutcome: rawScore === LIVE_POSITIVE_RAW ? "outcome.positive" : "outcome.unknown",
    metadata: null,
    createdAt: 1_000 + index
  }));
}

function supportFor(rawScores: readonly number[]) {
  const modelSet = buildCalibrationModelSet({
    observations: observations(rawScores, CALIBRATION_TASK_CLASS_IDS.dialogueOutcome),
    createdAt: 2_000
  });
  return calibrateRuntimeScore({
    raw: ADA_RAW_SUPPORT,
    calibrationId: CALIBRATION_IDS.proofSupport,
    taskClass: CALIBRATION_TASK_CLASS_IDS.sourceBoundQa,
    modelSet
  });
}

function emptyField(): FieldState {
  const matrix = { nodes: [], values: [] };
  return {
    requestFeatures: [],
    seeds: [],
    active: [],
    ppf: [],
    causalMass: [],
    alphaTrace: {
      alpha: 0.7,
      thresholds: { virtual: 0.49, visible: 0.7, bonded: 0.8366600265340756, structural: 0.51 },
      relations: [],
      adjacency: matrix,
      laplacian: matrix,
      normalizedLaplacian: matrix,
      surfaces: { pressure: 0, drift: 0, contradiction: 0, bond: 0, risk: 0, actionability: 0 },
      contradictionMass: 0,
      bondedLeakage: 0
    }
  };
}

function entailmentSupportFor(rawScores: readonly number[]) {
  const hasher = createHasher();
  const clock = createClock({ fixedTime: 2000, stepMs: 1 });
  const engine = createSemanticEntailmentEngine({ idFactory: createIdFactory({ clock, hasher, deterministicReplay: true }), hasher });
  return engine.check({
    text: "When was Ada Lovelace born?",
    evidence: [],
    nodes: [],
    field: emptyField(),
    createdAt: clock.now(),
    calibrationModels: buildCalibrationModelSet({
      observations: observations(rawScores, CALIBRATION_TASK_CLASS_IDS.dialogueOutcome),
      createdAt: 2_000
    })
  });
}

describe("a calibration class with no observations must not be reported as a measurement", () => {
  it("does not let a sibling task class's population decide the requested class's score", () => {
    const atCorrectTurn = supportFor(SIBLING_RAW_SCORES_AT_CORRECT_TURN);
    const atWrongTurn = supportFor([...SIBLING_RAW_SCORES_AT_CORRECT_TURN, ROW_THAT_ARRIVED_BETWEEN_TURNS]);

    // The requested class had zero observations in both windows, so no sibling row can have measured it.
    expect(atWrongTurn.value).toBe(atCorrectTurn.value);
  });

  it("reports an unmeasured task class as unmeasured rather than calibrated", () => {
    const measured = supportFor([...SIBLING_RAW_SCORES_AT_CORRECT_TURN, ROW_THAT_ARRIVED_BETWEEN_TURNS]);
    expect(measured.calibrated).toBe(false);
    expect(measured.measurement).toBe("unmeasured_task_class");
    expect(measured.value).toBe(measured.raw);
    // The borrowed model survives as provenance, never as a value.
    expect(measured.unappliedModelId).toBeDefined();
    expect(measured.modelId).toBeUndefined();
  });

  it("keeps a genuinely measured class calibrated", () => {
    const modelSet = buildCalibrationModelSet({
      observations: observations([...SIBLING_RAW_SCORES_AT_CORRECT_TURN, ROW_THAT_ARRIVED_BETWEEN_TURNS], CALIBRATION_TASK_CLASS_IDS.sourceBoundQa),
      createdAt: 2_000
    });
    const measured = calibrateRuntimeScore({
      raw: ROW_THAT_ARRIVED_BETWEEN_TURNS,
      calibrationId: CALIBRATION_IDS.proofSupport,
      taskClass: CALIBRATION_TASK_CLASS_IDS.sourceBoundQa,
      modelSet
    });
    expect(measured.calibrated).toBe(true);
    expect(measured.measurement).toBe("measured");
    expect(measured.sampleCount).toBeGreaterThan(0);
    expect(measured.value).toBe(0);
  });

  it("distinguishes a score region with no training sample from one measured at zero", () => {
    const modelSet = buildCalibrationModelSet({
      observations: observations(SIBLING_RAW_SCORES_AT_CORRECT_TURN, CALIBRATION_TASK_CLASS_IDS.sourceBoundQa),
      createdAt: 2_000
    });
    // 0.66 lands in a bin the live window had no row in; 0.55 lands in one it measured, at zero.
    const unmeasuredRegion = calibrateRuntimeScore({
      raw: ADA_RAW_SUPPORT,
      calibrationId: CALIBRATION_IDS.proofSupport,
      taskClass: CALIBRATION_TASK_CLASS_IDS.sourceBoundQa,
      modelSet
    });
    const measuredZero = calibrateRuntimeScore({
      raw: 0.55,
      calibrationId: CALIBRATION_IDS.proofSupport,
      taskClass: CALIBRATION_TASK_CLASS_IDS.sourceBoundQa,
      modelSet
    });
    expect(measuredZero.calibrated).toBe(true);
    expect(measuredZero.measurement).toBe("measured");
    expect(measuredZero.value).toBe(0);
    expect(unmeasuredRegion.calibrated).toBe(false);
    expect(unmeasuredRegion.measurement).toBe("unmeasured_score_region");
    expect(unmeasuredRegion.sampleCount).toBe(0);
    expect(unmeasuredRegion.value).toBe(unmeasuredRegion.raw);
  });

  it("carries the unmeasured state to the entailment consumer instead of a number", () => {
    const atCorrectTurn = entailmentSupportFor(SIBLING_RAW_SCORES_AT_CORRECT_TURN);
    const atWrongTurn = entailmentSupportFor([...SIBLING_RAW_SCORES_AT_CORRECT_TURN, ROW_THAT_ARRIVED_BETWEEN_TURNS]);

    expect(atCorrectTurn.supportMeasurement).toBe("unmeasured_task_class");
    expect(atWrongTurn.supportMeasurement).toBe("unmeasured_task_class");
    // Unmeasured means the proof's own quantity is what the turn carries, and the window cannot move it.
    expect(atWrongTurn.support).toBe(atWrongTurn.rawSupport);
    expect(atWrongTurn.support).toBe(atCorrectTurn.support);
  });
});
