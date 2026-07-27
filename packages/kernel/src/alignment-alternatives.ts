import { canonicalStringify, createHasher, toJsonValue } from "./primitives.js";
import type {
  SparseAlignmentCandidateSupport,
  SparseAlignmentTargetIndex
} from "./sparse-alignment-candidates.js";
import {
  solveSparseFusedUnbalancedTransport,
  type SparseFusedTransportPlan,
  type SparseTransportBudget,
  type SparseTransportObjective
} from "./sparse-fused-transport.js";
import type { CrossDocumentAlignmentModel } from "./cross-document-alignment.js";
import type { PopulationOrderingModel } from "./population-ordering.js";
import type { TransportEvidenceAllocation } from "./transport-evidence-allocation.js";
import type { TypedNullCostModel } from "./typed-null-alignment.js";
import type { Hasher, JsonValue } from "./types.js";

export const ALIGNMENT_ALTERNATIVE_SET_SCHEMA =
  "scce.alignment_alternative_set.v1" as const;

export interface AlignmentAlternativeHypothesis {
  rank: number;
  plan: SparseFusedTransportPlan;
  objectiveValue: number;
  restrictedGibbsWeight: number;
  evidenceAllocationId: string | null;
  predecessorPlanIds: string[];
}

export interface AlignmentAlternativeSet {
  schema: typeof ALIGNMENT_ALTERNATIVE_SET_SCHEMA;
  id: string;
  seriesId: string;
  revision: number;
  supportId: string;
  targetIndexId: string;
  temperature: number;
  maximumRetainedAlternatives: number;
  posteriorScope: "retained_candidate_set_only";
  exactGlobalPosteriorClaimed: false;
  predecessorSetIds: string[];
  hypotheses: AlignmentAlternativeHypothesis[];
  omittedSearchBranchCount: number;
  audit: JsonValue;
}

export interface ExtractedAlignmentAlternatives {
  plans: SparseFusedTransportPlan[];
  omittedSearchBranchCount: number;
}

/**
 * Produces a bounded deterministic neighborhood around the current plan. Each
 * branch removes one non-anchor binding from the feasible support and resolves
 * the original objective. Exact observable anchors are never removed.
 */
export function extractAlignmentAlternatives(input: {
  basePlan: SparseFusedTransportPlan;
  support: SparseAlignmentCandidateSupport;
  targetIndex: SparseAlignmentTargetIndex;
  typedNullCostModel: TypedNullCostModel;
  populationOrderingModel: PopulationOrderingModel;
  crossDocumentAlignmentModel?: CrossDocumentAlignmentModel;
  maximumRetainedAlternatives?: number;
  objective?: SparseTransportObjective;
  budget?: Partial<SparseTransportBudget>;
  hasher?: Hasher;
}): ExtractedAlignmentAlternatives {
  if (input.basePlan.supportId !== input.support.id
    || input.basePlan.targetIndexId !== input.targetIndex.id) {
    throw new Error("base alignment plan does not match alternative support");
  }
  const hasher = input.hasher ?? createHasher();
  const maximum = boundedMaximum(input.maximumRetainedAlternatives);
  const candidatesByRow = new Map(input.support.rows.map(row => [
    row.surfaceUnitId,
    new Set(row.candidateIds)
  ]));
  const branchCandidateIds = input.basePlan.cells
    .filter(cell => cell.mass > 0 && !cell.exactAnchor)
    .filter(cell => (candidatesByRow.get(cell.surfaceUnitId)?.size ?? 0) > 1)
    .sort((left, right) =>
      right.mass - left.mass
      || left.surfaceUnitId.localeCompare(right.surfaceUnitId)
      || left.graphTargetId.localeCompare(right.graphTargetId))
    .map(cell => cell.candidateId);
  const plans = [input.basePlan];
  const signatures = new Set([planSignature(input.basePlan, hasher)]);
  for (const candidateId of branchCandidateIds) {
    if (plans.length >= maximum) break;
    const plan = solveSparseFusedUnbalancedTransport({
      support: input.support,
      targetIndex: input.targetIndex,
      typedNullCostModel: input.typedNullCostModel,
      populationOrderingModel: input.populationOrderingModel,
      crossDocumentAlignmentModel: input.crossDocumentAlignmentModel,
      excludedCandidateIds: [candidateId],
      objective: input.objective,
      budget: input.budget,
      hasher
    });
    const signature = planSignature(plan, hasher);
    if (signatures.has(signature)) continue;
    signatures.add(signature);
    plans.push(plan);
  }
  return {
    plans,
    omittedSearchBranchCount: Math.max(0, branchCandidateIds.length - (plans.length - 1))
  };
}

/**
 * Persists immutable retained-set weights. These weights normalize only over K;
 * they are deliberately not represented as a global Bayesian posterior.
 */
export function compileAlignmentAlternativeSet(input: {
  seriesId: string;
  plans: readonly SparseFusedTransportPlan[];
  evidenceAllocations?: readonly TransportEvidenceAllocation[];
  temperature?: number;
  maximumRetainedAlternatives?: number;
  predecessorSets?: readonly AlignmentAlternativeSet[];
  omittedSearchBranchCount?: number;
  hasher?: Hasher;
}): AlignmentAlternativeSet {
  if (!input.plans.length) throw new Error("alignment alternatives require a plan");
  const hasher = input.hasher ?? createHasher();
  const maximum = boundedMaximum(input.maximumRetainedAlternatives);
  const temperature = finiteTemperature(input.temperature);
  const supportId = input.plans[0]!.supportId;
  const targetIndexId = input.plans[0]!.targetIndexId;
  if (input.plans.some(plan =>
    plan.supportId !== supportId || plan.targetIndexId !== targetIndexId)) {
    throw new Error("alignment alternative plans do not share one support");
  }
  const allocationByPlanId = new Map(
    (input.evidenceAllocations ?? []).map(allocation => [
      allocation.transportPlanId,
      allocation
    ])
  );
  const deduplicated = new Map<string, SparseFusedTransportPlan>();
  for (const plan of input.plans) {
    const signature = planSignature(plan, hasher);
    const current = deduplicated.get(signature);
    if (!current || objectiveValue(plan) < objectiveValue(current)) {
      deduplicated.set(signature, plan);
    }
  }
  const retained = [...deduplicated.values()]
    .sort((left, right) =>
      objectiveValue(left) - objectiveValue(right)
      || left.id.localeCompare(right.id))
    .slice(0, maximum);
  const weights = restrictedGibbsWeights(
    retained.map(objectiveValue),
    temperature
  );
  const predecessorSets = [...(input.predecessorSets ?? [])]
    .filter(set => set.seriesId === input.seriesId)
    .sort((left, right) => left.id.localeCompare(right.id));
  const predecessorPlansBySignature = new Map<string, string[]>();
  for (const set of predecessorSets) {
    for (const hypothesis of set.hypotheses) {
      const signature = planSignature(hypothesis.plan, hasher);
      const ids = predecessorPlansBySignature.get(signature) ?? [];
      ids.push(hypothesis.plan.id);
      predecessorPlansBySignature.set(signature, ids);
    }
  }
  const hypotheses = retained.map((plan, index) => ({
    rank: index + 1,
    plan,
    objectiveValue: objectiveValue(plan),
    restrictedGibbsWeight: weights[index]!,
    evidenceAllocationId: allocationByPlanId.get(plan.id)?.id ?? null,
    predecessorPlanIds: [...new Set(
      predecessorPlansBySignature.get(planSignature(plan, hasher)) ?? []
    )].sort()
  }));
  const canonical = {
    schema: ALIGNMENT_ALTERNATIVE_SET_SCHEMA,
    seriesId: input.seriesId,
    revision: Math.max(0, ...predecessorSets.map(set => set.revision)) + 1,
    supportId,
    targetIndexId,
    temperature,
    maximumRetainedAlternatives: maximum,
    posteriorScope: "retained_candidate_set_only" as const,
    exactGlobalPosteriorClaimed: false as const,
    predecessorSetIds: predecessorSets.map(set => set.id),
    hypotheses,
    omittedSearchBranchCount: Math.max(0, Math.floor(
      input.omittedSearchBranchCount ?? Math.max(0, input.plans.length - retained.length)
    ))
  };
  return {
    ...canonical,
    id: `alignment_alternatives.${hasher.digestHex(
      canonicalStringify(canonical)
    ).slice(0, 40)}`,
    audit: toJsonValue({
      compiler: "kernel.alignment_alternatives.restricted_gibbs.v1",
      candidatePlanCount: input.plans.length,
      distinctPlanCount: deduplicated.size,
      retainedPlanCount: hypotheses.length,
      omittedSearchBranchCount: canonical.omittedSearchBranchCount,
      restrictedWeightSum: sum(weights),
      exactGlobalPosteriorClaimed: false,
      posteriorScope: canonical.posteriorScope,
      immutableRevisionLineage: true
    })
  };
}

export function alignmentAlternativeSeriesId(input: {
  support: SparseAlignmentCandidateSupport;
  targetIndex: SparseAlignmentTargetIndex;
  hasher?: Hasher;
}): string {
  const hasher = input.hasher ?? createHasher();
  return `alignment_series.${hasher.digestHex(canonicalStringify({
    sourceFamilyId: input.support.sourceFamilyId,
    graphPortKeys: input.targetIndex.targets
      .map(target => [
        target.hyperedgeId,
        target.relationNodeId,
        target.portId,
        target.roleId,
        target.kind
      ].join("\u001f"))
      .sort()
  })).slice(0, 40)}`;
}

export function alignmentAlternativeSetsFromEventPayloads(
  payloads: readonly JsonValue[],
  seriesId: string
): AlignmentAlternativeSet[] {
  const byId = new Map<string, AlignmentAlternativeSet>();
  for (const payload of payloads) {
    if (!payload || typeof payload !== "object" || Array.isArray(payload)) continue;
    const sets = (payload as Record<string, JsonValue>).alignmentAlternativeSets;
    if (!Array.isArray(sets)) continue;
    for (const value of sets) {
      if (!isPersistedAlternativeSet(value, seriesId)) continue;
      const parsed = value as unknown as AlignmentAlternativeSet;
      byId.set(parsed.id, parsed);
    }
  }
  return [...byId.values()].sort((left, right) =>
    left.revision - right.revision || left.id.localeCompare(right.id));
}

function objectiveValue(plan: SparseFusedTransportPlan): number {
  const value = plan.iterations.at(-1)?.objective;
  if (value === undefined || !Number.isFinite(value)) {
    throw new Error(`alignment plan ${plan.id} has no finite objective`);
  }
  return value;
}

function planSignature(plan: SparseFusedTransportPlan, hasher: Hasher): string {
  return hasher.digestHex(canonicalStringify({
    cells: plan.cells
      .filter(cell => cell.mass > 0)
      .map(cell => ({
        candidateId: cell.candidateId,
        mass: cell.mass
      }))
      .sort((left, right) => left.candidateId.localeCompare(right.candidateId)),
    rows: plan.rowMarginals.map(row => ({
      surfaceUnitId: row.surfaceUnitId,
      surfaceNullMass: row.surfaceNullMass
    })),
    columns: plan.columnMarginals.map(column => ({
      graphTargetId: column.graphTargetId,
      graphImplicitMass: column.graphImplicitMass
    }))
  }));
}

function restrictedGibbsWeights(
  objectives: readonly number[],
  temperature: number
): number[] {
  const logWeights = objectives.map(value => -value / temperature);
  const maximum = Math.max(...logWeights);
  const unnormalized = logWeights.map(value => Math.exp(value - maximum));
  const denominator = sum(unnormalized);
  if (!(denominator > 0) || !Number.isFinite(denominator)) {
    throw new Error("alignment alternative weights cannot be normalized");
  }
  const weights = unnormalized.map(value => value / denominator);
  if (weights.length) {
    weights[weights.length - 1] = 1 - sum(weights.slice(0, -1));
  }
  return weights;
}

function boundedMaximum(value: number | undefined): number {
  const maximum = Math.floor(value ?? 8);
  if (!Number.isFinite(maximum) || maximum < 1 || maximum > 64) {
    throw new Error("maximum retained alignment alternatives must be in [1,64]");
  }
  return maximum;
}

function finiteTemperature(value: number | undefined): number {
  const temperature = value ?? 1;
  if (!Number.isFinite(temperature) || temperature <= 0) {
    throw new Error("alignment alternative temperature must be positive");
  }
  return temperature;
}

function sum(values: readonly number[]): number {
  return values.reduce((total, value) => total + value, 0);
}

function isPersistedAlternativeSet(
  value: JsonValue,
  seriesId: string
): boolean {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const record = value as Record<string, JsonValue>;
  return record.schema === ALIGNMENT_ALTERNATIVE_SET_SCHEMA
    && record.seriesId === seriesId
    && typeof record.id === "string"
    && typeof record.revision === "number"
    && typeof record.supportId === "string"
    && typeof record.targetIndexId === "string"
    && Array.isArray(record.hypotheses)
    && record.posteriorScope === "retained_candidate_set_only"
    && record.exactGlobalPosteriorClaimed === false;
}
