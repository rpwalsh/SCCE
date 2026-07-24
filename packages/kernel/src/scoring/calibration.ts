import { clamp01, createClock } from "../primitives.js";
import { calibratedScore, type ScoreTrace } from "./score-trace.js";
import { regularizedCalibrationLoss } from "../equation-operators.js";
import type { Clock } from "../types.js";

export interface CalibrationBin {
  lower: number;
  upper: number;
  confidence: number;
  empirical: number;
}

export interface CalibrationModel {
  id: string;
  taskClass: string;
  bins: CalibrationBin[];
  trainingLoss?: number;
  createdAt: number;
}

export interface CalibrationPoint {
  raw: number;
  outcome: boolean;
}

export function buildCalibrationModel(input: { id: string; taskClass: string; points: CalibrationPoint[]; binCount?: number; createdAt?: number; clock?: Clock }): CalibrationModel {
  const binCount = Math.max(2, Math.min(50, input.binCount ?? 10));
  const bins: CalibrationBin[] = [];
  for (let i = 0; i < binCount; i++) {
    const lower = i / binCount;
    const upper = (i + 1) / binCount;
    const rows = input.points.filter(point => point.raw >= lower && (i === binCount - 1 ? point.raw <= upper : point.raw < upper));
    const confidence = rows.length ? rows.reduce((sum, row) => sum + clamp01(row.raw), 0) / rows.length : (lower + upper) / 2;
    const empirical = rows.length ? rows.filter(row => row.outcome).length / rows.length : confidence;
    bins.push({ lower, upper, confidence: clamp01(confidence), empirical: clamp01(empirical) });
  }
  return {
    id: input.id,
    taskClass: input.taskClass,
    bins,
    trainingLoss: regularizedCalibrationLoss({
      predictions: input.points.map(point => point.raw),
      outcomes: input.points.map(point => point.outcome),
      weights: bins.map(bin => bin.empirical)
    }),
    createdAt: input.createdAt ?? (input.clock ?? createClock()).now()
  };
}

export function calibrateProbability(raw: number, model: CalibrationModel): number {
  const x = clamp01(raw);
  const bin = model.bins.find(item => x >= item.lower && (item.upper === 1 ? x <= item.upper : x < item.upper)) ?? model.bins[model.bins.length - 1];
  return clamp01(bin?.empirical ?? x);
}

export function calibratedScoreTrace(input: { raw: number; model: CalibrationModel; meaning: string; provenance: string[]; inputs: string[] }): ScoreTrace {
  const value = calibrateProbability(input.raw, input.model);
  return calibratedScore({
    value,
    range: [0, 1],
    meaning: input.meaning,
    inputs: [...input.inputs, `taskClass:${input.model.taskClass}`],
    provenance: input.provenance,
    calibrationId: input.model.id
  });
}
