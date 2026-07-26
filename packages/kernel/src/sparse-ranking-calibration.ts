import type { FtrlPlattCalibration, FtrlProximalRanker } from "./sparse-ranking.js";
import type { SparseRankingComparisonExample } from "./sparse-ranking-comparison-log.js";

const MIN_CALIBRATION_EXAMPLES = 10;

/**
 * Platt-scaling calibration for FTRL's raw sigmoid output (Part A finding
 * 9, stage 6's calibration follow-up, plan item 33). Fits a slope and
 * intercept over a trained ranker's *raw scores* against real binary
 * outcomes (preferred=1, every other candidate in the same example=0) --
 * reusing the same comparison-log examples the held-out evaluation gate
 * reads, not a separate hand-labeled set. Returns undefined rather than a
 * fabricated calibration when there isn't enough real data.
 */
export function fitFtrlCalibration(input: {
  ranker: FtrlProximalRanker;
  examples: readonly SparseRankingComparisonExample[];
  calibrationId: string;
  iterations?: number;
  learningRate?: number;
}): FtrlPlattCalibration | undefined {
  const logits: number[] = [];
  const labels: (0 | 1)[] = [];
  for (const example of input.examples) {
    if (example.preferredIndex < 0 || example.preferredIndex >= example.candidates.length) continue;
    for (let index = 0; index < example.candidates.length; index++) {
      const vector = example.candidates[index];
      if (!vector) continue;
      logits.push(input.ranker.score(vector).rawScore);
      labels.push(index === example.preferredIndex ? 1 : 0);
    }
  }
  if (logits.length < MIN_CALIBRATION_EXAMPLES) return undefined;
  // Platt scaling degenerates without at least one example of each
  // class -- an all-one-label set has no decision boundary to fit.
  if (!labels.includes(0) || !labels.includes(1)) return undefined;

  const iterations = input.iterations ?? 600;
  const learningRate = input.learningRate ?? 0.05;
  let slope = 1;
  let intercept = 0;
  for (let iteration = 0; iteration < iterations; iteration++) {
    let slopeGradient = 0;
    let interceptGradient = 0;
    for (let index = 0; index < logits.length; index++) {
      const logit = logits[index]!;
      const error = sigmoid(slope * logit + intercept) - labels[index]!;
      slopeGradient += error * logit;
      interceptGradient += error;
    }
    slope -= learningRate * slopeGradient / logits.length;
    intercept -= learningRate * interceptGradient / logits.length;
  }
  if (!Number.isFinite(slope) || !Number.isFinite(intercept)) return undefined;

  return { method: "platt", calibrationId: input.calibrationId, slope, intercept };
}

function sigmoid(value: number): number {
  if (value >= 0) {
    const z = Math.exp(-value);
    return 1 / (1 + z);
  }
  const z = Math.exp(value);
  return z / (1 + z);
}
