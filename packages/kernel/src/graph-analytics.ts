import type { GraphEdge, GraphNode, GraphSlice, JsonValue } from "./types.js";
import { clamp01, entropy, mean, toJsonValue } from "./primitives.js";
import { assessTransitionSpectralGap, jacobiEigenvaluesSymmetric, laplacian, zeros } from "./math.js";

export interface GraphAnalyticsReport {
  nodeCount: number;
  edgeCount: number;
  hyperedgeCount: number;
  typeCounts: Record<string, number>;
  components: Array<{ id: number; nodes: string[]; size: number; meanAlpha: number }>;
  centrality: Array<{ nodeId: string; degree: number; weightedDegree: number; ppfMass: number; betweennessProxy: number }>;
  spectral: {
    fiedler: number;
    /** Zero is a compatibility sentinel when spectralGapAvailable is false. */
    spectralGap: number;
    spectralGapAvailable: boolean;
    spectralGapReason: ReturnType<typeof assessTransitionSpectralGap>["reason"];
    spectralGapAssumptions: ReturnType<typeof assessTransitionSpectralGap>["assumptions"];
    spectralEntropy: number;
    eigenvalues: number[];
  };
  kCore: Array<{ nodeId: string; core: number }>;
  risks: Array<{ id: string; level: "info" | "warning" | "error"; message: string; evidence: JsonValue }>;
  audit: JsonValue;
}

export function analyzeGraph(slice: GraphSlice): GraphAnalyticsReport {
  const typeCounts = typeHistogram(slice.nodes);
  const components = connectedComponents(slice.nodes, slice.edges);
  const centrality = centralityReport(slice.nodes, slice.edges);
  const spectral = spectralReport(slice.nodes, slice.edges);
  const kCore = coreNumbers(slice.nodes, slice.edges);
  const risks = graphRisks(slice, components, spectral);
  return {
    nodeCount: slice.nodes.length,
    edgeCount: slice.edges.length,
    hyperedgeCount: slice.hyperedges.length,
    typeCounts,
    components,
    centrality,
    spectral,
    kCore,
    risks,
    audit: toJsonValue({ typeCounts, components: components.slice(0, 12), centrality: centrality.slice(0, 20), spectral, kCore: kCore.slice(0, 20), risks })
  };
}

function typeHistogram(nodes: readonly GraphNode[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const node of nodes) {
    const type = String((node.metadata as { type?: string }).type ?? node.typeId);
    out[type] = (out[type] ?? 0) + 1;
  }
  return out;
}

function connectedComponents(nodes: readonly GraphNode[], edges: readonly GraphEdge[]): GraphAnalyticsReport["components"] {
  const adj = adjacency(nodes, edges);
  const seen = new Set<string>();
  const out: GraphAnalyticsReport["components"] = [];
  const byId = new Map(nodes.map(node => [String(node.id), node]));
  for (const node of nodes) {
    const id = String(node.id);
    if (seen.has(id)) continue;
    const stack = [id];
    const comp: string[] = [];
    seen.add(id);
    while (stack.length) {
      const current = stack.pop()!;
      comp.push(current);
      for (const next of adj.get(current) ?? []) {
        if (!seen.has(next)) {
          seen.add(next);
          stack.push(next);
        }
      }
    }
    out.push({ id: out.length, nodes: comp, size: comp.length, meanAlpha: mean(comp.map(nodeId => byId.get(nodeId)?.alpha ?? 0)) });
  }
  return out.sort((a, b) => b.size - a.size);
}

function centralityReport(nodes: readonly GraphNode[], edges: readonly GraphEdge[]): GraphAnalyticsReport["centrality"] {
  const ids = nodes.map(node => String(node.id));
  const degree = new Map<string, number>();
  const weighted = new Map<string, number>();
  for (const edge of edges) {
    const s = String(edge.source);
    const t = String(edge.target);
    degree.set(s, (degree.get(s) ?? 0) + 1);
    degree.set(t, (degree.get(t) ?? 0) + 1);
    weighted.set(s, (weighted.get(s) ?? 0) + edge.weight * edge.alpha);
    weighted.set(t, (weighted.get(t) ?? 0) + edge.weight * edge.alpha);
  }
  const ppf = stationaryPerronFrobeniusMass(ids, edges);
  const between = betweennessProxy(ids, edges);
  return ids.map(nodeId => ({ nodeId, degree: degree.get(nodeId) ?? 0, weightedDegree: weighted.get(nodeId) ?? 0, ppfMass: ppf.get(nodeId) ?? 0, betweennessProxy: between.get(nodeId) ?? 0 })).sort((a, b) => b.ppfMass - a.ppfMass);
}

function spectralReport(nodes: readonly GraphNode[], edges: readonly GraphEdge[]): GraphAnalyticsReport["spectral"] {
  const ids = nodes.map(node => String(node.id));
  const l = laplacian(ids, edges.map(edge => ({ source: String(edge.source), target: String(edge.target), weight: edge.weight * edge.alpha })));
  const eigenvalues = jacobiEigenvaluesSymmetric(l.normalizedLaplacian.values, 100);
  const fiedler = eigenvalues.length > 1 ? eigenvalues[1] ?? 0 : 0;
  const transition = transitionMatrix(ids, edges);
  const gapAssessment = assessTransitionSpectralGap(transition);
  const spectralGap = gapAssessment.spectralGap;
  const positive = eigenvalues.map(value => Math.max(0, value));
  const total = positive.reduce((sum, value) => sum + value, 0);
  const spectralEntropy = total > 0 ? entropy(positive.map(value => value / total)) : 0;
  return {
    fiedler,
    spectralGap,
    spectralGapAvailable: gapAssessment.available,
    spectralGapReason: gapAssessment.reason,
    spectralGapAssumptions: gapAssessment.assumptions,
    spectralEntropy,
    eigenvalues: eigenvalues.slice(0, 64)
  };
}

function coreNumbers(nodes: readonly GraphNode[], edges: readonly GraphEdge[]): GraphAnalyticsReport["kCore"] {
  const adj = adjacency(nodes, edges);
  const degree = new Map([...adj.entries()].map(([id, set]) => [id, set.size]));
  const remaining = new Set(nodes.map(node => String(node.id)));
  const core = new Map<string, number>();
  let k = 0;
  while (remaining.size) {
    let progressed = false;
    for (const id of [...remaining]) {
      if ((degree.get(id) ?? 0) <= k) {
        remaining.delete(id);
        core.set(id, k);
        for (const n of adj.get(id) ?? []) degree.set(n, Math.max(0, (degree.get(n) ?? 0) - 1));
        progressed = true;
      }
    }
    if (!progressed) k++;
  }
  return [...core.entries()].map(([nodeId, value]) => ({ nodeId, core: value })).sort((a, b) => b.core - a.core);
}

function graphRisks(slice: GraphSlice, components: GraphAnalyticsReport["components"], spectral: GraphAnalyticsReport["spectral"]): GraphAnalyticsReport["risks"] {
  const risks: GraphAnalyticsReport["risks"] = [];
  if (slice.nodes.length === 0) risks.push({ id: "empty-graph", level: "error", message: "Graph slice is empty.", evidence: {} });
  if (components.length > 1 && components[0] && components[0].size / Math.max(1, slice.nodes.length) < 0.5) risks.push({ id: "fragmented-graph", level: "warning", message: "No dominant connected component.", evidence: { components: components.length } });
  if (spectral.spectralGapAvailable && spectral.spectralGap < 0.01 && slice.nodes.length > 4) {
    risks.push({ id: "slow-mixing", level: "warning", message: "The reversible transition-chain absolute spectral gap is small.", evidence: { spectralGap: spectral.spectralGap } });
  }
  if (!spectral.spectralGapAvailable && slice.nodes.length > 1) {
    risks.push({
      id: "transition-gap-unavailable",
      level: "info",
      message: "No reversible-chain spectral gap is reported because its assumptions were not established.",
      evidence: { reason: spectral.spectralGapReason, assumptions: spectral.spectralGapAssumptions }
    });
  }
  if (slice.hyperedges.length === 0 && slice.nodes.length > 3) risks.push({ id: "no-hyperedges", level: "info", message: "No higher-order evidence hyperedges returned.", evidence: {} });
  return risks;
}

function adjacency(nodes: readonly GraphNode[], edges: readonly GraphEdge[]): Map<string, Set<string>> {
  const out = new Map(nodes.map(node => [String(node.id), new Set<string>()]));
  for (const edge of edges) {
    out.get(String(edge.source))?.add(String(edge.target));
    out.get(String(edge.target))?.add(String(edge.source));
  }
  return out;
}

function stationaryPerronFrobeniusMass(ids: readonly string[], edges: readonly GraphEdge[]): Map<string, number> {
  const index = new Map(ids.map((id, i) => [id, i]));
  const n = ids.length;
  let mass = new Array<number>(n).fill(n ? 1 / n : 0);
  const out = new Map<number, Array<{ j: number; w: number }>>();
  for (const edge of edges) {
    const i = index.get(String(edge.source));
    const j = index.get(String(edge.target));
    if (i === undefined || j === undefined) continue;
    out.set(i, [...(out.get(i) ?? []), { j, w: edge.alpha * edge.weight }]);
  }
  for (let iter = 0; iter < 40; iter++) {
    const next = new Array<number>(n).fill(n ? 0.15 / n : 0);
    for (let i = 0; i < n; i++) {
      const row = out.get(i) ?? [];
      const total = row.reduce((sum, item) => sum + item.w, 0);
      if (total <= 0) {
        for (let j = 0; j < n; j++) next[j] = (next[j] ?? 0) + 0.85 * (mass[i] ?? 0) / Math.max(1, n);
      } else {
        for (const item of row) next[item.j] = (next[item.j] ?? 0) + 0.85 * (mass[i] ?? 0) * item.w / total;
      }
    }
    mass = next;
  }
  return new Map(ids.map((id, i) => [id, mass[i] ?? 0]));
}

function betweennessProxy(ids: readonly string[], edges: readonly GraphEdge[]): Map<string, number> {
  const adj = adjacencyFromIds(ids, edges);
  const score = new Map(ids.map(id => [id, 0]));
  for (const source of ids.slice(0, 128)) {
    const dist = bfs(source, adj);
    for (const [node, d] of dist) if (d > 1) score.set(node, (score.get(node) ?? 0) + 1 / d);
  }
  const max = Math.max(1, ...score.values());
  return new Map([...score.entries()].map(([id, value]) => [id, clamp01(value / max)]));
}

function adjacencyFromIds(ids: readonly string[], edges: readonly GraphEdge[]): Map<string, Set<string>> {
  const out = new Map(ids.map(id => [id, new Set<string>()]));
  for (const edge of edges) {
    out.get(String(edge.source))?.add(String(edge.target));
    out.get(String(edge.target))?.add(String(edge.source));
  }
  return out;
}

function bfs(source: string, adj: Map<string, Set<string>>): Map<string, number> {
  const dist = new Map([[source, 0]]);
  const queue = [source];
  for (let i = 0; i < queue.length; i++) {
    const current = queue[i]!;
    for (const next of adj.get(current) ?? []) {
      if (!dist.has(next)) {
        dist.set(next, (dist.get(current) ?? 0) + 1);
        queue.push(next);
      }
    }
  }
  return dist;
}

function transitionMatrix(ids: readonly string[], edges: readonly GraphEdge[]): number[][] {
  const index = new Map(ids.map((id, i) => [id, i]));
  const matrix = zeros(ids.length, ids.length);
  for (const edge of edges) {
    const i = index.get(String(edge.source));
    const j = index.get(String(edge.target));
    if (i === undefined || j === undefined) continue;
    matrix[i]![j] = (matrix[i]![j] ?? 0) + edge.alpha * edge.weight;
  }
  return matrix.map(row => {
    const total = row.reduce((sum, value) => sum + value, 0);
    return total > 0 ? row.map(value => value / total) : row.map(() => 1 / Math.max(1, row.length));
  });
}
