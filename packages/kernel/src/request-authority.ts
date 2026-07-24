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

export const REQUESTED_AUTHORITY_IDS = [
  "factual",
  "reasoned",
  "creative",
  "translation",
  "program",
  "action"
] as const satisfies readonly RequestedAuthority[];

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

/**
 * Language-neutral requirement prototypes shared by explicit structured
 * authority and source-backed request-language learning.
 */
export function authorityRequirementCoefficients(
  authority: RequestedAuthority
): Partial<Record<TurnRequirementDimension, number>> {
  if (authority === "creative") {
    return {
      noveltyDemand: 4.8,
      inferentialDepth: 1.2,
      uncertaintyTolerance: 2.0,
      counterfactualDemand: 0.9,
      externalTruthAuthority: -4.0,
      sourceDependence: -3.4,
      executableArtifactDemand: -1.8,
      actionCommitment: -1.8
    };
  }
  if (authority === "translation") {
    return {
      semanticPreservation: 4.8,
      surfaceTransformation: 4.6,
      audienceAdaptation: 1.5,
      externalTruthAuthority: -2.2,
      noveltyDemand: -1.8
    };
  }
  if (authority === "program") {
    return {
      executableArtifactDemand: 4.8,
      formatConstraintStrength: 2.8,
      inferentialDepth: 1.7,
      actionCommitment: 0.7,
      externalTruthAuthority: -1.2
    };
  }
  if (authority === "action") {
    return {
      actionCommitment: 4.9,
      executableArtifactDemand: 2.0,
      externalTruthAuthority: 0.8,
      sourceDependence: 0.5,
      noveltyDemand: -2.2
    };
  }
  if (authority === "reasoned") {
    return {
      inferentialDepth: 4.4,
      causalReasoningDemand: 1.6,
      temporalReasoningDemand: 0.7,
      externalTruthAuthority: 1.0,
      sourceDependence: 0.5,
      noveltyDemand: -1.2
    };
  }
  return {
    externalTruthAuthority: 4.6,
    sourceDependence: 3.7,
    uncertaintyTolerance: -1.2,
    inferentialDepth: -0.8,
    noveltyDemand: -3.4,
    executableArtifactDemand: -2.4,
    actionCommitment: -2.2
  };
}

/**
 * Keeps the judge on the candidate family licensed by the projected request
 * authority. Missing families are handed back to the runtime continuation
 * boundary; unrelated answer families are never reopened as a fallback.
 */
export function admitCandidatesForAuthority(
  field: CandidateField,
  authority: RequestedAuthority
): CandidateField {
  const compatible = field.candidates.filter(candidate =>
    candidateCompatibleWithAuthority(candidate, authority)
  );
  const admitted = compatible;

  const admittedIds = new Set(admitted.map(candidate => candidate.id));
  const admittedMass = field.surfaceMass.filter(row => admittedIds.has(row.candidateId));
  const massTotal = admittedMass.reduce((sum, row) => sum + row.mass, 0);
  const normalizedMass = admittedMass.map(row => ({
    ...row,
    mass: massTotal > 0 ? row.mass / massTotal : admitted.length > 0 ? 1 / admitted.length : 0
  }));
  const existingAudit = field.audit !== null
    && typeof field.audit === "object"
    && !Array.isArray(field.audit)
    ? field.audit
    : {};

  return {
    ...field,
    candidates: admitted,
    surfaceMass: normalizedMass,
    audit: toJsonValue({
      ...existingAudit,
      authorityAdmission: {
        schema: "scce.requested_authority.candidate_admission.v1",
        source: "requested_authority_projection",
        authority,
        generatedCandidateCount: field.candidates.length,
        compatibleCandidateIds: compatible.map(candidate => candidate.id),
        admittedCandidateIds: admitted.map(candidate => candidate.id),
        admittedCandidateKinds: admitted.map(candidate => candidate.kind),
        authorityUnavailable: compatible.length === 0,
        fallbackToGeneratedField: false,
        lexicalRouterUsed: false
      }
    })
  };
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
  const scores: Record<RequestedAuthority, number> = {
    factual: clamp01(0.42 + 0.34 * requirements.externalTruthAuthority + 0.24 * requirements.sourceDependence),
    reasoned: clamp01(0.18 + 0.62 * requirements.inferentialDepth + 0.12 * requirements.causalReasoningDemand + 0.08 * requirements.temporalReasoningDemand),
    creative: clamp01(0.10 + 0.72 * requirements.noveltyDemand + 0.18 * requirements.counterfactualDemand),
    translation: clamp01(0.08 + 0.47 * requirements.semanticPreservation + 0.45 * requirements.surfaceTransformation),
    program: clamp01(0.08 + 0.72 * requirements.executableArtifactDemand + 0.20 * requirements.formatConstraintStrength),
    action: clamp01(0.08 + 0.78 * requirements.actionCommitment + 0.14 * requirements.executableArtifactDemand)
  };
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
    equationId: "equation.requested_authority.requirement_projection.v1"
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

/** Shared dialogue contribution used before graph/outcome support is available. */
export function requestOperatorDialogueSupport(requirements: TurnRequirementField): OperatorSupportMap {
  return {
    [COGNITIVE_OPERATOR_IDS.dialogueContinuation]: Math.max(-1, Math.min(1, requirements.dialogueDependence * 0.5)),
    [COGNITIVE_OPERATOR_IDS.clarification]: Math.max(-1, Math.min(1, (1 - requirements.confidence) * 0.35))
  };
}

export function requestOperatorGraphSupport(input: {
  graph: GraphSlice;
  evidence: readonly EvidenceSpan[];
  field: FieldState;
}): OperatorSupportMap {
  const sourceCount = new Set(input.evidence.map(span => String(span.sourceVersionId))).size;
  const graphMass = clamp01(Math.log2(1 + input.graph.edges.length) / 8);
  const evidenceMass = clamp01(Math.log2(1 + input.evidence.length) / 5);
  const causalMass = clamp01(mean(input.field.causalMass.slice(0, 12).map(row => row.mass)));
  const hasQualifiedTime = input.graph.edges.some(edge => edge.temporalScope.validTo !== undefined);
  return {
    [COGNITIVE_OPERATOR_IDS.evidenceActivation]: evidenceMass,
    [COGNITIVE_OPERATOR_IDS.graphPropagation]: graphMass,
    [COGNITIVE_OPERATOR_IDS.sourceSynthesis]: sourceCount >= 2 ? Math.min(1, sourceCount / 4) : 0,
    [COGNITIVE_OPERATOR_IDS.relationComposition]: input.graph.edges.length >= 2 ? graphMass : 0,
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
