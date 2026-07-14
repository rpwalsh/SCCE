import { identity, multiply as matMul, transpose, zeros } from "./math.js";
import { mean } from "./primitives.js";

const MAX_VAR_ORDER = 8;
const MAX_FORECAST_HORIZON = 64;
const NORMAL_95_QUANTILE = 1.959963984540054;

export interface CholeskyLogDetDiagnostics {
  method: "adaptive_jitter_cholesky";
  status: "exact" | "regularized" | "failed";
  logDet: number;
  jitter: number;
  attempts: number;
  scale: number;
  symmetryCorrection: number;
  reason?: string;
}

export interface VarAicDiagnostics {
  criterion: "conditional_multivariate_gaussian_aic";
  formula: "negativeTwoLogLikelihood + 2 * parameterCount";
  likelihoodObservations: number;
  regressionParameters: number;
  innovationCovarianceParameters: number;
  parameterCount: number;
  residualDegreesOfFreedom: number;
  commonEstimationStart: number;
  covarianceLogDet: CholeskyLogDetDiagnostics;
}

export interface VarModel {
  order: number;
  intercept: number[];
  coefficients: number[][][];
  residualCovariance: number[][];
  aic: number;
  residuals: number[][];
  fitStatus: "fitted" | "cold_start";
  fitReason?: string;
  aicDiagnostics: VarAicDiagnostics;
}

export interface RealEigenvalue {
  real: number;
  imaginary: number;
}

export interface RealSchurBlock {
  start: number;
  size: 1 | 2;
  eigenvalues: RealEigenvalue[];
  radius: number;
}

export interface SpectralRadiusDiagnostics {
  method: "real_shifted_qr_quasi_triangular";
  radius: number;
  /** One minus the reported radius (exact on convergence, conservative for an upper bound). */
  stabilityMargin: number;
  radiusKind: "eigenvalue_modulus" | "matrix_infinity_norm_upper_bound";
  converged: boolean;
  iterations: number;
  maxIterations: number;
  tolerance: number;
  deflations: number;
  unresolvedDimension: number;
  residual: number;
  singleShiftSteps: number;
  doubleShiftSteps: number;
  exceptionalShiftSteps: number;
  blocks: RealSchurBlock[];
  eigenvalues: RealEigenvalue[];
  reason?: string;
}

export interface ForecastHorizonSemantics {
  convention: "h_step_ahead_end_state";
  steps: number;
  meanAtStep: number;
  covarianceImpulseFrom: 0;
  covarianceImpulseThrough: number;
  covarianceFormula: "sum(Psi_i * Sigma_e * Psi_i^T), i=0..h-1";
}

export interface WoldForecast {
  model: VarModel;
  mean: number[];
  covariance: number[][];
  interval: Array<{ mean: number; low: number; high: number; sigma: number }>;
  impulse: number[][][];
  unstable: boolean;
  nearUnitRoot: boolean;
  stability: SpectralRadiusDiagnostics;
  horizonSemantics: ForecastHorizonSemantics;
  varianceScale: 1;
  intervalMethod: "uncalibrated_gaussian_95_percent_prediction_interval";
}

/**
 * Fit candidate VAR orders on one common estimation window and select by the
 * conditional multivariate-Gaussian AIC. The parameter count is
 * d(1 + dp) regression coefficients plus d(d + 1)/2 free covariance terms.
 */
export function fitVarByAic(series: number[][], maxOrder = 3): VarModel {
  const first = series.find(row => row.length > 0 && row.every(Number.isFinite));
  const d = first?.length ?? 0;
  const clean = d > 0 ? series.filter(row => row.length === d && row.every(Number.isFinite)) : [];
  if (clean.length <= 2 || d === 0) return coldStartVar(clean, 1, "insufficient_observations");

  const requestedMax = Math.min(MAX_VAR_ORDER, Math.max(1, Math.floor(maxOrder)), clean.length - 1);
  let feasibleMax = requestedMax;
  while (feasibleMax > 0) {
    const observations = clean.length - feasibleMax;
    const regressorsPerEquation = 1 + d * feasibleMax;
    if (observations - regressorsPerEquation >= d) break;
    feasibleMax--;
  }
  if (feasibleMax === 0) return coldStartVar(clean, 1, "insufficient_residual_degrees_of_freedom");

  const models: VarModel[] = [];
  for (let order = 1; order <= feasibleMax; order++) {
    models.push(fitVar(clean, order, feasibleMax));
  }
  const fitted = models
    .filter(model => Number.isFinite(model.aic))
    .sort((a, b) => a.aic - b.aic || a.order - b.order)[0];
  return fitted ?? coldStartVar(clean, 1, "covariance_factorization_failed");
}

export function woldForecast(input: {
  series: number[][];
  source: number[];
  horizon: number;
  maxOrder?: number;
}): WoldForecast {
  const horizon = validateHorizon(input.horizon);
  const history = [...input.series, input.source].filter(
    row => row.length === input.source.length && row.every(Number.isFinite)
  );
  const model = fitVarByAic(history, input.maxOrder ?? 3);
  return forecastFromVarModel({ model, history, horizon });
}

/** Forecast an already-fitted VAR model. Horizon h means the end state at t+h. */
export function forecastFromVarModel(input: {
  model: VarModel;
  history: number[][];
  horizon: number;
}): WoldForecast {
  const horizon = validateHorizon(input.horizon);
  const d = input.model.intercept.length;
  const history = input.history.filter(row => row.length === d && row.every(Number.isFinite));
  const impulse = woldImpulseResponses(input.model.coefficients, horizon, d);
  const meanVector = forecastMean(input.model, history.slice(-input.model.order), horizon);
  const forecastCovariance = woldCovarianceFromImpulse(impulse, input.model.residualCovariance);
  ensureFiniteVector(meanVector, "VAR forecast mean");
  ensureFiniteMatrix(forecastCovariance, "Wold forecast covariance");

  const stability = spectralRadiusForVar(input.model.coefficients);
  const unstable = !stability.converged || stability.radius >= 1;
  const nearUnitRoot = stability.converged && stability.radius < 1 && stability.radius >= 1 - 1e-6;
  const interval = meanVector.map((forecastMeanValue, index) => {
    const variance = Math.max(0, forecastCovariance[index]?.[index] ?? 0);
    const sigma = Math.sqrt(variance);
    return {
      mean: forecastMeanValue,
      low: forecastMeanValue - NORMAL_95_QUANTILE * sigma,
      high: forecastMeanValue + NORMAL_95_QUANTILE * sigma,
      sigma
    };
  });
  return {
    model: input.model,
    mean: meanVector,
    covariance: forecastCovariance,
    interval,
    impulse,
    unstable,
    nearUnitRoot,
    stability,
    horizonSemantics: {
      convention: "h_step_ahead_end_state",
      steps: horizon,
      meanAtStep: horizon,
      covarianceImpulseFrom: 0,
      covarianceImpulseThrough: horizon - 1,
      covarianceFormula: "sum(Psi_i * Sigma_e * Psi_i^T), i=0..h-1"
    },
    varianceScale: 1,
    intervalMethod: "uncalibrated_gaussian_95_percent_prediction_interval"
  };
}

/**
 * Compute log(det(A + jitter I)) by Cholesky factorization. Jitter begins at
 * zero and increases geometrically only when the preceding factorization
 * fails. A failed result is explicit and has an infinite log determinant.
 */
export function adaptiveJitterCholeskyLogDet(
  matrix: number[][],
  options: { maxAttempts?: number; relativeInitialJitter?: number } = {}
): CholeskyLogDetDiagnostics {
  const method = "adaptive_jitter_cholesky" as const;
  const n = matrix.length;
  if (n === 0) {
    return { method, status: "exact", logDet: 0, jitter: 0, attempts: 1, scale: 1, symmetryCorrection: 0 };
  }
  if (!isSquareFinite(matrix)) {
    return {
      method,
      status: "failed",
      logDet: Number.POSITIVE_INFINITY,
      jitter: 0,
      attempts: 0,
      scale: 1,
      symmetryCorrection: Number.POSITIVE_INFINITY,
      reason: "matrix_must_be_square_and_finite"
    };
  }

  const symmetric = symmetrize(matrix);
  const symmetryCorrection = maxSymmetryCorrection(matrix);
  const matrixNorm = matrixInfinityNorm(symmetric);
  const scale = matrixNorm > 0 ? matrixNorm : 1;
  const maxAttempts = Math.max(1, Math.min(20, Math.floor(options.maxAttempts ?? 14)));
  const relativeInitialJitter = Math.max(Number.EPSILON, options.relativeInitialJitter ?? 1e-12);

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const jitter = attempt === 0 ? 0 : scale * relativeInitialJitter * 10 ** (attempt - 1);
    const diagonal = choleskyDiagonal(symmetric, jitter);
    if (!diagonal) continue;
    const logDet = 2 * diagonal.reduce((sum, value) => sum + Math.log(value), 0);
    if (!Number.isFinite(logDet)) continue;
    return {
      method,
      status: jitter === 0 ? "exact" : "regularized",
      logDet,
      jitter,
      attempts: attempt + 1,
      scale,
      symmetryCorrection
    };
  }

  return {
    method,
    status: "failed",
    logDet: Number.POSITIVE_INFINITY,
    jitter: scale * relativeInitialJitter * 10 ** Math.max(0, maxAttempts - 2),
    attempts: maxAttempts,
    scale,
    symmetryCorrection,
    reason: "cholesky_did_not_converge_within_jitter_budget"
  };
}

/** Build the standard dp by dp block companion matrix for a VAR(p). */
export function buildVarCompanionMatrix(coefficients: number[][][]): number[][] {
  if (coefficients.length === 0) return [];
  const d = coefficients[0]?.length ?? 0;
  if (d === 0) return [];
  for (const coefficient of coefficients) {
    if (coefficient.length !== d || coefficient.some(row => row.length !== d || row.some(value => !Number.isFinite(value)))) {
      throw new RangeError("VAR coefficient blocks must be finite d by d matrices");
    }
  }

  const p = coefficients.length;
  const companion = zeros(d * p, d * p);
  for (let lag = 0; lag < p; lag++) {
    const block = coefficients[lag] ?? zeros(d, d);
    for (let row = 0; row < d; row++) {
      for (let column = 0; column < d; column++) {
        companion[row]![lag * d + column] = block[row]?.[column] ?? 0;
      }
    }
  }
  for (let blockRow = 1; blockRow < p; blockRow++) {
    for (let index = 0; index < d; index++) {
      companion[blockRow * d + index]![(blockRow - 1) * d + index] = 1;
    }
  }
  return companion;
}

export function spectralRadiusForVar(
  coefficients: number[][][],
  options: { tolerance?: number; maxIterations?: number } = {}
): SpectralRadiusDiagnostics {
  return realSpectralRadius(buildVarCompanionMatrix(coefficients), options);
}

/**
 * Real shifted-QR iteration to quasi-triangular form. Isolated 1x1 blocks are
 * real roots; isolated 2x2 blocks are solved analytically, including complex
 * conjugate roots. Non-convergence degrades to a labeled infinity-norm upper
 * bound instead of reporting an unsupported eigenvalue estimate.
 */
export function realSpectralRadius(
  matrix: number[][],
  options: { tolerance?: number; maxIterations?: number } = {}
): SpectralRadiusDiagnostics {
  const method = "real_shifted_qr_quasi_triangular" as const;
  if (!isSquareFinite(matrix)) throw new RangeError("spectral-radius input must be a finite square matrix");
  const n = matrix.length;
  if (options.tolerance !== undefined && (!Number.isFinite(options.tolerance) || options.tolerance <= 0)) {
    throw new RangeError("spectral-radius tolerance must be finite and positive");
  }
  if (options.maxIterations !== undefined && (!Number.isInteger(options.maxIterations) || options.maxIterations < 0 || options.maxIterations > 1_000_000)) {
    throw new RangeError("spectral-radius maxIterations must be an integer from 0 through 1000000");
  }
  const tolerance = Math.max(Number.EPSILON, options.tolerance ?? 1e-12);
  const maxIterations = options.maxIterations ?? Math.max(128, 128 * n);
  if (n === 0) {
    return {
      method,
      radius: 0,
      stabilityMargin: 1,
      radiusKind: "eigenvalue_modulus",
      converged: true,
      iterations: 0,
      maxIterations,
      tolerance,
      deflations: 0,
      unresolvedDimension: 0,
      residual: 0,
      singleShiftSteps: 0,
      doubleShiftSteps: 0,
      exceptionalShiftSteps: 0,
      blocks: [],
      eigenvalues: []
    };
  }

  const originalNorm = matrixInfinityNorm(matrix);
  const h = upperHessenberg(matrix);
  const blocks: RealSchurBlock[] = [];
  let high = n - 1;
  let iterations = 0;
  let deflations = 0;
  let singleShiftSteps = 0;
  let doubleShiftSteps = 0;
  let exceptionalShiftSteps = 0;
  let iterationsWithoutDeflation = 0;
  let deflationResidual = 0;

  while (high >= 0) {
    const activeNorm = matrixInfinityNorm(h.slice(0, high + 1).map(row => row.slice(0, high + 1)));
    for (let row = 1; row <= high; row++) {
      const subdiagonal = Math.abs(h[row]?.[row - 1] ?? 0);
      const localScale = Math.abs(h[row - 1]?.[row - 1] ?? 0) + Math.abs(h[row]?.[row] ?? 0) + activeNorm * Number.EPSILON;
      if (subdiagonal <= tolerance * Math.max(Number.MIN_VALUE, localScale)) {
        deflationResidual = Math.max(deflationResidual, subdiagonal);
        h[row]![row - 1] = 0;
      }
    }

    if (high === 0 || (h[high]?.[high - 1] ?? 0) === 0) {
      blocks.push(oneByOneBlock(high, h[high]?.[high] ?? 0));
      high--;
      deflations++;
      iterationsWithoutDeflation = 0;
      continue;
    }

    let low = high - 1;
    while (low > 0 && (h[low]?.[low - 1] ?? 0) !== 0) low--;
    const blockSize = high - low + 1;
    if (blockSize === 2) {
      blocks.push(twoByTwoBlock(low, h));
      high -= 2;
      deflations += 2;
      iterationsWithoutDeflation = 0;
      continue;
    }
    if (iterations >= maxIterations) break;

    const active = extractSquare(h, low, high);
    const trailing = trailingTwoByTwo(active);
    const discriminant = trailing.trace ** 2 - 4 * trailing.determinant;
    let next: number[][];
    if (iterationsWithoutDeflation > 0 && iterationsWithoutDeflation % 24 === 0) {
      const direction = (Math.floor(iterationsWithoutDeflation / 24) % 2 === 0 ? 1 : -1);
      const magnitude = Math.max(tolerance * Math.max(1, activeNorm), Math.abs(trailing.lowerLeft));
      next = singleShiftQrStep(active, trailing.bottomRight + direction * magnitude);
      singleShiftSteps++;
      exceptionalShiftSteps++;
    } else if (discriminant >= 0) {
      const root = Math.sqrt(discriminant);
      const first = (trailing.trace + root) / 2;
      const second = (trailing.trace - root) / 2;
      const shift = Math.abs(first - trailing.bottomRight) <= Math.abs(second - trailing.bottomRight) ? first : second;
      next = singleShiftQrStep(active, shift);
      singleShiftSteps++;
    } else {
      next = doubleShiftQrStep(active, trailing.trace, trailing.determinant);
      doubleShiftSteps++;
    }
    replaceSquare(h, low, next);
    cleanupHessenbergRoundoff(h, low, high);
    iterations++;
    iterationsWithoutDeflation++;
  }

  const converged = high < 0;
  const orderedBlocks = blocks.sort((a, b) => a.start - b.start);
  const eigenvalues = orderedBlocks.flatMap(block => block.eigenvalues);
  const extractedRadius = orderedBlocks.reduce((maximum, block) => Math.max(maximum, block.radius), 0);
  const unresolvedDimension = converged ? 0 : high + 1;
  const residual = converged ? deflationResidual : Math.max(deflationResidual, unresolvedSubdiagonalResidual(h, high));
  const radius = converged ? extractedRadius : Math.max(extractedRadius, originalNorm);
  return {
    method,
    radius,
    stabilityMargin: 1 - radius,
    radiusKind: converged ? "eigenvalue_modulus" : "matrix_infinity_norm_upper_bound",
    converged,
    iterations,
    maxIterations,
    tolerance,
    deflations,
    unresolvedDimension,
    residual,
    singleShiftSteps,
    doubleShiftSteps,
    exceptionalShiftSteps,
    blocks: orderedBlocks,
    eigenvalues,
    ...(converged ? {} : { reason: "qr_iteration_limit_reached" })
  };
}

/** Return Psi_0 through Psi_(h-1) for the VAR Wold representation. */
export function woldImpulseResponses(coefficients: number[][][], horizon: number, dimension?: number): number[][][] {
  const steps = validateHorizon(horizon);
  const d = dimension ?? coefficients[0]?.length ?? 0;
  if (d === 0) return [];
  validateCoefficientShape(coefficients, d);
  const impulse: number[][][] = [identity(d)];
  for (let step = 1; step < steps; step++) {
    let psi = zeros(d, d);
    for (let lag = 1; lag <= Math.min(step, coefficients.length); lag++) {
      psi = add(psi, matMul(coefficients[lag - 1] ?? zeros(d, d), impulse[step - lag] ?? zeros(d, d)));
    }
    impulse.push(psi);
  }
  return impulse;
}

/** Horizon-h error covariance using Psi_0 through Psi_(h-1), without scaling. */
export function woldForecastCovariance(
  coefficients: number[][][],
  innovationCovariance: number[][],
  horizon: number
): number[][] {
  const d = innovationCovariance.length;
  return woldCovarianceFromImpulse(woldImpulseResponses(coefficients, horizon, d), innovationCovariance);
}

function fitVar(series: number[][], order: number, commonEstimationStart: number): VarModel {
  const d = series[0]?.length ?? 0;
  const rows: number[][] = [];
  const y: number[][] = [];
  for (let t = commonEstimationStart; t < series.length; t++) {
    const row = [1];
    for (let lag = 1; lag <= order; lag++) row.push(...(series[t - lag] ?? new Array(d).fill(0)));
    rows.push(row);
    y.push(series[t] ?? new Array(d).fill(0));
  }
  if (rows.length === 0) return coldStartVar(series, order, "empty_estimation_window");

  const xtx = matMul(transpose(rows), rows);
  const ridgeScale = Math.max(1, mean(xtx.map((row, index) => Math.abs(row[index] ?? 0))));
  const beta = ridgeSolve(rows, y, 1e-10 * ridgeScale);
  const intercept = Array.from({ length: d }, (_, column) => beta[0]?.[column] ?? 0);
  const coefficients = Array.from({ length: order }, (_, lag) => {
    const block = zeros(d, d);
    for (let source = 0; source < d; source++) {
      const betaRow = beta[1 + lag * d + source] ?? [];
      for (let destination = 0; destination < d; destination++) {
        block[destination]![source] = betaRow[destination] ?? 0;
      }
    }
    return block;
  });
  const residuals = rows.map((row, index) => {
    const predicted = multiplyRow(row, beta);
    const actual = y[index] ?? new Array(d).fill(0);
    return actual.map((value, column) => value - (predicted[column] ?? 0));
  });
  const rawResidualCovariance = innovationCovarianceMle(residuals, d);
  const covarianceLogDet = adaptiveJitterCholeskyLogDet(rawResidualCovariance);
  const residualCovariance = covarianceLogDet.status === "failed"
    ? rawResidualCovariance
    : addDiagonal(rawResidualCovariance, covarianceLogDet.jitter);

  const likelihoodObservations = residuals.length;
  const regressionParameters = d * (1 + d * order);
  const innovationCovarianceParameters = d * (d + 1) / 2;
  const parameterCount = regressionParameters + innovationCovarianceParameters;
  const residualDegreesOfFreedom = likelihoodObservations - (1 + d * order);
  const negativeTwoLogLikelihood = covarianceLogDet.status === "failed"
    ? Number.POSITIVE_INFINITY
    : likelihoodObservations * (d * (1 + Math.log(2 * Math.PI)) + covarianceLogDet.logDet);
  const aic = negativeTwoLogLikelihood + 2 * parameterCount;
  return {
    order,
    intercept,
    coefficients,
    residualCovariance,
    aic,
    residuals,
    fitStatus: "fitted",
    aicDiagnostics: {
      criterion: "conditional_multivariate_gaussian_aic",
      formula: "negativeTwoLogLikelihood + 2 * parameterCount",
      likelihoodObservations,
      regressionParameters,
      innovationCovarianceParameters,
      parameterCount,
      residualDegreesOfFreedom,
      commonEstimationStart,
      covarianceLogDet
    }
  };
}

function coldStartVar(series: number[][], requestedOrder: number, reason: string): VarModel {
  const d = series[0]?.length ?? 0;
  const order = Math.max(1, Math.floor(requestedOrder));
  const deltas = series.slice(1).map((row, index) => row.map((value, column) => value - (series[index]?.[column] ?? 0)));
  const drift = Array.from({ length: d }, (_, column) => mean(deltas.map(row => row[column] ?? 0)));
  const residuals = deltas.map(row => row.map((value, column) => value - (drift[column] ?? 0)));
  const rawCovariance = residuals.length > 0 ? innovationCovarianceMle(residuals, d) : diagonalMatrix(d, 1e-6);
  const covarianceLogDet = adaptiveJitterCholeskyLogDet(rawCovariance);
  const residualCovariance = covarianceLogDet.status === "failed"
    ? diagonalMatrix(d, 1e-6)
    : addDiagonal(rawCovariance, covarianceLogDet.jitter);
  const regressionParameters = d * (1 + d * order);
  const innovationCovarianceParameters = d * (d + 1) / 2;
  return {
    order,
    intercept: drift,
    coefficients: Array.from({ length: order }, (_, lag) => lag === 0
      ? identity(d)
      : zeros(d, d)),
    residualCovariance,
    aic: Number.POSITIVE_INFINITY,
    residuals,
    fitStatus: "cold_start",
    fitReason: reason,
    aicDiagnostics: {
      criterion: "conditional_multivariate_gaussian_aic",
      formula: "negativeTwoLogLikelihood + 2 * parameterCount",
      likelihoodObservations: residuals.length,
      regressionParameters,
      innovationCovarianceParameters,
      parameterCount: regressionParameters + innovationCovarianceParameters,
      residualDegreesOfFreedom: 0,
      commonEstimationStart: 0,
      covarianceLogDet
    }
  };
}

function forecastMean(model: VarModel, tail: number[][], horizon: number): number[] {
  const d = model.intercept.length;
  const history = tail.length > 0 ? tail.map(row => [...row]) : [new Array(d).fill(0)];
  while (history.length < model.order) history.unshift(history[0] ?? new Array(d).fill(0));
  for (let step = 0; step < horizon; step++) {
    const next = [...model.intercept];
    for (let lag = 1; lag <= model.order; lag++) {
      const coefficient = model.coefficients[lag - 1] ?? zeros(d, d);
      const state = history[history.length - lag] ?? new Array(d).fill(0);
      const contribution = matVec(coefficient, state);
      for (let index = 0; index < d; index++) next[index] = (next[index] ?? 0) + (contribution[index] ?? 0);
    }
    ensureFiniteVector(next, `VAR mean at step ${step + 1}`);
    history.push(next);
  }
  return history[history.length - 1] ?? new Array(d).fill(0);
}

function woldCovarianceFromImpulse(impulse: number[][][], innovationCovariance: number[][]): number[][] {
  const d = innovationCovariance.length;
  if (d === 0) return [];
  if (!isSquareFinite(innovationCovariance) || innovationCovariance.length !== d) {
    throw new RangeError("innovation covariance must be a finite square matrix");
  }
  let result = zeros(d, d);
  for (const psi of impulse) result = add(result, matMul(matMul(psi, innovationCovariance), transpose(psi)));
  return symmetrize(result);
}

function innovationCovarianceMle(residuals: number[][], dimension: number): number[][] {
  if (dimension === 0) return [];
  if (residuals.length === 0) return zeros(dimension, dimension);
  const result = zeros(dimension, dimension);
  for (const residual of residuals) {
    for (let row = 0; row < dimension; row++) {
      for (let column = 0; column < dimension; column++) {
        result[row]![column] = (result[row]?.[column] ?? 0) + (residual[row] ?? 0) * (residual[column] ?? 0);
      }
    }
  }
  return result.map(row => row.map(value => value / residuals.length));
}

function ridgeSolve(x: number[][], y: number[][], lambda: number): number[][] {
  const xt = transpose(x);
  const xtx = matMul(xt, x);
  for (let index = 0; index < xtx.length; index++) xtx[index]![index] = (xtx[index]?.[index] ?? 0) + lambda;
  return solveLinearSystem(xtx, matMul(xt, y));
}

function solveLinearSystem(a: number[][], b: number[][]): number[][] {
  const n = a.length;
  const columns = b[0]?.length ?? 0;
  const augmented = a.map((row, index) => [...row, ...(b[index] ?? new Array(columns).fill(0))]);
  for (let column = 0; column < n; column++) {
    let pivot = column;
    for (let row = column + 1; row < n; row++) {
      if (Math.abs(augmented[row]?.[column] ?? 0) > Math.abs(augmented[pivot]?.[column] ?? 0)) pivot = row;
    }
    [augmented[column], augmented[pivot]] = [augmented[pivot] ?? [], augmented[column] ?? []];
    const denominator = augmented[column]?.[column] ?? 0;
    if (Math.abs(denominator) < Number.EPSILON) continue;
    for (let index = column; index < n + columns; index++) {
      augmented[column]![index] = (augmented[column]?.[index] ?? 0) / denominator;
    }
    for (let row = 0; row < n; row++) {
      if (row === column) continue;
      const factor = augmented[row]?.[column] ?? 0;
      for (let index = column; index < n + columns; index++) {
        augmented[row]![index] = (augmented[row]?.[index] ?? 0) - factor * (augmented[column]?.[index] ?? 0);
      }
    }
  }
  return augmented.map(row => row.slice(n, n + columns));
}

function singleShiftQrStep(matrix: number[][], shift: number): number[][] {
  const shifted = matrix.map((row, index) => row.map((value, column) => value - (index === column ? shift : 0)));
  const { q, r } = householderQr(shifted);
  const next = matMul(r, q);
  for (let index = 0; index < next.length; index++) next[index]![index] = (next[index]?.[index] ?? 0) + shift;
  return next;
}

function doubleShiftQrStep(matrix: number[][], trace: number, determinant: number): number[][] {
  const squared = matMul(matrix, matrix);
  const polynomial = squared.map((row, index) => row.map((value, column) =>
    value - trace * (matrix[index]?.[column] ?? 0) + (index === column ? determinant : 0)
  ));
  const { q } = householderQr(polynomial);
  return matMul(matMul(transpose(q), matrix), q);
}

function householderQr(matrix: number[][]): { q: number[][]; r: number[][] } {
  const n = matrix.length;
  const q = identity(n);
  const r = matrix.map(row => [...row]);
  for (let column = 0; column < n; column++) {
    const vector = Array.from({ length: n - column }, (_, offset) => r[column + offset]?.[column] ?? 0);
    const norm = Math.hypot(...vector);
    if (norm === 0) continue;
    vector[0] = (vector[0] ?? 0) + ((vector[0] ?? 0) >= 0 ? norm : -norm);
    const vectorNorm = Math.hypot(...vector);
    if (vectorNorm === 0) continue;
    for (let index = 0; index < vector.length; index++) vector[index] = (vector[index] ?? 0) / vectorNorm;

    for (let targetColumn = column; targetColumn < n; targetColumn++) {
      let projection = 0;
      for (let index = 0; index < vector.length; index++) {
        projection += (vector[index] ?? 0) * (r[column + index]?.[targetColumn] ?? 0);
      }
      for (let index = 0; index < vector.length; index++) {
        r[column + index]![targetColumn] = (r[column + index]?.[targetColumn] ?? 0) - 2 * (vector[index] ?? 0) * projection;
      }
    }
    for (let row = 0; row < n; row++) {
      let projection = 0;
      for (let index = 0; index < vector.length; index++) projection += (q[row]?.[column + index] ?? 0) * (vector[index] ?? 0);
      for (let index = 0; index < vector.length; index++) {
        q[row]![column + index] = (q[row]?.[column + index] ?? 0) - 2 * projection * (vector[index] ?? 0);
      }
    }
  }
  return { q, r };
}

function upperHessenberg(matrix: number[][]): number[][] {
  const n = matrix.length;
  const result = matrix.map(row => [...row]);
  for (let column = 0; column < n - 2; column++) {
    const vector = Array.from({ length: n - column - 1 }, (_, offset) => result[column + 1 + offset]?.[column] ?? 0);
    const norm = Math.hypot(...vector);
    if (norm === 0) continue;
    vector[0] = (vector[0] ?? 0) + ((vector[0] ?? 0) >= 0 ? norm : -norm);
    const vectorNorm = Math.hypot(...vector);
    if (vectorNorm === 0) continue;
    for (let index = 0; index < vector.length; index++) vector[index] = (vector[index] ?? 0) / vectorNorm;

    for (let targetColumn = column; targetColumn < n; targetColumn++) {
      let projection = 0;
      for (let index = 0; index < vector.length; index++) {
        projection += (vector[index] ?? 0) * (result[column + 1 + index]?.[targetColumn] ?? 0);
      }
      for (let index = 0; index < vector.length; index++) {
        result[column + 1 + index]![targetColumn] = (result[column + 1 + index]?.[targetColumn] ?? 0) - 2 * (vector[index] ?? 0) * projection;
      }
    }
    for (let row = 0; row < n; row++) {
      let projection = 0;
      for (let index = 0; index < vector.length; index++) {
        projection += (result[row]?.[column + 1 + index] ?? 0) * (vector[index] ?? 0);
      }
      for (let index = 0; index < vector.length; index++) {
        result[row]![column + 1 + index] = (result[row]?.[column + 1 + index] ?? 0) - 2 * projection * (vector[index] ?? 0);
      }
    }
    for (let row = column + 2; row < n; row++) result[row]![column] = 0;
  }
  return result;
}

function oneByOneBlock(start: number, value: number): RealSchurBlock {
  return { start, size: 1, eigenvalues: [{ real: value, imaginary: 0 }], radius: Math.abs(value) };
}

function twoByTwoBlock(start: number, matrix: number[][]): RealSchurBlock {
  const a = matrix[start]?.[start] ?? 0;
  const b = matrix[start]?.[start + 1] ?? 0;
  const c = matrix[start + 1]?.[start] ?? 0;
  const d = matrix[start + 1]?.[start + 1] ?? 0;
  const trace = a + d;
  const determinant = a * d - b * c;
  const discriminant = trace ** 2 - 4 * determinant;
  const discriminantScale = Math.abs(trace ** 2) + Math.abs(4 * determinant) + 1;
  let eigenvalues: RealEigenvalue[];
  if (discriminant >= -64 * Number.EPSILON * discriminantScale) {
    const root = Math.sqrt(Math.max(0, discriminant));
    eigenvalues = [
      { real: (trace + root) / 2, imaginary: 0 },
      { real: (trace - root) / 2, imaginary: 0 }
    ];
  } else {
    const real = trace / 2;
    const imaginary = Math.sqrt(-discriminant) / 2;
    eigenvalues = [{ real, imaginary }, { real, imaginary: -imaginary }];
  }
  const radius = eigenvalues.reduce((maximum, value) => Math.max(maximum, Math.hypot(value.real, value.imaginary)), 0);
  return { start, size: 2, eigenvalues, radius };
}

function trailingTwoByTwo(matrix: number[][]): { trace: number; determinant: number; bottomRight: number; lowerLeft: number } {
  const n = matrix.length;
  const a = matrix[n - 2]?.[n - 2] ?? 0;
  const b = matrix[n - 2]?.[n - 1] ?? 0;
  const c = matrix[n - 1]?.[n - 2] ?? 0;
  const d = matrix[n - 1]?.[n - 1] ?? 0;
  return { trace: a + d, determinant: a * d - b * c, bottomRight: d, lowerLeft: c };
}

function cleanupHessenbergRoundoff(matrix: number[][], low: number, high: number): void {
  for (let row = low + 2; row <= high; row++) {
    for (let column = low; column < row - 1; column++) matrix[row]![column] = 0;
  }
}

function unresolvedSubdiagonalResidual(matrix: number[][], high: number): number {
  let residual = 0;
  for (let row = 1; row <= high; row++) residual = Math.max(residual, Math.abs(matrix[row]?.[row - 1] ?? 0));
  return residual;
}

function extractSquare(matrix: number[][], low: number, high: number): number[][] {
  return Array.from({ length: high - low + 1 }, (_, row) =>
    Array.from({ length: high - low + 1 }, (_, column) => matrix[low + row]?.[low + column] ?? 0)
  );
}

function replaceSquare(matrix: number[][], low: number, replacement: number[][]): void {
  for (let row = 0; row < replacement.length; row++) {
    for (let column = 0; column < replacement.length; column++) {
      matrix[low + row]![low + column] = replacement[row]?.[column] ?? 0;
    }
  }
}

function choleskyDiagonal(matrix: number[][], jitter: number): number[] | undefined {
  const n = matrix.length;
  const factor = zeros(n, n);
  const diagonal: number[] = [];
  for (let row = 0; row < n; row++) {
    for (let column = 0; column <= row; column++) {
      let value = matrix[row]?.[column] ?? 0;
      if (row === column) value += jitter;
      for (let inner = 0; inner < column; inner++) value -= (factor[row]?.[inner] ?? 0) * (factor[column]?.[inner] ?? 0);
      if (row === column) {
        if (!(value > 0) || !Number.isFinite(value)) return undefined;
        factor[row]![column] = Math.sqrt(value);
        diagonal.push(factor[row]?.[column] ?? 0);
      } else {
        const denominator = factor[column]?.[column] ?? 0;
        if (!(denominator > 0)) return undefined;
        factor[row]![column] = value / denominator;
      }
    }
  }
  return diagonal;
}

function maxSymmetryCorrection(matrix: number[][]): number {
  let correction = 0;
  for (let row = 0; row < matrix.length; row++) {
    for (let column = row + 1; column < matrix.length; column++) {
      correction = Math.max(correction, Math.abs((matrix[row]?.[column] ?? 0) - (matrix[column]?.[row] ?? 0)) / 2);
    }
  }
  return correction;
}

function symmetrize(matrix: number[][]): number[][] {
  return matrix.map((row, rowIndex) => row.map((value, columnIndex) =>
    rowIndex === columnIndex ? value : (value + (matrix[columnIndex]?.[rowIndex] ?? 0)) / 2
  ));
}

function addDiagonal(matrix: number[][], amount: number): number[][] {
  return matrix.map((row, rowIndex) => row.map((value, columnIndex) => value + (rowIndex === columnIndex ? amount : 0)));
}

function diagonalMatrix(dimension: number, value: number): number[][] {
  const result = zeros(dimension, dimension);
  for (let index = 0; index < dimension; index++) result[index]![index] = value;
  return result;
}

function matrixInfinityNorm(matrix: number[][]): number {
  return matrix.reduce((maximum, row) => Math.max(maximum, row.reduce((sum, value) => sum + Math.abs(value), 0)), 0);
}

function isSquareFinite(matrix: number[][]): boolean {
  return matrix.every(row => row.length === matrix.length && row.every(Number.isFinite));
}

function validateCoefficientShape(coefficients: number[][][], dimension: number): void {
  for (const coefficient of coefficients) {
    if (coefficient.length !== dimension || coefficient.some(row => row.length !== dimension || row.some(value => !Number.isFinite(value)))) {
      throw new RangeError("VAR coefficient blocks must match the forecast dimension and be finite");
    }
  }
}

function validateHorizon(horizon: number): number {
  if (!Number.isInteger(horizon) || horizon < 1 || horizon > MAX_FORECAST_HORIZON) {
    throw new RangeError(`forecast horizon must be an integer from 1 through ${MAX_FORECAST_HORIZON}`);
  }
  return horizon;
}

function ensureFiniteVector(vector: number[], label: string): void {
  if (vector.some(value => !Number.isFinite(value))) throw new RangeError(`${label} exceeded finite numeric bounds`);
}

function ensureFiniteMatrix(matrix: number[][], label: string): void {
  if (matrix.some(row => row.some(value => !Number.isFinite(value)))) throw new RangeError(`${label} exceeded finite numeric bounds`);
}

function multiplyRow(row: number[], matrix: number[][]): number[] {
  const columns = matrix[0]?.length ?? 0;
  const result = new Array<number>(columns).fill(0);
  for (let column = 0; column < columns; column++) {
    for (let index = 0; index < row.length; index++) {
      result[column] = (result[column] ?? 0) + (row[index] ?? 0) * (matrix[index]?.[column] ?? 0);
    }
  }
  return result;
}

function matVec(matrix: number[][], vector: number[]): number[] {
  return matrix.map(row => row.reduce((sum, value, index) => sum + value * (vector[index] ?? 0), 0));
}

function add(a: number[][], b: number[][]): number[][] {
  return a.map((row, rowIndex) => row.map((value, columnIndex) => value + (b[rowIndex]?.[columnIndex] ?? 0)));
}
