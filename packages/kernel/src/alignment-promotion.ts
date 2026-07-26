import { canonicalStringify, createHasher, toJsonValue } from "./primitives.js";
import type { AlignmentAlternativeSet } from "./alignment-alternatives.js";
import type { Hasher, JsonValue } from "./types.js";

export const ALIGNMENT_PROMOTION_SCHEMA =
  "scce.alignment_heldout_promotion.v1" as const;

export interface AlignmentPromotionObservation {
  id: string;
  seriesId: string;
  planId: string;
  sourceFamilyId: string;
  partition: "induction" | "heldout";
  requiredGraphTargetCount: number;
  recoveredGraphTargetCount: number;
  exactAnchorsPreserved: boolean;
  cycleRecall: number;
  unsupportedAdditionCount: number;
}

export interface AlignmentPromotionDecision {
  seriesId: string;
  planId: string;
  promoted: boolean;
  inductionSourceFamilyIds: string[];
  independentHeldoutSourceFamilyIds: string[];
  heldoutCoverage: number;
  cycleRecall: number;
  exactAnchorsPreserved: boolean;
  unsupportedAdditionCount: number;
  reasons: string[];
}

export interface AlignmentPromotionModel {
  schema: typeof ALIGNMENT_PROMOTION_SCHEMA;
  id: string;
  minimumIndependentHeldoutFamilies: number;
  minimumHeldoutCoverage: number;
  minimumCycleRecall: number;
  decisions: AlignmentPromotionDecision[];
  audit: JsonValue;
}

export function compileAlignmentPromotionModel(input: {
  alternativeSets: readonly AlignmentAlternativeSet[];
  observations: readonly AlignmentPromotionObservation[];
  minimumIndependentHeldoutFamilies?: number;
  minimumHeldoutCoverage?: number;
  minimumCycleRecall?: number;
  hasher?: Hasher;
}): AlignmentPromotionModel {
  const hasher = input.hasher ?? createHasher();
  const minimumIndependentHeldoutFamilies = boundedInteger(
    input.minimumIndependentHeldoutFamilies, 1, 32, 2);
  const minimumHeldoutCoverage = unit(input.minimumHeldoutCoverage ?? 1);
  const minimumCycleRecall = unit(input.minimumCycleRecall ?? 0.98);
  const observations = canonicalObservations(input.observations);
  const decisions = input.alternativeSets.flatMap(set => set.hypotheses.map(hypothesis => {
    const rows = observations.filter(row =>
      row.seriesId === set.seriesId && row.planId === hypothesis.plan.id);
    const inductionFamilies = new Set(rows
      .filter(row => row.partition === "induction")
      .map(row => row.sourceFamilyId));
    const independentHeldoutRows = rows.filter(row =>
      row.partition === "heldout" && !inductionFamilies.has(row.sourceFamilyId));
    const heldout = collapseHeldoutFamilies(independentHeldoutRows);
    const inductionSourceFamilyIds = [...inductionFamilies].sort();
    const independentHeldoutSourceFamilyIds = heldout.map(row =>
      row.sourceFamilyId).sort();
    const required = heldout.reduce((sum, row) =>
      sum + Math.max(0, Math.floor(row.requiredGraphTargetCount)), 0);
    const recovered = heldout.reduce((sum, row) =>
      sum + Math.min(
        Math.max(0, Math.floor(row.requiredGraphTargetCount)),
        Math.max(0, Math.floor(row.recoveredGraphTargetCount))
      ), 0);
    const heldoutCoverage = required > 0 ? recovered / required : 0;
    const cycleRecall = heldout.length
      ? Math.min(...heldout.map(row => unit(row.cycleRecall)))
      : 0;
    const exactAnchorsPreserved = heldout.length > 0
      && heldout.every(row => row.exactAnchorsPreserved);
    const unsupportedAdditionCount = heldout.reduce((sum, row) =>
      sum + Math.max(0, Math.floor(row.unsupportedAdditionCount)), 0);
    const reasons: string[] = [];
    if (!inductionSourceFamilyIds.length) reasons.push("induction_family_missing");
    if (independentHeldoutSourceFamilyIds.length
      < minimumIndependentHeldoutFamilies) reasons.push("independent_heldout_families_low");
    if (heldoutCoverage < minimumHeldoutCoverage) reasons.push("heldout_coverage_low");
    if (cycleRecall < minimumCycleRecall) reasons.push("cycle_recall_low");
    if (!exactAnchorsPreserved) reasons.push("exact_anchor_not_preserved");
    if (unsupportedAdditionCount !== 0) reasons.push("unsupported_additions_present");
    return {
      seriesId: set.seriesId,
      planId: hypothesis.plan.id,
      promoted: reasons.length === 0,
      inductionSourceFamilyIds,
      independentHeldoutSourceFamilyIds,
      heldoutCoverage,
      cycleRecall,
      exactAnchorsPreserved,
      unsupportedAdditionCount,
      reasons
    };
  })).sort((left, right) =>
    left.seriesId.localeCompare(right.seriesId)
    || left.planId.localeCompare(right.planId));
  const canonical = {
    schema: ALIGNMENT_PROMOTION_SCHEMA,
    minimumIndependentHeldoutFamilies,
    minimumHeldoutCoverage,
    minimumCycleRecall,
    decisions
  };
  return {
    ...canonical,
    id: `alignment_promotion.${hasher.digestHex(
      canonicalStringify(canonical)).slice(0, 40)}`,
    audit: toJsonValue({
      compiler: "kernel.alignment_promotion.independent_heldout.v1",
      observationCount: observations.length,
      promotedCount: decisions.filter(row => row.promoted).length,
      copiedFamiliesCannotSelfValidate: true,
      zeroUnsupportedAdditionsRequired: true
    })
  };
}

function collapseHeldoutFamilies(
  rows: readonly AlignmentPromotionObservation[]
): AlignmentPromotionObservation[] {
  const grouped = new Map<string, AlignmentPromotionObservation[]>();
  for (const row of rows) {
    const family = grouped.get(row.sourceFamilyId) ?? [];
    family.push(row);
    grouped.set(row.sourceFamilyId, family);
  }
  return [...grouped.entries()].map(([sourceFamilyId, family]) => ({
    id: family.map(row => row.id).sort().join("\u001f"),
    seriesId: family[0]!.seriesId,
    planId: family[0]!.planId,
    sourceFamilyId,
    partition: "heldout",
    requiredGraphTargetCount: Math.max(...family.map(row =>
      Math.max(0, Math.floor(row.requiredGraphTargetCount)))),
    recoveredGraphTargetCount: Math.min(...family.map(row =>
      Math.max(0, Math.floor(row.recoveredGraphTargetCount)))),
    exactAnchorsPreserved: family.every(row => row.exactAnchorsPreserved),
    cycleRecall: Math.min(...family.map(row => row.cycleRecall)),
    unsupportedAdditionCount: Math.max(...family.map(row =>
      Math.max(0, Math.floor(row.unsupportedAdditionCount))))
  }));
}

function canonicalObservations(
  rows: readonly AlignmentPromotionObservation[]
): AlignmentPromotionObservation[] {
  const ids = new Set<string>();
  return [...rows].map(row => {
    if (!row.id || !row.seriesId || !row.planId || !row.sourceFamilyId) {
      throw new Error("alignment promotion observation identity is required");
    }
    if (ids.has(row.id)) throw new Error(`duplicate alignment promotion ${row.id}`);
    ids.add(row.id);
    unit(row.cycleRecall);
    return { ...row };
  }).sort((left, right) => left.id.localeCompare(right.id));
}

function unit(value: number): number {
  if (!Number.isFinite(value) || value < 0 || value > 1) {
    throw new Error("alignment promotion probability must be in [0,1]");
  }
  return value;
}

function boundedInteger(
  value: number | undefined, minimum: number, maximum: number, fallback: number
): number {
  return Math.max(minimum, Math.min(maximum, Math.floor(value ?? fallback)));
}
