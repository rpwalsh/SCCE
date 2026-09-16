// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
import { describe, expect, it } from "vitest";
import {
  buildCalibrationModelSet,
  buildOperatorRoutingModels,
  operatorRoutingActivationModel,
  type OperatorRoutingModel
} from "../calibration-spine.js";
import { cognitiveCreditStageObservations, CREDIT_OUTCOME_LABEL_IDS, CREDIT_OUTCOME_SOURCE_IDS, CREDIT_STAGE_IDS, CREDIT_STAGE_CALIBRATION, COGNITIVE_CREDIT_SCHEMA, type CognitiveCreditRecord } from "../cognitive-credit.js";
import {
  COGNITIVE_OPERATOR_IDS,
  DEFAULT_COGNITIVE_OPERATOR_MODEL,
  TURN_REQUIREMENT_DIMENSIONS,
  activateCognitiveOperators,
  type TurnRequirementDimension,
  type TurnRequirementField
} from "../turn-requirements.js";
import type { CalibrationObservationRecord } from "../calibration-spine.js";

const DIMENSIONS = TURN_REQUIREMENT_DIMENSIONS as readonly TurnRequirementDimension[];

function requirementRow(high: readonly TurnRequirementDimension[]): Record<string, number> {
  return Object.fromEntries(DIMENSIONS.map(dimension => [dimension, high.includes(dimension) ? 0.9 : 0.1]));
}

/** A credit record shaped exactly as buildCognitiveCreditRecord emits one, for the two stages the fit joins. */
function creditRecord(input: {
  episodeId: string;
  requirement: Record<string, number>;
  activeOperatorIds: readonly string[];
  positive: boolean;
}): CognitiveCreditRecord {
  const stage = (stageId: typeof CREDIT_STAGE_IDS[keyof typeof CREDIT_STAGE_IDS], quantities: Record<string, number>, ids: string[]) => {
    const binding = CREDIT_STAGE_CALIBRATION[stageId];
    return {
      stageId,
      chainId: binding.chainId,
      calibrationId: binding.calibrationId,
      subsystemId: binding.subsystemId,
      decidingQuantity: 0.5,
      decidingQuantities: quantities,
      ids,
      upstreamIds: [],
      reached: true
    };
  };
  return {
    schema: COGNITIVE_CREDIT_SCHEMA,
    id: `cognitive.credit.${input.episodeId}`,
    episodeId: input.episodeId,
    conversationId: "conv.1",
    taskClass: "task.general_cognition",
    requestedAuthority: "factual",
    createdAt: 1_000,
    outcome: {
      label: input.positive ? CREDIT_OUTCOME_LABEL_IDS.positive : CREDIT_OUTCOME_LABEL_IDS.negative,
      source: CREDIT_OUTCOME_SOURCE_IDS.runtimeSignal,
      supervised: false,
      reward: input.positive ? 0.9 : 0.3,
      rewardTerms: { obligationDischarge: input.positive ? 0.9 : 0.3, nonContradiction: input.positive ? 0.9 : 0.3 },
      signals: { spoke: true, withheld: false, replanned: false, revised: false, corrected: false, contradictionMass: 0, obligationCount: 10, unresolvedObligationCount: input.positive ? 1 : 7, budgetExceededCount: 0, evidenceCount: 1 },
      graded: null
    },
    stages: [
      stage(CREDIT_STAGE_IDS.requirement, input.requirement, []),
      stage(CREDIT_STAGE_IDS.operator, { active: input.activeOperatorIds.length, considered: 17 }, [...input.activeOperatorIds])
    ]
  };
}

/**
 * Episodes in which running the counterfactual operator is what made the turn work, and running the program
 * planner on the same requirement field is what broke it. Nothing here names a word or a request; the whole
 * signal is the requirement field and the reward.
 */
function episodes(count: number): CalibrationObservationRecord[] {
  const rows: CalibrationObservationRecord[] = [];
  for (let index = 0; index < count; index++) {
    const counterfactualTurn = index % 2 === 0;
    rows.push(...cognitiveCreditStageObservations(creditRecord({
      episodeId: `episode.${index}`,
      requirement: requirementRow(["counterfactualDemand", "inferentialDepth"]),
      activeOperatorIds: counterfactualTurn
        ? [COGNITIVE_OPERATOR_IDS.counterfactualConstruction]
        : [COGNITIVE_OPERATOR_IDS.programPlanning],
      positive: counterfactualTurn
    })));
  }
  return rows;
}

const field = (row: Record<string, number>): TurnRequirementField =>
  ({ ...row, confidence: 0.8, trace: {} } as unknown as TurnRequirementField);

const activationOf = (operatorId: string, model: Parameters<typeof activateCognitiveOperators>[0]["model"], row: Record<string, number>) =>
  activateCognitiveOperators({ model, requirementField: field(row) }).find(item => item.operatorId === operatorId)!;

describe("operator routing is fitted from the credit ledger's own episodes", () => {
  it("refuses to produce a model when every episode measured the same reward", () => {
    // The reward is the label now, so a degenerate one must still refuse, boolean column or not.
    const constant = episodes(40).map(row => ({
      ...row,
      outcome: false,
      metadata: { ...(row.metadata as Record<string, unknown>), reward: 0.5, supervised: false }
    }));
    expect(buildOperatorRoutingModels({ observations: constant, createdAt: 2_000 })).toEqual({});
  });

  /**
   * What the live table held before this lane: every credit row outcome=false, because the label demanded
   * zero unresolved obligations. The rewards underneath carry two classes, and the fit must find them.
   */
  it("fits from the reward distribution even where every stored outcome column reads false", () => {
    const columnFalse = episodes(40).map(row => ({ ...row, outcome: false }));
    const models = buildOperatorRoutingModels({ observations: columnFalse, createdAt: 2_000 });
    expect(Object.keys(models)).toHaveLength(1);
    expect(models["task.general_cognition"]!.sampleCount).toBe(40);
  });

  it("refuses to produce a model with fewer episodes than the model has free parameters", () => {
    expect(buildOperatorRoutingModels({ observations: episodes(4), createdAt: 2_000 })).toEqual({});
  });

  it("leaves the shipped bootstrap in force, reliability and all, when there is no model", () => {
    const model = operatorRoutingActivationModel({ modelSet: buildCalibrationModelSet({ observations: [], createdAt: 2_000 }) });
    expect(model).toBe(DEFAULT_COGNITIVE_OPERATOR_MODEL);
    expect(model.reliability).toBe("uncalibrated_bootstrap");
  });

  it("moves the operator the reward favoured above the one it punished", () => {
    const fitted = buildOperatorRoutingModels({ observations: episodes(64), createdAt: 2_000 })["task.general_cognition"] as OperatorRoutingModel;
    expect(fitted).toBeDefined();
    expect(fitted.sampleCount).toBe(64);
    expect(fitted.positiveCount).toBe(32);

    const row = requirementRow(["counterfactualDemand", "inferentialDepth"]);
    const learned = operatorRoutingActivationModel({
      modelSet: { ...buildCalibrationModelSet({ observations: [], createdAt: 2_000 }), operatorRoutingModels: { "task.general_cognition": fitted } },
      blendTargetSamples: 64
    });
    expect(learned.reliability).toBe("calibrated");

    const rewardedBefore = activationOf(COGNITIVE_OPERATOR_IDS.counterfactualConstruction, DEFAULT_COGNITIVE_OPERATOR_MODEL, row).activation;
    const rewardedAfter = activationOf(COGNITIVE_OPERATOR_IDS.counterfactualConstruction, learned, row).activation;
    const punishedBefore = activationOf(COGNITIVE_OPERATOR_IDS.programPlanning, DEFAULT_COGNITIVE_OPERATOR_MODEL, row).activation;
    const punishedAfter = activationOf(COGNITIVE_OPERATOR_IDS.programPlanning, learned, row).activation;

    expect(rewardedAfter).toBeGreaterThan(rewardedBefore);
    expect(punishedAfter).toBeLessThan(punishedBefore);
  });

  it("derives its activation threshold from the fitted activations instead of keeping 0.5", () => {
    const fitted = buildOperatorRoutingModels({ observations: episodes(64), createdAt: 2_000 })["task.general_cognition"] as OperatorRoutingModel;
    expect(fitted.activationThreshold).not.toBe(DEFAULT_COGNITIVE_OPERATOR_MODEL.activationThreshold);
    expect(fitted.activationThreshold).toBeGreaterThanOrEqual(0);
    expect(fitted.activationThreshold).toBeLessThanOrEqual(1);
  });

  it("fits identically twice over the same observations, so replay is deterministic", () => {
    const first = buildOperatorRoutingModels({ observations: episodes(64), createdAt: 2_000 })["task.general_cognition"]!;
    const second = buildOperatorRoutingModels({ observations: episodes(64), createdAt: 2_000 })["task.general_cognition"]!;
    expect(second.modelHash).toBe(first.modelHash);
    expect(second.id).toBe(first.id);
  });

  it("reaches the runtime through the model set the 120s cache already loads", () => {
    const set = buildCalibrationModelSet({ observations: episodes(64), createdAt: 2_000 });
    expect(set.operatorRoutingModels?.["task.general_cognition"]).toBeDefined();
    expect(operatorRoutingActivationModel({ modelSet: set }).reliability).toBe("calibrated");
  });
});
