// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
import { describe, expect, it, vi } from "vitest";
const transportMockState = vi.hoisted(() => ({
  calls: 0,
  override: null as ((input: unknown) => unknown) | null
}));
vi.mock("../sparse-fused-transport.js", async () => {
  const actual = await vi.importActual<typeof import("../sparse-fused-transport.js")>(
    "../sparse-fused-transport.js"
  );
  return {
    ...actual,
    solveSparseFusedUnbalancedTransport: (input: Parameters<typeof actual.solveSparseFusedUnbalancedTransport>[0]) => {
      transportMockState.calls += 1;
      return transportMockState.override
        ? transportMockState.override(input) as ReturnType<typeof actual.solveSparseFusedUnbalancedTransport>
        : actual.solveSparseFusedUnbalancedTransport(input);
    }
  };
});
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
import { sparseAlignmentCandidatesForUnit } from "../sparse-alignment-candidates.js";

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
      attemptedBranchCount: extracted.attemptedBranchCount,
      totalBranchCount: extracted.totalBranchCount,
      branchSearchBudget: extracted.branchSearchBudget,
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
    expect(first.attemptedBranchCount).toBe(extracted.attemptedBranchCount);
    expect(first.totalBranchCount).toBe(extracted.totalBranchCount);
    expect(first.branchSearchBudget).toBe(extracted.branchSearchBudget);
    expect(() => compileAlignmentAlternativeSet({
      seriesId,
      plans: extracted.plans,
      attemptedBranchCount: extracted.attemptedBranchCount,
      totalBranchCount: extracted.totalBranchCount,
      branchSearchBudget: extracted.branchSearchBudget,
      omittedSearchBranchCount: extracted.omittedSearchBranchCount + 1,
      hasher
    })).toThrow(/contradicts branch-search metadata/);
    const legacyCounts = compileAlignmentAlternativeSet({
      seriesId,
      plans: extracted.plans,
      omittedSearchBranchCount: 12,
      hasher
    });
    expect(legacyCounts.omittedSearchBranchCount).toBe(12);
    expect(legacyCounts.attemptedBranchCount).toBeUndefined();
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

  it("preserves set output for repeated plan references and detached equivalents", () => {
    const compiled = fixture();
    const support = compiled.supports[0]!;
    const basePlan = solveSparseFusedUnbalancedTransport({
      support,
      targetIndex: compiled.targetIndex,
      hasher
    });
    const seriesId = alignmentAlternativeSeriesId({
      support,
      targetIndex: compiled.targetIndex,
      hasher
    });
    const sharedReference = compileAlignmentAlternativeSet({
      seriesId,
      plans: [basePlan, basePlan],
      maximumRetainedAlternatives: 2,
      hasher
    });
    const detached = structuredClone(basePlan);
    const detachedEquivalent = compileAlignmentAlternativeSet({
      seriesId,
      plans: [detached, structuredClone(detached)],
      maximumRetainedAlternatives: 2,
      hasher
    });

    expect(detachedEquivalent).toEqual(sharedReference);
  });

  it("accounts every unattempted branch when the explicit search budget is zero", () => {
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
      maxBranchSearches: 0,
      hasher
    });

    expect(extracted.plans).toHaveLength(1);
    expect(extracted.totalBranchCount).toBeGreaterThan(0);
    expect(extracted.attemptedBranchCount).toBe(0);
    expect(extracted.branchSearchBudget).toBe(0);
    expect(extracted.omittedSearchBranchCount).toBe(extracted.totalBranchCount);
    expect(() => extractAlignmentAlternatives({
      basePlan,
      support,
      targetIndex: compiled.targetIndex,
      typedNullCostModel,
      populationOrderingModel,
      maxBranchSearches: 1.5,
      hasher
    })).toThrow(/finite nonnegative integer/);
  });

  it("does not call beyond the branch budget and records duplicate outcomes as attempted", () => {
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
      maximumRetainedAlternatives: 64,
      maxBranchSearches: 2,
      hasher
    });

    expect(extracted.attemptedBranchCount).toBeLessThanOrEqual(2);
    expect(extracted.omittedSearchBranchCount).toBe(
      extracted.totalBranchCount - extracted.attemptedBranchCount
    );
    expect(extracted.attemptedBranchCount).toBeGreaterThanOrEqual(
      extracted.plans.length - 1
    );
    transportMockState.calls = 0;
    transportMockState.override = () => basePlan;
    let duplicateOutcomes: ReturnType<typeof extractAlignmentAlternatives> | undefined;
    try {
      duplicateOutcomes = extractAlignmentAlternatives({
        basePlan,
        support,
        targetIndex: compiled.targetIndex,
        typedNullCostModel,
        populationOrderingModel,
        maximumRetainedAlternatives: 64,
        maxBranchSearches: 2,
        hasher
      });
    } finally {
      transportMockState.override = null;
    }
    expect(transportMockState.calls).toBe(2);
    expect(duplicateOutcomes).toBeDefined();
    if (!duplicateOutcomes) return;
    expect(duplicateOutcomes.plans).toHaveLength(1);
    expect(duplicateOutcomes.attemptedBranchCount).toBe(2);
    expect(duplicateOutcomes.omittedSearchBranchCount).toBe(
      duplicateOutcomes.totalBranchCount - 2
    );
  });

  it("finds a later distinct alternative when the branch budget is widened", () => {
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
    const narrow = extractAlignmentAlternatives({
      basePlan,
      support,
      targetIndex: compiled.targetIndex,
      typedNullCostModel,
      populationOrderingModel,
      maximumRetainedAlternatives: 64,
      maxBranchSearches: 1,
      hasher
    });
    const wide = extractAlignmentAlternatives({
      basePlan,
      support,
      targetIndex: compiled.targetIndex,
      typedNullCostModel,
      populationOrderingModel,
      maximumRetainedAlternatives: 64,
      maxBranchSearches: 64,
      hasher
    });

    expect(narrow.attemptedBranchCount).toBeLessThanOrEqual(1);
    expect(wide.attemptedBranchCount).toBeGreaterThanOrEqual(narrow.attemptedBranchCount);
    expect(wide.attemptedBranchCount).toBeGreaterThan(narrow.attemptedBranchCount);
    expect(wide.omittedSearchBranchCount).toBe(0);
    expect(wide.plans.length).toBeGreaterThanOrEqual(narrow.plans.length);
    expect(wide.plans.length).toBeGreaterThan(1);
  });

  it("preserves branch eligibility for duplicate and missing candidate ids", () => {
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
    const cell = basePlan.cells.find(item => item.mass > 0 && !item.exactAnchor);
    expect(cell).toBeDefined();
    if (!cell) return;
    const row = support.rows.find(item => item.surfaceUnitId === cell.surfaceUnitId);
    const candidate = support.candidates.find(item => item.id === cell.candidateId);
    expect(row).toBeDefined();
    expect(candidate).toBeDefined();
    if (!row || !candidate) return;
    const focusedPlan = { ...basePlan, cells: [cell] };
    const missingId = `${cell.candidateId}.missing`;
    const mutateRow = (candidateIds: string[]) => support.rows.map(item =>
      item.surfaceUnitId === row.surfaceUnitId ? { ...item, candidateIds } : item);
    const duplicateSupport = {
      ...support,
      candidates: [...support.candidates, { ...candidate }],
      rows: mutateRow([cell.candidateId, cell.candidateId, missingId])
    };
    const missingOnlySupport = {
      ...support,
      rows: mutateRow([cell.candidateId, missingId])
    };
    expect(sparseAlignmentCandidatesForUnit(duplicateSupport, cell.surfaceUnitId))
      .toHaveLength(2);
    expect(sparseAlignmentCandidatesForUnit(missingOnlySupport, cell.surfaceUnitId))
      .toHaveLength(1);
    transportMockState.override = () => basePlan;
    try {
      const duplicateResult = extractAlignmentAlternatives({
        basePlan: focusedPlan,
        support: duplicateSupport,
        targetIndex: compiled.targetIndex,
        typedNullCostModel,
        populationOrderingModel,
        maxBranchSearches: 1,
        hasher
      });
      expect(duplicateResult.attemptedBranchCount).toBe(1);
      const missingResult = extractAlignmentAlternatives({
        basePlan: focusedPlan,
        support: missingOnlySupport,
        targetIndex: compiled.targetIndex,
        typedNullCostModel,
        populationOrderingModel,
        maxBranchSearches: 1,
        hasher
      });
      expect(missingResult.totalBranchCount).toBe(0);
    } finally {
      transportMockState.override = null;
    }
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
