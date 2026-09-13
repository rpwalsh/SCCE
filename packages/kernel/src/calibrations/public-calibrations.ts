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

  // --- judge.ts: candidate scoring and requirement-driven penalty weights
  // requirementPenaltyWeights: each penalty is a floor plus requirement-scaled terms. The floor is what the
  // penalty costs a candidate when the turn asks for none of that property at all.
  /** Contradiction penalty when the turn demands no external truth. judge.ts requirementPenaltyWeights. */
  "judge.contradiction_penalty_floor": 0.28,
  /** How much demanded external-truth authority raises the contradiction penalty. judge.ts requirementPenaltyWeights. */
  "judge.contradiction_penalty_authority_weight": 0.54,
  /** How much demanded inferential depth raises the contradiction penalty. judge.ts requirementPenaltyWeights. */
  "judge.contradiction_penalty_inferential_depth_weight": 0.16,
  /** Unsupported-fact penalty when the turn demands no external truth. judge.ts requirementPenaltyWeights. */
  "judge.unsupported_fact_penalty_floor": 0.36,
  /** How much demanded external-truth authority raises the unsupported-fact penalty. judge.ts requirementPenaltyWeights. */
  "judge.unsupported_fact_penalty_authority_weight": 0.62,
  /** How much demanded source dependence raises the unsupported-fact penalty. judge.ts requirementPenaltyWeights. */
  "judge.unsupported_fact_penalty_source_dependence_weight": 0.22,
  /** Stale-source penalty when the turn depends on no source. judge.ts requirementPenaltyWeights. */
  "judge.stale_source_penalty_floor": 0.30,
  /** How much demanded source dependence raises the stale-source penalty. judge.ts requirementPenaltyWeights. */
  "judge.stale_source_penalty_source_dependence_weight": 0.35,
  /** How much demanded executable artifact raises the stale-source penalty. judge.ts requirementPenaltyWeights. */
  "judge.stale_source_penalty_executable_demand_weight": 0.25,

  /** Executable-artifact demand at or above which a failed validation fails the candidate outright. judge.ts candidate gate. */
  "judge.executable_artifact_demand_floor": 0.65,

  // Proof sub-score: a normalized set, must continue to sum to 1. judge.ts scoreCandidate.
  /** Weight of epistemic force (proved/observed/...) in the proof sub-score. judge.ts scoreCandidate. */
  "judge.proof_epistemic_force_weight": 0.35,
  /** Weight of evidential support in the proof sub-score. judge.ts scoreCandidate. */
  "judge.proof_support_weight": 0.28,
  /** Weight of faithfulness to the evidence in the proof sub-score. judge.ts scoreCandidate. */
  "judge.proof_faithfulness_weight": 0.22,
  /** Weight of how much of the evidence the answer covers, in the proof sub-score. judge.ts scoreCandidate. */
  "judge.proof_evidence_coverage_weight": 0.15,

  // Field sub-score: a normalized set, must continue to sum to 1. judge.ts scoreCandidate.
  /** Weight of alpha pressure (field urgency) in the field sub-score. judge.ts scoreCandidate. */
  "judge.field_alpha_pressure_weight": 0.38,
  /** Weight of actionability in the field sub-score. judge.ts scoreCandidate. */
  "judge.field_actionability_weight": 0.25,
  /** Weight of realizability in the field sub-score. judge.ts scoreCandidate. */
  "judge.field_realizability_weight": 0.2,
  /** Weight of novelty in the field sub-score. judge.ts scoreCandidate. */
  "judge.field_novelty_weight": 0.17,

  // Risk sub-score: a normalized set, must continue to sum to 1. judge.ts scoreCandidate.
  /** Weight of measured contradiction in the risk sub-score. judge.ts scoreCandidate. */
  "judge.risk_contradiction_weight": 0.6,
  /** Weight of the candidate declaring boundaries in the risk sub-score. judge.ts scoreCandidate. */
  "judge.risk_boundary_weight": 0.25,
  /** Weight of a restrictive policy alpha-risk ceiling in the risk sub-score. judge.ts scoreCandidate. */
  "judge.risk_policy_ceiling_weight": 0.15,

  // Final factual candidate score. Not normalized: the two penalties are subtracted. judge.ts scoreCandidate.
  /** Weight of the proof sub-score in the final candidate score. judge.ts scoreCandidate. */
  "judge.total_proof_weight": 0.32,
  /** Weight of the field sub-score in the final candidate score. judge.ts scoreCandidate. */
  "judge.total_field_weight": 0.24,
  /** Weight of the validation-graph score in the final candidate score. judge.ts scoreCandidate. */
  "judge.total_validation_weight": 0.2,
  /** Weight of realizability in the final candidate score. judge.ts scoreCandidate. */
  "judge.total_realizability_weight": 0.12,
  /** Weight of the candidate's surface mass in the final candidate score. judge.ts scoreCandidate. */
  "judge.total_mass_weight": 0.12,
  /** How much the risk sub-score is subtracted from the final candidate score. judge.ts scoreCandidate. */
  "judge.total_risk_penalty": 0.42,

  // A candidate that is not creative, scored under a creative request: only these three residual terms apply.
  /** Residual weight of surface mass when a candidate mismatches a creative request. judge.ts scoreCreativeCandidate. */
  "judge.creative_mismatch_mass_weight": 0.12,
  /** Residual weight of actionability when a candidate mismatches a creative request. judge.ts scoreCreativeCandidate. */
  "judge.creative_mismatch_actionability_weight": 0.08,
  /** Residual weight of realizability when a candidate mismatches a creative request. judge.ts scoreCreativeCandidate. */
  "judge.creative_mismatch_realizability_weight": 0.08,

  // Fallback creative selection score, used only when the creative lane supplied none of its own.
  /** Weight of how much of the request's constraints the creative surface covers. judge.ts scoreCreativeCandidate. */
  "judge.creative_constraint_coverage_weight": 0.28,
  /** Weight of graph coherence in the fallback creative selection score. judge.ts scoreCreativeCandidate. */
  "judge.creative_coherence_weight": 0.22,
  /** Weight of novelty in the fallback creative selection score. judge.ts scoreCreativeCandidate. */
  "judge.creative_novelty_weight": 0.20,
  /** Weight of language realizability in the fallback creative selection score. judge.ts scoreCreativeCandidate. */
  "judge.creative_language_weight": 0.15,
  /** Weight of usefulness in the fallback creative selection score. judge.ts scoreCreativeCandidate. */
  "judge.creative_usefulness_weight": 0.15,
  /** How much measured risk is subtracted from the fallback creative selection score. judge.ts scoreCreativeCandidate. */
  "judge.creative_risk_penalty": 0.30,
  /** How much repetition is subtracted from the fallback creative selection score. judge.ts scoreCreativeCandidate. */
  "judge.creative_repetition_penalty": 0.20,
  /** How much an unsupported factual assertion is subtracted from a creative score. judge.ts scoreCreativeCandidate. */
  "judge.creative_fake_authority_penalty": 0.50,

  // Final creative candidate score: a normalized set, must continue to sum to 1. judge.ts scoreCreativeCandidate.
  /** Weight of the creative selection score in the final creative candidate score. judge.ts scoreCreativeCandidate. */
  "judge.creative_total_selection_weight": 0.72,
  /** Weight of surface mass in the final creative candidate score. judge.ts scoreCreativeCandidate. */
  "judge.creative_total_mass_weight": 0.16,
  /** Weight of the validation-graph score in the final creative candidate score. judge.ts scoreCreativeCandidate. */
  "judge.creative_total_validation_weight": 0.12,

  // --- graph-edge-quality.ts: whether an extracted subject/predicate/object edge is fit to answer from
  // Entity-centrality support: a normalized pair, must continue to sum to 1. scoreGraphEdgeQuality.
  /** Share of entity-centrality support taken from the subject endpoint. graph-edge-quality.ts scoreGraphEdgeQuality. */
  "graph_edge_quality.centrality_subject_weight": 0.55,
  /** Share of entity-centrality support taken from the object endpoint. graph-edge-quality.ts scoreGraphEdgeQuality. */
  "graph_edge_quality.centrality_object_weight": 0.45,

  // Endpoint compactness: a normalized pair, must continue to sum to 1. endpointQuality.
  /** Weight of symbol-count compactness in an endpoint's compactness. graph-edge-quality.ts endpointQuality. */
  "graph_edge_quality.endpoint_compactness_symbol_weight": 0.58,
  /** Weight of character-count compactness in an endpoint's compactness. graph-edge-quality.ts endpointQuality. */
  "graph_edge_quality.endpoint_compactness_char_weight": 0.42,

  // Endpoint quality: the three positive terms are a normalized set summing to 1; the fragment term is subtracted.
  /** Weight of compactness in an endpoint's quality. graph-edge-quality.ts endpointQuality. */
  "graph_edge_quality.endpoint_quality_compactness_weight": 0.5,
  /** Weight of label cleanliness in an endpoint's quality. graph-edge-quality.ts endpointQuality. */
  "graph_edge_quality.endpoint_quality_cleanliness_weight": 0.35,
  /** Weight of centrality in an endpoint's quality. graph-edge-quality.ts endpointQuality. */
  "graph_edge_quality.endpoint_quality_centrality_weight": 0.15,
  /** How much a fragmentary endpoint is subtracted from its quality. graph-edge-quality.ts endpointQuality. */
  "graph_edge_quality.endpoint_quality_fragment_penalty": 0.42,

  // Endpoint centrality: a normalized pair, must continue to sum to 1. endpointCentrality.
  /** Weight of the symbol-count band in endpoint centrality. graph-edge-quality.ts endpointCentrality. */
  "graph_edge_quality.endpoint_centrality_band_weight": 0.6,
  /** Weight of label cleanliness in endpoint centrality. graph-edge-quality.ts endpointCentrality. */
  "graph_edge_quality.endpoint_centrality_cleanliness_weight": 0.4,

  // Reason flags and class assignment. Each decides how an edge is labelled, and the label caps its quality.
  /** Subject specificity below which the edge is flagged low-information. graph-edge-quality.ts scoreGraphEdgeQuality. */
  "graph_edge_quality.low_information_subject_ceiling": 0.42,
  /** Object specificity below which the edge is flagged low-information. graph-edge-quality.ts scoreGraphEdgeQuality. */
  "graph_edge_quality.low_information_object_ceiling": 0.32,
  /** Function-like predicate score at or above which the predicate is flagged as code, not relation. graph-edge-quality.ts scoreGraphEdgeQuality. */
  "graph_edge_quality.function_predicate_floor": 0.72,
  /** Endpoint fragment score at or above which that endpoint is flagged fragmentary. graph-edge-quality.ts scoreGraphEdgeQuality. */
  "graph_edge_quality.endpoint_fragment_floor": 0.48,
  /** Markup density at or above which the edge is flagged, and classed, markup-dense. graph-edge-quality.ts scoreGraphEdgeQuality. */
  "graph_edge_quality.markup_dense_floor": 0.16,
  /** Category-navigation score at or above which the edge is catalog navigation, not fact. graph-edge-quality.ts scoreGraphEdgeQuality. */
  "graph_edge_quality.navigation_shape_floor": 0.55,
  /** Alias score at or above which the edge is a redirect alias, not fact. graph-edge-quality.ts scoreGraphEdgeQuality. */
  "graph_edge_quality.alias_shape_floor": 0.55,
  /** Title-hint score at or above which the edge restates its own source title. graph-edge-quality.ts scoreGraphEdgeQuality. */
  "graph_edge_quality.title_hint_shape_floor": 0.55,
  /** Relation usefulness at or above which the edge is flagged as carrying real semantic shape. graph-edge-quality.ts scoreGraphEdgeQuality. */
  "graph_edge_quality.semantic_shape_relation_usefulness_floor": 0.62,
  /** Fragment score below which that semantic-shape flag is still allowed. graph-edge-quality.ts scoreGraphEdgeQuality. */
  "graph_edge_quality.semantic_shape_fragment_ceiling": 0.36,
  /** Label cleanliness below which the edge is classed markup-noise regardless of markup density. graph-edge-quality.ts scoreGraphEdgeQuality. */
  "graph_edge_quality.noisy_markup_cleanliness_ceiling": 0.36,
  /** Fragment score at or above which, with a weak predicate, the edge is classed markup-noise. graph-edge-quality.ts scoreGraphEdgeQuality. */
  "graph_edge_quality.noisy_markup_fragment_floor": 0.72,
  /** Predicate quality below which that fragmentary edge is classed markup-noise. graph-edge-quality.ts scoreGraphEdgeQuality. */
  "graph_edge_quality.noisy_markup_predicate_quality_ceiling": 0.12,
  /** Fragment score at or above which an otherwise unclassed edge is a weak fragment. graph-edge-quality.ts scoreGraphEdgeQuality. */
  "graph_edge_quality.weak_fragment_floor": 0.34,
  /** Predicate quality below which an otherwise unclassed edge is a weak fragment. graph-edge-quality.ts scoreGraphEdgeQuality. */
  "graph_edge_quality.weak_fragment_predicate_quality_ceiling": 0.42,
  /** Semantic quality an answer-grade edge must reach, both to qualify and to stay answer-grade. graph-edge-quality.ts answerGradeShape and scoreGraphEdgeQuality. */
  "graph_edge_quality.answer_grade_semantic_floor": 0.58,
  /** Predicate quality an answer-grade edge must reach. graph-edge-quality.ts answerGradeShape. */
  "graph_edge_quality.answer_grade_predicate_quality_floor": 0.33,
  /** Object quality an answer-grade edge must reach. graph-edge-quality.ts answerGradeShape. */
  "graph_edge_quality.answer_grade_object_quality_floor": 0.74,
  /** Subject specificity an answer-grade edge must reach. graph-edge-quality.ts answerGradeShape. */
  "graph_edge_quality.answer_grade_subject_specificity_floor": 0.42,
  /** Object specificity an answer-grade edge must reach. graph-edge-quality.ts answerGradeShape. */
  "graph_edge_quality.answer_grade_object_specificity_floor": 0.32,
  /** Fragment score an answer-grade edge must stay below. graph-edge-quality.ts answerGradeShape. */
  "graph_edge_quality.answer_grade_fragment_ceiling": 0.24,
  /** Fragment score at or above which an endpoint's specificity is docked. graph-edge-quality.ts endpointSpecificity. */
  "graph_edge_quality.specificity_fragment_penalty_floor": 0.34,
  /** Object centrality at or above which a short object reads as a classifier in a list, not an answer. graph-edge-quality.ts listShapeScore. */
  "graph_edge_quality.object_classifier_centrality_floor": 0.54,
  /** Alphabetic vowel ratio below which a short surface reads as an abbreviation, not a word. graph-edge-quality.ts fragmentScore. */
  "graph_edge_quality.vowel_thinness_ratio_ceiling": 0.18,

  // --- learned-graph-prior-runtime.ts: which graph facts answer the question, and how complete the answer is
  // Explanation completeness, planned route: a normalized set, must continue to sum to 1.
  /** Weight of filled required roles in planned explanation completeness. learned-graph-prior-runtime.ts explanatory contract. */
  "graph_prior.plan_completeness_required_role_weight": 0.34,
  /** Weight of bridge coverage in planned explanation completeness. learned-graph-prior-runtime.ts explanatory contract. */
  "graph_prior.plan_completeness_bridge_weight": 0.24,
  /** Weight of supporting mass in planned explanation completeness. learned-graph-prior-runtime.ts explanatory contract. */
  "graph_prior.plan_completeness_support_weight": 0.24,
  /** Weight of path activation in planned explanation completeness. learned-graph-prior-runtime.ts explanatory contract. */
  "graph_prior.plan_completeness_activation_weight": 0.18,

  // Explanation completeness, realized route: a normalized set, must continue to sum to 1. Deliberately not the
  // same numbers as the planned route above, though the expression is otherwise identical.
  /** Weight of filled required roles in realized explanation completeness. learned-graph-prior-runtime.ts realized contract. */
  "graph_prior.realized_completeness_required_role_weight": 0.36,
  /** Weight of bridge coverage in realized explanation completeness. learned-graph-prior-runtime.ts realized contract. */
  "graph_prior.realized_completeness_bridge_weight": 0.22,
  /** Weight of supporting mass in realized explanation completeness. learned-graph-prior-runtime.ts realized contract. */
  "graph_prior.realized_completeness_support_weight": 0.22,
  /** Weight of path activation in realized explanation completeness. learned-graph-prior-runtime.ts realized contract. */
  "graph_prior.realized_completeness_activation_weight": 0.2,

  // Path activation of an answering fact: a normalized set, must continue to sum to 1.
  /** Weight of the fact's own activation in its path activation. learned-graph-prior-runtime.ts path activation. */
  "graph_prior.path_activation_fact_weight": 0.38,
  /** Weight of propagated prior-field mass in a fact's path activation. learned-graph-prior-runtime.ts path activation. */
  "graph_prior.path_activation_ppf_mass_weight": 0.34,
  /** Weight of the strongest endpoint activation in a fact's path activation. learned-graph-prior-runtime.ts path activation. */
  "graph_prior.path_activation_endpoint_weight": 0.28,

  /** Path score a zero-arc slot assignment must reach to stay a candidate. learned-graph-prior-runtime.ts slot assignment. */
  "graph_prior.assignment_path_score_floor": 0.18,
  /** Completeness a fact must exceed to enter the answering pool at all. learned-graph-prior-runtime.ts fact admission. */
  "graph_prior.fact_completeness_floor": 0.08,
  /** Question fit an unoverlapping, unactivated fact must reach to survive. learned-graph-prior-runtime.ts cognitive fabric. */
  "graph_prior.inactive_fact_question_fit_floor": 0.18,
  /** Question fit a fact must reach to count as direct evidence for the question. learned-graph-prior-runtime.ts question edge fit. */
  "graph_prior.direct_evidence_question_fit_floor": 0.44,
  /** Score below which an unanchored candidate is dropped. learned-graph-prior-runtime.ts candidate scoring. */
  "graph_prior.unanchored_candidate_score_floor": 0.018,
  /** Subject affinity below which graph priors are judged to be about something else. learned-graph-prior-runtime.ts unrelated-prior penalty. */
  "graph_prior.unrelated_prior_subject_affinity_ceiling": 0.08,
  /** Question overlap below which graph priors are judged to be about something else. learned-graph-prior-runtime.ts unrelated-prior penalty. */
  "graph_prior.unrelated_prior_question_overlap_ceiling": 0.03,
  /** Penalty applied when the graph priors are about something else. learned-graph-prior-runtime.ts unrelated-prior penalty. */
  "graph_prior.unrelated_prior_penalty": 0.6,
  /** Relevance a direct-evidence answer must reach. learned-graph-prior-runtime.ts relevance gate. */
  "graph_prior.relevance_direct_evidence_floor": 0.22,
  /** Relevance a requested-support answer must reach. learned-graph-prior-runtime.ts relevance gate. */
  "graph_prior.relevance_requested_support_floor": 0.22,
  /** Cognitive support mass a requested-support answer must reach. learned-graph-prior-runtime.ts relevance gate. */
  "graph_prior.requested_support_mass_floor": 0.2,
  /** Relevance a partial-support answer must reach. learned-graph-prior-runtime.ts relevance gate. */
  "graph_prior.relevance_partial_support_floor": 0.18,
  /** Cognitive support mass a partial-support answer must reach. learned-graph-prior-runtime.ts relevance gate. */
  "graph_prior.partial_support_mass_floor": 0.14,
  /** Affinity gap between the top two subject matches below which the subject is ambiguous and clarification is costed. learned-graph-prior-runtime.ts relevance gate. */
  "graph_prior.clarification_affinity_gap_ceiling": 0.025,
  /** Relevance a clarification-costed turn must still reach. learned-graph-prior-runtime.ts relevance gate. */
  "graph_prior.relevance_clarification_floor": 0.18,
  /** Overlap a fact must exceed to satisfy the request slot of the explanatory contract. learned-graph-prior-runtime.ts contract slots. */
  "graph_prior.request_slot_overlap_floor": 0.03,
  /** Punctuation mass above which a surface is debris, not a usable fact label. learned-graph-prior-runtime.ts surface admission. */
  "graph_prior.punctuation_mass_ceiling": 0.12,
  /** Fit below which a date-or-quantity catalog object is rejected as a stray list entry. learned-graph-prior-runtime.ts fact rejection. */
  "graph_prior.catalog_surface_fit_floor": 0.62,
  /** Fit below which a weak-fragment-classed fact is rejected. learned-graph-prior-runtime.ts fact rejection. */
  "graph_prior.weak_fragment_fit_floor": 0.5,
  /** Overlap below which that weak-fragment fact is rejected. learned-graph-prior-runtime.ts fact rejection. */
  "graph_prior.weak_fragment_overlap_ceiling": 0.08,
  /** Fragment score at or above which a fact needs an unusually high fit to survive. learned-graph-prior-runtime.ts fact rejection. */
  "graph_prior.fragment_rejection_floor": 0.62,
  /** The fit such a fragmentary fact must reach. learned-graph-prior-runtime.ts fact rejection. */
  "graph_prior.fragment_rejection_fit_floor": 0.64,

  // --- language-memory-runtime.ts: which learned surface is spoken, and how good the prose built from it is.
  // Every group marked "normalized set" must continue to sum to 1.
  // Combined surface score (normalized set). selectSurface.
  /** Weight of learned-field activation in the combined language-memory surface score. language-memory-runtime.ts selectSurface. */
  "language_memory.total_activation_weight": 0.46,
  /** Weight of fit to the request in the combined surface score. language-memory-runtime.ts selectSurface. */
  "language_memory.total_request_fit_weight": 0.34,
  /** Weight of the candidate's own fit in the combined surface score. language-memory-runtime.ts selectSurface. */
  "language_memory.total_candidate_fit_weight": 0.2,

  // Reported confidence in a spoken surface (normalized set).
  /** Weight of activation in reported surface confidence. language-memory-runtime.ts surface confidence. */
  "language_memory.confidence_activation_weight": 0.42,
  /** Weight of measured generation reliability in reported surface confidence. language-memory-runtime.ts surface confidence. */
  "language_memory.confidence_generation_reliability_weight": 0.28,
  /** Weight of how many surfaces were selected in reported confidence. language-memory-runtime.ts surface confidence. */
  "language_memory.confidence_selected_count_weight": 0.18,
  /** Weight of imported-use mass in reported confidence. language-memory-runtime.ts surface confidence. */
  "language_memory.confidence_imported_use_weight": 0.12,

  // Language-unit continuation score (normalized set).
  /** Weight of corpus support in a continuation unit's score. language-memory-runtime.ts unit continuation. */
  "language_memory.unit_support_weight": 0.34,
  /** Weight of request fit in a continuation unit's score. language-memory-runtime.ts unit continuation. */
  "language_memory.unit_fit_weight": 0.24,
  /** Weight of the Kneser-Ney probability in a continuation unit's score. language-memory-runtime.ts unit continuation. */
  "language_memory.unit_ngram_probability_weight": 0.22,
  /** Weight of source preference in a continuation unit's score. language-memory-runtime.ts unit continuation. */
  "language_memory.unit_source_preference_weight": 0.2,

  // Generated sentence score (normalized set).
  /** Weight of corpus support in a generated sentence's score. language-memory-runtime.ts sentence scoring. */
  "language_memory.sentence_support_weight": 0.3,
  /** Weight of request coverage in a generated sentence's score. language-memory-runtime.ts sentence scoring. */
  "language_memory.sentence_coverage_weight": 0.28,
  /** Weight of n-gram continuity in a generated sentence's score. language-memory-runtime.ts sentence scoring. */
  "language_memory.sentence_continuity_weight": 0.18,
  /** Weight of length fitness in a generated sentence's score. language-memory-runtime.ts sentence scoring. */
  "language_memory.sentence_length_fit_weight": 0.16,
  /** Weight of not repeating itself in a generated sentence's score. language-memory-runtime.ts sentence scoring. */
  "language_memory.sentence_non_repetition_weight": 0.08,

  // Joining two spans into one surface (normalized set).
  /** Weight of continuity across the join in the joined span's score. language-memory-runtime.ts span joining. */
  "language_memory.join_continuity_weight": 0.55,
  /** Weight of the right-hand span's own score in the joined score. language-memory-runtime.ts span joining. */
  "language_memory.join_right_score_weight": 0.25,
  /** Weight of the left-hand span's own score in the joined score. language-memory-runtime.ts span joining. */
  "language_memory.join_left_score_weight": 0.2,

  // Prose candidate score (normalized set).
  /** Weight of claim coverage in a prose candidate's score. language-memory-runtime.ts prose candidate scoring. */
  "language_memory.prose_claim_coverage_weight": 0.26,
  /** Weight of anchor coverage in a prose candidate's score. language-memory-runtime.ts prose candidate scoring. */
  "language_memory.prose_anchor_weight": 0.22,
  /** Weight of continuity in a prose candidate's score. language-memory-runtime.ts prose candidate scoring. */
  "language_memory.prose_continuity_weight": 0.18,
  /** Weight of prior support in a prose candidate's score. language-memory-runtime.ts prose candidate scoring. */
  "language_memory.prose_prior_support_weight": 0.16,
  /** Weight of length fitness in a prose candidate's score. language-memory-runtime.ts prose candidate scoring. */
  "language_memory.prose_length_fit_weight": 0.12,
  /** Weight of not repeating itself in a prose candidate's score. language-memory-runtime.ts prose candidate scoring. */
  "language_memory.prose_non_repetition_weight": 0.06,

  // Discourse score: the five positive terms are a normalized set; repetition is subtracted on top.
  /** Weight of anchor coverage in the discourse score. language-memory-runtime.ts discourse scoring. */
  "language_memory.discourse_anchor_coverage_weight": 0.3,
  /** Weight of cohesion across sentences in the discourse score. language-memory-runtime.ts discourse scoring. */
  "language_memory.discourse_cohesion_weight": 0.24,
  /** Weight of the selected beam's score in the discourse score. language-memory-runtime.ts discourse scoring. */
  "language_memory.discourse_beam_score_weight": 0.22,
  /** Weight of mean n-gram activation in the discourse score. language-memory-runtime.ts discourse scoring. */
  "language_memory.discourse_ngram_activation_weight": 0.14,
  /** Weight of boundary support in the discourse score. language-memory-runtime.ts discourse scoring. */
  "language_memory.discourse_boundary_support_weight": 0.1,
  /** How much repetition is subtracted from the discourse score. language-memory-runtime.ts discourse scoring. */
  "language_memory.discourse_repetition_penalty": 0.24,

  // What a construction move gains for the plan (normalized pair).
  /** Weight of newly covered request terms in coverage gain. language-memory-runtime.ts construction search. */
  "language_memory.coverage_gain_term_weight": 0.62,
  /** Weight of newly covered request atoms in coverage gain. language-memory-runtime.ts construction search. */
  "language_memory.coverage_gain_atom_weight": 0.38,

  // Per-move score increment during construction search. Not normalized: bonuses are added outside it.
  /** Weight of coverage gain in a construction move's increment. language-memory-runtime.ts construction search. */
  "language_memory.move_increment_coverage_gain_weight": 0.23,
  /** Weight of prior support in a construction move's increment. language-memory-runtime.ts construction search. */
  "language_memory.move_increment_prior_support_weight": 0.28,
  /** Weight of the transition score in a construction move's increment. language-memory-runtime.ts construction search. */
  "language_memory.move_increment_transition_weight": 0.15,
  /** Weight of n-gram activation in a construction move's increment. language-memory-runtime.ts construction search. */
  "language_memory.move_increment_ngram_activation_weight": 0.11,
  /** Weight of role fit in a construction move's increment. language-memory-runtime.ts construction search. */
  "language_memory.move_increment_role_fit_weight": 0.07,
  /** How much projected repetition is subtracted from a move's increment. language-memory-runtime.ts construction search. */
  "language_memory.move_increment_repetition_penalty": 0.22,

  // Standalone ranking of a construction move. Not normalized: a prior-anchor bonus is added outside it.
  /** Weight of the move's corpus support in its rank. language-memory-runtime.ts move ranking. */
  "language_memory.move_support_weight": 0.4,
  /** Weight of n-gram activation in a move's rank. language-memory-runtime.ts move ranking. */
  "language_memory.move_ngram_activation_weight": 0.16,
  /** Weight of role fit in a move's rank. language-memory-runtime.ts move ranking. */
  "language_memory.move_role_fit_weight": 0.14,
  /** Weight of compactness in a move's rank. language-memory-runtime.ts move ranking. */
  "language_memory.move_compactness_weight": 0.08,
  /** Weight of source mass in a move's rank. language-memory-runtime.ts move ranking. */
  "language_memory.move_source_mass_weight": 0.06,
  /** Weight of agreeing with the plan's order in a move's rank. language-memory-runtime.ts move ranking. */
  "language_memory.move_plan_order_weight": 0.12,

  // Search-state ranking during construction. Added on top of the state's accumulated score.
  /** Weight of required-slot coverage in a search state's rank. language-memory-runtime.ts construction search state. */
  "language_memory.state_required_coverage_weight": 0.32,
  /** Weight of request-atom coverage in a search state's rank. language-memory-runtime.ts construction search state. */
  "language_memory.state_atom_coverage_weight": 0.18,
  /** Weight of a balanced mix of move kinds in a search state's rank. language-memory-runtime.ts construction search state. */
  "language_memory.state_move_balance_weight": 0.12,
  /** Weight of mean transition score in a search state's rank. language-memory-runtime.ts construction search state. */
  "language_memory.state_transition_mean_weight": 0.1,
  /** Weight of mean support in a search state's rank. language-memory-runtime.ts construction search state. */
  "language_memory.state_average_support_weight": 0.12,
  /** How much repetition is subtracted from a search state's rank. language-memory-runtime.ts construction search state. */
  "language_memory.state_repetition_penalty": 0.32,

  // Whether a semantic relation is worth speaking (normalized set).
  /** Weight of corpus support in relation usefulness. language-memory-runtime.ts semantic material selection. */
  "language_memory.relation_support_weight": 0.32,
  /** Weight of relevance to the turn in relation usefulness. language-memory-runtime.ts semantic material selection. */
  "language_memory.relation_relevance_weight": 0.24,
  /** Weight of fitting the question's shape in relation usefulness. language-memory-runtime.ts semantic material selection. */
  "language_memory.relation_question_shape_fit_weight": 0.44,

  // Sentence admission score for a discourse plan (normalized set).
  /** Weight of corpus support in an admitted sentence's score. language-memory-runtime.ts sentence admission. */
  "language_memory.admission_support_weight": 0.42,
  /** Weight of activation in an admitted sentence's score. language-memory-runtime.ts sentence admission. */
  "language_memory.admission_activation_weight": 0.28,
  /** Weight of extent fit in an admitted sentence's score. language-memory-runtime.ts sentence admission. */
  "language_memory.admission_extent_fit_weight": 0.18,
  /** Weight of the model probability in an admitted sentence's score. language-memory-runtime.ts sentence admission. */
  "language_memory.admission_probability_weight": 0.12,

  // How much a model's word-order evidence is trusted (normalized pair).
  /** Weight of measured order fit in the trusted order score. language-memory-runtime.ts order fit. */
  "language_memory.order_fit_weight": 0.72,
  /** Weight of how much text the model saw, in the trusted order score. language-memory-runtime.ts order fit. */
  "language_memory.order_observed_mass_weight": 0.28,

  // Competence vector: what the engine reports it can and cannot say. Each group is a normalized set.
  /** Weight of lexical coverage in reported generation reliability. language-memory-runtime.ts competence vector. */
  "language_memory.generation_lexical_coverage_weight": 0.4,
  /** Weight of phrase fluency in reported generation reliability. language-memory-runtime.ts competence vector. */
  "language_memory.generation_phrase_fluency_weight": 0.36,
  /** Weight of model coverage in reported generation reliability. language-memory-runtime.ts competence vector. */
  "language_memory.generation_model_coverage_weight": 0.24,
  /** Weight of generation reliability in reported discourse reliability. language-memory-runtime.ts competence vector. */
  "language_memory.discourse_reliability_generation_weight": 0.64,
  /** Weight of discourse-pattern coverage in reported discourse reliability. language-memory-runtime.ts competence vector. */
  "language_memory.discourse_reliability_pattern_coverage_weight": 0.36,
  /** Weight of model coverage in reported segmentation quality. language-memory-runtime.ts competence vector. */
  "language_memory.segmentation_model_coverage_weight": 0.35,
  /** Weight of lexical coverage in reported segmentation quality. language-memory-runtime.ts competence vector. */
  "language_memory.segmentation_lexical_coverage_weight": 0.65,

  // Prose quality complaints and admission gates.
  /** Claim coverage below which prose is flagged as not saying what it was asked. language-memory-runtime.ts prose issues. */
  "language_memory.prose_claim_coverage_floor": 0.55,
  /** Anchor coverage below which prose is flagged as missing its anchors. language-memory-runtime.ts prose issues. */
  "language_memory.prose_anchor_coverage_floor": 0.42,
  /** Length fitness below which prose is flagged as the wrong length. language-memory-runtime.ts prose issues. */
  "language_memory.prose_length_fit_floor": 0.16,
  /** Feature-set similarity at which a required anchor counts as present without appearing literally. language-memory-runtime.ts anchor coverage. */
  "language_memory.anchor_similarity_floor": 0.18,
  /** Term weight at or above which a request term is treated as required, not optional. language-memory-runtime.ts required terms. */
  "language_memory.required_term_weight_floor": 0.45,
  /** Semantic overlap above which two rows of material are the same material. language-memory-runtime.ts material deduplication. */
  "language_memory.material_duplicate_overlap_floor": 0.92,
  /** Question fit above which a primary row counts as contributing something. language-memory-runtime.ts material contribution. */
  "language_memory.material_contribution_question_fit_floor": 0.04,
  /** Relation usefulness above which background material is spoken anyway. language-memory-runtime.ts material surfacing. */
  "language_memory.background_relation_usefulness_floor": 0.64,
  /** Repetition penalty at or above which a discourse is too repetitive to admit. language-memory-runtime.ts discourse admission. */
  "language_memory.discourse_repetition_ceiling": 0.72,
  /** Share of short fragments at or above which a surface reads as list debris. language-memory-runtime.ts debris detection. */
  "language_memory.fragment_ratio_floor": 0.5,
  /** Punctuation density that debris must also carry. language-memory-runtime.ts debris detection. */
  "language_memory.fragment_punctuation_density_floor": 0.24,
  /** Punctuation-per-glyph ratio above which a surface is rejected as not prose. language-memory-runtime.ts surface admission. */
  "language_memory.punctuation_glyph_ratio_ceiling": 0.35
});

export type CalibrationKey = keyof typeof PUBLIC_CALIBRATIONS;

/** Every id in the public table, for callers that need to report or diff coverage. */
export const PUBLIC_CALIBRATION_IDS = Object.freeze(Object.keys(PUBLIC_CALIBRATIONS) as CalibrationKey[]);
