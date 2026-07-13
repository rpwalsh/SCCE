import type { AlphaTrace, GraphEdge, GraphNode, JsonValue, NodeId } from "./types.js";
import { clamp01, mean, toJsonValue, weightedJaccard } from "./primitives.js";
import { conductanceEquation } from "./equation-operators.js";

const DEFAULT_ITERATIONS = 24;
const DEFAULT_NODE_LIMIT = 96;
const DEFAULT_EDGE_LIMIT = 256;

export interface GreenPotentialInput {
  nodes: readonly GraphNode[];
  edges: readonly GraphEdge[];
  requestFeatures: readonly string[];
  seeds: readonly { nodeId: NodeId; weight: number; feature?: string }[];
  activeNodeIds: readonly string[];
  ppf: readonly { nodeId: NodeId; mass: number }[];
  alphaTrace: AlphaTrace;
  lambda?: number;
  iterations?: number;
  nodeLimit?: number;
  edgeLimit?: number;
}

export interface GreenPotentialResult {
  schema: "scce.green_potential_field.v1";
  operatorId: "field.green.damped_laplacian.v1";
  nodeCount: number;
  edgeCount: number;
  lambda: number;
  iterations: number;
  residual: number;
  fieldEnergy: number;
  supportPotential: number;
  contradictionPotential: number;
  uncertaintyPotential: number;
  answerabilityPotential: number;
  evidenceInfluence: Array<{ evidenceId: string; influence: number; edgeIds: string[] }>;
  topNodes: Array<{ nodeId: string; support: number; contradiction: number; uncertainty: number; answerability: number }>;
  audit: JsonValue;
}

interface SolverGraph {
  nodeIds: string[];
  edges: Array<{ id: string; source: number; target: number; conductance: number; evidenceIds: string[] }>;
}

export function solveGreenPotentialField(input: GreenPotentialInput): GreenPotentialResult {
  const lambda = Math.max(0.0001, input.lambda ?? 0.08);
  const iterations = Math.max(8, Math.min(240, input.iterations ?? DEFAULT_ITERATIONS));
  const graph = solverGraph(input);
  const supportSource = sourceVector(input, graph.nodeIds, "support");
  const contradictionSource = sourceVector(input, graph.nodeIds, "contradiction");
  const support = solvePotential(graph, supportSource, lambda, iterations);
  const contradiction = solvePotential(graph, contradictionSource, lambda, iterations);
  const supportNorm = normalizePotential(support.values);
  const contradictionNorm = normalizePotential(contradiction.values);
  const topNodes = graph.nodeIds.map((nodeId, index) => {
    const nodeSupport = supportNorm[index] ?? 0;
    const nodeContradiction = contradictionNorm[index] ?? 0;
    const answerability = clamp01(nodeSupport - nodeContradiction * 0.72);
    return {
      nodeId,
      support: nodeSupport,
      contradiction: nodeContradiction,
      uncertainty: clamp01(1 - Math.max(nodeSupport, nodeContradiction)),
      answerability
    };
  }).sort((left, right) => right.answerability - left.answerability || right.support - left.support || left.nodeId.localeCompare(right.nodeId));
  const evidenceInfluence = influenceRows(graph, supportNorm, contradictionNorm);
  const supportPotential = mean(topNodes.slice(0, 12).map(row => row.support));
  const contradictionPotential = mean(topNodes.slice(0, 12).map(row => row.contradiction));
  const uncertaintyPotential = mean(topNodes.slice(0, 12).map(row => row.uncertainty));
  const answerabilityPotential = clamp01(supportPotential - contradictionPotential * 0.72);
  const fieldEnergy = potentialEnergy(graph, supportNorm) + potentialEnergy(graph, contradictionNorm);
  return {
    schema: "scce.green_potential_field.v1",
    operatorId: "field.green.damped_laplacian.v1",
    nodeCount: graph.nodeIds.length,
    edgeCount: graph.edges.length,
    lambda,
    iterations,
    residual: clamp01(mean([support.residual, contradiction.residual])),
    fieldEnergy: clamp01(fieldEnergy),
    supportPotential,
    contradictionPotential,
    uncertaintyPotential,
    answerabilityPotential,
    evidenceInfluence,
    topNodes: topNodes.slice(0, 24),
    audit: toJsonValue({
      sourceCharge: {
        support: supportSource.reduce((sum, value) => sum + Math.max(0, value), 0),
        contradiction: contradictionSource.reduce((sum, value) => sum + Math.max(0, value), 0)
      },
      bounded: input.nodes.length > graph.nodeIds.length || input.edges.length > graph.edges.length,
      requestedNodeLimit: input.nodeLimit ?? DEFAULT_NODE_LIMIT,
      requestedEdgeLimit: input.edgeLimit ?? DEFAULT_EDGE_LIMIT
    })
  };
}

function solverGraph(input: GreenPotentialInput): SolverGraph {
  const nodeLimit = input.nodeLimit ?? DEFAULT_NODE_LIMIT;
  const edgeLimit = input.edgeLimit ?? DEFAULT_EDGE_LIMIT;
  const active = new Set(input.activeNodeIds.map(String));
  for (const seed of input.seeds) active.add(String(seed.nodeId));
  for (const row of input.ppf.slice(0, nodeLimit)) active.add(String(row.nodeId));
  const nodeById = new Map(input.nodes.map(node => [String(node.id), node]));
  const nodeScores = [...active]
    .map(nodeId => {
      const node = nodeById.get(nodeId);
      const queryFit = node ? weightedJaccard(input.requestFeatures, node.features) : 0;
      const ppf = input.ppf.find(row => String(row.nodeId) === nodeId)?.mass ?? 0;
      return node ? { nodeId, score: queryFit * 0.42 + node.alpha * 0.3 + ppf * 0.28 } : undefined;
    })
    .filter((row): row is { nodeId: string; score: number } => Boolean(row))
    .sort((left, right) => right.score - left.score || left.nodeId.localeCompare(right.nodeId))
    .slice(0, nodeLimit);
  const nodeIds = nodeScores.map(row => row.nodeId);
  const indexById = new Map(nodeIds.map((nodeId, index) => [nodeId, index]));
  const alphaByEdge = new Map(input.alphaTrace.relations.map(row => [`${row.source}\u0001${row.target}\u0001${row.relationId}`, row.strength]));
  const edges = input.edges
    .map(edge => {
      const source = indexById.get(String(edge.source));
      const target = indexById.get(String(edge.target));
      if (source === undefined || target === undefined || source === target) return undefined;
      const conductance = edgeConductance(edge, alphaByEdge.get(`${edge.source}\u0001${edge.target}\u0001${edge.relationId}`));
      if (conductance <= 0) return undefined;
      return { id: String(edge.id), source, target, conductance, evidenceIds: edge.evidenceIds.map(String) };
    })
    .filter((edge): edge is SolverGraph["edges"][number] => Boolean(edge))
    .sort((left, right) => right.conductance - left.conductance || left.id.localeCompare(right.id))
    .slice(0, edgeLimit);
  return { nodeIds, edges };
}

function edgeConductance(edge: GraphEdge, alphaStrength?: number): number {
  const metadata = objectRecord(edge.metadata);
  const sourceQuality = edge.evidenceIds.length ? 1 : 0.58;
  const temporalFit = edge.temporalScope.validTo === undefined ? 1 : 0.86;
  const modalityAgreement = numberField(metadata, "modalityAgreement", 1);
  const contradictionPenalty = numberField(metadata, "contradiction", 0);
  const alpha = Math.max(edge.alpha, alphaStrength ?? 0);
  return conductanceEquation({
    weight: Math.max(0, edge.weight),
    alpha,
    provenance: sourceQuality,
    temporalFit,
    modalityAgreement,
    contradictionPenalty
  });
}

function objectRecord(value: JsonValue | undefined): Record<string, JsonValue> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, JsonValue> : undefined;
}

function numberField(record: Record<string, JsonValue> | undefined, key: string, fallback: number): number {
  const value = record?.[key];
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function sourceVector(input: GreenPotentialInput, nodeIds: readonly string[], mode: "support" | "contradiction"): number[] {
  const seedByNode = new Map(input.seeds.map(seed => [String(seed.nodeId), clamp01(seed.weight)]));
  const ppfByNode = new Map(input.ppf.map(row => [String(row.nodeId), clamp01(row.mass)]));
  const nodeById = new Map(input.nodes.map(node => [String(node.id), node]));
  const contradictionMass = clamp01(input.alphaTrace.contradictionMass * 0.55 + input.alphaTrace.surfaces.contradiction * 0.45);
  return nodeIds.map(nodeId => {
    const node = nodeById.get(nodeId);
    const queryFit = node ? weightedJaccard(input.requestFeatures, node.features) : 0;
    const seed = seedByNode.get(nodeId) ?? 0;
    const ppf = ppfByNode.get(nodeId) ?? 0;
    const support = clamp01(seed * 0.44 + ppf * 0.32 + queryFit * 0.18 + (node?.evidenceIds.length ? 0.06 : 0));
    if (mode === "support") return support;
    return clamp01(contradictionMass * (0.38 + support * 0.62));
  });
}

function solvePotential(graph: SolverGraph, source: readonly number[], lambda: number, iterations: number): { values: number[]; residual: number } {
  const degree = Array(graph.nodeIds.length).fill(0) as number[];
  const neighbors = graph.nodeIds.map((): Array<{ index: number; conductance: number }> => []);
  for (const edge of graph.edges) {
    degree[edge.source] = (degree[edge.source] ?? 0) + edge.conductance;
    degree[edge.target] = (degree[edge.target] ?? 0) + edge.conductance;
    neighbors[edge.source]!.push({ index: edge.target, conductance: edge.conductance });
    neighbors[edge.target]!.push({ index: edge.source, conductance: edge.conductance });
  }
  let current = source.map(value => clamp01(value));
  for (let step = 0; step < iterations; step++) {
    const next = current.map((_, index) => {
      const coupled = neighbors[index]!.reduce((sum, item) => sum + item.conductance * current[item.index]!, 0);
      return (source[index]! + coupled) / Math.max(lambda, degree[index]! + lambda);
    });
    current = next;
  }
  return { values: current, residual: residual(graph, current, source, degree, lambda) };
}

function normalizePotential(values: readonly number[]): number[] {
  const max = Math.max(0.000001, ...values.map(value => Math.abs(value)));
  return values.map(value => clamp01(value / max));
}

function residual(graph: SolverGraph, values: readonly number[], source: readonly number[], degree: readonly number[], lambda: number): number {
  if (!values.length) return 0;
  const neighborMass = Array(values.length).fill(0) as number[];
  for (const edge of graph.edges) {
    neighborMass[edge.source] = (neighborMass[edge.source] ?? 0) + edge.conductance * values[edge.target]!;
    neighborMass[edge.target] = (neighborMass[edge.target] ?? 0) + edge.conductance * values[edge.source]!;
  }
  return mean(values.map((value, index) => Math.abs((degree[index]! + lambda) * value - neighborMass[index]! - source[index]!)));
}

function potentialEnergy(graph: SolverGraph, values: readonly number[]): number {
  if (!graph.edges.length) return 0;
  return mean(graph.edges.map(edge => edge.conductance * ((values[edge.source] ?? 0) - (values[edge.target] ?? 0)) ** 2));
}

function influenceRows(graph: SolverGraph, support: readonly number[], contradiction: readonly number[]): GreenPotentialResult["evidenceInfluence"] {
  const rows = new Map<string, { influence: number; edgeIds: Set<string> }>();
  for (const edge of graph.edges) {
    const supportFlow = ((support[edge.source] ?? 0) + (support[edge.target] ?? 0)) / 2;
    const contradictionFlow = ((contradiction[edge.source] ?? 0) + (contradiction[edge.target] ?? 0)) / 2;
    const influence = clamp01(edge.conductance * (supportFlow + contradictionFlow * 0.72));
    for (const evidenceId of edge.evidenceIds) {
      const row = rows.get(evidenceId) ?? { influence: 0, edgeIds: new Set<string>() };
      row.influence += influence;
      row.edgeIds.add(edge.id);
      rows.set(evidenceId, row);
    }
  }
  return [...rows.entries()]
    .map(([evidenceId, row]) => ({ evidenceId, influence: clamp01(row.influence), edgeIds: [...row.edgeIds].slice(0, 8) }))
    .sort((left, right) => right.influence - left.influence || left.evidenceId.localeCompare(right.evidenceId))
    .slice(0, 24);
}
