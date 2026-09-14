// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
import { clamp01, mean, toJsonValue } from "./primitives.js";
import {
  COGNITIVE_OPERATOR_IDS,
  TURN_REQUIREMENT_DIMENSIONS,
  type CognitiveOperatorId,
  type ExplicitTurnRequirement,
  type OperatorSupportMap,
  type TurnRequirementDimension,
  type TurnRequirementField
} from "./turn-requirements.js";
import type { CandidateField, CandidateSurface } from "./candidate-contract.js";
import type { EvidenceSpan, FieldState, GraphSlice, JsonValue, RequestedAuthority } from "./types.js";
import { isKnownGraphTemporalScope } from "./graph-temporal.js";
import { calibrated } from "./calibrations/prod-calibrations.js";
import type { CalibrationKey } from "./calibrations/public-calibrations.js";

export const REQUESTED_AUTHORITY_IDS = [
  "factual",
  "reasoned",
  "creative",
  "translation",
  "program",
  "action"
] as const satisfies readonly RequestedAuthority[];

/**
 * Single authority vocabulary shared by live routing and downstream planners.
 * The values are opaque routing IDs; request surface text is never consulted
 * by this contract.
 */
export const REQUEST_AUTHORITY_ROUTING_CONTRACT = {
  schema: "scce.requested_authority.routing_contract.v1",
  authorityIds: REQUESTED_AUTHORITY_IDS,
  coefficientSource: "turn_requirement_dimensions"
} as const;

export interface RequestAuthorityProjection {
  schema: "scce.requested_authority.requirement_projection.v2";
  requestedAuthority: RequestedAuthority;
  selectedAuthority: RequestedAuthority;
  projectedAuthority: RequestedAuthority;
  explicitOverride: boolean;
  scores: Record<RequestedAuthority, number>;
  scoreMargin: number;
  trace: JsonValue;
}

export interface ProjectRequestAuthorityInput {
  requirementField: TurnRequirementField;
  explicitAuthority?: RequestedAuthority;
}

const AUTHORITY_COEFFICIENT_KEYS: Record<RequestedAuthority, Partial<Record<TurnRequirementDimension, CalibrationKey>>> = {
  factual: { externalTruthAuthority: "request_authority.coefficient.factual.externalTruthAuthority", sourceDependence: "request_authority.coefficient.factual.sourceDependence", uncertaintyTolerance: "request_authority.coefficient.factual.uncertaintyTolerance", inferentialDepth: "request_authority.coefficient.factual.inferentialDepth", noveltyDemand: "request_authority.coefficient.factual.noveltyDemand", executableArtifactDemand: "request_authority.coefficient.factual.executableArtifactDemand", actionCommitment: "request_authority.coefficient.factual.actionCommitment" },
  reasoned: { inferentialDepth: "request_authority.coefficient.reasoned.inferentialDepth", causalReasoningDemand: "request_authority.coefficient.reasoned.causalReasoningDemand", temporalReasoningDemand: "request_authority.coefficient.reasoned.temporalReasoningDemand", externalTruthAuthority: "request_authority.coefficient.reasoned.externalTruthAuthority", sourceDependence: "request_authority.coefficient.reasoned.sourceDependence", noveltyDemand: "request_authority.coefficient.reasoned.noveltyDemand" },
  creative: { noveltyDemand: "request_authority.coefficient.creative.noveltyDemand", inferentialDepth: "request_authority.coefficient.creative.inferentialDepth", uncertaintyTolerance: "request_authority.coefficient.creative.uncertaintyTolerance", counterfactualDemand: "request_authority.coefficient.creative.counterfactualDemand", externalTruthAuthority: "request_authority.coefficient.creative.externalTruthAuthority", sourceDependence: "request_authority.coefficient.creative.sourceDependence", executableArtifactDemand: "request_authority.coefficient.creative.executableArtifactDemand", actionCommitment: "request_authority.coefficient.creative.actionCommitment" },
  translation: { semanticPreservation: "request_authority.coefficient.translation.semanticPreservation", surfaceTransformation: "request_authority.coefficient.translation.surfaceTransformation", audienceAdaptation: "request_authority.coefficient.translation.audienceAdaptation", externalTruthAuthority: "request_authority.coefficient.translation.externalTruthAuthority", noveltyDemand: "request_authority.coefficient.translation.noveltyDemand" },
  program: { executableArtifactDemand: "request_authority.coefficient.program.executableArtifactDemand", formatConstraintStrength: "request_authority.coefficient.program.formatConstraintStrength", inferentialDepth: "request_authority.coefficient.program.inferentialDepth", actionCommitment: "request_authority.coefficient.program.actionCommitment", externalTruthAuthority: "request_authority.coefficient.program.externalTruthAuthority" },
  action: { actionCommitment: "request_authority.coefficient.action.actionCommitment", executableArtifactDemand: "request_authority.coefficient.action.executableArtifactDemand", externalTruthAuthority: "request_authority.coefficient.action.externalTruthAuthority", sourceDependence: "request_authority.coefficient.action.sourceDependence", noveltyDemand: "request_authority.coefficient.action.noveltyDemand" }
};

/**
 * Language-neutral requirement prototypes shared by explicit structured
 * authority and source-backed request-language learning.
 */
export function authorityRequirementCoefficients(
  authority: RequestedAuthority
): Partial<Record<TurnRequirementDimension, number>> {
  const keys = AUTHORITY_COEFFICIENT_KEYS[authority];
  return Object.fromEntries(Object.entries(keys).map(([dimension, key]) => [dimension, calibrated(key!)])) as Partial<Record<TurnRequirementDimension, number>>;
}

/** Scores an authority from the same requirement prototype used by learning. */
export function scoreRequestAuthority(
  requirementField: TurnRequirementField,
  authority: RequestedAuthority
): number {
  const coefficients = authorityRequirementCoefficients(authority);
  const logit = TURN_REQUIREMENT_DIMENSIONS.reduce((sum, dimension) => (
    sum + (coefficients[dimension] ?? 0) * requirementField[dimension]
  ), 0);
  // Keep this as a bounded routing energy. It is deliberately not exposed as
  // a probability until a caller applies its own calibrated model.
  return clamp01(calibrated("request_authority.projection_bias") + logit / calibrated("request_authority.projection_scale"));
}

/**
 * There is no such thing as a "creative turn" or a "factual turn" that the
 * judge is confined to -- every candidate the turn actually generated stays
 * eligible, regardless of kind. The projected authority is real information
 * (which kind of answer this request most likely calls for) but it is a
 * *signal*, not a partition: judge.ts's requirement-aware scoring path
 * (selectForRequirementField) already judges any candidate kind uniformly
 * on its own quality/support/coverage, keyed off the turn's real
 * requirement dimensions -- it never branched on requestedAuthority for
 * scoring or admission, only for its audit trace. Physically dropping
 * incompatible candidates here meant a well-supported factual candidate
 * could never win a turn the projector happened to call "creative" (or
 * vice versa), and a thin/wrong-authority pool forced a full-turn replan
 * instead of just letting the actually-best candidate answer. Kept as a
 * real function (not deleted) so the compatibility signal stays visible in
 * the audit trace for observability.
 *
 * One exception is not authority routing at all: for factual authority, a
 * candidate whose own proof/requirement signals say it has not established
 * the requested answer is not an answer candidate. Keeping those candidates
 * in the field allowed the judge to select a source-grounded surface that
 * was merely about the subject (for example an Apollo 11 launch sentence
 * for "Who commanded Apollo 11?") even though the trace already exposed
 * severe underdetermination. This gate consumes only candidate-internal
 * semantic/proof signals; it does not parse request language or add a second
 * lexical router.
 */
export function admitCandidatesForAuthority(
  field: CandidateField,
  authority: RequestedAuthority
): CandidateField {
  const compatible = field.candidates.filter(candidate =>
    candidateCompatibleWithAuthority(candidate, authority)
  );
  const rejectedForFactualProof = authority === "factual"
    ? field.candidates
      .map(candidate => ({ candidate, failures: factualCandidateAdmissionFailures(candidate) }))
      .filter(row => row.failures.length > 0)
    : [];
  const rejectedIds = new Set(rejectedForFactualProof.map(row => row.candidate.id));
  const admittedCandidates = field.candidates.filter(candidate => !rejectedIds.has(candidate.id));
  const admittedMassRows = field.surfaceMass.filter(row => !rejectedIds.has(row.candidateId));
  const admittedMassTotal = admittedMassRows.reduce((sum, row) => sum + row.mass, 0);
  const surfaceMass = admittedMassRows.map(row => ({
    ...row,
    mass: admittedMassTotal > 0 ? row.mass / admittedMassTotal : row.mass
  }));
  const existingAudit = field.audit !== null
    && typeof field.audit === "object"
    && !Array.isArray(field.audit)
    ? field.audit
    : {};

  return {
    ...field,
    candidates: admittedCandidates,
    surfaceMass,
    audit: toJsonValue({
      ...existingAudit,
      authorityAdmission: {
        schema: "scce.requested_authority.candidate_admission.v2",
        source: "requested_authority_projection",
        authority,
        generatedCandidateCount: field.candidates.length,
        compatibleCandidateIds: compatible.map(candidate => candidate.id),
        admittedCandidateIds: admittedCandidates.map(candidate => candidate.id),
        admittedCandidateKinds: admittedCandidates.map(candidate => candidate.kind),
        rejectedFactualProofCandidates: rejectedForFactualProof.map(row => ({
          candidateId: row.candidate.id,
          failures: row.failures
        })),
        authorityUnavailable: admittedCandidates.length === 0,
        fallbackToGeneratedField: false,
        lexicalRouterUsed: false
      }
    })
  };
}

function factualCandidateAdmissionFailures(candidate: CandidateSurface): string[] {
  const failures: string[] = [];
  if ((candidate.missedRequirementIds?.length ?? 0) > 0) failures.push("missed-required-output");
  if (candidate.boundaries.includes("unsupported-factual-claim")) failures.push("unsupported-factual-claim");

  if (!candidateCompatibleWithAuthority(candidate, "factual")
    && candidate.scores.support <= 0
    && candidate.scores.faithfulness <= 0) {
    failures.push("no-factual-support");
  }
  return failures;
}

export function candidateCompatibleWithAuthority(
  candidate: CandidateSurface,
  authority: RequestedAuthority
): boolean {
  if (authority === "factual") return candidate.kind === "proof-answer" || candidate.kind === "ccr-extractive";
  if (authority === "reasoned") return candidate.kind === "reasoned-synthesis"
    || candidate.kind === "ccr-extractive"
    || candidate.kind === "graph-inference"
    || candidate.kind === "causal-inference"
    || candidate.kind === "temporal-inference"
    || candidate.kind === "counterfactual-response";
  if (authority === "creative") return candidate.kind === "creative-candidate";
  if (authority === "translation") {
    return candidate.kind === "translation" && candidate.claimBases?.includes("translated") === true;
  }
  if (authority === "program") return candidate.kind === "program-proposal" || candidate.kind === "workspace-proposal";
  return candidate.kind === "action-preview";
}

/**
 * Projects request authority from the source-neutral turn-requirement field.
 * Scores are bounded routing energies, not calibrated probabilities.
 */
export function projectRequestAuthority(input: ProjectRequestAuthorityInput): RequestAuthorityProjection {
  const requirements = input.requirementField;
  const scores = Object.fromEntries(
    REQUESTED_AUTHORITY_IDS.map(authority => [authority, scoreRequestAuthority(requirements, authority)])
  ) as Record<RequestedAuthority, number>;
  const ranked = REQUESTED_AUTHORITY_IDS
    .map(authority => ({ authority, score: scores[authority] }))
    .sort((left, right) => right.score - left.score || (left.authority < right.authority ? -1 : left.authority > right.authority ? 1 : 0));
  const projectedAuthority = ranked[0]?.authority ?? "factual";
  const requestedAuthority = input.explicitAuthority ?? projectedAuthority;
  const scoreMargin = clamp01((ranked[0]?.score ?? 0) - (ranked[1]?.score ?? 0));
  const trace = toJsonValue({
    schema: "scce.requested_authority.requirement_projection.v2",
    requestedAuthority,
    selectedAuthority: requestedAuthority,
    projectedAuthority,
    explicitOverride: Boolean(input.explicitAuthority),
    source: "turn_requirement_field",
    lexicalRouterUsed: false,
    scoreReliability: "uncalibrated_bootstrap",
    scoreSemantics: "bounded_routing_energy_not_probability",
    scores,
    scoreMargin,
    requirementConfidence: requirements.confidence,
    equationId: "equation.requested_authority.requirement_prototype_projection.v1"
  });
  return {
    schema: "scce.requested_authority.requirement_projection.v2",
    requestedAuthority,
    selectedAuthority: requestedAuthority,
    projectedAuthority,
    explicitOverride: Boolean(input.explicitAuthority),
    scores,
    scoreMargin,
    trace
  };
}

/**
 * A projected authority can only initiate a physical lane when its matching
 * cognitive operator is active. This checks typed state, never request text.
 */
export function operationalAuthorityForProjection(input: {
  projection: RequestAuthorityProjection;
  activeOperatorIds: readonly CognitiveOperatorId[];
}): RequestedAuthority {
  const active = new Set(input.activeOperatorIds);
  const eligible = (authority: RequestedAuthority): boolean => authority !== "program"
    ? authority !== "action" || active.has(COGNITIVE_OPERATOR_IDS.actionPlanning)
    : active.has(COGNITIVE_OPERATOR_IDS.programPlanning);
  if (eligible(input.projection.requestedAuthority)) return input.projection.requestedAuthority;
  return REQUESTED_AUTHORITY_IDS
    .filter(eligible)
    .map(authority => ({ authority, score: input.projection.scores[authority] }))
    .sort((left, right) => right.score - left.score || left.authority.localeCompare(right.authority))[0]?.authority
    ?? "reasoned";
}

/** Shared dialogue contribution used before graph/outcome support is available. */
export function requestOperatorDialogueSupport(requirements: TurnRequirementField): OperatorSupportMap {
  return {
    [COGNITIVE_OPERATOR_IDS.dialogueContinuation]: Math.max(-1, Math.min(1, requirements.dialogueDependence * calibrated("request_authority.dialogue_continuation_scale"))),
    [COGNITIVE_OPERATOR_IDS.clarification]: Math.max(-1, Math.min(1, (1 - requirements.confidence) * calibrated("request_authority.clarification_uncertainty_scale")))
  };
}

export function requestOperatorGraphSupport(input: {
  graph: GraphSlice;
  evidence: readonly EvidenceSpan[];
  field: FieldState;
}): OperatorSupportMap {
  const sourceCount = new Set(input.evidence.map(span => String(span.sourceVersionId))).size;
  const graphMass = clamp01(Math.log2(1 + input.graph.edges.length) / calibrated("request_authority.graph_edge_log_scale"));
  const evidenceMass = clamp01(Math.log2(1 + input.evidence.length) / calibrated("request_authority.evidence_log_scale"));
  const causalMass = clamp01(mean(input.field.causalMass.slice(0, calibrated("request_authority.causal_mass_sample_limit")).map(row => row.mass)));
  const hasQualifiedTime = input.graph.edges.some(edge =>
    isKnownGraphTemporalScope(edge.temporalScope)
    && edge.temporalScope.validTo !== undefined);
  return {
    [COGNITIVE_OPERATOR_IDS.evidenceActivation]: evidenceMass,
    [COGNITIVE_OPERATOR_IDS.graphPropagation]: graphMass,
    [COGNITIVE_OPERATOR_IDS.sourceSynthesis]: sourceCount >= calibrated("request_authority.source_synthesis_threshold") ? Math.min(1, sourceCount / calibrated("request_authority.source_synthesis_divisor")) : 0,
    [COGNITIVE_OPERATOR_IDS.relationComposition]: input.graph.edges.length >= calibrated("request_authority.relation_composition_edge_threshold") ? graphMass : 0,
    [COGNITIVE_OPERATOR_IDS.semanticProof]: evidenceMass,
    [COGNITIVE_OPERATOR_IDS.temporalAnalysis]: hasQualifiedTime ? graphMass : 0,
    [COGNITIVE_OPERATOR_IDS.causalAnalysis]: causalMass
  };
}

export interface ExplicitAuthorityRequirementsInput {
  requestText: string;
  authority?: RequestedAuthority;
  sourceId?: string;
}

/**
 * Converts an explicit structured authority into the same requirement field
 * inputs used by learned frames. It does not inspect request surface text.
 */
export function explicitAuthorityRequirements(input: ExplicitAuthorityRequirementsInput): ExplicitTurnRequirement[] {
  const authority = input.authority;
  if (!authority) return [];
  const values: Partial<Record<TurnRequirementDimension, number>> =
    authority === "creative" ? { noveltyDemand: 0.96, inferentialDepth: 0.62, uncertaintyTolerance: 0.74 }
      : authority === "translation" ? { semanticPreservation: 0.97, surfaceTransformation: 0.96, audienceAdaptation: 0.64 }
        : authority === "program" ? { executableArtifactDemand: 0.96, inferentialDepth: 0.72, formatConstraintStrength: 0.62 }
          : authority === "action" ? { actionCommitment: 0.97, executableArtifactDemand: 0.72 }
            : authority === "reasoned" ? { inferentialDepth: 0.9, externalTruthAuthority: 0.62, uncertaintyTolerance: 0.46 }
              : { externalTruthAuthority: 0.92, sourceDependence: 0.82, uncertaintyTolerance: 0.34 };
  const sourceId = input.sourceId ?? "structured_request.authority";
  const charEnd = [...input.requestText].length;
  return Object.entries(values).flatMap(([dimension, value]) => {
    if (!isTurnRequirementDimension(dimension) || value === undefined) return [];
    return [{
      id: `requirement.structured_authority.${authority}.${dimension}.v1`,
      dimension,
      value,
      confidence: 1,
      polarity: "required" as const,
      status: "explicit" as const,
      span: { charStart: 0, charEnd },
      semanticRoleId: "role.request.authority.v1",
      learnedFrameOrPatternId: `pattern.structured_authority.${authority}.v1`,
      sourceActivationId: "activation.structured_api.authority.v1",
      trace: toJsonValue({ source: sourceId, authority })
    }];
  });
}

function isTurnRequirementDimension(value: string): value is TurnRequirementDimension {
  return (TURN_REQUIREMENT_DIMENSIONS as readonly string[]).includes(value);
}

export function activeRequestOperatorIds(
  operators: readonly { operatorId: CognitiveOperatorId; active: boolean }[]
): CognitiveOperatorId[] {
  return operators.filter(row => row.active).map(row => row.operatorId);
}
