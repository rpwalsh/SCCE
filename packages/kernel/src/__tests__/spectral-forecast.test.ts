import { describe, expect, it } from "vitest";
import type { IdFactory } from "../ids.js";
import { createPredictionLayer } from "../prediction.js";
import {
  adaptiveJitterCholeskyLogDet,
  buildVarCompanionMatrix,
  fitVarByAic,
  forecastFromVarModel,
  realSpectralRadius,
  spectralRadiusForVar,
  woldForecastCovariance,
  type VarModel
} from "../spectral-forecast.js";
import type { ForecastState } from "../types.js";

describe("spectral forecast numerical contract", () => {
  it("uses the correlated covariance determinant rather than a diagonal product", () => {
    const covariance = [
      [4, 1.5],
      [1.5, 1]
    ];
    const result = adaptiveJitterCholeskyLogDet(covariance);

    expect(result.status).toBe("exact");
    expect(result.jitter).toBe(0);
    expect(result.logDet).toBeCloseTo(Math.log(1.75), 12);
    expect(result.logDet).not.toBeCloseTo(Math.log(4), 4);
  });

  it("regularizes singular covariance adaptively and reports hard failure explicitly", () => {
    const singular = adaptiveJitterCholeskyLogDet([
      [1, 1],
      [1, 1]
    ]);
    expect(singular.status).toBe("regularized");
    expect(singular.jitter).toBeGreaterThan(0);
    expect(Number.isFinite(singular.logDet)).toBe(true);

    const failed = adaptiveJitterCholeskyLogDet([[Number.NaN]]);
    expect(failed.status).toBe("failed");
    expect(failed.reason).toBe("matrix_must_be_square_and_finite");
    expect(failed.logDet).toBe(Number.POSITIVE_INFINITY);
  });

  it("documents and applies the full VAR AIC parameter count", () => {
    const series: number[][] = [];
    let x = 0;
    let y = 0;
    for (let step = 0; step < 80; step++) {
      const priorX = x;
      const innovationX = 0.08 * Math.sin(step * 1.7) + 0.03 * Math.cos(step * 0.37);
      const innovationY = 0.04 * Math.sin(step * 0.61) - 0.02 * Math.cos(step * 1.13);
      x = 0.45 * x + innovationX;
      y = 0.25 * y + 0.15 * priorX + 0.55 * innovationX + innovationY;
      series.push([x, y]);
    }

    const model = fitVarByAic(series, 2);
    const expectedRegressionParameters = 2 * (1 + 2 * model.order);
    const expectedCovarianceParameters = 2 * 3 / 2;
    expect(model.fitStatus).toBe("fitted");
    expect(model.aicDiagnostics.criterion).toBe("conditional_multivariate_gaussian_aic");
    expect(model.aicDiagnostics.regressionParameters).toBe(expectedRegressionParameters);
    expect(model.aicDiagnostics.innovationCovarianceParameters).toBe(expectedCovarianceParameters);
    expect(model.aicDiagnostics.parameterCount).toBe(expectedRegressionParameters + expectedCovarianceParameters);
    expect(model.aicDiagnostics.likelihoodObservations).toBe(78);
    expect(Number.isFinite(model.aic)).toBe(true);
  });

  it("requires enough residual degrees of freedom for a full-rank innovation covariance", () => {
    const dimension = 9;
    const series = Array.from({ length: 32 }, (_, step) => Array.from(
      { length: dimension },
      (_, column) => Math.sin((step + 1) * (column + 1) * 0.13) + 0.01 * step * (column + 1)
    ));

    const model = fitVarByAic(series, 3);

    expect(model.fitStatus).toBe("fitted");
    expect(model.order).toBeLessThanOrEqual(2);
    expect(model.aicDiagnostics.residualDegreesOfFreedom).toBeGreaterThanOrEqual(dimension);
  });

  it("builds the full VAR(2) companion matrix and finds A2-driven instability", () => {
    const coefficients = [[[0.5]], [[0.8]]];
    expect(buildVarCompanionMatrix(coefficients)).toEqual([
      [0.5, 0.8],
      [1, 0]
    ]);

    const result = spectralRadiusForVar(coefficients);
    const independentRadius = (0.5 + Math.sqrt(0.5 ** 2 + 4 * 0.8)) / 2;
    expect(result.converged).toBe(true);
    expect(result.radiusKind).toBe("eigenvalue_modulus");
    expect(result.radius).toBeCloseTo(independentRadius, 12);
    expect(result.radius).toBeGreaterThan(1);
    expect(result.stabilityMargin).toBeCloseTo(1 - result.radius, 12);
  });

  it("recognizes a stable VAR(2) and complex-conjugate companion roots", () => {
    const stable = spectralRadiusForVar([[[0.4]], [[0.2]]]);
    const stableReference = (0.4 + Math.sqrt(0.4 ** 2 + 4 * 0.2)) / 2;
    expect(stable.converged).toBe(true);
    expect(stable.radius).toBeCloseTo(stableReference, 12);
    expect(stable.radius).toBeLessThan(1);

    const complex = realSpectralRadius([
      [0, -0.81],
      [1, 0]
    ]);
    expect(complex.converged).toBe(true);
    expect(complex.radius).toBeCloseTo(0.9, 12);
    expect(complex.blocks).toHaveLength(1);
    expect(complex.blocks[0]?.size).toBe(2);
    expect(Math.abs(complex.eigenvalues[0]?.imaginary ?? 0)).toBeCloseTo(0.9, 12);
    expect(Math.abs(complex.eigenvalues[1]?.imaginary ?? 0)).toBeCloseTo(0.9, 12);
  });

  it("handles isolated 1x1 and complex 2x2 real-Schur blocks with diagnostics", () => {
    const result = realSpectralRadius([
      [0, -0.81, 0],
      [1, 0, 0],
      [0, 0, 1.1]
    ]);
    expect(result.converged).toBe(true);
    expect(result.deflations).toBe(3);
    expect(result.unresolvedDimension).toBe(0);
    expect(result.radius).toBeCloseTo(1.1, 12);
    expect(result.blocks.map(block => block.size)).toEqual([2, 1]);
  });

  it("converges a coupled 4x4 companion form to real and complex blocks", () => {
    const result = spectralRadiusForVar([
      [[0.4, 0], [0, 0]],
      [[0.2, 0], [0, -0.81]]
    ]);
    expect(result.converged).toBe(true);
    expect(result.unresolvedDimension).toBe(0);
    expect(result.radius).toBeCloseTo(0.9, 10);
    expect(result.iterations).toBeGreaterThan(0);
    expect(result.eigenvalues.some(value => Math.abs(value.imaginary) > 0.89)).toBe(true);
  });

  it("reports near-unit roots without an inverse-gap explosion", () => {
    const result = realSpectralRadius([[0.9999995]]);
    expect(result.converged).toBe(true);
    expect(result.radius).toBeCloseTo(0.9999995, 12);
    expect(result.iterations).toBe(0);
    expect(Number.isFinite(result.radius)).toBe(true);
  });

  it("labels a QR iteration-limit result as an upper bound", () => {
    const result = realSpectralRadius([
      [0, 0, 1],
      [1, 0, 0],
      [0, 1, 0]
    ], { maxIterations: 0 });
    expect(result.converged).toBe(false);
    expect(result.radiusKind).toBe("matrix_infinity_norm_upper_bound");
    expect(result.reason).toBe("qr_iteration_limit_reached");
    expect(result.unresolvedDimension).toBe(3);
    expect(result.radius).toBe(1);
  });

  it("rejects non-finite or unbounded QR controls", () => {
    const rotation = [[0, -2], [2, 0]];
    expect(() => realSpectralRadius(rotation, { tolerance: Number.POSITIVE_INFINITY })).toThrow(/tolerance must be finite and positive/u);
    expect(() => realSpectralRadius(rotation, { tolerance: Number.NaN })).toThrow(/tolerance must be finite and positive/u);
    expect(() => realSpectralRadius(rotation, { maxIterations: Number.NaN })).toThrow(/maxIterations must be an integer/u);
    expect(() => realSpectralRadius(rotation, { maxIterations: 1_000_001 })).toThrow(/maxIterations must be an integer/u);
  });

  it("uses Psi_0 through Psi_(h-1) for horizon-specific Wold covariance", () => {
    const coefficients = [[[0.5]]];
    const innovationCovariance = [[4]];
    expect(woldForecastCovariance(coefficients, innovationCovariance, 1)[0]?.[0]).toBeCloseTo(4, 12);
    expect(woldForecastCovariance(coefficients, innovationCovariance, 2)[0]?.[0]).toBeCloseTo(5, 12);
    expect(woldForecastCovariance(coefficients, innovationCovariance, 3)[0]?.[0]).toBeCloseTo(5.25, 12);
  });

  it("uses a coherent random-walk-with-drift cold start independent of the level offset", () => {
    const low = fitVarByAic([[0], [1], [2]], 3);
    const high = fitVarByAic([[100], [101], [102]], 3);
    const lowForecast = forecastFromVarModel({ model: low, history: [[0], [1], [2]], horizon: 1 });
    const highForecast = forecastFromVarModel({ model: high, history: [[100], [101], [102]], horizon: 1 });

    expect(low.fitStatus).toBe("cold_start");
    expect(high.fitStatus).toBe("cold_start");
    expect(low.coefficients[0]).toEqual([[1]]);
    expect(high.coefficients[0]).toEqual([[1]]);
    expect(lowForecast.mean[0]).toBeCloseTo(3, 12);
    expect(highForecast.mean[0]).toBeCloseTo(103, 12);
    expect(highForecast.mean[0]! - lowForecast.mean[0]!).toBeCloseTo(100, 12);
    expect(high.residuals.flat().every(value => Math.abs(value) < 1e-12)).toBe(true);
  });

  it("does not shrink or inflate innovation variance and widens only through Wold propagation", () => {
    const stableModel = fixtureModel([[[0.5]]], [[4]]);
    const unstableModel = fixtureModel([[[1.2]]], [[4]]);
    const stableOne = forecastFromVarModel({ model: stableModel, history: [[2]], horizon: 1 });
    const unstableOne = forecastFromVarModel({ model: unstableModel, history: [[2]], horizon: 1 });
    const stableThree = forecastFromVarModel({ model: stableModel, history: [[2]], horizon: 3 });

    expect(stableOne.covariance[0]?.[0]).toBeCloseTo(4, 12);
    expect(unstableOne.covariance[0]?.[0]).toBeCloseTo(4, 12);
    expect(stableOne.interval[0]?.sigma).toBeCloseTo(2, 12);
    expect(unstableOne.interval[0]?.sigma).toBeCloseTo(2, 12);
    expect(stableOne.varianceScale).toBe(1);
    expect(unstableOne.varianceScale).toBe(1);
    expect(stableThree.covariance[0]?.[0]).toBeCloseTo(5.25, 12);
    expect((stableThree.interval[0]?.high ?? 0) - (stableThree.interval[0]?.low ?? 0))
      .toBeGreaterThan((stableOne.interval[0]?.high ?? 0) - (stableOne.interval[0]?.low ?? 0));
    expect(stableThree.horizonSemantics).toMatchObject({
      steps: 3,
      meanAtStep: 3,
      covarianceImpulseFrom: 0,
      covarianceImpulseThrough: 2
    });
  });

  it("publishes truthful forecast audit labels and preserves an unclamped state dimension", () => {
    const layer = createPredictionLayer({
      idFactory: {
        forecastEnvelopeId: () => "forecast.fixture"
      } as unknown as IdFactory
    });
    const source = {
      id: "state.fixture",
      t: 1,
      stateVector: [2],
      spectrum: { nodes: [], values: [] }
    } as unknown as ForecastState;
    const envelope = layer.forecast({ states: [], source, horizon: 1, createdAt: 2 });
    const audit = JSON.stringify(envelope.audit);

    expect(envelope.mean[0]).toBeCloseTo(2, 12);
    expect(audit).toContain("horizon-specific Wold covariance");
    expect(audit).toContain("random-walk-with-drift cold start");
    expect(audit).toContain("h_step_ahead_end_state");
    expect(audit).toContain("real_shifted_qr_quasi_triangular");
    expect(audit).not.toContain("Davis-Kahan");
    expect(audit).not.toContain("SGW");
    expect(audit).not.toContain("gapPenalty");
  });

  it("orders history chronologically and excludes duplicate or future source states", () => {
    const layer = createPredictionLayer({
      idFactory: { forecastEnvelopeId: () => "forecast.ordered" } as unknown as IdFactory
    });
    const state = (id: string, t: number, stateVector: number[]) => ({
      id,
      episodeId: "episode.fixture",
      t,
      stateVector,
      spectrum: { nodes: [], values: [] }
    } as unknown as ForecastState);
    const source = state("state.source", 4, [4, 40]);
    const history = [
      state("state.three", 3, [3, 30]),
      state("state.one", 1, [1, 10]),
      state("state.two", 2, [2, 20]),
      state("state.two-copy", 2, [2, 20]),
      state("state.source", 0, [500, 5_000]),
      state("state.same-time", 4, [600, 6_000]),
      state("state.future", 5, [700, 7_000])
    ];

    const envelope = layer.forecast({ states: history, source, horizon: 1, createdAt: 5 });

    expect(envelope.mean[0]).toBeCloseTo(5, 12);
    expect(envelope.mean[1]).toBeCloseTo(50, 12);
  });
});

function fixtureModel(coefficients: number[][][], residualCovariance: number[][]): VarModel {
  const dimension = residualCovariance.length;
  const order = coefficients.length;
  const covarianceLogDet = adaptiveJitterCholeskyLogDet(residualCovariance);
  const regressionParameters = dimension * (1 + dimension * order);
  const innovationCovarianceParameters = dimension * (dimension + 1) / 2;
  return {
    order,
    intercept: new Array(dimension).fill(0),
    coefficients,
    residualCovariance,
    aic: 0,
    residuals: [],
    fitStatus: "fitted",
    aicDiagnostics: {
      criterion: "conditional_multivariate_gaussian_aic",
      formula: "negativeTwoLogLikelihood + 2 * parameterCount",
      likelihoodObservations: 32,
      regressionParameters,
      innovationCovarianceParameters,
      parameterCount: regressionParameters + innovationCovarianceParameters,
      residualDegreesOfFreedom: 30,
      commonEstimationStart: order,
      covarianceLogDet
    }
  };
}
