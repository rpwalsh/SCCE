// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
import { summarizeRequestGraphSupport, type RequestGraphSupportSummary } from "./request-authority.js";
import { evidenceSourceFamilyId } from "./source-family.js";
import { calibrated, prodCalibrationIds } from "./calibrations/prod-calibrations.js";
import type { CalibrationKey } from "./calibrations/public-calibrations.js";
import type { IdFactory } from "./ids.js";
import { clamp01, toJsonValue } from "./primitives.js";
import type { EvidenceSpan, FieldState, GraphNode, GraphSlice, JsonValue } from "./types.js";
import { TURN_REQUIREMENT_DIMENSIONS, type TurnRequirementDimension, type TurnRequirementField } from "./turn-requirements.js";

export interface GraphRefinementSeedPrior {
  nodeId: GraphNode["id"];
  weight: number;
  feature?: string;
}
const REFINABLE_DIMENSIONS = ["temporalReasoningDemand", "causalReasoningDemand", "inferentialDepth", "sourceDependence"] as const;
export type GraphRefinementRequirementShifts = Record<typeof REFINABLE_DIMENSIONS[number], number>;
export interface GraphRefinementStructuralContext {
  schema: "scce.graphRefinement.structuralContext.v1";
  support: RequestGraphSupportSummary;
  admittedGraphNodeIds: string[];
  graphEvidenceIds: string[];
  graphSourceFamilyIds: string[];
  activatedNodeIds: string[];
  activatedObjectIds: string[];
  activatedEvidenceIds: string[];
  activatedSourceFamilyIds: string[];
  sharedParticipantNodeIds: string[];
  objectActivation: Array<{ objectId: string; activation: number }>;
  activeMass: number;
  causalMass: number;
  contradictionMass: number;
  logitShifts: GraphRefinementRequirementShifts;
}
export interface GraphRefinementTrace {
  schema: "scce.graphRefinement.trace.v1";
  id: string;
  executed: boolean;
  callbackCount: 0 | 1;
  refinement: "bounded_structural_applicability" | "disabled" | "no_graph" | "already_refined";
  calibration: "uncalibrated_structural_applicability";
  graphObjectIds: string[];
  evidenceIds: string[];
  activeNodeIds: string[];
  seedNodeIds: string[];
  temporalObjectIds: string[];
  requirements: { initial: Record<string, number>; refined: Record<string, number> };
  seedWeights: Array<{ nodeId: string; weight: number }>;
  fieldRefs: JsonValue;
  structuralContext: GraphRefinementStructuralContext;
  normalization: JsonValue;
}
export interface GraphRefinementInput {
  graph: GraphSlice;
  evidence: readonly EvidenceSpan[];
  initialRequirements: TurnRequirementField;
  firstField: FieldState;
  idFactory: IdFactory;
  runSecondPass: (seedPriors: readonly GraphRefinementSeedPrior[]) => FieldState;
  baseSeedPriors?: readonly GraphRefinementSeedPrior[];
  disabled?: boolean;
  noGraph?: boolean;
}
export interface GraphRefinementResult {
  initialRequirements: TurnRequirementField;
  refinedRequirements: TurnRequirementField;
  finalField: FieldState;
  structuralContext: GraphRefinementStructuralContext;
  seedBias: readonly GraphRefinementSeedPrior[];
  trace: GraphRefinementTrace;
}
type RefinementNormalization = ReturnType<typeof refinementNormalization>;

function refinementNormalization() {
  const bounded = (key: CalibrationKey, min: number, max: number) => Math.min(max, Math.max(min, calibrated(key)));
  // Resolve once per turn. Installing overrides is configuration, not evidence of calibration quality.
  return {
    bootstrapProfile: "graph_refinement.bootstrap.v1",
    productionOverrideIds: prodCalibrationIds().filter(key => key.startsWith("graph_refinement.")).sort(),
    maxLogitShift: bounded("graph_refinement.max_logit_shift", 0, 1),
    maxStructuralSeeds: Math.floor(bounded("graph_refinement.max_structural_seeds", 1, 48)),
    maxSeeds: Math.floor(bounded("graph_refinement.max_seeds", 1, 48)),
    sourceDiversityScale: bounded("graph_refinement.source_diversity_scale", 1, 8),
    seedWeights: {
      active: bounded("graph_refinement.seed_weight.active", 0, 1),
      temporal: bounded("graph_refinement.seed_weight.temporal", 0, 1),
      causal: bounded("graph_refinement.seed_weight.causal", 0, 1),
      composition: bounded("graph_refinement.seed_weight.composition", 0, 1),
      sourceDiversity: bounded("graph_refinement.seed_weight.source_diversity", 0, 1)
    }
  };
}

/** One refinement between two caller-owned activations of the existing field engine. */
export function runGraphRefinement(input: GraphRefinementInput): GraphRefinementResult {
  const normalization = refinementNormalization();
  const support = summarizeRequestGraphSupport(input.graph, input.evidence);
  const structuralContext = structuralContextFor(input.graph, input.evidence, input.firstField, support, normalization);
  const alreadyRefined = hasGraphRefinement(input.initialRequirements.trace);
  const executable = input.disabled !== true && input.noGraph !== true && !alreadyRefined;
  const refinedRequirements = executable ? refineRequirements(input.initialRequirements, structuralContext, normalization) : input.initialRequirements;
  const seedBias = executable ? structuralSeedPriors(input, structuralContext, refinedRequirements, normalization) : [];
  const finalField = executable ? input.runSecondPass(seedBias) : input.firstField;
  const payload: Omit<GraphRefinementTrace, "id"> = {
    schema: "scce.graphRefinement.trace.v1", executed: executable, callbackCount: executable ? 1 : 0,
    refinement: input.disabled === true ? "disabled" : input.noGraph === true ? "no_graph" : alreadyRefined ? "already_refined" : "bounded_structural_applicability",
    calibration: "uncalibrated_structural_applicability",
    graphObjectIds: support.graphObjectIds, evidenceIds: structuralContext.activatedEvidenceIds,
    activeNodeIds: structuralContext.activatedNodeIds, seedNodeIds: seedBias.map(seed => String(seed.nodeId)),
    temporalObjectIds: support.temporalObjectIds,
    requirements: { initial: dimensionValues(input.initialRequirements), refined: dimensionValues(refinedRequirements) },
    seedWeights: seedBias.map(seed => ({ nodeId: String(seed.nodeId), weight: seed.weight })),
    fieldRefs: { first: fieldReference(input.firstField), final: fieldReference(finalField) },
    structuralContext, normalization
  };
  // Bind inputs, guards, execution reason and outcomes with the existing factory.
  const trace = { ...payload, id: String(input.idFactory.artifactId(toJsonValue({
    ...payload, requirementConstraints: { required: input.initialRequirements.requiredFeatures,
      prohibited: input.initialRequirements.prohibitedFeatures, bounds: input.initialRequirements.learnedRequirementBounds ?? {} }
  }))) };
  return { initialRequirements: input.initialRequirements, refinedRequirements, finalField, structuralContext, seedBias, trace };
}

function structuralContextFor(graph: GraphSlice, evidence: readonly EvidenceSpan[], field: FieldState, support: RequestGraphSupportSummary, normalization: RefinementNormalization): GraphRefinementStructuralContext {
  const present = new Set(graph.nodes.map(node => String(node.id)));
  const admittedGraphNodeIds = [...new Set(support.objects.flatMap(object => object.memberNodeIds).filter(id => present.has(id)))].sort();
  const active = new Map(field.active.map(row => [String(row.nodeId), finiteUnit(row.activation)]));
  const causal = new Map(field.causalMass.map(row => [String(row.nodeId), finiteUnit(row.mass)]));
  const contradiction = new Map((field.contradictionMass ?? []).map(row => [String(row.nodeId), finiteUnit(row.mass)]));
  const activatedNodeIds = admittedGraphNodeIds.filter(id => (active.get(id) ?? 0) > 0);
  const objectActivation = support.objects.map(object => ({ objectId: object.id,
    activation: Math.max(0, ...object.memberNodeIds.filter(id => present.has(id)).map(id => active.get(id) ?? 0)) }));
  const activationByObject = new Map(objectActivation.map(row => [row.objectId, row.activation]));
  const activatedObjects = support.objects.filter(object => (activationByObject.get(object.id) ?? 0) > 0);
  const activatedEvidenceIds = [...new Set(activatedObjects.flatMap(object => object.evidenceIds))].sort();
  const activeEvidence = new Set(activatedEvidenceIds);
  const activatedSourceFamilyIds = [...new Set(evidence.filter(span => activeEvidence.has(String(span.id))).map(evidenceSourceFamilyId))].sort();
  const composition = new Set(support.compositionObjectIds);
  const byMember = new Map<string, Set<string>>();
  for (const object of activatedObjects.filter(object => composition.has(object.id))) {
    const signature = JSON.stringify(object.memberNodeIds);
    for (const id of object.memberNodeIds) {
      const signatures = byMember.get(id) ?? new Set<string>();
      signatures.add(signature);
      byMember.set(id, signatures);
    }
  }
  const sharedParticipantNodeIds = [...byMember].filter(([id, signatures]) => present.has(id) && signatures.size > 1).map(([id]) => id).sort();
  const activeMass = mean(activatedNodeIds.map(id => active.get(id) ?? 0));
  const causalMass = mean(activatedNodeIds.map(id => (active.get(id) ?? 0) * (causal.get(id) ?? 0)));
  const contradictionMass = mean(activatedNodeIds.map(id => (active.get(id) ?? 0) * (contradiction.get(id) ?? 0)));
  const temporalMass = Math.max(0, ...support.temporalObjectIds.map(id => activationByObject.get(id) ?? 0));
  const compositionMass = Math.max(0, ...sharedParticipantNodeIds.map(id => active.get(id) ?? 0));
  const diversity = finiteUnit((activatedSourceFamilyIds.length - 1) / normalization.sourceDiversityScale) * activeMass;
  return {
    schema: "scce.graphRefinement.structuralContext.v1", support, admittedGraphNodeIds,
    graphEvidenceIds: support.graphEvidenceIds, graphSourceFamilyIds: support.graphSourceFamilyIds,
    activatedNodeIds, activatedObjectIds: activatedObjects.map(object => object.id), activatedEvidenceIds,
    activatedSourceFamilyIds, sharedParticipantNodeIds, objectActivation, activeMass, causalMass, contradictionMass,
    logitShifts: { temporalReasoningDemand: temporalMass, causalReasoningDemand: causalMass,
      inferentialDepth: Math.max(compositionMass, causalMass), sourceDependence: Math.max(diversity, contradictionMass) }
  };
}

function refineRequirements(initial: TurnRequirementField, context: GraphRefinementStructuralContext, normalization: RefinementNormalization): TurnRequirementField {
  const protectedDimensions = new Set([
    ...initial.requiredFeatures.filter(row => row.status === "explicit").map(row => row.dimension),
    ...initial.prohibitedFeatures.map(row => row.dimension)
  ]);
  const refined = { ...initial };
  const contributed = new Set(initial.contributedDimensions ?? []);
  for (const dimension of REFINABLE_DIMENSIONS) {
    if (protectedDimensions.has(dimension) || context.logitShifts[dimension] === 0) continue;
    let value = shiftLogit(initial[dimension], context.logitShifts[dimension], normalization.maxLogitShift);
    const bounds = initial.learnedRequirementBounds?.[dimension];
    if (bounds) {
      // An invalid range or already out-of-range field cannot authorize a rewrite.
      if (!Number.isFinite(bounds.lower) || !Number.isFinite(bounds.upper) || bounds.lower > bounds.upper
        || initial[dimension] < bounds.lower || initial[dimension] > bounds.upper) continue;
      value = Math.min(bounds.upper, Math.max(bounds.lower, value));
    }
    refined[dimension] = value;
    if (value !== initial[dimension]) contributed.add(dimension);
  }
  refined.contributedDimensions = [...contributed];
  refined.trace = toJsonValue({ previous: initial.trace, graphRefinement: {
    schema: "scce.graphRefinement.refinement.v1", calibration: "uncalibrated_structural_applicability",
    maxLogitShift: normalization.maxLogitShift, graphObjectIds: context.activatedObjectIds,
    evidenceIds: context.activatedEvidenceIds, activeNodeIds: context.activatedNodeIds,
    logitShifts: context.logitShifts, initial: dimensionValues(initial), refined: dimensionValues(refined)
  } });
  return refined;
}

function structuralSeedPriors(input: GraphRefinementInput, context: GraphRefinementStructuralContext, requirements: TurnRequirementField, normalization: RefinementNormalization): GraphRefinementSeedPrior[] {
  const present = new Set(input.graph.nodes.map(node => String(node.id)));
  const active = new Map(input.firstField.active.map(row => [String(row.nodeId), finiteUnit(row.activation)]));
  const causal = new Map(input.firstField.causalMass.map(row => [String(row.nodeId), finiteUnit(row.mass)]));
  const temporalObjects = new Set(context.support.temporalObjectIds);
  const compositionObjects = new Set(context.support.compositionObjectIds);
  const objectActivation = new Map(context.objectActivation.map(row => [row.objectId, row.activation]));
  const temporal = new Map<string, number>();
  const composition = new Map<string, number>();
  for (const object of context.support.objects) {
    for (const id of object.memberNodeIds) {
      const activation = objectActivation.get(object.id) ?? 0;
      if (temporalObjects.has(object.id)) temporal.set(id, Math.max(temporal.get(id) ?? 0, activation));
      if (compositionObjects.has(object.id) && context.sharedParticipantNodeIds.length > 0) composition.set(id, Math.max(composition.get(id) ?? 0, activation));
    }
  }
  const merged = new Map<string, GraphRefinementSeedPrior>();
  // Retain caller seeds on actual graph nodes; a prior does not confer evidence or proof.
  for (const seed of input.baseSeedPriors ?? []) {
    const id = String(seed.nodeId);
    if (!present.has(id) || finiteUnit(seed.weight) === 0) continue;
    if ((merged.get(id)?.weight ?? 0) < seed.weight) merged.set(id, { ...seed, weight: finiteUnit(seed.weight) });
  }
  const w = normalization.seedWeights;
  const structural = context.admittedGraphNodeIds.map(id => {
    const activation = active.get(id) ?? 0;
    // Conflict raises source scrutiny in the requirements; it must not suppress
    // the conflicting nodes that proof and counterexample selection need to inspect.
    const weight = finiteUnit(activation * w.active
      + (temporal.get(id) ?? 0) * requirements.temporalReasoningDemand * w.temporal
      + activation * (causal.get(id) ?? 0) * requirements.causalReasoningDemand * w.causal
      + (composition.get(id) ?? 0) * requirements.inferentialDepth * w.composition
      + activation * context.logitShifts.sourceDependence * requirements.sourceDependence * w.sourceDiversity);
    return { nodeId: id as GraphNode["id"], weight, feature: "graph-refinement.structural" };
  }).filter(seed => seed.weight > 0).sort(compareSeeds).slice(0, normalization.maxStructuralSeeds);
  for (const seed of structural) {
    const existing = merged.get(String(seed.nodeId));
    merged.set(String(seed.nodeId), { ...seed, weight: existing ? finiteUnit(existing.weight + (1 - existing.weight) * seed.weight) : seed.weight });
  }
  return [...merged.values()].sort(compareSeeds).slice(0, normalization.maxSeeds);
}

function compareSeeds(a: GraphRefinementSeedPrior, b: GraphRefinementSeedPrior): number {
  return b.weight - a.weight || (a.nodeId < b.nodeId ? -1 : a.nodeId > b.nodeId ? 1 : 0);
}
function finiteUnit(value: number): number { return Number.isFinite(value) ? clamp01(value) : 0; }
function mean(values: number[]): number { return values.length ? finiteUnit(values.reduce((sum, value) => sum + value, 0) / values.length) : 0; }
function shiftLogit(value: number, shift: number, maxLogitShift: number): number {
  if (value <= 0 || value >= 1 || shift === 0 || maxLogitShift === 0) return value;
  return clamp01(1 / (1 + Math.exp(-(Math.log(value / (1 - value)) + Math.min(maxLogitShift, finiteUnit(shift))))));
}
function dimensionValues(field: TurnRequirementField): Record<TurnRequirementDimension, number> {
  return Object.fromEntries(TURN_REQUIREMENT_DIMENSIONS.map(dimension => [dimension, field[dimension]])) as Record<TurnRequirementDimension, number>;
}
function fieldReference(field: FieldState): JsonValue {
  return toJsonValue({ active: field.active, seeds: field.seeds, causalMass: field.causalMass, contradictionMass: field.contradictionMass ?? [] });
}
function hasGraphRefinement(trace: JsonValue): boolean {
  if (!trace || typeof trace !== "object" || Array.isArray(trace)) return false;
  const marker = trace.graphRefinement;
  return !!marker && typeof marker === "object" && !Array.isArray(marker) && marker.schema === "scce.graphRefinement.refinement.v1";
}
