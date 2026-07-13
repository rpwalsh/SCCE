import { clamp01, mean } from "./primitives.js";
import type { MatrixSnapshot } from "./types.js";

export function zeros(rows: number, cols: number): number[][] {
  return Array.from({ length: rows }, () => new Array<number>(cols).fill(0));
}

export function identity(n: number): number[][] {
  const out = zeros(n, n);
  for (let i = 0; i < n; i++) out[i]![i] = 1;
  return out;
}

export function transpose(matrix: number[][]): number[][] {
  if (matrix.length === 0) return [];
  const rows = matrix.length;
  const cols = matrix[0]?.length ?? 0;
  const out = zeros(cols, rows);
  for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) out[c]![r] = matrix[r]![c] ?? 0;
  return out;
}

export function multiply(a: number[][], b: number[][]): number[][] {
  const rows = a.length;
  const cols = b[0]?.length ?? 0;
  const mid = b.length;
  const out = zeros(rows, cols);
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      let sum = 0;
      for (let k = 0; k < mid; k++) sum += (a[r]![k] ?? 0) * (b[k]![c] ?? 0);
      out[r]![c] = sum;
    }
  }
  return out;
}

export function multiplyVector(matrix: number[][], vector: readonly number[]): number[] {
  return matrix.map(row => row.reduce((sum, value, index) => sum + value * (vector[index] ?? 0), 0));
}

export function addMatrix(a: number[][], b: number[][]): number[][] {
  return a.map((row, r) => row.map((value, c) => value + (b[r]?.[c] ?? 0)));
}

export function scaleMatrix(a: number[][], scale: number): number[][] {
  return a.map(row => row.map(value => value * scale));
}

export function covariance(samples: readonly number[][]): number[][] {
  if (samples.length === 0) return [];
  const d = samples[0]?.length ?? 0;
  const mus = Array.from({ length: d }, (_, i) => mean(samples.map(row => row[i] ?? 0)));
  const out = zeros(d, d);
  for (const row of samples) {
    for (let i = 0; i < d; i++) {
      for (let j = 0; j < d; j++) out[i]![j] = (out[i]![j] ?? 0) + ((row[i] ?? 0) - (mus[i] ?? 0)) * ((row[j] ?? 0) - (mus[j] ?? 0));
    }
  }
  const div = Math.max(1, samples.length - 1);
  return out.map(row => row.map(value => value / div));
}

export function laplacian(nodes: string[], weightedEdges: Array<{ source: string; target: string; weight: number }>): {
  adjacency: MatrixSnapshot;
  laplacian: MatrixSnapshot;
  normalizedLaplacian: MatrixSnapshot;
} {
  const index = new Map(nodes.map((id, i) => [id, i]));
  const n = nodes.length;
  const a = zeros(n, n);
  for (const edge of weightedEdges) {
    const i = index.get(edge.source);
    const j = index.get(edge.target);
    if (i === undefined || j === undefined || i === j) continue;
    const w = clamp01(edge.weight);
    a[i]![j] = (a[i]![j] ?? 0) + w;
    a[j]![i] = (a[j]![i] ?? 0) + w;
  }
  const d = a.map(row => row.reduce((sum, value) => sum + value, 0));
  const l = zeros(n, n);
  const nl = zeros(n, n);
  for (let i = 0; i < n; i++) {
    l[i]![i] = d[i] ?? 0;
    nl[i]![i] = d[i] ? 1 : 0;
    for (let j = 0; j < n; j++) {
      if (i === j) continue;
      const adjacency = a[i]![j] ?? 0;
      l[i]![j] = -adjacency;
      if ((d[i] ?? 0) > 0 && (d[j] ?? 0) > 0) nl[i]![j] = -adjacency / Math.sqrt((d[i] ?? 1) * (d[j] ?? 1));
    }
  }
  return {
    adjacency: { nodes, values: a },
    laplacian: { nodes, values: l },
    normalizedLaplacian: { nodes, values: nl }
  };
}

export function jacobiEigenvaluesSymmetric(input: number[][], maxIter = 80): number[] {
  const n = input.length;
  if (n === 0) return [];
  const a = input.map(row => row.slice(0, n));
  for (let iter = 0; iter < maxIter; iter++) {
    let p = 0;
    let q = 1;
    let max = 0;
    for (let i = 0; i < n; i++) {
      for (let j = i + 1; j < n; j++) {
        const v = Math.abs(a[i]![j] ?? 0);
        if (v > max) {
          max = v;
          p = i;
          q = j;
        }
      }
    }
    if (max < 1e-10) break;
    const app = a[p]![p] ?? 0;
    const aqq = a[q]![q] ?? 0;
    const apq = a[p]![q] ?? 0;
    const phi = 0.5 * Math.atan2(2 * apq, aqq - app);
    const c = Math.cos(phi);
    const s = Math.sin(phi);
    for (let k = 0; k < n; k++) {
      const aik = a[p]![k] ?? 0;
      const aqk = a[q]![k] ?? 0;
      a[p]![k] = c * aik - s * aqk;
      a[q]![k] = s * aik + c * aqk;
    }
    for (let k = 0; k < n; k++) {
      const akp = a[k]![p] ?? 0;
      const akq = a[k]![q] ?? 0;
      a[k]![p] = c * akp - s * akq;
      a[k]![q] = s * akp + c * akq;
    }
  }
  return a.map((row, i) => row[i] ?? 0).sort((x, y) => x - y);
}

export interface TransitionSpectralGapAssessment {
  available: boolean;
  spectralGap: number;
  eigenvalues: number[];
  stationaryDistribution: number[];
  assumptions: {
    square: boolean;
    rowStochastic: boolean;
    irreducible: boolean;
    aperiodic: boolean;
    reversible: boolean;
  };
  reason: "available" | "not_square" | "not_row_stochastic" | "not_irreducible" | "not_aperiodic" | "not_reversible";
}

/**
 * Assess the absolute spectral gap used by reversible-chain mixing bounds.
 *
 * A directed transition matrix is never silently symmetrized. We first verify
 * row stochasticity, irreducibility, aperiodicity, and detailed balance. Only
 * then is the reversible discriminant projected to numerical symmetry for the
 * symmetric Jacobi eigensolver.
 */
export function assessTransitionSpectralGap(transition: readonly (readonly number[])[]): TransitionSpectralGapAssessment {
  const size = transition.length;
  const square = size > 0 && transition.every(row => row.length === size);
  const rowStochastic = square && transition.every(row =>
    row.every(value => Number.isFinite(value) && value >= -1e-12) &&
    Math.abs(row.reduce((sum, value) => sum + value, 0) - 1) <= 1e-9
  );
  const irreducible = rowStochastic && stronglyConnectedTransition(transition);
  const aperiodic = irreducible && transitionPeriod(transition) === 1;
  const stationaryDistribution = rowStochastic ? stationaryDistributionForTransition(transition) : [];
  const reversible = irreducible && stationaryDistribution.length === size && detailedBalanceHolds(transition, stationaryDistribution);
  const assumptions = { square, rowStochastic, irreducible, aperiodic, reversible };
  const unavailable = (reason: TransitionSpectralGapAssessment["reason"]): TransitionSpectralGapAssessment => ({
    available: false,
    spectralGap: 0,
    eigenvalues: [],
    stationaryDistribution,
    assumptions,
    reason
  });
  if (!square) return unavailable("not_square");
  if (!rowStochastic) return unavailable("not_row_stochastic");
  if (!irreducible) return unavailable("not_irreducible");
  if (!aperiodic) return unavailable("not_aperiodic");
  if (!reversible) return unavailable("not_reversible");
  if (size === 1) {
    return { available: true, spectralGap: 1, eigenvalues: [1], stationaryDistribution: [1], assumptions, reason: "available" };
  }

  const discriminant = transition.map((row, i) => row.map((value, j) =>
    value * Math.sqrt((stationaryDistribution[i] ?? 0) / (stationaryDistribution[j] ?? 1))
  ));
  // Detailed balance established symmetry above; averaging only removes
  // floating-point residuals before invoking a symmetric eigensolver.
  const symmetricDiscriminant = discriminant.map((row, i) =>
    row.map((value, j) => 0.5 * (value + (discriminant[j]?.[i] ?? value)))
  );
  const eigenvalues = jacobiEigenvaluesSymmetric(symmetricDiscriminant, 120).sort((left, right) => Math.abs(right) - Math.abs(left));
  const secondMagnitude = Math.abs(eigenvalues[1] ?? 0);
  const spectralGap = Math.max(0, Math.min(1, 1 - secondMagnitude));
  return { available: true, spectralGap, eigenvalues, stationaryDistribution, assumptions, reason: "available" };
}

/**
 * Compatibility scalar. Zero means either a genuine zero absolute gap or that
 * the reversible-chain assumptions were not established; callers that need to
 * distinguish those cases must use assessTransitionSpectralGap().
 */
export function spectralGapFromTransition(transition: number[][]): number {
  return assessTransitionSpectralGap(transition).spectralGap;
}

function stationaryDistributionForTransition(transition: readonly (readonly number[])[]): number[] {
  const size = transition.length;
  if (size === 0) return [];
  let current = new Array<number>(size).fill(1 / size);
  // Iterate the lazy chain to make convergence independent of the original
  // chain's period. This computes a stationary vector of the same P.
  for (let iteration = 0; iteration < 20_000; iteration++) {
    const next = new Array<number>(size).fill(0);
    for (let i = 0; i < size; i++) {
      next[i] = (next[i] ?? 0) + 0.5 * (current[i] ?? 0);
      for (let j = 0; j < size; j++) {
        next[j] = (next[j] ?? 0) + 0.5 * (current[i] ?? 0) * (transition[i]?.[j] ?? 0);
      }
    }
    const residual = next.reduce((sum, value, index) => sum + Math.abs(value - (current[index] ?? 0)), 0);
    current = next;
    if (residual <= 1e-13) break;
  }
  return current;
}

function detailedBalanceHolds(transition: readonly (readonly number[])[], stationary: readonly number[]): boolean {
  if (stationary.some(value => !(value > 0) || !Number.isFinite(value))) return false;
  for (let i = 0; i < transition.length; i++) {
    for (let j = i + 1; j < transition.length; j++) {
      const forward = (stationary[i] ?? 0) * (transition[i]?.[j] ?? 0);
      const reverse = (stationary[j] ?? 0) * (transition[j]?.[i] ?? 0);
      if (Math.abs(forward - reverse) > 1e-8 * Math.max(1, Math.abs(forward), Math.abs(reverse))) return false;
    }
  }
  return true;
}

function stronglyConnectedTransition(transition: readonly (readonly number[])[]): boolean {
  if (transition.length === 0) return false;
  return reachableTransitionStates(transition, false).size === transition.length && reachableTransitionStates(transition, true).size === transition.length;
}

function reachableTransitionStates(transition: readonly (readonly number[])[], reverse: boolean): Set<number> {
  const seen = new Set<number>([0]);
  const stack = [0];
  while (stack.length > 0) {
    const current = stack.pop()!;
    for (let candidate = 0; candidate < transition.length; candidate++) {
      const probability = reverse ? (transition[candidate]?.[current] ?? 0) : (transition[current]?.[candidate] ?? 0);
      if (probability > 0 && !seen.has(candidate)) {
        seen.add(candidate);
        stack.push(candidate);
      }
    }
  }
  return seen;
}

function transitionPeriod(transition: readonly (readonly number[])[]): number {
  if (transition.length === 0) return 0;
  const distance = new Array<number>(transition.length).fill(-1);
  distance[0] = 0;
  const queue = [0];
  for (let cursor = 0; cursor < queue.length; cursor++) {
    const current = queue[cursor]!;
    for (let candidate = 0; candidate < transition.length; candidate++) {
      if ((transition[current]?.[candidate] ?? 0) <= 0 || (distance[candidate] ?? -1) >= 0) continue;
      distance[candidate] = (distance[current] ?? 0) + 1;
      queue.push(candidate);
    }
  }
  let period = 0;
  for (let from = 0; from < transition.length; from++) {
    for (let to = 0; to < transition.length; to++) {
      if ((transition[from]?.[to] ?? 0) <= 0) continue;
      period = greatestCommonDivisor(period, Math.abs((distance[from] ?? 0) + 1 - (distance[to] ?? 0)));
    }
  }
  return period;
}

function greatestCommonDivisor(left: number, right: number): number {
  let a = Math.abs(Math.trunc(left));
  let b = Math.abs(Math.trunc(right));
  while (b !== 0) [a, b] = [b, a % b];
  return a;
}
