import type { GraphEdge, GraphNode, Hasher, JsonValue, NodeId } from "./types.js";
import { clamp01, cosineSimilarity, mean, normalizeVector, toJsonValue, variance } from "./primitives.js";
import { jacobiEigenvaluesSymmetric, zeros } from "./math.js";
import {
  fitSparsePpmiRepresentation,
  splitCooccurrenceForValidation,
  type SparseCooccurrenceState,
  type SparsePpmiDiagnostics
} from "./powerwalk-ppmi.js";

export {
  fitSparsePpmiRepresentation,
  mergeSparseCooccurrenceState,
  splitCooccurrenceForValidation,
  POWERWALK_COOCCURRENCE_VERSION,
  POWERWALK_PARTITION_SCHEMA,
  POWERWALK_REPRESENTATION_VERSION
} from "./powerwalk-ppmi.js";
export type {
  PowerWalkPartitionIdentity,
  PowerWalkCooccurrenceRow,
  SparseCooccurrenceCount,
  SparseCooccurrenceState,
  SparsePpmiDiagnostics,
  SparsePpmiFit,
  SparsePpmiOptions
} from "./powerwalk-ppmi.js";

export interface PowerWalkParams {
  p: Map<string, number>;
  q: Map<string, number>;
  lambda: Map<string, number>;
  epsilon: number;
  audit?: JsonValue;
}

export interface TypePairWalkStats {
  typePair: string;
  edges: number;
  meanAgeDays: number;
  ageVariance: number;
  meanAlphaWeight: number;
  meanOutDegree: number;
  temporalHalfLifeDays: number;
  p: number;
  q: number;
  lambda: number;
}

export interface PowerWalkResult {
  walks: NodeId[][];
  embeddings: Array<{ nodeId: NodeId; vector: number[] }>;
  typePairWalkLengths: PowerWalkLengthDiagnostic[];
  transitionAudit: Array<{
    start: NodeId;
    walkIndex: number;
    step: number;
    from: NodeId;
    to: NodeId;
    previous?: NodeId;
    edgeId: string;
    selected: boolean;
    typePair: string;
    probability: number;
    bias: number;
    decay: number;
    alphaWeight: number;
  }>;
  cooccurrence: Array<{ nodeId: NodeId; contextNodeId: NodeId; count: number; distanceMean: number; weight: number }>;
  cooccurrenceState: SparseCooccurrenceState;
  representation: SparsePpmiDiagnostics & {
    excludedZeroContextNodes: number;
    zeroContextPolicy: "excluded_from_similarity";
  };
  calibration: JsonValue;
}

export interface PowerWalkExecution {
  now?: number;
  seed?: string;
  walksPerNode?: number;
  dimensions?: number;
  validationFraction?: number;
  priorCooccurrenceState?: SparseCooccurrenceState;
}

export interface PowerWalkSeedAnchor {
  nodeId: NodeId;
  weight: number;
  feature?: string;
}

export interface PowerWalkSeedExpansionAudit {
  schema: "scce.powerwalk_seed_expansion.v1";
  method: "query_anchor_ppmi_cosine";
  anchorInputCount: number;
  usableAnchorCount: number;
  excludedAnchorCount: number;
  representedNodeCount: number;
  comparedPairs: number;
  minimumCosine: number;
  maximumExpandedSeeds: number;
  expansionScale: number;
  expandedSeedCount: number;
  top: Array<{ nodeId: NodeId; anchorNodeId: NodeId; cosine: number; weight: number }>;
}

export interface PowerWalkSeedExpansion {
  seeds: PowerWalkSeedAnchor[];
  audit: PowerWalkSeedExpansionAudit;
}

export interface PowerWalkLengthDiagnostic {
  typePair: string;
  spectralGap: number;
  length: number;
  boundKind: "reversible_absolute_spectral_bound" | "exploration_heuristic";
  rationale: "bound_assumptions_not_established" | "second_order_transition_bound_not_established";
  assumptions: {
    rowStochastic: boolean;
    irreducible: boolean;
    aperiodic: boolean;
    reversible: boolean;
  };
}

export function createTypedTemporalWalkEngine(options: { hasher: Hasher }) {
  return {
    calibrate(nodes: readonly GraphNode[], edges: readonly GraphEdge[], now = graphSnapshotTime(edges)): PowerWalkParams {
      validatePowerWalkInputs(nodes, edges, now);
      return calibratePowerWalkParameters(nodes, edges, now);
    },

    run(nodes: readonly GraphNode[], edges: readonly GraphEdge[], params?: PowerWalkParams, execution: PowerWalkExecution = {}): PowerWalkResult {
      const now = execution.now ?? graphSnapshotTime(edges);
      validatePowerWalkInputs(nodes, edges, now);
      const canonicalNodes = [...nodes].sort(compareNodes);
      const canonicalEdges = [...edges].sort(compareEdges);
      const cfg = params ?? this.calibrate(canonicalNodes, canonicalEdges, now);
      const byId = new Map(canonicalNodes.map(node => [node.id, node]));
      const neighbor = new Map<NodeId, GraphEdge[]>();
      for (const edge of canonicalEdges) {
        if (!byId.has(edge.source) || !byId.has(edge.target)) continue;
        if (!neighbor.has(edge.source)) neighbor.set(edge.source, []);
        neighbor.get(edge.source)?.push(edge);
      }
      const transition = transitionMatrix(canonicalNodes, canonicalEdges, cfg, now);
      const typePairWalkLengths = walkLengthsByType(canonicalNodes, canonicalEdges, transition, cfg.epsilon);
      const transitionAudit: PowerWalkResult["transitionAudit"] = [];
      const walks: NodeId[][] = [];
      for (const node of canonicalNodes.slice(0, 500)) {
        const typeLength = typePairWalkLengths.find(item => item.typePair.startsWith(`${String(node.typeId)}->`))?.length ?? 16;
        const walksPerNode = Math.max(1, Math.min(64, Math.floor(execution.walksPerNode ?? 4)));
        for (let walkIndex = 0; walkIndex < walksPerNode; walkIndex++) {
          const walked = walkFrom(node.id, byId, neighbor, canonicalEdges, cfg, Math.min(96, Math.max(8, typeLength)), options.hasher, now, execution.seed ?? "powerwalk", walkIndex);
          walks.push(walked.walk);
          if (transitionAudit.length < 512) transitionAudit.push(...walked.audit.slice(0, 512 - transitionAudit.length));
        }
      }
      const cooccurrence = walkCooccurrence(walks, 4);
      const split = splitCooccurrenceForValidation(cooccurrence, {
        hasher: options.hasher,
        seed: `${execution.seed ?? "powerwalk"}:validation`,
        validationFraction: execution.validationFraction
      });
      const fit = fitSparsePpmiRepresentation(canonicalNodes.map(node => node.id), split.training, {
        hasher: options.hasher,
        dimensions: execution.dimensions,
        projectionSeed: `${execution.seed ?? "powerwalk"}:projection`,
        window: 4,
        priorState: execution.priorCooccurrenceState,
        snapshotId: options.hasher.digestHex(JSON.stringify({
          schema: "powerwalk.training-snapshot.v2",
          seed: execution.seed ?? "powerwalk",
          now,
          partitionPolicyHash: split.partition.policyHash,
          splitHash: split.partition.splitHash
        })),
        validation: split.validation,
        partition: split.partition,
        partitionMismatch: "reset"
      });
      return {
        walks,
        embeddings: fit.embeddings,
        typePairWalkLengths,
        transitionAudit,
        cooccurrence: cooccurrence.slice(0, 2048),
        cooccurrenceState: fit.state,
        representation: {
          ...fit.diagnostics,
          excludedZeroContextNodes: fit.diagnostics.zeroContextNodes,
          zeroContextPolicy: "excluded_from_similarity"
        },
        calibration: cfg.audit ?? toJsonValue({ epsilon: cfg.epsilon })
      };
    }
  };
}

/**
 * Expand query-conditioned retrieval anchors through the learned PowerWalk
 * representation. The input anchors are the only query signal: embeddings are
 * learned from PPMI walk contexts, and zero-context nodes are never replaced by
 * hash-derived vectors.
 */
export function expandPowerWalkSeedAnchors(input: {
  anchors: readonly PowerWalkSeedAnchor[];
  embeddings: readonly { nodeId: NodeId; vector: readonly number[] }[];
  minimumCosine?: number;
  maximumExpandedSeeds?: number;
  maximumAnchors?: number;
  expansionScale?: number;
}): PowerWalkSeedExpansion {
  const minimumCosine = clamp(input.minimumCosine ?? 0.2, -1, 1);
  const maximumExpandedSeeds = clampInteger(input.maximumExpandedSeeds ?? 24, 0, 128);
  const maximumAnchors = clampInteger(input.maximumAnchors ?? 32, 0, 128);
  const expansionScale = clamp01(input.expansionScale ?? 0.5);
  const embeddingByNode = new Map(input.embeddings.map(row => [String(row.nodeId), row]));
  const represented = input.embeddings
    .filter(row => hasLearnedContext(row.vector))
    .sort((left, right) => String(left.nodeId).localeCompare(String(right.nodeId)));
  const anchorIds = new Set(input.anchors.map(anchor => String(anchor.nodeId)));
  const anchors = [...input.anchors]
    .filter(anchor => Number.isFinite(anchor.weight) && anchor.weight > 0)
    .sort((left, right) => right.weight - left.weight || String(left.nodeId).localeCompare(String(right.nodeId)))
    .slice(0, maximumAnchors);
  const usableAnchors = anchors.filter(anchor => {
    const embedding = embeddingByNode.get(String(anchor.nodeId));
    return embedding ? hasLearnedContext(embedding.vector) : false;
  });
  let comparedPairs = 0;
  const bestByNode = new Map<string, { nodeId: NodeId; anchorNodeId: NodeId; cosine: number; weight: number }>();
  for (const anchor of usableAnchors) {
    const anchorVector = embeddingByNode.get(String(anchor.nodeId))!.vector;
    for (const candidate of represented) {
      if (anchorIds.has(String(candidate.nodeId))) continue;
      comparedPairs++;
      const cosine = cosineSimilarity(anchorVector, candidate.vector);
      if (!Number.isFinite(cosine) || cosine < minimumCosine) continue;
      const weight = clamp01(anchor.weight * cosine * expansionScale);
      if (!(weight > 0)) continue;
      const key = String(candidate.nodeId);
      const existing = bestByNode.get(key);
      if (!existing || weight > existing.weight || (weight === existing.weight && String(anchor.nodeId).localeCompare(String(existing.anchorNodeId)) < 0)) {
        bestByNode.set(key, { nodeId: candidate.nodeId, anchorNodeId: anchor.nodeId, cosine, weight });
      }
    }
  }
  const selected = [...bestByNode.values()]
    .sort((left, right) => right.weight - left.weight || right.cosine - left.cosine || String(left.nodeId).localeCompare(String(right.nodeId)))
    .slice(0, maximumExpandedSeeds);
  return {
    seeds: selected.map(row => ({
      nodeId: row.nodeId,
      weight: row.weight,
      feature: `powerwalk:ppmi-cosine:${String(row.anchorNodeId)}`
    })),
    audit: {
      schema: "scce.powerwalk_seed_expansion.v1",
      method: "query_anchor_ppmi_cosine",
      anchorInputCount: input.anchors.length,
      usableAnchorCount: usableAnchors.length,
      excludedAnchorCount: input.anchors.length - usableAnchors.length,
      representedNodeCount: represented.length,
      comparedPairs,
      minimumCosine,
      maximumExpandedSeeds,
      expansionScale,
      expandedSeedCount: selected.length,
      top: selected.slice(0, 12)
    }
  };
}

export function calibratePowerWalkParameters(nodes: readonly GraphNode[], edges: readonly GraphEdge[], now = graphSnapshotTime(edges)): PowerWalkParams {
  const p = new Map<string, number>();
  const q = new Map<string, number>();
  const lambda = new Map<string, number>();
  const stats = typePairStats(nodes, edges, now);
  for (const row of stats) {
    p.set(row.typePair, row.p);
    q.set(row.typePair, row.q);
    lambda.set(row.typePair, row.lambda);
  }
  return { p, q, lambda, epsilon: 0.01, audit: toJsonValue({ stats }) };
}

export function powerWalkTransitionProbability(input: {
  previous?: GraphNode;
  current: GraphNode;
  candidate: GraphNode;
  edge: GraphEdge;
  allEdges: readonly GraphEdge[];
  params: PowerWalkParams;
  now?: number;
}): { unnormalized: number; bias: number; decay: number; alphaWeight: number; distance: 0 | 1 | 2; typePair: string } {
  assertFiniteNonnegative(input.edge.weight, "edge.weight");
  assertFiniteNonnegative(input.edge.alpha, "edge.alpha");
  if (!Number.isFinite(input.edge.updatedAt)) throw new Error("PowerWalk edge.updatedAt must be finite");
  if (input.now !== undefined && !Number.isFinite(input.now)) throw new Error("PowerWalk now must be finite");
  const typePair = `${input.current.typeId}->${input.candidate.typeId}`;
  const pKey = `${input.previous?.typeId ?? input.current.typeId}->${input.current.typeId}`;
  const distance = node2vecDistance(input.previous?.id, input.candidate.id, input.allEdges);
  const p = input.params.p.get(pKey) ?? 1;
  const q = input.params.q.get(typePair) ?? 1;
  assertFinitePositive(p, `p[${pKey}]`);
  assertFinitePositive(q, `q[${typePair}]`);
  const lambda = input.params.lambda.get(typePair) ?? 0.01;
  assertFiniteNonnegative(lambda, `lambda[${typePair}]`);
  const bias = distance === 0 ? 1 / p : distance === 1 ? 1 : 1 / q;
  const ageDays = Math.max(0, (input.now ?? graphSnapshotTime(input.allEdges)) - input.edge.updatedAt) / (1000 * 60 * 60 * 24);
  const decay = Math.exp(-lambda * ageDays);
  const alphaWeight = input.edge.weight * input.edge.alpha;
  return { unnormalized: Math.max(0, alphaWeight * bias * decay), bias, decay, alphaWeight, distance, typePair };
}

function transitionMatrix(nodes: readonly GraphNode[], edges: readonly GraphEdge[], params: PowerWalkParams, now: number): number[][] {
  const index = new Map(nodes.map((node, i) => [node.id, i]));
  const byId = new Map(nodes.map(node => [node.id, node]));
  const matrix = zeros(nodes.length, nodes.length);
  for (const edge of edges) {
    const i = index.get(edge.source);
    const j = index.get(edge.target);
    const source = byId.get(edge.source);
    const target = byId.get(edge.target);
    if (i === undefined || j === undefined || !source || !target) continue;
    const key = `${source.typeId}->${target.typeId}`;
    const decay = Math.exp(-(params.lambda.get(key) ?? 0.01) * Math.max(0, now - edge.updatedAt) / (1000 * 60 * 60 * 24));
    matrix[i]![j] = (matrix[i]![j] ?? 0) + edge.weight * edge.alpha * decay;
  }
  return matrix.map(row => normalizeVector(row, 0));
}

export function typeConditionalTransitionMatrix(nodes: readonly GraphNode[], edges: readonly GraphEdge[], params: PowerWalkParams, sourceType: string, targetType: string, now = graphSnapshotTime(edges)): number[][] {
  const pairNodes = nodes.filter(node => String(node.typeId) === sourceType || String(node.typeId) === targetType);
  const index = new Map(pairNodes.map((node, i) => [node.id, i]));
  const byId = new Map(nodes.map(node => [node.id, node]));
  const matrix = zeros(pairNodes.length, pairNodes.length);
  for (const edge of edges) {
    const source = byId.get(edge.source);
    const target = byId.get(edge.target);
    if (!source || !target || String(source.typeId) !== sourceType || String(target.typeId) !== targetType) continue;
    const i = index.get(edge.source);
    const j = index.get(edge.target);
    if (i === undefined || j === undefined) continue;
    const typePair = powerWalkTypePairKey(source, target);
    const decay = Math.exp(-(params.lambda.get(typePair) ?? 0.01) * ageDays(edge, now));
    matrix[i]![j] = (matrix[i]![j] ?? 0) + edge.weight * edge.alpha * decay;
  }
  return matrix.map(row => normalizeVector(row, 0));
}

function walkFrom(
  start: NodeId,
  byId: Map<NodeId, GraphNode>,
  neighbor: Map<NodeId, GraphEdge[]>,
  allEdges: readonly GraphEdge[],
  params: PowerWalkParams,
  length: number,
  hasher: Hasher,
  now: number,
  seed: string,
  walkIndex: number
): { walk: NodeId[]; audit: PowerWalkResult["transitionAudit"] } {
  const walk = [start];
  const audit: PowerWalkResult["transitionAudit"] = [];
  let previous: NodeId | undefined;
  let current = start;
  for (let step = 1; step < length; step++) {
    const edges = neighbor.get(current) ?? [];
    if (edges.length === 0) break;
    const currentNode = byId.get(current);
    const weighted = edges.map(edge => {
      const dest = byId.get(edge.target);
      const prev = previous ? byId.get(previous) : undefined;
      if (!currentNode || !dest) return { edge, weight: 0, transition: undefined };
      const transition = powerWalkTransitionProbability({ previous: prev, current: currentNode, candidate: dest, edge, allEdges, params, now });
      return { edge, weight: transition.unnormalized, transition };
    });
    const selected = deterministicWeightedChoice(weighted, `${seed}:${start}:${walkIndex}:${current}:${step}`, hasher);
    const total = weighted.reduce((sum, item) => sum + Math.max(0, item.weight), 0);
    for (const item of weighted) {
      if (!item.transition) continue;
      audit.push({
        start,
        walkIndex,
        step,
        from: current,
        to: item.edge.target,
        ...(previous ? { previous } : {}),
        edgeId: String(item.edge.id),
        selected: selected?.id === item.edge.id,
        typePair: item.transition.typePair,
        probability: total > 0 ? Math.max(0, item.weight) / total : 0,
        bias: item.transition.bias,
        decay: item.transition.decay,
        alphaWeight: item.transition.alphaWeight
      });
    }
    if (!selected) break;
    previous = current;
    current = selected.target;
    walk.push(current);
  }
  return { walk, audit };
}

function node2vecDistance(previous: NodeId | undefined, candidate: NodeId, edges: readonly GraphEdge[]): 0 | 1 | 2 {
  if (!previous) return 1;
  if (previous === candidate) return 0;
  return edges.some(edge => (edge.source === previous && edge.target === candidate) || (edge.source === candidate && edge.target === previous)) ? 1 : 2;
}

function deterministicWeightedChoice(items: Array<{ edge: GraphEdge; weight: number }>, salt: string, hasher: Hasher): GraphEdge | undefined {
  const total = items.reduce((sum, item) => sum + Math.max(0, item.weight), 0);
  if (total <= 0) return undefined;
  const h = Number.parseInt(hasher.digestHex(salt).slice(0, 12), 16) / 0xffffffffffff;
  let cursor = h * total;
  for (const item of items) {
    cursor -= Math.max(0, item.weight);
    if (cursor <= 0) return item.edge;
  }
  return items[items.length - 1]?.edge;
}

function walkLengthsByType(nodes: readonly GraphNode[], edges: readonly GraphEdge[], transition: number[][], epsilon: number): PowerWalkLengthDiagnostic[] {
  const types = [...new Set(nodes.map(node => String(node.typeId)))].sort();
  const out: PowerWalkLengthDiagnostic[] = [];
  for (const a of types) {
    for (const b of types) {
      const indices = nodes.map((node, i) => ({ node, i })).filter(item => String(item.node.typeId) === a || String(item.node.typeId) === b).map(item => item.i);
      const sub = indices.map(i => indices.map(j => transition[i]?.[j] ?? 0));
      const pairEdges = edges.filter(edge => {
        const s = nodes.find(node => node.id === edge.source);
        const t = nodes.find(node => node.id === edge.target);
        return s && t && String(s.typeId) === a && String(t.typeId) === b;
      });
      const assessment = assessTransitionForMixingBound(sub);
      const assumptionsHold = pairEdges.length > 0 && assessment.valid;
      const heuristicLength = Math.max(8, Math.min(96, Math.ceil(Math.log(1 / Math.max(1e-9, epsilon)) * Math.sqrt(Math.max(1, sub.length)))));
      out.push({
        typePair: `${a}->${b}`,
        // The executed node2vec walk is second-order over (previous,current)
        // states. A first-order node-chain gap is not a bound for that process.
        spectralGap: 0,
        length: heuristicLength,
        boundKind: "exploration_heuristic",
        rationale: assumptionsHold ? "second_order_transition_bound_not_established" : "bound_assumptions_not_established",
        assumptions: assessment.assumptions
      });
    }
  }
  return out;
}

export function minimumPowerWalkLength(spectralGap: number, epsilon: number): number {
  const gap = Math.max(1e-6, spectralGap);
  return Math.max(1, Math.ceil(Math.log(1 / Math.max(1e-9, epsilon)) / gap));
}

export function powerWalkTypePairKey(source: GraphNode, target: GraphNode): string {
  return `${String(source.typeId)}->${String(target.typeId)}`;
}

function typePairStats(nodes: readonly GraphNode[], edges: readonly GraphEdge[], now: number): TypePairWalkStats[] {
  const byId = new Map(nodes.map(node => [node.id, node]));
  const outDegree = new Map<string, number>();
  for (const edge of edges) outDegree.set(String(edge.source), (outDegree.get(String(edge.source)) ?? 0) + 1);
  const types = [...new Set(nodes.map(node => String(node.typeId)))].sort();
  const stats: TypePairWalkStats[] = [];
  for (const sourceType of types) {
    for (const targetType of types) {
      const pairEdges = edges.filter(edge => {
        const s = byId.get(edge.source);
        const t = byId.get(edge.target);
        return s && t && String(s.typeId) === sourceType && String(t.typeId) === targetType;
      });
      const ages = pairEdges.map(edge => ageDays(edge, now));
      const weights = pairEdges.map(edge => edge.weight * edge.alpha);
      const sourceDegrees = nodes.filter(node => String(node.typeId) === sourceType).map(node => outDegree.get(String(node.id)) ?? 0);
      const targetDegrees = nodes.filter(node => String(node.typeId) === targetType).map(node => outDegree.get(String(node.id)) ?? 0);
      const meanOutDegree = mean(sourceDegrees);
      const temporalHalfLifeDays = halfLifeFromAges(ages, pairEdges.length);
      const lambda = Math.log(2) / Math.max(1e-6, temporalHalfLifeDays);
      const degreeRatio = (mean(targetDegrees) + 1) / (meanOutDegree + 1);
      const density = pairEdges.length / Math.max(1, sourceDegrees.length * Math.max(1, targetDegrees.length));
      const p = clamp(0.35 + degreeRatio, 0.25, 4);
      const q = clamp(2.2 - 1.4 * density + 0.4 * Math.sqrt(Math.max(0, variance(targetDegrees))), 0.25, 4);
      stats.push({
        typePair: `${sourceType}->${targetType}`,
        edges: pairEdges.length,
        meanAgeDays: mean(ages),
        ageVariance: variance(ages),
        meanAlphaWeight: mean(weights),
        meanOutDegree,
        temporalHalfLifeDays,
        p,
        q,
        lambda
      });
    }
  }
  return stats;
}

function halfLifeFromAges(ages: readonly number[], edgeCount: number): number {
  if (edgeCount === 0) return 30;
  const m = mean(ages);
  const spread = Math.sqrt(variance(ages));
  return clamp(1 + 0.55 * m + 0.45 * spread, 1, 180);
}

function ageDays(edge: GraphEdge, now: number): number {
  return Math.max(0, now - edge.updatedAt) / (1000 * 60 * 60 * 24);
}

function graphSnapshotTime(edges: readonly GraphEdge[]): number {
  return edges.reduce((latest, edge) => Math.max(latest, edge.updatedAt), 0);
}

function walkCooccurrence(walks: readonly NodeId[][], window: number): PowerWalkResult["cooccurrence"] {
  const counts = new Map<string, { nodeId: NodeId; contextNodeId: NodeId; count: number; distanceSum: number }>();
  for (const walk of walks) {
    for (let i = 0; i < walk.length; i++) {
      const nodeId = walk[i]!;
      for (let j = Math.max(0, i - window); j <= Math.min(walk.length - 1, i + window); j++) {
        if (i === j) continue;
        const contextNodeId = walk[j]!;
        const distance = Math.abs(i - j);
        const key = `${nodeId}\u001f${contextNodeId}`;
        const current = counts.get(key) ?? { nodeId, contextNodeId, count: 0, distanceSum: 0 };
        current.count++;
        current.distanceSum += distance;
        counts.set(key, current);
      }
    }
  }
  const maxCount = Math.max(1, ...[...counts.values()].map(row => row.count));
  return [...counts.values()]
    .map(row => ({ nodeId: row.nodeId, contextNodeId: row.contextNodeId, count: row.count, distanceMean: row.distanceSum / Math.max(1, row.count), weight: clamp01((row.count / maxCount) * (1 / Math.max(1, row.distanceSum / Math.max(1, row.count)))) }))
    .sort((a, b) => b.weight - a.weight || String(a.nodeId).localeCompare(String(b.nodeId)));
}

export function typePairSpectralGaps(nodes: readonly GraphNode[], edges: readonly GraphEdge[], params: PowerWalkParams): Array<{
  typePair: string;
  spectralGap: number;
  eigenvalues: number[];
  boundKind: "reversible_absolute_spectral_bound" | "unavailable";
  assumptions: PowerWalkLengthDiagnostic["assumptions"];
}> {
  const types = [...new Set(nodes.map(node => String(node.typeId)))].sort();
  const out: Array<{
    typePair: string;
    spectralGap: number;
    eigenvalues: number[];
    boundKind: "reversible_absolute_spectral_bound" | "unavailable";
    assumptions: PowerWalkLengthDiagnostic["assumptions"];
  }> = [];
  for (const sourceType of types) {
    for (const targetType of types) {
      const matrix = typeConditionalTransitionMatrix(nodes, edges, params, sourceType, targetType);
      const assessment = assessTransitionForMixingBound(matrix);
      out.push({
        typePair: `${sourceType}->${targetType}`,
        spectralGap: assessment.valid ? assessment.spectralGap : 0,
        eigenvalues: assessment.valid ? assessment.eigenvalues.slice(0, 12) : [],
        boundKind: assessment.valid ? "reversible_absolute_spectral_bound" : "unavailable",
        assumptions: assessment.assumptions
      });
    }
  }
  return out;
}

interface TransitionMixingAssessment {
  valid: boolean;
  spectralGap: number;
  eigenvalues: number[];
  minimumStationaryMass: number;
  assumptions: PowerWalkLengthDiagnostic["assumptions"];
}

/**
 * A spectral mixing bound is reported only for a finite, row-stochastic,
 * irreducible, aperiodic, reversible chain. Directed or substochastic slices
 * still receive an exploration length, but no theorem-backed mixing claim.
 */
function assessTransitionForMixingBound(matrix: readonly (readonly number[])[]): TransitionMixingAssessment {
  const size = matrix.length;
  const rowStochastic = size > 0 && matrix.every(row => {
    if (row.length !== size || row.some(value => !Number.isFinite(value) || value < -1e-12)) return false;
    return Math.abs(row.reduce((sum, value) => sum + value, 0) - 1) <= 1e-9;
  });
  const irreducible = rowStochastic && isStronglyConnected(matrix);
  const aperiodic = irreducible && transitionPeriod(matrix) === 1;
  const stationary = rowStochastic ? stationaryDistribution(matrix) : [];
  const reversible = irreducible && stationary.length === size && detailedBalanceHolds(matrix, stationary);
  const assumptions = { rowStochastic, irreducible, aperiodic, reversible };
  if (!rowStochastic || !irreducible || !aperiodic || !reversible) {
    return { valid: false, spectralGap: 0, eigenvalues: [], minimumStationaryMass: 0, assumptions };
  }
  if (size === 1) {
    return { valid: true, spectralGap: 1, eigenvalues: [1], minimumStationaryMass: 1, assumptions };
  }
  const discriminant = matrix.map((row, i) => row.map((value, j) => {
    const piI = stationary[i] ?? 0;
    const piJ = stationary[j] ?? 0;
    if (piI <= 0 || piJ <= 0) return 0;
    return value * Math.sqrt(piI / piJ);
  }));
  const symmetric = discriminant.map((row, i) => row.map((value, j) => 0.5 * (value + (discriminant[j]?.[i] ?? 0))));
  const eigenvalues = jacobiEigenvaluesSymmetric(symmetric, 120).sort((a, b) => Math.abs(b) - Math.abs(a));
  const secondMagnitude = Math.abs(eigenvalues[1] ?? 0);
  const spectralGap = Math.max(0, 1 - secondMagnitude);
  return {
    valid: spectralGap > 1e-12,
    spectralGap,
    eigenvalues,
    minimumStationaryMass: Math.min(...stationary),
    assumptions
  };
}

function stationaryDistribution(matrix: readonly (readonly number[])[]): number[] {
  if (matrix.length === 0) return [];
  let current = new Array<number>(matrix.length).fill(1 / matrix.length);
  for (let iteration = 0; iteration < 10_000; iteration++) {
    const next = new Array<number>(matrix.length).fill(0);
    for (let i = 0; i < matrix.length; i++) {
      for (let j = 0; j < matrix.length; j++) next[j] = (next[j] ?? 0) + (current[i] ?? 0) * (matrix[i]?.[j] ?? 0);
    }
    const residual = next.reduce((sum, value, index) => sum + Math.abs(value - (current[index] ?? 0)), 0);
    current = next;
    if (residual <= 1e-13) break;
  }
  return current;
}

function detailedBalanceHolds(matrix: readonly (readonly number[])[], stationary: readonly number[]): boolean {
  if (stationary.some(value => !(value > 0) || !Number.isFinite(value))) return false;
  for (let i = 0; i < matrix.length; i++) {
    for (let j = i + 1; j < matrix.length; j++) {
      const forward = (stationary[i] ?? 0) * (matrix[i]?.[j] ?? 0);
      const reverse = (stationary[j] ?? 0) * (matrix[j]?.[i] ?? 0);
      if (Math.abs(forward - reverse) > 1e-8 * Math.max(1, Math.abs(forward), Math.abs(reverse))) return false;
    }
  }
  return true;
}

function isStronglyConnected(matrix: readonly (readonly number[])[]): boolean {
  if (matrix.length === 0) return false;
  const forward = reachable(matrix, false);
  const reverse = reachable(matrix, true);
  return forward.size === matrix.length && reverse.size === matrix.length;
}

function reachable(matrix: readonly (readonly number[])[], reverse: boolean): Set<number> {
  const seen = new Set<number>([0]);
  const stack = [0];
  while (stack.length) {
    const current = stack.pop()!;
    for (let candidate = 0; candidate < matrix.length; candidate++) {
      const probability = reverse ? (matrix[candidate]?.[current] ?? 0) : (matrix[current]?.[candidate] ?? 0);
      if (probability > 0 && !seen.has(candidate)) {
        seen.add(candidate);
        stack.push(candidate);
      }
    }
  }
  return seen;
}

function transitionPeriod(matrix: readonly (readonly number[])[]): number {
  if (matrix.length === 0) return 0;
  const distance = new Array<number>(matrix.length).fill(-1);
  distance[0] = 0;
  const queue = [0];
  for (let cursor = 0; cursor < queue.length; cursor++) {
    const current = queue[cursor]!;
    for (let candidate = 0; candidate < matrix.length; candidate++) {
      if ((matrix[current]?.[candidate] ?? 0) <= 0 || (distance[candidate] ?? -1) >= 0) continue;
      distance[candidate] = (distance[current] ?? 0) + 1;
      queue.push(candidate);
    }
  }
  let period = 0;
  for (let from = 0; from < matrix.length; from++) {
    for (let to = 0; to < matrix.length; to++) {
      if ((matrix[from]?.[to] ?? 0) <= 0) continue;
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

function clamp(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.max(min, Math.min(max, value));
}

function clampInteger(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, Math.floor(Number.isFinite(value) ? value : min)));
}

function hasLearnedContext(vector: readonly number[]): boolean {
  return vector.length > 0 && vector.some(value => Number.isFinite(value) && value !== 0);
}

function compareNodes(left: GraphNode, right: GraphNode): number {
  return String(left.id).localeCompare(String(right.id));
}

function compareEdges(left: GraphEdge, right: GraphEdge): number {
  return String(left.source).localeCompare(String(right.source))
    || String(left.target).localeCompare(String(right.target))
    || String(left.id).localeCompare(String(right.id));
}

function validatePowerWalkInputs(nodes: readonly GraphNode[], edges: readonly GraphEdge[], now: number): void {
  if (!Number.isFinite(now)) throw new Error("PowerWalk snapshot time must be finite");
  const nodeIds = new Set<string>();
  for (const node of nodes) {
    const id = String(node.id);
    if (nodeIds.has(id)) throw new Error(`PowerWalk node id is duplicated: ${id}`);
    nodeIds.add(id);
  }
  for (const edge of edges) {
    assertFiniteNonnegative(edge.weight, `edge ${String(edge.id)} weight`);
    assertFiniteNonnegative(edge.alpha, `edge ${String(edge.id)} alpha`);
    if (!Number.isFinite(edge.updatedAt)) throw new Error(`PowerWalk edge ${String(edge.id)} updatedAt must be finite`);
  }
}

function assertFinitePositive(value: number, label: string): void {
  if (!Number.isFinite(value) || value <= 0) throw new Error(`PowerWalk ${label} must be finite and positive`);
}

function assertFiniteNonnegative(value: number, label: string): void {
  if (!Number.isFinite(value) || value < 0) throw new Error(`PowerWalk ${label} must be finite and non-negative`);
}
