import { canonicalStringify, createHasher, toJsonValue } from "./primitives.js";
import type {
  SparseAlignmentCandidate,
  SparseAlignmentCandidateSupport,
  SparseAlignmentTargetIndex
} from "./sparse-alignment-candidates.js";
import type { Hasher, JsonValue } from "./types.js";
import type { AlignmentAlternativeSet } from "./alignment-alternatives.js";
import type { SparseFusedTransportPlan } from "./sparse-fused-transport.js";

export const ALIGNMENT_COMMUNITY_ROUTING_SCHEMA =
  "scce.alignment_community_routing.v1" as const;
export const COARSE_TO_FINE_ALIGNMENT_SCHEMA =
  "scce.coarse_to_fine_alignment.v1" as const;

export interface AlignmentTargetCommunity {
  id: string;
  hyperedgeId: string;
  relationNodeIds: string[];
  targetIds: string[];
}

export interface AlignmentCommunityRoute {
  surfaceUnitId: string;
  selectedCommunityIds: string[];
  exactAnchorCommunityIds: string[];
  retainedCandidateIds: string[];
  omittedCandidateCount: number;
}

export interface RoutedSparseAlignmentSupport
  extends SparseAlignmentCandidateSupport {
  parentSupportId: string;
  routingId: string;
}

export interface AlignmentCommunityRouting {
  schema: typeof ALIGNMENT_COMMUNITY_ROUTING_SCHEMA;
  id: string;
  parentSupportId: string;
  targetIndexId: string;
  maximumCommunitiesPerRow: number;
  communities: AlignmentTargetCommunity[];
  routes: AlignmentCommunityRoute[];
  routedSupport: RoutedSparseAlignmentSupport;
  audit: JsonValue;
}

export interface CoarseToFineAlignmentResult {
  schema: typeof COARSE_TO_FINE_ALIGNMENT_SCHEMA;
  id: string;
  sourceSupportId: string;
  routedSupportId: string;
  targetIndexId: string;
  routingId: string;
  primaryPlanId: string;
  alternativeSetId: string;
  stages: readonly [
    "exact_anchor_preservation",
    "community_routing",
    "sparse_generalized_sinkhorn",
    "bounded_local_conditional_gradient",
    "retained_k_best"
  ];
  termination: SparseFusedTransportPlan["status"];
  finalObjective: number;
  finalSurfaceMarginalResidual: number;
  finalGraphMarginalResidual: number;
  work: {
    outerIterations: number;
    sinkhornIterations: number;
    structuralComparisons: number;
    orderingComparisons: number;
    conditionalGradientComparisons: number;
    conditionalGradientMassShift: number;
    retainedAlternatives: number;
    omittedAlternativeBranches: number;
  };
  globalOptimalityClaimed: false;
  audit: JsonValue;
}

/**
 * Routes each surface row through relation communities before fine transport.
 * Communities are opaque hyperedge neighborhoods, not named linguistic roles.
 */
export function compileAlignmentCommunityRouting(input: {
  support: SparseAlignmentCandidateSupport;
  targetIndex: SparseAlignmentTargetIndex;
  maximumCommunitiesPerRow?: number;
  hasher?: Hasher;
}): AlignmentCommunityRouting {
  if (input.support.targetIndexId !== input.targetIndex.id) {
    throw new Error("community routing support and target index do not match");
  }
  const hasher = input.hasher ?? createHasher();
  const maximumCommunitiesPerRow = boundedCommunityCount(
    input.maximumCommunitiesPerRow
  );
  const communities = targetCommunities(input.targetIndex, hasher);
  const communityByTargetId = new Map(communities.flatMap(community =>
    community.targetIds.map(targetId => [targetId, community] as const)));
  const candidateById = new Map(input.support.candidates.map(candidate => [
    candidate.id,
    candidate
  ]));
  const routes = input.support.rows.map(row => {
    const candidates = row.candidateIds.flatMap(candidateId => {
      const candidate = candidateById.get(candidateId);
      return candidate ? [candidate] : [];
    });
    const scores = new Map<string, number>();
    const exact = new Set<string>();
    for (const candidate of candidates) {
      const community = communityByTargetId.get(candidate.graphTargetId);
      if (!community) continue;
      scores.set(
        community.id,
        (scores.get(community.id) ?? 0) + routeScore(candidate)
      );
      if (candidate.supportKinds.includes("exact_observable_anchor")) {
        exact.add(community.id);
      }
    }
    const selected = new Set(exact);
    for (const [communityId] of [...scores.entries()].sort((left, right) =>
      right[1] - left[1] || left[0].localeCompare(right[0]))) {
      if (selected.size >= Math.max(maximumCommunitiesPerRow, exact.size)) break;
      selected.add(communityId);
    }
    const retainedCandidateIds = candidates
      .filter(candidate => {
        const community = communityByTargetId.get(candidate.graphTargetId);
        return community ? selected.has(community.id) : false;
      })
      .map(candidate => candidate.id)
      .sort();
    return {
      surfaceUnitId: row.surfaceUnitId,
      selectedCommunityIds: [...selected].sort(),
      exactAnchorCommunityIds: [...exact].sort(),
      retainedCandidateIds,
      omittedCandidateCount:
        row.omittedCandidateCount + candidates.length - retainedCandidateIds.length
    };
  });
  const retainedCandidateIds = new Set(routes.flatMap(route =>
    route.retainedCandidateIds));
  const candidates = input.support.candidates.filter(candidate =>
    retainedCandidateIds.has(candidate.id));
  const rows = input.support.rows.map(row => {
    const route = routes.find(item => item.surfaceUnitId === row.surfaceUnitId)!;
    return {
      surfaceUnitId: row.surfaceUnitId,
      candidateIds: route.retainedCandidateIds,
      omittedCandidateCount: route.omittedCandidateCount
    };
  });
  const routingCanonical = {
    schema: ALIGNMENT_COMMUNITY_ROUTING_SCHEMA,
    parentSupportId: input.support.id,
    targetIndexId: input.targetIndex.id,
    maximumCommunitiesPerRow,
    communities,
    routes
  };
  const routingId = `alignment_routing.${hasher.digestHex(
    canonicalStringify(routingCanonical)
  ).slice(0, 40)}`;
  const supportCanonical = {
    schema: input.support.schema,
    parentSupportId: input.support.id,
    routingId,
    latticeId: input.support.latticeId,
    sourceFamilyId: input.support.sourceFamilyId,
    targetIndexId: input.support.targetIndexId,
    incidenceGraphId: input.support.incidenceGraphId,
    maxCandidateDegree: input.support.maxCandidateDegree,
    populationPosterior: input.support.populationPosterior,
    candidates,
    rows
  };
  const routedSupport: RoutedSparseAlignmentSupport = {
    ...input.support,
    ...supportCanonical,
    id: `alignment_support.routed.${hasher.digestHex(
      canonicalStringify(supportCanonical)
    ).slice(0, 40)}`,
    audit: toJsonValue({
      ...jsonRecord(input.support.audit),
      compiler: "kernel.alignment.community_routing.v1",
      parentSupportId: input.support.id,
      routingId,
      communityCount: communities.length,
      retainedCandidateCount: candidates.length,
      omittedByRouting: input.support.candidates.length - candidates.length,
      exactAnchorsPreserved: input.support.candidates
        .filter(candidate =>
          candidate.supportKinds.includes("exact_observable_anchor"))
        .every(candidate => retainedCandidateIds.has(candidate.id)),
      denseCommunityMatrixMaterialized: false
    })
  };
  return {
    ...routingCanonical,
    id: routingId,
    routedSupport,
    audit: toJsonValue({
      compiler: "kernel.alignment.community_routing.v1",
      communityCount: communities.length,
      rowCount: routes.length,
      retainedCandidateCount: candidates.length,
      omittedCandidateCount: input.support.candidates.length - candidates.length,
      maximumSelectedCommunities: Math.max(
        0,
        ...routes.map(route => route.selectedCommunityIds.length)
      ),
      exactAnchorsPreserved: input.support.candidates
        .filter(candidate =>
          candidate.supportKinds.includes("exact_observable_anchor"))
        .every(candidate => retainedCandidateIds.has(candidate.id)),
      routingMemory: "O(|V_G|+|S|*K_pi)"
    })
  };
}

export function compileCoarseToFineAlignmentResult(input: {
  routing: AlignmentCommunityRouting;
  primaryPlan: SparseFusedTransportPlan;
  alternativeSet: AlignmentAlternativeSet;
  hasher?: Hasher;
}): CoarseToFineAlignmentResult {
  if (input.primaryPlan.supportId !== input.routing.routedSupport.id
    || input.alternativeSet.supportId !== input.routing.routedSupport.id
    || input.primaryPlan.targetIndexId !== input.routing.targetIndexId) {
    throw new Error("coarse-to-fine alignment stages do not share routed support");
  }
  if (!input.alternativeSet.hypotheses.some(hypothesis =>
    hypothesis.plan.id === input.primaryPlan.id)) {
    throw new Error("coarse-to-fine alternatives omit the primary plan");
  }
  const hasher = input.hasher ?? createHasher();
  const final = input.primaryPlan.iterations.at(-1);
  if (!final) throw new Error("coarse-to-fine primary plan has no iteration trace");
  const canonical = {
    schema: COARSE_TO_FINE_ALIGNMENT_SCHEMA,
    sourceSupportId: input.routing.parentSupportId,
    routedSupportId: input.routing.routedSupport.id,
    targetIndexId: input.routing.targetIndexId,
    routingId: input.routing.id,
    primaryPlanId: input.primaryPlan.id,
    alternativeSetId: input.alternativeSet.id,
    stages: [
      "exact_anchor_preservation",
      "community_routing",
      "sparse_generalized_sinkhorn",
      "bounded_local_conditional_gradient",
      "retained_k_best"
    ] as const,
    termination: input.primaryPlan.status,
    finalObjective: final.objective,
    finalSurfaceMarginalResidual: final.surfaceMarginalResidual,
    finalGraphMarginalResidual: final.graphMarginalResidual,
    work: {
      outerIterations: input.primaryPlan.iterations.length,
      sinkhornIterations: input.primaryPlan.iterations.reduce(
        (sum, iteration) => sum + iteration.sinkhornIterations,
        0
      ),
      structuralComparisons: input.primaryPlan.iterations.reduce(
        (sum, iteration) => sum + iteration.structuralComparisons,
        0
      ),
      orderingComparisons: input.primaryPlan.iterations.reduce(
        (sum, iteration) => sum + iteration.orderingComparisons,
        0
      ),
      conditionalGradientComparisons: input.primaryPlan.iterations.reduce(
        (sum, iteration) => sum + iteration.conditionalGradientComparisons,
        0
      ),
      conditionalGradientMassShift: input.primaryPlan.iterations.reduce(
        (sum, iteration) => sum + iteration.conditionalGradientMassShift,
        0
      ),
      retainedAlternatives: input.alternativeSet.hypotheses.length,
      omittedAlternativeBranches: input.alternativeSet.omittedSearchBranchCount
    },
    globalOptimalityClaimed: false as const
  };
  return {
    ...canonical,
    id: `coarse_to_fine_alignment.${hasher.digestHex(
      canonicalStringify(canonical)
    ).slice(0, 40)}`,
    audit: toJsonValue({
      solver: "kernel.coarse_to_fine_alignment.v1",
      exactAnchorsPreserved:
        jsonRecord(input.routing.audit).exactAnchorsPreserved === true,
      objectiveStoppingRecorded: true,
      marginalStoppingRecorded: true,
      workBudgetRecorded: true,
      denseMatrixMaterialized: false,
      globalOptimalityClaimed: false
    })
  };
}

function targetCommunities(
  targetIndex: SparseAlignmentTargetIndex,
  hasher: Hasher
): AlignmentTargetCommunity[] {
  const grouped = new Map<string, typeof targetIndex.targets>();
  for (const target of targetIndex.targets) {
    const values = grouped.get(target.hyperedgeId) ?? [];
    values.push(target);
    grouped.set(target.hyperedgeId, values);
  }
  return [...grouped.entries()].map(([hyperedgeId, targets]) => ({
    id: `alignment_community.${hasher.digestHex(canonicalStringify({
      targetIndexId: targetIndex.id,
      hyperedgeId,
      targetIds: targets.map(target => target.id).sort()
    })).slice(0, 40)}`,
    hyperedgeId,
    relationNodeIds: [...new Set(targets.map(target =>
      String(target.relationNodeId)))].sort(),
    targetIds: targets.map(target => target.id).sort()
  })).sort((left, right) => left.id.localeCompare(right.id));
}

function routeScore(candidate: SparseAlignmentCandidate): number {
  return candidate.score
    + (candidate.supportKinds.includes("exact_observable_anchor") ? 4 : 0)
    + (candidate.supportKinds.includes("shared_exact_evidence") ? 1 : 0)
    + (candidate.supportKinds.includes("typed_incidence_structure") ? 0.25 : 0);
}

function boundedCommunityCount(value: number | undefined): number {
  return Math.max(1, Math.min(32, Math.floor(value ?? 4)));
}

function jsonRecord(value: JsonValue): Record<string, JsonValue> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, JsonValue>
    : {};
}
