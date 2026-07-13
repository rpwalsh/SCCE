import type { GraphEdge, GraphNode, GraphSnapshot, Hasher, JsonValue, NodeId } from "./types.js";
import { clamp01, createHasher, mean, normalizeVector, toJsonValue, weightedJaccard } from "./primitives.js";

export interface CausalVariable {
  nodeId: NodeId;
  label: string;
  features: string[];
  alpha: number;
  prior: number;
  observed?: number;
}

export interface CausalMechanism {
  id: string;
  source: NodeId;
  target: NodeId;
  relation: string;
  weight: number;
  alpha: number;
  lag: number;
  sign: 1 | -1;
  evidenceIds: string[];
}

export interface CounterfactualIntervention {
  id: string;
  nodeId: NodeId;
  value: number;
  operator: "set" | "increase" | "decrease" | "clamp";
  confidence: number;
  reason: string;
}

export interface CounterfactualWorld {
  id: string;
  variables: Array<{ nodeId: NodeId; factual: number; counterfactual: number; delta: number }>;
  interventions: CounterfactualIntervention[];
  effect: Array<{ nodeId: NodeId; effect: number; lower: number; upper: number; pathSupport: number }>;
  constraints: Array<{ id: string; passed: boolean; pressure: number; message: string }>;
  explanation: CounterfactualPath[];
  audit: JsonValue;
}

export interface CounterfactualPath {
  id: string;
  nodes: NodeId[];
  mechanisms: string[];
  product: number;
  alpha: number;
  lag: number;
  support: number;
}

export interface CounterfactualQuery {
  targetFeatures: string[];
  interventions: CounterfactualIntervention[];
  horizon?: number;
  damping?: number;
  maxPaths?: number;
}

export interface CounterfactualModel {
  id: string;
  variables: CausalVariable[];
  mechanisms: CausalMechanism[];
  transition: number[][];
  audit: JsonValue;
}

export function createCounterfactualCognition(options: { hasher?: Hasher; maxVariables?: number } = {}) {
  const hasher = options.hasher ?? createHasher();
  const maxVariables = Math.max(8, options.maxVariables ?? 4096);
  return {
    model(graph: GraphSnapshot): CounterfactualModel {
      return modelFromGraph(graph, hasher, maxVariables);
    },

    simulate(input: { graph: GraphSnapshot; query: CounterfactualQuery }): CounterfactualWorld {
      const model = modelFromGraph(input.graph, hasher, maxVariables);
      return simulateCounterfactual(model, input.query, hasher);
    },

    compare(input: { factual: CounterfactualWorld; alternative: CounterfactualWorld }): JsonValue {
      const deltas = new Map<string, number>();
      for (const item of input.factual.effect) deltas.set(String(item.nodeId), item.effect);
      const comparison = input.alternative.effect.map(item => ({
        nodeId: item.nodeId,
        factual: deltas.get(String(item.nodeId)) ?? 0,
        alternative: item.effect,
        delta: item.effect - (deltas.get(String(item.nodeId)) ?? 0)
      })).sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta));
      return toJsonValue({ comparison, factual: input.factual.id, alternative: input.alternative.id });
    }
  };
}

function modelFromGraph(graph: GraphSnapshot, hasher: Hasher, maxVariables: number): CounterfactualModel {
  const nodes = graph.nodes
    .slice()
    .sort((a, b) => b.alpha - a.alpha || String(a.id).localeCompare(String(b.id)))
    .slice(0, maxVariables);
  const nodeSet = new Set(nodes.map(node => String(node.id)));
  const variables = nodes.map(node => variableFromNode(node));
  const mechanisms = graph.edges
    .filter(edge => nodeSet.has(String(edge.source)) && nodeSet.has(String(edge.target)))
    .map(edge => mechanismFromEdge(edge, hasher))
    .sort((a, b) => Math.abs(b.weight * b.alpha) - Math.abs(a.weight * a.alpha));
  const transition = transitionFrom(variables, mechanisms);
  const id = `counterfactual_model_${hasher.digestHex(JSON.stringify({ nodes: variables.map(v => v.nodeId), mechanisms: mechanisms.map(m => m.id) })).slice(0, 32)}`;
  return {
    id,
    variables,
    mechanisms,
    transition,
    audit: toJsonValue({
      variables: variables.length,
      mechanisms: mechanisms.length,
      density: mechanisms.length / Math.max(1, variables.length * variables.length),
      alphaMean: mean(variables.map(v => v.alpha))
    })
  };
}

function variableFromNode(node: GraphNode): CausalVariable {
  const observed = numericObservation(node.representation);
  return {
    nodeId: node.id,
    label: nodeLabel(node),
    features: node.features,
    alpha: node.alpha,
    prior: observed ?? clamp01(0.5 * node.alpha + Math.min(0.5, node.evidenceIds.length / 12)),
    observed
  };
}

function mechanismFromEdge(edge: GraphEdge, hasher: Hasher): CausalMechanism {
  const relation = String(edge.relationId);
  const metadata = edge.metadata && typeof edge.metadata === "object" && !Array.isArray(edge.metadata) ? edge.metadata as Record<string, JsonValue> : {};
  const polarity = typeof metadata.polarity === "number" ? metadata.polarity : typeof metadata.sign === "number" ? metadata.sign : 1;
  const sign: 1 | -1 = polarity < 0 ? -1 : 1;
  const lag = lagFromEdge(edge);
  return {
    id: `mechanism_${hasher.digestHex(`${edge.source}:${edge.relationId}:${edge.target}:${edge.id}`).slice(0, 24)}`,
    source: edge.source,
    target: edge.target,
    relation,
    weight: clamp01(Math.abs(edge.weight)),
    alpha: clamp01(edge.alpha),
    lag,
    sign,
    evidenceIds: edge.evidenceIds.map(String)
  };
}

function transitionFrom(variables: readonly CausalVariable[], mechanisms: readonly CausalMechanism[]): number[][] {
  const index = new Map(variables.map((variable, i) => [String(variable.nodeId), i]));
  const matrix = variables.map(() => new Array<number>(variables.length).fill(0));
  for (let i = 0; i < variables.length; i++) matrix[i]![i] = 0.12 + 0.18 * variables[i]!.alpha;
  for (const mechanism of mechanisms) {
    const source = index.get(String(mechanism.source));
    const target = index.get(String(mechanism.target));
    if (source === undefined || target === undefined) continue;
    matrix[source]![target] = (matrix[source]![target] ?? 0) + mechanism.sign * mechanism.weight * mechanism.alpha;
  }
  return matrix;
}

function simulateCounterfactual(model: CounterfactualModel, query: CounterfactualQuery, hasher: Hasher): CounterfactualWorld {
  const index = new Map(model.variables.map((variable, i) => [String(variable.nodeId), i]));
  const factual = normalizeVector(model.variables.map(variable => variable.prior), 1 / Math.max(1, model.variables.length));
  let counterfactual = factual.slice();
  for (const intervention of query.interventions) {
    const i = index.get(String(intervention.nodeId));
    if (i === undefined) continue;
    const prior = counterfactual[i] ?? 0;
    counterfactual[i] =
      intervention.operator === "set" ? clamp01(intervention.value) :
      intervention.operator === "increase" ? clamp01(prior + intervention.value) :
      intervention.operator === "decrease" ? clamp01(prior - intervention.value) :
      clamp01(Math.min(prior, intervention.value));
  }
  const horizon = Math.max(1, Math.min(64, query.horizon ?? 8));
  const damping = clamp01(query.damping ?? 0.82);
  const clamped = new Set(query.interventions.map(item => String(item.nodeId)));
  for (let step = 0; step < horizon; step++) {
    const next = counterfactual.slice();
    for (let i = 0; i < model.transition.length; i++) {
      const sourceMass = counterfactual[i] ?? 0;
      for (let j = 0; j < model.transition.length; j++) {
        if (clamped.has(String(model.variables[j]!.nodeId))) continue;
        const influence = model.transition[i]?.[j] ?? 0;
        next[j] = clamp01((next[j] ?? 0) + damping * sourceMass * influence / Math.max(1, horizon));
      }
    }
    counterfactual = next;
  }
  const variables = model.variables.map((variable, i) => ({
    nodeId: variable.nodeId,
    factual: factual[i] ?? 0,
    counterfactual: counterfactual[i] ?? 0,
    delta: (counterfactual[i] ?? 0) - (factual[i] ?? 0)
  }));
  const targetSet = targetVariables(model, query.targetFeatures);
  const paths = explainPaths(model, query.interventions, targetSet, query.maxPaths ?? 64, hasher);
  const effect = targetSet.map(variable => {
    const i = index.get(String(variable.nodeId)) ?? -1;
    const delta = i >= 0 ? (counterfactual[i] ?? 0) - (factual[i] ?? 0) : 0;
    const support = paths.filter(path => path.nodes.some(node => String(node) === String(variable.nodeId))).reduce((sum, path) => sum + path.support, 0);
    const width = Math.max(0.03, (1 - clamp01(support)) * 0.35);
    return { nodeId: variable.nodeId, effect: delta, lower: delta - width, upper: delta + width, pathSupport: clamp01(support) };
  }).sort((a, b) => Math.abs(b.effect) - Math.abs(a.effect));
  const constraints = constraintChecks(model, query, variables, effect);
  const id = `counterfactual_world_${hasher.digestHex(JSON.stringify({ model: model.id, interventions: query.interventions.map(i => i.id), effect: effect.map(e => [e.nodeId, e.effect]) })).slice(0, 32)}`;
  return {
    id,
    variables,
    interventions: query.interventions,
    effect,
    constraints,
    explanation: paths,
    audit: toJsonValue({
      modelId: model.id,
      horizon,
      damping,
      interventions: query.interventions,
      targetFeatures: query.targetFeatures,
      constraints,
      topEffects: effect.slice(0, 16)
    })
  };
}

function targetVariables(model: CounterfactualModel, features: readonly string[]): CausalVariable[] {
  if (features.length === 0) return model.variables.slice(0, Math.min(16, model.variables.length));
  return model.variables
    .map(variable => ({ variable, score: weightedJaccard(features, variable.features) }))
    .filter(item => item.score > 0.02)
    .sort((a, b) => b.score - a.score || b.variable.alpha - a.variable.alpha)
    .slice(0, 32)
    .map(item => item.variable);
}

function explainPaths(model: CounterfactualModel, interventions: readonly CounterfactualIntervention[], targets: readonly CausalVariable[], maxPaths: number, hasher: Hasher): CounterfactualPath[] {
  const targetIds = new Set(targets.map(target => String(target.nodeId)));
  const outgoing = new Map<string, CausalMechanism[]>();
  for (const mechanism of model.mechanisms) {
    const bucket = outgoing.get(String(mechanism.source)) ?? [];
    bucket.push(mechanism);
    outgoing.set(String(mechanism.source), bucket);
  }
  const paths: CounterfactualPath[] = [];
  for (const intervention of interventions) {
    const queue: Array<{ nodes: NodeId[]; mechanisms: CausalMechanism[]; product: number; alpha: number; lag: number }> = [
      { nodes: [intervention.nodeId], mechanisms: [], product: intervention.confidence, alpha: intervention.confidence, lag: 0 }
    ];
    const seen = new Set<string>();
    while (queue.length && paths.length < maxPaths) {
      const current = queue.shift()!;
      const tail = current.nodes[current.nodes.length - 1]!;
      if (current.nodes.length > 1 && targetIds.has(String(tail))) {
        paths.push(pathFrom(current, hasher));
      }
      if (current.nodes.length >= 8) continue;
      for (const mechanism of outgoing.get(String(tail)) ?? []) {
        if (current.nodes.some(node => String(node) === String(mechanism.target))) continue;
        const key = `${current.nodes.map(String).join(">")}:${mechanism.id}`;
        if (seen.has(key)) continue;
        seen.add(key);
        const product = current.product * mechanism.weight * mechanism.sign;
        const alpha = current.alpha * mechanism.alpha;
        if (Math.abs(product * alpha) < 0.002) continue;
        queue.push({
          nodes: [...current.nodes, mechanism.target],
          mechanisms: [...current.mechanisms, mechanism],
          product,
          alpha,
          lag: current.lag + mechanism.lag
        });
      }
      queue.sort((a, b) => Math.abs(b.product * b.alpha) - Math.abs(a.product * a.alpha));
    }
  }
  return paths.sort((a, b) => b.support - a.support || Math.abs(b.product) - Math.abs(a.product)).slice(0, maxPaths);
}

function pathFrom(input: { nodes: NodeId[]; mechanisms: CausalMechanism[]; product: number; alpha: number; lag: number }, hasher: Hasher): CounterfactualPath {
  const support = clamp01(Math.abs(input.product) * input.alpha / Math.max(1, 1 + input.lag * 0.1));
  return {
    id: `cf_path_${hasher.digestHex(`${input.nodes.map(String).join(">")}:${input.mechanisms.map(m => m.id).join(">")}`).slice(0, 24)}`,
    nodes: input.nodes,
    mechanisms: input.mechanisms.map(m => m.id),
    product: input.product,
    alpha: input.alpha,
    lag: input.lag,
    support
  };
}

function constraintChecks(model: CounterfactualModel, query: CounterfactualQuery, variables: CounterfactualWorld["variables"], effect: CounterfactualWorld["effect"]): CounterfactualWorld["constraints"] {
  const constraints: CounterfactualWorld["constraints"] = [];
  const interventionIds = new Set(query.interventions.map(item => String(item.nodeId)));
  const impossible = variables.filter(variable => variable.counterfactual < -1e-9 || variable.counterfactual > 1 + 1e-9);
  constraints.push({ id: "bounded-unit-interval", passed: impossible.length === 0, pressure: impossible.length / Math.max(1, variables.length), message: "counterfactual state remains in unit interval" });
  const unsupported = effect.filter(item => item.pathSupport < 0.08 && Math.abs(item.effect) > 0.08);
  constraints.push({ id: "effect-path-support", passed: unsupported.length === 0, pressure: unsupported.length / Math.max(1, effect.length), message: "material effects have explanatory paths" });
  const directEffects = effect.filter(item => interventionIds.has(String(item.nodeId)) && Math.abs(item.effect) > 0.001);
  constraints.push({ id: "intervention-visible", passed: query.interventions.length === 0 || directEffects.length > 0, pressure: query.interventions.length ? 1 - directEffects.length / query.interventions.length : 0, message: "interventions visibly affect their assigned variables" });
  const disconnected = model.mechanisms.length === 0 && model.variables.length > 1;
  constraints.push({ id: "mechanism-connectivity", passed: !disconnected, pressure: disconnected ? 1 : 0, message: "model contains mechanisms for propagation" });
  return constraints;
}

function nodeLabel(node: GraphNode): string {
  const rep = node.representation;
  if (typeof rep === "string") return rep;
  if (rep && typeof rep === "object" && !Array.isArray(rep)) {
    const record = rep as Record<string, JsonValue>;
    for (const key of ["label", "name", "text", "predicate"]) {
      if (typeof record[key] === "string") return record[key] as string;
    }
  }
  return String(node.id);
}

function numericObservation(value: JsonValue): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return clamp01(value);
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const record = value as Record<string, JsonValue>;
  for (const key of ["value", "score", "probability", "alpha", "mass"]) {
    const raw = record[key];
    if (typeof raw === "number" && Number.isFinite(raw)) return clamp01(raw);
  }
  return undefined;
}

function lagFromEdge(edge: GraphEdge): number {
  const meta = edge.metadata;
  if (meta && typeof meta === "object" && !Array.isArray(meta)) {
    const value = (meta as Record<string, JsonValue>).lag;
    if (typeof value === "number" && Number.isFinite(value)) return Math.max(0, value);
  }
  const scope = edge.temporalScope;
  if (scope.validTo !== undefined) return Math.max(0, scope.validTo - scope.validFrom);
  return 1;
}
