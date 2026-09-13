// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
import type { CalibrationKey } from "./public-calibrations.js";

/**
 * What a calibrator is allowed to try for each id, and how finely it is worth trying.
 *
 * This ships with the engine rather than living in a tool, because it is part of the contract: a public clone
 * can calibrate its own brain without being told what the ranges are. The fitting algorithm is public, the
 * fitted result is not (private-runtime/README.md).
 *
 * `resolution` is the honest limit, not a preference. A threshold compared against min(len)/max(len) can only
 * change behaviour when it crosses a ratio the corpus actually produces, and for word lengths 3..14 there are
 * 31 such ratios in total -- every value in (0.7143, 0.7273] behaves identically, which is the interval the
 * shipped 0.72 sits in. Reporting more digits than the plateau supports is false precision, so a calibrator
 * reports the plateau it found and takes its midpoint.
 */
export type CalibrationSearchKind = "threshold" | "weight" | "count";

export interface CalibrationSearchEntry {
  kind: CalibrationSearchKind;
  min: number;
  max: number;
  /** First pass. Refinement bisects between the winner and its neighbours until it reaches `resolution`. */
  coarse: readonly number[];
  /** Differences smaller than this cannot be separated by the objective and are not searched. */
  resolution: number;
}

const threshold = (min: number, max: number, coarse: readonly number[]): CalibrationSearchEntry =>
  ({ kind: "threshold", min, max, coarse, resolution: 0.005 });
const weight = (min: number, max: number, coarse: readonly number[]): CalibrationSearchEntry =>
  ({ kind: "weight", min, max, coarse, resolution: 0.01 });
const count = (min: number, max: number, coarse: readonly number[]): CalibrationSearchEntry =>
  ({ kind: "count", min, max, coarse, resolution: 1 });

export const CALIBRATION_SEARCH_SPACE: Readonly<Record<CalibrationKey, CalibrationSearchEntry>> = Object.freeze({
  // --- request unit matching
  "units.prefix_ratio_floor": threshold(0.5, 0.95, [0.6, 0.66, 0.72, 0.78, 0.85]),
  "units.similarity_floor": threshold(0.5, 0.95, [0.6, 0.66, 0.72, 0.78, 0.85]),
  "units.containment_similarity": weight(0.5, 1, [0.7, 0.78, 0.82, 0.9]),
  "units.containment_ratio_floor": threshold(0.5, 0.95, [0.6, 0.66, 0.72, 0.78, 0.85]),
  "units.edit_distance_cap": count(1, 5, [1, 2, 3, 4]),
  "units.stem_shared_prefix_min": count(2, 8, [3, 4, 5, 6]),
  "units.stem_shared_ratio_floor": threshold(0.4, 0.9, [0.5, 0.6, 0.7, 0.8]),
  "units.stem_direct_match_min_length": count(3, 9, [4, 5, 6, 7]),

  // --- sentence ranking, shared by both rankers
  "ranking.unit_overlap_weight": weight(0, 3, [0.5, 0.92, 1.4, 2]),
  "ranking.lexical_similarity_weight": weight(0, 2, [0.15, 0.35, 0.6, 1]),
  "ranking.anchor_boost": weight(0, 3, [0, 0.54, 1.1, 2]),
  "ranking.title_lead_boost": weight(0, 10, [0, 2, 4, 6, 8]),
  "ranking.source_affinity_weight": weight(0, 6, [1, 2, 3, 4.5]),
  "ranking.fragment_penalty": weight(0, 4, [0.4, 1.2, 2, 3]),
  "ranking.near_duplicate_weight": weight(0, 24, [4, 8, 12, 18]),
  "ranking.near_duplicate_fraction_floor": threshold(0.2, 0.9, [0.3, 0.4, 0.5, 0.65, 0.8]),
  "ranking.anchor_predication_rerank_limit": count(2, 24, [4, 8, 12, 16]),

  // --- ranker-specific
  "ranking.exact.source_affinity_secondary_title_factor": weight(0, 1, [0.4, 0.7, 0.85, 1]),
  "ranking.exact.source_order_bonus": weight(0, 1, [0, 0.08, 0.16, 0.32]),
  "ranking.exact.source_order_decay": weight(0, 0.1, [0.006, 0.018, 0.036, 0.06]),
  "ranking.best.source_order_bonus": weight(0, 1, [0, 0.09, 0.18, 0.36]),
  "ranking.best.source_order_decay": weight(0, 0.1, [0.005, 0.015, 0.03, 0.05]),
  "ranking.best.pair_overlap_weight": weight(0, 1, [0, 0.08, 0.16, 0.32]),
  "ranking.best.evidence_alpha_weight": weight(0, 1, [0, 0.06, 0.12, 0.24]),

  // --- answer plan admission
  "plan.contradiction_block": threshold(0.3, 0.95, [0.5, 0.62, 0.72, 0.85]),
  "plan.contradiction_unanchored_block": threshold(0.2, 0.9, [0.3, 0.45, 0.6, 0.75]),
  "plan.relevance_floor": threshold(0, 0.2, [0, 0.02, 0.035, 0.07]),

  // --- temporal development context scoring
  "temporal_context.concept_coverage_weight": weight(0, 0.6, [0.09, 0.18, 0.3]),
  "temporal_context.breadth_weight": weight(0, 0.6, [0.08, 0.16, 0.28]),
  "temporal_context.distinctness_weight": weight(0, 0.6, [0.08, 0.16, 0.28]),
  "temporal_context.preceding_proximity_weight": weight(0, 0.6, [0.1, 0.2, 0.34]),
  "temporal_context.temporal_neighborhood_weight": weight(0, 0.6, [0.09, 0.18, 0.3]),
  "temporal_context.source_order_weight": weight(0, 0.4, [0.03, 0.07, 0.14]),
  "temporal_context.length_fitness_weight": weight(0, 0.4, [0.02, 0.05, 0.1]),
  "temporal_context.numeric_specificity_penalty": weight(0, 0.5, [0.05, 0.1, 0.2]),
  "temporal_context.named_specificity_penalty": weight(0, 0.5, [0.05, 0.1, 0.2]),
  "temporal_context.point_date_specificity_penalty": weight(0, 0.6, [0.11, 0.22, 0.36]),
  "temporal_context.repetition_pressure_penalty": weight(0, 0.6, [0.09, 0.18, 0.3]),
  // --- field operators. Iteration counts that run on every activation and were never declared until now.
  // Searchable because their cost is linear in the count and nobody has shown what the value buys.
  "field.heat_diffusion_steps": count(1, 8, [1, 2, 3, 5, 8]),
  "field.wave_propagation_steps": count(1, 4, [1, 2, 3, 4]),
  "field.wave_damping": weight(0, 0.4, [0.02, 0.08, 0.16, 0.32]),
  "field.spectral_partition_iterations": count(2, 16, [2, 4, 6, 10, 16]),
  // --- judge.ts candidate scoring
  "judge.contradiction_penalty_floor": weight(0, 0.6, [0.14, 0.28, 0.45]),
  "judge.contradiction_penalty_authority_weight": weight(0, 1, [0.27, 0.54, 0.8]),
  "judge.contradiction_penalty_inferential_depth_weight": weight(0, 0.6, [0.08, 0.16, 0.32]),
  "judge.unsupported_fact_penalty_floor": weight(0, 0.7, [0.18, 0.36, 0.54]),
  "judge.unsupported_fact_penalty_authority_weight": weight(0, 1, [0.31, 0.62, 0.86]),
  "judge.unsupported_fact_penalty_source_dependence_weight": weight(0, 0.6, [0.11, 0.22, 0.4]),
  "judge.stale_source_penalty_floor": weight(0, 0.6, [0.15, 0.3, 0.48]),
  "judge.stale_source_penalty_source_dependence_weight": weight(0, 0.8, [0.18, 0.35, 0.6]),
  "judge.stale_source_penalty_executable_demand_weight": weight(0, 0.6, [0.12, 0.25, 0.44]),
  "judge.executable_artifact_demand_floor": threshold(0.3, 0.9, [0.45, 0.55, 0.65, 0.75, 0.85]),
  "judge.proof_epistemic_force_weight": weight(0, 1, [0.18, 0.35, 0.55]),
  "judge.proof_support_weight": weight(0, 1, [0.14, 0.28, 0.45]),
  "judge.proof_faithfulness_weight": weight(0, 1, [0.11, 0.22, 0.4]),
  "judge.proof_evidence_coverage_weight": weight(0, 1, [0.08, 0.15, 0.3]),
  "judge.field_alpha_pressure_weight": weight(0, 1, [0.19, 0.38, 0.58]),
  "judge.field_actionability_weight": weight(0, 1, [0.13, 0.25, 0.42]),
  "judge.field_realizability_weight": weight(0, 1, [0.1, 0.2, 0.36]),
  "judge.field_novelty_weight": weight(0, 1, [0.09, 0.17, 0.32]),
  "judge.risk_contradiction_weight": weight(0, 1, [0.3, 0.6, 0.85]),
  "judge.risk_boundary_weight": weight(0, 1, [0.13, 0.25, 0.42]),
  "judge.risk_policy_ceiling_weight": weight(0, 1, [0.08, 0.15, 0.3]),
  "judge.total_proof_weight": weight(0, 1, [0.16, 0.32, 0.5]),
  "judge.total_field_weight": weight(0, 1, [0.12, 0.24, 0.4]),
  "judge.total_validation_weight": weight(0, 1, [0.1, 0.2, 0.36]),
  "judge.total_realizability_weight": weight(0, 1, [0.06, 0.12, 0.24]),
  "judge.total_mass_weight": weight(0, 1, [0.06, 0.12, 0.24]),
  "judge.total_risk_penalty": weight(0, 1, [0.21, 0.42, 0.65]),
  "judge.creative_mismatch_mass_weight": weight(0, 0.5, [0.06, 0.12, 0.24]),
  "judge.creative_mismatch_actionability_weight": weight(0, 0.5, [0.04, 0.08, 0.16]),
  "judge.creative_mismatch_realizability_weight": weight(0, 0.5, [0.04, 0.08, 0.16]),
  "judge.creative_constraint_coverage_weight": weight(0, 1, [0.14, 0.28, 0.45]),
  "judge.creative_coherence_weight": weight(0, 1, [0.11, 0.22, 0.4]),
  "judge.creative_novelty_weight": weight(0, 1, [0.1, 0.2, 0.36]),
  "judge.creative_language_weight": weight(0, 1, [0.08, 0.15, 0.3]),
  "judge.creative_usefulness_weight": weight(0, 1, [0.08, 0.15, 0.3]),
  "judge.creative_risk_penalty": weight(0, 1, [0.15, 0.3, 0.5]),
  "judge.creative_repetition_penalty": weight(0, 1, [0.1, 0.2, 0.36]),
  "judge.creative_fake_authority_penalty": weight(0, 1, [0.25, 0.5, 0.75]),
  "judge.creative_total_selection_weight": weight(0, 1, [0.36, 0.72, 0.9]),
  "judge.creative_total_mass_weight": weight(0, 1, [0.08, 0.16, 0.3]),
  "judge.creative_total_validation_weight": weight(0, 1, [0.06, 0.12, 0.24])
});

/** Ids a calibrator may search, in a stable order so a run is reproducible. */
export const CALIBRATION_SEARCH_IDS = Object.freeze(
  Object.keys(CALIBRATION_SEARCH_SPACE).sort() as CalibrationKey[]
);

/** Snaps a proposed value into the entry's range, and to whole numbers where the id counts things. */
export function snapCalibrationValue(entry: CalibrationSearchEntry, value: number): number {
  const bounded = Math.min(entry.max, Math.max(entry.min, value));
  if (entry.kind === "count") return Math.round(bounded);
  const steps = Math.round(bounded / entry.resolution);
  return Number((steps * entry.resolution).toFixed(6));
}
