// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
import type { BoundaryStatisticsRow } from "./boundary-estimator.js";
export function boundaryFitDot(left: ArrayLike<number>, right: ArrayLike<number>, offset = 0, length = right.length): number {
  let sum = 0;
  let compensation = 0;
  for (let index = 0; index < Math.max(left.length, length); index++) {
    const product = (left[index] ?? 0) * (right[offset + index] ?? 0);
    const adjusted = product - compensation;
    const next = sum + adjusted;
    compensation = (next - sum) - adjusted;
    sum = next;
  }
  return sum;
}

export function boundaryFitSigmoid(value: number): number {
  if (value >= 0) {
    const inverse = Math.exp(-Math.min(60, value));
    return 1 / (1 + inverse);
  }
  const exponent = Math.exp(Math.max(-60, value));
  return exponent / (1 + exponent);
}

export function boundaryFitQuantize(value: number): number {
  return Math.round(value * 1_000_000_000_000) / 1_000_000_000_000;
}

export class BoundaryGradientPass {
  readonly gradients: Float64Array;
  interceptGradient = 0;

  constructor(readonly weights: number[], public intercept: number) {
    this.gradients = new Float64Array(weights.length);
  }

  begin(): void {
    this.gradients.fill(0);
    this.interceptGradient = 0;
  }

  add(features: ArrayLike<number>, offset: number, positive: number, mass: number): void {
    const predicted = boundaryFitSigmoid(this.intercept + boundaryFitDot(this.weights, features, offset, this.weights.length));
    const residual = predicted * mass - positive;
    this.interceptGradient += residual;
    for (let feature = 0; feature < this.weights.length; feature++) {
      this.gradients[feature] = this.gradients[feature]! + residual * features[offset + feature]!;
    }
  }

  finish(totalMass: number, learningRate: number, l2: number): void {
    this.intercept = boundaryFitQuantize(this.intercept - learningRate * this.interceptGradient / totalMass);
    for (let feature = 0; feature < this.weights.length; feature++) {
      const regularized = this.gradients[feature]! / totalMass + l2 * this.weights[feature]!;
      this.weights[feature] = boundaryFitQuantize(this.weights[feature]! - learningRate * regularized);
    }
  }
}

export class BoundaryCalibrationPass {
  slope = 1;
  intercept = 0;
  slopeGradient = 0;
  interceptGradient = 0;

  begin(): void { this.slopeGradient = 0; this.interceptGradient = 0; }

  add(rawLogit: number, positive: number, mass: number): void {
    const residual = boundaryFitSigmoid(this.slope * rawLogit + this.intercept) * mass - positive;
    this.slopeGradient += residual * rawLogit;
    this.interceptGradient += residual;
  }

  finish(mass: number): void {
    this.slope = boundaryFitQuantize(Math.min(10, Math.max(0.05, this.slope - 0.08 * this.slopeGradient / mass)));
    this.intercept = boundaryFitQuantize(this.intercept - 0.08 * this.interceptGradient / mass);
  }
}

export class BoundaryMetricsPass {
  logLoss = 0;
  brier = 0;
  mass = 0;
  truePositive = 0;
  falsePositive = 0;
  falseNegative = 0;
  readonly bins = Array.from({ length: 10 }, () => ({ predicted: 0, positive: 0, mass: 0 }));

  constructor(readonly weights: readonly number[], readonly rawIntercept: number, readonly slope: number, readonly calibrationIntercept: number) {}

  add(row: BoundaryStatisticsRow, features?: readonly number[]): void {
    const positive = row.positiveMass / 1_024;
    const negative = row.negativeMass / 1_024;
    const rowMass = positive + negative;
    if (rowMass <= 0) return;
    const rawLogit = this.rawIntercept + boundaryFitDot(this.weights, features ?? row.featuresFixed.map(value => value / 1_000_000));
    const predicted = Math.min(1 - 1e-12, Math.max(1e-12, Math.min(1, Math.max(0, boundaryFitSigmoid(this.slope * rawLogit + this.calibrationIntercept)))));
    this.logLoss += -positive * Math.log(predicted) - negative * Math.log(1 - predicted);
    this.brier += positive * (1 - predicted) ** 2 + negative * predicted ** 2;
    this.mass += rowMass;
    const bin = this.bins[Math.min(9, Math.floor(predicted * 10))]!;
    bin.predicted += predicted * rowMass;
    bin.positive += positive;
    bin.mass += rowMass;
    const anchorPositive = row.anchoredPositiveMass / 1_024;
    const anchorNegative = row.anchoredNegativeMass / 1_024;
    if (predicted >= 0.5) {
      this.truePositive += anchorPositive;
      this.falsePositive += anchorNegative;
    } else this.falseNegative += anchorPositive;
  }

  finish(positiveMass: number, negativeMass: number) {
    let ece = 0;
    for (const bin of this.bins) {
      if (bin.mass <= 0) continue;
      ece += bin.mass / Math.max(1, this.mass) * Math.abs(bin.predicted / bin.mass - bin.positive / bin.mass);
    }
    const positiveRate = positiveMass / Math.max(1, positiveMass + negativeMass);
    const neutral = Math.min(1 - 1e-12, Math.max(1e-12, positiveRate));
    const baselineLogLoss = (-(positiveMass / 1_024) * Math.log(neutral) - (negativeMass / 1_024) * Math.log(1 - neutral)) / Math.max(1, this.mass);
    const averageLogLoss = this.logLoss / Math.max(1, this.mass);
    return { mass: boundaryFitQuantize(this.mass), logLoss: boundaryFitQuantize(averageLogLoss), brier: boundaryFitQuantize(this.brier / Math.max(1, this.mass)),
      expectedCalibrationError: boundaryFitQuantize(ece),
      anchorPrecision: this.truePositive + this.falsePositive > 0 ? boundaryFitQuantize(this.truePositive / (this.truePositive + this.falsePositive)) : null,
      anchorRecall: this.truePositive + this.falseNegative > 0 ? boundaryFitQuantize(this.truePositive / (this.truePositive + this.falseNegative)) : null,
      predictiveCompressionGainNats: boundaryFitQuantize(baselineLogLoss - averageLogLoss) };
  }
}
