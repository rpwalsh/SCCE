import { describe, expect, it } from "vitest";
import {
  allocateTransportEvidence,
  alignmentAlternativeSeriesId,
  alignmentAlternativeSetsFromEventPayloads,
  buildSurfaceLattice,
  compileAlignmentAlternativeSet,
  compilePopulationOrderingModel,
  compileSparseAlignmentCandidateSupports,
  compileTypedNullCostModel,
  createHasher,
  extractAlignmentAlternatives,
  solveSparseFusedUnbalancedTransport,
  toJsonValue,
  type EvidenceId,
  type GraphNode,
  type Hyperedge,
  type NodeId,
  type SourceVersionId
} from "../index.js";

describe("retained alignment alternatives", () => {
  const hasher = createHasher();

  it("persists bounded restricted Gibbs weights and immutable revision lineage", () => {
    const compiled = fixture();
    const support = compiled.supports[0]!;
    const typedNullCostModel = compileTypedNullCostModel({
      supports: [support],
      targetIndex: compiled.targetIndex,
      hasher
    });
    const populationOrderingModel = compilePopulationOrderingModel({
      supports: [support],
      hasher
    });
    const basePlan = solveSparseFusedUnbalancedTransport({
      support,
      targetIndex: compiled.targetIndex,
      typedNullCostModel,
      populationOrderingModel,
      hasher
    });
    const extracted = extractAlignmentAlternatives({
      basePlan,
      support,
      targetIndex: compiled.targetIndex,
      typedNullCostModel,
      populationOrderingModel,
      maximumRetainedAlternatives: 4,
      hasher
    });
    const allocations = extracted.plans.map(plan =>
      allocateTransportEvidence({ plan, support, hasher }));
    const seriesId = alignmentAlternativeSeriesId({
      support,
      targetIndex: compiled.targetIndex,
      hasher
    });
    const first = compileAlignmentAlternativeSet({
      seriesId,
      plans: extracted.plans,
      evidenceAllocations: allocations,
      maximumRetainedAlternatives: 4,
      temperature: 0.5,
      omittedSearchBranchCount: extracted.omittedSearchBranchCount,
      hasher
    });
    const revised = compileAlignmentAlternativeSet({
      seriesId,
      plans: extracted.plans,
      evidenceAllocations: allocations,
      predecessorSets: [first],
      maximumRetainedAlternatives: 4,
      temperature: 0.5,
      hasher
    });

    expect(extracted.plans.length).toBeGreaterThan(1);
    expect(extracted.plans.length).toBeLessThanOrEqual(4);
    expect(new Set(extracted.plans.map(plan => plan.id)).size).toBe(
      extracted.plans.length
    );
    expect(extracted.plans.slice(1).every(plan =>
      plan.excludedCandidateIds.length === 1)).toBe(true);
    expect(first.schema).toBe("scce.alignment_alternative_set.v1");
    expect(first.posteriorScope).toBe("retained_candidate_set_only");
    expect(first.exactGlobalPosteriorClaimed).toBe(false);
    expect(first.hypotheses).toHaveLength(extracted.plans.length);
    expect(first.hypotheses.reduce(
      (sum, hypothesis) => sum + hypothesis.restrictedGibbsWeight,
      0
    )).toBeCloseTo(1, 14);
    expect(first.hypotheses.every(hypothesis =>
      hypothesis.evidenceAllocationId !== null)).toBe(true);
    expect(first.hypotheses.map(hypothesis => hypothesis.objectiveValue))
      .toEqual([...first.hypotheses]
        .map(hypothesis => hypothesis.objectiveValue)
        .sort((left, right) => left - right));
    expect(revised.id).not.toBe(first.id);
    expect(first.revision).toBe(1);
    expect(revised.revision).toBe(2);
    expect(revised.predecessorSetIds).toEqual([first.id]);
    expect(revised.hypotheses.every(hypothesis =>
      hypothesis.predecessorPlanIds.length === 1)).toBe(true);
    expect(alignmentAlternativeSetsFromEventPayloads([
      toJsonValue({ alignmentAlternativeSets: [first] })
    ], seriesId)).toEqual([first]);
  });

  it("never branches by deleting exact observable anchors", () => {
    const compiled = fixture();
    const support = compiled.supports[0]!;
    const exactCandidateId = support.candidates.find(candidate =>
      candidate.supportKinds.includes("exact_observable_anchor"))!.id;
    expect(() => solveSparseFusedUnbalancedTransport({
      support,
      targetIndex: compiled.targetIndex,
      excludedCandidateIds: [exactCandidateId],
      hasher
    })).toThrow(/cannot be excluded/);
  });

  function fixture() {
    const lattice = buildSurfaceLattice({
      documentId: "document.alternatives",
      sourceFamilyId: "family.alternatives",
      sourceVersionId: "source-version.alternatives" as SourceVersionId,
      text: "Ada built engine",
      evidenceIds: ["evidence.alternatives" as EvidenceId],
      hasher
    });
    return compileSparseAlignmentCandidateSupports({
      lattices: [lattice],
      nodes: [
        node("node.alternatives.ada", "Ada"),
        node("node.alternatives.engine", "engine")
      ],
      hyperedges: [hyperedge()],
      maxCandidateDegree: 8,
      hasher
    });
  }
});

function node(id: string, representation: string): GraphNode {
  return {
    id: id as NodeId,
    typeId: "dimension.fixture" as GraphNode["typeId"],
    representation,
    alpha: 1,
    evidenceIds: ["evidence.alternatives" as EvidenceId],
    features: [],
    createdAt: 1,
    updatedAt: 1,
    metadata: {}
  };
}

function hyperedge(): Hyperedge {
  return {
    schema: "scce.hyperedge.v2",
    id: "hyperedge.alternatives" as Hyperedge["id"],
    relationId: "relation.alternatives" as Hyperedge["relationId"],
    participantPorts: [
      port("port.alternatives.ada", "role.alternatives.1", "node.alternatives.ada"),
      port("port.alternatives.engine", "role.alternatives.2", "node.alternatives.engine")
    ],
    memberNodeIds: [
      "node.alternatives.ada" as NodeId,
      "node.alternatives.engine" as NodeId
    ],
    qualifiers: {},
    modality: {},
    evidenceIds: ["evidence.alternatives" as EvidenceId],
    weightVector: { alpha: 1 },
    temporalScope: {},
    provenanceRefs: ["evidence.alternatives"],
    createdAt: 1,
    updatedAt: 1
  };
}

function port(
  portId: string,
  roleId: string,
  nodeId: string
): Hyperedge["participantPorts"][number] {
  return {
    portId,
    roleId,
    nodeId: nodeId as NodeId,
    valueKind: "observable.string",
    realization: "observed",
    evidenceIds: ["evidence.alternatives" as EvidenceId]
  };
}
