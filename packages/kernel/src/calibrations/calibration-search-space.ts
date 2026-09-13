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
  // --- tool cognition
  "tool_cognition.risk_surface_alpha_weight": weight(0, 0.8, [0.2, 0.35, 0.5]),
  "tool_cognition.risk_surface_contradiction_weight": weight(0, 0.8, [0.15, 0.25, 0.4]),
  "tool_cognition.risk_surface_drift_weight": weight(0, 0.8, [0.1, 0.2, 0.35]),
  "tool_cognition.risk_surface_unbonded_weight": weight(0, 0.8, [0.1, 0.2, 0.35]),
  "tool_cognition.risk_surface_default": threshold(0, 0.9, [0.15, 0.35, 0.6]),
  "tool_cognition.expected_evidence_gap_weight": weight(0, 0.8, [0.25, 0.45, 0.65]),
  "tool_cognition.expected_field_gap_weight": weight(0, 0.6, [0.1, 0.2, 0.35]),
  "tool_cognition.expected_risk_weight": weight(0, 0.6, [0.05, 0.1, 0.25]),
  "tool_cognition.objective_pressure_floor": threshold(0.01, 0.5, [0.04, 0.08, 0.16, 0.3]),
  "tool_cognition.capability_fit_floor": threshold(0.01, 0.5, [0.02, 0.04, 0.1, 0.25]),
  "tool_cognition.utility_fit_weight": weight(0, 1, [0.35, 0.55, 0.75]),
  "tool_cognition.utility_evi_weight": weight(0, 1, [0.25, 0.45, 0.65]),
  "tool_cognition.utility_risk_discount": weight(0, 1, [0.2, 0.42, 0.7]),
  "tool_cognition.capability_fit_kind_weight": weight(0, 1, [0.4, 0.62, 0.8]),
  "tool_cognition.capability_fit_phase_weight": weight(0, 0.8, [0.12, 0.23, 0.4]),
  "tool_cognition.capability_fit_metadata_weight": weight(0, 0.8, [0.08, 0.15, 0.3]),
  "tool_cognition.capability_risk_base_weight": weight(0, 0.8, [0.18, 0.32, 0.5]),
  "tool_cognition.capability_risk_mutation_weight": weight(0, 0.8, [0.12, 0.24, 0.4]),
  "tool_cognition.capability_risk_privacy_weight": weight(0, 0.8, [0.1, 0.2, 0.35]),
  "tool_cognition.capability_risk_network_weight": weight(0, 0.6, [0.07, 0.14, 0.28]),
  "tool_cognition.capability_risk_spend_weight": weight(0, 0.6, [0.05, 0.1, 0.22]),
  "tool_cognition.evi_phase_weight": weight(0, 1, [0.38, 0.58, 0.78]),
  "tool_cognition.evi_connector_weight": weight(0, 1, [0.22, 0.42, 0.62]),
  "tool_cognition.evi_risk_discount": weight(0, 1, [0.15, 0.3, 0.55]),
  "tool_cognition.approval_risk_ceiling": threshold(0.1, 0.9, [0.2, 0.35, 0.5, 0.7]),
  "tool_cognition.approval_privacy_pressure_ceiling": threshold(0.1, 0.95, [0.35, 0.55, 0.75]),
  "tool_cognition.operator_grant_risk_ceiling": threshold(0.3, 0.98, [0.6, 0.72, 0.82, 0.92]),
  "tool_cognition.mutation_pressure_two_phase_floor": threshold(0.1, 0.95, [0.35, 0.55, 0.75]),
  "tool_cognition.plan_utility_floor": threshold(0.02, 0.6, [0.06, 0.12, 0.25, 0.4]),
  "tool_cognition.risk_vector_mutation_floor": threshold(0.1, 0.9, [0.25, 0.4, 0.6]),
  "tool_cognition.risk_vector_network_floor": threshold(0.1, 0.9, [0.2, 0.35, 0.55]),
  "tool_cognition.operator_grant_eligibility_risk_ceiling": threshold(0.2, 0.95, [0.5, 0.72, 0.85]),
  "tool_cognition.capability_gap_utility_floor": threshold(0.05, 0.8, [0.15, 0.28, 0.45]),
  "tool_cognition.outcome_evidence_weight": weight(0, 1, [0.25, 0.45, 0.65]),
  "tool_cognition.outcome_artifact_weight": weight(0, 1, [0.2, 0.35, 0.55]),
  "tool_cognition.outcome_success_weight": weight(0, 1, [0.1, 0.2, 0.4]),
  "tool_cognition.outcome_spend_penalty_weight": weight(0, 0.8, [0.09, 0.18, 0.35]),
  "tool_cognition.outcome_duration_penalty_weight": weight(0, 0.8, [0.04, 0.08, 0.2]),
  "tool_cognition.connector_reliability_success_weight": weight(0, 1, [0.35, 0.55, 0.75]),
  "tool_cognition.connector_reliability_risk_weight": weight(0, 1, [0.25, 0.45, 0.65]),
  "tool_cognition.pattern_retention_reliability_floor": threshold(0.2, 0.95, [0.45, 0.62, 0.8]),
  "tool_cognition.pattern_retention_utility_delta_floor": threshold(0.05, 0.8, [0.15, 0.28, 0.45]),
  // --- semantic obligations (semantic-obligations.ts). Evidence matching, obligation discharge and the
  "obligations.match_lexical_weight": weight(0, 1, [0.2, 0.34, 0.5]),
  "obligations.match_context_weight": weight(0, 1, [0.12, 0.25, 0.42]),
  "obligations.match_vector_weight": weight(0, 1, [0.1, 0.21, 0.38]),
  "obligations.match_field_mass_weight": weight(0, 1, [0.1, 0.2, 0.36]),
  "obligations.constraint_conflict_support_floor": threshold(0.05, 0.9, [0.15, 0.28, 0.45, 0.65]),
  "obligations.entity_conflict_support_floor": threshold(0.05, 0.9, [0.25, 0.46, 0.65]),
  "obligations.transform_support_lexical_weight": weight(0, 1, [0.25, 0.45, 0.65]),
  "obligations.transform_support_vector_weight": weight(0, 1, [0.18, 0.35, 0.55]),
  "obligations.transform_support_alpha_weight": weight(0, 1, [0.1, 0.2, 0.38]),
  "obligations.transform_satisfied_support_floor": threshold(0.05, 0.95, [0.2, 0.34, 0.55, 0.75]),
  "obligations.transform_underdetermined_support_floor": threshold(0.02, 0.6, [0.08, 0.16, 0.3, 0.45]),
  "obligations.role_satisfied_fit_floor": threshold(0.1, 0.95, [0.3, 0.48, 0.68]),
  "obligations.role_underdetermined_fit_floor": threshold(0.02, 0.7, [0.12, 0.22, 0.4]),
  "obligations.role_fit_shape_weight": weight(0, 1, [0.25, 0.45, 0.65]),
  "obligations.role_fit_lexical_weight": weight(0, 1, [0.12, 0.25, 0.45]),
  "obligations.role_fit_vector_weight": weight(0, 1, [0.15, 0.3, 0.5]),
  "obligations.latent_contradiction_floor": threshold(0.1, 0.95, [0.25, 0.42, 0.6, 0.8]),
  "obligations.verdict_contradiction_floor": threshold(0.1, 0.95, [0.25, 0.42, 0.6, 0.8]),
  "obligations.verdict_item_contradiction_floor": threshold(0.1, 0.95, [0.3, 0.48, 0.68]),
  "obligations.unadmitted_support_ceiling_floor": threshold(0.02, 0.7, [0.1, 0.18, 0.35]),
  "obligations.entailment_role_coverage_floor": threshold(0.1, 0.98, [0.25, 0.42, 0.62, 0.85]),
  "obligations.entailment_structural_coverage_floor": threshold(0.2, 0.98, [0.5, 0.72, 0.88]),
  "obligations.entailment_relation_compatibility_floor": threshold(0.05, 0.95, [0.2, 0.34, 0.55, 0.75]),
  "obligations.entailment_transformation_support_floor": threshold(0.05, 0.95, [0.2, 0.34, 0.55, 0.75]),
  "obligations.entailment_faithfulness_lcb_floor": threshold(0.02, 0.9, [0.1, 0.18, 0.35, 0.6]),
  "obligations.entailment_stability_floor": threshold(0.05, 0.95, [0.25, 0.42, 0.62]),
  "obligations.underdetermined_structural_coverage_floor": threshold(0.02, 0.9, [0.12, 0.25, 0.45]),
  "obligations.underdetermined_relation_compatibility_floor": threshold(0.02, 0.9, [0.14, 0.28, 0.5]),
  "obligations.underdetermined_causal_mass_floor": threshold(0.01, 0.6, [0.03, 0.05, 0.12, 0.3]),
  "obligations.relation_compatibility_warning_floor": threshold(0.02, 0.9, [0.12, 0.25, 0.45]),
  "obligations.faithfulness_lcb_warning_floor": threshold(0.02, 0.8, [0.06, 0.12, 0.25, 0.45]),
  "obligations.contradiction_pressure_explicit_weight": weight(0, 1, [0.28, 0.48, 0.68]),
  "obligations.contradiction_pressure_surface_weight": weight(0, 1, [0.16, 0.32, 0.52]),
  "obligations.contradiction_pressure_mass_weight": weight(0, 1, [0.1, 0.2, 0.38]),
  // --- semantic proof system (semantic-proof-system.ts). Atom unification, role and quantity matching, and
  "proof.certifying_role_floor": threshold(0.1, 0.98, [0.28, 0.45, 0.65, 0.85]),
  "proof.certifying_constraint_floor": threshold(0.1, 0.98, [0.45, 0.68, 0.85]),
  "proof.certifying_contradiction_ceiling": threshold(0.02, 0.8, [0.1, 0.22, 0.4]),
  "proof.agreement_predicate_weight": weight(0, 1, [0.2, 0.34, 0.52]),
  "proof.agreement_role_weight": weight(0, 1, [0.18, 0.32, 0.5]),
  "proof.agreement_constraint_weight": weight(0, 1, [0.08, 0.16, 0.32]),
  "proof.agreement_polarity_weight": weight(0, 1, [0.05, 0.1, 0.25]),
  "proof.agreement_transform_boost_weight": weight(0, 1, [0.04, 0.08, 0.2]),
  "proof.predicate_similarity_posterior_weight": weight(0, 1, [0.2, 0.35, 0.55]),
  "proof.predicate_similarity_lexical_weight": weight(0, 1, [0.12, 0.25, 0.45]),
  "proof.predicate_similarity_feature_weight": weight(0, 1, [0.12, 0.25, 0.45]),
  "proof.predicate_similarity_vector_weight": weight(0, 1, [0.08, 0.15, 0.3]),
  "proof.role_match_lexical_weight": weight(0, 1, [0.28, 0.48, 0.68]),
  "proof.role_match_feature_weight": weight(0, 1, [0.15, 0.3, 0.5]),
  "proof.role_match_type_bonus": weight(0, 0.6, [0.06, 0.12, 0.25]),
  "proof.role_match_name_bonus": weight(0, 0.6, [0.05, 0.1, 0.22]),
  "proof.role_match_name_prefix_bonus": weight(0, 0.4, [0.02, 0.04, 0.1]),
  "proof.role_match_accept_floor": threshold(0.02, 0.8, [0.1, 0.18, 0.35, 0.55]),
  "proof.quantity_overlap_weight": weight(0, 1, [0.35, 0.55, 0.75]),
  "proof.quantity_closeness_weight": weight(0, 1, [0.25, 0.45, 0.65]),
  "proof.polarity_counterexample_predicate_floor": threshold(0.1, 0.95, [0.28, 0.45, 0.65]),
  "proof.polarity_counterexample_role_floor": threshold(0.05, 0.95, [0.2, 0.35, 0.55]),
  "proof.verdict_contradiction_floor": threshold(0.1, 0.95, [0.35, 0.55, 0.75]),
  "proof.verdict_contradiction_dominance_ratio": threshold(0.3, 1.5, [0.6, 0.9, 1.2]),
  "proof.verdict_entailed_support_floor": threshold(0.3, 0.99, [0.55, 0.76, 0.9]),
  "proof.verdict_entailed_coverage_floor": threshold(0.2, 0.99, [0.5, 0.72, 0.88]),
  "proof.verdict_entailed_faithfulness_floor": threshold(0.1, 0.95, [0.28, 0.45, 0.65]),
  "proof.verdict_partial_support_floor": threshold(0.05, 0.9, [0.25, 0.42, 0.6]),
  "proof.verdict_partial_coverage_floor": threshold(0.05, 0.9, [0.2, 0.35, 0.55]),
  "proof.atom_alpha_own_weight": weight(0, 1, [0.45, 0.65, 0.85]),
  "proof.atom_alpha_field_mass_weight": weight(0, 1, [0.15, 0.35, 0.55]),
  // --- proof calculus (proof-calculus.ts). Witness scoring, operator boundary reporting and the epistemic
  "calculus.witness_support_floor": threshold(0.01, 0.5, [0.04, 0.08, 0.18, 0.35]),
  "calculus.witness_contradiction_floor": threshold(0.01, 0.6, [0.06, 0.12, 0.25, 0.45]),
  "calculus.flow_shortfall_floor": threshold(0.1, 0.98, [0.4, 0.62, 0.8]),
  "calculus.conservation_pressure_floor": threshold(0.1, 0.98, [0.5, 0.72, 0.9]),
  "calculus.consistency_pressure_floor": threshold(0.05, 0.95, [0.18, 0.32, 0.55]),
  "calculus.witness_coverage_weight": weight(0, 1, [0.12, 0.22, 0.4]),
  "calculus.witness_vector_weight": weight(0, 1, [0.08, 0.15, 0.3]),
  "calculus.witness_field_mass_weight": weight(0, 1, [0.09, 0.18, 0.35]),
  "calculus.witness_faithfulness_weight": weight(0, 1, [0.1, 0.2, 0.38]),
  "calculus.witness_provenance_weight": weight(0, 1, [0.08, 0.15, 0.3]),
  "calculus.witness_transform_weight": weight(0, 1, [0.05, 0.1, 0.25]),
  "calculus.witness_contradiction_penalty": weight(0, 1, [0.2, 0.4, 0.7]),
  "calculus.force_unknown_contradiction_floor": threshold(0.05, 0.95, [0.25, 0.45, 0.7]),
  "calculus.force_unknown_leakage_floor": threshold(0.1, 0.99, [0.5, 0.72, 0.9]),
  "calculus.force_proved_support_floor": threshold(0.3, 0.99, [0.6, 0.82, 0.94]),
  "calculus.force_proved_lcb_floor": threshold(0.2, 0.99, [0.4, 0.62, 0.85]),
  "calculus.force_observed_support_floor": threshold(0.1, 0.95, [0.4, 0.62, 0.82]),
  "calculus.force_observed_lcb_floor": threshold(0.05, 0.9, [0.2, 0.36, 0.6]),
  "calculus.force_inferred_support_floor": threshold(0.05, 0.9, [0.18, 0.34, 0.55]),
  "calculus.force_conjectured_support_floor": threshold(0.01, 0.7, [0.06, 0.12, 0.28])
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
