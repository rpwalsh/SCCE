import type { FieldState, GraphEdge, GraphNode, JsonValue, NodeId } from "./types.js";
import { clamp01, mean, toJsonValue } from "./primitives.js";
import { davisKahanSinTheta } from "./causal-math.js";

export interface StructuralAdjustmentHypothesis {
  treatment: NodeId;
  outcome: NodeId;
  variables: NodeId[];
  kind: "backdoor_candidate" | "frontdoor_candidate" | "topological_context";
  assumptionsVerified: false;
  reason: string;
}

export interface GraphEffectHeuristicComponent {
  assignment: number[];
  graphContextMass: number;
  graphEffectHeuristic: number;
}

export interface GraphOnlyCausalEffectAssessment {
  numericalEffectStatus: "not_identified";
  numericalEffect: null;
  reason: string;
  treatment: NodeId;
  outcome: NodeId;
  structuralAdjustmentHypothesis: StructuralAdjustmentHypothesis;
  graphEffectHeuristic: number;
  spectralStability: ReturnType<typeof davisKahanSinTheta>;
  components: GraphEffectHeuristicComponent[];
  audit: JsonValue;
}

export type PfaceEstimate = GraphOnlyCausalEffectAssessment;

export function createPfaceEstimator() {
  return {
    estimate(input: { nodes: GraphNode[]; edges: GraphEdge[]; field: FieldState; treatment?: NodeId; outcome?: NodeId; homogeneityVerified?: boolean }): PfaceEstimate | undefined {
      const pair = choosePair(input.nodes, input.edges, input.field, input.treatment, input.outcome);
      if (!pair) return undefined;
      const structuralAdjustmentHypothesis = findStructuralAdjustmentHypothesis(pair.treatment, pair.outcome, input.nodes, input.edges);
      const ppfMass = new Map(input.field.ppf.map(item => [String(item.nodeId), item.mass]));
      const components = enumerateStructuralContexts(structuralAdjustmentHypothesis.variables.slice(0, 8), ppfMass).map(context => ({
        ...context,
        graphEffectHeuristic: localGraphEffectHeuristic(
          pair.treatment,
          pair.outcome,
          structuralAdjustmentHypothesis.variables,
          context.assignment,
          input.nodes,
          input.edges
        )
      }));
      const graphEffectHeuristic = components.reduce((sum, row) => sum + row.graphEffectHeuristic * row.graphContextMass, 0);
      const spectralStability = davisKahanSinTheta({
        base: input.field.alphaTrace.normalizedLaplacian.values,
        perturbed: input.field.alphaTrace.laplacian.values,
        priorGap: Math.max(1e-6, input.field.alphaTrace.surfaces.bond)
      });
      const reason = "causal structure hypothesis available; numerical causal effect not identified without treatment/outcome observations and validated identification assumptions";
      return {
        numericalEffectStatus: "not_identified",
        numericalEffect: null,
        reason,
        treatment: pair.treatment,
        outcome: pair.outcome,
        structuralAdjustmentHypothesis,
        graphEffectHeuristic,
        spectralStability,
        components,
        audit: toJsonValue({
          numericalEffectStatus: "not_identified",
          numericalEffect: null,
          reason,
          treatment: pair.treatment,
          outcome: pair.outcome,
          structuralAdjustmentHypothesis,
          graphEffectHeuristic,
          spectralStability,
          componentCount: components.length,
          homogeneityFlagDoesNotIdentifyNumericalEffect: input.homogeneityVerified === true
        })
      };
    }
  };
}

function choosePair(nodes: GraphNode[], edges: GraphEdge[], field: FieldState, treatment?: NodeId, outcome?: NodeId): { treatment: NodeId; outcome: NodeId } | undefined {
  if (treatment && outcome) return { treatment, outcome };
  const active = field.ppf.slice(0, 12).map(item => item.nodeId);
  for (const source of active) {
    const outgoing = edges.filter(edge => edge.source === source).sort((a, b) => b.alpha * b.weight - a.alpha * a.weight);
    const target = outgoing.find(edge => nodes.some(node => node.id === edge.target))?.target;
    if (target && target !== source) return { treatment: source, outcome: target };
  }
  const edge = [...edges].sort((a, b) => b.alpha * b.weight - a.alpha * a.weight)[0];
  return edge ? { treatment: edge.source, outcome: edge.target } : undefined;
}

function findStructuralAdjustmentHypothesis(treatment: NodeId, outcome: NodeId, nodes: GraphNode[], edges: GraphEdge[]): StructuralAdjustmentHypothesis {
  const parentsOfTreatment = incoming(treatment, edges);
  const parentsOfOutcome = incoming(outcome, edges).filter(id => id !== treatment);
  const common = parentsOfTreatment.filter(id => parentsOfOutcome.includes(id));
  if (common.length) {
    return {
      treatment,
      outcome,
      variables: common.slice(0, 8),
      kind: "backdoor_candidate",
      assumptionsVerified: false,
      reason: "common-parent topology suggests an adjustment candidate; identification assumptions are unverified"
    };
  }
  const mediators = outgoing(treatment, edges).filter(id => id !== outcome && incoming(outcome, edges).includes(id));
  if (mediators.length) {
    return {
      treatment,
      outcome,
      variables: mediators.slice(0, 8),
      kind: "frontdoor_candidate",
      assumptionsVerified: false,
      reason: "two-edge mediator topology suggests an adjustment candidate; identification assumptions are unverified"
    };
  }
  const highMassNeighbors = [...new Set([...parentsOfOutcome, ...parentsOfTreatment, ...outgoing(treatment, edges), ...incoming(outcome, edges)])]
    .filter(id => nodes.some(node => node.id === id && id !== treatment && id !== outcome));
  return {
    treatment,
    outcome,
    variables: highMassNeighbors.slice(0, 6),
    kind: "topological_context",
    assumptionsVerified: false,
    reason: "neighboring nodes supplied as graph context; no adjustment criterion was established"
  };
}

function enumerateStructuralContexts(variables: NodeId[], ppfMass: Map<string, number>): Array<{ assignment: number[]; graphContextMass: number }> {
  const count = 2 ** variables.length;
  if (variables.length === 0) return [{ assignment: [], graphContextMass: 1 }];
  const rows: Array<{ assignment: number[]; graphContextMass: number }> = [];
  for (let mask = 0; mask < count; mask++) {
    const assignment = variables.map((_, i) => (mask & (1 << i)) ? 1 : 0);
    const rawGraphMass = assignment.reduce<number>((product, bit, i) => {
      const mass = clamp01(ppfMass.get(String(variables[i])) ?? 0.5);
      return product * (bit ? mass : 1 - mass);
    }, 1);
    rows.push({ assignment, graphContextMass: rawGraphMass });
  }
  const total = rows.reduce((sum, row) => sum + row.graphContextMass, 0);
  return rows.map(row => ({ ...row, graphContextMass: total > 0 ? row.graphContextMass / total : 1 / count }));
}

function localGraphEffectHeuristic(treatment: NodeId, outcome: NodeId, contextNodes: NodeId[], assignment: number[], nodes: GraphNode[], edges: GraphEdge[]): number {
  const direct = edgeWeight(treatment, outcome, edges);
  const mediatedPathScore = mean(contextNodes.map((nodeId, i) => (assignment[i] ? 1 : -1) * edgeWeight(treatment, nodeId, edges) * edgeWeight(nodeId, outcome, edges)));
  const treatmentAlpha = nodes.find(node => node.id === treatment)?.alpha ?? 0.5;
  const outcomeAlpha = nodes.find(node => node.id === outcome)?.alpha ?? 0.5;
  return clampSigned(0.55 * direct + 0.25 * mediatedPathScore + 0.2 * (outcomeAlpha - treatmentAlpha));
}

function incoming(nodeId: NodeId, edges: GraphEdge[]): NodeId[] {
  return edges.filter(edge => edge.target === nodeId).map(edge => edge.source);
}

function outgoing(nodeId: NodeId, edges: GraphEdge[]): NodeId[] {
  return edges.filter(edge => edge.source === nodeId).map(edge => edge.target);
}

function edgeWeight(source: NodeId, target: NodeId, edges: GraphEdge[]): number {
  const edge = edges.find(item => item.source === source && item.target === target);
  return edge ? clamp01(edge.weight * edge.alpha) : 0;
}

function clampSigned(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(-1, Math.min(1, value));
}
