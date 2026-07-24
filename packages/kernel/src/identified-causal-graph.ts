import type { Clock, Hasher, JsonValue, NodeId } from "./types.js";
import { canonicalStringify, toJsonValue } from "./primitives.js";
import {
  createConformalCausalRiskInterval,
  type ConformalCausalRiskInterval
} from "./conformal-causal-risk.js";

export interface AssociationalNode {
  id: NodeId;
}

export interface AssociationalEdge {
  id: string;
  left: NodeId;
  right: NodeId;
  statisticId: string;
  value: number;
  sampleSize: number;
  evidenceIds: string[];
}

export interface AssociationalGraph {
  kind: "associational_graph";
  nodes: AssociationalNode[];
  edges: AssociationalEdge[];
}

export interface CausalAssumptionEdge {
  id: string;
  cause: NodeId;
  effect: NodeId;
  evidenceIds: string[];
}

export interface CausalAssumptionDag {
  kind: "causal_assumption_dag";
  assumptionSetId: string;
  nodes: NodeId[];
  edges: CausalAssumptionEdge[];
  evidenceIds: string[];
}

export interface CausalObservation {
  id: string;
  values: Readonly<Record<string, number>>;
  evidenceIds: string[];
}

export interface BackdoorIdentificationDesign {
  kind: "backdoor_adjustment";
  treatment: NodeId;
  outcome: NodeId;
  adjustmentSet: NodeId[];
  dag: CausalAssumptionDag;
  assumptions: {
    consistency: true;
    noInterference: true;
    noUnmeasuredConfoundingGivenAdjustment: true;
    temporalOrderEstablished: true;
    positivityExpected: true;
  };
}

export interface RandomizedInterventionDesign {
  kind: "randomized_intervention";
  treatment: NodeId;
  outcome: NodeId;
  assignmentMechanismId: string;
  assignmentEvidenceIds: string[];
  assumptions: {
    randomizedAssignment: true;
    consistency: true;
    noInterference: true;
    outcomeObservedAfterAssignment: true;
  };
}

export type IdentificationDesign =
  | BackdoorIdentificationDesign
  | RandomizedInterventionDesign;

export interface CausalStratumEstimate {
  adjustmentValues: Record<string, number>;
  sampleCount: number;
  treatedCount: number;
  controlCount: number;
  treatedMean: number;
  controlMean: number;
  effect: number;
  populationWeight: number;
}

export interface IdentifiedCausalClaim {
  id: string;
  createdAt: number;
  estimand: "average_treatment_effect";
  treatment: NodeId;
  outcome: NodeId;
  treatmentContrast: { control: 0; treated: 1 };
  estimate: number;
  identification:
    | {
        kind: "backdoor_adjustment";
        assumptionSetId: string;
        adjustmentSet: NodeId[];
        validatedBackdoorCriterion: true;
        empiricalPositivity: true;
      }
    | {
        kind: "randomized_intervention";
        assignmentMechanismId: string;
        assignmentEvidenceIds: string[];
        randomizedAssignmentAsserted: true;
      };
  strata: CausalStratumEstimate[];
  riskInterval: ConformalCausalRiskInterval;
  observationEvidenceIds: string[];
  warnings: [
    "identification depends on the supplied assumptions",
    "the risk interval is not a parameter confidence interval"
  ];
}

export interface CausalIdentificationAudit {
  designKind: IdentificationDesign["kind"] | "missing";
  associationContextPresent: boolean;
  associationContextUsedForIdentification: false;
  associationContextValidation: {
    valid: boolean;
    reasons: string[];
  } | null;
  causalDagValidated: boolean;
  explicitAssumptionsValidated: boolean;
  empiricalPositivityValidated: boolean;
  observationCount: number;
  reasons: string[];
}

export type IdentifiedCausalEstimateResult =
  | {
      status: "identified";
      claim: IdentifiedCausalClaim;
      audit: CausalIdentificationAudit;
      trace: JsonValue;
    }
  | {
      status: "rejected";
      claim: null;
      audit: CausalIdentificationAudit;
      trace: JsonValue;
    };

export interface IdentifiedCausalEstimateInput {
  observations: CausalObservation[];
  design?: IdentificationDesign;
  associationContext?: AssociationalGraph;
  targetRiskCoverage: number;
}

export interface IdentifiedCausalGraphDependencies {
  clock: Clock;
  hasher: Hasher;
}

export function validateAssociationalGraph(graph: AssociationalGraph): {
  valid: boolean;
  reasons: string[];
} {
  const reasons: string[] = [];
  const nodes = new Set<string>();
  for (const node of graph.nodes) {
    const id = String(node.id);
    if (!id) reasons.push("association_node_id_required");
    if (nodes.has(id)) reasons.push(`duplicate_association_node:${id}`);
    nodes.add(id);
  }
  const edgeIds = new Set<string>();
  for (const edge of graph.edges) {
    if (!edge.id) reasons.push("association_edge_id_required");
    if (edgeIds.has(edge.id)) reasons.push(`duplicate_association_edge:${edge.id}`);
    edgeIds.add(edge.id);
    if (!nodes.has(String(edge.left)) || !nodes.has(String(edge.right))) {
      reasons.push(`association_edge_endpoint_missing:${edge.id}`);
    }
    if (!Number.isFinite(edge.value)) reasons.push(`association_value_not_finite:${edge.id}`);
    if (!Number.isInteger(edge.sampleSize) || edge.sampleSize <= 0) {
      reasons.push(`association_sample_size_invalid:${edge.id}`);
    }
    if (edge.evidenceIds.length === 0) reasons.push(`association_evidence_required:${edge.id}`);
  }
  return { valid: reasons.length === 0, reasons: uniqueSorted(reasons) };
}

export function createIdentifiedCausalGraphEngine(
  dependencies: IdentifiedCausalGraphDependencies
) {
  return {
    estimate(input: IdentifiedCausalEstimateInput): IdentifiedCausalEstimateResult {
      const associationValidation = input.associationContext
        ? validateAssociationalGraph(input.associationContext)
        : { valid: true, reasons: [] };
      const baseAudit: CausalIdentificationAudit = {
        designKind: input.design?.kind ?? "missing",
        associationContextPresent: input.associationContext !== undefined,
        associationContextUsedForIdentification: false,
        associationContextValidation: input.associationContext
          ? associationValidation
          : null,
        causalDagValidated: false,
        explicitAssumptionsValidated: false,
        empiricalPositivityValidated: false,
        observationCount: input.observations.length,
        reasons: []
      };
      const reasons: string[] = [];
      if (!input.design) reasons.push("identification_design_required");
      if (!(input.targetRiskCoverage > 0 && input.targetRiskCoverage < 1)) {
        reasons.push("target_risk_coverage_must_be_between_zero_and_one");
      }
      if (reasons.length || !input.design) return rejected(baseAudit, reasons);

      const observationReasons = validateObservations(
        input.observations,
        input.design.treatment,
        input.design.outcome
      );
      reasons.push(...observationReasons);
      if (input.design.kind === "backdoor_adjustment") {
        const validation = validateBackdoorDesign(input.design);
        reasons.push(...validation.reasons);
        baseAudit.causalDagValidated = validation.dagValid;
        baseAudit.explicitAssumptionsValidated = validation.assumptionsValid;
      } else {
        const validation = validateRandomizedDesign(input.design);
        reasons.push(...validation.reasons);
        baseAudit.causalDagValidated = false;
        baseAudit.explicitAssumptionsValidated = validation.assumptionsValid;
      }
      if (reasons.length) return rejected(baseAudit, reasons);

      const adjustmentSet = input.design.kind === "backdoor_adjustment"
        ? input.design.adjustmentSet
        : [];
      const estimateResult = estimateByStratification(
        input.observations,
        input.design.treatment,
        input.design.outcome,
        adjustmentSet
      );
      if (estimateResult.status === "rejected") {
        return rejected(baseAudit, estimateResult.reasons);
      }
      baseAudit.empiricalPositivityValidated = true;

      const absoluteResiduals = leaveOneOutResiduals(
        input.observations,
        input.design.treatment,
        input.design.outcome,
        adjustmentSet
      );
      const riskResult = createConformalCausalRiskInterval({
        pointEstimate: estimateResult.estimate,
        absoluteResiduals,
        targetCoverage: input.targetRiskCoverage,
        // A binary effect contrast contains two potential-outcome endpoints, so
        // its residual envelope is the sum of two one-endpoint radii.
        contrastRadiusMultiplier: 2
      });
      if (riskResult.status === "rejected") {
        return rejected(baseAudit, riskResult.reasons);
      }

      const claimCore = {
        estimand: "average_treatment_effect",
        treatment: String(input.design.treatment),
        outcome: String(input.design.outcome),
        design: input.design,
        strata: estimateResult.strata,
        estimate: estimateResult.estimate,
        targetRiskCoverage: input.targetRiskCoverage,
        observations: [...input.observations]
          .sort((left, right) => left.id.localeCompare(right.id))
          .map(row => ({
            id: row.id,
            values: row.values,
            evidenceIds: [...row.evidenceIds].sort()
          }))
      };
      const claim: IdentifiedCausalClaim = {
        id: `identified_causal_${dependencies.hasher.digestHex(canonicalStringify(claimCore))}`,
        createdAt: dependencies.clock.now(),
        estimand: "average_treatment_effect",
        treatment: input.design.treatment,
        outcome: input.design.outcome,
        treatmentContrast: { control: 0, treated: 1 },
        estimate: estimateResult.estimate,
        identification: input.design.kind === "backdoor_adjustment"
          ? {
              kind: "backdoor_adjustment",
              assumptionSetId: input.design.dag.assumptionSetId,
              adjustmentSet: [...input.design.adjustmentSet],
              validatedBackdoorCriterion: true,
              empiricalPositivity: true
            }
          : {
              kind: "randomized_intervention",
              assignmentMechanismId: input.design.assignmentMechanismId,
              assignmentEvidenceIds: uniqueSorted(input.design.assignmentEvidenceIds),
              randomizedAssignmentAsserted: true
            },
        strata: estimateResult.strata,
        riskInterval: riskResult.interval,
        observationEvidenceIds: uniqueSorted(input.observations.flatMap(row => row.evidenceIds)),
        warnings: [
          "identification depends on the supplied assumptions",
          "the risk interval is not a parameter confidence interval"
        ]
      };
      const audit: CausalIdentificationAudit = {
        ...baseAudit,
        reasons: []
      };
      return {
        status: "identified",
        claim,
        audit,
        trace: toJsonValue({
          claimId: claim.id,
          identification: claim.identification,
          associationContextUsedForIdentification: false,
          strata: claim.strata,
          riskInterval: claim.riskInterval,
          observationEvidenceIds: claim.observationEvidenceIds
        })
      };
    }
  };
}

function validateObservations(
  observations: readonly CausalObservation[],
  treatment: NodeId,
  outcome: NodeId
): string[] {
  const reasons: string[] = [];
  if (observations.length < 4) reasons.push("at_least_four_observations_required");
  if (observations.length > 100_000) reasons.push("observation_limit_exceeded");
  const ids = new Set<string>();
  for (const observation of observations) {
    if (!observation.id) reasons.push("observation_id_required");
    if (ids.has(observation.id)) reasons.push(`duplicate_observation_id:${observation.id}`);
    ids.add(observation.id);
    if (observation.evidenceIds.length === 0) {
      reasons.push(`observation_evidence_required:${observation.id}`);
    }
    const treatmentValue = observation.values[String(treatment)];
    const outcomeValue = observation.values[String(outcome)];
    if (treatmentValue !== 0 && treatmentValue !== 1) {
      reasons.push(`binary_treatment_required:${observation.id}`);
    }
    if (!Number.isFinite(outcomeValue)) {
      reasons.push(`finite_outcome_required:${observation.id}`);
    }
    for (const [variable, value] of Object.entries(observation.values)) {
      if (!Number.isFinite(value)) reasons.push(`finite_observation_value_required:${observation.id}:${variable}`);
    }
  }
  return uniqueSorted(reasons);
}

function validateBackdoorDesign(design: BackdoorIdentificationDesign): {
  dagValid: boolean;
  assumptionsValid: boolean;
  reasons: string[];
} {
  const reasons = validateDag(design.dag);
  if (design.adjustmentSet.length > 8) reasons.push("adjustment_variable_limit_exceeded");
  const nodes = new Set(design.dag.nodes.map(String));
  if (!nodes.has(String(design.treatment))) reasons.push("treatment_missing_from_causal_dag");
  if (!nodes.has(String(design.outcome))) reasons.push("outcome_missing_from_causal_dag");
  if (design.treatment === design.outcome) reasons.push("treatment_and_outcome_must_differ");
  const adjustmentIds = design.adjustmentSet.map(String);
  if (new Set(adjustmentIds).size !== adjustmentIds.length) reasons.push("duplicate_adjustment_variable");
  for (const variable of design.adjustmentSet) {
    if (!nodes.has(String(variable))) reasons.push(`adjustment_variable_missing_from_causal_dag:${String(variable)}`);
    if (variable === design.treatment || variable === design.outcome) {
      reasons.push(`treatment_or_outcome_cannot_be_adjusted:${String(variable)}`);
    }
  }
  const descendants = descendantsOf(design.treatment, design.dag.edges);
  for (const variable of design.adjustmentSet) {
    if (descendants.has(String(variable))) {
      reasons.push(`adjustment_contains_treatment_descendant:${String(variable)}`);
    }
  }
  const assumptionsValid = allTrue([
    design.assumptions.consistency,
    design.assumptions.noInterference,
    design.assumptions.noUnmeasuredConfoundingGivenAdjustment,
    design.assumptions.temporalOrderEstablished,
    design.assumptions.positivityExpected
  ]);
  if (!assumptionsValid) reasons.push("all_backdoor_identification_assumptions_must_be_explicitly_true");
  const dagValid = !reasons.some(reason =>
    reason.startsWith("causal_dag_")
    || reason.includes("_causal_dag")
    || reason.startsWith("duplicate_causal_")
  );
  if (dagValid && !dSeparatedInBackdoorGraph(
    design.treatment,
    design.outcome,
    design.adjustmentSet,
    design.dag
  )) {
    reasons.push("adjustment_set_does_not_block_all_backdoor_paths");
  }
  return { dagValid, assumptionsValid, reasons: uniqueSorted(reasons) };
}

function validateRandomizedDesign(design: RandomizedInterventionDesign): {
  assumptionsValid: boolean;
  reasons: string[];
} {
  const reasons: string[] = [];
  if (design.treatment === design.outcome) reasons.push("treatment_and_outcome_must_differ");
  if (!design.assignmentMechanismId) reasons.push("assignment_mechanism_id_required");
  if (design.assignmentEvidenceIds.length === 0) reasons.push("randomization_evidence_required");
  const assumptionsValid = allTrue([
    design.assumptions.randomizedAssignment,
    design.assumptions.consistency,
    design.assumptions.noInterference,
    design.assumptions.outcomeObservedAfterAssignment
  ]);
  if (!assumptionsValid) reasons.push("all_randomized_identification_assumptions_must_be_explicitly_true");
  return { assumptionsValid, reasons: uniqueSorted(reasons) };
}

function validateDag(dag: CausalAssumptionDag): string[] {
  const reasons: string[] = [];
  if (dag.nodes.length > 2_048) reasons.push("causal_dag_node_limit_exceeded");
  if (dag.edges.length > 8_192) reasons.push("causal_dag_edge_limit_exceeded");
  if (!dag.assumptionSetId) reasons.push("causal_dag_assumption_set_id_required");
  if (dag.evidenceIds.length === 0) reasons.push("causal_dag_evidence_required");
  const nodes = new Set<string>();
  for (const node of dag.nodes) {
    const id = String(node);
    if (!id) reasons.push("causal_dag_node_id_required");
    if (nodes.has(id)) reasons.push(`duplicate_causal_dag_node:${id}`);
    nodes.add(id);
  }
  const edgeIds = new Set<string>();
  for (const edge of dag.edges) {
    if (!edge.id) reasons.push("causal_dag_edge_id_required");
    if (edgeIds.has(edge.id)) reasons.push(`duplicate_causal_dag_edge:${edge.id}`);
    edgeIds.add(edge.id);
    if (!nodes.has(String(edge.cause)) || !nodes.has(String(edge.effect))) {
      reasons.push(`causal_dag_edge_endpoint_missing:${edge.id}`);
    }
    if (edge.cause === edge.effect) reasons.push(`causal_dag_self_cycle:${edge.id}`);
    if (edge.evidenceIds.length === 0) reasons.push(`causal_dag_edge_evidence_required:${edge.id}`);
  }
  if (containsDirectedCycle(dag.nodes, dag.edges)) reasons.push("causal_dag_contains_cycle");
  return uniqueSorted(reasons);
}

function containsDirectedCycle(nodes: readonly NodeId[], edges: readonly CausalAssumptionEdge[]): boolean {
  const state = new Map<string, 0 | 1 | 2>();
  const adjacency = adjacencyMap(edges);
  const visit = (node: string): boolean => {
    const current = state.get(node) ?? 0;
    if (current === 1) return true;
    if (current === 2) return false;
    state.set(node, 1);
    for (const next of adjacency.get(node) ?? []) if (visit(next)) return true;
    state.set(node, 2);
    return false;
  };
  return nodes.some(node => visit(String(node)));
}

function descendantsOf(
  treatment: NodeId,
  edges: readonly CausalAssumptionEdge[]
): Set<string> {
  const adjacency = adjacencyMap(edges);
  const descendants = new Set<string>();
  const pending = [...(adjacency.get(String(treatment)) ?? [])];
  while (pending.length) {
    const node = pending.pop()!;
    if (descendants.has(node)) continue;
    descendants.add(node);
    pending.push(...(adjacency.get(node) ?? []));
  }
  return descendants;
}

function dSeparatedInBackdoorGraph(
  treatment: NodeId,
  outcome: NodeId,
  adjustmentSet: readonly NodeId[],
  dag: CausalAssumptionDag
): boolean {
  const treatmentId = String(treatment);
  const outcomeId = String(outcome);
  const conditioned = new Set(adjustmentSet.map(String));
  const edges = dag.edges.filter(edge => String(edge.cause) !== treatmentId);
  const relevant = ancestorClosure(
    new Set([treatmentId, outcomeId, ...conditioned]),
    edges
  );
  const undirected = new Map<string, Set<string>>();
  const connect = (left: string, right: string) => {
    if (!relevant.has(left) || !relevant.has(right)) return;
    if (!undirected.has(left)) undirected.set(left, new Set());
    if (!undirected.has(right)) undirected.set(right, new Set());
    undirected.get(left)!.add(right);
    undirected.get(right)!.add(left);
  };
  for (const edge of edges) connect(String(edge.cause), String(edge.effect));
  const parentsByChild = new Map<string, string[]>();
  for (const edge of edges) {
    const child = String(edge.effect);
    const parents = parentsByChild.get(child) ?? [];
    parents.push(String(edge.cause));
    parentsByChild.set(child, parents);
  }
  for (const parents of parentsByChild.values()) {
    for (let left = 0; left < parents.length; left++) {
      for (let right = left + 1; right < parents.length; right++) {
        connect(parents[left]!, parents[right]!);
      }
    }
  }
  const seen = new Set<string>(conditioned);
  const pending = [treatmentId];
  while (pending.length) {
    const node = pending.shift()!;
    if (node === outcomeId) return false;
    if (seen.has(node)) continue;
    seen.add(node);
    for (const next of undirected.get(node) ?? []) if (!seen.has(next)) pending.push(next);
  }
  return true;
}

function ancestorClosure(
  initial: Set<string>,
  edges: readonly CausalAssumptionEdge[]
): Set<string> {
  const parents = new Map<string, string[]>();
  for (const edge of edges) {
    const target = String(edge.effect);
    const current = parents.get(target) ?? [];
    current.push(String(edge.cause));
    parents.set(target, current);
  }
  const closure = new Set(initial);
  const pending = [...initial];
  while (pending.length) {
    const node = pending.pop()!;
    for (const parent of parents.get(node) ?? []) {
      if (closure.has(parent)) continue;
      closure.add(parent);
      pending.push(parent);
    }
  }
  return closure;
}

function estimateByStratification(
  observations: readonly CausalObservation[],
  treatment: NodeId,
  outcome: NodeId,
  adjustmentSet: readonly NodeId[]
): { status: "estimated"; estimate: number; strata: CausalStratumEstimate[] }
  | { status: "rejected"; reasons: string[] } {
  const grouped = new Map<string, CausalObservation[]>();
  for (const observation of observations) {
    const missing = adjustmentSet.find(variable =>
      !Number.isFinite(observation.values[String(variable)])
    );
    if (missing) {
      return {
        status: "rejected",
        reasons: [`finite_adjustment_value_required:${observation.id}:${String(missing)}`]
      };
    }
    const key = canonicalStringify(adjustmentSet.map(variable =>
      observation.values[String(variable)]!
    ));
    const rows = grouped.get(key) ?? [];
    rows.push(observation);
    grouped.set(key, rows);
  }
  if (grouped.size > 256) {
    return { status: "rejected", reasons: ["adjustment_strata_limit_exceeded"] };
  }
  const strata: CausalStratumEstimate[] = [];
  const positivityReasons: string[] = [];
  for (const [key, rows] of [...grouped.entries()].sort(([left], [right]) => left.localeCompare(right))) {
    const treated = rows.filter(row => row.values[String(treatment)] === 1);
    const control = rows.filter(row => row.values[String(treatment)] === 0);
    if (treated.length < 2 || control.length < 2) {
      positivityReasons.push(`empirical_positivity_requires_two_per_arm_in_stratum:${key}`);
      continue;
    }
    const adjustmentValues = JSON.parse(key) as number[];
    const treatedMean = average(treated.map(row => row.values[String(outcome)]!));
    const controlMean = average(control.map(row => row.values[String(outcome)]!));
    strata.push({
      adjustmentValues: Object.fromEntries(
        adjustmentSet.map((variable, index) => [String(variable), adjustmentValues[index]!])
      ),
      sampleCount: rows.length,
      treatedCount: treated.length,
      controlCount: control.length,
      treatedMean,
      controlMean,
      effect: treatedMean - controlMean,
      populationWeight: rows.length / observations.length
    });
  }
  if (positivityReasons.length) {
    return { status: "rejected", reasons: uniqueSorted(positivityReasons) };
  }
  const estimate = strata.reduce((sum, stratum) =>
    sum + stratum.effect * stratum.populationWeight, 0);
  return { status: "estimated", estimate, strata };
}

function leaveOneOutResiduals(
  observations: readonly CausalObservation[],
  treatment: NodeId,
  outcome: NodeId,
  adjustmentSet: readonly NodeId[]
): number[] {
  const groupKey = (observation: CausalObservation) => canonicalStringify([
    observation.values[String(treatment)],
    ...adjustmentSet.map(variable => observation.values[String(variable)])
  ]);
  const groups = new Map<string, CausalObservation[]>();
  for (const observation of observations) {
    const key = groupKey(observation);
    const rows = groups.get(key) ?? [];
    rows.push(observation);
    groups.set(key, rows);
  }
  return observations.map(observation => {
    const peers = groups.get(groupKey(observation))!
      .filter(peer => peer.id !== observation.id);
    const prediction = average(peers.map(peer => peer.values[String(outcome)]!));
    return Math.abs(observation.values[String(outcome)]! - prediction);
  });
}

function adjacencyMap(edges: readonly CausalAssumptionEdge[]): Map<string, string[]> {
  const adjacency = new Map<string, string[]>();
  for (const edge of edges) {
    const source = String(edge.cause);
    const targets = adjacency.get(source) ?? [];
    targets.push(String(edge.effect));
    adjacency.set(source, targets);
  }
  return adjacency;
}

function average(values: readonly number[]): number {
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function allTrue(values: readonly unknown[]): boolean {
  return values.every(value => value === true);
}

function rejected(
  baseAudit: CausalIdentificationAudit,
  reasons: readonly string[]
): IdentifiedCausalEstimateResult {
  const normalizedReasons = uniqueSorted(reasons);
  const audit = { ...baseAudit, reasons: normalizedReasons };
  return {
    status: "rejected",
    claim: null,
    audit,
    trace: toJsonValue({
      status: "rejected",
      designKind: audit.designKind,
      associationContextUsedForIdentification: false,
      reasons: normalizedReasons
    })
  };
}

function uniqueSorted(values: readonly string[]): string[] {
  return [...new Set(values)].sort();
}
