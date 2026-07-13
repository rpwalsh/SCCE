import type { FieldState, GraphEdge, GraphNode } from "./types.js";
import { clamp01, featureSet, toJsonValue, weightedJaccard } from "./primitives.js";
import { createAlphaLayer } from "./alpha.js";
import { personalizedRandomWalkWithRestartDetailed, type RelationTransitionPolicy } from "./ppf.js";
import { createCausalDiscoveryEngine } from "./causal.js";
import { graphEdgePriorClass, graphNodePriorClass, isLearnedPriorClass } from "./proof-boundary.js";
import { scoreGraphEdgeQuality } from "./graph-edge-quality.js";
import { GRAPH_QUALITY_CLASS_IDS } from "./question-routing-ids.js";
import { solveGreenPotentialField } from "./green-potential.js";
import { heatDiffuse, spectralPartition, wavePropagate } from "./equation-operators.js";
import { conditionDisablesComponent, type EvaluationConditionConfig } from "./evaluation-flags.js";
import { executeEvaluationComponent, type EvaluationTraceRecorder } from "./evaluation-trace.js";
import {
  freezeRelationPotentialModel,
  scoreGraphEdgesWithRelationPotential,
  type RelationPotentialEdgeScoreAudit,
  type RelationPotentialModel
} from "./relation-potential.js";

export interface FieldEvaluationContext {
  condition: EvaluationConditionConfig;
  trace: EvaluationTraceRecorder;
}

export interface AlphaFieldEngineOptions {
  alpha?: number;
  relationPolicies?: readonly RelationTransitionPolicy[];
  /** A pre-trained, versioned model used for inference only. */
  relationPotentialModel?: RelationPotentialModel;
}

export function createAlphaFieldEngine(options: AlphaFieldEngineOptions = {}) {
  const causal = createCausalDiscoveryEngine();
  const relationPotentialModel = options.relationPotentialModel === undefined
    ? undefined
    : freezeRelationPotentialModel(options.relationPotentialModel);
  return {
    activate(input: { text: string; nodes: GraphNode[]; edges: GraphEdge[]; previous?: FieldState; seedPriors?: Array<{ nodeId: GraphNode["id"]; weight: number; feature?: string }>; evaluation?: FieldEvaluationContext }): FieldState {
      const requestFeatures = fieldRequestFeatures(input.text);
      const priorByNode = new Map((input.seedPriors ?? []).map(seed => [String(seed.nodeId), clamp01(seed.weight)]));
      const priorFeatureByNode = new Map((input.seedPriors ?? []).map(seed => [String(seed.nodeId), seed.feature ?? "resident-memory-prior"]));
      const seeds = input.nodes
        .map(node => {
          const comparableFeatures = fieldNodeFeatures(node);
          const lexical = weightedJaccard(requestFeatures, comparableFeatures);
          const resident = priorByNode.get(String(node.id)) ?? 0;
          return {
            nodeId: node.id,
            weight: clamp01(Math.max(lexical * node.alpha, resident)),
            feature: lexical >= resident ? firstOverlap(requestFeatures, comparableFeatures) : priorFeatureByNode.get(String(node.id)) ?? "resident-memory-prior"
          };
        })
        .filter(seed => seed.weight > 0)
        .sort((a, b) => b.weight - a.weight)
        .slice(0, 48);
      const nodeIds = new Set(input.nodes.map(node => String(node.id)));
      const boundedEdges = input.edges.filter(edge => nodeIds.has(String(edge.source)) && nodeIds.has(String(edge.target)));
      const relationPotential = relationPotentialEdges({
        edges: boundedEdges,
        model: relationPotentialModel,
        evaluation: input.evaluation
      });
      const diffusionEdges = relationPotential.edges;
      const relationPolicies: readonly RelationTransitionPolicy[] = options.relationPolicies ?? [...new Set(diffusionEdges.map(edge => String(edge.relationId)))]
        .sort()
        .map(relationId => ({ relationId, direction: "directed" as const }));
      const diffusion = seeds.length
        ? evaluateFieldComponent({
          evaluation: input.evaluation,
          component: "query-diffusion",
          boundary: "field.query-diffusion",
          execute: () => personalizedRandomWalkWithRestartDetailed({
            nodes: input.nodes,
            edges: diffusionEdges,
            personalization: seeds,
            relationPolicies,
            restartProbability: 0.15,
            maxIterations: 120,
            tolerance: 1e-10
          }),
          // Query seeds are retained, but no mass is propagated across edges.
          bypass: () => seedOnlyDiffusion(seeds)
        })
        : seedlessQueryDiffusion(input.evaluation);
      // `ppf` is retained in FieldState as a durable compatibility field. Its
      // value is query-conditioned personalized random-walk activation mass.
      const ppf = diffusion.rank;
      const active = ppf.slice(0, 64).map(item => ({ nodeId: item.nodeId, activation: item.mass }));
      const activeNodeIds = active.map(item => String(item.nodeId));
      const alphaTrace = createAlphaLayer(options).buildTrace({ nodes: input.nodes, edges: diffusionEdges, activeNodeIds, previous: input.previous?.alphaTrace });
      const fieldOperators = fieldOperatorTrace(alphaTrace, ppf, input.previous);
      const causalMass = causal.discover({ nodes: input.nodes, edges: diffusionEdges, activeNodeIds: active.map(item => item.nodeId) });
      const greenPotential = solveGreenPotentialField({ nodes: input.nodes, edges: diffusionEdges, requestFeatures, seeds, activeNodeIds, ppf, alphaTrace });
      const importedPriorTrace = importedGraphPriorTrace(input.nodes, diffusionEdges, active, ppf);
      return { requestFeatures, seeds, active, ppf, ppfDiagnostics: toJsonValue({ ...diffusion.diagnostics, omittedOutOfSliceEdges: input.edges.length - diffusionEdges.length, relationPotential: relationPotential.diagnostics, importedPriorTrace, fieldOperators }), alphaTrace, greenPotential: toJsonValue(greenPotential), causalMass };
    }
  };
}

interface FieldRelationPotentialResult {
  edges: GraphEdge[];
  diagnostics: {
    schema: "scce.field_relation_potential.v1";
    mode: "frozen_model" | "identity_unconfigured" | "identity_condition_disabled";
    modelId: string | null;
    datasetHash: string | null;
    edgeCount: number;
    edgeScores: readonly RelationPotentialEdgeScoreAudit[];
  };
}

function relationPotentialEdges(input: {
  edges: GraphEdge[];
  model?: RelationPotentialModel;
  evaluation?: FieldEvaluationContext;
}): FieldRelationPotentialResult {
  const boundary = "field.relation-potential";
  if (input.evaluation && conditionDisablesComponent(input.evaluation.condition, "relation-potential")) {
    input.evaluation.trace.componentBypassed("relation-potential", boundary, "condition-disabled");
    return identity("identity_condition_disabled");
  }
  if (!input.model) {
    input.evaluation?.trace.componentBypassed("relation-potential", boundary, "not-applicable");
    return identity("identity_unconfigured");
  }
  input.evaluation?.trace.componentEntered("relation-potential", boundary);
  const scored = scoreGraphEdgesWithRelationPotential(input.model, input.edges);
  return {
    edges: scored.edges,
    diagnostics: {
      schema: "scce.field_relation_potential.v1",
      mode: "frozen_model",
      modelId: input.model.modelId,
      datasetHash: input.model.datasetHash,
      edgeCount: input.edges.length,
      edgeScores: scored.audit
    }
  };

  function identity(mode: "identity_unconfigured" | "identity_condition_disabled"): FieldRelationPotentialResult {
    return {
      edges: input.edges,
      diagnostics: {
        schema: "scce.field_relation_potential.v1",
        mode,
        modelId: input.model?.modelId ?? null,
        datasetHash: input.model?.datasetHash ?? null,
        edgeCount: input.edges.length,
        edgeScores: []
      }
    };
  }
}

function seedlessQueryDiffusion(evaluation: FieldEvaluationContext | undefined): ReturnType<typeof personalizedRandomWalkWithRestartDetailed> {
  if (evaluation) {
    const disabled = conditionDisablesComponent(evaluation.condition, "query-diffusion");
    evaluation.trace.componentBypassed("query-diffusion", "field.query-diffusion", disabled ? "condition-disabled" : "not-applicable");
  }
  return seedOnlyDiffusion([]);
}

function evaluateFieldComponent<T>(input: {
  evaluation?: FieldEvaluationContext;
  component: "relation-potential" | "query-diffusion";
  boundary: string;
  execute: () => T;
  bypass: () => T;
}): T {
  if (!input.evaluation) return input.execute();
  return executeEvaluationComponent({
    condition: input.evaluation.condition,
    trace: input.evaluation.trace,
    component: input.component,
    boundary: input.boundary,
    execute: input.execute,
    bypass: input.bypass
  });
}

function seedOnlyDiffusion(seeds: readonly { nodeId: GraphNode["id"]; weight: number }[]): ReturnType<typeof personalizedRandomWalkWithRestartDetailed> {
  const total = seeds.reduce((sum, seed) => sum + Math.max(0, seed.weight), 0);
  const rank = seeds
    .map(seed => ({ nodeId: seed.nodeId, mass: total > 0 ? Math.max(0, seed.weight) / total : 0 }))
    .filter(row => row.mass > 0)
    .sort((left, right) => right.mass - left.mass || String(left.nodeId).localeCompare(String(right.nodeId)));
  return {
    rank,
    transition: [],
    teleport: rank.map(row => row.mass),
    diagnostics: {
      algorithm: "personalized_random_walk_with_restart",
      solver: "sparse_power_iteration",
      converged: true,
      iterations: 0,
      residualL1: 0,
      massSum: rank.reduce((sum, row) => sum + row.mass, 0),
      chernoff: 0,
      sde: { drift: 0, entropy: 0, margin: 0, converged: true, adversarialPlateau: false, reason: "condition-disabled" },
      danglingNodes: 0,
      continuationProbability: 0,
      restartProbability: 1,
      damping: 0,
      transitionNonZero: 0,
      transitionShape: [rank.length, rank.length],
      transitionMaterialized: false,
      danglingPolicy: "personalization",
      relationPolicyCounts: { directed: 0, reversible: 0, learnedInverse: 0 },
      relationPolicies: [],
      explicitReverseTransitions: 0,
      syntheticReverseTransitions: 0
    }
  };
}

function fieldOperatorTrace(alphaTrace: FieldState["alphaTrace"], ppf: FieldState["ppf"], previous: FieldState | undefined) {
  const mass = new Map(ppf.map(item => [String(item.nodeId), item.mass]));
  const previousMass = new Map((previous?.ppf ?? []).map(item => [String(item.nodeId), item.mass]));
  const bounded = boundedFieldMatrices(alphaTrace, mass, previousMass);
  const nodes = bounded.nodes;
  const current = nodes.map(nodeId => mass.get(nodeId) ?? 0);
  const prior = nodes.map(nodeId => previousMass.get(nodeId) ?? 0);
  const heat = heatDiffuse({ laplacian: bounded.laplacian, current, steps: 3 });
  const wave = wavePropagate({ laplacian: bounded.laplacian, current: heat.values, previous: prior, damping: 0.08, steps: 1 });
  const spectral = spectralPartition({ nodes, laplacian: bounded.normalizedLaplacian, iterations: 6 });
  return {
    schema: "scce.field_operators.v2",
    heat: { energy: heat.energy, residual: heat.residual, topNodes: topFieldNodes(nodes, heat.values) },
    wave: { energy: wave.energy, momentum: wave.momentum, topNodes: topFieldNodes(nodes, wave.values) },
    spectral: {
      algebraicConnectivity: spectral.algebraicConnectivity,
      partitionEigengap: spectral.partitionEigengap,
      converged: spectral.converged,
      residual: spectral.residual,
      clusters: spectral.clusters.map(cluster => ({ id: cluster.id, mass: cluster.mass, nodeCount: cluster.nodeIds.length }))
    }
  };
}

function boundedFieldMatrices(alphaTrace: FieldState["alphaTrace"], mass: Map<string, number>, previousMass: Map<string, number>, limit = 48) {
  const allNodes = alphaTrace.laplacian.nodes;
  const selected = allNodes
    .map((nodeId, index) => ({
      nodeId,
      index,
      score: Math.max(mass.get(nodeId) ?? 0, previousMass.get(nodeId) ?? 0, Math.abs(alphaTrace.laplacian.values[index]?.[index] ?? 0))
    }))
    .sort((left, right) => right.score - left.score || left.nodeId.localeCompare(right.nodeId))
    .slice(0, limit)
    .sort((left, right) => left.index - right.index);
  const indices = selected.map(row => row.index);
  return {
    nodes: selected.map(row => row.nodeId),
    laplacian: submatrix(alphaTrace.laplacian.values, indices),
    normalizedLaplacian: submatrix(alphaTrace.normalizedLaplacian.values, indices)
  };
}

function submatrix(matrix: readonly (readonly number[])[], indices: readonly number[]): number[][] {
  return indices.map(row => indices.map(col => matrix[row]?.[col] ?? 0));
}

function topFieldNodes(nodes: readonly string[], values: readonly number[]): Array<{ nodeId: string; value: number }> {
  return nodes
    .map((nodeId, index) => ({ nodeId, value: values[index] ?? 0 }))
    .filter(row => row.value > 0)
    .sort((left, right) => right.value - left.value || left.nodeId.localeCompare(right.nodeId))
    .slice(0, 12);
}

function fieldRequestFeatures(text: string): string[] {
  const focused = featureSet(text, 512).filter(isFieldActivationFeature);
  return focused.length ? focused : featureSet(text, 512).filter(feature => !feature.startsWith("char:"));
}

function fieldNodeFeatures(node: GraphNode): string[] {
  const alreadyNormalized = node.features.filter(feature => feature.startsWith("sym:") || feature.startsWith("bi:") || feature.startsWith("tri:"));
  const sourceFeatures = featureSet(`${node.features.join(" ")} ${JSON.stringify(node.representation)}`, 512).filter(isFieldActivationFeature);
  return [...new Set([...alreadyNormalized, ...sourceFeatures])];
}

function isFieldActivationFeature(feature: string): boolean {
  if (feature.startsWith("tri:")) return featureUnits(feature).filter(isInformationBearingUnit).length >= 2;
  if (feature.startsWith("bi:")) return featureUnits(feature).every(isInformationBearingUnit);
  if (feature.startsWith("sym:")) return isInformationBearingUnit(feature.slice(4));
  return false;
}

function featureUnits(feature: string): string[] {
  const index = feature.indexOf(":");
  const body = index >= 0 ? feature.slice(index + 1) : feature;
  return body.split("|").filter(Boolean);
}

function isInformationBearingUnit(unit: string): boolean {
  const clean = unit.normalize("NFKC").toLocaleLowerCase().replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, "");
  if (clean.length < 4) return false;
  let alphaNumeric = 0;
  for (const char of clean) if (/[\p{L}\p{N}]/u.test(char)) alphaNumeric++;
  return alphaNumeric >= 4;
}

function firstOverlap(a: readonly string[], b: readonly string[]): string {
  const right = new Set(b);
  return a.find(item => right.has(item)) ?? "";
}

function importedGraphPriorTrace(
  nodes: readonly GraphNode[],
  edges: readonly GraphEdge[],
  active: readonly { nodeId: GraphNode["id"]; activation: number }[],
  ppf: readonly { nodeId: GraphNode["id"]; mass: number }[]
) {
  const activeIds = new Set(active.map(item => String(item.nodeId)));
  const massByNode = new Map(ppf.map(item => [String(item.nodeId), item.mass]));
  const importedNodes = nodes
    .map(node => ({ node, forceClass: graphNodePriorClass(node), mass: massByNode.get(String(node.id)) ?? 0, active: activeIds.has(String(node.id)) }))
    .filter(item => isLearnedPriorClass(item.forceClass));
  const importedEdges = edges
    .map(edge => ({ edge, forceClass: graphEdgePriorClass(edge), quality: graphEdgeQuality(edge, nodes) }))
    .filter(item => isLearnedPriorClass(item.forceClass));
  const activatedEdges = importedEdges.filter(item => activeIds.has(String(item.edge.source)) || activeIds.has(String(item.edge.target)));
  return {
    importedGraphNodeCount: importedNodes.length,
    importedGraphNodeCountActivated: importedNodes.filter(item => item.active || item.mass > 0).length,
    importedGraphEdgeCount: importedEdges.length,
    importedGraphEdgeCountActivated: activatedEdges.length,
    answerGradeImportedGraphEdgeCount: importedEdges.filter(item => item.quality.answerGrade).length,
    weakImportedGraphEdgeCount: importedEdges.filter(item => item.quality.classId === GRAPH_QUALITY_CLASS_IDS.weakFragment).length,
    categoryImportedGraphEdgeCount: importedEdges.filter(item => item.quality.classId === GRAPH_QUALITY_CLASS_IDS.catalogNavigation).length,
    noisyImportedGraphEdgeCount: importedEdges.filter(item => item.quality.classId === GRAPH_QUALITY_CLASS_IDS.noisyMarkup).length,
    answerGradeImportedGraphEdgeCountActivated: activatedEdges.filter(item => item.quality.answerGrade).length,
    weakImportedGraphEdgeCountActivated: activatedEdges.filter(item => item.quality.classId === GRAPH_QUALITY_CLASS_IDS.weakFragment).length,
    categoryImportedGraphEdgeCountActivated: activatedEdges.filter(item => item.quality.classId === GRAPH_QUALITY_CLASS_IDS.catalogNavigation).length,
    noisyImportedGraphEdgeCountActivated: activatedEdges.filter(item => item.quality.classId === GRAPH_QUALITY_CLASS_IDS.noisyMarkup).length,
    topImportedPriorNodesByMass: importedNodes
      .filter(item => item.mass > 0)
      .sort((a, b) => b.mass - a.mass || String(a.node.id).localeCompare(String(b.node.id)))
      .slice(0, 24)
      .map(item => ({
        nodeId: item.node.id,
        mass: item.mass,
        activated: item.active,
        forceClass: item.forceClass,
        label: graphNodeLabel(item.node)
      }))
  };
}

function graphEdgeQuality(edge: GraphEdge, nodes: readonly GraphNode[]) {
  const nodeById = new Map(nodes.map(node => [String(node.id), node]));
  const metadata = objectRecord(edge.metadata) ?? {};
  const relation = objectRecord(metadata.relation) ?? metadata;
  const subject = firstString(relation.subject, relation.source, relation.from) ?? graphNodeLabel(nodeById.get(String(edge.source)));
  const predicate = firstString(relation.predicate, relation.relation, relation.type) ?? String(edge.relationId);
  const object = firstString(relation.object, relation.target, relation.to) ?? graphNodeLabel(nodeById.get(String(edge.target)));
  return scoreGraphEdgeQuality({
    edgeId: String(edge.id),
    relationId: String(edge.relationId),
    subject,
    predicate,
    object,
    weight: edge.weight,
    alpha: edge.alpha,
    forceClass: graphEdgePriorClass(edge)
  });
}

function graphNodeLabel(node: GraphNode | undefined): string {
  if (!node) return "";
  const rep = node.representation;
  if (typeof rep === "string") return rep.slice(0, 160);
  if (!rep || typeof rep !== "object" || Array.isArray(rep)) return String(node.id);
  const record = rep as Record<string, unknown>;
  for (const key of ["label", "name", "text", "conceptId", "type"]) {
    const value = record[key];
    if (typeof value === "string" && value.trim()) return value.slice(0, 160);
  }
  return String(node.id);
}

function objectRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function firstString(...values: readonly unknown[]): string | undefined {
  for (const value of values) if (typeof value === "string" && value.trim()) return value;
  return undefined;
}
