import {
  buildCalibrationModel,
  calibrateProbability,
  type CalibrationModel
} from "./scoring/calibration.js";
import { evaluateCalibration, type EvaluationMetrics } from "./scoring/evaluation.js";
import {
  type CalibrationModelSet,
  type CalibrationObservationRecord
} from "./calibration-spine.js";
import { canonicalStringify, createHasher } from "./primitives.js";

export interface CalibrationEvaluationSplit {
  seed: string;
  fitObservationIds: string[];
  holdoutObservationIds: string[];
  fitSourceGroupIds: string[];
  holdoutSourceGroupIds: string[];
  splitHash: string;
}

export interface CalibrationHoldoutResult {
  key: string;
  calibrationId: string;
  taskClass: string;
  status: "evaluated" | "insufficient_data";
  reasons: string[];
  split: CalibrationEvaluationSplit;
  fitOutcomeRate?: number;
  holdoutOutcomeRate?: number;
  rawMetrics?: EvaluationMetrics;
  calibratedMetrics?: EvaluationMetrics;
  brierDelta?: number;
  modelId?: string;
}

export interface CalibrationEvaluationReport {
  schema: "scce.calibration.holdout_report.v1";
  id: string;
  datasetId: string;
  inputHash: string;
  seed: string;
  holdoutFraction: number;
  minimumFitPoints: number;
  minimumHoldoutPoints: number;
  observationCount: number;
  sourceGroupCount: number;
  evaluatedModelCount: number;
  insufficientModelCount: number;
  results: CalibrationHoldoutResult[];
  claimBoundary: "supplied_source_disjoint_holdout_only";
  createdAt: number;
}

export interface CalibrationEvaluationOutput {
  report: CalibrationEvaluationReport;
  modelSet: CalibrationModelSet;
}

/**
 * Fits calibration bins only on source-group-disjoint fit observations and reports
 * Brier/NLL/ECE only on the untouched holdout. The caller remains responsible for
 * establishing that the supplied dataset is representative of a deployment task.
 */
export function fitAndEvaluateCalibrationObservations(input: {
  observations: readonly CalibrationObservationRecord[];
  datasetId: string;
  seed?: string;
  holdoutFraction?: number;
  minimumFitPoints?: number;
  minimumHoldoutPoints?: number;
  binCount?: number;
  createdAt?: number;
}): CalibrationEvaluationOutput {
  const datasetId = requiredText(input.datasetId, "datasetId");
  const seed = requiredText(input.seed ?? "scce.calibration.holdout.v1", "seed");
  const holdoutFraction = finiteFraction(input.holdoutFraction ?? 0.25, "holdoutFraction");
  const minimumFitPoints = positiveInteger(input.minimumFitPoints ?? 20, "minimumFitPoints");
  const minimumHoldoutPoints = positiveInteger(input.minimumHoldoutPoints ?? 20, "minimumHoldoutPoints");
  const requestedBinCount = positiveInteger(input.binCount ?? 10, "binCount");
  const hasher = createHasher();
  const observations = normalizedObservations(input.observations);
  const createdAt = finiteTimestamp(input.createdAt ?? observations.reduce((latest, observation) => Math.max(latest, observation.createdAt), 0));
  const inputHash = hasher.digestHex(canonicalStringify(observations));
  const grouped = groupByCalibrationKey(observations);
  const models: Record<string, CalibrationModel> = {};
  const results: CalibrationHoldoutResult[] = [];

  for (const [key, rows] of [...grouped.entries()].sort(([left], [right]) => compareCanonicalText(left, right))) {
    const [calibrationId, taskClass] = splitCalibrationKey(key);
    const split = sourceDisjointSplit({ rows, key, seed, holdoutFraction, hasher });
    const fitRows = observationsForIds(rows, split.fitObservationIds);
    const holdoutRows = observationsForIds(rows, split.holdoutObservationIds);
    const reasons = insufficiencyReasons({ fitRows, holdoutRows, split, minimumFitPoints, minimumHoldoutPoints });
    if (reasons.length) {
      results.push({ key, calibrationId, taskClass, status: "insufficient_data", reasons, split });
      continue;
    }

    const binCount = Math.max(2, Math.min(50, requestedBinCount, Math.floor(Math.sqrt(fitRows.length))));
    const model = buildCalibrationModel({
      id: `calibration.model.${hasher.digestHex(canonicalStringify({
        datasetId,
        inputHash,
        key,
        splitHash: split.splitHash,
        binCount,
        createdAt,
        fit: fitRows.map(row => ({ id: row.id, rawScore: row.rawScore, outcome: row.outcome, sourceRecordId: row.sourceRecordId }))
      })).slice(0, 32)}`,
      taskClass,
      points: fitRows.map(row => ({ raw: row.rawScore, outcome: row.outcome })),
      binCount,
      createdAt
    });
    models[key] = model;
    const rawMetrics = evaluateCalibration(holdoutRows.map(row => ({ predicted: row.rawScore, actual: row.outcome })), binCount);
    const calibratedMetrics = evaluateCalibration(holdoutRows.map(row => ({ predicted: calibrateProbability(row.rawScore, model), actual: row.outcome })), binCount);
    results.push({
      key,
      calibrationId,
      taskClass,
      status: "evaluated",
      reasons: [],
      split,
      fitOutcomeRate: outcomeRate(fitRows),
      holdoutOutcomeRate: outcomeRate(holdoutRows),
      rawMetrics,
      calibratedMetrics,
      brierDelta: calibratedMetrics.brier - rawMetrics.brier,
      modelId: model.id
    });
  }

  const sourceGroupCount = new Set(observations.map(sourceGroupId)).size;
  const evaluatedModelCount = results.filter(result => result.status === "evaluated").length;
  const modelSet: CalibrationModelSet = {
    schema: "scce.calibration.model_set.v1",
    id: `calibration.model_set.${hasher.digestHex(canonicalStringify({ datasetId, inputHash, seed, models, createdAt })).slice(0, 32)}`,
    models,
    creativePreferenceModels: {},
    observationCount: results
      .filter(result => result.status === "evaluated")
      .reduce((sum, result) => sum + result.split.fitObservationIds.length, 0),
    createdAt
  };
  const reportBody = {
    datasetId,
    inputHash,
    seed,
    holdoutFraction,
    minimumFitPoints,
    minimumHoldoutPoints,
    observationCount: observations.length,
    sourceGroupCount,
    evaluatedModelCount,
    insufficientModelCount: results.length - evaluatedModelCount,
    results,
    claimBoundary: "supplied_source_disjoint_holdout_only" as const,
    createdAt
  };
  return {
    modelSet,
    report: {
      schema: "scce.calibration.holdout_report.v1",
      id: `calibration.holdout_report.${hasher.digestHex(canonicalStringify(reportBody)).slice(0, 32)}`,
      ...reportBody
    }
  };
}

function normalizedObservations(input: readonly CalibrationObservationRecord[]): CalibrationObservationRecord[] {
  const seen = new Set<string>();
  return [...input].map(observation => {
    if (!observation || typeof observation !== "object" || Array.isArray(observation)) throw new Error("calibration observation must be an object");
    if (observation.schema !== "scce.calibration.observation.v1") throw new Error(`invalid calibration observation schema: ${observation.id}`);
    const normalized: CalibrationObservationRecord = {
      ...observation,
      id: requiredText(observation.id, "observation.id"),
      calibrationId: requiredText(observation.calibrationId, "observation.calibrationId"),
      subsystemId: requiredText(observation.subsystemId, "observation.subsystemId"),
      taskClass: requiredText(observation.taskClass, "observation.taskClass"),
      finalOutcome: requiredText(observation.finalOutcome, "observation.finalOutcome"),
      sourceRecordId: requiredText(observation.sourceRecordId ?? "", "observation.sourceRecordId (source-disjoint grouping key)"),
      ...(observation.sourceTraceId === undefined
        ? {}
        : { sourceTraceId: requiredText(observation.sourceTraceId, "observation.sourceTraceId") }),
      ...(observation.selectedOutputHash === undefined
        ? {}
        : { selectedOutputHash: requiredText(observation.selectedOutputHash, "observation.selectedOutputHash") }),
      createdAt: finiteTimestamp(observation.createdAt)
    };
    if (normalized.calibrationId.includes("|") || normalized.taskClass.includes("|")) {
      throw new Error(`calibration observation key fields cannot contain '|': ${normalized.id}`);
    }
    if (!Number.isFinite(normalized.rawScore) || normalized.rawScore < 0 || normalized.rawScore > 1) {
      throw new Error(`calibration observation rawScore must be within [0,1]: ${normalized.id}`);
    }
    if (typeof normalized.outcome !== "boolean") throw new Error(`calibration observation outcome must be boolean: ${normalized.id}`);
    if (seen.has(normalized.id)) throw new Error(`duplicate calibration observation id after canonicalization: ${normalized.id}`);
    seen.add(normalized.id);
    return normalized;
  }).sort((left, right) => compareCanonicalText(left.id, right.id));
}

function groupByCalibrationKey(observations: readonly CalibrationObservationRecord[]): Map<string, CalibrationObservationRecord[]> {
  const grouped = new Map<string, CalibrationObservationRecord[]>();
  for (const observation of observations) {
    const key = `${observation.calibrationId}|${observation.taskClass}`;
    grouped.set(key, [...(grouped.get(key) ?? []), observation]);
  }
  return grouped;
}

function sourceDisjointSplit(input: {
  rows: readonly CalibrationObservationRecord[];
  key: string;
  seed: string;
  holdoutFraction: number;
  hasher: ReturnType<typeof createHasher>;
}): CalibrationEvaluationSplit {
  const groups = new Map<string, CalibrationObservationRecord[]>();
  for (const row of input.rows) {
    const groupId = sourceGroupId(row);
    groups.set(groupId, [...(groups.get(groupId) ?? []), row]);
  }
  const groupIds = [...groups.keys()].sort((left, right) => {
    const leftHash = input.hasher.digestHex(`${input.seed}\u001f${input.key}\u001f${left}`);
    const rightHash = input.hasher.digestHex(`${input.seed}\u001f${input.key}\u001f${right}`);
    return compareCanonicalText(leftHash, rightHash) || compareCanonicalText(left, right);
  });
  const holdoutGroupCount = groupIds.length < 2
    ? groupIds.length
    : Math.max(1, Math.min(groupIds.length - 1, Math.round(groupIds.length * input.holdoutFraction)));
  const holdoutSourceGroupIds = groupIds.slice(0, holdoutGroupCount).sort();
  const fitSourceGroupIds = groupIds.slice(holdoutGroupCount).sort();
  const holdoutSet = new Set(holdoutSourceGroupIds);
  const fitObservationIds = input.rows.filter(row => !holdoutSet.has(sourceGroupId(row))).map(row => row.id).sort();
  const holdoutObservationIds = input.rows.filter(row => holdoutSet.has(sourceGroupId(row))).map(row => row.id).sort();
  const splitBody = { input: input.key, seed: input.seed, fitObservationIds, holdoutObservationIds, fitSourceGroupIds, holdoutSourceGroupIds };
  return {
    seed: input.seed,
    fitObservationIds,
    holdoutObservationIds,
    fitSourceGroupIds,
    holdoutSourceGroupIds,
    splitHash: input.hasher.digestHex(canonicalStringify(splitBody))
  };
}

function insufficiencyReasons(input: {
  fitRows: readonly CalibrationObservationRecord[];
  holdoutRows: readonly CalibrationObservationRecord[];
  split: CalibrationEvaluationSplit;
  minimumFitPoints: number;
  minimumHoldoutPoints: number;
}): string[] {
  const reasons: string[] = [];
  if (input.split.fitSourceGroupIds.length < 1 || input.split.holdoutSourceGroupIds.length < 1) reasons.push("fewer_than_two_source_groups");
  if (input.fitRows.length < input.minimumFitPoints) reasons.push("fit_points_below_minimum");
  if (input.holdoutRows.length < input.minimumHoldoutPoints) reasons.push("holdout_points_below_minimum");
  if (!hasBothOutcomes(input.fitRows)) reasons.push("fit_outcome_class_missing");
  if (!hasBothOutcomes(input.holdoutRows)) reasons.push("holdout_outcome_class_missing");
  return reasons;
}

function observationsForIds(rows: readonly CalibrationObservationRecord[], ids: readonly string[]): CalibrationObservationRecord[] {
  const wanted = new Set(ids);
  return rows.filter(row => wanted.has(row.id)).sort((left, right) => compareCanonicalText(left.id, right.id));
}

function sourceGroupId(observation: CalibrationObservationRecord): string {
  return observation.sourceRecordId!;
}

function hasBothOutcomes(rows: readonly CalibrationObservationRecord[]): boolean {
  return rows.some(row => row.outcome) && rows.some(row => !row.outcome);
}

function outcomeRate(rows: readonly CalibrationObservationRecord[]): number {
  return rows.filter(row => row.outcome).length / rows.length;
}

function splitCalibrationKey(key: string): [string, string] {
  const separator = key.indexOf("|");
  if (separator <= 0 || separator === key.length - 1) throw new Error(`invalid calibration key: ${key}`);
  return [key.slice(0, separator), key.slice(separator + 1)];
}

function requiredText(value: string, field: string): string {
  const normalized = value.normalize("NFC").trim();
  if (!normalized) throw new Error(`${field} is required`);
  return normalized;
}

function compareCanonicalText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function finiteFraction(value: number, field: string): number {
  if (!Number.isFinite(value) || value <= 0 || value >= 1) throw new Error(`${field} must be within (0,1)`);
  return value;
}

function positiveInteger(value: number, field: string): number {
  if (!Number.isInteger(value) || value < 1) throw new Error(`${field} must be a positive integer`);
  return value;
}

function finiteTimestamp(value: number): number {
  if (!Number.isFinite(value) || value < 0) throw new Error("createdAt must be a non-negative finite timestamp");
  return Math.floor(value);
}
