import type { EvidenceId, EvidenceSpan, GraphEdge, GraphNode, JsonValue } from "./types.js";
import { clamp01, entropy, mean, normalizeVector, toJsonValue, weightedJaccard } from "./primitives.js";
import { jacobiEigenvaluesSymmetric, spectralGapFromTransition } from "./math.js";

export interface WaldSprtState {
  alpha: number;
  beta: number;
  lambda0: number;
  lambda1: number;
  logLikelihoodRatio: number;
  n: number;
  upper: number;
  lower: number;
  decision: "continue" | "accept-h1" | "accept-h0";
}

export interface ChernoffResult {
  information: number;
  tStar: number;
  affinity: number;
  iterations: number;
}

export interface DavisKahanEnvelope {
  perturbationNorm: number;
  spectralGap: number;
  sinTheta: number;
  stable: boolean;
  reason: string;
}

export interface StabilityAdjustedSupportAssessment {
  sampledSupportLcb: number;
  projectedSupport: number;
  spectralStabilityPenalty: number;
  stabilityAdjustedSupport: number;
  accepted: boolean;
  delta: number;
  sampledSupportThreshold: number;
  stabilityAdjustedSupportThreshold: number;
  spectralPenaltyScale: number;
  sinTheta: number;
  sampleCount: number;
  details: JsonValue;
}

export interface SubspaceDriftEntropy {
  drift: number;
  entropy: number;
  margin: number;
  converged: boolean;
  adversarialPlateau: boolean;
  reason: string;
}

export interface MinimumCoverResult {
  selectedEvidenceIds: EvidenceId[];
  selectedFeatures: string[];
  coverage: number;
  codeLength: number;
  uncoveredFeatures: string[];
  audit: JsonValue;
}

export interface MediatorPathRedundancyPruningResult {
  keptEdges: GraphEdge[];
  prunedEdges: Array<{ edge: GraphEdge; mediator: GraphNode; redundancyScore: number; reason: string }>;
  audit: JsonValue;
}

export function createCausalMath() {
  return {
    waldSprt,
    hoeffdingLcb,
    chernoffInformation,
    holmStepDown,
    davisKahanSinTheta,
    mediatorPathRedundancyPruning,
    robbinsMonro,
    assessStabilityAdjustedSupport,
    subspaceDriftEntropy,
    causalMinimumCoverCoding
  };
}

export function waldSprt(input: {
  observations: readonly number[];
  alpha?: number;
  beta?: number;
  lambda0?: number;
  lambda1?: number;
  initial?: Pick<WaldSprtState, "logLikelihoodRatio" | "n">;
}): WaldSprtState {
  const alpha = input.alpha ?? 0.05;
  const beta = input.beta ?? 0.1;
  const lambda0 = input.lambda0 ?? 24;
  const lambda1 = input.lambda1 ?? 4;
  const upper = Math.log((1 - beta) / alpha);
  const lower = Math.log(beta / (1 - alpha));
  let llr = input.initial?.logLikelihoodRatio ?? 0;
  let n = input.initial?.n ?? 0;
  for (const raw of input.observations) {
    const x = Math.max(0, raw);
    llr += Math.log(lambda1 / lambda0) - (lambda1 - lambda0) * x;
    n++;
    if (llr >= upper) return { alpha, beta, lambda0, lambda1, logLikelihoodRatio: llr, n, upper, lower, decision: "accept-h1" };
    if (llr <= lower) return { alpha, beta, lambda0, lambda1, logLikelihoodRatio: llr, n, upper, lower, decision: "accept-h0" };
  }
  return { alpha, beta, lambda0, lambda1, logLikelihoodRatio: llr, n, upper, lower, decision: "continue" };
}

export function hoeffdingLcb(scores: readonly number[], delta = 0.05): number {
  if (scores.length === 0) return 0;
  return clamp01(mean(scores.map(clamp01)) - Math.sqrt(Math.log(1 / delta) / (2 * scores.length)));
}

export function chernoffInformation(pRaw: readonly number[], qRaw: readonly number[], tolerance = 1e-8): ChernoffResult {
  const n = Math.max(pRaw.length, qRaw.length);
  const p = normalizeVector(Array.from({ length: n }, (_, i) => Math.max(0, pRaw[i] ?? 0)), 1 / Math.max(1, n));
  const q = normalizeVector(Array.from({ length: n }, (_, i) => Math.max(0, qRaw[i] ?? 0)), 1 / Math.max(1, n));
  const phi = (t: number) => Math.log(p.reduce((sum, pi, i) => sum + Math.pow(Math.max(1e-300, pi), 1 - t) * Math.pow(Math.max(1e-300, q[i] ?? 0), t), 0));
  let a = 0;
  let b = 1;
  const gr = (Math.sqrt(5) - 1) / 2;
  let c = b - gr * (b - a);
  let d = a + gr * (b - a);
  let iterations = 0;
  while (Math.abs(b - a) > tolerance && iterations < 100) {
    if (phi(c) < phi(d)) {
      b = d;
      d = c;
      c = b - gr * (b - a);
    } else {
      a = c;
      c = d;
      d = a + gr * (b - a);
    }
    iterations++;
  }
  const tStar = (a + b) / 2;
  const affinity = Math.exp(phi(tStar));
  return { information: Math.max(0, -Math.log(Math.max(1e-300, affinity))), tStar, affinity, iterations };
}

export function holmStepDown(pValues: readonly { id: string; p: number }[], alpha = 0.05): { survivors: string[]; rejected: string[]; adjusted: Array<{ id: string; p: number; threshold: number; rejected: boolean }> } {
  const sorted = [...pValues].sort((a, b) => a.p - b.p || a.id.localeCompare(b.id));
  const adjusted: Array<{ id: string; p: number; threshold: number; rejected: boolean }> = [];
  let stopped = false;
  for (let i = 0; i < sorted.length; i++) {
    const item = sorted[i]!;
    const threshold = alpha / Math.max(1, sorted.length - i);
    const rejected = !stopped && item.p <= threshold;
    if (!rejected) stopped = true;
    adjusted.push({ id: item.id, p: item.p, threshold, rejected });
  }
  return { survivors: adjusted.filter(item => item.rejected).map(item => item.id), rejected: adjusted.filter(item => !item.rejected).map(item => item.id), adjusted };
}

export function davisKahanSinTheta(input: { base: number[][]; perturbed: number[][]; k?: number; priorGap?: number }): DavisKahanEnvelope {
  const n = Math.max(input.base.length, input.perturbed.length);
  const diff = Array.from({ length: n }, (_, r) => Array.from({ length: n }, (_, c) => (input.perturbed[r]?.[c] ?? 0) - (input.base[r]?.[c] ?? 0)));
  const perturbationNorm = spectralNormPower(diff);
  const eigen = jacobiEigenvaluesSymmetric(input.base).sort((a, b) => Math.abs(b) - Math.abs(a));
  const k = input.k ?? 1;
  const gap = input.priorGap ?? Math.max(1e-9, Math.abs((eigen[k - 1] ?? 0) - (eigen[k] ?? 0)));
  const sinTheta = clamp01(perturbationNorm / Math.max(1e-9, gap));
  return { perturbationNorm, spectralGap: gap, sinTheta, stable: sinTheta < 0.5, reason: sinTheta < 0.5 ? "davis-kahan-stable" : "unstable_subspace" };
}

export function mediatorPathRedundancyPruning(input: { nodes: GraphNode[]; edges: GraphEdge[] }): MediatorPathRedundancyPruningResult {
  const nodesById = new Map(input.nodes.map(node => [String(node.id), node]));
  const incoming = new Map<string, GraphEdge[]>();
  const outgoing = new Map<string, GraphEdge[]>();
  for (const edge of input.edges) {
    const source = String(edge.source);
    const target = String(edge.target);
    outgoing.set(source, [...(outgoing.get(source) ?? []), edge]);
    incoming.set(target, [...(incoming.get(target) ?? []), edge]);
  }
  const pruned: MediatorPathRedundancyPruningResult["prunedEdges"] = [];
  const kept: GraphEdge[] = [];
  for (const edge of input.edges) {
    const sourceOut = outgoing.get(String(edge.source)) ?? [];
    const targetIn = incoming.get(String(edge.target)) ?? [];
    let best: { mediator: GraphNode; score: number } | undefined;
    for (const out of sourceOut) {
      const mediatorId = String(out.target);
      if (mediatorId === String(edge.target)) continue;
      const mediatorToTarget = targetIn.find(candidate => String(candidate.source) === mediatorId);
      const mediator = nodesById.get(mediatorId);
      if (!mediatorToTarget || !mediator) continue;
      const score = clamp01(Math.min(out.weight, mediatorToTarget.weight) * weightedJaccard(out.evidenceIds.map(String), mediatorToTarget.evidenceIds.map(String)));
      if (!best || score > best.score) best = { mediator, score };
    }
    if (best && best.score >= Math.max(0.05, edge.weight * 0.65)) {
      pruned.push({
        edge,
        mediator: best.mediator,
        redundancyScore: best.score,
        reason: "redundant-direct-edge-via-supported-mediator-path"
      });
    }
    else kept.push(edge);
  }
  return {
    keptEdges: kept,
    prunedEdges: pruned,
    audit: toJsonValue({
      method: "mediator_path_redundancy_pruning",
      conditionalIndependenceTested: false,
      kept: kept.length,
      pruned: pruned.length,
      prunedEdges: pruned.slice(0, 64).map(item => ({ edge: item.edge.id, mediator: item.mediator.id, redundancyScore: item.redundancyScore }))
    })
  };
}

export function robbinsMonro(input: { previous: number; observation: number; n: number; target?: number; gainScale?: number }): { value: number; gain: number; residual: number } {
  const gain = (input.gainScale ?? 1) / Math.max(1, input.n);
  const residual = input.observation - (input.target ?? input.previous);
  return { value: input.previous + gain * residual, gain, residual };
}

export function assessStabilityAdjustedSupport(input: {
  supportSamples: readonly number[];
  projectedSupport: number;
  sinTheta: number;
  delta?: number;
  sampledSupportThreshold?: number;
  stabilityAdjustedSupportThreshold?: number;
  spectralPenaltyScale?: number;
}): StabilityAdjustedSupportAssessment {
  const delta = input.delta ?? 0.05;
  const sampledSupportThreshold = input.sampledSupportThreshold ?? 0.35;
  const stabilityAdjustedSupportThreshold = input.stabilityAdjustedSupportThreshold ?? 0.08;
  const spectralPenaltyScale = Math.max(0, input.spectralPenaltyScale ?? 1);
  const sinTheta = clamp01(input.sinTheta);
  const sampledSupportLcb = hoeffdingLcb(input.supportSamples, delta);
  const projectedSupport = clamp01(input.projectedSupport);
  const spectralStabilityPenalty = clamp01(spectralPenaltyScale * sinTheta);
  const stabilityAdjustedSupport = clamp01(projectedSupport - spectralStabilityPenalty);
  const accepted = sampledSupportLcb >= sampledSupportThreshold && stabilityAdjustedSupport >= stabilityAdjustedSupportThreshold;
  return {
    sampledSupportLcb,
    projectedSupport,
    spectralStabilityPenalty,
    stabilityAdjustedSupport,
    accepted,
    delta,
    sampledSupportThreshold,
    stabilityAdjustedSupportThreshold,
    spectralPenaltyScale,
    sinTheta,
    sampleCount: input.supportSamples.length,
    details: toJsonValue({
      supportSamples: input.supportSamples,
      projectedSupport,
      sampledSupportLcb,
      spectralStabilityPenalty,
      stabilityAdjustedSupport
    })
  };
}

export function subspaceDriftEntropy(input: { previous: readonly number[]; current: readonly number[]; driftThreshold?: number; entropyFloor?: number; margin?: number }): SubspaceDriftEntropy {
  const p = normalizeVector([...input.previous], 1 / Math.max(1, input.previous.length));
  const q = normalizeVector([...input.current], 1 / Math.max(1, input.current.length));
  const drift = l1(p, q);
  const h = entropy(q);
  const maxEntropy = Math.log2(Math.max(2, q.length));
  const normalizedEntropy = maxEntropy > 0 ? h / maxEntropy : 0;
  const margin = (input.margin ?? 0.15) - drift;
  const adversarialPlateau = drift <= (input.driftThreshold ?? 0.02) && normalizedEntropy >= (input.entropyFloor ?? 0.92);
  const converged = drift <= (input.driftThreshold ?? 0.02) && !adversarialPlateau && margin >= 0;
  return { drift, entropy: normalizedEntropy, margin, converged, adversarialPlateau, reason: adversarialPlateau ? "adversarial-maximum-spread-plateau" : converged ? "sde-converged" : "sde-continue" };
}

export function causalMinimumCoverCoding(input: { claimFeatures: readonly string[]; evidence: readonly EvidenceSpan[]; maxEvidence?: number; lambda?: number }): MinimumCoverResult {
  const uncovered = new Set(input.claimFeatures.filter(feature => feature.startsWith("sym:") || feature.startsWith("bi:")));
  const selected: EvidenceSpan[] = [];
  const lambda = input.lambda ?? 0.18;
  while (uncovered.size && selected.length < (input.maxEvidence ?? 8)) {
    let best: { span: EvidenceSpan; gain: number; cost: number; score: number } | undefined;
    for (const span of input.evidence) {
      if (selected.some(item => item.id === span.id)) continue;
      const gain = span.features.filter(feature => uncovered.has(feature)).length;
      const cost = Math.log2(2 + span.text.length) + lambda * (1 - span.alpha) * 10;
      const score = gain / Math.max(1e-9, cost);
      if (!best || score > best.score) best = { span, gain, cost, score };
    }
    if (!best || best.gain <= 0) break;
    selected.push(best.span);
    for (const feature of best.span.features) uncovered.delete(feature);
  }
  const selectedFeatures = [...new Set(selected.flatMap(span => span.features))];
  const total = input.claimFeatures.filter(feature => feature.startsWith("sym:") || feature.startsWith("bi:")).length;
  const coverage = total ? 1 - uncovered.size / total : selected.length ? 1 : 0;
  const codeLength = selected.reduce((sum, span) => sum + Math.log2(2 + span.text.length) - Math.log2(1 + span.alpha), 0);
  return {
    selectedEvidenceIds: selected.map(span => span.id),
    selectedFeatures,
    coverage,
    codeLength,
    uncoveredFeatures: [...uncovered].sort(),
    audit: toJsonValue({ selected: selected.map(span => ({ id: span.id, alpha: span.alpha, bytes: span.byteEnd - span.byteStart })), coverage, codeLength, uncovered: [...uncovered].slice(0, 64) })
  };
}

function spectralNormPower(matrix: number[][]): number {
  const n = matrix.length;
  if (!n) return 0;
  let v = normalizeVector(new Array<number>(n).fill(1 / n));
  for (let iter = 0; iter < 40; iter++) {
    const mv = matrix.map(row => row.reduce((sum, value, i) => sum + value * (v[i] ?? 0), 0));
    const norm = Math.sqrt(mv.reduce((sum, value) => sum + value * value, 0));
    if (norm <= 1e-18) return 0;
    v = mv.map(value => value / norm);
  }
  const mv = matrix.map(row => row.reduce((sum, value, i) => sum + value * (v[i] ?? 0), 0));
  return Math.sqrt(mv.reduce((sum, value) => sum + value * value, 0));
}

function l1(a: readonly number[], b: readonly number[]): number {
  const n = Math.max(a.length, b.length);
  let sum = 0;
  for (let i = 0; i < n; i++) sum += Math.abs((a[i] ?? 0) - (b[i] ?? 0));
  return sum;
}

export function transitionSpectralGap(transition: number[][]): number {
  return spectralGapFromTransition(transition);
}
