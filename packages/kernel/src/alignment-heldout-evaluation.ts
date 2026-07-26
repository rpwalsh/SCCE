import type { AlignmentAlternativeSet } from "./alignment-alternatives.js";
import {
  alignmentCalibrationFeatures,
  type AlignmentCalibrationObservation
} from "./alignment-calibration.js";
import type { AlignmentPromotionObservation } from "./alignment-promotion.js";
import { canonicalStringify, createHasher, toJsonValue } from "./primitives.js";
import type {
  SparseAlignmentCandidateSupport,
  SparseAlignmentTargetIndex
} from "./sparse-alignment-candidates.js";
import type { SparseFusedTransportPlan } from "./sparse-fused-transport.js";
import type { TransportEvidenceAllocation } from "./transport-evidence-allocation.js";
import type { Hasher, JsonValue } from "./types.js";

export const ALIGNMENT_HELDOUT_EVALUATION_SCHEMA =
  "scce.alignment_heldout_evaluation.v1" as const;

export interface AlignmentHeldoutFamilyResult {
  sourceFamilyId: string;
  supportId: string;
  referencePlanId: string;
  requiredGraphTargetCount: number;
  candidateRecoveredGraphTargetCount: number;
  finalRecoveredGraphTargetCount: number;
  candidateRecall: number;
  finalRecall: number;
  exactAnchorsPreserved: boolean;
  unsupportedAdditionCount: number;
  outcome: boolean;
}

export interface AlignmentHeldoutEvaluationArtifact {
  schema: typeof ALIGNMENT_HELDOUT_EVALUATION_SCHEMA;
  id: string;
  seriesId: string;
  planId: string;
  inductionSupportId: string;
  inductionSourceFamilyId: string;
  evidenceAllocationId: string;
  targetIndexId: string;
  requiredGraphTargetIds: string[];
  heldout: AlignmentHeldoutFamilyResult[];
  minimumCandidateRecall: 1;
  minimumFinalRecall: 0.98;
  maximumUnsupportedAdditions: 0;
  audit: JsonValue;
}

export interface AutomaticAlignmentEvaluation {
  artifacts: AlignmentHeldoutEvaluationArtifact[];
  promotionObservations: AlignmentPromotionObservation[];
  calibrationObservations: AlignmentCalibrationObservation[];
  candidateRecall: {
    evaluatedPlanCount: number;
    heldoutFamilyEvaluations: number;
    minimum: number;
    mean: number;
    perfectCount: number;
  };
}

/**
 * Cross-fits every retained plan against dependency-independent supports.
 * Candidate recall is measured before transport recovery because no downstream
 * solver can recover a target removed from candidate support.
 */
export function compileAutomaticAlignmentEvaluation(input: {
  alternativeSets: readonly AlignmentAlternativeSet[];
  supports: readonly SparseAlignmentCandidateSupport[];
  referencePlans: readonly SparseFusedTransportPlan[];
  evidenceAllocations: readonly TransportEvidenceAllocation[];
  targetIndex: SparseAlignmentTargetIndex;
  hasher?: Hasher;
}): AutomaticAlignmentEvaluation {
  const hasher = input.hasher ?? createHasher();
  const supportById = uniqueMap(input.supports, row => row.id);
  const referenceBySupportId = uniqueMap(
    input.referencePlans,
    row => row.supportId
  );
  const allocationByPlanId = uniqueMap(
    input.evidenceAllocations,
    row => row.transportPlanId
  );
  const targetById = uniqueMap(input.targetIndex.targets, row => row.id);
  const oneSupportPerFamily = representativeSupports(input.supports);
  const artifacts: AlignmentHeldoutEvaluationArtifact[] = [];
  const promotionObservations: AlignmentPromotionObservation[] = [];
  const calibrationObservations: AlignmentCalibrationObservation[] = [];

  for (const set of [...input.alternativeSets].sort((left, right) =>
    left.id.localeCompare(right.id))) {
    for (const hypothesis of set.hypotheses) {
      const plan = hypothesis.plan;
      const inductionSupport = supportById.get(plan.supportId);
      const allocation = allocationByPlanId.get(plan.id);
      if (!inductionSupport || !allocation
        || allocation.status !== "conserved"
        || plan.targetIndexId !== input.targetIndex.id) continue;
      const requiredGraphTargetIds = selectedGraphTargetIds(plan);
      if (!requiredGraphTargetIds.length) continue;
      const required = new Set(requiredGraphTargetIds);
      const requiredHyperedges = new Set(requiredGraphTargetIds.map(id =>
        targetById.get(id)?.hyperedgeId).filter(Boolean));
      const heldout: AlignmentHeldoutFamilyResult[] = [];
      for (const support of oneSupportPerFamily) {
        if (support.sourceFamilyId === inductionSupport.sourceFamilyId) continue;
        const referencePlan = referenceBySupportId.get(support.id);
        if (!referencePlan) continue;
        const candidateTargets = new Set(support.candidates.map(candidate =>
          candidate.graphTargetId));
        const selectedTargets = new Set(selectedGraphTargetIds(referencePlan));
        const candidateRecoveredGraphTargetCount = requiredGraphTargetIds.filter(id =>
          candidateTargets.has(id)).length;
        const finalRecoveredGraphTargetCount = requiredGraphTargetIds.filter(id =>
          selectedTargets.has(id)).length;
        const candidateRecall =
          candidateRecoveredGraphTargetCount / requiredGraphTargetIds.length;
        const finalRecall =
          finalRecoveredGraphTargetCount / requiredGraphTargetIds.length;
        const heldoutExactAnchors = support.candidates.filter(candidate =>
          candidate.supportKinds.includes("exact_observable_anchor")
          && required.has(candidate.graphTargetId));
        const selectedCandidateIds = new Set(referencePlan.cells
          .filter(cell => cell.mass > 1e-12)
          .map(cell => cell.candidateId));
        const exactAnchorsPreserved = heldoutExactAnchors.every(candidate =>
          selectedCandidateIds.has(candidate.id));
        const unsupportedAdditionCount = [...selectedTargets].filter(id => {
          if (required.has(id)) return false;
          const hyperedgeId = targetById.get(id)?.hyperedgeId;
          return hyperedgeId ? requiredHyperedges.has(hyperedgeId) : false;
        }).length;
        heldout.push({
          sourceFamilyId: support.sourceFamilyId,
          supportId: support.id,
          referencePlanId: referencePlan.id,
          requiredGraphTargetCount: requiredGraphTargetIds.length,
          candidateRecoveredGraphTargetCount,
          finalRecoveredGraphTargetCount,
          candidateRecall,
          finalRecall,
          exactAnchorsPreserved,
          unsupportedAdditionCount,
          outcome: candidateRecall === 1
            && finalRecall >= 0.98
            && exactAnchorsPreserved
            && unsupportedAdditionCount === 0
        });
      }
      const canonical = {
        schema: ALIGNMENT_HELDOUT_EVALUATION_SCHEMA,
        seriesId: set.seriesId,
        planId: plan.id,
        inductionSupportId: inductionSupport.id,
        inductionSourceFamilyId: inductionSupport.sourceFamilyId,
        evidenceAllocationId: allocation.id,
        targetIndexId: input.targetIndex.id,
        requiredGraphTargetIds,
        heldout: heldout.sort((left, right) =>
          left.sourceFamilyId.localeCompare(right.sourceFamilyId)),
        minimumCandidateRecall: 1 as const,
        minimumFinalRecall: 0.98 as const,
        maximumUnsupportedAdditions: 0 as const
      };
      const artifact: AlignmentHeldoutEvaluationArtifact = {
        ...canonical,
        id: stableId(hasher, "alignment_heldout_evaluation", canonical),
        audit: toJsonValue({
          evaluator: "kernel.alignment_heldout.crossfit.v1",
          contentAddressedPlanBinding: true,
          contentAddressedEvidenceAllocationBinding: true,
          sourceFamilyDisjoint: true,
          candidateRecallMeasuredBeforeTransport: true,
          finalRecallCannotExceedCandidateRecall:
            heldout.every(row => row.finalRecall <= row.candidateRecall + 1e-12)
        })
      };
      artifacts.push(artifact);
      promotionObservations.push({
        id: stableId(hasher, "alignment_promotion_observation", [
          artifact.id,
          "induction",
          inductionSupport.sourceFamilyId
        ]),
        seriesId: set.seriesId,
        planId: plan.id,
        sourceFamilyId: inductionSupport.sourceFamilyId,
        partition: "induction",
        requiredGraphTargetCount: requiredGraphTargetIds.length,
        recoveredGraphTargetCount: requiredGraphTargetIds.length,
        exactAnchorsPreserved: true,
        cycleRecall: 1,
        unsupportedAdditionCount: 0
      });
      for (const result of heldout) {
        promotionObservations.push({
          id: stableId(hasher, "alignment_promotion_observation", [
            artifact.id,
            result.sourceFamilyId,
            result.referencePlanId
          ]),
          seriesId: set.seriesId,
          planId: plan.id,
          sourceFamilyId: result.sourceFamilyId,
          partition: "heldout",
          requiredGraphTargetCount: result.requiredGraphTargetCount,
          recoveredGraphTargetCount: result.finalRecoveredGraphTargetCount,
          exactAnchorsPreserved: result.exactAnchorsPreserved,
          cycleRecall: result.finalRecall,
          unsupportedAdditionCount: result.unsupportedAdditionCount
        });
      }
      const minimumCycleRecall = heldout.length
        ? Math.min(...heldout.map(row => row.finalRecall))
        : 0;
      const unsupported = heldout.reduce((sum, row) =>
        sum + row.unsupportedAdditionCount, 0);
      const features = alignmentCalibrationFeatures({
        plan,
        independentAnchorSourceFamilies: heldout.length,
        cycleRecall: minimumCycleRecall,
        unsupportedAdditionRate: unsupported / Math.max(
          1,
          heldout.length * requiredGraphTargetIds.length
        )
      });
      for (const result of heldout) {
        calibrationObservations.push({
          id: stableId(hasher, "alignment_calibration_observation", [
            artifact.id,
            result.sourceFamilyId
          ]),
          sourceFamilyId: result.sourceFamilyId,
          partition: calibrationPartition(result.sourceFamilyId, hasher),
          outcome: result.outcome,
          features
        });
      }
    }
  }
  const recallValues = artifacts.flatMap(artifact =>
    artifact.heldout.map(row => row.candidateRecall));
  return {
    artifacts: artifacts.sort((left, right) => left.id.localeCompare(right.id)),
    promotionObservations: uniqueObservations(promotionObservations),
    calibrationObservations: uniqueObservations(calibrationObservations),
    candidateRecall: {
      evaluatedPlanCount: artifacts.length,
      heldoutFamilyEvaluations: recallValues.length,
      minimum: recallValues.length ? Math.min(...recallValues) : 0,
      mean: recallValues.length
        ? recallValues.reduce((sum, value) => sum + value, 0)
          / recallValues.length
        : 0,
      perfectCount: recallValues.filter(value => value === 1).length
    }
  };
}

function selectedGraphTargetIds(plan: SparseFusedTransportPlan): string[] {
  const rows = new Map<string, typeof plan.cells>();
  for (const cell of plan.cells) {
    const values = rows.get(cell.surfaceUnitId) ?? [];
    values.push(cell);
    rows.set(cell.surfaceUnitId, values);
  }
  return [...rows.values()].flatMap(cells => {
    const maximum = Math.max(0, ...cells.map(cell => cell.mass));
    return cells.filter(cell => cell.mass > 1e-12
      && cell.mass >= maximum - 1e-12)
      .map(cell => cell.graphTargetId);
  }).filter((id, index, values) => values.indexOf(id) === index).sort();
}

function representativeSupports(
  supports: readonly SparseAlignmentCandidateSupport[]
): SparseAlignmentCandidateSupport[] {
  const byFamily = new Map<string, SparseAlignmentCandidateSupport>();
  for (const support of [...supports].sort((left, right) =>
    left.id.localeCompare(right.id))) {
    if (!byFamily.has(support.sourceFamilyId)) {
      byFamily.set(support.sourceFamilyId, support);
    }
  }
  return [...byFamily.values()].sort((left, right) =>
    left.sourceFamilyId.localeCompare(right.sourceFamilyId));
}

function calibrationPartition(
  sourceFamilyId: string,
  hasher: Hasher
): "fit" | "holdout" {
  const prefix = hasher.digestHex(sourceFamilyId).slice(0, 2);
  return Number.parseInt(prefix, 16) % 5 === 0 ? "holdout" : "fit";
}

function uniqueMap<T>(
  rows: readonly T[],
  key: (row: T) => string
): Map<string, T> {
  const out = new Map<string, T>();
  for (const row of rows) {
    const id = key(row);
    if (!out.has(id)) out.set(id, row);
  }
  return out;
}

function uniqueObservations<T extends { id: string }>(rows: readonly T[]): T[] {
  return [...new Map(rows.map(row => [row.id, row])).values()].sort((left, right) =>
    left.id.localeCompare(right.id));
}

function stableId(hasher: Hasher, namespace: string, value: unknown): string {
  return `${namespace}.${hasher.digestHex(canonicalStringify(value)).slice(0, 40)}`;
}
