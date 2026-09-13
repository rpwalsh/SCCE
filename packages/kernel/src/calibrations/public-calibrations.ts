// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.

/**
 * The public bootstrap values for constants that were hand-set inline.
 *
 * Every value here was moved verbatim from the call site named in its comment, so installing this table changes
 * no behaviour. What changes is that each value now has an id, which is what the private side needs in order to
 * override one: a fitted value cannot replace a literal buried in an expression.
 *
 * These are BOOTSTRAP values, not measured ones. `calibration_observations` currently carries two ids
 * (candidate.mass, judge.requirement_weights), so none of the values below has ever been fitted -- they are
 * defaults that happened to work, and several have been measured deciding answers on their own:
 * units.prefix_ratio_floor decided whether "Kenya's" names Kenya (5/7 = 0.714 against 0.72), and
 * ranking.title_lead_boost outranked a BM25 gap of 8.2 against 4.8.
 *
 * Ids follow calibration-spine.ts's convention: subsystem, then what the value governs.
 */
export const PUBLIC_CALIBRATIONS = Object.freeze({
  // --- request unit matching (local-evidence-runtime.ts requestUnitMatchesSurface / requestUnitSimilarity / requestUnitSharesStem)
  /** Shared prefix as a fraction of the longer unit, above which two surface forms are the same unit. */
  "units.prefix_ratio_floor": 0.72,
  /** Similarity above which two surface forms are the same unit. */
  "units.similarity_floor": 0.72,
  /** Similarity awarded when one unit contains the other. */
  "units.containment_similarity": 0.82,
  /** Length ratio required before containment counts as similarity at all. */
  "units.containment_ratio_floor": 0.72,
  /** Edit distance beyond which two units are unrelated. */
  "units.edit_distance_cap": 3,
  /** Characters of shared prefix required for a shared stem. */
  "units.stem_shared_prefix_min": 4,
  /** Shared prefix as a fraction of the longer unit, required for a shared stem. */
  "units.stem_shared_ratio_floor": 0.6,
  /** Unit length at or above which a full surface match also proves a shared stem. */
  "units.stem_direct_match_min_length": 5,

  // --- sentence ranking, shared by both rankers in local-evidence-runtime.ts
  /** Weight on the count of request content units the sentence carries. */
  "ranking.unit_overlap_weight": 0.92,
  /** Weight on weighted-Jaccard similarity between request and sentence features. */
  "ranking.lexical_similarity_weight": 0.35,
  /** Flat bonus for a sentence that matches one of the request's source anchors. */
  "ranking.anchor_boost": 0.54,
  /** Flat bonus for the titled source's lead, or for the sentence the coverage transfer moved it to. */
  "ranking.title_lead_boost": 4,
  /** Weight on how completely the request names this span's own title. */
  "ranking.source_affinity_weight": 3,
  /** Penalty per fragment signal (lowercase-initial opening, dangling tail). */
  "ranking.fragment_penalty": 1.2,
  /** Weight on a sentence the request near-duplicates; must outrank title lead plus affinity. */
  "ranking.near_duplicate_weight": 12,
  /** Ordered-adjacent-pair fraction above which a sentence counts as near-duplicated by the request. */
  "ranking.near_duplicate_fraction_floor": 0.5,
  /** How many ranked sentences the anchor-predication preference may reorder. */
  "ranking.anchor_predication_rerank_limit": 8,

  // --- ranker-specific: the two rankers claim to mirror each other and do not
  /** proposeSourceExactEvidenceAnswer: affinity multiplier when this is not the primary title. */
  "ranking.exact.source_affinity_secondary_title_factor": 0.7,
  /** proposeSourceExactEvidenceAnswer: bonus for appearing early in the span. */
  "ranking.exact.source_order_bonus": 0.16,
  /** proposeSourceExactEvidenceAnswer: decay of that bonus per sentence. */
  "ranking.exact.source_order_decay": 0.018,
  /** bestEvidenceSentences: bonus for appearing early in the span. */
  "ranking.best.source_order_bonus": 0.18,
  /** bestEvidenceSentences: decay of that bonus per sentence. */
  "ranking.best.source_order_decay": 0.015,
  /** bestEvidenceSentences: weight on adjacent request unit pairs the sentence preserves. */
  "ranking.best.pair_overlap_weight": 0.16,
  /** bestEvidenceSentences: weight on the evidence span's own alpha. */
  "ranking.best.evidence_alpha_weight": 0.12,

  // --- local evidence answer plan admission (local-evidence-runtime.ts)
  /** Claim-versus-evidence contradiction at or above which no plain answer is produced. */
  "plan.contradiction_block": 0.72,
  /** Contradiction at or above which an unanchored answer is blocked. */
  "plan.contradiction_unanchored_block": 0.45,
  /** Relevance below which an unbound, non-session answer is not worth producing. */
  "plan.relevance_floor": 0.035,

  // --- temporal development context scoring (local-evidence-runtime.ts temporalDevelopmentContextSentence)
  "temporal_context.concept_coverage_weight": 0.18,
  "temporal_context.breadth_weight": 0.16,
  "temporal_context.distinctness_weight": 0.16,
  "temporal_context.preceding_proximity_weight": 0.20,
  "temporal_context.temporal_neighborhood_weight": 0.18,
  "temporal_context.source_order_weight": 0.07,
  "temporal_context.length_fitness_weight": 0.05,
  "temporal_context.numeric_specificity_penalty": 0.10,
  "temporal_context.named_specificity_penalty": 0.10,
  "temporal_context.point_date_specificity_penalty": 0.22,
  "temporal_context.repetition_pressure_penalty": 0.18,

  // --- field operators (field.ts fieldOperatorTrace). Ten iterative operations run on EVERY activation.
  // These four were written inline and never declared, so no coverage audit could see them and no fit could
  // reach them. None is derived from anything: they are the values the operators were first written with.
  /** Heat diffusion steps per activation. Unjustified; the operator's cost scales with it. */
  "field.heat_diffusion_steps": 3,
  /** Wave propagation steps per activation. Unjustified. */
  "field.wave_propagation_steps": 1,
  /** Wave damping. Unjustified. */
  "field.wave_damping": 0.08,
  /** Spectral partition power iterations per activation. Unjustified; the most expensive of the three. */
  "field.spectral_partition_iterations": 6,

  // --- tool cognition (tool-cognition.ts). Objective analysis, capability scoring, approval and outcome learning.
  // The four risk-surface weights are one normalized set and must continue to sum to 1.
  /** Share of the alpha risk surface in the objective risk score. tool-cognition.ts analyzeObjectives. */
  "tool_cognition.risk_surface_alpha_weight": 0.35,
  /** Share of the contradiction surface in the objective risk score. tool-cognition.ts analyzeObjectives. */
  "tool_cognition.risk_surface_contradiction_weight": 0.25,
  /** Share of the drift surface in the objective risk score. tool-cognition.ts analyzeObjectives. */
  "tool_cognition.risk_surface_drift_weight": 0.2,
  /** Share of un-bondedness (1 - bond) in the objective risk score. tool-cognition.ts analyzeObjectives. */
  "tool_cognition.risk_surface_unbonded_weight": 0.2,
  /** Risk assumed when the field carries no alpha trace to measure, so tools are planned blind. tool-cognition.ts analyzeObjectives. */
  "tool_cognition.risk_surface_default": 0.35,
  // The next three plus the 0.25 base share total 1: how much missing evidence, a thin field and risk each raise
  // the evidence an objective demands before it is satisfied.
  /** How much absent evidence raises an objective's required evidence. tool-cognition.ts analyzeObjectives baseExpected. */
  "tool_cognition.expected_evidence_gap_weight": 0.45,
  /** How much a thin field raises an objective's required evidence. tool-cognition.ts analyzeObjectives baseExpected. */
  "tool_cognition.expected_field_gap_weight": 0.2,
  /** How much measured risk raises an objective's required evidence. tool-cognition.ts analyzeObjectives baseExpected. */
  "tool_cognition.expected_risk_weight": 0.1,
  /** Pressure below which an objective is not raised at all, so no tool is ever planned for it. tool-cognition.ts analyzeObjectives. */
  "tool_cognition.objective_pressure_floor": 0.08,
  /** Capability-to-objective fit below which the pairing is not scored. tool-cognition.ts scoreCapabilities. */
  "tool_cognition.capability_fit_floor": 0.04,
  // Fit and expected value of information are one normalized pair and must continue to sum to 1.
  /** Share of objective fit in a capability's utility. tool-cognition.ts scoreCapabilities. */
  "tool_cognition.utility_fit_weight": 0.55,
  /** Share of expected value of information in a capability's utility. tool-cognition.ts scoreCapabilities. */
  "tool_cognition.utility_evi_weight": 0.45,
  /** How steeply risk discounts a capability's utility, so risky tools lose to safe ones. tool-cognition.ts scoreCapabilities. */
  "tool_cognition.utility_risk_discount": 0.42,
  // The three capability-fit weights are one normalized set and must continue to sum to 1.
  /** Share of objective-kind match in capability fit. tool-cognition.ts capabilityFit. */
  "tool_cognition.capability_fit_kind_weight": 0.62,
  /** Share of phase suitability (read/prepare/commit) in capability fit. tool-cognition.ts capabilityFit. */
  "tool_cognition.capability_fit_phase_weight": 0.23,
  /** Share of connector-metadata overlap in capability fit. tool-cognition.ts capabilityFit. */
  "tool_cognition.capability_fit_metadata_weight": 0.15,
  // The five capability-risk weights are one normalized set and must continue to sum to 1. Safety-bearing:
  // this score decides approval mode and is compared against the policy's alpha risk ceiling.
  /** Share of the connector's own declared risk in capability risk. tool-cognition.ts capabilityRisk. */
  "tool_cognition.capability_risk_base_weight": 0.32,
  /** Share of mutation pressure in capability risk. tool-cognition.ts capabilityRisk. */
  "tool_cognition.capability_risk_mutation_weight": 0.24,
  /** Share of privacy pressure in capability risk. tool-cognition.ts capabilityRisk. */
  "tool_cognition.capability_risk_privacy_weight": 0.2,
  /** Share of network exposure in capability risk. tool-cognition.ts capabilityRisk. */
  "tool_cognition.capability_risk_network_weight": 0.14,
  /** Share of spend exposure in capability risk. tool-cognition.ts capabilityRisk. */
  "tool_cognition.capability_risk_spend_weight": 0.1,
  // Phase value and connector value are one normalized pair and must continue to sum to 1.
  /** Share of phase value in expected value of information. tool-cognition.ts expectedValueOfInformation. */
  "tool_cognition.evi_phase_weight": 0.58,
  /** Share of connector-specific value in expected value of information. tool-cognition.ts expectedValueOfInformation. */
  "tool_cognition.evi_connector_weight": 0.42,
  /** How steeply risk discounts expected value of information. tool-cognition.ts expectedValueOfInformation. */
  "tool_cognition.evi_risk_discount": 0.3,
  /** Capability risk above which a human approval is required. Safety-bearing: below it a tool runs unattended. tool-cognition.ts approvalModeFor. */
  "tool_cognition.approval_risk_ceiling": 0.35,
  /** Objective privacy pressure above which a human approval is required. Safety-bearing. tool-cognition.ts approvalModeFor and approvalReasons. */
  "tool_cognition.approval_privacy_pressure_ceiling": 0.55,
  /** Risk above which a standing operator grant stops substituting for explicit approval. Safety-bearing: it caps how much a blanket grant can authorize. tool-cognition.ts approvalModeFor. */
  "tool_cognition.operator_grant_risk_ceiling": 0.82,
  /** Mutation pressure above which the plan is explained as needing two-phase handling. tool-cognition.ts approvalReasons. */
  "tool_cognition.mutation_pressure_two_phase_floor": 0.55,
  /** Utility below which a scored capability is dropped from a plan that already has one. tool-cognition.ts selectPlans. */
  "tool_cognition.plan_utility_floor": 0.12,
  /** Mutation pressure above which a plan's reported risk vector is flagged as mutating. tool-cognition.ts capabilityPlansFor. */
  "tool_cognition.risk_vector_mutation_floor": 0.4,
  /** Network pressure above which a plan's reported risk vector is flagged as networked. tool-cognition.ts capabilityPlansFor. */
  "tool_cognition.risk_vector_network_floor": 0.35,
  /** Risk below which an approval request may be satisfied by a temporary operator grant. Safety-bearing. tool-cognition.ts approvalControls. */
  "tool_cognition.operator_grant_eligibility_risk_ceiling": 0.72,
  /** Utility a selected capability must reach before an objective stops being reported as a capability gap. tool-cognition.ts capabilityGaps. */
  "tool_cognition.capability_gap_utility_floor": 0.28,
  // The three outcome weights are one normalized set and must continue to sum to 1.
  /** Share of evidence produced in an outcome's productivity. tool-cognition.ts learningSignalFor. */
  "tool_cognition.outcome_evidence_weight": 0.45,
  /** Share of artifacts produced in an outcome's productivity. tool-cognition.ts learningSignalFor. */
  "tool_cognition.outcome_artifact_weight": 0.35,
  /** Share of plain success in an outcome's productivity. tool-cognition.ts learningSignalFor. */
  "tool_cognition.outcome_success_weight": 0.2,
  /** How much money spent discounts the learned utility of an outcome. tool-cognition.ts learningSignalFor. */
  "tool_cognition.outcome_spend_penalty_weight": 0.18,
  /** How much elapsed time discounts the learned utility of an outcome. tool-cognition.ts learningSignalFor. */
  "tool_cognition.outcome_duration_penalty_weight": 0.08,
  // Success and low risk are one normalized pair and must continue to sum to 1.
  /** Share of success in learned connector reliability. tool-cognition.ts learningSignalFor. */
  "tool_cognition.connector_reliability_success_weight": 0.55,
  /** Share of low observed risk in learned connector reliability. tool-cognition.ts learningSignalFor. */
  "tool_cognition.connector_reliability_risk_weight": 0.45,
  /** Connector reliability a tool episode must reach before it is retained as a reusable pattern. tool-cognition.ts learningSignalFor. */
  "tool_cognition.pattern_retention_reliability_floor": 0.62,
  /** Utility gain a tool episode must show before it is retained as a reusable pattern. tool-cognition.ts learningSignalFor. */
  "tool_cognition.pattern_retention_utility_delta_floor": 0.28
});

export type CalibrationKey = keyof typeof PUBLIC_CALIBRATIONS;

/** Every id in the public table, for callers that need to report or diff coverage. */
export const PUBLIC_CALIBRATION_IDS = Object.freeze(Object.keys(PUBLIC_CALIBRATIONS) as CalibrationKey[]);
