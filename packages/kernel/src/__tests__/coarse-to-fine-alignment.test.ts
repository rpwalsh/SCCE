import { describe, expect, it } from "vitest";
import {
  buildSurfaceLattice,
  alignmentAlternativeSeriesId,
  compileAlignmentAlternativeSet,
  compileAlignmentCommunityRouting,
  compileCoarseToFineAlignmentResult,
  compileSparseAlignmentCandidateSupports,
  createHasher,
  solveSparseFusedUnbalancedTransport,
  type EvidenceId,
  type GraphNode,
  type Hyperedge,
  type NodeId,
  type SourceVersionId
} from "../index.js";

describe("anchored coarse-to-fine alignment", () => {
  const hasher = createHasher();

  it("routes through opaque graph communities and bounds local correction", () => {
    const compiled = compileSparseAlignmentCandidateSupports({
      lattices: [buildSurfaceLattice({
        documentId: "document.coarse",
        sourceFamilyId: "family.coarse",
        sourceVersionId: "source-version.coarse" as SourceVersionId,
        text: "Ada built engine",
        evidenceIds: ["evidence.coarse" as EvidenceId],
        hasher
      })],
      nodes: [
        node("node.coarse.ada", "Ada"),
        node("node.coarse.engine", "engine"),
        node("node.coarse.paris", "Paris"),
        node("node.coarse.france", "France")
      ],
      hyperedges: [
        hyperedge(
          "hyperedge.coarse.engine",
          "relation.coarse.engine",
          [["port.coarse.ada", "node.coarse.ada"], ["port.coarse.engine", "node.coarse.engine"]]
        ),
        hyperedge(
          "hyperedge.coarse.place",
          "relation.coarse.engine",
          [["port.coarse.ada", "node.coarse.paris"], ["port.coarse.engine", "node.coarse.france"]]
        )
      ],
      maxCandidateDegree: 16,
      hasher
    });
    const sourceSupport = compiled.supports[0]!;
    const routing = compileAlignmentCommunityRouting({
      support: sourceSupport,
      targetIndex: compiled.targetIndex,
      maximumCommunitiesPerRow: 1,
      hasher
    });
    const plan = solveSparseFusedUnbalancedTransport({
      support: routing.routedSupport,
      targetIndex: compiled.targetIndex,
      budget: {
        maxOuterIterations: 3,
        maxSinkhornIterations: 32,
        maxConditionalGradientSteps: 3,
        maxConditionalGradientComparisons: 10_000
      },
      hasher
    });
    const alternatives = compileAlignmentAlternativeSet({
      seriesId: alignmentAlternativeSeriesId({
        support: routing.routedSupport,
        targetIndex: compiled.targetIndex,
        hasher
      }),
      plans: [plan],
      hasher
    });
    const result = compileCoarseToFineAlignmentResult({
      routing,
      primaryPlan: plan,
      alternativeSet: alternatives,
      hasher
    });
    const retained = new Set(routing.routedSupport.candidates.map(candidate =>
      candidate.id));
    const exact = sourceSupport.candidates.filter(candidate =>
      candidate.supportKinds.includes("exact_observable_anchor"));

    expect(routing.schema).toBe("scce.alignment_community_routing.v2");
    expect(routing.communities).toHaveLength(3);
    expect(routing.communities.every(community =>
      community.hyperedgeIds.length === 2)).toBe(true);
    expect(routing.routedSupport.parentSupportId).toBe(sourceSupport.id);
    expect(routing.routedSupport.candidates.length)
      .toBeLessThan(sourceSupport.candidates.length);
    expect(exact.every(candidate => retained.has(candidate.id))).toBe(true);
    expect(routing.routes.every(route =>
      route.selectedCommunityIds.length
      <= Math.max(1, route.exactAnchorCommunityIds.length))).toBe(true);
    expect(routing.routes.every(route =>
      Number.isFinite(route.omittedCommunityUpperBound)
      && typeof route.routingRecallCertified === "boolean"
      && route.selectedCommunityUpperBounds.every(bound =>
        Number.isFinite(bound.upperBound)))).toBe(true);
    expect(plan.iterations.every(iteration =>
      iteration.conditionalGradientComparisons >= 0
      && iteration.conditionalGradientComparisons <= 10_000
      && Number.isFinite(iteration.conditionalGradientMassShift)
      && iteration.conditionalGradientMassShift >= 0)).toBe(true);
    expect(plan.audit).toMatchObject({
      conditionalGradientComparisons: expect.any(Number),
      conditionalGradientMassShift: expect.any(Number)
    });
    expect(result.schema).toBe("scce.coarse_to_fine_alignment.v1");
    expect(result.stages).toEqual([
      "exact_anchor_preservation",
      "community_routing",
      "sparse_generalized_sinkhorn",
      "bounded_local_conditional_gradient",
      "retained_k_best"
    ]);
    expect(result.work.conditionalGradientComparisons).toBeGreaterThanOrEqual(0);
    expect(result.globalOptimalityClaimed).toBe(false);
  });
});

function node(id: string, representation: string): GraphNode {
  return {
    id: id as NodeId,
    typeId: "dimension.fixture" as GraphNode["typeId"],
    representation,
    alpha: 1,
    evidenceIds: ["evidence.coarse" as EvidenceId],
    features: [],
    createdAt: 1,
    updatedAt: 1,
    metadata: {}
  };
}

function hyperedge(
  id: string,
  relationId: string,
  participants: readonly (readonly [string, string])[]
): Hyperedge {
  return {
    schema: "scce.hyperedge.v2",
    id: id as Hyperedge["id"],
    relationId: relationId as Hyperedge["relationId"],
    participantPorts: participants.map(([portId, nodeId], index) => ({
      portId,
      roleId: `role.coarse.${index}`,
      nodeId: nodeId as NodeId,
      valueKind: "observable.string",
      realization: "observed",
      evidenceIds: ["evidence.coarse" as EvidenceId]
    })),
    memberNodeIds: participants.map(([, nodeId]) => nodeId as NodeId),
    qualifiers: {},
    modality: {},
    evidenceIds: ["evidence.coarse" as EvidenceId],
    weightVector: { alpha: 1 },
    temporalScope: {},
    provenanceRefs: ["evidence.coarse"],
    createdAt: 1,
    updatedAt: 1
  };
}
