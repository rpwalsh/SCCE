// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
import { describe, expect, it } from "vitest";
import {
  compileAlignmentPromotionModel,
  compileAutomaticAlignmentEvaluation,
  type AlignmentAlternativeSet,
  type SparseAlignmentCandidateSupport,
  type SparseAlignmentTargetIndex,
  type SparseFusedTransportPlan,
  type SurfaceLattice,
  type TransportEvidenceAllocation
} from "../index.js";
import { canonicalNormalizationContract } from "../normalization-contract.js";

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

  it("treats a port the held-out surface never mentions as unrealized meaning, not a recovery miss", () => {
    const complete = support("support.a", "family.a", ["target.1", "target.2"]);
    const partial = support("support.b", "family.b", ["target.1"]);
    const third = support("support.c", "family.c", ["target.1"]);
    const supports = [complete, partial, third];
    const plans = [
      plan("plan.a", complete, ["target.1", "target.2"]),
      plan("plan.b", partial, ["target.1"]),
      plan("plan.c", third, ["target.1"])
    ];
    const sets = plans.map((row, index) =>
      alternativeSet(`series.${index}`, row));
    const evaluation = compileAutomaticAlignmentEvaluation({
      alternativeSets: sets,
      supports,
      referencePlans: plans,
      evidenceAllocations: plans.map(allocation),
      targetIndex: targetIndex({ "target.1": ["ada"], "target.2": ["1815"] }),
      lattices: [lattice("lattice.a", "Ada 1815"), lattice("lattice.b", "Ada"), lattice("lattice.c", "Ada")]
    });
    const artifact = evaluation.artifacts.find(row => row.planId === "plan.a")!;
    expect(artifact.heldout.map(row => row.unrealizedGraphTargetIds)).toEqual([["target.2"], ["target.2"]]);
    expect(artifact.heldout.every(row => row.candidateRecall === 1 && row.finalRecall === 1)).toBe(true);
    const promotion = compileAlignmentPromotionModel({
      alternativeSets: sets,
      observations: evaluation.promotionObservations
    });
    expect(promotion.decisions.find(row => row.planId === "plan.a")?.promoted).toBe(true);
    // A surface that mentions the port but grew no candidate is still a generator miss.
    const missed = compileAutomaticAlignmentEvaluation({
      alternativeSets: sets,
      supports,
      referencePlans: plans,
      evidenceAllocations: plans.map(allocation),
      targetIndex: targetIndex({ "target.1": ["ada"], "target.2": ["1815"] }),
      lattices: [lattice("lattice.a", "Ada 1815"), lattice("lattice.b", "Ada 1815"), lattice("lattice.c", "Ada")]
    });
    const missedRow = missed.artifacts.find(row => row.planId === "plan.a")!.heldout.find(row => row.sourceFamilyId === "family.b")!;
    expect(missedRow.unrealizedGraphTargetIds).toEqual([]);
    expect(missedRow.candidateRecall).toBe(0.5);
  });
});

function targetIndex(surfaceKeys: Record<string, string[]> = {}): SparseAlignmentTargetIndex {
  return {
    id: "target-index.1",
    targets: ["target.1", "target.2"].map(id => ({
      id,
      kind: "incidence",
      relationNodeId: "relation.1",
      hyperedgeId: "hyperedge.1",
      evidenceIds: ["evidence.1"],
      observableSurfaceKeys: surfaceKeys[id] ?? []
    }))
  } as unknown as SparseAlignmentTargetIndex;
}

function lattice(id: string, text: string): SurfaceLattice {
  return {
    id,
    normalizationContract: canonicalNormalizationContract(),
    units: text.split(" ").map((word, index) => ({ id: `${id}.unit.${index}`, normalized: word }))
  } as unknown as SurfaceLattice;
}

function support(
  id: string,
  sourceFamilyId: string,
  targetIds: string[]
): SparseAlignmentCandidateSupport {
  return {
    id,
    sourceFamilyId,
    latticeId: id.replace("support", "lattice"),
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
