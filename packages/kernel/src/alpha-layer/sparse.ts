import { clamp01, normalizeVector } from "../primitives.js";

export interface CooEntry {
  row: number;
  col: number;
  value: number;
}

export interface CsrMatrix {
  rows: number;
  cols: number;
  rowPtr: Int32Array;
  colIdx: Int32Array;
  values: Float64Array;
}

export interface SparseSolveReport {
  converged: boolean;
  iterations: number;
  residualNorm: number;
}

export interface VectorWithReport {
  vector: number[];
  report: SparseSolveReport;
}

export function csrFromCoo(rows: number, cols: number, entries: readonly CooEntry[]): CsrMatrix {
  const merged = new Map<string, number>();
  for (const entry of entries) {
    if (!Number.isFinite(entry.value) || entry.value === 0) continue;
    if (entry.row < 0 || entry.row >= rows || entry.col < 0 || entry.col >= cols) continue;
    const key = `${entry.row}:${entry.col}`;
    merged.set(key, (merged.get(key) ?? 0) + entry.value);
  }
  const sorted = [...merged.entries()]
    .map(([key, value]) => {
      const [rawRow, rawCol] = key.split(":");
      return { row: Number(rawRow ?? 0), col: Number(rawCol ?? 0), value };
    })
    .filter(entry => entry.value !== 0)
    .sort((a, b) => a.row - b.row || a.col - b.col);
  const rowPtr = new Int32Array(rows + 1);
  for (const entry of sorted) rowPtr[entry.row + 1] = (rowPtr[entry.row + 1] ?? 0) + 1;
  for (let i = 1; i < rowPtr.length; i++) rowPtr[i] = (rowPtr[i] ?? 0) + (rowPtr[i - 1] ?? 0);
  const colIdx = new Int32Array(sorted.length);
  const values = new Float64Array(sorted.length);
  const cursor = new Int32Array(rowPtr);
  for (const entry of sorted) {
    const at = cursor[entry.row] ?? 0;
    cursor[entry.row] = at + 1;
    colIdx[at] = entry.col;
    values[at] = entry.value;
  }
  return { rows, cols, rowPtr, colIdx, values };
}

export function csrToDense(matrix: CsrMatrix): number[][] {
  const out = Array.from({ length: matrix.rows }, () => new Array<number>(matrix.cols).fill(0));
  forEachCsr(matrix, (row, col, value) => {
    out[row]![col] = value;
  });
  return out;
}

export function denseToCsr(matrix: readonly number[][]): CsrMatrix {
  const rows = matrix.length;
  const cols = matrix[0]?.length ?? 0;
  const entries: CooEntry[] = [];
  for (let row = 0; row < rows; row++) {
    for (let col = 0; col < cols; col++) {
      const value = matrix[row]?.[col] ?? 0;
      if (value !== 0) entries.push({ row, col, value });
    }
  }
  return csrFromCoo(rows, cols, entries);
}

export function forEachCsr(matrix: CsrMatrix, fn: (row: number, col: number, value: number) => void): void {
  for (let row = 0; row < matrix.rows; row++) {
    const start = matrix.rowPtr[row] ?? 0;
    const end = matrix.rowPtr[row + 1] ?? start;
    for (let ptr = start; ptr < end; ptr++) fn(row, matrix.colIdx[ptr] ?? 0, matrix.values[ptr] ?? 0);
  }
}

export function csrMatVec(matrix: CsrMatrix, vector: readonly number[]): number[] {
  const out = new Array<number>(matrix.rows).fill(0);
  for (let row = 0; row < matrix.rows; row++) {
    let sum = 0;
    const start = matrix.rowPtr[row] ?? 0;
    const end = matrix.rowPtr[row + 1] ?? start;
    for (let ptr = start; ptr < end; ptr++) sum += (matrix.values[ptr] ?? 0) * (vector[matrix.colIdx[ptr] ?? 0] ?? 0);
    out[row] = sum;
  }
  return out;
}

export function csrTranspose(matrix: CsrMatrix): CsrMatrix {
  const entries: CooEntry[] = [];
  forEachCsr(matrix, (row, col, value) => entries.push({ row: col, col: row, value }));
  return csrFromCoo(matrix.cols, matrix.rows, entries);
}

export function csrAdd(a: CsrMatrix, b: CsrMatrix, scaleA = 1, scaleB = 1): CsrMatrix {
  if (a.rows !== b.rows || a.cols !== b.cols) throw new Error("csrAdd shape mismatch");
  const entries: CooEntry[] = [];
  forEachCsr(a, (row, col, value) => entries.push({ row, col, value: scaleA * value }));
  forEachCsr(b, (row, col, value) => entries.push({ row, col, value: scaleB * value }));
  return csrFromCoo(a.rows, a.cols, entries);
}

export function csrScale(matrix: CsrMatrix, scale: number): CsrMatrix {
  return { rows: matrix.rows, cols: matrix.cols, rowPtr: matrix.rowPtr.slice(), colIdx: matrix.colIdx.slice(), values: Float64Array.from(matrix.values, value => value * scale) };
}

export function csrIdentity(n: number, scale = 1): CsrMatrix {
  return csrFromCoo(n, n, Array.from({ length: n }, (_, i) => ({ row: i, col: i, value: scale })));
}

export function csrDegrees(matrix: CsrMatrix, absolute = false): number[] {
  const out = new Array<number>(matrix.rows).fill(0);
  forEachCsr(matrix, (row, _col, value) => {
    out[row] = (out[row] ?? 0) + (absolute ? Math.abs(value) : value);
  });
  return out;
}

export function symmetricAlphaAdjacency(nodeCount: number, edges: readonly { source: number; target: number; weight: number; reverseWeight?: number }[]): CsrMatrix {
  const entries: CooEntry[] = [];
  for (const edge of edges) {
    if (edge.source === edge.target) continue;
    const forward = Math.max(0, edge.weight);
    const reverse = Math.max(0, edge.reverseWeight ?? edge.weight);
    if (forward > 0) entries.push({ row: edge.source, col: edge.target, value: forward });
    if (reverse > 0) entries.push({ row: edge.target, col: edge.source, value: reverse });
  }
  return csrFromCoo(nodeCount, nodeCount, entries);
}

export function graphLaplacian(adjacency: CsrMatrix): { degree: number[]; laplacian: CsrMatrix; normalized: CsrMatrix; randomWalk: CsrMatrix } {
  if (adjacency.rows !== adjacency.cols) throw new Error("graphLaplacian requires a square adjacency");
  const degree = csrDegrees(adjacency);
  const lapEntries: CooEntry[] = [];
  const normEntries: CooEntry[] = [];
  const rwEntries: CooEntry[] = [];
  for (let i = 0; i < adjacency.rows; i++) {
    const d = degree[i] ?? 0;
    if (d > 0) {
      lapEntries.push({ row: i, col: i, value: d });
      normEntries.push({ row: i, col: i, value: 1 });
    }
    const start = adjacency.rowPtr[i] ?? 0;
    const end = adjacency.rowPtr[i + 1] ?? start;
    for (let ptr = start; ptr < end; ptr++) {
      const j = adjacency.colIdx[ptr] ?? 0;
      const w = adjacency.values[ptr] ?? 0;
      if (i === j || w === 0) continue;
      lapEntries.push({ row: i, col: j, value: -w });
      const dj = degree[j] ?? 0;
      if (d > 0 && dj > 0) normEntries.push({ row: i, col: j, value: -w / Math.sqrt(d * dj) });
      if (d > 0) rwEntries.push({ row: i, col: j, value: w / d });
    }
  }
  return {
    degree,
    laplacian: csrFromCoo(adjacency.rows, adjacency.cols, lapEntries),
    normalized: csrFromCoo(adjacency.rows, adjacency.cols, normEntries),
    randomWalk: csrFromCoo(adjacency.rows, adjacency.cols, rwEntries)
  };
}

export function stochasticNormalizeRows(matrix: CsrMatrix, prior?: readonly number[]): CsrMatrix {
  const entries: CooEntry[] = [];
  for (let row = 0; row < matrix.rows; row++) {
    const start = matrix.rowPtr[row] ?? 0;
    const end = matrix.rowPtr[row + 1] ?? start;
    let sum = 0;
    for (let ptr = start; ptr < end; ptr++) sum += Math.max(0, matrix.values[ptr] ?? 0);
    if (sum > 0) {
      for (let ptr = start; ptr < end; ptr++) {
        const value = Math.max(0, matrix.values[ptr] ?? 0);
        if (value > 0) entries.push({ row, col: matrix.colIdx[ptr] ?? 0, value: value / sum });
      }
    } else if (prior?.length === matrix.cols) {
      for (let col = 0; col < matrix.cols; col++) if ((prior[col] ?? 0) > 0) entries.push({ row, col, value: prior[col] ?? 0 });
    }
  }
  return csrFromCoo(matrix.rows, matrix.cols, entries);
}

export function dot(a: readonly number[], b: readonly number[]): number {
  const n = Math.max(a.length, b.length);
  let sum = 0;
  for (let i = 0; i < n; i++) sum += (a[i] ?? 0) * (b[i] ?? 0);
  return sum;
}

export function l2Norm(vector: readonly number[]): number {
  return Math.sqrt(dot(vector, vector));
}

export function vectorAdd(a: readonly number[], b: readonly number[], scaleA = 1, scaleB = 1): number[] {
  const n = Math.max(a.length, b.length);
  return Array.from({ length: n }, (_, i) => scaleA * (a[i] ?? 0) + scaleB * (b[i] ?? 0));
}

export function conjugateGradient(matrix: CsrMatrix, rhs: readonly number[], options: { tolerance?: number; maxIterations?: number; ridge?: number } = {}): VectorWithReport {
  if (matrix.rows !== matrix.cols) throw new Error("conjugateGradient requires a square matrix");
  const n = matrix.rows;
  const tolerance = options.tolerance ?? 1e-8;
  const maxIterations = options.maxIterations ?? Math.max(32, n * 4);
  const ridge = options.ridge ?? 0;
  let x = new Array<number>(n).fill(0);
  const apply = (v: readonly number[]) => {
    const mv = csrMatVec(matrix, v);
    return ridge ? mv.map((value, i) => value + ridge * (v[i] ?? 0)) : mv;
  };
  let r = vectorAdd(rhs, apply(x), 1, -1);
  let p = r.slice();
  let rsOld = dot(r, r);
  if (Math.sqrt(rsOld) <= tolerance) return { vector: x, report: { converged: true, iterations: 0, residualNorm: Math.sqrt(rsOld) } };
  let converged = false;
  let residualNorm = Math.sqrt(rsOld);
  let iter = 0;
  for (; iter < maxIterations; iter++) {
    const ap = apply(p);
    const denom = dot(p, ap);
    if (Math.abs(denom) < 1e-18) break;
    const alpha = rsOld / denom;
    x = vectorAdd(x, p, 1, alpha);
    r = vectorAdd(r, ap, 1, -alpha);
    const rsNew = dot(r, r);
    residualNorm = Math.sqrt(rsNew);
    if (residualNorm <= tolerance) {
      converged = true;
      break;
    }
    const beta = rsNew / Math.max(1e-18, rsOld);
    p = vectorAdd(r, p, 1, beta);
    rsOld = rsNew;
  }
  return { vector: x, report: { converged, iterations: iter + 1, residualNorm } };
}

export function powerIteration(matrix: CsrMatrix, options: { iterations?: number; tolerance?: number; initial?: readonly number[] } = {}): { eigenvalue: number; eigenvector: number[]; iterations: number; residual: number } {
  if (matrix.rows !== matrix.cols) throw new Error("powerIteration requires a square matrix");
  const n = matrix.rows;
  let v = normalizeVector(options.initial?.length === n ? [...options.initial] : new Array<number>(n).fill(1 / Math.max(1, n)));
  let eigenvalue = 0;
  let residual = Infinity;
  const iterations = options.iterations ?? 100;
  const tolerance = options.tolerance ?? 1e-8;
  let iter = 0;
  for (; iter < iterations; iter++) {
    const mv = csrMatVec(matrix, v);
    const norm = l2Norm(mv);
    if (norm <= 1e-18) break;
    const next = mv.map(value => value / norm);
    const av = csrMatVec(matrix, next);
    eigenvalue = dot(next, av);
    residual = l2Norm(vectorAdd(av, next, 1, -eigenvalue));
    v = next;
    if (residual <= tolerance) break;
  }
  return { eigenvalue, eigenvector: v, iterations: iter + 1, residual };
}

export function inverseIterationShift(matrix: CsrMatrix, shift: number, options: { iterations?: number; ridge?: number; tolerance?: number } = {}): { eigenvalue: number; eigenvector: number[]; report: SparseSolveReport[] } {
  if (matrix.rows !== matrix.cols) throw new Error("inverseIterationShift requires a square matrix");
  const shifted = csrAdd(matrix, csrIdentity(matrix.rows, -shift));
  let v = normalizeVector(new Array<number>(matrix.rows).fill(1 / Math.max(1, matrix.rows)));
  const reports: SparseSolveReport[] = [];
  for (let iter = 0; iter < (options.iterations ?? 12); iter++) {
    const solved = conjugateGradient(shifted, v, { tolerance: options.tolerance ?? 1e-8, ridge: options.ridge ?? 1e-6, maxIterations: matrix.rows * 8 + 32 });
    reports.push(solved.report);
    const norm = l2Norm(solved.vector);
    if (norm <= 1e-18) break;
    v = solved.vector.map(value => value / norm);
  }
  const av = csrMatVec(matrix, v);
  return { eigenvalue: dot(v, av), eigenvector: v, report: reports };
}

export function personalizedStationaryDistribution(transition: CsrMatrix, personalization: readonly number[], options: { damping?: number; iterations?: number; tolerance?: number } = {}): { mass: number[]; residual: number; iterations: number } {
  if (transition.rows !== transition.cols) throw new Error("personalizedStationaryDistribution requires a square matrix");
  const n = transition.rows;
  const teleport = normalizeVector([...personalization]);
  const damping = clamp01(options.damping ?? 0.85);
  let mass = teleport.slice();
  let residual = Infinity;
  let iter = 0;
  const transposed = csrTranspose(transition);
  for (; iter < (options.iterations ?? 100); iter++) {
    const walked = csrMatVec(transposed, mass);
    const next = walked.map((value, i) => damping * value + (1 - damping) * (teleport[i] ?? 0));
    const normed = normalizeVector(next);
    residual = l2Norm(vectorAdd(normed, mass, 1, -1));
    mass = normed;
    if (residual <= (options.tolerance ?? 1e-10)) break;
  }
  return { mass, residual, iterations: iter + 1 };
}
