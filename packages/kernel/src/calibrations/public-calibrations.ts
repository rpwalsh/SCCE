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
  "tool_cognition.pattern_retention_utility_delta_floor": 0.28,
  // --- semantic obligations (semantic-obligations.ts). Evidence matching, obligation discharge and the
  // entailment verdict that decides whether a claim may be spoken.
  // The four match weights are one normalized set and must continue to sum to 1.
  /** Share of lexical overlap in how well an evidence candidate supports an obligation. semantic-obligations.ts rankedMatch. */
  "obligations.match_lexical_weight": 0.34,
  /** Share of surrounding-context overlap in obligation support. semantic-obligations.ts rankedMatch. */
  "obligations.match_context_weight": 0.25,
  /** Share of feature-vector similarity in obligation support. semantic-obligations.ts rankedMatch. */
  "obligations.match_vector_weight": 0.21,
  /** Share of field mass on the candidate's evidence in obligation support. semantic-obligations.ts rankedMatch. */
  "obligations.match_field_mass_weight": 0.2,
  /** Support a differing constraint must reach before it is treated as conflicting with the claim's. semantic-obligations.ts contradictoryConstraint. */
  "obligations.constraint_conflict_support_floor": 0.28,
  /** Support a differing entity must reach before it is treated as contradicting the claim's. semantic-obligations.ts contradictoryEntity. */
  "obligations.entity_conflict_support_floor": 0.46,
  // The three transform-support weights are one normalized set and must continue to sum to 1.
  /** Share of lexical overlap in how well a span supports a claim's transform obligation. semantic-obligations.ts transformObligations. */
  "obligations.transform_support_lexical_weight": 0.45,
  /** Share of feature-vector similarity in transform support. semantic-obligations.ts transformObligations. */
  "obligations.transform_support_vector_weight": 0.35,
  /** Share of the span's own alpha in transform support. semantic-obligations.ts transformObligations. */
  "obligations.transform_support_alpha_weight": 0.2,
  /** Safety-bearing: support at which a claim's transform obligation counts as discharged, which is one of the conditions for speaking the claim. semantic-obligations.ts transformObligations. */
  "obligations.transform_satisfied_support_floor": 0.34,
  /** Support below which a transform obligation is missing rather than merely underdetermined. semantic-obligations.ts transformObligations. */
  "obligations.transform_underdetermined_support_floor": 0.16,
  /** Safety-bearing: role fit at which a claim's role obligation counts as discharged by a span. semantic-obligations.ts roleObligations. */
  "obligations.role_satisfied_fit_floor": 0.48,
  /** Role fit below which the role obligation is missing rather than underdetermined. semantic-obligations.ts roleObligations. */
  "obligations.role_underdetermined_fit_floor": 0.22,
  // The three role-fit weights are one normalized set and must continue to sum to 1.
  /** Share of token-shape similarity in how well two roles match. semantic-obligations.ts roleFit. */
  "obligations.role_fit_shape_weight": 0.45,
  /** Share of lexical overlap in role match. semantic-obligations.ts roleFit. */
  "obligations.role_fit_lexical_weight": 0.25,
  /** Share of feature-vector similarity in role match. semantic-obligations.ts roleFit. */
  "obligations.role_fit_vector_weight": 0.3,
  /** Contradiction surface and contradiction mass below which no latent contradiction obligation is raised; applied to both quantities. semantic-obligations.ts latentContradictionObligations. */
  "obligations.latent_contradiction_floor": 0.42,
  /** Safety-bearing: aggregate contradiction at which the entailment verdict becomes contradicted and the claim is not spoken. semantic-obligations.ts entailmentVerdict. */
  "obligations.verdict_contradiction_floor": 0.42,
  /** Safety-bearing: contradiction on a single contradicted obligation that is enough to make the whole verdict contradicted. semantic-obligations.ts entailmentVerdict. */
  "obligations.verdict_item_contradiction_floor": 0.48,
  /** Best support an unadmitted proof must still show for the verdict to be underdetermined rather than unknown. semantic-obligations.ts entailmentVerdict. */
  "obligations.unadmitted_support_ceiling_floor": 0.18,
  // The next five are the conjunction that admits an entailed verdict. Every one is safety-bearing: a claim is
  // only spoken as entailed when all of them are met, so lowering any of them speaks weaker claims.
  /** Role coverage an entailed verdict requires. semantic-obligations.ts entailmentVerdict. */
  "obligations.entailment_role_coverage_floor": 0.42,
  /** Structural coverage an entailed verdict requires. semantic-obligations.ts entailmentVerdict. */
  "obligations.entailment_structural_coverage_floor": 0.72,
  /** Relation compatibility an entailed verdict requires. semantic-obligations.ts entailmentVerdict. */
  "obligations.entailment_relation_compatibility_floor": 0.34,
  /** Transformation support an entailed verdict requires. semantic-obligations.ts entailmentVerdict. */
  "obligations.entailment_transformation_support_floor": 0.34,
  /** Lower confidence bound on faithfulness an entailed verdict requires. semantic-obligations.ts entailmentVerdict. */
  "obligations.entailment_faithfulness_lcb_floor": 0.18,
  /** Stability an entailed verdict requires. semantic-obligations.ts entailmentVerdict. */
  "obligations.entailment_stability_floor": 0.42,
  // Any one of the next three keeps a failed entailment at underdetermined instead of unknown.
  /** Structural coverage that keeps a verdict underdetermined rather than unknown. semantic-obligations.ts entailmentVerdict. */
  "obligations.underdetermined_structural_coverage_floor": 0.25,
  /** Relation compatibility that keeps a verdict underdetermined rather than unknown. semantic-obligations.ts entailmentVerdict. */
  "obligations.underdetermined_relation_compatibility_floor": 0.28,
  /** Causal mass that keeps a verdict underdetermined rather than unknown. semantic-obligations.ts entailmentVerdict. */
  "obligations.underdetermined_causal_mass_floor": 0.05,
  /** Relation compatibility below which the proof reports relation-compatibility-low. semantic-obligations.ts proofWarnings. */
  "obligations.relation_compatibility_warning_floor": 0.25,
  /** Faithfulness lower bound below which the proof reports faithfulness-lcb-low. semantic-obligations.ts proofWarnings. */
  "obligations.faithfulness_lcb_warning_floor": 0.12,
  // The three contradiction-pressure weights are one normalized set and must continue to sum to 1.
  /** Share of explicitly contradicted obligations in overall contradiction pressure. semantic-obligations.ts contradictionPressure. */
  "obligations.contradiction_pressure_explicit_weight": 0.48,
  /** Share of the field's contradiction surface in overall contradiction pressure. semantic-obligations.ts contradictionPressure. */
  "obligations.contradiction_pressure_surface_weight": 0.32,
  /** Share of the field's contradiction mass in overall contradiction pressure. semantic-obligations.ts contradictionPressure. */
  "obligations.contradiction_pressure_mass_weight": 0.2,
  // --- semantic proof system (semantic-proof-system.ts). Atom unification, role and quantity matching, and
  // the proof verdict.
  // Safety-bearing block: certifyingUnification decides whether a unification may back a certified fact.
  /** Safety-bearing: role agreement a unification must reach to certify a fact. semantic-proof-system.ts certifyingUnification. */
  "proof.certifying_role_floor": 0.45,
  /** Safety-bearing: constraint agreement a unification must reach to certify a fact. semantic-proof-system.ts certifyingUnification. */
  "proof.certifying_constraint_floor": 0.68,
  /** Safety-bearing: contradiction above which a unification may not certify a fact. semantic-proof-system.ts certifyingUnification. */
  "proof.certifying_contradiction_ceiling": 0.22,
  // The five agreement weights are one normalized set and must continue to sum to 1.
  /** Share of predicate similarity in how far two atoms agree. semantic-proof-system.ts unifyAtoms. */
  "proof.agreement_predicate_weight": 0.34,
  /** Share of role similarity in atom agreement. semantic-proof-system.ts unifyAtoms. */
  "proof.agreement_role_weight": 0.32,
  /** Share of constraint similarity in atom agreement. semantic-proof-system.ts unifyAtoms. */
  "proof.agreement_constraint_weight": 0.16,
  /** Share of matching polarity in atom agreement. semantic-proof-system.ts unifyAtoms. */
  "proof.agreement_polarity_weight": 0.1,
  /** Share of the transform support boost in atom agreement. semantic-proof-system.ts unifyAtoms. */
  "proof.agreement_transform_boost_weight": 0.08,
  // The four predicate-similarity weights are one normalized set and must continue to sum to 1.
  /** Share of the learned relation posterior in predicate similarity. semantic-proof-system.ts predicateSimilarity. */
  "proof.predicate_similarity_posterior_weight": 0.35,
  /** Share of edit-level lexical similarity in predicate similarity. semantic-proof-system.ts predicateSimilarity. */
  "proof.predicate_similarity_lexical_weight": 0.25,
  /** Share of predicate feature overlap in predicate similarity. semantic-proof-system.ts predicateSimilarity. */
  "proof.predicate_similarity_feature_weight": 0.25,
  /** Share of atom vector cosine in predicate similarity. semantic-proof-system.ts predicateSimilarity. */
  "proof.predicate_similarity_vector_weight": 0.15,
  /** Share of lexical similarity in how well two role fillers match. semantic-proof-system.ts roleSimilarity. */
  "proof.role_match_lexical_weight": 0.48,
  /** Share of feature overlap in how well two role fillers match. semantic-proof-system.ts roleSimilarity. */
  "proof.role_match_feature_weight": 0.3,
  /** Bonus added when two role fillers share a role type. semantic-proof-system.ts roleSimilarity. */
  "proof.role_match_type_bonus": 0.12,
  /** Bonus added when two role fillers carry the same role name. semantic-proof-system.ts roleSimilarity. */
  "proof.role_match_name_bonus": 0.1,
  /** Bonus added when two role names share a leading fragment. semantic-proof-system.ts roleSimilarity. */
  "proof.role_match_name_prefix_bonus": 0.04,
  /** Score the best candidate must reach before a claim role counts as matched by an evidence role. semantic-proof-system.ts roleSimilarity. */
  "proof.role_match_accept_floor": 0.18,
  // Interval overlap and value closeness are one normalized pair and must continue to sum to 1.
  /** Share of interval overlap in how far two quantities agree. semantic-proof-system.ts quantitySimilarity. */
  "proof.quantity_overlap_weight": 0.55,
  /** Share of point-value closeness in how far two quantities agree. semantic-proof-system.ts quantitySimilarity. */
  "proof.quantity_closeness_weight": 0.45,
  /** Predicate similarity above which opposed polarity is reported as a polarity counterexample rather than an unrelated atom. semantic-proof-system.ts contradictionReason. */
  "proof.polarity_counterexample_predicate_floor": 0.45,
  /** Role agreement above which opposed polarity is reported as a polarity counterexample. semantic-proof-system.ts contradictionReason. */
  "proof.polarity_counterexample_role_floor": 0.35,
  // The verdict thresholds are all safety-bearing: they decide entailed, partial, contradicted or
  // underdetermined, and only an entailed or partial proof lets a claim be spoken as sourced.
  /** Safety-bearing: contradiction at which a proof is refuted outright. semantic-proof-system.ts verdictFrom. */
  "proof.verdict_contradiction_floor": 0.55,
  /** Safety-bearing: how far contradiction must exceed support, as a multiple of support, before a proof is refuted. semantic-proof-system.ts verdictFrom. */
  "proof.verdict_contradiction_dominance_ratio": 0.9,
  /** Safety-bearing: support an admitted proof needs to be entailed. semantic-proof-system.ts verdictFrom. */
  "proof.verdict_entailed_support_floor": 0.76,
  /** Safety-bearing: claim coverage an admitted proof needs to be entailed. semantic-proof-system.ts verdictFrom. */
  "proof.verdict_entailed_coverage_floor": 0.72,
  /** Safety-bearing: faithfulness lower bound an admitted proof needs to be entailed. semantic-proof-system.ts verdictFrom. */
  "proof.verdict_entailed_faithfulness_floor": 0.45,
  /** Safety-bearing: support a proof needs to be partial rather than underdetermined. semantic-proof-system.ts verdictFrom. */
  "proof.verdict_partial_support_floor": 0.42,
  /** Safety-bearing: claim coverage a proof needs to be partial rather than underdetermined. semantic-proof-system.ts verdictFrom. */
  "proof.verdict_partial_coverage_floor": 0.35,
  /** Share of an atom's own alpha when field mass reweights it; pairs with the field-mass share and the two must continue to sum to 1. semantic-proof-system.ts fieldWeightedAtoms. */
  "proof.atom_alpha_own_weight": 0.65,
  /** Share of field mass when it reweights an atom's alpha. semantic-proof-system.ts fieldWeightedAtoms. */
  "proof.atom_alpha_field_mass_weight": 0.35,
  // --- proof calculus (proof-calculus.ts). Witness scoring, operator boundary reporting and the epistemic
  // force ladder.
  /** Support a witness must exceed before it counts as supporting the claim at all. proof-calculus.ts evaluate. */
  "calculus.witness_support_floor": 0.08,
  /** Contradiction a witness must exceed before it counts as contradicting the claim. proof-calculus.ts evaluate. */
  "calculus.witness_contradiction_floor": 0.12,
  /** Unmet flow ratio above which the proof reports an operator flow shortfall. proof-calculus.ts operatorBoundaryReasons. */
  "calculus.flow_shortfall_floor": 0.62,
  /** Kirchhoff imbalance above which the proof reports conservation pressure. proof-calculus.ts operatorBoundaryReasons. */
  "calculus.conservation_pressure_floor": 0.72,
  /** Potts contradiction pressure above which the proof reports consistency pressure. proof-calculus.ts operatorBoundaryReasons. */
  "calculus.consistency_pressure_floor": 0.32,
  // The six positive witness weights are one normalized set and must continue to sum to 1; the contradiction
  // penalty is subtracted from that sum and is not part of it.
  /** Share of directional claim coverage in a witness's support. proof-calculus.ts witness. */
  "calculus.witness_coverage_weight": 0.22,
  /** Share of feature-vector agreement in a witness's support. proof-calculus.ts witness. */
  "calculus.witness_vector_weight": 0.15,
  /** Share of field mass on the witness's graph nodes in its support. proof-calculus.ts witness. */
  "calculus.witness_field_mass_weight": 0.18,
  /** Share of windowed faithfulness in a witness's support. proof-calculus.ts witness. */
  "calculus.witness_faithfulness_weight": 0.2,
  /** Share of provenance strength in a witness's support. proof-calculus.ts witness. */
  "calculus.witness_provenance_weight": 0.15,
  /** Share of transformation confidence in a witness's support. proof-calculus.ts witness. */
  "calculus.witness_transform_weight": 0.1,
  /** How much a witness's own contradiction is subtracted from its support. proof-calculus.ts witness. */
  "calculus.witness_contradiction_penalty": 0.4,
  // The epistemic force ladder is safety-bearing: it decides whether a claim is reported as proved, observed,
  // inferred, conjectured or invented, which is what a reader is told about how far to trust it.
  /** Safety-bearing: contradiction above which the epistemic force is unknown, whatever the support. proof-calculus.ts forceFrom. */
  "calculus.force_unknown_contradiction_floor": 0.45,
  /** Safety-bearing: source leakage above which the epistemic force is unknown. proof-calculus.ts forceFrom. */
  "calculus.force_unknown_leakage_floor": 0.72,
  /** Safety-bearing: support a claim needs to be called proved. proof-calculus.ts forceFrom. */
  "calculus.force_proved_support_floor": 0.82,
  /** Safety-bearing: lower confidence bound a claim needs to be called proved. proof-calculus.ts forceFrom. */
  "calculus.force_proved_lcb_floor": 0.62,
  /** Safety-bearing: support a claim needs to be called observed. proof-calculus.ts forceFrom. */
  "calculus.force_observed_support_floor": 0.62,
  /** Safety-bearing: lower confidence bound a claim needs to be called observed. proof-calculus.ts forceFrom. */
  "calculus.force_observed_lcb_floor": 0.36,
  /** Safety-bearing: support a claim needs to be called inferred rather than conjectured. proof-calculus.ts forceFrom. */
  "calculus.force_inferred_support_floor": 0.34,
  /** Safety-bearing: support a claim needs to be called conjectured rather than invented. proof-calculus.ts forceFrom. */
  "calculus.force_conjectured_support_floor": 0.12,
  // --- translation (translation.ts). Frame alignment preservation, target selection and translation force.
  // The seven preservation weights are one normalized set and must continue to sum to 1.
  /** Share of semantic agreement in how much meaning a frame alignment preserves. translation.ts alignFrames. */
  "translation.preservation_semantic_weight": 0.26,
  /** Share of role-topology agreement in alignment preservation. translation.ts alignFrames. */
  "translation.preservation_topology_weight": 0.22,
  /** Share of script fit to the target language profile in alignment preservation. translation.ts alignFrames. */
  "translation.preservation_script_fit_weight": 0.19,
  /** Share of target evidence mass in alignment preservation. translation.ts alignFrames. */
  "translation.preservation_evidence_mass_weight": 0.11,
  /** Share of the learned alignment prior in alignment preservation. translation.ts alignFrames. */
  "translation.preservation_prior_boost_weight": 0.06,
  /** Share of confident seed overlap in alignment preservation. translation.ts alignFrames. */
  "translation.preservation_seed_overlap_weight": 0.1,
  /** Share of multi-symbol construction overlap in alignment preservation. translation.ts alignFrames. */
  "translation.preservation_construction_overlap_weight": 0.06,
  // Script mass and profile feature overlap are one normalized pair and must continue to sum to 1.
  /** Share of script mass in how well a frame fits a language profile. translation.ts scriptFitScore. */
  "translation.script_fit_mass_weight": 0.45,
  /** Share of profile n-gram and shape overlap in frame-to-profile fit. translation.ts scriptFitScore. */
  "translation.script_fit_profile_overlap_weight": 0.55,
  /** Margin the leading target cluster must hold over the runner-up before a translation target is chosen at all; below it the frame is left unaligned. translation.ts selectTargetCluster. */
  "translation.cluster_margin_floor": 0.12,
  // The force ladders below are safety-bearing: a translation reported as direct is presented as carrying the
  // source meaning, while gloss and unknown mark a rendering the turn must not assert.
  /** Safety-bearing: preservation a single alignment needs, with evidence behind it, to be called direct. translation.ts forceFromPreservation. */
  "translation.direct_preservation_floor": 0.74,
  /** Safety-bearing: preservation an alignment needs to be called approximate rather than a gloss. translation.ts forceFromPreservation. */
  "translation.approximate_preservation_floor": 0.48,
  /** Preservation below which an alignment's force is unknown rather than a gloss. translation.ts forceFromPreservation. */
  "translation.gloss_preservation_floor": 0.16,
  /** Safety-bearing: fraction of alignments that must themselves be direct for the whole translation to be called direct. translation.ts aggregateForce. */
  "translation.aggregate_direct_share_floor": 0.7,
  /** Safety-bearing: mean preservation the whole translation needs to be called direct. translation.ts aggregateForce. */
  "translation.aggregate_direct_preservation_floor": 0.72,
  /** Safety-bearing: mean preservation the whole translation needs to be called approximate. translation.ts aggregateForce. */
  "translation.aggregate_approximate_preservation_floor": 0.46,
  /** Mean preservation below which the whole translation's force is unknown rather than a gloss. translation.ts aggregateForce. */
  "translation.aggregate_gloss_preservation_floor": 0.12,
  /** Preservation below which an alignment's source symbols are reported as uncertain terms. translation.ts translationTurnReport. */
  "translation.uncertain_term_preservation_floor": 0.48,
  // Emission preservation and low objective energy are one normalized pair and must continue to sum to 1.
  /** Share of emission preservation in the reported semantic preservation score. translation.ts translationTurnReport. */
  "translation.semantic_score_preservation_weight": 0.55,
  /** Share of low objective energy in the reported semantic preservation score. translation.ts translationTurnReport. */
  "translation.semantic_score_energy_weight": 0.45
});

export type CalibrationKey = keyof typeof PUBLIC_CALIBRATIONS;

/** Every id in the public table, for callers that need to report or diff coverage. */
export const PUBLIC_CALIBRATION_IDS = Object.freeze(Object.keys(PUBLIC_CALIBRATIONS) as CalibrationKey[]);
