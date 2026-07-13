export type ProofForceClass =
  | "direct_evidence"
  | "profile_excerpt_evidence"
  | "learned_language_prior"
  | "learned_concept_prior"
  | "learned_program_prior"
  | "unknown_prior";

import { truthStateFromProofVerdict } from "./truth-contract.js";
import type { TruthState } from "./types.js";
import { featureScore, provisionalHeuristicScore, type ScoreTrace } from "./scoring/score-trace.js";
import { bayesUpdate, shannonEntropy } from "./equation-operators.js";
import { clamp01 } from "./primitives.js";

export interface ProofAtom {
  id?: string;
  surface?: string;
  kindId?: string;
}

export interface ProofScalar {
  value: number;
  unitId?: string;
  tolerance?: number;
}

export interface ProofDateTime {
  value: string;
  precisionId?: string;
}

export interface ProofClaim {
  id: string;
  subject: ProofAtom;
  relationId: string;
  object: ProofAtom;
  quantity?: ProofScalar;
  dateTime?: ProofDateTime;
  polarityId?: string;
  modalityId?: string;
  requiredSourceBinding?: boolean;
}

export interface ProofEvidenceRecord {
  id: string;
  forceClass: ProofForceClass;
  sourceVersionId?: string;
  evidenceSpanId?: string;
  subject: ProofAtom;
  relationId: string;
  object: ProofAtom;
  quantity?: ProofScalar;
  dateTime?: ProofDateTime;
  polarityId?: string;
  modalityId?: string;
  text?: string;
}

export interface ProofPolicy {
  defaultModalityId: string;
  defaultPolarityId: string;
  modalityStrength: Record<string, number>;
  polarityContradictions: Array<[string, string]>;
  relationCompatibility: Record<string, string[]>;
}

export interface SemanticProofInput {
  claim: ProofClaim;
  candidateEvidence: ProofEvidenceRecord[];
  policy?: ProofPolicy;
}

export type SemanticProofEngineVerdict =
  | "certified"
  | "insufficient_evidence"
  | "contradicted"
  | "unsupported_prior_only"
  | "source_bound_only"
  | "ambiguous";

export interface SemanticProofObligation {
  kind: string;
  passed: boolean;
  reason?: string;
}

export interface SemanticProofResult {
  verdict: SemanticProofEngineVerdict;
  truthState: TruthState;
  certifiedEvidenceIds: string[];
  rejectedEvidence: Array<{ evidenceId: string; reason: string }>;
  obligations: SemanticProofObligation[];
  contradictions: Array<{ evidenceId: string; kind: string; reason: string }>;
  scoreTrace: ScoreTrace[];
  trace: Record<string, unknown>;
}

interface EvidenceAdmission {
  evidence: ProofEvidenceRecord;
  canCertify: boolean;
  sourceBoundOnly: boolean;
  priorOnly: boolean;
  reason: string;
}

interface CandidateEvaluation {
  evidenceId: string;
  canCertify: boolean;
  obligations: SemanticProofObligation[];
  contradictions: Array<{ evidenceId: string; kind: string; reason: string }>;
  ambiguousSubjectId?: string;
  ambiguousObjectId?: string;
}

const DIRECT_EVIDENCE: ProofForceClass = "direct_evidence";
const PROFILE_EXCERPT_EVIDENCE: ProofForceClass = "profile_excerpt_evidence";
const UNKNOWN_PRIOR: ProofForceClass = "unknown_prior";
const LEARNED_PRIOR_CLASSES: readonly ProofForceClass[] = [
  "learned_language_prior",
  "learned_concept_prior",
  "learned_program_prior"
];

export const DEFAULT_PROOF_POLICY: ProofPolicy = {
  defaultModalityId: "modality.asserted",
  defaultPolarityId: "polarity.positive",
  modalityStrength: {
    "modality.asserted": 1,
    "modality.reported": 0.82,
    "modality.estimated": 0.72,
    "modality.planned": 0.52,
    "modality.possible": 0.34
  },
  polarityContradictions: [["polarity.positive", "polarity.negative"]],
  relationCompatibility: {}
};

export function proveClaim(input: SemanticProofInput): SemanticProofResult {
  const policy = normalizePolicy(input.policy);
  const claim = normalizeClaim(input.claim, policy);
  const admissions = input.candidateEvidence.map(evidence => admitEvidence(evidence));
  const rejectedEvidence = admissions
    .filter(admission => !admission.canCertify)
    .map(admission => ({ evidenceId: admission.evidence.id, reason: admission.reason }));
  const obligations: SemanticProofObligation[] = [];
  const contradictions: Array<{ evidenceId: string; kind: string; reason: string }> = [];
  const certified: CandidateEvaluation[] = [];
  const evaluated: CandidateEvaluation[] = [];

  for (const admission of admissions) {
    if (!admission.canCertify) continue;
    const evaluation = evaluateCandidate(claim, admission.evidence, policy);
    evaluated.push(evaluation);
    obligations.push(...evaluation.obligations);
    contradictions.push(...evaluation.contradictions);
    if (evaluation.canCertify) certified.push(evaluation);
  }

  const directEvidenceCount = admissions.filter(admission => admission.evidence.forceClass === DIRECT_EVIDENCE).length;
  const sourceBoundCount = admissions.filter(admission => admission.sourceBoundOnly).length;
  const priorOnlyCount = admissions.filter(admission => admission.priorOnly).length;
  const verdict = proofVerdict({
    candidateEvidenceCount: input.candidateEvidence.length,
    directEvidenceCount,
    sourceBoundCount,
    priorOnlyCount,
    certified,
    contradictions,
    evaluated
  });
  const certifiedEvidenceIds = verdict === "certified"
    ? [...new Set(certified.map(item => item.evidenceId))]
    : [];

  if (!input.candidateEvidence.length) {
    obligations.push({ kind: "coverage", passed: false, reason: "no_candidate_evidence" });
  } else if (!evaluated.length) {
    obligations.push({ kind: "coverage", passed: false, reason: "no_admissible_direct_evidence" });
  } else {
    obligations.push({ kind: "coverage", passed: certified.length > 0 && contradictions.length === 0, reason: certified.length > 0 ? "candidate_coverage_checked" : "candidate_coverage_failed" });
  }

  const directEvidenceFraction = input.candidateEvidence.length
    ? directEvidenceCount / input.candidateEvidence.length
    : 0;
  const contradictionFraction = input.candidateEvidence.length
    ? contradictions.length / Math.max(1, input.candidateEvidence.length)
    : 0;
  const certifiedFraction = evaluated.length
    ? certified.length / Math.max(1, evaluated.length)
    : 0;
  const ambiguity = shannonEntropy([certifiedFraction, contradictionFraction, Math.max(0, 1 - certifiedFraction - contradictionFraction)]);
  const bayes = bayesUpdate({
    prior: directEvidenceFraction || 0.01,
    likelihood: certifiedFraction || 0.01,
    alternativeLikelihood: Math.max(0.01, contradictionFraction)
  });
  const confidenceLcb = clamp01(Math.max(0, certifiedFraction - contradictionFraction * 0.5) * 0.76 + bayes.posterior * 0.24 - ambiguity.normalized * 0.08);
  const scoreTrace: ScoreTrace[] = [
    featureScore({
      value: directEvidenceFraction,
      range: [0, 1],
      meaning: "proof direct evidence fraction",
      inputs: ["candidateEvidence"],
      provenance: ["semantic-proof-engine.ts:proveClaim"]
    }),
    featureScore({
      value: certifiedFraction,
      range: [0, 1],
      meaning: "proof support mass",
      inputs: ["candidateEvidence"],
      provenance: ["semantic-proof-engine.ts:proveClaim"]
    }),
    featureScore({
      value: contradictionFraction,
      range: [0, 1],
      meaning: "proof contradiction mass",
      inputs: ["candidateEvidence"],
      provenance: ["semantic-proof-engine.ts:proveClaim"]
    }),
    provisionalHeuristicScore({
      value: Math.min(1, Math.max(0, confidenceLcb)),
      range: [0, 1],
      meaning: "proof confidence lower bound heuristic",
      inputs: ["supportMass", "contradictionMass", "modality"],
      provenance: ["semantic-proof-engine.ts:proveClaim"],
      failureModes: ["modality_mismatch", "evidence_bias", "source_quality_gap"]
    }),
    provisionalHeuristicScore({
      value: ambiguity.normalized,
      range: [0, 1],
      meaning: "proof ambiguity entropy",
      inputs: ["supportMass", "contradictionMass", "unresolvedMass"],
      provenance: ["semantic-proof-engine.ts:proveClaim"],
      failureModes: ["ambiguous_candidate_set", "contradictory_evidence"]
    })
  ];

  return {
    verdict,
    truthState: truthStateFromProofVerdict(verdict),
    certifiedEvidenceIds,
    rejectedEvidence,
    obligations,
    contradictions,
    scoreTrace,
    trace: {
      claimId: claim.id,
      candidateEvidenceCount: input.candidateEvidence.length,
      admittedEvidenceCount: admissions.filter(admission => admission.canCertify).length,
      rejectedEvidenceCount: rejectedEvidence.length,
      directEvidenceCount,
      sourceBoundEvidenceCount: sourceBoundCount,
      priorOnlyEvidenceCount: priorOnlyCount,
      certifiedCandidateCount: certified.length,
      contradictionCount: contradictions.length,
      relationCompatibilityPolicySize: Object.keys(policy.relationCompatibility).length,
      modalityStrengthIds: Object.keys(policy.modalityStrength).sort(),
      certifiedEvidenceIds,
      rejectedEvidence,
      bayes,
      ambiguityEntropy: ambiguity,
      candidateOnlySignals: {
        learnedPriors: priorOnlyCount,
        profileExcerpts: sourceBoundCount
      }
    }
  };
}

function normalizePolicy(policy: ProofPolicy | undefined): ProofPolicy {
  if (!policy) return DEFAULT_PROOF_POLICY;
  return {
    defaultModalityId: policy.defaultModalityId || DEFAULT_PROOF_POLICY.defaultModalityId,
    defaultPolarityId: policy.defaultPolarityId || DEFAULT_PROOF_POLICY.defaultPolarityId,
    modalityStrength: { ...DEFAULT_PROOF_POLICY.modalityStrength, ...policy.modalityStrength },
    polarityContradictions: policy.polarityContradictions.length ? policy.polarityContradictions : DEFAULT_PROOF_POLICY.polarityContradictions,
    relationCompatibility: { ...policy.relationCompatibility }
  };
}

function normalizeClaim(claim: ProofClaim, policy: ProofPolicy): ProofClaim {
  return {
    ...claim,
    polarityId: claim.polarityId ?? policy.defaultPolarityId,
    modalityId: claim.modalityId ?? policy.defaultModalityId,
    requiredSourceBinding: claim.requiredSourceBinding ?? true
  };
}

function admitEvidence(evidence: ProofEvidenceRecord): EvidenceAdmission {
  if (evidence.forceClass === DIRECT_EVIDENCE) {
    if (!nonEmpty(evidence.sourceVersionId) || !nonEmpty(evidence.evidenceSpanId)) {
      return { evidence, canCertify: false, sourceBoundOnly: false, priorOnly: false, reason: "missing_source_binding" };
    }
    return { evidence, canCertify: true, sourceBoundOnly: false, priorOnly: false, reason: "admitted.direct_evidence.exact_span" };
  }
  if (evidence.forceClass === PROFILE_EXCERPT_EVIDENCE) {
    return { evidence, canCertify: false, sourceBoundOnly: true, priorOnly: false, reason: "profile_excerpt_external_claim" };
  }
  if (evidence.forceClass === UNKNOWN_PRIOR) {
    return { evidence, canCertify: false, sourceBoundOnly: false, priorOnly: true, reason: "unknown_force_class" };
  }
  if (LEARNED_PRIOR_CLASSES.includes(evidence.forceClass)) {
    return { evidence, canCertify: false, sourceBoundOnly: false, priorOnly: true, reason: "learned_prior_not_evidence" };
  }
  return { evidence, canCertify: false, sourceBoundOnly: false, priorOnly: false, reason: "unknown_force_class" };
}

function evaluateCandidate(claim: ProofClaim, evidence: ProofEvidenceRecord, policy: ProofPolicy): CandidateEvaluation {
  const obligations: SemanticProofObligation[] = [];
  const contradictions: Array<{ evidenceId: string; kind: string; reason: string }> = [];
  const subject = evaluateAtom("entity_identity", claim.subject, evidence.subject);
  const object = evaluateAtom("entity_identity", claim.object, evidence.object);
  const relation = evaluateRelation(claim.relationId, evidence.relationId, policy);
  obligations.push({ kind: "source_binding", passed: true, reason: "admitted.direct_evidence.exact_span" });
  obligations.push({ kind: "entity_identity", passed: subject.passed, reason: subject.reason });
  obligations.push({ kind: "entity_identity", passed: object.passed, reason: object.reason });
  obligations.push({ kind: "relation", passed: relation.passed, reason: relation.reason });
  if (!subject.passed && relation.passed) contradictions.push({ evidenceId: evidence.id, kind: "entity_identity", reason: subject.reason });
  if (!object.passed && relation.passed) contradictions.push({ evidenceId: evidence.id, kind: "entity_identity", reason: object.reason });

  const quantity = evaluateQuantity(claim.quantity, evidence.quantity);
  obligations.push(...quantity.obligations);
  if (quantity.contradiction) contradictions.push({ evidenceId: evidence.id, kind: quantity.contradiction.kind, reason: quantity.contradiction.reason });

  const dateTime = evaluateDateTime(claim.dateTime, evidence.dateTime);
  obligations.push(...dateTime.obligations);
  if (dateTime.contradiction) contradictions.push({ evidenceId: evidence.id, kind: dateTime.contradiction.kind, reason: dateTime.contradiction.reason });

  const polarity = evaluatePolarity(claim.polarityId ?? policy.defaultPolarityId, evidence.polarityId ?? policy.defaultPolarityId, policy);
  obligations.push({ kind: "polarity", passed: polarity.passed, reason: polarity.reason });
  if (polarity.contradiction) contradictions.push({ evidenceId: evidence.id, kind: "polarity", reason: polarity.reason });

  const modality = evaluateModality(claim.modalityId ?? policy.defaultModalityId, evidence.modalityId ?? policy.defaultModalityId, policy);
  obligations.push({ kind: "modality", passed: modality.passed, reason: modality.reason });

  const criticalPassed = obligations.every(obligation => obligation.passed);
  return {
    evidenceId: evidence.id,
    canCertify: criticalPassed && contradictions.length === 0,
    obligations,
    contradictions,
    ambiguousSubjectId: ambiguousAtomId(claim.subject, evidence.subject),
    ambiguousObjectId: ambiguousAtomId(claim.object, evidence.object)
  };
}

function evaluateAtom(kind: string, claim: ProofAtom, evidence: ProofAtom): { kind: string; passed: boolean; reason: string } {
  if (nonEmpty(claim.id) && nonEmpty(evidence.id)) {
    return { kind, passed: claim.id === evidence.id, reason: claim.id === evidence.id ? "atom_id_exact" : "atom_id_mismatch" };
  }
  if (nonEmpty(claim.id) || nonEmpty(evidence.id)) {
    const claimSurface = normalizedSurface(claim.surface);
    const evidenceSurface = normalizedSurface(evidence.surface);
    const exactSurface = Boolean(claimSurface && claimSurface === evidenceSurface);
    return { kind, passed: exactSurface, reason: exactSurface ? "atom_surface_exact_id_missing" : "atom_id_missing" };
  }
  const claimSurface = normalizedSurface(claim.surface);
  const evidenceSurface = normalizedSurface(evidence.surface);
  if (!claimSurface || !evidenceSurface) return { kind, passed: false, reason: "atom_identity_missing" };
  return { kind, passed: claimSurface === evidenceSurface, reason: claimSurface === evidenceSurface ? "atom_surface_exact" : "atom_surface_mismatch" };
}

function evaluateRelation(claimRelationId: string, evidenceRelationId: string, policy: ProofPolicy): { passed: boolean; reason: string } {
  if (claimRelationId === evidenceRelationId) return { passed: true, reason: "relation_id_exact" };
  const compatible = policy.relationCompatibility[claimRelationId] ?? [];
  return {
    passed: compatible.includes(evidenceRelationId),
    reason: compatible.includes(evidenceRelationId) ? "relation_policy_compatible" : "relation_id_mismatch"
  };
}

function evaluateQuantity(
  claim: ProofScalar | undefined,
  evidence: ProofScalar | undefined
): { obligations: SemanticProofObligation[]; contradiction?: { kind: string; reason: string } } {
  if (!claim) return { obligations: [] };
  if (!evidence) return { obligations: [{ kind: "quantity", passed: false, reason: "quantity_missing" }] };
  const obligations: SemanticProofObligation[] = [];
  const unitPassed = !claim.unitId || !evidence.unitId || claim.unitId === evidence.unitId;
  obligations.push({ kind: "unit", passed: unitPassed, reason: unitPassed ? "unit_compatible" : "unit_conflict" });
  if (!unitPassed) return { obligations, contradiction: { kind: "unit", reason: "unit_conflict" } };
  const tolerance = Math.max(0, claim.tolerance ?? evidence.tolerance ?? 0);
  const passed = Math.abs(claim.value - evidence.value) <= tolerance;
  obligations.push({ kind: "quantity", passed, reason: passed ? "quantity_within_tolerance" : "quantity_conflict" });
  return passed ? { obligations } : { obligations, contradiction: { kind: "quantity", reason: "quantity_conflict" } };
}

function evaluateDateTime(
  claim: ProofDateTime | undefined,
  evidence: ProofDateTime | undefined
): { obligations: SemanticProofObligation[]; contradiction?: { kind: string; reason: string } } {
  if (!claim) return { obligations: [] };
  if (!evidence) return { obligations: [{ kind: "date_time", passed: false, reason: "date_time_missing" }] };
  const valuePassed = claim.value === evidence.value;
  const precisionPassed = !claim.precisionId || !evidence.precisionId || claim.precisionId === evidence.precisionId;
  const passed = valuePassed && precisionPassed;
  const reason = !valuePassed ? "date_time_conflict" : precisionPassed ? "date_time_exact" : "date_time_precision_mismatch";
  return passed
    ? { obligations: [{ kind: "date_time", passed: true, reason }] }
    : { obligations: [{ kind: "date_time", passed: false, reason }], contradiction: valuePassed ? undefined : { kind: "date_time", reason } };
}

function evaluatePolarity(claimPolarityId: string, evidencePolarityId: string, policy: ProofPolicy): { passed: boolean; contradiction: boolean; reason: string } {
  if (claimPolarityId === evidencePolarityId) return { passed: true, contradiction: false, reason: "polarity_id_exact" };
  const contradiction = policy.polarityContradictions.some(([left, right]) =>
    left === claimPolarityId && right === evidencePolarityId || left === evidencePolarityId && right === claimPolarityId
  );
  return { passed: false, contradiction, reason: contradiction ? "polarity_policy_contradiction" : "polarity_policy_mismatch" };
}

function evaluateModality(claimModalityId: string, evidenceModalityId: string, policy: ProofPolicy): { passed: boolean; reason: string } {
  const claimStrength = policy.modalityStrength[claimModalityId] ?? 1;
  const evidenceStrength = policy.modalityStrength[evidenceModalityId] ?? 0;
  return {
    passed: evidenceStrength >= claimStrength,
    reason: evidenceStrength >= claimStrength ? "modality_strength_sufficient" : "modality_strength_insufficient"
  };
}

function proofVerdict(input: {
  candidateEvidenceCount: number;
  directEvidenceCount: number;
  sourceBoundCount: number;
  priorOnlyCount: number;
  certified: CandidateEvaluation[];
  contradictions: Array<{ evidenceId: string; kind: string; reason: string }>;
  evaluated: CandidateEvaluation[];
}): SemanticProofEngineVerdict {
  if (input.candidateEvidenceCount === 0) return "insufficient_evidence";
  if (input.contradictions.length > 0) return "contradicted";
  if (input.certified.length > 0) return ambiguousCertification(input.certified) ? "ambiguous" : "certified";
  if (input.sourceBoundCount > 0 && input.directEvidenceCount === 0) return "source_bound_only";
  if (input.priorOnlyCount > 0 && input.directEvidenceCount === 0) return "unsupported_prior_only";
  return "insufficient_evidence";
}

function ambiguousCertification(certified: readonly CandidateEvaluation[]): boolean {
  if (certified.length <= 1) return false;
  const subjects = new Set(certified.map(item => item.ambiguousSubjectId).filter(nonEmpty));
  const objects = new Set(certified.map(item => item.ambiguousObjectId).filter(nonEmpty));
  return subjects.size > 1 || objects.size > 1;
}

function ambiguousAtomId(claim: ProofAtom, evidence: ProofAtom): string | undefined {
  if (nonEmpty(claim.id)) return undefined;
  return evidence.id ?? normalizedSurface(evidence.surface);
}

function normalizedSurface(value: string | undefined): string {
  if (!value) return "";
  let out = "";
  let pendingSpace = false;
  for (const char of value.normalize("NFKC").toLocaleLowerCase()) {
    if (isWhitespace(char)) {
      pendingSpace = out.length > 0;
      continue;
    }
    if (pendingSpace) out += " ";
    pendingSpace = false;
    out += char;
  }
  return out.trim();
}

function isWhitespace(char: string): boolean {
  return char === " " || char === "\t" || char === "\n" || char === "\r" || char === "\f" || char === "\v";
}

function nonEmpty(value: string | undefined): value is string {
  return typeof value === "string" && value.length > 0;
}
