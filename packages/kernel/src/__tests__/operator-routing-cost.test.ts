// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
import { describe, expect, it } from "vitest";
import { buildOperatorRoutingModels } from "../calibration-spine.js";
import { cognitiveCreditStageObservations, CREDIT_OUTCOME_LABEL_IDS, CREDIT_OUTCOME_SOURCE_IDS, CREDIT_STAGE_IDS, CREDIT_STAGE_CALIBRATION, COGNITIVE_CREDIT_SCHEMA, type CognitiveCreditRecord } from "../cognitive-credit.js";
import { COGNITIVE_OPERATOR_IDS, TURN_REQUIREMENT_DIMENSIONS } from "../turn-requirements.js";
import type { CalibrationObservationRecord } from "../calibration-spine.js";

/** loadCalibrationModelSet reads 5000 rows; the credit ledger writes 13 per turn, so this is the real ceiling. */
const EPISODES_AT_THE_OBSERVATION_LIMIT = Math.floor(5000 / 13);

function rows(count: number): CalibrationObservationRecord[] {
  const out: CalibrationObservationRecord[] = [];
  for (let index = 0; index < count; index++) {
    const positive = index % 2 === 0;
    const record: CognitiveCreditRecord = {
      schema: COGNITIVE_CREDIT_SCHEMA,
      id: `cognitive.credit.${index}`,
      episodeId: `episode.${index}`,
      conversationId: "conv.1",
      taskClass: "task.general_cognition",
      requestedAuthority: "factual",
      createdAt: 1_000,
      outcome: {
        label: positive ? CREDIT_OUTCOME_LABEL_IDS.positive : CREDIT_OUTCOME_LABEL_IDS.negative,
        source: CREDIT_OUTCOME_SOURCE_IDS.runtimeSignal,
        supervised: false,
        signals: { spoke: true, withheld: false, replanned: false, revised: false, corrected: false, contradictionMass: 0, unresolvedObligationCount: 0, budgetExceededCount: 0, evidenceCount: 1 },
        graded: null
      },
      stages: [CREDIT_STAGE_IDS.requirement, CREDIT_STAGE_IDS.operator].map(stageId => {
        const binding = CREDIT_STAGE_CALIBRATION[stageId];
        return {
          stageId,
          chainId: binding.chainId,
          calibrationId: binding.calibrationId,
          subsystemId: binding.subsystemId,
          decidingQuantity: 0.5,
          decidingQuantities: stageId === CREDIT_STAGE_IDS.requirement
            ? Object.fromEntries(TURN_REQUIREMENT_DIMENSIONS.map((dimension, position) => [dimension, ((index + position) % 10) / 10]))
            : { active: 1 },
          ids: stageId === CREDIT_STAGE_IDS.operator
            ? [positive ? COGNITIVE_OPERATOR_IDS.counterfactualConstruction : COGNITIVE_OPERATOR_IDS.programPlanning]
            : [],
          upstreamIds: [],
          reached: true
        };
      })
    };
    out.push(...cognitiveCreditStageObservations(record));
  }
  return out;
}

describe("the routing fit stays a background cost, never a turn cost", () => {
  it("fits the whole 5000-observation window well inside the 10s turn budget", () => {
    const observations = rows(EPISODES_AT_THE_OBSERVATION_LIMIT);
    const started = performance.now();
    const fitted = buildOperatorRoutingModels({ observations, createdAt: 2_000 })["task.general_cognition"];
    const elapsedMs = performance.now() - started;
    expect(fitted).toBeDefined();
    // Reported, not just asserted: a refit lands on a cold turn and the contract is 10s for the whole turn.
    console.log(`operator routing fit: ${observations.length} observations, ${fitted!.sampleCount} episodes, ${elapsedMs.toFixed(0)}ms`);
    // Measured 109ms here against the judge refit's 16ms on the same window. The record-shaped first draft of
    // this descent cost 1667ms, which is the regression this bound exists to catch.
    expect(elapsedMs).toBeLessThan(500);
  });
});
