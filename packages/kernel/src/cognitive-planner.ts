import type { CounterfactualWorld } from "./counterfactual-cognition.js";
import { verifyPatchTransactionPlan, type PatchTransactionPlan } from "./patch-transaction.js";
import type { InventionConstruct } from "./prediction.js";
import type { TranslationPlan } from "./translation.js";
import { canonicalStringify, clamp01, createHasher, mean, symbolizeData, toJsonValue } from "./primitives.js";
import { projectGraphEdgeRelationPotential } from "./relation-potential.js";
import {
  COGNITIVE_OPERATOR_IDS,
  type ActivatedOperator,
  type TurnRequirement,
  type TurnRequirementDimension,
  type TurnRequirementField
} from "./turn-requirements.js";
import type {
  ConstructGraph,
  EvidenceId,
  EvidenceSpan,
  FieldState,
  FileArtifact,
  GraphEdge,
  GraphNode,
  GraphSlice,
  JsonValue,
  ProgramGraph
} from "./types.js";

export type ClaimBasis =
  | "direct_evidence"
  | "source_synthesis"
  | "reasoned_inference"
  | "causal_inference"
  | "temporal_inference"
  | "counterfactual"
  | "learned_prior"
  | "invented"
  | "conjectured"
  | "translated"
  | "action_result"
  | "unsupported";

export interface PlannedClaim {
  id: string;
  text: string;
  basis: ClaimBasis;
  evidenceIds: EvidenceId[];
  priorIds: string[];
  graphNodeIds: string[];
  graphEdgeIds: string[];
  externallyFactual: boolean;
  hypothetical: boolean;
  actionReceiptId?: string;
  trace: JsonValue;
}

export interface PlannedRelation {
  id: string;
  sourceClaimId: string;
  targetClaimId: string;
  relationId: string;
  basis: ClaimBasis;
  graphEdgeIds: string[];
  evidenceIds: EvidenceId[];
  trace: JsonValue;
}

export interface PlannedStep {
  id: string;
  order: number;
  text: string;
  basis: ClaimBasis;
  dependsOnIds: string[];
  evidenceIds: EvidenceId[];
  trace: JsonValue;
}

export interface PlannedArtifact {
  id: string;
  kindId: string;
  title: string;
  constructId?: string;
  completion: number;
  validationRequired: boolean;
  trace: JsonValue;
}

export interface ReasoningQuality {
  premiseValidity: number;
  relationContinuity: number;
  requirementCoverage: number;
  explanatoryPower: number;
  contradictionHandling: number;
  temporalConsistency: number;
  simplicity: number;
  usefulness: number;
  unsupportedLeapRate: number;
  internalContradiction: number;
  score: number;
}

export interface InventionQuality {
  requirementSatisfaction: number;
  relationCoherence: number;
  noveltyMemory: number;
  noveltySibling: number;
  novelty: number;
  fit: number;
  usefulness: number;
  languageRealizability: number;
  styleFit: number;
  risk: number;
  repetition: number;
  unsupportedExternallyFactualRate: number;
  score: number;
}

export interface ProposalQuality {
  reasoning: ReasoningQuality;
  invention?: InventionQuality;
  baseQuality: number;
  diversity: number;
  mmr: number;
  hardFailures: string[];
}

export interface CognitiveProposal {
  id: string;
  operatorActivations: ActivatedOperator[];
  claims: PlannedClaim[];
  relations: PlannedRelation[];
  steps: PlannedStep[];
  artifacts: PlannedArtifact[];
  evidenceIds: EvidenceId[];
  priorIds: string[];
  graphNodeIds: string[];
  semanticFrameIds: string[];
  constructIds: string[];
  satisfiedRequirementIds: string[];
  missedRequirementIds: string[];
  quality: ProposalQuality;
  trace: JsonValue;
}

export interface CognitivePlannerInput {
  requestText: string;
  requirements: TurnRequirementField;
  operatorActivations: readonly ActivatedOperator[];
  evidence: readonly EvidenceSpan[];
  graph: GraphSlice;
  field: FieldState;
  construct: ConstructGraph;
  inventions?: readonly InventionConstruct[];
  counterfactualWorlds?: readonly CounterfactualWorld[];
  translationPlans?: readonly TranslationPlan[];
  programGraphs?: readonly ProgramGraph[];
  workspacePlans?: readonly PatchTransactionPlan[];
  actionPlans?: readonly CognitiveActionPlan[];
  proposalMemory?: readonly CognitiveProposal[];
  maxProposals?: number;
}

/** A typed action meaning supplied by the action lane before Mouth realization. */
export interface CognitiveActionPlan {
  id: string;
  capabilityId: string;
  phase: "read" | "prepare" | "commit";
  status: "planned" | "invoked" | "succeeded" | "failed" | "rolled_back";
  previewSurface?: string;
  resultSurface?: string;
  actionReceiptId?: string;
  artifactKindId?: string;
  trace?: JsonValue;
}

export const COGNITIVE_PROPOSAL_BOOTSTRAP = Object.freeze({
  schema: "scce.cognitive_proposal.bootstrap.v1" as const,
  version: "cognitive-proposal.bootstrap.2026-07-12.v1",
  calibrationScopeId: "candidate.cognitive_proposal_preference",
  featureSchemaId: "scce.cognitive_proposal.preference_features.v1",
  mmr: Object.freeze({ quality: 0.72, diversity: 0.28 }),
  reasoning: Object.freeze({
    premiseValidity: 0.20,
    relationContinuity: 0.17,
    requirementCoverage: 0.15,
    explanatoryPower: 0.13,
    contradictionHandling: 0.10,
    temporalConsistency: 0.09,
    simplicity: 0.08,
    usefulness: 0.08,
    unsupportedLeapRate: -0.45,
    internalContradiction: -0.35
  }),
  invention: Object.freeze({
    requirementSatisfaction: 0.24,
    relationCoherence: 0.18,
    novelty: 0.18,
    fit: 0.16,
    usefulness: 0.12,
    languageRealizability: 0.07,
    styleFit: 0.05,
    risk: -0.30,
    repetition: -0.22,
    unsupportedExternallyFactualRate: -0.70
  })
});

type ProposalDraft = Omit<CognitiveProposal, "id" | "quality" | "trace"> & {
  kind: "reasoning" | "invention" | "counterfactual" | "clarification";
  family?: string;
  sourceInvention?: InventionConstruct;
};

type ScoredDraft = ProposalDraft & {
  id: string;
  reasoning: ReasoningQuality;
  invention?: InventionQuality;
  baseQuality: number;
  hardFailures: string[];
};

/**
 * Constructs bounded answer meanings before surface realization. Routing is
 * driven only by learned requirement/operator activation and typed graph
 * structure; request tokens never choose an operator or proposal kind.
 */
export function planCognitiveProposals(input: CognitivePlannerInput): CognitiveProposal[] {
  assertPlannerInput(input);
  const maxProposals = boundedInteger(input.maxProposals ?? 8, 1, 16, "maxProposals");
  const evidenceById = new Map(input.evidence.map(span => [String(span.id), span]));
  const nodeById = new Map(input.graph.nodes.map(node => [String(node.id), node]));
  const activeOperators = input.operatorActivations
    .filter(operator => operator.active && operator.activation > 0)
    .sort((left, right) => right.activation - left.activation || left.id.localeCompare(right.id));
  const drafts = uniqueDrafts([
    ...translationDrafts(input, activeOperators),
    ...workspacePlanDrafts(input, activeOperators),
    ...actionPlanDrafts(input, activeOperators),
    ...inventionDrafts(input, activeOperators, evidenceById),
    ...counterfactualWorldDrafts(input, activeOperators, nodeById),
    ...topologyFamilyDrafts(input, activeOperators, evidenceById, nodeById),
    ...orderedCompositionDrafts(input, activeOperators),
    ...programDesignDrafts(input, activeOperators),
    ...hypothesisDrafts(input, activeOperators, nodeById),
    ...relationDrafts(input, activeOperators, evidenceById, nodeById),
    ...sourceSynthesisDrafts(input, activeOperators, evidenceById, nodeById),
    ...constructPriorDrafts(input, activeOperators),
    ...clarificationDrafts(input, activeOperators)
  ]).slice(0, Math.max(maxProposals * 3, 3));

  const scored = drafts.map(draft => scoreDraft(input, draft));
  const selected = selectWithMmr(scored, input.proposalMemory ?? [], maxProposals);
  return selected.map(({ draft, diversity, mmr }, rank) => finalizeProposal(draft, diversity, mmr, rank));
}

function translationDrafts(input: CognitivePlannerInput, operators: ActivatedOperator[]): ProposalDraft[] {
  if (!operatorActive(operators, COGNITIVE_OPERATOR_IDS.translation)) return [];
  return (input.translationPlans ?? []).slice(0, 4).flatMap((plan, index): ProposalDraft[] => {
    const text = cleanMeaningSurface(plan.emission.text);
    if (!text || plan.construct.preservationValidation.blockingMissing.length > 0) return [];
    const priorIds = uniqueStrings([
      plan.id,
      ...plan.sourceFrames.map(frame => frame.id),
      ...plan.targetFrames.map(frame => frame.id)
    ]);
    const evidenceIds = asEvidenceIds(uniqueStrings([
      ...plan.sourceFrames.flatMap(frame => frame.evidenceIds),
      ...plan.targetFrames.flatMap(frame => frame.evidenceIds)
    ]));
    const claim = plannedClaim({
      seed: ["translation", plan.id, index],
      text,
      basis: "translated",
      evidenceIds,
      priorIds,
      graphNodeIds: [],
      graphEdgeIds: [],
      externallyFactual: false,
      hypothetical: false,
      trace: {
        source: "translation.plan",
        planId: plan.id,
        force: plan.force,
        sourceLanguage: plan.sourceLanguage,
        targetLanguage: plan.targetLanguage,
        preservation: plan.emission.preservation,
        preservationValidation: plan.construct.preservationValidation
      }
    });
    const steps = plan.emission.units.slice(0, 16).map((unit, unitIndex): PlannedStep => ({
      id: stableId("planned_step", [plan.id, unit.sourceFrameId, unitIndex]),
      order: unitIndex,
      text: cleanMeaningSurface(unit.text),
      basis: "translated",
      dependsOnIds: unitIndex > 0 ? [stableId("planned_step", [plan.id, plan.emission.units[unitIndex - 1]?.sourceFrameId, unitIndex - 1])] : [],
      evidenceIds,
      trace: toJsonValue({ sourceFrameId: unit.sourceFrameId, targetFrameId: unit.targetFrameId ?? null, force: unit.force })
    }));
    const matched = matchRequirements(input.requirements, { claims: [claim], artifacts: [], steps, evidenceIds });
    return [{
      kind: "reasoning",
      operatorActivations: relevantOperators(operators, ["semanticPreservation", "surfaceTransformation"]),
      claims: [claim],
      relations: [],
      steps,
      artifacts: [],
      evidenceIds,
      priorIds,
      graphNodeIds: [],
      semanticFrameIds: uniqueStrings([...input.requirements.activatedFrameIds, ...plan.sourceFrames.map(frame => frame.id), ...plan.targetFrames.map(frame => frame.id)]),
      constructIds: [plan.id],
      satisfiedRequirementIds: matched.satisfied,
      missedRequirementIds: matched.missed
    }];
  });
}

function workspacePlanDrafts(input: CognitivePlannerInput, operators: ActivatedOperator[]): ProposalDraft[] {
  if (!operatorRequirementGate(
    input.requirements,
    operators,
    COGNITIVE_OPERATOR_IDS.workspaceRepair,
    [["executableArtifactDemand", 0.55]]
  )) return [];
  return (input.workspacePlans ?? []).slice(0, 4).flatMap((plan, planIndex): ProposalDraft[] => {
    try {
      verifyPatchTransactionPlan(plan);
    } catch {
      return [];
    }
    const claims = plan.operations.slice(0, 16).map((operation, operationIndex) => plannedClaim({
      seed: ["workspace_plan", plan.planHash, operationIndex],
      text: cleanMeaningSurface(operation.path),
      basis: "learned_prior",
      evidenceIds: [],
      priorIds: [plan.planHash],
      graphNodeIds: [],
      graphEdgeIds: [],
      externallyFactual: false,
      hypothetical: false,
      trace: {
        source: "workspace.patch_transaction_plan",
        planHash: plan.planHash,
        operationIndex,
        operationKind: operation.kind,
        executionState: "not_executed"
      }
    }));
    if (claims.length === 0) return [];
    const steps = plan.operations.slice(0, 16).map((operation, operationIndex): PlannedStep => ({
      id: stableId("planned_step", [plan.planHash, operationIndex]),
      order: operationIndex,
      text: cleanMeaningSurface(operation.path),
      basis: "learned_prior",
      dependsOnIds: operationIndex === 0 ? [] : [stableId("planned_step", [plan.planHash, operationIndex - 1])],
      evidenceIds: [],
      trace: toJsonValue({ source: "workspace.patch_transaction_plan", planHash: plan.planHash, operationKind: operation.kind })
    }));
    const artifacts: PlannedArtifact[] = [{
      id: stableId("artifact", ["workspace_patch", plan.planHash]),
      kindId: "artifact.workspace.patch_transaction.v1",
      title: plan.planHash,
      constructId: plan.planHash,
      completion: 1,
      validationRequired: true,
      trace: toJsonValue({ source: "workspace.patch_transaction_plan", planHash: plan.planHash, executionState: "not_executed" })
    }];
    const matched = matchRequirements(input.requirements, { claims, artifacts, steps, evidenceIds: [] });
    return [{
      kind: "reasoning",
      family: "workspace_artifact_preview",
      operatorActivations: operatorsForIds(operators, [COGNITIVE_OPERATOR_IDS.workspaceRepair]),
      claims,
      relations: [],
      steps,
      artifacts,
      evidenceIds: [],
      priorIds: [plan.planHash],
      graphNodeIds: [],
      semanticFrameIds: uniqueStrings(input.requirements.activatedFrameIds),
      constructIds: [plan.planHash],
      satisfiedRequirementIds: matched.satisfied,
      missedRequirementIds: matched.missed
    }];
  });
}

function actionPlanDrafts(input: CognitivePlannerInput, operators: ActivatedOperator[]): ProposalDraft[] {
  if (!operatorRequirementGate(
    input.requirements,
    operators,
    COGNITIVE_OPERATOR_IDS.actionPlanning,
    [["actionCommitment", 0.55]]
  )) return [];
  return (input.actionPlans ?? []).slice(0, 8).flatMap((plan, planIndex): ProposalDraft[] => {
    const receiptId = cleanIdentifier(plan.actionReceiptId);
    const completed = plan.status === "succeeded" || plan.status === "failed";
    const resultSurface = completed && receiptId ? cleanMeaningSurface(plan.resultSurface ?? "") : "";
    const previewSurface = cleanMeaningSurface(plan.previewSurface ?? "") || cleanMeaningSurface(plan.capabilityId);
    const text = resultSurface || previewSurface;
    if (!text) return [];
    const basis: ClaimBasis = resultSurface ? "action_result" : "learned_prior";
    const claim = plannedClaim({
      seed: ["action_plan", plan.id, planIndex, basis],
      text,
      basis,
      evidenceIds: [],
      priorIds: [plan.id],
      graphNodeIds: [],
      graphEdgeIds: [],
      externallyFactual: basis === "action_result",
      hypothetical: basis !== "action_result",
      actionReceiptId: basis === "action_result" ? receiptId : undefined,
      trace: {
        source: basis === "action_result" ? "action.plan.receipted_result" : "action.plan.preview",
        planId: plan.id,
        capabilityId: plan.capabilityId,
        phase: plan.phase,
        status: plan.status,
        actionReceiptId: basis === "action_result" ? receiptId : null,
        planTrace: plan.trace ?? null
      }
    });
    const artifacts: PlannedArtifact[] = [{
      id: stableId("artifact", ["action_preview", plan.id]),
      kindId: cleanIdentifier(plan.artifactKindId) || "artifact.action.preview.v1",
      title: previewSurface || text,
      constructId: plan.id,
      completion: basis === "action_result" ? 1 : plan.status === "invoked" ? 0.5 : 0.25,
      validationRequired: basis !== "action_result",
      trace: toJsonValue({ source: "action.plan", planId: plan.id, status: plan.status, receiptRequiredForResult: true })
    }];
    const matched = matchRequirements(input.requirements, { claims: [claim], artifacts, steps: [], evidenceIds: [] });
    return [{
      kind: "reasoning",
      family: basis === "action_result" ? "receipted_action_result" : "action_preview",
      operatorActivations: operatorsForIds(operators, [COGNITIVE_OPERATOR_IDS.actionPlanning]),
      claims: [claim],
      relations: [],
      steps: [],
      artifacts,
      evidenceIds: [],
      priorIds: [plan.id],
      graphNodeIds: [],
      semanticFrameIds: uniqueStrings(input.requirements.activatedFrameIds),
      constructIds: [plan.id],
      satisfiedRequirementIds: matched.satisfied,
      missedRequirementIds: matched.missed
    }];
  });
}

function counterfactualWorldDrafts(
  input: CognitivePlannerInput,
  operators: ActivatedOperator[],
  nodeById: Map<string, GraphNode>
): ProposalDraft[] {
  if (!operatorActive(operators, COGNITIVE_OPERATOR_IDS.counterfactualConstruction)) return [];
  return (input.counterfactualWorlds ?? []).slice(0, 4).flatMap((world): ProposalDraft[] => {
    const effects = [...world.effect]
      .filter(effect => Number.isFinite(effect.effect))
      .sort((left, right) => Math.abs(right.effect) - Math.abs(left.effect) || String(left.nodeId).localeCompare(String(right.nodeId)))
      .slice(0, 4);
    const claims = effects.flatMap((effect, index): PlannedClaim[] => {
      const text = cleanMeaningSurface(nodeSurface(nodeById.get(String(effect.nodeId))));
      if (!text) return [];
      const paths = world.explanation.filter(path => path.nodes.some(nodeId => String(nodeId) === String(effect.nodeId)));
      return [plannedClaim({
        seed: [world.id, effect.nodeId, index],
        text,
        basis: "counterfactual",
        evidenceIds: [],
        priorIds: [world.id],
        graphNodeIds: uniqueStrings(paths.flatMap(path => path.nodes.map(String))),
        graphEdgeIds: [],
        externallyFactual: false,
        hypothetical: true,
        trace: {
          source: "counterfactual-cognition.world",
          worldId: world.id,
          effect: effect.effect,
          lower: effect.lower,
          upper: effect.upper,
          pathSupport: effect.pathSupport
        }
      })];
    });
    if (claims.length === 0) return [];
    const relations = world.explanation.slice(0, 8).flatMap((path, index): PlannedRelation[] => {
      const target = claims.find(claim => path.nodes.some(nodeId => claim.graphNodeIds.includes(String(nodeId)))) ?? claims[0];
      if (!target) return [];
      return [{
        id: stableId("planned_relation", [world.id, path.id, index]),
        sourceClaimId: target.id,
        targetClaimId: target.id,
        relationId: path.mechanisms.join("+") || path.id,
        basis: "counterfactual",
        graphEdgeIds: [],
        evidenceIds: [],
        trace: toJsonValue({ source: "counterfactual-cognition.path", worldId: world.id, pathId: path.id, support: path.support })
      }];
    });
    const matched = matchRequirements(input.requirements, { claims, artifacts: [], steps: [], evidenceIds: [] });
    return [{
      kind: "counterfactual",
      operatorActivations: relevantOperators(operators, ["counterfactualDemand", "inferentialDepth"]),
      claims,
      relations,
      steps: [],
      artifacts: [],
      evidenceIds: [],
      priorIds: [world.id],
      graphNodeIds: uniqueStrings(claims.flatMap(claim => claim.graphNodeIds)),
      semanticFrameIds: uniqueStrings(input.requirements.activatedFrameIds),
      constructIds: [],
      satisfiedRequirementIds: matched.satisfied,
      missedRequirementIds: matched.missed
    }];
  });
}

function topologyFamilyDrafts(
  input: CognitivePlannerInput,
  operators: ActivatedOperator[],
  evidenceById: Map<string, EvidenceSpan>,
  nodeById: Map<string, GraphNode>
): ProposalDraft[] {
  if (!operatorRequirementGate(
    input.requirements,
    operators,
    COGNITIVE_OPERATOR_IDS.analogy,
    [["inferentialDepth", 0.55], ["noveltyDemand", 0.45]]
  )) return [];
  const rankedEdges = input.graph.edges
    .filter(edge => nodeById.has(String(edge.source)) && nodeById.has(String(edge.target)))
    .sort((left, right) => edgeUtility(right) - edgeUtility(left) || String(left.id).localeCompare(String(right.id)))
    .slice(0, 16);
  const drafts: ProposalDraft[] = [];

  const analogyPair = firstEdgePair(rankedEdges, (left, right) =>
    String(left.relationId) === String(right.relationId)
    && String(left.source) !== String(right.source)
    && String(left.target) !== String(right.target)
  );
  if (analogyPair) {
    const draft = topologyPairDraft({
      input,
      operators,
      evidenceById,
      nodeById,
      edges: analogyPair,
      nodeIds: [String(analogyPair[0].target), String(analogyPair[1].target)],
      family: "analogy",
      relationId: "relation.cognitive.analogy.parallel_topology.v1"
    });
    if (draft) drafts.push(draft);
  }

  const comparisonPair = firstEdgePair(rankedEdges, (left, right) =>
    String(left.source) === String(right.source) && String(left.target) !== String(right.target)
    || String(left.target) === String(right.target) && String(left.source) !== String(right.source)
  );
  if (comparisonPair) {
    const sharedSource = String(comparisonPair[0].source) === String(comparisonPair[1].source);
    const draft = topologyPairDraft({
      input,
      operators,
      evidenceById,
      nodeById,
      edges: comparisonPair,
      nodeIds: sharedSource
        ? [String(comparisonPair[0].target), String(comparisonPair[1].target)]
        : [String(comparisonPair[0].source), String(comparisonPair[1].source)],
      family: "comparison",
      relationId: "relation.cognitive.comparison.shared_anchor.v1"
    });
    if (draft) drafts.push(draft);
  }

  const tradeoffPairs = edgePairs(rankedEdges)
    .filter(([left, right]) => String(left.source) === String(right.source) && String(left.target) !== String(right.target))
    .map((edges) => ({ edges, strength: relationPotentialTension(edges[0], edges[1], input.graph) }))
    .filter(item => item.strength >= 0.08)
    .sort((left, right) => right.strength - left.strength || edgePairKey(left.edges).localeCompare(edgePairKey(right.edges)));
  const tradeoffPair = tradeoffPairs[0]?.edges;
  if (tradeoffPair) {
    const draft = topologyPairDraft({
      input,
      operators,
      evidenceById,
      nodeById,
      edges: tradeoffPair,
      nodeIds: [String(tradeoffPair[0].target), String(tradeoffPair[1].target)],
      family: "tradeoff",
      relationId: "relation.cognitive.tradeoff.relation_potential.v1",
      extraTrace: { tension: tradeoffPairs[0]?.strength ?? 0 }
    });
    if (draft) drafts.push(draft);
  }
  return drafts;
}

function topologyPairDraft(input: {
  input: CognitivePlannerInput;
  operators: ActivatedOperator[];
  evidenceById: Map<string, EvidenceSpan>;
  nodeById: Map<string, GraphNode>;
  edges: readonly [GraphEdge, GraphEdge];
  nodeIds: readonly [string, string];
  family: "analogy" | "comparison" | "tradeoff";
  relationId: string;
  extraTrace?: JsonValue;
}): ProposalDraft | undefined {
  const claims = input.nodeIds.flatMap((nodeId, index): PlannedClaim[] => {
    const text = cleanMeaningSurface(nodeSurface(input.nodeById.get(nodeId)));
    if (!text) return [];
    const edge = input.edges[index];
    if (!edge) return [];
    return [plannedClaim({
      seed: [input.family, edge.id, nodeId],
      text,
      basis: "reasoned_inference",
      evidenceIds: [],
      priorIds: [],
      graphNodeIds: [String(edge.source), String(edge.target)],
      graphEdgeIds: [String(edge.id)],
      externallyFactual: false,
      hypothetical: false,
      trace: {
        source: "graph.topology_relation_potential",
        family: input.family,
        edgeId: edge.id,
        projection: projectGraphEdgeRelationPotential(edge, { edges: input.input.graph.edges })
      }
    })];
  });
  if (claims.length !== 2) return undefined;
  const evidenceIds = uniqueEvidenceIds(input.edges.flatMap(edge => edge.evidenceIds).filter(id => input.evidenceById.has(String(id))));
  const relation: PlannedRelation = {
    id: stableId("planned_relation", [input.family, ...input.edges.map(edge => String(edge.id))]),
    sourceClaimId: claims[0]!.id,
    targetClaimId: claims[1]!.id,
    relationId: input.relationId,
    basis: "reasoned_inference",
    graphEdgeIds: input.edges.map(edge => String(edge.id)),
    evidenceIds,
    trace: toJsonValue({
      source: "graph.topology_relation_potential",
      family: input.family,
      projections: input.edges.map(edge => projectGraphEdgeRelationPotential(edge, { edges: input.input.graph.edges })),
      extra: input.extraTrace ?? null
    })
  };
  const matched = matchRequirements(input.input.requirements, { claims, artifacts: [], steps: [], evidenceIds });
  return {
    kind: "reasoning",
    family: input.family,
    operatorActivations: operatorsForIds(input.operators, [COGNITIVE_OPERATOR_IDS.analogy]),
    claims,
    relations: [relation],
    steps: [],
    artifacts: [],
    evidenceIds,
    priorIds: [],
    graphNodeIds: uniqueStrings(claims.flatMap(claim => claim.graphNodeIds)),
    semanticFrameIds: uniqueStrings(input.input.requirements.activatedFrameIds),
    constructIds: [],
    satisfiedRequirementIds: matched.satisfied,
    missedRequirementIds: matched.missed
  };
}

function orderedCompositionDrafts(input: CognitivePlannerInput, operators: ActivatedOperator[]): ProposalDraft[] {
  if (input.requirements.inferentialDepth < 0.55) return [];
  const compositionOperators = operators.filter(operator =>
    operator.active
    && operator.activation > 0
    && (operator.operatorId === COGNITIVE_OPERATOR_IDS.relationComposition || operator.operatorId === COGNITIVE_OPERATOR_IDS.programPlanning)
    && operator.contributingRequirementDimensions.includes("inferentialDepth")
  );
  if (compositionOperators.length === 0) return [];
  return meaningStructures(input).slice(0, 6).flatMap((structure): ProposalDraft[] => {
    const sequence = boundedOrderedSequence(structure.nodes, structure.edges, 8);
    if (sequence.length < 2) return [];
    const mathematical = sequence.some(node => hasMathematicalStructure(node));
    const family = mathematical ? "mathematical_derivation" : "procedure_composition";
    const conclusionNode = sequence[sequence.length - 1]!;
    const conclusionText = cleanMeaningSurface(conclusionNode.label);
    if (!conclusionText) return [];
    const priorIds = uniqueStrings([structure.id, ...sequence.map(node => node.id)]);
    const claim = plannedClaim({
      seed: [family, structure.id, ...sequence.map(node => node.id)],
      text: conclusionText,
      basis: "reasoned_inference",
      evidenceIds: [],
      priorIds,
      graphNodeIds: [],
      graphEdgeIds: [],
      externallyFactual: false,
      hypothetical: false,
      trace: {
        source: "construct.ordered_structure",
        family,
        structureId: structure.id,
        orderedNodeIds: sequence.map(node => node.id),
        mathematicalStructure: mathematical
      }
    });
    const steps = sequence.map((node, index): PlannedStep => ({
      id: stableId("planned_step", [family, structure.id, node.id, index]),
      order: index,
      text: cleanMeaningSurface(node.label),
      basis: "learned_prior",
      dependsOnIds: index === 0 ? [] : [stableId("planned_step", [family, structure.id, sequence[index - 1]!.id, index - 1])],
      evidenceIds: [],
      trace: toJsonValue({ source: "construct.ordered_node", structureId: structure.id, nodeId: node.id, nodeKind: node.kind, metadata: node.metadata })
    })).filter(step => Boolean(step.text));
    if (steps.length < 2) return [];
    const artifacts = structure.files.slice(0, 8).map(file => plannedFileArtifact(file, structure.id));
    const matched = matchRequirements(input.requirements, { claims: [claim], artifacts, steps, evidenceIds: [] });
    return [{
      kind: "reasoning",
      family,
      operatorActivations: compositionOperators.slice(0, 8),
      claims: [claim],
      relations: [],
      steps,
      artifacts,
      evidenceIds: [],
      priorIds,
      graphNodeIds: [],
      semanticFrameIds: uniqueStrings(input.requirements.activatedFrameIds),
      constructIds: [structure.id],
      satisfiedRequirementIds: matched.satisfied,
      missedRequirementIds: matched.missed
    }];
  });
}

function programDesignDrafts(input: CognitivePlannerInput, operators: ActivatedOperator[]): ProposalDraft[] {
  if (!operatorRequirementGate(
    input.requirements,
    operators,
    COGNITIVE_OPERATOR_IDS.programPlanning,
    [["executableArtifactDemand", 0.7]]
  ) || !operatorRequirementGate(
    input.requirements,
    operators,
    COGNITIVE_OPERATOR_IDS.invention,
    [["noveltyDemand", 0.7]]
  )) return [];
  const relevant = operatorsForIds(operators, [COGNITIVE_OPERATOR_IDS.programPlanning, COGNITIVE_OPERATOR_IDS.invention]);
  return programGraphsForInput(input).slice(0, 3).flatMap((program): ProposalDraft[] => {
    const artifacts = program.files.slice(0, 16).map(file => plannedFileArtifact(file, program.id));
    if (artifacts.length === 0) return [];
    const orderedNodes = boundedOrderedSequence(program.nodes, program.edges, 10);
    const priorIds = uniqueStrings([program.id, ...orderedNodes.map(node => node.id)]);
    const algorithmSurface = cleanMeaningSurface(program.entrypoint)
      || cleanMeaningSurface(orderedNodes[orderedNodes.length - 1]?.label ?? "");
    const algorithmDraft = algorithmSurface
      ? programDesignDraft({
          input,
          program,
          relevant,
          artifacts,
          family: "algorithm_design",
          surfaces: [algorithmSurface],
          priorIds,
          steps: orderedNodes
        })
      : undefined;
    const hubs = structuralHubs(program.nodes, program.edges, 3);
    const architectureDraft = hubs.length > 0
      ? programDesignDraft({
          input,
          program,
          relevant,
          artifacts,
          family: "architecture_design",
          surfaces: hubs.map(node => node.label),
          priorIds: uniqueStrings([program.id, ...hubs.map(node => node.id)]),
          steps: hubs
        })
      : undefined;
    return [algorithmDraft, architectureDraft].filter((draft): draft is ProposalDraft => Boolean(draft));
  });
}

function programDesignDraft(input: {
  input: CognitivePlannerInput;
  program: ProgramGraph;
  relevant: ActivatedOperator[];
  artifacts: PlannedArtifact[];
  family: "algorithm_design" | "architecture_design";
  surfaces: readonly string[];
  priorIds: string[];
  steps: readonly MeaningStructureNode[];
}): ProposalDraft | undefined {
  const claims = input.surfaces.slice(0, 4).flatMap((surface, index): PlannedClaim[] => {
    const text = cleanMeaningSurface(surface);
    if (!text) return [];
    return [plannedClaim({
      seed: [input.family, input.program.id, index, text],
      text,
      basis: "invented",
      evidenceIds: [],
      priorIds: input.priorIds,
      graphNodeIds: [],
      graphEdgeIds: [],
      externallyFactual: false,
      hypothetical: false,
      trace: { source: "program_graph.design", family: input.family, programId: input.program.id }
    })];
  });
  if (claims.length === 0) return undefined;
  const steps = input.steps.slice(0, 10).flatMap((node, index): PlannedStep[] => {
    const text = cleanMeaningSurface(node.label);
    if (!text) return [];
    return [{
      id: stableId("planned_step", [input.family, input.program.id, node.id, index]),
      order: index,
      text,
      basis: "invented",
      dependsOnIds: index === 0 ? [] : [stableId("planned_step", [input.family, input.program.id, input.steps[index - 1]!.id, index - 1])],
      evidenceIds: [],
      trace: toJsonValue({ source: "program_graph.node", nodeId: node.id, nodeKind: node.kind })
    }];
  });
  const relations = claims.slice(1).map((claim, index): PlannedRelation => ({
    id: stableId("planned_relation", [input.family, input.program.id, index]),
    sourceClaimId: claims[index]!.id,
    targetClaimId: claim.id,
    relationId: input.family === "architecture_design"
      ? "relation.cognitive.architecture_dependency.v1"
      : "relation.cognitive.algorithm_sequence.v1",
    basis: "invented",
    graphEdgeIds: [],
    evidenceIds: [],
    trace: toJsonValue({ source: "program_graph.design", family: input.family, programId: input.program.id })
  }));
  const matched = matchRequirements(input.input.requirements, { claims, artifacts: input.artifacts, steps, evidenceIds: [] });
  return {
    kind: "invention",
    family: input.family,
    operatorActivations: input.relevant,
    claims,
    relations,
    steps,
    artifacts: input.artifacts,
    evidenceIds: [],
    priorIds: input.priorIds,
    graphNodeIds: [],
    semanticFrameIds: uniqueStrings(input.input.requirements.activatedFrameIds),
    constructIds: [input.program.id],
    satisfiedRequirementIds: matched.satisfied,
    missedRequirementIds: matched.missed
  };
}

function hypothesisDrafts(
  input: CognitivePlannerInput,
  operators: ActivatedOperator[],
  nodeById: Map<string, GraphNode>
): ProposalDraft[] {
  if (input.requirements.uncertaintyTolerance < 0.65) return [];
  if (Math.max(input.requirements.noveltyDemand, input.requirements.inferentialDepth) < 0.5) return [];
  const hypothesisOperators = operators.filter(operator =>
    operator.active
    && operator.activation > 0
    && (operator.operatorId === COGNITIVE_OPERATOR_IDS.invention || operator.operatorId === COGNITIVE_OPERATOR_IDS.analogy)
    && operator.contributingRequirementDimensions.some(dimension =>
      dimension === "uncertaintyTolerance" || dimension === "noveltyDemand" || dimension === "inferentialDepth"
    )
  );
  if (hypothesisOperators.length === 0) return [];
  return input.graph.edges
    .map(edge => ({ edge, uncertainty: relationUncertainty(edge, input.graph) }))
    .sort((left, right) => right.uncertainty - left.uncertainty || String(left.edge.id).localeCompare(String(right.edge.id)))
    .slice(0, 3)
    .flatMap(({ edge, uncertainty }, index): ProposalDraft[] => {
      const text = cleanMeaningSurface(nodeSurface(nodeById.get(String(edge.target))));
      if (!text) return [];
      const claim = plannedClaim({
        seed: ["hypothesis", edge.id, index],
        text,
        basis: "conjectured",
        evidenceIds: [],
        priorIds: [String(edge.id)],
        graphNodeIds: [String(edge.source), String(edge.target)],
        graphEdgeIds: [String(edge.id)],
        externallyFactual: false,
        hypothetical: true,
        trace: {
          source: "graph.relation_uncertainty",
          family: "hypothesis_generation",
          epistemicStatus: "conjectured",
          observed: false,
          edgeId: edge.id,
          uncertainty,
          projection: projectGraphEdgeRelationPotential(edge, { edges: input.graph.edges })
        }
      });
      const matched = matchRequirements(input.requirements, { claims: [claim], artifacts: [], steps: [], evidenceIds: [] });
      return [{
        kind: "reasoning",
        family: "hypothesis_generation",
        operatorActivations: hypothesisOperators.slice(0, 8),
        claims: [claim],
        relations: [],
        steps: [],
        artifacts: [],
        evidenceIds: [],
        priorIds: [String(edge.id)],
        graphNodeIds: [String(edge.source), String(edge.target)],
        semanticFrameIds: uniqueStrings(input.requirements.activatedFrameIds),
        constructIds: [],
        satisfiedRequirementIds: matched.satisfied,
        missedRequirementIds: matched.missed
      }];
    });
}

export function scoreReasoningProposal(input: {
  proposal: Pick<CognitiveProposal, "claims" | "relations" | "steps" | "artifacts" | "satisfiedRequirementIds" | "missedRequirementIds">;
  requirements: TurnRequirementField;
  graph: GraphSlice;
  field: FieldState;
}): ReasoningQuality {
  const claims = input.proposal.claims;
  const premiseClaims = claims.filter(claim => claim.basis === "direct_evidence" || claim.basis === "source_synthesis" || claim.basis === "learned_prior");
  const premiseValidity = premiseClaims.length === 0
    ? (claims.some(claim => claim.basis === "invented" || claim.basis === "counterfactual" || claim.basis === "conjectured") ? 1 : 0)
    : mean(premiseClaims.map(claim => claimBasisIsAdmissible(claim) ? 1 : 0));
  const relationContinuity = input.proposal.relations.length === 0
    ? (claims.some(claim => nonRelationalBasis(claim.basis)) ? 1 : 0)
    : mean(input.proposal.relations.map(relation => relation.graphEdgeIds.length > 0 || relation.basis === "invented" || relation.basis === "counterfactual" ? 1 : 0));
  const requiredCount = input.requirements.requiredFeatures.length;
  const requirementCoverage = requiredCount === 0
    ? 1
    : clamp01(input.proposal.satisfiedRequirementIds.length / requiredCount);
  const derived = claims.filter(claim => isDerivedBasis(claim.basis));
  const explanatoryPower = clamp01(mean([
    derived.length > 0 ? Math.min(1, derived.length / 2) : 0,
    input.proposal.relations.length > 0 ? Math.min(1, input.proposal.relations.length / 2) : 0,
    input.proposal.steps.length > 0 ? Math.min(1, input.proposal.steps.length / 3) : 0
  ]));
  const contradictionPressure = clamp01(input.field.alphaTrace.contradictionMass);
  const internalContradiction = proposalInternalContradiction(claims, input.proposal.relations, input.graph);
  const contradictionHandling = clamp01(1 - Math.max(contradictionPressure, internalContradiction));
  const temporalEdges = graphEdgesForProposal(input.proposal, input.graph).filter(edge => edge.temporalScope.validTo !== undefined || edge.temporalScope.validFrom > 0);
  const temporalConsistency = temporalEdges.length === 0
    ? 1
    : mean(temporalEdges.map(edge => edge.temporalScope.validTo === undefined || edge.temporalScope.validFrom <= edge.temporalScope.validTo ? 1 : 0));
  const complexity = claims.length + input.proposal.relations.length + input.proposal.steps.length + input.proposal.artifacts.length;
  const simplicity = clamp01(1 - Math.max(0, complexity - 4) / 16);
  const usefulness = clamp01(mean([
    requirementCoverage,
    input.proposal.artifacts.length > 0 ? 1 : 0,
    input.proposal.steps.length > 0 ? 1 : 0,
    input.field.alphaTrace.surfaces.actionability
  ]));
  const derivationClaims = claims.filter(claim => isDerivedBasis(claim.basis) || claim.basis === "unsupported");
  const unsupportedLeapRate = derivationClaims.length === 0
    ? 0
    : clamp01(derivationClaims.filter(claim => !claimBasisIsAdmissible(claim)).length / derivationClaims.length);
  const w = COGNITIVE_PROPOSAL_BOOTSTRAP.reasoning;
  const score =
    w.premiseValidity * premiseValidity
    + w.relationContinuity * relationContinuity
    + w.requirementCoverage * requirementCoverage
    + w.explanatoryPower * explanatoryPower
    + w.contradictionHandling * contradictionHandling
    + w.temporalConsistency * temporalConsistency
    + w.simplicity * simplicity
    + w.usefulness * usefulness
    + w.unsupportedLeapRate * unsupportedLeapRate
    + w.internalContradiction * internalContradiction;
  return finiteQuality({
    premiseValidity,
    relationContinuity,
    requirementCoverage,
    explanatoryPower,
    contradictionHandling,
    temporalConsistency,
    simplicity,
    usefulness,
    unsupportedLeapRate,
    internalContradiction,
    score
  });
}

export function weightedProposalJaccard(left: CognitiveProposal | ProposalDraft, right: CognitiveProposal | ProposalDraft): number {
  const leftFeatures = proposalFeatures(left);
  const rightFeatures = proposalFeatures(right);
  const ids = new Set([...leftFeatures.keys(), ...rightFeatures.keys()]);
  if (ids.size === 0) return 1;
  let intersection = 0;
  let union = 0;
  for (const id of ids) {
    const leftWeight = leftFeatures.get(id) ?? 0;
    const rightWeight = rightFeatures.get(id) ?? 0;
    intersection += Math.min(leftWeight, rightWeight);
    union += Math.max(leftWeight, rightWeight);
  }
  return union <= Number.EPSILON ? 1 : clamp01(intersection / union);
}

export function claimBasisIsAdmissible(claim: PlannedClaim): boolean {
  if (!claim.text.trim()) return false;
  switch (claim.basis) {
    case "direct_evidence":
    case "source_synthesis":
      return claim.evidenceIds.length > 0;
    case "reasoned_inference":
    case "causal_inference":
    case "temporal_inference":
      return claim.graphEdgeIds.length > 0 || claim.priorIds.length > 0;
    case "counterfactual":
      return claim.hypothetical && (claim.graphEdgeIds.length > 0 || claim.priorIds.length > 0 || claim.graphNodeIds.length > 0);
    case "learned_prior":
      return claim.priorIds.length > 0 || claim.graphNodeIds.length > 0;
    case "invented":
      return !claim.externallyFactual && claim.evidenceIds.length === 0;
    case "conjectured":
      return !claim.externallyFactual;
    case "translated":
      return claim.priorIds.length > 0 || claim.graphNodeIds.length > 0;
    case "action_result":
      return Boolean(claim.actionReceiptId);
    case "unsupported":
      return false;
  }
}

function inventionDrafts(
  input: CognitivePlannerInput,
  operators: ActivatedOperator[],
  evidenceById: Map<string, EvidenceSpan>
): ProposalDraft[] {
  if (!operatorActive(operators, COGNITIVE_OPERATOR_IDS.invention)) return [];
  return (input.inventions ?? []).slice(0, 8).map((invention, index) => {
    const trace = jsonRecord(invention.trace);
    const traceClaims = Array.isArray(trace.claimBasis) ? trace.claimBasis.map(jsonRecord) : [];
    const claims = traceClaims.flatMap((record, claimIndex): PlannedClaim[] => {
      const kind = textValue(record.kind);
      const force = textValue(record.force);
      const rawEvidenceIds = stringArray(record.evidenceIds).filter(id => evidenceById.has(id));
      const surface = cleanMeaningSurface(textValue(record.surface)) || (kind === "invention" ? cleanMeaningSurface(invention.proposalSurface) : "");
      if (!surface) return [];
      const basis: ClaimBasis = kind === "factual_premise"
        ? (rawEvidenceIds.length > 1 ? "source_synthesis" : "direct_evidence")
        : kind === "performance_prediction" || force === "conjectured"
          ? "conjectured"
          : kind === "deduction" || force === "inferred"
            ? "reasoned_inference"
            : "invented";
      const evidenceIds = basis === "invented" || basis === "conjectured" ? [] : asEvidenceIds(rawEvidenceIds);
      return [plannedClaim({
        seed: [invention.id, claimIndex, kind],
        text: surface,
        basis,
        evidenceIds,
        priorIds: invention.basisPriorIds,
        graphNodeIds: stringArray(trace.selectedGraphNodeIds),
        graphEdgeIds: basis === "reasoned_inference" ? stringArray(trace.selectedGraphEdgeIds) : [],
        externallyFactual: basis === "direct_evidence" || basis === "source_synthesis" || basis === "reasoned_inference",
        hypothetical: false,
        trace: { source: "invention.construct.claim_basis", constructId: invention.id, force, kind }
      })];
    });
    if (!claims.some(claim => claim.basis === "invented")) {
      claims.push(plannedClaim({
        seed: [invention.id, "invented"],
        text: cleanMeaningSurface(invention.proposalSurface) || cleanMeaningSurface(invention.title),
        basis: "invented",
        evidenceIds: [],
        priorIds: invention.basisPriorIds,
        graphNodeIds: stringArray(trace.selectedGraphNodeIds),
        graphEdgeIds: [],
        externallyFactual: false,
        hypothetical: false,
        trace: { source: "invention.construct", constructId: invention.id }
      }));
    }
    const artifacts = invention.artifactKindIds.map((kindId, artifactIndex): PlannedArtifact => ({
      id: stableId("artifact", [invention.id, kindId, artifactIndex]),
      kindId,
      title: cleanMeaningSurface(invention.title),
      constructId: invention.id,
      completion: clamp01(invention.supportScore),
      validationRequired: invention.validationPlan.length > 0,
      trace: toJsonValue({ source: "invention.construct", constructId: invention.id })
    }));
    const steps = invention.validationPlan.map((validation, stepIndex): PlannedStep => ({
      id: stableId("step", [invention.id, stepIndex]),
      order: stepIndex,
      text: [validation.command.command, ...validation.command.args].join(" ").trim(),
      basis: "invented",
      dependsOnIds: stepIndex === 0 ? [] : [stableId("step", [invention.id, stepIndex - 1])],
      evidenceIds: [],
      trace: toJsonValue({ source: "invention.validation_plan", commandSource: validation.commandSource })
    }));
    const matched = matchRequirements(input.requirements, { claims, artifacts, steps, evidenceIds: asEvidenceIds(invention.basisEvidenceIds) });
    return {
      kind: "invention",
      sourceInvention: invention,
      operatorActivations: relevantOperators(operators, ["noveltyDemand", "executableArtifactDemand", "inferentialDepth"]),
      claims,
      relations: relationsFromInventionTrace(invention, claims),
      steps,
      artifacts,
      evidenceIds: uniqueEvidenceIds(claims.flatMap(claim => claim.evidenceIds)),
      priorIds: uniqueStrings(invention.basisPriorIds),
      graphNodeIds: uniqueStrings(stringArray(trace.selectedGraphNodeIds)),
      semanticFrameIds: uniqueStrings(input.requirements.activatedFrameIds),
      constructIds: [invention.id],
      satisfiedRequirementIds: matched.satisfied,
      missedRequirementIds: matched.missed
    };
  });
}

function relationDrafts(
  input: CognitivePlannerInput,
  operators: ActivatedOperator[],
  evidenceById: Map<string, EvidenceSpan>,
  nodeById: Map<string, GraphNode>
): ProposalDraft[] {
  if (!operatorActive(
    operators,
    COGNITIVE_OPERATOR_IDS.graphPropagation,
    COGNITIVE_OPERATOR_IDS.relationComposition,
    COGNITIVE_OPERATOR_IDS.semanticProof,
    COGNITIVE_OPERATOR_IDS.temporalAnalysis,
    COGNITIVE_OPERATOR_IDS.causalAnalysis,
    COGNITIVE_OPERATOR_IDS.counterfactualConstruction,
    COGNITIVE_OPERATOR_IDS.analogy
  )) return [];
  const activeNodeIds = new Set(input.field.active.filter(item => item.activation > 0).map(item => String(item.nodeId)));
  const rankedEdges = input.graph.edges
    .filter(edge => activeNodeIds.size === 0 || activeNodeIds.has(String(edge.source)) || activeNodeIds.has(String(edge.target)))
    .sort((left, right) => edgeUtility(right) - edgeUtility(left) || String(left.id).localeCompare(String(right.id)))
    .slice(0, 8);
  const paths = boundedRelationPaths(rankedEdges, 8);
  const bases = activeReasoningBases(input.requirements, operators);
  const drafts: ProposalDraft[] = [];
  for (const path of paths) {
    const source = nodeById.get(String(path[0]?.source));
    const target = nodeById.get(String(path[path.length - 1]?.target));
    const conclusion = cleanMeaningSurface(nodeSurface(target));
    if (!source || !target || !conclusion) continue;
    const pathEvidenceIds = uniqueEvidenceIds(path.flatMap(edge => edge.evidenceIds).filter(id => evidenceById.has(String(id))));
    const premiseSpans = uniqueBySource(pathEvidenceIds.map(id => evidenceById.get(String(id))).filter((span): span is EvidenceSpan => Boolean(span))).slice(0, 4);
    for (const basis of bases) {
      const conclusionClaim = plannedClaim({
        seed: [basis, ...path.map(edge => String(edge.id))],
        text: conclusion,
        basis,
        evidenceIds: [],
        priorIds: [],
        graphNodeIds: uniqueStrings([String(source.id), ...path.map(edge => String(edge.target))]),
        graphEdgeIds: path.map(edge => String(edge.id)),
        externallyFactual: basis !== "counterfactual",
        hypothetical: basis === "counterfactual",
        trace: { source: "graph.relation_path", pathLength: path.length }
      });
      const premiseClaims = premiseSpans.map((span, index) => plannedClaim({
        seed: [basis, "premise", span.id, index],
        text: cleanMeaningSurface(span.textPreview || span.text),
        basis: "direct_evidence",
        evidenceIds: [span.id],
        priorIds: [],
        graphNodeIds: graphNodesForEvidence(input.graph, span.id),
        graphEdgeIds: [],
        externallyFactual: true,
        hypothetical: false,
        trace: { source: "evidence.span", sourceId: span.sourceId }
      }));
      const claims = [...premiseClaims, conclusionClaim];
      const relations = path.map((edge, index): PlannedRelation => ({
        id: stableId("planned_relation", [basis, edge.id, index]),
        sourceClaimId: premiseClaims[Math.min(index, Math.max(0, premiseClaims.length - 1))]?.id ?? conclusionClaim.id,
        targetClaimId: conclusionClaim.id,
        relationId: String(edge.relationId),
        basis,
        graphEdgeIds: [String(edge.id)],
        evidenceIds: uniqueEvidenceIds(edge.evidenceIds.filter(id => evidenceById.has(String(id)))),
        trace: toJsonValue({ source: "graph.edge", edgeId: edge.id })
      }));
      const matched = matchRequirements(input.requirements, { claims, artifacts: [], steps: [], evidenceIds: pathEvidenceIds });
      drafts.push({
        kind: basis === "counterfactual" ? "counterfactual" : "reasoning",
        operatorActivations: relevantOperators(operators, basisDimensions(basis)),
        claims,
        relations,
        steps: [],
        artifacts: [],
        evidenceIds: pathEvidenceIds,
        priorIds: [],
        graphNodeIds: uniqueStrings([String(source.id), ...path.map(edge => String(edge.target))]),
        semanticFrameIds: uniqueStrings(input.requirements.activatedFrameIds),
        constructIds: [],
        satisfiedRequirementIds: matched.satisfied,
        missedRequirementIds: matched.missed
      });
    }
  }
  return drafts;
}

function sourceSynthesisDrafts(
  input: CognitivePlannerInput,
  operators: ActivatedOperator[],
  evidenceById: Map<string, EvidenceSpan>,
  nodeById: Map<string, GraphNode>
): ProposalDraft[] {
  if (!operatorActive(operators, COGNITIVE_OPERATOR_IDS.sourceSynthesis)) return [];
  const sources = uniqueBySource([...evidenceById.values()]).slice(0, 5);
  if (sources.length < 2) return [];
  const supportedTargets = input.graph.nodes
    .filter(node => node.evidenceIds.filter(id => evidenceById.has(String(id))).length >= 2)
    .sort((left, right) => right.alpha - left.alpha || String(left.id).localeCompare(String(right.id)))
    .slice(0, 3);
  return supportedTargets.flatMap((target, index): ProposalDraft[] => {
    const targetEvidence = uniqueBySource(target.evidenceIds.map(id => evidenceById.get(String(id))).filter((span): span is EvidenceSpan => Boolean(span)));
    if (targetEvidence.length < 2) return [];
    const text = cleanMeaningSurface(nodeSurface(nodeById.get(String(target.id))));
    if (!text) return [];
    const evidenceIds = asEvidenceIds(targetEvidence.map(span => String(span.id)));
    const claims = [plannedClaim({
      seed: ["source_synthesis", target.id, index],
      text,
      basis: "source_synthesis",
      evidenceIds,
      priorIds: [],
      graphNodeIds: [String(target.id)],
      graphEdgeIds: input.graph.edges.filter(edge => String(edge.target) === String(target.id) && edge.evidenceIds.some(id => evidenceById.has(String(id)))).map(edge => String(edge.id)),
      externallyFactual: true,
      hypothetical: false,
      trace: { source: "graph.multi_source_node", sourceCount: targetEvidence.length }
    })];
    const matched = matchRequirements(input.requirements, { claims, artifacts: [], steps: [], evidenceIds });
    return [{
      kind: "reasoning",
      operatorActivations: relevantOperators(operators, ["sourceDependence", "inferentialDepth"]),
      claims,
      relations: [],
      steps: [],
      artifacts: [],
      evidenceIds,
      priorIds: [],
      graphNodeIds: [String(target.id)],
      semanticFrameIds: uniqueStrings(input.requirements.activatedFrameIds),
      constructIds: [],
      satisfiedRequirementIds: matched.satisfied,
      missedRequirementIds: matched.missed
    }];
  });
}

function constructPriorDrafts(input: CognitivePlannerInput, operators: ActivatedOperator[]): ProposalDraft[] {
  if (!operatorActive(
    operators,
    COGNITIVE_OPERATOR_IDS.dialogueContinuation,
    COGNITIVE_OPERATOR_IDS.analogy,
    COGNITIVE_OPERATOR_IDS.transformation,
    COGNITIVE_OPERATOR_IDS.translation,
    COGNITIVE_OPERATOR_IDS.programPlanning,
    COGNITIVE_OPERATOR_IDS.workspaceRepair,
    COGNITIVE_OPERATOR_IDS.actionPlanning
  )) return [];
  const inventionIds = new Set((input.inventions ?? []).map(invention => invention.id));
  return input.construct.nodes
    .filter(node => !inventionIds.has(node.id))
    .slice(0, 3)
    .flatMap((node, index): ProposalDraft[] => {
      const text = cleanMeaningSurface(node.label);
      if (!text) return [];
      const claim = plannedClaim({
        seed: ["construct_prior", node.id, index],
        text,
        basis: "learned_prior",
        evidenceIds: [],
        priorIds: [node.id],
        graphNodeIds: [],
        graphEdgeIds: [],
        externallyFactual: false,
        hypothetical: false,
        trace: { source: "construct.node", kind: node.kind }
      });
      const matched = matchRequirements(input.requirements, { claims: [claim], artifacts: [], steps: [], evidenceIds: [] });
      return [{
        kind: "reasoning",
        operatorActivations: relevantOperators(operators, ["dialogueDependence", "inferentialDepth"]),
        claims: [claim],
        relations: [],
        steps: [],
        artifacts: [],
        evidenceIds: [],
        priorIds: [node.id],
        graphNodeIds: [],
        semanticFrameIds: uniqueStrings(input.requirements.activatedFrameIds),
        constructIds: [node.id],
        satisfiedRequirementIds: matched.satisfied,
        missedRequirementIds: matched.missed
      }];
    });
}

function clarificationDrafts(input: CognitivePlannerInput, operators: ActivatedOperator[]): ProposalDraft[] {
  if (!operatorActive(operators, COGNITIVE_OPERATOR_IDS.clarification)) return [];
  if (input.evidence.length > 0 || input.graph.edges.length > 0 || (input.inventions?.length ?? 0) > 0 || input.construct.nodes.length > 0) return [];
  const active = relevantOperators(operators, ["externalTruthAuthority", "dialogueDependence"]);
  return [{
    kind: "clarification",
    operatorActivations: active,
    claims: [],
    relations: [],
    steps: [],
    artifacts: [],
    evidenceIds: [],
    priorIds: [],
    graphNodeIds: [],
    semanticFrameIds: uniqueStrings(input.requirements.activatedFrameIds),
    constructIds: [],
    satisfiedRequirementIds: [],
    missedRequirementIds: input.requirements.requiredFeatures.map(requirement => requirement.id)
  }];
}

function scoreDraft(input: CognitivePlannerInput, draft: ProposalDraft): ScoredDraft {
  const reasoning = scoreReasoningProposal({ proposal: draft, requirements: input.requirements, graph: input.graph, field: input.field });
  const hardFailures = claimHardFailures(draft.claims);
  const provisional: ScoredDraft = {
    ...draft,
    id: stableId("cognitive_proposal", proposalIdentity(draft)),
    reasoning,
    baseQuality: clamp01(reasoning.score),
    hardFailures
  };
  if (draft.kind !== "invention" || !draft.sourceInvention) return provisional;
  const invention = scoreInventionProposal(input, draft);
  return { ...provisional, invention, baseQuality: hardFailures.length > 0 ? 0 : clamp01(invention.score) };
}

function scoreInventionProposal(input: CognitivePlannerInput, draft: ProposalDraft): InventionQuality {
  const invention = draft.sourceInvention;
  if (!invention) throw new Error("invention proposal is missing its existing InventionConstruct");
  const trace = jsonRecord(invention.trace);
  const requirementSatisfaction = input.requirements.requiredFeatures.length === 0
    ? clamp01(numberValue(trace.constraintCoverage, 1))
    : clamp01(draft.satisfiedRequirementIds.length / input.requirements.requiredFeatures.length);
  const relationCoherence = draft.relations.length > 0
    ? relationCoherenceForIds(draft.relations.flatMap(relation => relation.graphEdgeIds), input.graph)
    : clamp01(numberValue(trace.graphCoherence, relationCoherenceForIds(stringArray(trace.selectedGraphEdgeIds), input.graph)));
  const noveltyMemory = clamp01(numberValue(trace.novelty, invention.noveltyScore));
  const siblingInventions = (input.inventions ?? []).filter(candidate => candidate.id !== invention.id);
  const noveltySibling = siblingInventions.length === 0
    ? 1
    : clamp01(1 - Math.max(...siblingInventions.map(candidate => inventionSimilarity(invention, candidate))));
  const novelty = clamp01(0.70 * noveltyMemory + 0.30 * noveltySibling);
  const explicitRequirements = input.requirements.requiredFeatures.filter(requirement => requirement.status === "explicit");
  const inferredRequirements = input.requirements.requiredFeatures.filter(requirement => requirement.status === "inferred");
  const explicitRequirementFit = requirementSubsetFit(explicitRequirements, draft.satisfiedRequirementIds);
  const inferredGoalFit = requirementSubsetFit(inferredRequirements, draft.satisfiedRequirementIds);
  const audienceFit = requirementDimensionFit(input.requirements.requiredFeatures, draft.satisfiedRequirementIds, "audienceAdaptation");
  const artifactFit = input.requirements.executableArtifactDemand <= 0.25
    ? 1
    : clamp01(draft.artifacts.length > 0 ? mean(draft.artifacts.map(artifact => artifact.completion)) : 0);
  const fit = clamp01(mean([explicitRequirementFit, inferredGoalFit, audienceFit, artifactFit]));
  const actionability = clamp01(input.field.alphaTrace.surfaces.actionability);
  const completeness = requirementSatisfaction;
  const problemReduction = clamp01(numberValue(trace.usefulness, invention.supportScore));
  const implementationPotential = draft.artifacts.length > 0 || draft.steps.length > 0 ? 1 : clamp01(invention.supportScore);
  const usefulness = clamp01(mean([actionability, completeness, problemReduction, implementationPotential]));
  const languageRealizability = clamp01(numberValue(trace.languageRealizability, 0));
  const styleFit = clamp01(numberValue(trace.styleFit, requirementDimensionFit(input.requirements.requiredFeatures, draft.satisfiedRequirementIds, "audienceAdaptation")));
  const prohibitedFeatureHit = prohibitedFeatureRate(input.requirements, draft);
  const requirementViolation = input.requirements.requiredFeatures.length === 0 ? 0 : 1 - requirementSatisfaction;
  const risk = clamp01(Math.max(
    numberValue(trace.risk, invention.riskScore),
    proposalInternalContradiction(draft.claims, draft.relations, input.graph),
    prohibitedFeatureHit,
    requirementViolation
  ));
  const repetition = clamp01(numberValue(trace.repetition, repetitionRate(draft.claims.map(claim => claim.text))));
  const externalClaims = draft.claims.filter(claim => claim.externallyFactual);
  const unsupportedExternallyFactualRate = externalClaims.length === 0
    ? 0
    : clamp01(externalClaims.filter(claim => !claimBasisIsAdmissible(claim)).length / externalClaims.length);
  const w = COGNITIVE_PROPOSAL_BOOTSTRAP.invention;
  const score =
    w.requirementSatisfaction * requirementSatisfaction
    + w.relationCoherence * relationCoherence
    + w.novelty * novelty
    + w.fit * fit
    + w.usefulness * usefulness
    + w.languageRealizability * languageRealizability
    + w.styleFit * styleFit
    + w.risk * risk
    + w.repetition * repetition
    + w.unsupportedExternallyFactualRate * unsupportedExternallyFactualRate;
  return finiteQuality({
    requirementSatisfaction,
    relationCoherence,
    noveltyMemory,
    noveltySibling,
    novelty,
    fit,
    usefulness,
    languageRealizability,
    styleFit,
    risk,
    repetition,
    unsupportedExternallyFactualRate,
    score
  });
}

function selectWithMmr(
  candidates: ScoredDraft[],
  memory: readonly CognitiveProposal[],
  limit: number
): Array<{ draft: ScoredDraft; diversity: number; mmr: number }> {
  const remaining = [...candidates].sort((left, right) => right.baseQuality - left.baseQuality || left.id.localeCompare(right.id));
  const selected: Array<{ draft: ScoredDraft; diversity: number; mmr: number }> = [];
  while (remaining.length > 0 && selected.length < limit) {
    const scored = remaining.map(draft => {
      const comparisons: Array<CognitiveProposal | ProposalDraft> = [...memory, ...selected.map(item => item.draft)];
      const similarity = comparisons.length === 0 ? 0 : Math.max(...comparisons.map(other => weightedProposalJaccard(draft, other)));
      const diversity = clamp01(1 - similarity);
      const mmr = COGNITIVE_PROPOSAL_BOOTSTRAP.mmr.quality * draft.baseQuality
        + COGNITIVE_PROPOSAL_BOOTSTRAP.mmr.diversity * diversity;
      return { draft, diversity, mmr, similarity };
    }).sort((left, right) => right.mmr - left.mmr || right.diversity - left.diversity || left.draft.id.localeCompare(right.draft.id));
    const next = scored.find(item => item.similarity < 0.86) ?? (selected.length === 0 ? scored[0] : undefined);
    if (!next) break;
    selected.push({ draft: next.draft, diversity: next.diversity, mmr: next.mmr });
    remaining.splice(remaining.findIndex(candidate => candidate.id === next.draft.id), 1);
  }
  return selected;
}

function finalizeProposal(draft: ScoredDraft, diversity: number, mmr: number, rank: number): CognitiveProposal {
  return {
    id: draft.id,
    operatorActivations: draft.operatorActivations,
    claims: draft.claims,
    relations: draft.relations,
    steps: draft.steps,
    artifacts: draft.artifacts,
    evidenceIds: draft.evidenceIds,
    priorIds: draft.priorIds,
    graphNodeIds: draft.graphNodeIds,
    semanticFrameIds: draft.semanticFrameIds,
    constructIds: draft.constructIds,
    satisfiedRequirementIds: draft.satisfiedRequirementIds,
    missedRequirementIds: draft.missedRequirementIds,
    quality: {
      reasoning: draft.reasoning,
      invention: draft.invention,
      baseQuality: draft.baseQuality,
      diversity,
      mmr,
      hardFailures: draft.hardFailures
    },
    trace: toJsonValue({
      source: "cognitive-planner.plan",
      schema: "scce.cognitive_proposal.trace.v1",
      kind: draft.kind,
      family: draft.family ?? draft.kind,
      rank: rank + 1,
      claimBases: draft.claims.map(claim => ({ claimId: claim.id, basis: claim.basis, evidenceIds: claim.evidenceIds })),
      equations: {
        reasoning: "Q_reason=0.20P+0.17C+0.15X+0.13E+0.10K+0.09T+0.08S+0.08U-0.45L-0.35I",
        invention: "Q_invention=0.24X+0.18C+0.18N+0.16F+0.12U+0.07L+0.05styleFit-0.30R-0.22repetition-0.70H",
        novelty: "N=0.70*N_memory+0.30*N_sibling",
        diversity: "diversity(g,S)=1-max_h(weightedJaccard(phi(g),phi(h)))",
        mmr: "MMR(g)=0.72*quality(g)+0.28*diversity(g,S)"
      },
      bootstrap: COGNITIVE_PROPOSAL_BOOTSTRAP,
      calibrationStatus: "bootstrap_uncalibrated",
      quality: {
        reasoning: draft.reasoning,
        invention: draft.invention ?? null,
        baseQuality: draft.baseQuality,
        diversity,
        mmr
      },
      hardFailures: draft.hardFailures
    })
  };
}

function activeReasoningBases(requirements: TurnRequirementField, operators: readonly ActivatedOperator[]): ClaimBasis[] {
  const bases: ClaimBasis[] = ["reasoned_inference"];
  if (requirements.causalReasoningDemand > 0 && hasDimensionOperator(operators, "causalReasoningDemand")) bases.push("causal_inference");
  if (requirements.temporalReasoningDemand > 0 && hasDimensionOperator(operators, "temporalReasoningDemand")) bases.push("temporal_inference");
  if (requirements.counterfactualDemand > 0 && hasDimensionOperator(operators, "counterfactualDemand")) bases.push("counterfactual");
  return uniqueStrings(bases) as ClaimBasis[];
}

interface MeaningStructureNode {
  id: string;
  kind: string;
  label: string;
  metadata: JsonValue;
}

interface MeaningStructureEdge {
  source: string;
  target: string;
  relation: string;
  weight: number;
}

interface MeaningStructure {
  id: string;
  nodes: MeaningStructureNode[];
  edges: MeaningStructureEdge[];
  files: FileArtifact[];
}

function operatorRequirementGate(
  requirements: TurnRequirementField,
  operators: readonly ActivatedOperator[],
  operatorId: ActivatedOperator["operatorId"],
  dimensions: readonly (readonly [TurnRequirementDimension, number])[]
): boolean {
  if (!dimensions.every(([dimension, threshold]) => requirements[dimension] >= threshold)) return false;
  return operators.some(operator =>
    operator.active
    && operator.activation > 0
    && operator.operatorId === operatorId
    && dimensions.every(([dimension]) => operator.contributingRequirementDimensions.includes(dimension))
  );
}

function operatorsForIds(
  operators: readonly ActivatedOperator[],
  operatorIds: readonly ActivatedOperator["operatorId"][]
): ActivatedOperator[] {
  const ids = new Set(operatorIds);
  return operators.filter(operator => operator.active && operator.activation > 0 && ids.has(operator.operatorId)).slice(0, 8);
}

function firstEdgePair(
  edges: readonly GraphEdge[],
  predicate: (left: GraphEdge, right: GraphEdge) => boolean
): readonly [GraphEdge, GraphEdge] | undefined {
  return edgePairs(edges).find(([left, right]) => predicate(left, right));
}

function edgePairs(edges: readonly GraphEdge[]): Array<readonly [GraphEdge, GraphEdge]> {
  const pairs: Array<readonly [GraphEdge, GraphEdge]> = [];
  for (let leftIndex = 0; leftIndex < edges.length; leftIndex += 1) {
    for (let rightIndex = leftIndex + 1; rightIndex < edges.length; rightIndex += 1) {
      const left = edges[leftIndex];
      const right = edges[rightIndex];
      if (left && right) pairs.push([left, right]);
    }
  }
  return pairs;
}

function edgePairKey(edges: readonly [GraphEdge, GraphEdge]): string {
  return edges.map(edge => String(edge.id)).sort().join("|");
}

function relationPotentialTension(left: GraphEdge, right: GraphEdge, graph: GraphSlice): number {
  const leftFeatures = projectGraphEdgeRelationPotential(left, { edges: graph.edges }).features;
  const rightFeatures = projectGraphEdgeRelationPotential(right, { edges: graph.edges }).features;
  return clamp01(mean([
    Math.abs(leftFeatures.utility - rightFeatures.utility),
    Math.abs(leftFeatures.compatibility - rightFeatures.compatibility),
    Math.abs(leftFeatures.contradiction - rightFeatures.contradiction),
    Math.abs(leftFeatures.temporalFit - rightFeatures.temporalFit)
  ]));
}

function relationUncertainty(edge: GraphEdge, graph: GraphSlice): number {
  const features = projectGraphEdgeRelationPotential(edge, { edges: graph.edges }).features;
  return clamp01(mean([
    features.contradiction,
    1 - features.provenance,
    1 - features.sourceAgreement,
    1 - features.modalityAgreement,
    1 - features.temporalFit
  ]));
}

function programGraphsForInput(input: CognitivePlannerInput): ProgramGraph[] {
  const programs = [input.construct.program, ...(input.programGraphs ?? [])].filter((program): program is ProgramGraph => Boolean(program));
  return [...new Map(programs.map(program => [program.id, program])).values()];
}

function meaningStructures(input: CognitivePlannerInput): MeaningStructure[] {
  const construct: MeaningStructure = {
    id: String(input.construct.id),
    nodes: input.construct.nodes.map(node => ({ id: node.id, kind: node.kind, label: node.label, metadata: node.metadata })),
    edges: input.construct.edges.map(edge => ({ source: edge.source, target: edge.target, relation: edge.relation, weight: edge.weight })),
    files: [...input.construct.artifacts]
  };
  const programs = programGraphsForInput(input).map((program): MeaningStructure => ({
    id: program.id,
    nodes: program.nodes.map(node => ({ id: node.id, kind: node.kind, label: node.label, metadata: node.metadata })),
    edges: program.edges.map(edge => ({ source: edge.source, target: edge.target, relation: edge.relation, weight: edge.weight })),
    files: [...program.files]
  }));
  return [construct, ...programs].filter((structure, index, all) =>
    structure.nodes.length > 0 && all.findIndex(other => other.id === structure.id) === index
  );
}

function boundedOrderedSequence(
  nodes: readonly MeaningStructureNode[],
  edges: readonly MeaningStructureEdge[],
  limit: number
): MeaningStructureNode[] {
  const byId = new Map(nodes.map(node => [node.id, node]));
  const validEdges = edges
    .filter(edge => byId.has(edge.source) && byId.has(edge.target) && edge.source !== edge.target)
    .sort((left, right) => right.weight - left.weight || `${left.source}|${left.target}`.localeCompare(`${right.source}|${right.target}`));
  const outgoing = new Map<string, MeaningStructureEdge[]>();
  const incomingCount = new Map(nodes.map(node => [node.id, 0]));
  for (const edge of validEdges) {
    const list = outgoing.get(edge.source) ?? [];
    list.push(edge);
    outgoing.set(edge.source, list);
    incomingCount.set(edge.target, (incomingCount.get(edge.target) ?? 0) + 1);
  }
  const starts = nodes
    .filter(node => (incomingCount.get(node.id) ?? 0) === 0 && (outgoing.get(node.id)?.length ?? 0) > 0)
    .sort(compareStructureNodes);
  const candidates: MeaningStructureNode[][] = [];
  const walk = (node: MeaningStructureNode, path: MeaningStructureNode[], visited: Set<string>) => {
    const nextPath = [...path, node];
    const successors = (outgoing.get(node.id) ?? []).filter(edge => !visited.has(edge.target));
    if (successors.length === 0 || nextPath.length >= limit) {
      candidates.push(nextPath);
      return;
    }
    for (const edge of successors.slice(0, 4)) {
      const next = byId.get(edge.target);
      if (!next) continue;
      walk(next, nextPath, new Set([...visited, edge.target]));
    }
  };
  for (const start of starts.slice(0, 8)) walk(start, [], new Set([start.id]));
  const best = candidates
    .filter(candidate => candidate.length >= 2)
    .sort((left, right) => right.length - left.length || left.map(node => node.id).join("|").localeCompare(right.map(node => node.id).join("|")))[0];
  if (best) return best.slice(0, limit);
  const explicitlyOrdered = nodes
    .map(node => ({ node, order: structureNodeOrder(node) }))
    .filter((item): item is { node: MeaningStructureNode; order: number } => item.order !== undefined)
    .sort((left, right) => left.order - right.order || left.node.id.localeCompare(right.node.id));
  return explicitlyOrdered.length >= 2 ? explicitlyOrdered.slice(0, limit).map(item => item.node) : [];
}

function structureNodeOrder(node: MeaningStructureNode): number | undefined {
  const metadata = jsonRecord(node.metadata);
  for (const value of [metadata.order, metadata.index, metadata.sequence]) {
    if (typeof value === "number" && Number.isFinite(value)) return value;
  }
  return undefined;
}

function compareStructureNodes(left: MeaningStructureNode, right: MeaningStructureNode): number {
  const leftOrder = structureNodeOrder(left);
  const rightOrder = structureNodeOrder(right);
  if (leftOrder !== undefined || rightOrder !== undefined) return (leftOrder ?? Number.MAX_SAFE_INTEGER) - (rightOrder ?? Number.MAX_SAFE_INTEGER) || left.id.localeCompare(right.id);
  return left.id.localeCompare(right.id);
}

function hasMathematicalStructure(node: MeaningStructureNode): boolean {
  const metadata = jsonRecord(node.metadata);
  const structuralIds = [node.kind, textValue(metadata.schema), textValue(metadata.typeId), textValue(metadata.roleId), textValue(metadata.operatorId)];
  if (structuralIds.some(id => /^(?:math|role\.math|operator\.math|construct\.math)(?:[.:]|$)/u.test(id))) return true;
  if (typeof metadata.value === "number" && Number.isFinite(metadata.value)) return true;
  return Array.isArray(metadata.operands)
    && metadata.operands.length > 0
    && metadata.operands.every(value => typeof value === "number" && Number.isFinite(value));
}

function structuralHubs(
  nodes: readonly MeaningStructureNode[],
  edges: readonly MeaningStructureEdge[],
  limit: number
): MeaningStructureNode[] {
  const degree = new Map(nodes.map(node => [node.id, 0]));
  for (const edge of edges) {
    if (degree.has(edge.source)) degree.set(edge.source, (degree.get(edge.source) ?? 0) + 1);
    if (degree.has(edge.target)) degree.set(edge.target, (degree.get(edge.target) ?? 0) + 1);
  }
  return nodes
    .filter(node => (degree.get(node.id) ?? 0) > 0 && Boolean(cleanMeaningSurface(node.label)))
    .sort((left, right) => (degree.get(right.id) ?? 0) - (degree.get(left.id) ?? 0) || left.id.localeCompare(right.id))
    .slice(0, limit);
}

function plannedFileArtifact(file: FileArtifact, constructId: string): PlannedArtifact {
  return {
    id: stableId("artifact", [constructId, file.artifactId, file.contentHash]),
    kindId: `artifact.program.${file.role}.v1`,
    title: cleanMeaningSurface(file.path),
    constructId,
    completion: 1,
    validationRequired: true,
    trace: toJsonValue({ source: "program_graph.file", artifactId: file.artifactId, path: file.path, mediaType: file.mediaType, contentHash: file.contentHash })
  };
}

function relevantOperators(operators: readonly ActivatedOperator[], dimensions: readonly TurnRequirementDimension[]): ActivatedOperator[] {
  const dimensionSet = new Set<TurnRequirementDimension>(dimensions);
  const relevant = operators.filter(operator => operator.contributingRequirementDimensions.some(dimension => dimensionSet.has(dimension)));
  return (relevant.length > 0 ? relevant : operators.slice(0, 3)).slice(0, 8);
}

function hasDimensionOperator(operators: readonly ActivatedOperator[], dimension: TurnRequirementDimension): boolean {
  return operators.some(operator => operator.active && operator.activation > 0 && operator.contributingRequirementDimensions.includes(dimension));
}

function operatorActive(operators: readonly ActivatedOperator[], ...operatorIds: readonly ActivatedOperator["operatorId"][]): boolean {
  const allowed = new Set(operatorIds);
  return operators.some(operator => operator.active && operator.activation > 0 && allowed.has(operator.operatorId));
}

function basisDimensions(basis: ClaimBasis): TurnRequirementDimension[] {
  if (basis === "causal_inference") return ["causalReasoningDemand", "inferentialDepth"];
  if (basis === "temporal_inference") return ["temporalReasoningDemand", "inferentialDepth"];
  if (basis === "counterfactual") return ["counterfactualDemand", "inferentialDepth"];
  return ["inferentialDepth", "sourceDependence"];
}

function matchRequirements(
  requirements: TurnRequirementField,
  proposal: { claims: PlannedClaim[]; artifacts: PlannedArtifact[]; steps: PlannedStep[]; evidenceIds: EvidenceId[] }
): { satisfied: string[]; missed: string[] } {
  const satisfied: string[] = [];
  const missed: string[] = [];
  for (const requirement of requirements.requiredFeatures) {
    (satisfiesRequirement(requirement, proposal) ? satisfied : missed).push(requirement.id);
  }
  for (const requirement of requirements.prohibitedFeatures) {
    (satisfiesRequirement(requirement, proposal) ? missed : satisfied).push(requirement.id);
  }
  return { satisfied: uniqueStrings(satisfied), missed: uniqueStrings(missed) };
}

function satisfiesRequirement(
  requirement: TurnRequirement,
  proposal: { claims: PlannedClaim[]; artifacts: PlannedArtifact[]; steps: PlannedStep[]; evidenceIds: EvidenceId[] }
): boolean {
  const bases = new Set(proposal.claims.map(claim => claim.basis));
  switch (requirement.dimension) {
    case "externalTruthAuthority":
    case "sourceDependence":
      return proposal.evidenceIds.length > 0 && proposal.claims.filter(claim => claim.externallyFactual).every(claimBasisIsAdmissible);
    case "noveltyDemand":
      return bases.has("invented") || bases.has("counterfactual");
    case "inferentialDepth":
      return [...bases].some(isDerivedBasis);
    case "semanticPreservation":
    case "surfaceTransformation":
      return bases.has("translated") || proposal.claims.length > 0;
    case "executableArtifactDemand":
      return proposal.artifacts.length > 0 || proposal.steps.length > 0;
    case "actionCommitment":
      return proposal.claims.some(claim => claim.basis === "action_result" && Boolean(claim.actionReceiptId));
    case "dialogueDependence":
      return proposal.claims.some(claim => claim.priorIds.length > 0);
    case "uncertaintyTolerance":
      return bases.has("conjectured") || bases.has("counterfactual") || bases.has("invented");
    case "formatConstraintStrength":
    case "audienceAdaptation":
    case "brevityDetailBalance":
      return proposal.claims.length > 0 || proposal.artifacts.length > 0;
    case "temporalReasoningDemand":
      return bases.has("temporal_inference");
    case "causalReasoningDemand":
      return bases.has("causal_inference");
    case "counterfactualDemand":
      return bases.has("counterfactual");
  }
}

function requirementSubsetFit(requirements: readonly TurnRequirement[], satisfiedIds: readonly string[]): number {
  if (requirements.length === 0) return 1;
  const satisfied = new Set(satisfiedIds);
  const totalWeight = requirements.reduce((sum, requirement) => sum + Math.max(Number.EPSILON, requirement.value * requirement.confidence), 0);
  return clamp01(requirements.reduce((sum, requirement) => sum + (satisfied.has(requirement.id) ? Math.max(Number.EPSILON, requirement.value * requirement.confidence) : 0), 0) / totalWeight);
}

function requirementDimensionFit(
  requirements: readonly TurnRequirement[],
  satisfiedIds: readonly string[],
  dimension: TurnRequirementDimension
): number {
  return requirementSubsetFit(requirements.filter(requirement => requirement.dimension === dimension), satisfiedIds);
}

function prohibitedFeatureRate(requirements: TurnRequirementField, draft: ProposalDraft): number {
  if (requirements.prohibitedFeatures.length === 0) return 0;
  const missed = new Set(draft.missedRequirementIds);
  return clamp01(requirements.prohibitedFeatures.filter(requirement => missed.has(requirement.id)).length / requirements.prohibitedFeatures.length);
}

function relationsFromInventionTrace(invention: InventionConstruct, claims: PlannedClaim[]): PlannedRelation[] {
  const trace = jsonRecord(invention.trace);
  const edgeIds = stringArray(trace.selectedGraphEdgeIds);
  const target = claims.find(claim => claim.basis === "invented");
  const source = claims.find(claim => claim.basis === "direct_evidence" || claim.basis === "source_synthesis" || claim.basis === "reasoned_inference");
  if (!target || edgeIds.length === 0) return [];
  return edgeIds.map((edgeId, index) => ({
    id: stableId("planned_relation", [invention.id, edgeId, index]),
    sourceClaimId: source?.id ?? target.id,
    targetClaimId: target.id,
    relationId: "relation.composed_invention",
    basis: "invented",
    graphEdgeIds: [edgeId],
    evidenceIds: [],
    trace: toJsonValue({ source: "invention.construct.trace", constructId: invention.id })
  }));
}

function boundedRelationPaths(edges: readonly GraphEdge[], limit: number): GraphEdge[][] {
  const paths: GraphEdge[][] = edges.map(edge => [edge]);
  for (const first of edges) {
    for (const second of edges) {
      if (String(first.target) !== String(second.source) || String(first.id) === String(second.id)) continue;
      paths.push([first, second]);
      if (paths.length >= limit * 2) break;
    }
    if (paths.length >= limit * 2) break;
  }
  return paths
    .sort((left, right) => mean(right.map(edgeUtility)) - mean(left.map(edgeUtility)) || pathKey(left).localeCompare(pathKey(right)))
    .slice(0, limit);
}

function relationCoherenceForIds(edgeIds: readonly string[], graph: GraphSlice): number {
  const wanted = new Set(edgeIds);
  const edges = graph.edges.filter(edge => wanted.has(String(edge.id)));
  if (edges.length === 0) return 0;
  return clamp01(mean(edges.map(edge => {
    const projection = projectGraphEdgeRelationPotential(edge, { edges: graph.edges });
    const positive = mean([
      projection.features.compatibility,
      projection.features.provenance,
      projection.features.temporalFit,
      projection.features.modalityAgreement,
      projection.features.recurrence,
      projection.features.utility,
      projection.features.sourceAgreement
    ]);
    return clamp01(positive * (1 - projection.features.contradiction));
  })));
}

function graphEdgesForProposal(
  proposal: Pick<CognitiveProposal, "relations">,
  graph: GraphSlice
): GraphEdge[] {
  const ids = new Set(proposal.relations.flatMap(relation => relation.graphEdgeIds));
  return graph.edges.filter(edge => ids.has(String(edge.id)));
}

function proposalInternalContradiction(
  claims: readonly PlannedClaim[],
  relations: readonly PlannedRelation[],
  graph: GraphSlice
): number {
  const duplicateBasis = new Map<string, Set<ClaimBasis>>();
  for (const claim of claims) {
    const normalized = normalizeSurface(claim.text);
    if (!normalized) continue;
    const bases = duplicateBasis.get(normalized) ?? new Set<ClaimBasis>();
    bases.add(claim.basis);
    duplicateBasis.set(normalized, bases);
  }
  const incompatibleBasis = [...duplicateBasis.values()].some(bases => bases.has("direct_evidence") && bases.has("counterfactual")) ? 1 : 0;
  const edgeIds = new Set(relations.flatMap(relation => relation.graphEdgeIds));
  const contradiction = graph.edges
    .filter(edge => edgeIds.has(String(edge.id)))
    .map(edge => projectGraphEdgeRelationPotential(edge, { edges: graph.edges }).features.contradiction);
  return clamp01(Math.max(incompatibleBasis, ...contradiction, 0));
}

function claimHardFailures(claims: readonly PlannedClaim[]): string[] {
  const failures: string[] = [];
  for (const claim of claims) {
    if (!claimBasisIsAdmissible(claim)) failures.push(`claim:${claim.id}:inadmissible_basis`);
    if (claim.basis === "invented" && claim.evidenceIds.length > 0) failures.push(`claim:${claim.id}:invented_source_attribution`);
    if (claim.basis === "action_result" && !claim.actionReceiptId) failures.push(`claim:${claim.id}:missing_action_receipt`);
  }
  return uniqueStrings(failures);
}

function plannedClaim(input: {
  seed: unknown;
  text: string;
  basis: ClaimBasis;
  evidenceIds: EvidenceId[];
  priorIds: string[];
  graphNodeIds: string[];
  graphEdgeIds: string[];
  externallyFactual: boolean;
  hypothetical: boolean;
  actionReceiptId?: string;
  trace: unknown;
}): PlannedClaim {
  return {
    id: stableId("planned_claim", input.seed),
    text: cleanMeaningSurface(input.text),
    basis: input.basis,
    evidenceIds: uniqueEvidenceIds(input.evidenceIds),
    priorIds: uniqueStrings(input.priorIds),
    graphNodeIds: uniqueStrings(input.graphNodeIds),
    graphEdgeIds: uniqueStrings(input.graphEdgeIds),
    externallyFactual: input.externallyFactual,
    hypothetical: input.hypothetical,
    actionReceiptId: input.actionReceiptId,
    trace: toJsonValue(input.trace)
  };
}

function proposalFeatures(proposal: CognitiveProposal | ProposalDraft): Map<string, number> {
  const features = new Map<string, number>();
  const add = (id: string, weight: number) => features.set(id, Math.max(features.get(id) ?? 0, weight));
  for (const claim of proposal.claims) {
    add(`basis:${claim.basis}`, 1.4);
    for (const token of symbolizeData(claim.text).slice(0, 48)) add(`meaning:${token}`, 0.45);
  }
  for (const relation of proposal.relations) add(`relation:${relation.relationId}`, 1.25);
  for (const artifact of proposal.artifacts) add(`artifact:${artifact.kindId}`, 1.2);
  for (const id of proposal.evidenceIds) add(`evidence:${String(id)}`, 0.35);
  for (const id of proposal.graphNodeIds) add(`node:${id}`, 0.55);
  for (const id of proposal.constructIds) add(`construct:${id}`, 0.7);
  for (const operator of proposal.operatorActivations) add(`operator:${String(operator.operatorId)}`, 0.9);
  return features;
}

function inventionSimilarity(left: InventionConstruct, right: InventionConstruct): number {
  const leftFeatures = weightedTextFeatures(left.proposalSurface, left.artifactKindIds, left.basisPriorIds);
  const rightFeatures = weightedTextFeatures(right.proposalSurface, right.artifactKindIds, right.basisPriorIds);
  const ids = new Set([...leftFeatures.keys(), ...rightFeatures.keys()]);
  let intersection = 0;
  let union = 0;
  for (const id of ids) {
    intersection += Math.min(leftFeatures.get(id) ?? 0, rightFeatures.get(id) ?? 0);
    union += Math.max(leftFeatures.get(id) ?? 0, rightFeatures.get(id) ?? 0);
  }
  return union <= Number.EPSILON ? 1 : clamp01(intersection / union);
}

function weightedTextFeatures(text: string, artifactIds: readonly string[], priorIds: readonly string[]): Map<string, number> {
  const features = new Map<string, number>();
  for (const token of symbolizeData(text).slice(0, 96)) features.set(`meaning:${token}`, 0.5);
  for (const id of artifactIds) features.set(`artifact:${id}`, 1.2);
  for (const id of priorIds) features.set(`prior:${id}`, 0.8);
  return features;
}

function nodeSurface(node: GraphNode | undefined): string {
  if (!node) return "";
  const representation = jsonRecord(node.representation);
  const metadata = jsonRecord(node.metadata);
  for (const value of [representation.surface, representation.label, representation.text, representation.name, metadata.surface, metadata.label, metadata.sourceLabel]) {
    const surface = cleanMeaningSurface(textValue(value));
    if (surface) return surface;
  }
  return "";
}

function cleanMeaningSurface(value: string): string {
  const normalized = value.replace(/\u0000/gu, " ").normalize("NFC").replace(/\s+/gu, " ").trim();
  if (!normalized || normalized.startsWith("{") || normalized.startsWith("[") || normalized.includes("\"scores\":")) return "";
  return [...normalized].slice(0, 1200).join("");
}

function repetitionRate(surfaces: readonly string[]): number {
  const tokens = surfaces.flatMap(surface => symbolizeData(surface));
  if (tokens.length === 0) return 0;
  return clamp01(1 - new Set(tokens).size / tokens.length);
}

function edgeUtility(edge: GraphEdge): number {
  return clamp01(Math.max(0, edge.alpha) * Math.max(0, edge.weight));
}

function graphNodesForEvidence(graph: GraphSlice, evidenceId: EvidenceId): string[] {
  return graph.nodes.filter(node => node.evidenceIds.some(id => String(id) === String(evidenceId))).map(node => String(node.id));
}

function uniqueBySource(spans: readonly EvidenceSpan[]): EvidenceSpan[] {
  const seen = new Set<string>();
  return spans.filter(span => {
    const id = String(span.sourceId);
    if (seen.has(id)) return false;
    seen.add(id);
    return true;
  });
}

function uniqueDrafts(drafts: readonly ProposalDraft[]): ProposalDraft[] {
  const seen = new Set<string>();
  return drafts.filter(draft => {
    const key = canonicalStringify(proposalIdentity(draft));
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function proposalIdentity(draft: ProposalDraft): JsonValue {
  return toJsonValue({
    kind: draft.kind,
    family: draft.family ?? draft.kind,
    claims: draft.claims.map(claim => ({ text: normalizeSurface(claim.text), basis: claim.basis, evidenceIds: claim.evidenceIds })),
    relations: draft.relations.map(relation => ({ relationId: relation.relationId, graphEdgeIds: relation.graphEdgeIds })),
    artifacts: draft.artifacts.map(artifact => ({ kindId: artifact.kindId, constructId: artifact.constructId ?? null })),
    constructIds: draft.constructIds
  });
}

function normalizeSurface(text: string): string {
  return symbolizeData(text).join(" ");
}

function nonRelationalBasis(basis: ClaimBasis): boolean {
  return basis === "direct_evidence" || basis === "source_synthesis" || basis === "learned_prior" || basis === "invented" || basis === "conjectured" || basis === "translated" || basis === "action_result";
}

function isDerivedBasis(basis: ClaimBasis): boolean {
  return basis === "source_synthesis"
    || basis === "reasoned_inference"
    || basis === "causal_inference"
    || basis === "temporal_inference"
    || basis === "counterfactual";
}

function pathKey(path: readonly GraphEdge[]): string {
  return path.map(edge => String(edge.id)).join("|");
}

function asEvidenceIds(ids: readonly string[]): EvidenceId[] {
  return uniqueStrings(ids) as EvidenceId[];
}

function uniqueEvidenceIds(ids: readonly EvidenceId[]): EvidenceId[] {
  return uniqueStrings(ids.map(String)) as EvidenceId[];
}

function uniqueStrings(values: readonly string[]): string[] {
  return [...new Set(values.filter(Boolean))].sort();
}

function jsonRecord(value: unknown): Record<string, JsonValue> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, JsonValue> : {};
}

function textValue(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function numberValue(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

function cleanIdentifier(value: unknown): string {
  if (typeof value !== "string") return "";
  const normalized = value.normalize("NFC").trim();
  if (!normalized || normalized.includes("\u0000") || /\s/u.test(normalized)) return "";
  return [...normalized].slice(0, 256).join("");
}

function stableId(prefix: string, value: unknown): string {
  return `${prefix}:${createHasher().digestHex(canonicalStringify(value)).slice(0, 32)}`;
}

function finiteQuality<T extends Record<string, number>>(quality: T): T {
  for (const [key, value] of Object.entries(quality)) if (!Number.isFinite(value)) throw new RangeError(`cognitive proposal quality ${key} must be finite`);
  return quality;
}

function boundedInteger(value: number, min: number, max: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < min || value > max) throw new RangeError(`${label} must be a safe integer in [${min}, ${max}]`);
  return value;
}

function assertPlannerInput(input: CognitivePlannerInput): void {
  if (!input || typeof input !== "object") throw new TypeError("cognitive planner input is required");
  if (!input.requirements || !input.graph || !input.field || !input.construct) throw new TypeError("cognitive planner requires requirements, graph, field, and construct state");
  for (const operator of input.operatorActivations) {
    if (!Number.isFinite(operator.activation) || operator.activation < 0 || operator.activation > 1) throw new RangeError(`operator ${operator.id} activation must be in [0,1]`);
  }
}
