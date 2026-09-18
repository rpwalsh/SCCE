// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
//
// Universal translation with no word files. Two languages that describe the same world produce co-occurrence
// structures with the same SHAPE; aligning the shapes -- not the surfaces -- falls out a translation map. It is
// script-independent because it never looks at characters: Lakota, Arabic, or a conlang align the same way,
// given enough monolingual text and nothing else. This is entropic Gromov-Wasserstein, anchored by the
// closed-class hubs SCCE already discovers unsupervised (function words are structural hubs in every language,
// so they pin the rotation the GW coupling would otherwise be free to spin).
//
// Brick 1 of the first-class multilingual feature: the structural coupling core, proven on synthetic isomorphic
// structures. Brick 2 consolidates the inner Sinkhorn onto sparse-fused-transport's solver and constructs the
// candidate support from real per-language co-occurrence; brick 3 is the cross-lingual turn path. The inner
// Sinkhorn here is the GW-specific projection, kept local until that consolidation.

/** One language's structure: symbols and their co-occurrence weights, monolingual, nothing cross-lingual. */
export interface LanguageCooccurrence {
  language: string;
  /** Symbols in a stable order; the first index is row 0 of the structure matrix. */
  symbols: readonly string[];
  /** symbol i -> {symbol j -> co-occurrence weight}. Sparse; missing pairs are zero. */
  cooccurrence: ReadonlyMap<string, ReadonlyMap<string, number>>;
  /** Optional marginal mass per symbol (document/corpus frequency). Uniform when absent. */
  mass?: ReadonlyMap<string, number>;
}

/** A closed-class hub correspondence known before alignment: a structural anchor, never a translated word pair. */
export interface StructuralAnchor {
  sourceSymbol: string;
  targetSymbol: string;
  /** How hard to pin this pair, 0..1. Closed-class hubs are strong; nothing here is a dictionary entry. */
  strength: number;
}

export interface AlignedSymbolPair {
  sourceSymbol: string;
  targetSymbol: string;
  /** Coupling mass on this pair, normalized against the source symbol's row: 0..1 confidence. */
  score: number;
}

export interface CrossLingualAlignmentOptions {
  /** Entropic regularization for the inner Sinkhorn. Higher = smoother, more stable, less peaked. */
  epsilon?: number;
  /** Gromov-Wasserstein outer iterations. */
  outerIterations?: number;
  /** Sinkhorn inner iterations per outer step. */
  innerIterations?: number;
  /** Cap the vocabulary aligned per language to the top-mass symbols; GW is quadratic in this. */
  maxSymbols?: number;
  anchors?: readonly StructuralAnchor[];
}

const DEFAULTS = { epsilon: 0.05, outerIterations: 120, innerIterations: 24, maxSymbols: 256 };

/** Row-normalized structure matrix over the chosen symbols: each symbol's co-occurrence profile as a distribution. */
function structureMatrix(structure: LanguageCooccurrence, symbols: readonly string[]): number[][] {
  const index = new Map(symbols.map((s, i) => [s, i]));
  const n = symbols.length;
  const matrix = Array.from({ length: n }, () => new Array<number>(n).fill(0));
  for (let i = 0; i < n; i++) {
    const row = structure.cooccurrence.get(symbols[i]!);
    if (!row) continue;
    let sum = 0;
    for (const [other, weight] of row) {
      const j = index.get(other);
      if (j === undefined || weight <= 0) continue;
      matrix[i]![j] = weight;
      sum += weight;
    }
    if (sum > 0) for (let j = 0; j < n; j++) matrix[i]![j] = (matrix[i]![j] ?? 0) / sum;
  }
  return matrix;
}

/** Top-mass symbols, so GW stays quadratic in a bounded vocabulary rather than the whole language. */
function topSymbols(structure: LanguageCooccurrence, cap: number): string[] {
  return [...structure.symbols].sort((a, b) => symbolMass(structure, b) - symbolMass(structure, a)).slice(0, cap);
}

function symbolMass(structure: LanguageCooccurrence, symbol: string): number {
  const declared = structure.mass?.get(symbol);
  if (declared !== undefined) return declared;
  let sum = 0;
  for (const weight of structure.cooccurrence.get(symbol)?.values() ?? []) sum += weight;
  return sum;
}

function marginal(structure: LanguageCooccurrence, symbols: readonly string[]): number[] {
  const raw = symbols.map(s => symbolMass(structure, s));
  const total = raw.reduce((a, b) => a + b, 0) || symbols.length;
  return raw.map(v => (v > 0 ? v : 1e-9) / total);
}

/**
 * Entropic Gromov-Wasserstein coupling between two structure matrices. The coupling T is chosen so that
 * structurally similar pairs in the source map to structurally similar pairs in the target -- i.e. it aligns the
 * two geometries, never the surfaces. Anchors bias the initial coupling so the (otherwise rotation-free)
 * solution locks onto the correct correspondence. Returns T[i][j] = transported mass from source i to target j.
 */
function entropicGromovWasserstein(
  cSource: number[][],
  cTarget: number[][],
  p: number[],
  q: number[],
  anchorBias: number[][],
  options: Required<Omit<CrossLingualAlignmentOptions, "anchors">>
): number[][] {
  const n = p.length;
  const m = q.length;
  // Initialize the coupling as the independent product, nudged toward the anchor bias.
  let T = Array.from({ length: n }, (_, i) => Array.from({ length: m }, (_, j) => p[i]! * q[j]! * (1 + anchorBias[i]![j]!)));
  T = normalizeToMarginals(T, p, q, options.epsilon, options.innerIterations);

  // The squared-loss GW cost decomposes (Peyre 2016) into a constant marginal term minus a coupling term:
  //   L (x) T = constC - 2 . Cs T Ct^T,   constC[i][j] = sum_k Cs[i][k]^2 p[k] + sum_l Ct[j][l]^2 q[l].
  // The separable -Cs T Ct^T alone (what an earlier pass used) drops constC and the factor 2, which lets
  // structurally distinct symbols collapse together; the full cost keeps them apart.
  const rowTermS = cSource.map(row => row.reduce((s, v, k) => s + v * v * p[k]!, 0));
  const rowTermT = cTarget.map(row => row.reduce((s, v, l) => s + v * v * q[l]!, 0));
  const CtT = transpose(cTarget);
  for (let outer = 0; outer < options.outerIterations; outer++) {
    const TCt = multiply(T, CtT);        // n x m
    const CsTCt = multiply(cSource, TCt); // n x m  (Cs T Ct^T)
    const cost = Array.from({ length: n }, (_, i) => Array.from({ length: m }, (_, j) =>
      (rowTermS[i]! + rowTermT[j]!) - 2 * CsTCt[i]![j]! - anchorBias[i]![j]!));
    // Log-domain stabilization: exp(-cost/epsilon) overflows to Inf for any strong anchor at small epsilon, which
    // collapses Sinkhorn to a single cell. Subtracting the minimum cost bounds every exponent at 0 without
    // changing the coupling (a constant shift cancels in the row/column scaling).
    let minCost = Infinity;
    for (const rowVals of cost) for (const c of rowVals) if (c < minCost) minCost = c;
    const kernel = cost.map(rowVals => rowVals.map(c => Math.exp(-(c - minCost) / options.epsilon)));
    T = normalizeKernelToMarginals(kernel, p, q, options.innerIterations);
  }
  return T;
}

function transpose(a: number[][]): number[][] {
  const r = a.length, c = a[0]?.length ?? 0;
  const out = Array.from({ length: c }, () => new Array<number>(r).fill(0));
  for (let i = 0; i < r; i++) for (let j = 0; j < c; j++) out[j]![i] = a[i]![j]!;
  return out;
}
function multiply(a: number[][], b: number[][]): number[][] {
  const r = a.length, k = b.length, c = b[0]?.length ?? 0;
  const out = Array.from({ length: r }, () => new Array<number>(c).fill(0));
  for (let i = 0; i < r; i++) for (let x = 0; x < k; x++) {
    const aix = a[i]![x]!;
    if (aix === 0) continue;
    for (let j = 0; j < c; j++) out[i]![j]! += aix * b[x]![j]!;
  }
  return out;
}

/** Sinkhorn projection of an existing coupling onto the marginals with entropic smoothing. */
function normalizeToMarginals(T: number[][], p: number[], q: number[], epsilon: number, iterations: number): number[][] {
  const kernel = T.map(row => row.map(v => Math.max(v, 1e-12)));
  return normalizeKernelToMarginals(kernel, p, q, iterations);
}

/** Sinkhorn: scale a nonnegative kernel so its row sums approach p and column sums approach q. */
function normalizeKernelToMarginals(kernel: number[][], p: number[], q: number[], iterations: number): number[][] {
  const n = p.length, m = q.length;
  const u = new Array<number>(n).fill(1);
  const v = new Array<number>(m).fill(1);
  for (let it = 0; it < iterations; it++) {
    for (let i = 0; i < n; i++) {
      let s = 0;
      for (let j = 0; j < m; j++) s += kernel[i]![j]! * v[j]!;
      u[i] = p[i]! / (s || 1e-12);
    }
    for (let j = 0; j < m; j++) {
      let s = 0;
      for (let i = 0; i < n; i++) s += kernel[i]![j]! * u[i]!;
      v[j] = q[j]! / (s || 1e-12);
    }
  }
  return Array.from({ length: n }, (_, i) => Array.from({ length: m }, (_, j) => u[i]! * kernel[i]![j]! * v[j]!));
}

/**
 * Align two monolingual co-occurrence structures into symbol correspondences, with no parallel data and no
 * dictionary. Anchors are optional structural hints (closed-class hubs); with none, the alignment is recovered
 * up to the symmetry the structure itself breaks. Pure and deterministic given its inputs.
 */
export function alignLanguagesByStructure(
  source: LanguageCooccurrence,
  target: LanguageCooccurrence,
  options: CrossLingualAlignmentOptions = {}
): AlignedSymbolPair[] {
  const opts = {
    epsilon: options.epsilon ?? DEFAULTS.epsilon,
    outerIterations: options.outerIterations ?? DEFAULTS.outerIterations,
    innerIterations: options.innerIterations ?? DEFAULTS.innerIterations,
    maxSymbols: options.maxSymbols ?? DEFAULTS.maxSymbols
  };
  const sourceSymbols = topSymbols(source, opts.maxSymbols);
  const targetSymbols = topSymbols(target, opts.maxSymbols);
  if (!sourceSymbols.length || !targetSymbols.length) return [];

  const cSource = structureMatrix(source, sourceSymbols);
  const cTarget = structureMatrix(target, targetSymbols);
  const p = marginal(source, sourceSymbols);
  const q = marginal(target, targetSymbols);

  const sourceIndex = new Map(sourceSymbols.map((s, i) => [s, i]));
  const targetIndex = new Map(targetSymbols.map((s, i) => [s, i]));
  const anchorBias = Array.from({ length: sourceSymbols.length }, () => new Array<number>(targetSymbols.length).fill(0));
  for (const anchor of options.anchors ?? []) {
    const i = sourceIndex.get(anchor.sourceSymbol);
    const j = targetIndex.get(anchor.targetSymbol);
    if (i === undefined || j === undefined) continue;
    // Anchors are pinned hard: a closed-class hub whose correspondence is known should dominate the local cost,
    // not merely nudge it, so its structural constraint propagates to the content symbols around it.
    anchorBias[i]![j] = Math.max(0, anchor.strength) * 25;
  }

  const coupling = entropicGromovWasserstein(cSource, cTarget, p, q, anchorBias, opts);

  const pairs: AlignedSymbolPair[] = [];
  for (let i = 0; i < sourceSymbols.length; i++) {
    const row = coupling[i]!;
    const rowSum = row.reduce((a, b) => a + b, 0) || 1e-12;
    let bestJ = 0, best = -1;
    for (let j = 0; j < row.length; j++) if (row[j]! > best) { best = row[j]!; bestJ = j; }
    pairs.push({ sourceSymbol: sourceSymbols[i]!, targetSymbol: targetSymbols[bestJ]!, score: best / rowSum });
  }
  return pairs.sort((a, b) => b.score - a.score);
}
