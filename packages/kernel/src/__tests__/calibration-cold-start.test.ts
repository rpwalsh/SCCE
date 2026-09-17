// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
import { describe, expect, it } from "vitest";
import {
  CALIBRATION_IDS,
  CALIBRATION_SUBSYSTEM_IDS,
  CALIBRATION_TASK_CLASS_IDS,
  buildCalibrationModelSet,
  calibrateRuntimeScore,
  calibrationModelMatchFor,
  calibrationObservationRecord,
  creativePreferenceModelFor,
  creditRewardClasses,
  judgeRequirementModelFor,
  operatorRoutingModelFor,
  type CalibrationObservationRecord
} from "../calibration-spine.js";
import { PUBLIC_CALIBRATIONS, type CalibrationKey } from "../calibrations/public-calibrations.js";
import { calibrated, prodCalibrationIds } from "../calibrations/prod-calibrations.js";
import {
  buildCognitiveCreditRecord,
  cognitiveCreditStageObservations,
  CREDIT_STAGE_CALIBRATION,
  CREDIT_STAGE_IDS
} from "../cognitive-credit.js";
import { createClock, createHasher, createIdFactory, createSemanticEntailmentEngine } from "../index.js";
import type { FieldState, JsonValue, SemanticEntailmentResult } from "../types.js";

const SPINE_IDS = Object.values(CALIBRATION_IDS);
const TASK_CLASSES = Object.values(CALIBRATION_TASK_CLASS_IDS);
/** Probe points, one per decile boundary plus both endpoints, so every bin of a 10-bin model is asked. */
const PROBE_RAW = [0, 0.05, 0.15, 0.25, 0.35, 0.45, 0.55, 0.65, 0.75, 0.85, 0.95, 1];

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

function checkEntailment(observations: readonly CalibrationObservationRecord[]): SemanticEntailmentResult {
  const hasher = createHasher();
  const clock = createClock({ fixedTime: 2000, stepMs: 1 });
  const engine = createSemanticEntailmentEngine({ idFactory: createIdFactory({ clock, hasher, deterministicReplay: true }), hasher });
  return engine.check({
    text: "When was Ada Lovelace born?",
    evidence: [],
    nodes: [],
    field: emptyField(),
    createdAt: clock.now(),
    calibrationModels: buildCalibrationModelSet({ observations, createdAt: 2_000 })
  });
}

/** The credit view a turn hands the ledger, carrying only this entailment. Enough to reach the proof stage. */
function creditStageRows(result: SemanticEntailmentResult, episodeId: string): readonly CalibrationObservationRecord[] {
  return cognitiveCreditStageObservations(buildCognitiveCreditRecord({
    episodeId,
    conversationId: "conversation.cold-start",
    // The class entailment.ts itself calibrates against, which is what production passes to both.
    taskClass: CALIBRATION_TASK_CLASS_IDS.sourceBoundQa,
    answer: "Ada Lovelace was born on 10 December 1815.",
    entailment: result as unknown as JsonValue,
    createdAt: 3_000
  }));
}

function proofStageRawScore(result: SemanticEntailmentResult, episodeId: string): number {
  const id = CREDIT_STAGE_CALIBRATION[CREDIT_STAGE_IDS.proof].calibrationId;
  const row = creditStageRows(result, episodeId).find(item => item.calibrationId === id);
  expect(row).toBeDefined();
  return row!.rawScore;
}

describe("T1: on an empty observation table every calibration id is honestly uncalibrated", () => {
  const modelSet = buildCalibrationModelSet({ observations: [], createdAt: 1_000 });

  it("builds no model of any kind from zero observations", () => {
    expect(Object.keys(modelSet.models)).toEqual([]);
    expect(Object.keys(modelSet.creativePreferenceModels ?? {})).toEqual([]);
    expect(Object.keys(modelSet.judgeRequirementModels ?? {})).toEqual([]);
    expect(Object.keys(modelSet.operatorRoutingModels ?? {})).toEqual([]);
    expect(modelSet.observationCount).toBe(0);
  });

  it("resolves every spine id in every task class at every score region to unmeasured_no_model", () => {
    const dishonest: string[] = [];
    let probed = 0;
    for (const calibrationId of SPINE_IDS) {
      for (const taskClass of TASK_CLASSES) {
        expect(calibrationModelMatchFor({ modelSet, calibrationId, taskClass })).toBeUndefined();
        for (const raw of PROBE_RAW) {
          probed++;
          const resolved = calibrateRuntimeScore({ raw, calibrationId, taskClass, modelSet });
          if (resolved.calibrated !== false) dishonest.push(`${calibrationId}|${taskClass}|${raw}:calibrated`);
          if (resolved.measurement !== "unmeasured_no_model") dishonest.push(`${calibrationId}|${taskClass}|${raw}:${resolved.measurement}`);
          if (resolved.value !== raw) dishonest.push(`${calibrationId}|${taskClass}|${raw}:value=${resolved.value}`);
          if (resolved.modelId !== undefined) dishonest.push(`${calibrationId}|${taskClass}|${raw}:borrowed=${resolved.modelId}`);
          if (resolved.unappliedModelId !== undefined) dishonest.push(`${calibrationId}|${taskClass}|${raw}:unapplied=${resolved.unappliedModelId}`);
        }
      }
    }
    expect(dishonest).toEqual([]);
    // Every declared spine id, in every declared class, at every bin: the whole cross product, not a sample.
    expect(probed).toBe(SPINE_IDS.length * TASK_CLASSES.length * PROBE_RAW.length);
    expect(new Set(SPINE_IDS).size).toBe(SPINE_IDS.length);
    expect(SPINE_IDS.length).toBeGreaterThanOrEqual(25);
  });

  it("returns no structured model for any task class", () => {
    for (const taskClass of TASK_CLASSES) {
      expect(judgeRequirementModelFor({ modelSet, taskClass })).toBeUndefined();
      expect(operatorRoutingModelFor({ modelSet, taskClass })).toBeUndefined();
      expect(creativePreferenceModelFor({ modelSet, taskClass })).toBeUndefined();
    }
  });

  it("resolves every declared public id to its own bootstrap, with no profile installed", () => {
    expect(prodCalibrationIds()).toEqual([]);
    const keys = Object.keys(PUBLIC_CALIBRATIONS) as CalibrationKey[];
    const drifted = keys.filter(key => calibrated(key) !== PUBLIC_CALIBRATIONS[key]);
    expect(drifted).toEqual([]);
    expect(keys.length).toBeGreaterThan(0);
  });
});

describe("T2: the credit ledger must not observe a value a calibration produced", () => {
  it("records the proof's own quantity on the first turn, when nothing is measured", () => {
    const first = checkEntailment([]);
    expect(first.supportMeasurement).toBe("unmeasured_no_model");
    expect(first.support).toBe(first.rawSupport);
    expect(proofStageRawScore(first, "episode.cold.1")).toBe(first.rawSupport);
  });

  it("still records the proof's own quantity once that id's bin is measured", () => {
    // Two rows in this id/class, in the bin the turn's own raw support lands in, one per outcome class:
    // the least the binned fitter will model, which is all it takes to make the bin measured.
    const coldSupport = checkEntailment([]).rawSupport ?? 0;
    const seed: CalibrationObservationRecord[] = [true, false].map((outcome, index) => calibrationObservationRecord({
      calibrationId: CALIBRATION_IDS.proofSupport,
      subsystemId: CALIBRATION_SUBSYSTEM_IDS.proof,
      taskClass: CALIBRATION_TASK_CLASS_IDS.sourceBoundQa,
      rawScore: coldSupport,
      outcome,
      idSeed: `cold-start-seed-${index}`,
      createdAt: 1_000 + index
    }));
    const second = checkEntailment(seed);
    // The bin is genuinely measured, so the turn's carried support legitimately moves.
    expect(second.supportMeasurement).toBe("measured");
    expect(second.support).not.toBe(second.rawSupport);
    // The ledger row is evidence about the world, so it must be the pre-calibration quantity, unchanged.
    expect(proofStageRawScore(second, "episode.cold.2")).toBe(second.rawSupport);
    expect(proofStageRawScore(second, "episode.cold.2")).toBe(proofStageRawScore(checkEntailment([]), "episode.cold.2"));
  });

  it("records retrieval's pre-calibration blend, never the score retrieval.hybrid_recall returned", () => {
    const id = CREDIT_STAGE_CALIBRATION[CREDIT_STAGE_IDS.retrieval].calibrationId;
    // One role trace whose calibrated score and pre-calibration blend differ, as a measured bin makes them.
    const roles = [{
      evidenceId: "evidence.1",
      role: "direct_answer",
      score: 0.5,
      rawScore: 0.0288,
      scoreMeasurement: "measured",
      scoreTraces: [],
      reason: "seeded"
    }];
    const rows = cognitiveCreditStageObservations(buildCognitiveCreditRecord({
      episodeId: "episode.retrieval.1",
      conversationId: "conversation.cold-start",
      taskClass: CALIBRATION_TASK_CLASS_IDS.sourceBoundQa,
      answer: "Ada Lovelace was born on 10 December 1815.",
      retrievalRoles: roles as unknown as JsonValue,
      evidenceIds: ["evidence.1"],
      createdAt: 3_000
    }));
    expect(rows.find(item => item.calibrationId === id)?.rawScore).toBe(0.0288);
  });
});

describe("T1: an unclassified credit row is not a measured failure", () => {
  /** A turn the runtime can only label `outcome.unknown`, whose measured reward is high. */
  function creditView(episodeId: string): Parameters<typeof buildCognitiveCreditRecord>[0] {
    return {
      episodeId,
      conversationId: "conversation.cold-start",
      taskClass: CALIBRATION_TASK_CLASS_IDS.sourceBoundQa,
      answer: "Ada Lovelace was born on 10 December 1815.",
      entailment: {
        claim: { id: `claim.${episodeId}` },
        proof: { id: `proof.${episodeId}` },
        support: 0.66,
        rawSupport: 0.66,
        contradiction: 0.02,
        rawContradiction: 0.02,
        faithfulnessLcb: 0.61,
        scores: { support: 0 },
        obligations: [{ status: "satisfied" }, { status: "satisfied" }, { status: "underdetermined" }]
      } as unknown as JsonValue,
      evidenceIds: ["evidence.1"],
      createdAt: 5_000
    };
  }

  it("does not fit a calibrated zero from turns whose outcome class was never decided", () => {
    const records = ["episode.label.1", "episode.label.2"].map(id => buildCognitiveCreditRecord(creditView(id)));
    for (const record of records) {
      // The runtime measures a quality and declines to class it; the boolean every fit reads is therefore false.
      expect(record.outcome.label).toBe("outcome.unknown");
      expect(record.outcome.reward).toBeGreaterThan(0.5);
    }
    const rows = records.flatMap(record => cognitiveCreditStageObservations(record));
    expect(rows.filter(row => row.outcome)).toEqual([]);

    const modelSet = buildCalibrationModelSet({ observations: rows, createdAt: 9_000 });
    const dishonest: string[] = [];
    for (const calibrationId of SPINE_IDS) {
      const resolved = calibrateRuntimeScore({
        raw: 0.66,
        calibrationId,
        taskClass: CALIBRATION_TASK_CLASS_IDS.sourceBoundQa,
        modelSet
      });
      // Two unclassified turns have measured no outcome, so no id may report a measured value from them.
      if (resolved.calibrated) dishonest.push(`${calibrationId}:measured=${resolved.value}`);
      if (resolved.value !== 0.66) dishonest.push(`${calibrationId}:value=${resolved.value}`);
    }
    expect(dishonest).toEqual([]);
    expect(Object.keys(modelSet.models)).toEqual([]);
  });

  it("still fits a row whose outcome a writer outside the credit ledger measured", () => {
    const seed: CalibrationObservationRecord[] = [true, false].map((outcome, index) => calibrationObservationRecord({
      calibrationId: CALIBRATION_IDS.translationPreservation,
      subsystemId: CALIBRATION_SUBSYSTEM_IDS.translation,
      taskClass: CALIBRATION_TASK_CLASS_IDS.translation,
      rawScore: 0.66,
      outcome,
      idSeed: `translation-seed-${index}`,
      createdAt: 1_000 + index
    }));
    const resolved = calibrateRuntimeScore({
      raw: 0.66,
      calibrationId: CALIBRATION_IDS.translationPreservation,
      taskClass: CALIBRATION_TASK_CLASS_IDS.translation,
      modelSet: buildCalibrationModelSet({ observations: seed, createdAt: 9_000 })
    });
    expect(resolved.measurement).toBe("measured");
    expect(resolved.value).toBe(0.5);
  });
});

describe("T33: the model set that decided a turn must be identifiable", () => {
  /** Same id, same class, same timestamps, different measured frequencies. */
  function window(outcomes: readonly boolean[]) {
    return buildCalibrationModelSet({
      observations: outcomes.map((outcome, index) => calibrationObservationRecord({
        calibrationId: CALIBRATION_IDS.proofSupport,
        subsystemId: CALIBRATION_SUBSYSTEM_IDS.proof,
        taskClass: CALIBRATION_TASK_CLASS_IDS.sourceBoundQa,
        rawScore: 0.15,
        outcome,
        idSeed: `window-${index}-${outcome}`,
        createdAt: 1_000 + index
      }))
    });
  }

  it("gives two windows that calibrate the same score differently two different ids", () => {
    const split = window([true, false]);
    const agreed = window([true, true]);
    const probe = (modelSet: ReturnType<typeof buildCalibrationModelSet>) => calibrateRuntimeScore({
      raw: 0.15,
      calibrationId: CALIBRATION_IDS.proofSupport,
      taskClass: CALIBRATION_TASK_CLASS_IDS.sourceBoundQa,
      modelSet
    }).value;
    // The two windows decide the same raw score differently, so they are not the same model set.
    expect(probe(split)).not.toBe(probe(agreed));
    expect(split.createdAt).toBe(agreed.createdAt);
    expect(Object.keys(split.models)).toEqual(Object.keys(agreed.models));
    expect(split.id).not.toBe(agreed.id);
  });
});

describe("T1: a credit row written before the reward existed is also unclassified", () => {
  /** The shape 598 of the 1079 live credit rows carry: the credit schema, no reward, boolean false. */
  function rewardlessCreditRow(index: number): CalibrationObservationRecord {
    return calibrationObservationRecord({
      calibrationId: CALIBRATION_IDS.proofSupport,
      subsystemId: CALIBRATION_SUBSYSTEM_IDS.proof,
      taskClass: CALIBRATION_TASK_CLASS_IDS.sourceBoundQa,
      rawScore: 0.66,
      outcome: false,
      finalOutcome: "outcome.unknown",
      idSeed: `rewardless-${index}`,
      createdAt: 1_000 + index,
      metadata: {
        schema: "scce.cognitive_credit.stage_observation.v1",
        episodeId: `episode.rewardless.${index}`,
        stageId: "stage.proof",
        reached: true
      }
    });
  }

  it("does not read a pre-reward credit row as a measured failure", () => {
    const modelSet = buildCalibrationModelSet({
      observations: [0, 1, 2, 3].map(rewardlessCreditRow),
      createdAt: 9_000
    });
    const resolved = calibrateRuntimeScore({
      raw: 0.66,
      calibrationId: CALIBRATION_IDS.proofSupport,
      taskClass: CALIBRATION_TASK_CLASS_IDS.sourceBoundQa,
      modelSet
    });
    expect(resolved.measurement).toBe("unmeasured_no_model");
    expect(resolved.value).toBe(0.66);
    expect(Object.keys(modelSet.models)).toEqual([]);
  });
});

describe("T3: a turn-level reward never labels a per-quantity calibration", () => {
  function creditRows(rewards: readonly number[]): CalibrationObservationRecord[] {
    return rewards.map((reward, index) => calibrationObservationRecord({
      calibrationId: CALIBRATION_IDS.proofSupport,
      subsystemId: CALIBRATION_SUBSYSTEM_IDS.proof,
      taskClass: CALIBRATION_TASK_CLASS_IDS.sourceBoundQa,
      rawScore: 0.66,
      outcome: false,
      finalOutcome: "outcome.unknown",
      idSeed: `criterion-${index}-${reward}`,
      createdAt: 1_000 + index,
      metadata: {
        schema: "scce.cognitive_credit.stage_observation.v1",
        episodeId: `episode.criterion.${index}`,
        stageId: "stage.proof",
        reached: true,
        reward
      }
    }));
  }

  function resolve(rewards: readonly number[]) {
    return calibrateRuntimeScore({
      raw: 0.66,
      calibrationId: CALIBRATION_IDS.proofSupport,
      taskClass: CALIBRATION_TASK_CLASS_IDS.sourceBoundQa,
      modelSet: buildCalibrationModelSet({ observations: creditRows(rewards), createdAt: 9_000 })
    });
  }

  it("stays unmeasured at every episode count, however well the rewards separate", () => {
    // Whether the turn went well is a property of the turn, not of the support figure proof.support scores.
    // All 83 live proof.support rows are credit rows, so its only available label is that turn-level reward.
    const populations = [
      [0.9],
      [0.9, 0.1],
      [0.9, 0.5, 0.1],
      [0.5, 0.5, 0.5, 0.5],
      [0.9, 0.8, 0.2, 0.1],
      [1, 0.95, 0.9, 0.85, 0.15, 0.1, 0.05, 0]
    ];
    for (const rewards of populations) {
      const resolved = resolve(rewards);
      expect(resolved.measurement).toBe("unmeasured_no_model");
      expect(resolved.value).toBe(0.66);
    }
  });

  it("leaves the turn-level reward available to the turn-level fit", () => {
    // The routing fit consumes exactly this population and derives its own class from it; that is unchanged.
    expect(creditRewardClasses(new Map([["a", 0.9], ["b", 0.8], ["c", 0.2], ["d", 0.1]]))?.positive.size).toBe(2);
  });
});
