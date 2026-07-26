import { canonicalStringify, createHasher, toJsonValue } from "./primitives.js";
import type {
  SparseAlignmentCandidate,
  SparseAlignmentCandidateSupport,
  SparseAlignmentTarget,
  SparseAlignmentTargetIndex
} from "./sparse-alignment-candidates.js";
import type { Hasher, JsonValue } from "./types.js";

export const TYPED_NULL_COST_MODEL_SCHEMA =
  "scce.typed_null_alignment_cost_model.v1" as const;

export type SurfaceNullType =
  | "unsupported_surface"
  | "supported_surface"
  | "exactly_anchored_surface";

export type GraphImplicitType =
  | "omitted_participant"
  | "unexpressed_relation"
  | "unexpressed_observed_participant";

export interface TypedNullCostEstimate<T extends string> {
  type: T;
  nullObservations: number;
  alignedObservations: number;
  posteriorNullProbability: number;
  unmatchedCost: number;
  matchedCost: number;
}

export interface TypedNullCostModel {
  schema: typeof TYPED_NULL_COST_MODEL_SCHEMA;
  id: string;
  targetIndexId: string;
  trainingSupportIds: string[];
  supervision: "source_exact_support";
  calibrated: false;
  surface: Array<TypedNullCostEstimate<SurfaceNullType>>;
  graph: Array<TypedNullCostEstimate<GraphImplicitType>>;
  audit: JsonValue;
}

export function compileTypedNullCostModel(input: {
  supports: readonly SparseAlignmentCandidateSupport[];
  targetIndex: SparseAlignmentTargetIndex;
  hasher?: Hasher;
}): TypedNullCostModel {
  const hasher = input.hasher ?? createHasher();
  const surfaceCounts = initializeCounts<SurfaceNullType>([
    "unsupported_surface",
    "supported_surface",
    "exactly_anchored_surface"
  ]);
  const graphCounts = initializeCounts<GraphImplicitType>([
    "omitted_participant",
    "unexpressed_relation",
    "unexpressed_observed_participant"
  ]);

  for (const support of input.supports) {
    if (support.targetIndexId !== input.targetIndex.id) {
      throw new Error("typed null model received support from a different target index");
    }
    const candidateById = new Map(support.candidates.map(candidate => [
      candidate.id,
      candidate
    ]));
    for (const row of support.rows) {
      const candidates = row.candidateIds.flatMap(candidateId => {
        const candidate = candidateById.get(candidateId);
        return candidate ? [candidate] : [];
      });
      const type = classifySurfaceNullType(candidates);
      if (!candidates.length) {
        surfaceCounts.get(type)!.null++;
      } else if (candidates.some(isExactEvidenceCandidate)) {
        surfaceCounts.get(type)!.aligned++;
      } else {
        // Structure/context-only support is an abstaining surface observation.
        // It contributes equally to both outcomes instead of becoming a label.
        surfaceCounts.get(type)!.null += 0.5;
        surfaceCounts.get(type)!.aligned += 0.5;
      }
    }

    const candidatesByTarget = new Map<string, SparseAlignmentCandidate[]>();
    for (const candidate of support.candidates) {
      const existing = candidatesByTarget.get(candidate.graphTargetId) ?? [];
      existing.push(candidate);
      candidatesByTarget.set(candidate.graphTargetId, existing);
    }
    for (const target of input.targetIndex.targets) {
      const type = classifyGraphImplicitType(target);
      const candidates = candidatesByTarget.get(target.id) ?? [];
      if (target.realization === "omitted") {
        graphCounts.get(type)!.null++;
      } else if (candidates.some(isExactEvidenceCandidate)) {
        graphCounts.get(type)!.aligned++;
      } else if (!candidates.length) {
        graphCounts.get(type)!.null++;
      } else {
        graphCounts.get(type)!.null += 0.5;
        graphCounts.get(type)!.aligned += 0.5;
      }
    }
  }

  const surface = compileEstimates(surfaceCounts);
  const graph = compileEstimates(graphCounts);
  const trainingSupportIds = [...new Set(input.supports.map(support => support.id))].sort();
  const canonical = {
    schema: TYPED_NULL_COST_MODEL_SCHEMA,
    targetIndexId: input.targetIndex.id,
    trainingSupportIds,
    supervision: "source_exact_support" as const,
    calibrated: false as const,
    surface,
    graph
  };
  return {
    ...canonical,
    id: `typed_null_cost.${hasher.digestHex(canonicalStringify(canonical)).slice(0, 40)}`,
    audit: toJsonValue({
      compiler: "kernel.typed_null_alignment.beta_bernoulli.v1",
      prior: { alpha: 1, beta: 1 },
      languageLabelsUsed: false,
      traditionalGrammarLabelsUsed: false,
      exactEvidenceIsSupervisionNotCalibration: true,
      trainingSupportCount: trainingSupportIds.length,
      calibratedConfidenceClaimed: false
    })
  };
}

export function classifySurfaceNullType(
  candidates: readonly SparseAlignmentCandidate[]
): SurfaceNullType {
  if (!candidates.length) return "unsupported_surface";
  return candidates.some(candidate =>
    candidate.supportKinds.includes("exact_observable_anchor"))
    ? "exactly_anchored_surface"
    : "supported_surface";
}

export function classifyGraphImplicitType(
  target: SparseAlignmentTarget
): GraphImplicitType {
  if (target.kind === "incidence" && target.realization === "omitted") {
    return "omitted_participant";
  }
  return target.kind === "relation"
    ? "unexpressed_relation"
    : "unexpressed_observed_participant";
}

export function surfaceNullEstimate(
  model: TypedNullCostModel,
  type: SurfaceNullType
): TypedNullCostEstimate<SurfaceNullType> {
  const estimate = model.surface.find(item => item.type === type);
  if (!estimate) throw new Error(`typed null model is missing surface type ${type}`);
  return estimate;
}

export function graphImplicitEstimate(
  model: TypedNullCostModel,
  type: GraphImplicitType
): TypedNullCostEstimate<GraphImplicitType> {
  const estimate = model.graph.find(item => item.type === type);
  if (!estimate) throw new Error(`typed null model is missing graph type ${type}`);
  return estimate;
}

function isExactEvidenceCandidate(candidate: SparseAlignmentCandidate): boolean {
  return candidate.supportKinds.includes("exact_observable_anchor");
}

function initializeCounts<T extends string>(
  types: readonly T[]
): Map<T, { null: number; aligned: number }> {
  return new Map(types.map(type => [type, { null: 0, aligned: 0 }]));
}

function compileEstimates<T extends string>(
  counts: ReadonlyMap<T, { null: number; aligned: number }>
): Array<TypedNullCostEstimate<T>> {
  return [...counts].map(([type, count]) => {
    const posteriorNullProbability = (count.null + 1)
      / (count.null + count.aligned + 2);
    return {
      type,
      nullObservations: quantize(count.null),
      alignedObservations: quantize(count.aligned),
      posteriorNullProbability: quantize(posteriorNullProbability),
      unmatchedCost: quantize(-Math.log(Math.max(1e-12, posteriorNullProbability))),
      matchedCost: quantize(-Math.log(Math.max(
        1e-12,
        1 - posteriorNullProbability
      )))
    };
  }).sort((left, right) => left.type.localeCompare(right.type));
}

function quantize(value: number): number {
  return Math.round(value * 1_000_000_000_000) / 1_000_000_000_000;
}
