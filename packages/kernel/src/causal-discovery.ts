import type { JsonValue } from "./types.js";
import { benjaminiHochberg, grangerTest, selectLagByAic, stationarize, transferEntropy, type GrangerEdge, type TemporalSeries, type TransferEntropyEdge } from "./temporal-causal.js";
import { clamp01, mean, toJsonValue, variance } from "./primitives.js";

export interface PcmciLink {
  source: string;
  target: string;
  lag: number;
  partialCorrelation: number;
  pValue: number;
  qValue: number;
  accepted: boolean;
  conditioningSet: string[];
  strength: number;
}

export interface ReichenbachScreen {
  commonCause: string;
  left: string;
  right: string;
  lag: number;
  rawCorrelation: number;
  conditionedCorrelation: number;
  screeningOff: number;
  accepted: boolean;
}

export interface CausalDiscoveryReport {
  grangerEdges: GrangerEdge[];
  transferEntropyEdges: TransferEntropyEdge[];
  pcmciLinks: PcmciLink[];
  reichenbachScreens: ReichenbachScreen[];
  fused: Array<{ source: string; target: string; lag: number; strength: number; methods: string[] }>;
  audit: JsonValue;
}

export function createTemporalCausalDiscoveryEngine() {
  return {
    discover(input: { series: readonly TemporalSeries[]; maxLag?: number; fdrQ?: number; minSamples?: number; transferEntropyBins?: number }): CausalDiscoveryReport {
      const minSamples = input.minSamples ?? 24;
      const stationary = input.series.map(series => stationarize(series, 2)).filter(series => series.transformed.length >= minSamples);
      const maxLag = Math.max(1, input.maxLag ?? Math.min(8, Math.floor(Math.min(...stationary.map(series => series.transformed.length)) / 6) || 1));
      const grangerRaw: GrangerEdge[] = [];
      const te: TransferEntropyEdge[] = [];
      for (const source of stationary) {
        for (const target of stationary) {
          if (source.id === target.id) continue;
          const lag = selectLagByAic(source.transformed, target.transformed, maxLag);
          grangerRaw.push(grangerTest(source.id, target.id, source.transformed, target.transformed, lag));
          te.push(transferEntropy(source.id, target.id, source.transformed, target.transformed, lag, input.transferEntropyBins ?? 5));
        }
      }
      const grangerEdges = benjaminiHochberg(grangerRaw, input.fdrQ ?? 0.1);
      const pcmciLinks = pcmci(stationary.map(series => ({ id: series.id, values: series.transformed })), maxLag, input.fdrQ ?? 0.1);
      const reichenbachScreens = reichenbach(stationary.map(series => ({ id: series.id, values: series.transformed })), maxLag);
      const fused = fuse(grangerEdges, te, pcmciLinks, reichenbachScreens);
      return {
        grangerEdges,
        transferEntropyEdges: te.sort((a, b) => b.normalized - a.normalized),
        pcmciLinks,
        reichenbachScreens,
        fused,
        audit: toJsonValue({
          series: input.series.length,
          usable: stationary.length,
          maxLag,
          grangerAccepted: grangerEdges.filter(edge => edge.rejectedNull).length,
          pcmciAccepted: pcmciLinks.filter(edge => edge.accepted).length,
          reichenbachAccepted: reichenbachScreens.filter(screen => screen.accepted).length,
          fused: fused.length
        })
      };
    }
  };
}

function pcmci(series: readonly { id: string; values: number[] }[], maxLag: number, fdrQ: number): PcmciLink[] {
  const raw: PcmciLink[] = [];
  for (const source of series) {
    for (const target of series) {
      if (source.id === target.id) continue;
      for (let lag = 1; lag <= maxLag; lag++) {
        const rows = laggedRows(series, target.id, source.id, lag);
        if (rows.y.length < 8) continue;
        const conditioning = rows.conditioning.filter(item => item.id !== source.id);
        const xResidual = residualize(rows.x, conditioning.map(item => item.values));
        const yResidual = residualize(rows.y, conditioning.map(item => item.values));
        const pc = correlation(xResidual, yResidual);
        const pValue = correlationPValue(pc, xResidual.length, conditioning.length);
        raw.push({
          source: source.id,
          target: target.id,
          lag,
          partialCorrelation: pc,
          pValue,
          qValue: pValue,
          accepted: false,
          conditioningSet: conditioning.map(item => item.id),
          strength: clamp01(Math.abs(pc))
        });
      }
    }
  }
  return bhPcmci(raw, fdrQ);
}

function reichenbach(series: readonly { id: string; values: number[] }[], maxLag: number): ReichenbachScreen[] {
  const out: ReichenbachScreen[] = [];
  for (const cause of series) {
    for (const left of series) {
      for (const right of series) {
        if (cause.id === left.id || cause.id === right.id || left.id >= right.id) continue;
        for (let lag = 1; lag <= maxLag; lag++) {
          const rows = commonCauseRows(cause.values, left.values, right.values, lag);
          if (rows.cause.length < 8) continue;
          const raw = Math.abs(correlation(rows.left, rows.right));
          const leftResidual = residualize(rows.left, [rows.cause]);
          const rightResidual = residualize(rows.right, [rows.cause]);
          const conditioned = Math.abs(correlation(leftResidual, rightResidual));
          const screeningOff = clamp01((raw - conditioned) / Math.max(1e-9, raw));
          out.push({ commonCause: cause.id, left: left.id, right: right.id, lag, rawCorrelation: raw, conditionedCorrelation: conditioned, screeningOff, accepted: raw > 0.15 && screeningOff > 0.3 });
        }
      }
    }
  }
  return out.sort((a, b) => b.screeningOff - a.screeningOff).slice(0, 512);
}

function laggedRows(series: readonly { id: string; values: number[] }[], targetId: string, sourceId: string, lag: number): { y: number[]; x: number[]; conditioning: Array<{ id: string; values: number[] }> } {
  const target = series.find(item => item.id === targetId)?.values ?? [];
  const source = series.find(item => item.id === sourceId)?.values ?? [];
  const n = Math.min(target.length, source.length, ...series.map(item => item.values.length));
  const y: number[] = [];
  const x: number[] = [];
  const conditioning = series.map(item => ({ id: item.id, values: [] as number[] }));
  for (let t = lag; t < n; t++) {
    y.push(target[t] ?? 0);
    x.push(source[t - lag] ?? 0);
    for (const row of conditioning) {
      const values = series.find(item => item.id === row.id)?.values ?? [];
      row.values.push(values[t - lag] ?? 0);
    }
  }
  return { y, x, conditioning };
}

function commonCauseRows(cause: readonly number[], left: readonly number[], right: readonly number[], lag: number): { cause: number[]; left: number[]; right: number[] } {
  const n = Math.min(cause.length, left.length, right.length);
  const out = { cause: [] as number[], left: [] as number[], right: [] as number[] };
  for (let t = lag; t < n; t++) {
    out.cause.push(cause[t - lag] ?? 0);
    out.left.push(left[t] ?? 0);
    out.right.push(right[t] ?? 0);
  }
  return out;
}

function residualize(y: readonly number[], xs: readonly number[][]): number[] {
  const usable = xs.filter(row => row.length === y.length);
  if (!usable.length) return [...y];
  const rows = y.map((_, i) => [1, ...usable.map(x => x[i] ?? 0)]);
  const beta = ridge(rows, [...y], 1e-6);
  return y.map((value, i) => value - rows[i]!.reduce((sum, x, j) => sum + x * (beta[j] ?? 0), 0));
}

function ridge(x: number[][], y: number[], lambda: number): number[] {
  const cols = x[0]?.length ?? 0;
  const xtx = Array.from({ length: cols }, () => new Array<number>(cols).fill(0));
  const xty = new Array<number>(cols).fill(0);
  for (let r = 0; r < x.length; r++) {
    for (let i = 0; i < cols; i++) {
      xty[i] = (xty[i] ?? 0) + (x[r]?.[i] ?? 0) * (y[r] ?? 0);
      for (let j = 0; j < cols; j++) xtx[i]![j] = (xtx[i]![j] ?? 0) + (x[r]?.[i] ?? 0) * (x[r]?.[j] ?? 0);
    }
  }
  for (let i = 0; i < cols; i++) xtx[i]![i] = (xtx[i]![i] ?? 0) + lambda;
  return solve(xtx, xty);
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

function correlation(a: readonly number[], b: readonly number[]): number {
  const n = Math.min(a.length, b.length);
  if (n < 3) return 0;
  const ma = mean(a.slice(0, n));
  const mb = mean(b.slice(0, n));
  const sa = Math.sqrt(variance(a.slice(0, n)));
  const sb = Math.sqrt(variance(b.slice(0, n)));
  if (sa <= 1e-12 || sb <= 1e-12) return 0;
  let cov = 0;
  for (let i = 0; i < n; i++) cov += ((a[i] ?? 0) - ma) * ((b[i] ?? 0) - mb);
  return Math.max(-1, Math.min(1, cov / ((n - 1) * sa * sb)));
}

function correlationPValue(r: number, n: number, conditioned: number): number {
  const df = Math.max(1, n - conditioned - 2);
  const t = Math.abs(r) * Math.sqrt(df / Math.max(1e-12, 1 - r * r));
  return clamp01(2 * (1 - normalCdf(t)));
}

function normalCdf(x: number): number {
  return 0.5 * (1 + erf(x / Math.SQRT2));
}

function erf(x: number): number {
  const sign = x < 0 ? -1 : 1;
  const z = Math.abs(x);
  const t = 1 / (1 + 0.3275911 * z);
  const y = 1 - (((((1.061405429 * t - 1.453152027) * t) + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-z * z);
  return sign * y;
}

function bhPcmci(edges: readonly PcmciLink[], q: number): PcmciLink[] {
  const sorted = [...edges].sort((a, b) => a.pValue - b.pValue);
  let largest = -1;
  for (let i = 0; i < sorted.length; i++) if ((sorted[i]?.pValue ?? 1) <= ((i + 1) / Math.max(1, sorted.length)) * q) largest = i;
  return sorted.map((edge, i) => ({ ...edge, qValue: Math.min(1, edge.pValue * sorted.length / Math.max(1, i + 1)), accepted: i <= largest })).sort((a, b) => Number(b.accepted) - Number(a.accepted) || b.strength - a.strength);
}

function fuse(granger: readonly GrangerEdge[], te: readonly TransferEntropyEdge[], pcmci: readonly PcmciLink[], screens: readonly ReichenbachScreen[]): CausalDiscoveryReport["fused"] {
  const byPair = new Map<string, { source: string; target: string; lag: number; strength: number; methods: Set<string> }>();
  const add = (source: string, target: string, lag: number, strength: number, method: string) => {
    const key = `${source}->${target}`;
    const row = byPair.get(key) ?? { source, target, lag, strength: 0, methods: new Set<string>() };
    row.lag = Math.max(row.lag, lag);
    row.strength = clamp01(row.strength + strength * (1 - row.strength));
    row.methods.add(method);
    byPair.set(key, row);
  };
  for (const edge of granger) if (edge.rejectedNull) add(edge.source, edge.target, edge.lag, edge.strength, "granger");
  for (const edge of te) if (edge.normalized > 0.02) add(edge.source, edge.target, edge.lag, edge.normalized, "transfer_entropy");
  for (const edge of pcmci) if (edge.accepted) add(edge.source, edge.target, edge.lag, edge.strength, "pcmci");
  for (const screen of screens) if (screen.accepted) {
    add(screen.commonCause, screen.left, screen.lag, screen.screeningOff, "reichenbach");
    add(screen.commonCause, screen.right, screen.lag, screen.screeningOff, "reichenbach");
  }
  return [...byPair.values()].map(row => ({ ...row, methods: [...row.methods].sort() })).sort((a, b) => b.strength - a.strength);
}
