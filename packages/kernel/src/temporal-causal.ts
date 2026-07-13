import type { JsonValue } from "./types.js";
import { clamp01, mean, toJsonValue, variance } from "./primitives.js";

export interface TemporalSeries {
  id: string;
  values: number[];
  t0?: number;
  dt?: number;
  metadata?: JsonValue;
}

export interface StationarityReport {
  id: string;
  differencingOrder: number;
  originalVariance: number;
  finalVariance: number;
  autocorrelation1: number;
  meanAbsDrift: number;
  stationaryScore: number;
  transformed: number[];
}

export interface GrangerEdge {
  source: string;
  target: string;
  lag: number;
  fStatistic: number;
  pValue: number;
  qValue: number;
  rejectedNull: boolean;
  restrictedRss: number;
  unrestrictedRss: number;
  strength: number;
}

export interface TransferEntropyEdge {
  source: string;
  target: string;
  lag: number;
  bins: number;
  transferEntropy: number;
  normalized: number;
  samples: number;
}

export interface TemporalCausalDiscoveryResult {
  stationarity: StationarityReport[];
  grangerEdges: GrangerEdge[];
  transferEntropyEdges: TransferEntropyEdge[];
  fusedEdges: Array<{
    source: string;
    target: string;
    lag: number;
    strength: number;
    grangerP: number;
    grangerQ: number;
    transferEntropy: number;
    method: "granger" | "transfer_entropy" | "fused";
  }>;
  audit: JsonValue;
}

export interface TemporalCausalOptions {
  maxLag?: number;
  fdrQ?: number;
  transferEntropyBins?: number;
  minSamples?: number;
}

export function createTemporalCausalDiscovery() {
  return {
    discover(series: readonly TemporalSeries[], options: TemporalCausalOptions = {}): TemporalCausalDiscoveryResult {
      const minSamples = options.minSamples ?? 24;
      const stationarity = series.map(item => stationarize(item, 2));
      const usable = stationarity.filter(item => item.transformed.length >= minSamples);
      const maxLag = Math.max(1, options.maxLag ?? Math.min(8, Math.floor(Math.min(...usable.map(item => item.transformed.length)) / 6) || 1));
      const grangerRaw: GrangerEdge[] = [];
      const teEdges: TransferEntropyEdge[] = [];
      for (const source of usable) {
        for (const target of usable) {
          if (source.id === target.id) continue;
          const lag = selectLagByAic(source.transformed, target.transformed, maxLag);
          const granger = grangerTest(source.id, target.id, source.transformed, target.transformed, lag);
          grangerRaw.push(granger);
          teEdges.push(transferEntropy(source.id, target.id, source.transformed, target.transformed, lag, options.transferEntropyBins ?? 5));
        }
      }
      const grangerEdges = benjaminiHochberg(grangerRaw, options.fdrQ ?? 0.1);
      const fusedEdges = fuseEdges(grangerEdges, teEdges);
      return {
        stationarity,
        grangerEdges,
        transferEntropyEdges: teEdges.sort((a, b) => b.normalized - a.normalized),
        fusedEdges,
        audit: toJsonValue({
          series: series.length,
          usable: usable.length,
          maxLag,
          fdrQ: options.fdrQ ?? 0.1,
          grangerEdges: grangerEdges.filter(edge => edge.rejectedNull).length,
          transferEntropyEdges: teEdges.filter(edge => edge.normalized > 0.02).length,
          fusedEdges: fusedEdges.length
        })
      };
    }
  };
}

export function stationarize(series: TemporalSeries, maxOrder = 2): StationarityReport {
  let transformed = clean(series.values);
  const originalVariance = variance(transformed);
  let order = 0;
  while (order < maxOrder && stationarityScore(transformed) < 0.55 && transformed.length > 4) {
    transformed = difference(transformed);
    order++;
  }
  const finalVariance = variance(transformed);
  return {
    id: series.id,
    differencingOrder: order,
    originalVariance,
    finalVariance,
    autocorrelation1: autocorrelation(transformed, 1),
    meanAbsDrift: meanAbsDrift(transformed),
    stationaryScore: stationarityScore(transformed),
    transformed
  };
}

export function grangerTest(sourceId: string, targetId: string, xRaw: readonly number[], yRaw: readonly number[], lag: number): GrangerEdge {
  const x = alignFinite(xRaw);
  const y = alignFinite(yRaw);
  const n = Math.min(x.length, y.length);
  const p = Math.max(1, Math.min(lag, Math.floor((n - 3) / 2)));
  if (n <= 2 * p + 2) return emptyGranger(sourceId, targetId, p);
  const restricted = regressionRows(y.slice(0, n), y.slice(0, n), p, false);
  const unrestricted = regressionRows(y.slice(0, n), x.slice(0, n), p, true);
  const restrictedFit = olsRss(restricted.y, restricted.x);
  const unrestrictedFit = olsRss(unrestricted.y, unrestricted.x);
  const df1 = p;
  const df2 = Math.max(1, unrestricted.y.length - 2 * p - 1);
  const numerator = (restrictedFit.rss - unrestrictedFit.rss) / df1;
  const denominator = unrestrictedFit.rss / df2;
  const fStatistic = denominator > 1e-12 ? Math.max(0, numerator / denominator) : 0;
  const pValue = fSurvival(fStatistic, df1, df2);
  const strength = clamp01((restrictedFit.rss - unrestrictedFit.rss) / Math.max(1e-12, restrictedFit.rss));
  return {
    source: sourceId,
    target: targetId,
    lag: p,
    fStatistic,
    pValue,
    qValue: pValue,
    rejectedNull: false,
    restrictedRss: restrictedFit.rss,
    unrestrictedRss: unrestrictedFit.rss,
    strength
  };
}

export function transferEntropy(sourceId: string, targetId: string, xRaw: readonly number[], yRaw: readonly number[], lag: number, bins = 5): TransferEntropyEdge {
  const x = discretize(alignFinite(xRaw), bins);
  const y = discretize(alignFinite(yRaw), bins);
  const n = Math.min(x.length, y.length);
  const p = Math.max(1, Math.min(lag, n - 2));
  const counts = new Map<string, number>();
  const yhist = new Map<string, number>();
  const yhistX = new Map<string, number>();
  const yNextYHist = new Map<string, number>();
  let samples = 0;
  for (let t = p; t < n; t++) {
    const yn = y[t]!;
    const yh = y.slice(t - p, t).join(",");
    const xh = x.slice(t - p, t).join(",");
    inc(counts, `${yn}|${yh}|${xh}`);
    inc(yhist, yh);
    inc(yhistX, `${yh}|${xh}`);
    inc(yNextYHist, `${yn}|${yh}`);
    samples++;
  }
  let te = 0;
  for (const [key, c] of counts) {
    const [yn, yh, xh] = split3(key);
    const pJoint = c / Math.max(1, samples);
    const pYGivenYX = c / Math.max(1, yhistX.get(`${yh}|${xh}`) ?? 0);
    const pYGivenY = (yNextYHist.get(`${yn}|${yh}`) ?? 0) / Math.max(1, yhist.get(yh) ?? 0);
    if (pYGivenYX > 0 && pYGivenY > 0) te += pJoint * Math.log2(pYGivenYX / pYGivenY);
  }
  const entropyTarget = entropyOfBins(y.slice(p));
  return { source: sourceId, target: targetId, lag: p, bins, transferEntropy: Math.max(0, te), normalized: entropyTarget > 0 ? clamp01(te / entropyTarget) : 0, samples };
}

export function benjaminiHochberg(edges: readonly GrangerEdge[], q = 0.1): GrangerEdge[] {
  const sorted = [...edges].sort((a, b) => a.pValue - b.pValue || a.source.localeCompare(b.source) || a.target.localeCompare(b.target));
  let largest = -1;
  for (let i = 0; i < sorted.length; i++) {
    if ((sorted[i]?.pValue ?? 1) <= ((i + 1) / Math.max(1, sorted.length)) * q) largest = i;
  }
  return sorted.map((edge, i) => {
    const qValue = Math.min(1, edge.pValue * sorted.length / Math.max(1, i + 1));
    return { ...edge, qValue, rejectedNull: i <= largest };
  }).sort((a, b) => Number(b.rejectedNull) - Number(a.rejectedNull) || a.qValue - b.qValue || b.strength - a.strength);
}

export function selectLagByAic(xRaw: readonly number[], yRaw: readonly number[], maxLag: number): number {
  const x = alignFinite(xRaw);
  const y = alignFinite(yRaw);
  let best = { lag: 1, aic: Number.POSITIVE_INFINITY };
  for (let lag = 1; lag <= Math.max(1, maxLag); lag++) {
    const rows = regressionRows(y, x, lag, true);
    const fit = olsRss(rows.y, rows.x);
    const n = Math.max(1, rows.y.length);
    const k = rows.x[0]?.length ?? 1;
    const sigma = Math.max(1e-12, fit.rss / n);
    const aic = n * Math.log(sigma) + 2 * k;
    if (aic < best.aic) best = { lag, aic };
  }
  return best.lag;
}

function fuseEdges(grangerEdges: readonly GrangerEdge[], teEdges: readonly TransferEntropyEdge[]): TemporalCausalDiscoveryResult["fusedEdges"] {
  const teByPair = new Map(teEdges.map(edge => [`${edge.source}->${edge.target}`, edge]));
  return grangerEdges
    .map(edge => {
      const te = teByPair.get(`${edge.source}->${edge.target}`);
      const teStrength = te?.normalized ?? 0;
      const strength = clamp01(0.68 * edge.strength * (edge.rejectedNull ? 1 : 0.35) + 0.32 * teStrength);
      return {
        source: edge.source,
        target: edge.target,
        lag: Math.max(edge.lag, te?.lag ?? edge.lag),
        strength,
        grangerP: edge.pValue,
        grangerQ: edge.qValue,
        transferEntropy: te?.transferEntropy ?? 0,
        method: edge.rejectedNull && teStrength > 0.02 ? "fused" as const : edge.rejectedNull ? "granger" as const : "transfer_entropy" as const
      };
    })
    .filter(edge => edge.strength > 0.02)
    .sort((a, b) => b.strength - a.strength);
}

function regressionRows(y: readonly number[], x: readonly number[], lag: number, includeX: boolean): { y: number[]; x: number[][] } {
  const n = Math.min(x.length, y.length);
  const outY: number[] = [];
  const outX: number[][] = [];
  for (let t = lag; t < n; t++) {
    const row = [1];
    for (let k = 1; k <= lag; k++) row.push(y[t - k] ?? 0);
    if (includeX) for (let k = 1; k <= lag; k++) row.push(x[t - k] ?? 0);
    outY.push(y[t] ?? 0);
    outX.push(row);
  }
  return { y: outY, x: outX };
}

function olsRss(y: readonly number[], x: readonly number[][]): { beta: number[]; rss: number } {
  if (!x.length) return { beta: [], rss: 0 };
  const cols = x[0]?.length ?? 0;
  const xtx = Array.from({ length: cols }, () => new Array<number>(cols).fill(0));
  const xty = new Array<number>(cols).fill(0);
  for (let r = 0; r < x.length; r++) {
    const row = x[r]!;
    for (let i = 0; i < cols; i++) {
      xty[i] = (xty[i] ?? 0) + (row[i] ?? 0) * (y[r] ?? 0);
      for (let j = 0; j < cols; j++) xtx[i]![j] = (xtx[i]![j] ?? 0) + (row[i] ?? 0) * (row[j] ?? 0);
    }
  }
  for (let i = 0; i < cols; i++) xtx[i]![i] = (xtx[i]![i] ?? 0) + 1e-8;
  const beta = solve(xtx, xty);
  const rss = y.reduce((sum, observed, r) => {
    const predicted = (x[r] ?? []).reduce((s, value, i) => s + value * (beta[i] ?? 0), 0);
    return sum + (observed - predicted) ** 2;
  }, 0);
  return { beta, rss };
}

function solve(a: number[][], b: number[]): number[] {
  const n = b.length;
  const aug = a.map((row, i) => [...row, b[i] ?? 0]);
  for (let col = 0; col < n; col++) {
    let pivot = col;
    for (let r = col + 1; r < n; r++) if (Math.abs(aug[r]?.[col] ?? 0) > Math.abs(aug[pivot]?.[col] ?? 0)) pivot = r;
    [aug[col], aug[pivot]] = [aug[pivot] ?? [], aug[col] ?? []];
    const div = aug[col]?.[col] ?? 0;
    if (Math.abs(div) < 1e-12) continue;
    for (let c = col; c <= n; c++) aug[col]![c] = (aug[col]![c] ?? 0) / div;
    for (let r = 0; r < n; r++) {
      if (r === col) continue;
      const factor = aug[r]?.[col] ?? 0;
      for (let c = col; c <= n; c++) aug[r]![c] = (aug[r]![c] ?? 0) - factor * (aug[col]![c] ?? 0);
    }
  }
  return aug.map(row => row[n] ?? 0);
}

function fSurvival(f: number, df1: number, df2: number): number {
  if (!Number.isFinite(f) || f <= 0) return 1;
  const x = (df1 * f) / (df1 * f + df2);
  return clamp01(1 - regularizedIncompleteBeta(x, df1 / 2, df2 / 2));
}

function regularizedIncompleteBeta(x: number, a: number, b: number): number {
  if (x <= 0) return 0;
  if (x >= 1) return 1;
  const bt = Math.exp(logGamma(a + b) - logGamma(a) - logGamma(b) + a * Math.log(x) + b * Math.log(1 - x));
  if (x < (a + 1) / (a + b + 2)) return bt * betaContinuedFraction(x, a, b) / a;
  return 1 - bt * betaContinuedFraction(1 - x, b, a) / b;
}

function betaContinuedFraction(x: number, a: number, b: number): number {
  const maxIterations = 100;
  const eps = 3e-7;
  const fpmin = 1e-30;
  let qab = a + b;
  let qap = a + 1;
  let qam = a - 1;
  let c = 1;
  let d = 1 - qab * x / qap;
  if (Math.abs(d) < fpmin) d = fpmin;
  d = 1 / d;
  let h = d;
  for (let m = 1; m <= maxIterations; m++) {
    const m2 = 2 * m;
    let aa = m * (b - m) * x / ((qam + m2) * (a + m2));
    d = 1 + aa * d;
    if (Math.abs(d) < fpmin) d = fpmin;
    c = 1 + aa / c;
    if (Math.abs(c) < fpmin) c = fpmin;
    d = 1 / d;
    h *= d * c;
    aa = -(a + m) * (qab + m) * x / ((a + m2) * (qap + m2));
    d = 1 + aa * d;
    if (Math.abs(d) < fpmin) d = fpmin;
    c = 1 + aa / c;
    if (Math.abs(c) < fpmin) c = fpmin;
    d = 1 / d;
    const del = d * c;
    h *= del;
    if (Math.abs(del - 1) < eps) break;
  }
  return h;
}

function logGamma(z: number): number {
  const cof = [76.18009172947146, -86.50532032941677, 24.01409824083091, -1.231739572450155, 0.001208650973866179, -0.000005395239384953];
  let x = z;
  let y = z;
  let tmp = x + 5.5;
  tmp -= (x + 0.5) * Math.log(tmp);
  let ser = 1.000000000190015;
  for (const c of cof) ser += c / ++y;
  return -tmp + Math.log(2.5066282746310005 * ser / x);
}

function stationarityScore(values: readonly number[]): number {
  if (values.length < 4) return 0;
  const ac = Math.abs(autocorrelation(values, 1));
  const drift = meanAbsDrift(values) / (Math.sqrt(variance(values)) + 1e-9);
  return clamp01(0.55 * (1 - ac) + 0.45 * (1 / (1 + drift)));
}

function autocorrelation(values: readonly number[], lag: number): number {
  if (values.length <= lag + 1) return 0;
  const m = mean(values);
  let num = 0;
  let den = 0;
  for (let i = 0; i < values.length; i++) {
    const centered = (values[i] ?? 0) - m;
    den += centered * centered;
    if (i >= lag) num += centered * ((values[i - lag] ?? 0) - m);
  }
  return den > 0 ? num / den : 0;
}

function meanAbsDrift(values: readonly number[]): number {
  if (values.length < 2) return 0;
  let total = 0;
  for (let i = 1; i < values.length; i++) total += Math.abs((values[i] ?? 0) - (values[i - 1] ?? 0));
  return total / (values.length - 1);
}

function difference(values: readonly number[]): number[] {
  const out: number[] = [];
  for (let i = 1; i < values.length; i++) out.push((values[i] ?? 0) - (values[i - 1] ?? 0));
  return out;
}

function clean(values: readonly number[]): number[] {
  return values.map(value => Number(value)).filter(Number.isFinite);
}

function alignFinite(values: readonly number[]): number[] {
  return clean(values);
}

function discretize(values: readonly number[], bins: number): number[] {
  const cleanValues = clean(values);
  if (!cleanValues.length) return [];
  const sorted = [...cleanValues].sort((a, b) => a - b);
  return cleanValues.map(value => {
    let rank = 0;
    while (rank < sorted.length && (sorted[rank] ?? 0) <= value) rank++;
    return Math.max(0, Math.min(bins - 1, Math.floor((rank / Math.max(1, sorted.length)) * bins)));
  });
}

function entropyOfBins(values: readonly number[]): number {
  const counts = new Map<number, number>();
  for (const value of values) counts.set(value, (counts.get(value) ?? 0) + 1);
  const total = Math.max(1, values.length);
  let h = 0;
  for (const count of counts.values()) {
    const p = count / total;
    if (p > 0) h -= p * Math.log2(p);
  }
  return h;
}

function inc(map: Map<string, number>, key: string): void {
  map.set(key, (map.get(key) ?? 0) + 1);
}

function split3(key: string): [string, string, string] {
  const parts = key.split("|");
  return [parts[0] ?? "", parts[1] ?? "", parts.slice(2).join("|")];
}

function emptyGranger(source: string, target: string, lag: number): GrangerEdge {
  return { source, target, lag, fStatistic: 0, pValue: 1, qValue: 1, rejectedNull: false, restrictedRss: 0, unrestrictedRss: 0, strength: 0 };
}
