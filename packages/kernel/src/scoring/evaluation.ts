import { clamp01 } from "../primitives.js";

export interface EvaluationPoint {
  predicted: number;
  actual: boolean;
}

export interface EvaluationMetrics {
  sampleCount: number;
  brier: number;
  nll: number;
  ece: number;
}

export function evaluateCalibration(points: EvaluationPoint[], binCount = 10): EvaluationMetrics {
  if (!points.length) return { sampleCount: 0, brier: 0, nll: 0, ece: 0 };
  const brier = points.reduce((sum, point) => {
    const p = clamp01(point.predicted);
    const y = point.actual ? 1 : 0;
    return sum + (p - y) * (p - y);
  }, 0) / points.length;
  const nll = points.reduce((sum, point) => {
    const p = clamp01(point.predicted);
    const y = point.actual ? 1 : 0;
    const clipped = Math.min(1 - 1e-9, Math.max(1e-9, p));
    return sum - (y * Math.log(clipped) + (1 - y) * Math.log(1 - clipped));
  }, 0) / points.length;
  const ece = expectedCalibrationError(points, binCount);
  return { sampleCount: points.length, brier, nll, ece };
}

export function expectedCalibrationError(points: EvaluationPoint[], binCount = 10): number {
  const bins = Array.from({ length: Math.max(2, binCount) }, () => [] as EvaluationPoint[]);
  for (const point of points) {
    const p = clamp01(point.predicted);
    const index = Math.min(bins.length - 1, Math.floor(p * bins.length));
    bins[index]!.push(point);
  }
  return bins.reduce((sum, bin) => {
    if (!bin.length) return sum;
    const confidence = bin.reduce((acc, row) => acc + clamp01(row.predicted), 0) / bin.length;
    const accuracy = bin.filter(row => row.actual).length / bin.length;
    return sum + (bin.length / points.length) * Math.abs(accuracy - confidence);
  }, 0);
}
