// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
/**
 * What a brand-new brain's calibration subsystem does at every observation count, measured rather than read
 * off the code: which fitters install a model, what a consumer is told, and which guard refused.
 * Offline. Touches no database. `vite-node tools/calibration-cold-start-report.mts`
 */
import {
  CALIBRATION_IDS,
  CALIBRATION_SUBSYSTEM_IDS,
  CALIBRATION_TASK_CLASS_IDS,
  buildCalibrationModelSet,
  calibrateRuntimeScore,
  calibrationObservationRecord,
  type CalibrationObservationRecord
} from "../packages/kernel/src/calibration-spine.js";
import { TURN_REQUIREMENT_DIMENSIONS, COGNITIVE_OPERATOR_IDS } from "../packages/kernel/src/turn-requirements.js";
import { PUBLIC_CALIBRATIONS } from "../packages/kernel/src/calibrations/public-calibrations.js";

const ID = CALIBRATION_IDS.proofSupport;
const CLASS = CALIBRATION_TASK_CLASS_IDS.sourceBoundQa;
const RAW = 0.0288;

function rows(count: number, alternateOutcome: boolean): CalibrationObservationRecord[] {
  return Array.from({ length: count }, (_value, index) => calibrationObservationRecord({
    calibrationId: ID,
    subsystemId: CALIBRATION_SUBSYSTEM_IDS.proof,
    taskClass: CLASS,
    rawScore: RAW,
    outcome: alternateOutcome ? index % 2 === 0 : false,
    idSeed: `cold-report-${alternateOutcome ? "mixed" : "constant"}-${index}`,
    createdAt: 1_000 + index
  }));
}

console.log(`declared public ids: ${Object.keys(PUBLIC_CALIBRATIONS).length}`);
console.log(`spine ids: ${Object.values(CALIBRATION_IDS).length}  task classes: ${Object.values(CALIBRATION_TASK_CLASS_IDS).length}`);
console.log(`operator routing free parameters per operator: ${1 + TURN_REQUIREMENT_DIMENSIONS.length} (1 intercept + ${TURN_REQUIREMENT_DIMENSIONS.length} requirement dimensions), operators: ${Object.values(COGNITIVE_OPERATOR_IDS).length}`);
console.log("");
console.log("rows | label | binned model | consumer measurement | calibrated value | judge | routing");
for (const mixed of [false, true]) {
  for (const count of [0, 1, 2, 3, 8, 23, 24, 25, 40]) {
    const observations = rows(count, mixed);
    const modelSet = buildCalibrationModelSet({ observations, createdAt: 9_000 });
    const resolved = calibrateRuntimeScore({ raw: RAW, calibrationId: ID, taskClass: CLASS, modelSet });
    const model = modelSet.models[`${ID}|${CLASS}`];
    console.log([
      String(count).padStart(4),
      (mixed ? "mixed" : "constant").padEnd(8),
      (model ? `yes bin n=${model.bins.find(bin => RAW >= bin.lower && RAW < bin.upper)?.count ?? 0}` : "no").padEnd(13),
      resolved.measurement.padEnd(22),
      resolved.value.toFixed(4).padEnd(8),
      (Object.keys(modelSet.judgeRequirementModels ?? {}).length ? "yes" : "no").padEnd(5),
      Object.keys(modelSet.operatorRoutingModels ?? {}).length ? "yes" : "no"
    ].join(" | "));
  }
}
