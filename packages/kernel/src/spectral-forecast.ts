import { covariance, identity, multiply as matMul, transpose, zeros } from "./math.js";
import { clamp01, mean } from "./primitives.js";

export interface VarModel {
  order: number;
  intercept: number[];
  coefficients: number[][][];
  residualCovariance: number[][];
  aic: number;
  residuals: number[][];
}

export interface WoldForecast {
  model: VarModel;
  mean: number[];
  covariance: number[][];
  interval: Array<{ mean: number; low: number; high: number; sigma: number }>;
  impulse: number[][][];
  unstable: boolean;
  gapPenalty: number;
  sgwShrink: number;
}

export function fitVarByAic(series: number[][], maxOrder = 3): VarModel {
  const clean = series.filter(row => row.every(Number.isFinite));
  const d = clean[0]?.length ?? 0;
  if (clean.length <= 2 || d === 0) return coldStartVar(clean, 1);
  const models: VarModel[] = [];
  for (let order = 1; order <= Math.min(maxOrder, clean.length - 1); order++) models.push(fitVar(clean, order));
  return models.sort((a, b) => a.aic - b.aic)[0] ?? coldStartVar(clean, 1);
}

export function woldForecast(input: { series: number[][]; source: number[]; horizon: number; maxOrder?: number; sinTheta?: number; stabilityTrust?: number }): WoldForecast {
  const history = [...input.series, input.source].filter(row => row.length === input.source.length);
  const model = fitVarByAic(history, input.maxOrder ?? 3);
  const d = input.source.length;
  const impulse = impulseResponses(model.coefficients, input.horizon, d);
  const meanVector = forecastMean(model, history.slice(-model.order), input.horizon);
  const bareCovariance = woldCovariance(impulse, model.residualCovariance);
  const sinTheta = clamp01(input.sinTheta ?? 0.5);
  const unstable = sinTheta > 0.5;
  const sgwShrink = unstable ? 1 : Math.max(0, 1 - (input.stabilityTrust ?? 1) * sinTheta);
  const spectralGap = spectralRadiusGap(model.coefficients);
  const gapPenalty = 1 + 0.5 / Math.max(1e-6, spectralGap);
  const covariance = bareCovariance.map(row => row.map(value => Math.max(1e-9, value * (unstable ? 1 : sgwShrink ** 2))));
  const interval = meanVector.map((m, i) => {
    const sigma = Math.sqrt(Math.max(1e-9, covariance[i]?.[i] ?? 1e-9)) * gapPenalty;
    return { mean: m, low: m - 1.96 * sigma, high: m + 1.96 * sigma, sigma };
  });
  return { model, mean: meanVector, covariance, interval, impulse, unstable, gapPenalty, sgwShrink };
}

function fitVar(series: number[][], order: number): VarModel {
  const d = series[0]?.length ?? 0;
  const rows: number[][] = [];
  const y: number[][] = [];
  for (let t = order; t < series.length; t++) {
    const row = [1];
    for (let lag = 1; lag <= order; lag++) row.push(...(series[t - lag] ?? new Array(d).fill(0)));
    rows.push(row);
    y.push(series[t] ?? new Array(d).fill(0));
  }
  if (rows.length === 0) return coldStartVar(series, order);
  const beta = ridgeSolve(rows, y, 1e-6);
  const intercept = Array.from({ length: d }, (_, j) => beta[0]?.[j] ?? 0);
  const coefficients = Array.from({ length: order }, (_, lag) => {
    const block = zeros(d, d);
    for (let src = 0; src < d; src++) {
      const betaRow = beta[1 + lag * d + src] ?? [];
      for (let dst = 0; dst < d; dst++) block[dst]![src] = betaRow[dst] ?? 0;
    }
    return block;
  });
  const residuals = rows.map((row, i) => {
    const pred = multiplyRow(row, beta);
    const actual = y[i] ?? new Array(d).fill(0);
    return actual.map((value, j) => value - (pred[j] ?? 0));
  });
  const residualCovariance = covariance(residuals.length ? residuals : [new Array(d).fill(1e-6)]);
  const det = Math.max(1e-12, pseudoDet(residualCovariance));
  const params = d * (1 + d * order);
  const n = Math.max(1, residuals.length);
  const aic = n * Math.log(det) + 2 * params;
  return { order, intercept, coefficients, residualCovariance, aic, residuals };
}

function coldStartVar(series: number[][], order: number): VarModel {
  const d = series[0]?.length ?? 1;
  const deltas = series.slice(1).map((row, i) => row.map((value, j) => value - (series[i]?.[j] ?? 0)));
  const drift = Array.from({ length: d }, (_, j) => mean(deltas.map(row => row[j] ?? 0)));
  return {
    order,
    intercept: drift,
    coefficients: [identity(d).map(row => row.map(value => value * 0.65))],
    residualCovariance: covariance(deltas.length ? deltas : [new Array(d).fill(1e-6)]),
    aic: Number.POSITIVE_INFINITY,
    residuals: deltas
  };
}

function forecastMean(model: VarModel, tail: number[][], horizon: number): number[] {
  const d = model.intercept.length;
  const history = tail.length ? [...tail] : [new Array(d).fill(0)];
  while (history.length < model.order) history.unshift(history[0] ?? new Array(d).fill(0));
  for (let h = 0; h < horizon; h++) {
    const next = [...model.intercept];
    for (let lag = 1; lag <= model.order; lag++) {
      const coeff = model.coefficients[lag - 1] ?? identity(d);
      const row = history[history.length - lag] ?? new Array(d).fill(0);
      const contribution = matVec(coeff, row);
      for (let i = 0; i < d; i++) next[i] = (next[i] ?? 0) + (contribution[i] ?? 0);
    }
    history.push(next);
  }
  return history[history.length - 1] ?? new Array(d).fill(0);
}

function impulseResponses(coefficients: number[][][], horizon: number, d: number): number[][][] {
  const impulse = [identity(d)];
  for (let h = 1; h < horizon; h++) {
    let phi = zeros(d, d);
    for (let lag = 1; lag <= Math.min(h, coefficients.length); lag++) {
      phi = add(phi, matMul(coefficients[lag - 1] ?? zeros(d, d), impulse[h - lag] ?? identity(d)));
    }
    impulse.push(phi);
  }
  return impulse;
}

function woldCovariance(impulse: number[][][], sigma: number[][]): number[][] {
  const d = sigma.length;
  let out = zeros(d, d);
  for (const phi of impulse) out = add(out, matMul(matMul(phi, sigma), transpose(phi)));
  return out;
}

function ridgeSolve(x: number[][], y: number[][], lambda: number): number[][] {
  const xt = transpose(x);
  const xtx = matMul(xt, x);
  for (let i = 0; i < xtx.length; i++) xtx[i]![i] = (xtx[i]?.[i] ?? 0) + lambda;
  const xty = matMul(xt, y);
  return solveLinearSystem(xtx, xty);
}

function solveLinearSystem(a: number[][], b: number[][]): number[][] {
  const n = a.length;
  const m = b[0]?.length ?? 0;
  const aug = a.map((row, i) => [...row, ...(b[i] ?? new Array(m).fill(0))]);
  for (let col = 0; col < n; col++) {
    let pivot = col;
    for (let row = col + 1; row < n; row++) if (Math.abs(aug[row]?.[col] ?? 0) > Math.abs(aug[pivot]?.[col] ?? 0)) pivot = row;
    [aug[col], aug[pivot]] = [aug[pivot] ?? [], aug[col] ?? []];
    const denom = aug[col]?.[col] ?? 0;
    if (Math.abs(denom) < 1e-12) continue;
    for (let j = col; j < n + m; j++) aug[col]![j] = (aug[col]?.[j] ?? 0) / denom;
    for (let row = 0; row < n; row++) {
      if (row === col) continue;
      const factor = aug[row]?.[col] ?? 0;
      for (let j = col; j < n + m; j++) aug[row]![j] = (aug[row]?.[j] ?? 0) - factor * (aug[col]?.[j] ?? 0);
    }
  }
  return aug.map(row => row.slice(n, n + m));
}

function multiplyRow(row: number[], matrix: number[][]): number[] {
  const cols = matrix[0]?.length ?? 0;
  const out = new Array<number>(cols).fill(0);
  for (let j = 0; j < cols; j++) for (let i = 0; i < row.length; i++) out[j] = (out[j] ?? 0) + (row[i] ?? 0) * (matrix[i]?.[j] ?? 0);
  return out;
}

function matVec(matrix: number[][], vector: number[]): number[] {
  return matrix.map(row => row.reduce((sum, value, i) => sum + value * (vector[i] ?? 0), 0));
}

function add(a: number[][], b: number[][]): number[][] {
  return a.map((row, i) => row.map((value, j) => value + (b[i]?.[j] ?? 0)));
}

function pseudoDet(matrix: number[][]): number {
  return matrix.reduce((prod, row, i) => prod * Math.max(1e-9, Math.abs(row[i] ?? 0)), 1);
}

function spectralRadiusGap(coefficients: number[][][]): number {
  if (!coefficients.length) return 1;
  const first = coefficients[0] ?? [];
  const radius = Math.max(0, ...first.map(row => row.reduce((sum, value) => sum + Math.abs(value), 0)));
  return Math.max(1e-6, 1 - Math.min(0.999999, radius));
}
