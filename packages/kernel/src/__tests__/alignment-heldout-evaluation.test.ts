import { describe, expect, it } from "vitest";
import {
  compileAlignmentPromotionModel,
  compileAutomaticAlignmentEvaluation,
  type AlignmentAlternativeSet,
  type SparseAlignmentCandidateSupport,
  type SparseAlignmentTargetIndex,
  type SparseFusedTransportPlan,
  type TransportEvidenceAllocation
} from "../index.js";

describe("automatic source-family held-out alignment evaluation", () => {
  it("measures candidate recall before recovery and graduates only complete plans", () => {
    const supports = [
      support("support.a", "family.a", ["target.1", "target.2"]),
      support("support.b", "family.b", ["target.1", "target.2"]),
      support("support.c", "family.c", ["target.1", "target.2"])
    ];
    const plans = supports.map((row, index) =>
      plan(`plan.${index + 1}`, row, ["target.1", "target.2"]));
    const sets = plans.map((row, index) =>
      alternativeSet(`series.${index + 1}`, row));
    const evaluation = compileAutomaticAlignmentEvaluation({
      alternativeSets: sets,
      supports,
      referencePlans: plans,
      evidenceAllocations: plans.map(allocation),
      targetIndex: targetIndex()
    });

    expect(evaluation.artifacts).toHaveLength(3);
    expect(evaluation.candidateRecall).toMatchObject({
      evaluatedPlanCount: 3,
      heldoutFamilyEvaluations: 6,
      minimum: 1,
      perfectCount: 6
    });
    expect(evaluation.artifacts.every(artifact =>
      artifact.heldout.every(row =>
        row.finalRecall <= row.candidateRecall))).toBe(true);
    const promotion = compileAlignmentPromotionModel({
      alternativeSets: sets,
      observations: evaluation.promotionObservations
    });
    expect(promotion.decisions.every(row => row.promoted)).toBe(true);
    expect(evaluation.artifacts[0]!.audit).toMatchObject({
      contentAddressedPlanBinding: true,
      contentAddressedEvidenceAllocationBinding: true,
      candidateRecallMeasuredBeforeTransport: true
    });
  });

  it("exposes a candidate generator miss as a hard recovery ceiling", () => {
    const complete = support("support.a", "family.a", ["target.1", "target.2"]);
    const missing = support("support.b", "family.b", ["target.1"]);
    const third = support("support.c", "family.c", ["target.1", "target.2"]);
    const supports = [complete, missing, third];
    const plans = [
      plan("plan.a", complete, ["target.1", "target.2"]),
      plan("plan.b", missing, ["target.1"]),
      plan("plan.c", third, ["target.1", "target.2"])
    ];
    const sets = plans.map((row, index) =>
      alternativeSet(`series.${index}`, row));
    const evaluation = compileAutomaticAlignmentEvaluation({
      alternativeSets: sets,
      supports,
      referencePlans: plans,
      evidenceAllocations: plans.map(allocation),
      targetIndex: targetIndex()
    });
    const evaluated = evaluation.artifacts.find(row =>
      row.planId === "plan.a")!.heldout.find(row =>
        row.sourceFamilyId === "family.b")!;
    expect(evaluated.candidateRecall).toBe(0.5);
    expect(evaluated.finalRecall).toBeLessThanOrEqual(evaluated.candidateRecall);
    const promotion = compileAlignmentPromotionModel({
      alternativeSets: sets,
      observations: evaluation.promotionObservations
    });
    expect(promotion.decisions.find(row => row.planId === "plan.a")).toMatchObject({
      promoted: false,
      reasons: expect.arrayContaining(["heldout_coverage_low", "cycle_recall_low"])
    });
  });
});

function targetIndex(): SparseAlignmentTargetIndex {
  return {
    id: "target-index.1",
    targets: ["target.1", "target.2"].map(id => ({
      id,
      kind: "incidence",
      relationNodeId: "relation.1",
      hyperedgeId: "hyperedge.1",
      evidenceIds: ["evidence.1"],
      observableSurfaceKeys: []
    }))
  } as unknown as SparseAlignmentTargetIndex;
}

function support(
  id: string,
  sourceFamilyId: string,
  targetIds: string[]
): SparseAlignmentCandidateSupport {
  return {
    id,
    sourceFamilyId,
    targetIndexId: "target-index.1",
    candidates: targetIds.map((graphTargetId, index) => ({
      id: `${id}.candidate.${index}`,
      surfaceUnitId: `${id}.unit.${index}`,
      graphTargetId,
      supportKinds: ["exact_observable_anchor"]
    })),
    rows: targetIds.map((_, index) => ({
      surfaceUnitId: `${id}.unit.${index}`,
      candidateIds: [`${id}.candidate.${index}`],
      omittedCandidateCount: 0
    }))
  } as unknown as SparseAlignmentCandidateSupport;
}

function plan(
  id: string,
  support: SparseAlignmentCandidateSupport,
  targetIds: string[]
): SparseFusedTransportPlan {
  return {
    id,
    supportId: support.id,
    targetIndexId: "target-index.1",
    cells: targetIds.map((graphTargetId, index) => ({
      candidateId: `${support.id}.candidate.${index}`,
      surfaceUnitId: `${support.id}.unit.${index}`,
      graphTargetId,
      mass: 1,
      exactAnchor: true
    })),
    iterations: [{
      objective: 1,
      feature: 0.1,
      structural: 0.1,
      ordering: 0.1,
      crossDocument: 0.1,
      surfaceMarginalResidual: 0,
      graphMarginalResidual: 0
    }]
  } as unknown as SparseFusedTransportPlan;
}

function alternativeSet(
  seriesId: string,
  value: SparseFusedTransportPlan
): AlignmentAlternativeSet {
  return {
    id: `${seriesId}.set`,
    seriesId,
    hypotheses: [{ plan: value }]
  } as unknown as AlignmentAlternativeSet;
}

function allocation(plan: SparseFusedTransportPlan): TransportEvidenceAllocation {
  return {
    id: `${plan.id}.allocation`,
    transportPlanId: plan.id,
    status: "conserved"
  } as unknown as TransportEvidenceAllocation;
}
