import type { AlphaTrace, FieldState, GraphSnapshot, Hasher, JsonValue, MatrixSnapshot, NodeId } from "./types.js";
import { clamp01, cosineSimilarity, createHasher, mean, normalizeVector, toJsonValue, weightedJaccard } from "./primitives.js";

export interface GraphFingerprint {
  id: string;
  nodeCount: number;
  edgeCount: number;
  hyperedgeCount: number;
  nodeHash: string;
  edgeHash: string;
  alphaHash: string;
  topologyHash: string;
}

export interface PersonalizedSeedVector {
  nodes: string[];
  values: number[];
  entropy: number;
  support: number;
  seedHash: string;
}

export interface PerronFrobeniusDiagnostics {
  dominantEigenvalue: number;
  spectralGap: number;
  residual: number;
  iterations: number;
  stationary: Array<{ nodeId: NodeId; mass: number }>;
  conductance: number;
  irreducibilityScore: number;
  aperiodicityScore: number;
  audit: JsonValue;
}

export interface AlphaPersistenceRecord {
  cacheKey: string;
  graphFingerprint: GraphFingerprint;
  requestHash: string;
  fieldHash: string;
  seed: PersonalizedSeedVector;
  ppf: Array<{ nodeId: NodeId; mass: number }>;
  alphaTrace: AlphaTrace;
  diagnostics: PerronFrobeniusDiagnostics;
  createdAt: number;
  expiresAt: number;
  invalidation: AlphaInvalidationRule[];
}

export interface AlphaInvalidationRule {
  id: string;
  reason: "topology_changed" | "alpha_changed" | "seed_drift" | "contradiction_pressure" | "policy_epoch" | "expired";
  threshold: number;
  observed: number;
  invalidates: boolean;
}

export interface AlphaReuseDecision {
  reuse: boolean;
  score: number;
  rules: AlphaInvalidationRule[];
  cacheKey: string;
  audit: JsonValue;
}

export function createAlphaFieldPersistence(options: { hasher?: Hasher; halfLifeMs?: number; tolerance?: number } = {}) {
  const hasher = options.hasher ?? createHasher();
  const halfLifeMs = Math.max(1000, options.halfLifeMs ?? 15 * 60 * 1000);
  const tolerance = Math.max(1e-9, options.tolerance ?? 1e-7);
  return {
    fingerprint(graph: GraphSnapshot): GraphFingerprint {
      return graphFingerprint(graph, hasher);
    },

    seedVector(input: { graph: GraphSnapshot; requestFeatures: string[]; prior?: FieldState }): PersonalizedSeedVector {
      return personalizedSeedVector(input, hasher);
    },

    diagnostics(input: { graph: GraphSnapshot; seed?: PersonalizedSeedVector; damping?: number; maxIterations?: number }): PerronFrobeniusDiagnostics {
      const fingerprint = graphFingerprint(input.graph, hasher);
      const matrix = transitionMatrix(input.graph);
      const seed = input.seed ?? uniformSeed(input.graph, hasher);
      return perronFrobeniusDiagnostics({ graph: input.graph, fingerprint, matrix, seed, damping: input.damping ?? 0.85, maxIterations: input.maxIterations ?? 200, tolerance });
    },

    record(input: {
      graph: GraphSnapshot;
      requestText: string;
      requestFeatures: string[];
      field: FieldState;
      createdAt: number;
      ttlMs?: number;
      policyEpoch?: string;
    }): AlphaPersistenceRecord {
      const fingerprint = graphFingerprint(input.graph, hasher);
      const seed = personalizedSeedVector({ graph: input.graph, requestFeatures: input.requestFeatures, prior: input.field }, hasher);
      const diagnostics = perronFrobeniusDiagnostics({
        graph: input.graph,
        fingerprint,
        matrix: transitionMatrix(input.graph),
        seed,
        damping: 0.85,
        maxIterations: 200,
        tolerance
      });
      const requestHash = hasher.digestHex(input.requestText);
      const fieldHash = hasher.digestHex(JSON.stringify({ ppf: input.field.ppf, active: input.field.active, surfaces: input.field.alphaTrace.surfaces }));
      const cacheKey = cacheKeyFor({ fingerprint, requestHash, seedHash: seed.seedHash, policyEpoch: input.policyEpoch ?? "default" }, hasher);
      const expiresAt = input.createdAt + (input.ttlMs ?? halfLifeMs);
      return {
        cacheKey,
        graphFingerprint: fingerprint,
        requestHash,
        fieldHash,
        seed,
        ppf: input.field.ppf,
        alphaTrace: input.field.alphaTrace,
        diagnostics,
        createdAt: input.createdAt,
        expiresAt,
        invalidation: []
      };
    },

    decideReuse(input: {
      record: AlphaPersistenceRecord;
      graph: GraphSnapshot;
      requestText: string;
      requestFeatures: string[];
      now: number;
      field?: FieldState;
      policyEpoch?: string;
    }): AlphaReuseDecision {
      const nextFingerprint = graphFingerprint(input.graph, hasher);
      const nextSeed = personalizedSeedVector({ graph: input.graph, requestFeatures: input.requestFeatures, prior: input.field }, hasher);
      const requestHash = hasher.digestHex(input.requestText);
      const cacheKey = cacheKeyFor({ fingerprint: nextFingerprint, requestHash, seedHash: nextSeed.seedHash, policyEpoch: input.policyEpoch ?? "default" }, hasher);
      const rules = invalidationRules({
        record: input.record,
        nextFingerprint,
        nextSeed,
        requestHash,
        now: input.now,
        field: input.field,
        policyEpochChanged: cacheKey !== input.record.cacheKey
      });
      const score = clamp01(1 - mean(rules.map(rule => rule.invalidates ? 1 : rule.observed / Math.max(rule.threshold, 1e-9))));
      return {
        reuse: rules.every(rule => !rule.invalidates),
        score,
        rules,
        cacheKey,
        audit: toJsonValue({ cacheKey, priorKey: input.record.cacheKey, score, rules })
      };
    },

    projectCachedField(record: AlphaPersistenceRecord): FieldState {
      return {
        requestFeatures: [],
        seeds: record.seed.nodes.map((nodeId, index) => ({ nodeId: nodeId as NodeId, feature: "cached_seed", weight: record.seed.values[index] ?? 0 })),
        active: record.diagnostics.stationary.map(item => ({ nodeId: item.nodeId, activation: item.mass })),
        ppf: record.ppf,
        ppfDiagnostics: record.diagnostics.audit,
        alphaTrace: record.alphaTrace,
        causalMass: []
      };
    }
  };
}

function graphFingerprint(graph: GraphSnapshot, hasher: Hasher): GraphFingerprint {
  const nodePayload = graph.nodes
    .map(node => ({ id: node.id, typeId: node.typeId, alpha: round(node.alpha), features: node.features.slice(0, 64), evidenceIds: node.evidenceIds.slice(0, 32) }))
    .sort((a, b) => String(a.id).localeCompare(String(b.id)));
  const edgePayload = graph.edges
    .map(edge => ({ id: edge.id, source: edge.source, target: edge.target, relationId: edge.relationId, alpha: round(edge.alpha), weight: round(edge.weight), evidenceIds: edge.evidenceIds.slice(0, 32) }))
    .sort((a, b) => String(a.id).localeCompare(String(b.id)));
  const alphaPayload = {
    nodes: nodePayload.map(node => [node.id, node.alpha]),
    edges: edgePayload.map(edge => [edge.id, edge.alpha, edge.weight])
  };
  const topologyPayload = {
    nodes: nodePayload.map(node => node.id),
    edges: edgePayload.map(edge => [edge.source, edge.relationId, edge.target])
  };
  const nodeHash = hasher.digestHex(JSON.stringify(nodePayload));
  const edgeHash = hasher.digestHex(JSON.stringify(edgePayload));
  const alphaHash = hasher.digestHex(JSON.stringify(alphaPayload));
  const topologyHash = hasher.digestHex(JSON.stringify(topologyPayload));
  return {
    id: `graph_fp_${hasher.digestHex(`${nodeHash}:${edgeHash}:${alphaHash}:${topologyHash}`).slice(0, 32)}`,
    nodeCount: graph.nodes.length,
    edgeCount: graph.edges.length,
    hyperedgeCount: graph.hyperedges.length,
    nodeHash,
    edgeHash,
    alphaHash,
    topologyHash
  };
}

function personalizedSeedVector(input: { graph: GraphSnapshot; requestFeatures: string[]; prior?: FieldState }, hasher: Hasher): PersonalizedSeedVector {
  const nodes = input.graph.nodes.map(node => String(node.id));
  const priorMass = new Map<string, number>();
  for (const item of input.prior?.ppf ?? []) priorMass.set(String(item.nodeId), Math.max(priorMass.get(String(item.nodeId)) ?? 0, item.mass));
  for (const item of input.prior?.active ?? []) priorMass.set(String(item.nodeId), Math.max(priorMass.get(String(item.nodeId)) ?? 0, item.activation));
  const values = input.graph.nodes.map(node => {
    const featureCoupling = weightedJaccard(input.requestFeatures, node.features);
    const evidenceCoupling = node.evidenceIds.length ? Math.min(1, node.evidenceIds.length / 8) : 0;
    const prior = priorMass.get(String(node.id)) ?? 0;
    return Math.max(0, 0.48 * featureCoupling + 0.18 * evidenceCoupling + 0.22 * node.alpha + 0.12 * prior);
  });
  const normalized = normalizeVector(values, nodes.length ? 1 / nodes.length : 0);
  return {
    nodes,
    values: normalized,
    entropy: shannon(normalized),
    support: normalized.filter(value => value > 0).length / Math.max(1, normalized.length),
    seedHash: hasher.digestHex(JSON.stringify({ nodes, values: normalized.map(round) }))
  };
}

function uniformSeed(graph: GraphSnapshot, hasher: Hasher): PersonalizedSeedVector {
  const nodes = graph.nodes.map(node => String(node.id));
  const values = nodes.map(() => nodes.length ? 1 / nodes.length : 0);
  return {
    nodes,
    values,
    entropy: shannon(values),
    support: nodes.length ? 1 : 0,
    seedHash: hasher.digestHex(JSON.stringify({ nodes, values }))
  };
}

function transitionMatrix(graph: GraphSnapshot): number[][] {
  const nodes = graph.nodes.map(node => String(node.id));
  const index = new Map(nodes.map((id, i) => [id, i]));
  const matrix = nodes.map(() => new Array<number>(nodes.length).fill(0));
  for (let i = 0; i < nodes.length; i++) matrix[i]![i] = 0.02;
  for (const edge of graph.edges) {
    const source = index.get(String(edge.source));
    const target = index.get(String(edge.target));
    if (source === undefined || target === undefined) continue;
    const weight = Math.max(0, edge.weight) * (0.35 + 0.65 * clamp01(edge.alpha));
    matrix[source]![target] = (matrix[source]![target] ?? 0) + weight;
    matrix[target]![source] = (matrix[target]![source] ?? 0) + weight * 0.18;
  }
  for (let row = 0; row < matrix.length; row++) {
    const total = matrix[row]!.reduce((sum, value) => sum + Math.max(0, value), 0);
    if (total <= 0) {
      for (let col = 0; col < matrix.length; col++) matrix[row]![col] = matrix.length ? 1 / matrix.length : 0;
    } else {
      for (let col = 0; col < matrix.length; col++) matrix[row]![col] = Math.max(0, matrix[row]![col] ?? 0) / total;
    }
  }
  return matrix;
}

function perronFrobeniusDiagnostics(input: {
  graph: GraphSnapshot;
  fingerprint: GraphFingerprint;
  matrix: number[][];
  seed: PersonalizedSeedVector;
  damping: number;
  maxIterations: number;
  tolerance: number;
}): PerronFrobeniusDiagnostics {
  const n = input.matrix.length;
  if (n === 0) {
    return { dominantEigenvalue: 0, spectralGap: 0, residual: 0, iterations: 0, stationary: [], conductance: 0, irreducibilityScore: 0, aperiodicityScore: 0, audit: toJsonValue({ empty: true }) };
  }
  let vector = normalizeVector(input.seed.values.slice(0, n), 1 / n);
  let residual = Number.POSITIVE_INFINITY;
  let iterations = 0;
  const damping = clamp01(input.damping);
  const teleport = normalizeVector(input.seed.values.slice(0, n), 1 / n);
  while (iterations < input.maxIterations && residual > input.tolerance) {
    const next = new Array<number>(n).fill(0);
    for (let row = 0; row < n; row++) {
      const mass = vector[row] ?? 0;
      for (let col = 0; col < n; col++) next[col] = (next[col] ?? 0) + damping * mass * (input.matrix[row]?.[col] ?? 0);
    }
    for (let col = 0; col < n; col++) next[col] = (next[col] ?? 0) + (1 - damping) * (teleport[col] ?? 0);
    const normalized = normalizeVector(next, 1 / n);
    residual = l1(vector, normalized);
    vector = normalized;
    iterations++;
  }
  const second = secondEigenEstimate(input.matrix, vector, damping);
  const dominantEigenvalue = rayleighQuotient(input.matrix, vector);
  const spectralGap = clamp01(Math.abs(dominantEigenvalue - second));
  const stationary = input.graph.nodes
    .map((node, index) => ({ nodeId: node.id, mass: vector[index] ?? 0 }))
    .sort((a, b) => b.mass - a.mass || String(a.nodeId).localeCompare(String(b.nodeId)));
  const conductance = approximateConductance(input.matrix, vector);
  const irreducibilityScore = irreducibility(input.matrix);
  const aperiodicityScore = aperiodicity(input.matrix);
  return {
    dominantEigenvalue,
    spectralGap,
    residual,
    iterations,
    stationary,
    conductance,
    irreducibilityScore,
    aperiodicityScore,
    audit: toJsonValue({
      fingerprint: input.fingerprint,
      damping,
      tolerance: input.tolerance,
      seed: { entropy: input.seed.entropy, support: input.seed.support, seedHash: input.seed.seedHash },
      convergence: { residual, iterations, dominantEigenvalue, spectralGap },
      graphHealth: { conductance, irreducibilityScore, aperiodicityScore }
    })
  };
}

function invalidationRules(input: {
  record: AlphaPersistenceRecord;
  nextFingerprint: GraphFingerprint;
  nextSeed: PersonalizedSeedVector;
  requestHash: string;
  now: number;
  field?: FieldState;
  policyEpochChanged: boolean;
}): AlphaInvalidationRule[] {
  const topologyChanged = input.record.graphFingerprint.topologyHash === input.nextFingerprint.topologyHash ? 0 : 1;
  const alphaChanged = input.record.graphFingerprint.alphaHash === input.nextFingerprint.alphaHash ? 0 : 1;
  const seedDrift = 1 - cosineSimilarity(input.record.seed.values, input.nextSeed.values);
  const contradiction = input.field?.alphaTrace.surfaces.contradiction ?? input.record.alphaTrace.surfaces.contradiction;
  const expired = input.now > input.record.expiresAt ? 1 : 0;
  return [
    rule("topology", "topology_changed", 0.01, topologyChanged),
    rule("alpha", "alpha_changed", 0.35, alphaChanged),
    rule("seed", "seed_drift", 0.22, seedDrift),
    rule("contradiction", "contradiction_pressure", 0.58, contradiction),
    rule("policy", "policy_epoch", 0.5, input.policyEpochChanged ? 1 : 0),
    rule("ttl", "expired", 0.5, expired)
  ];
}

function rule(id: string, reason: AlphaInvalidationRule["reason"], threshold: number, observed: number): AlphaInvalidationRule {
  return { id, reason, threshold, observed, invalidates: observed > threshold };
}

function cacheKeyFor(input: { fingerprint: GraphFingerprint; requestHash: string; seedHash: string; policyEpoch: string }, hasher: Hasher): string {
  return `alpha_cache_${hasher.digestHex(JSON.stringify({ topology: input.fingerprint.topologyHash, alpha: input.fingerprint.alphaHash, request: input.requestHash, seed: input.seedHash, policyEpoch: input.policyEpoch })).slice(0, 40)}`;
}

export function alphaTraceMatrixSnapshot(trace: AlphaTrace, kind: "adjacency" | "laplacian" | "normalizedLaplacian" = "adjacency"): MatrixSnapshot {
  return kind === "adjacency" ? trace.adjacency : kind === "laplacian" ? trace.laplacian : trace.normalizedLaplacian;
}

function secondEigenEstimate(matrix: number[][], dominant: readonly number[], damping: number): number {
  const n = matrix.length;
  if (n <= 1) return 0;
  let vector = new Array<number>(n).fill(0).map((_, index) => (index % 2 === 0 ? 1 : -1) / n);
  const dominantNorm = dot(dominant, dominant) || 1;
  for (let iter = 0; iter < 32; iter++) {
    const projected = multiplyTranspose(matrix, vector).map(value => value * damping);
    const projection = dot(projected, dominant) / dominantNorm;
    vector = projected.map((value, index) => value - projection * (dominant[index] ?? 0));
    const norm = Math.sqrt(dot(vector, vector));
    if (norm <= 1e-12) break;
    vector = vector.map(value => value / norm);
  }
  return Math.abs(rayleighQuotient(matrix, vector));
}

function rayleighQuotient(matrix: number[][], vector: readonly number[]): number {
  const mv = multiplyTranspose(matrix, vector);
  const numerator = dot(vector, mv);
  const denominator = dot(vector, vector);
  return denominator > 0 ? numerator / denominator : 0;
}

function multiplyTranspose(matrix: number[][], vector: readonly number[]): number[] {
  const n = matrix.length;
  const out = new Array<number>(n).fill(0);
  for (let row = 0; row < n; row++) {
    const mass = vector[row] ?? 0;
    for (let col = 0; col < n; col++) out[col] = (out[col] ?? 0) + mass * (matrix[row]?.[col] ?? 0);
  }
  return out;
}

function approximateConductance(matrix: number[][], stationary: readonly number[]): number {
  const n = matrix.length;
  if (n <= 1) return 1;
  const order = stationary.map((mass, index) => ({ mass, index })).sort((a, b) => b.mass - a.mass);
  let best = 1;
  const inSet = new Set<number>();
  let volume = 0;
  for (let k = 0; k < Math.min(n - 1, Math.max(1, Math.floor(n / 2))); k++) {
    const index = order[k]!.index;
    inSet.add(index);
    volume += stationary[index] ?? 0;
    let cut = 0;
    for (const row of inSet) {
      for (let col = 0; col < n; col++) if (!inSet.has(col)) cut += (stationary[row] ?? 0) * (matrix[row]?.[col] ?? 0);
    }
    const denom = Math.min(volume, Math.max(1e-12, 1 - volume));
    best = Math.min(best, cut / denom);
  }
  return clamp01(best);
}

function irreducibility(matrix: number[][]): number {
  const n = matrix.length;
  if (n === 0) return 0;
  const visited = reachable(matrix, 0, false);
  const reverseVisited = reachable(matrix, 0, true);
  return Math.min(visited.size, reverseVisited.size) / n;
}

function reachable(matrix: number[][], start: number, reverse: boolean): Set<number> {
  const seen = new Set<number>([start]);
  const queue = [start];
  while (queue.length) {
    const node = queue.shift()!;
    for (let next = 0; next < matrix.length; next++) {
      const weight = reverse ? matrix[next]?.[node] ?? 0 : matrix[node]?.[next] ?? 0;
      if (weight <= 0 || seen.has(next)) continue;
      seen.add(next);
      queue.push(next);
    }
  }
  return seen;
}

function aperiodicity(matrix: number[][]): number {
  if (matrix.length === 0) return 0;
  const selfLoops = matrix.filter((row, index) => (row[index] ?? 0) > 1e-9).length / matrix.length;
  const denseRows = matrix.filter(row => row.filter(value => value > 1e-9).length > 1).length / matrix.length;
  return clamp01(0.65 * selfLoops + 0.35 * denseRows);
}

function dot(a: readonly number[], b: readonly number[]): number {
  const n = Math.max(a.length, b.length);
  let sum = 0;
  for (let i = 0; i < n; i++) sum += (a[i] ?? 0) * (b[i] ?? 0);
  return sum;
}

function l1(a: readonly number[], b: readonly number[]): number {
  const n = Math.max(a.length, b.length);
  let sum = 0;
  for (let i = 0; i < n; i++) sum += Math.abs((a[i] ?? 0) - (b[i] ?? 0));
  return sum;
}

function shannon(values: readonly number[]): number {
  let h = 0;
  for (const value of values) {
    if (value > 0) h -= value * Math.log2(value);
  }
  return h;
}

function round(value: number): number {
  return Math.round(value * 1_000_000) / 1_000_000;
}
