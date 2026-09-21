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
  // --- structural graph refinement (graph-refinement.ts), bootstrap profile v1
  "graph_refinement.max_logit_shift": 1,
  "graph_refinement.max_structural_seeds": 32,
  "graph_refinement.max_seeds": 48,
  "graph_refinement.seed_weight.active": 0.4,
  "graph_refinement.seed_weight.temporal": 0.2,
  "graph_refinement.seed_weight.causal": 0.15,
  "graph_refinement.seed_weight.composition": 0.2,
  "graph_refinement.seed_weight.source_diversity": 0.05,
  "graph_refinement.source_diversity_scale": 2,

  // --- code request structural demand (code-request.ts)
  // Bootstrap weights are intentionally small and additive: each typed observation contributes evidence,
  // while codeRequestRecognized remains the separate corroboration gate.
  "code_request.demand.fenced_block": 0.45,
  "code_request.demand.formal_language": 0.4,
  "code_request.demand.language_alias": 0.15,
  "code_request.demand.code_path": 0.35,
  "code_request.demand.identifier_shape": 0.2,
  "code_request.demand.call_shape": 0.2,
  "code_request.demand.code_punctuation": 0.2,
  "code_request.demand.owner_behavior_example": 0.35,
  "code_request.demand.owner_stateful_behavior_example": 0.35,

  // --- request authority projection (request-authority.ts)
  /** Intercept of the bounded authority routing energy. */
  "request_authority.projection_bias": 0.5,
  /** Logit scale of the bounded authority routing energy. */
  "request_authority.projection_scale": 10,
  "request_authority.coefficient.factual.externalTruthAuthority": 4.6,
  "request_authority.coefficient.factual.sourceDependence": 3.7,
  "request_authority.coefficient.factual.uncertaintyTolerance": -1.2,
  "request_authority.coefficient.factual.inferentialDepth": -0.8,
  "request_authority.coefficient.factual.noveltyDemand": -3.4,
  "request_authority.coefficient.factual.executableArtifactDemand": -2.4,
  "request_authority.coefficient.factual.actionCommitment": -2.2,
  "request_authority.coefficient.reasoned.inferentialDepth": 4.4,
  "request_authority.coefficient.reasoned.causalReasoningDemand": 1.6,
  "request_authority.coefficient.reasoned.temporalReasoningDemand": 0.7,
  "request_authority.coefficient.reasoned.externalTruthAuthority": 1,
  "request_authority.coefficient.reasoned.sourceDependence": 0.5,
  "request_authority.coefficient.reasoned.noveltyDemand": -1.2,
  "request_authority.coefficient.creative.noveltyDemand": 4.8,
  "request_authority.coefficient.creative.inferentialDepth": 1.2,
  "request_authority.coefficient.creative.uncertaintyTolerance": 2,
  "request_authority.coefficient.creative.counterfactualDemand": 0.9,
  "request_authority.coefficient.creative.externalTruthAuthority": -4,
  "request_authority.coefficient.creative.sourceDependence": -3.4,
  "request_authority.coefficient.creative.executableArtifactDemand": -1.8,
  "request_authority.coefficient.creative.actionCommitment": -1.8,
  "request_authority.coefficient.translation.semanticPreservation": 4.8,
  "request_authority.coefficient.translation.surfaceTransformation": 4.6,
  "request_authority.coefficient.translation.audienceAdaptation": 1.5,
  "request_authority.coefficient.translation.externalTruthAuthority": -2.2,
  "request_authority.coefficient.translation.noveltyDemand": -1.8,
  "request_authority.coefficient.program.executableArtifactDemand": 4.8,
  "request_authority.coefficient.program.formatConstraintStrength": 2.8,
  "request_authority.coefficient.program.inferentialDepth": 1.7,
  "request_authority.coefficient.program.actionCommitment": 0.7,
  "request_authority.coefficient.program.externalTruthAuthority": -1.2,
  "request_authority.coefficient.action.actionCommitment": 4.9,
  "request_authority.coefficient.action.executableArtifactDemand": 2,
  "request_authority.coefficient.action.externalTruthAuthority": 0.8,
  "request_authority.coefficient.action.sourceDependence": 0.5,
  "request_authority.coefficient.action.noveltyDemand": -2.2,
  "request_authority.dialogue_continuation_scale": 0.5,
  "request_authority.clarification_uncertainty_scale": 0.35,
  "request_authority.source_synthesis_threshold": 2,
  "request_authority.source_synthesis_divisor": 4,
  "request_authority.relation_composition_edge_threshold": 2,
  "request_authority.graph_edge_log_scale": 8,
  "request_authority.evidence_log_scale": 5,
  "request_authority.causal_mass_sample_limit": 12,

  // --- closed class (closed-class-words.ts deriveClosedClassWords)
  /** Head of the continuation-diversity ranking taken as the language's closed class. */
  "closed_class.rank_limit": 96,

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
  /**
   * How many of a quoted sentence's adjacent pairs are searched, rarest first.
   *
   * It bounds cost and it decides what is reachable, so it is declared rather than written inline as a scan limit.
   * Swept against the live index over the 39 declining cloze rows whose answering span exists:
   *
   *     pairs   found   ranked first   query p50   query max
   *         6      37             27        17ms       317ms
   *        10      38             33        73ms       785ms
   *        14      39             33       405ms     12022ms
   *        20      39             35      2419ms     17975ms
   *
   * 10 rather than 14: the extra row 14 finds costs a 12-second worst case, and a query that eats the turn's
   * deadline makes the mouth refuse to speak at all, which is the failure this whole change exists to remove.
   */
  "retrieval.quoted_sentence_query_features": 10,

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

  // --- turn truth state, answer basis and certification (launch-contract.ts)
  // Moved verbatim from the inline literals these ids replace. Sibling concepts to plan.contradiction_block
  // above: the spine already carried an id for "how much contradiction blocks an answer" while these decided
  // what a contradiction IS, from a literal no search space or observation could reach.
  /** Contradiction above which the turn carries a contradiction answer-basis reason and blocks certified fact. */
  "launch_contract.contradiction_reason_floor": 0.05,
  /** Contradiction above which the symbolic truth state is `truth.contradicted`. */
  "launch_contract.contradicted_truth_state_floor": 0.4,
  /** Support at or above which, with faithfulness, the truth state is `truth.certified`. */
  "launch_contract.certified_support_floor": 0.78,
  /** Faithfulness lower bound at or above which, with support, the truth state is `truth.certified`. */
  "launch_contract.certified_faithfulness_floor": 0.65,
  "launch_contract.reliability_support_weight": 0.62,
  "launch_contract.reliability_faithfulness_weight": 0.25,
  "launch_contract.reliability_noncontradiction_weight": 0.13,
  /** Raw reliability at or above which the reported bucket is `high`. */
  "launch_contract.reliability_high_floor": 0.8,
  /** Raw reliability at or above which the reported bucket is `medium`. */
  "launch_contract.reliability_medium_floor": 0.55,

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
  "language_memory.punctuation_glyph_ratio_ceiling": 0.35,
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
  "translation.semantic_score_energy_weight": 0.45,

  // --- structural residue (structural-residue.ts). The one id here was DERIVED, not chosen: Otsu's split of the
  // corpus's own score distribution over all 1,918,749 sentences of all 73,480 promoted evidence spans, which put
  // 6.06% of them above the cut. `node tools/derive-structural-residue-cut.mjs` recomputes it on any corpus; a
  // 900k-sentence prefix of the same corpus gives 0.1289, inside this id's 0.005 resolution.
  /** Score at or above which a surface is serialized apparatus rather than a statement. Otsu, 2026-09-13. */
  "evidence.structural_residue_cut": 0.1296,
  /** Residue score of a line run at or above which the run is ingest apparatus. Otsu, 2026-09-16. */
  "ingest.apparatus_run_residue_cut": 0.2151,

  // --- source preservation demand (mouth.ts sourcePreservationRequested, production-turn-runtime.ts reasonedRealizationPreservesContract)
  /** Requirement-field preservation or source demand at or above which a turn keeps source-exact wording. */
  "turn_requirements.source_preservation_floor": 0.6,
  // --- dialogue requirement field (turn-requirements.ts collectDialogueActivations, derivedContextContribution)
  /** Activation of the current-intent dialogue move with no continuity link. */
  "requirement.dialogue_intent.activation_without_continuity": 0.58,
  /** Activation of the current-intent dialogue move once the conversation has a continuity link. */
  "requirement.dialogue_intent.activation_with_continuity": 0.82,
  /** dialogueDependence coefficient of the current-intent move with no continuity link. */
  "requirement.dialogue_intent.coefficient_without_continuity": 0.3,
  /** dialogueDependence coefficient of the current-intent move once the conversation has a continuity link. */
  "requirement.dialogue_intent.coefficient_with_continuity": 0.9,
  /** Weight of saturated continuity links in the derived dialogueDependence context contribution. */
  "requirement.dialogue_context.continuity_weight": 0.45,
  /** Weight of saturated unresolved slots in the derived dialogueDependence context contribution. */
  "requirement.dialogue_context.unresolved_weight": 0.25,

  // --- request communicative act (request-communicative-act.ts)
  /** Laplace pseudo-count smoothing each act class's n-gram presence estimate. */
  "request_act.feature_pseudo_count": 1,

  // --- generic unit signal (kernel-answer-primitives.ts genericQuestionSignal)
  /** UTF-16 length at or below which a request unit is too short to name anything. */
  "units.generic_length_ceiling": 2,
  /** Share of adjacent repeated characters above which a request unit is degenerate rather than a name. */
  "units.generic_repeated_character_ratio": 0.72,

  // --- contradiction pressure (proof-calculus.ts boundaries, production-turn-runtime.ts contradiction fallback)
  /** Claim-versus-evidence contradiction above which the turn holds a real contradiction, not an absent fact. */
  "calculus.contradiction_pressure_floor": 0.2
});

export type CalibrationKey = keyof typeof PUBLIC_CALIBRATIONS;

/** Every id in the public table, for callers that need to report or diff coverage. */
export const PUBLIC_CALIBRATION_IDS = Object.freeze(Object.keys(PUBLIC_CALIBRATIONS) as CalibrationKey[]);
