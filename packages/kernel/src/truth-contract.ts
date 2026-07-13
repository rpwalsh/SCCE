import type { TruthState } from "./types.js";

export type EvidenceForceClass =
  | "direct_evidence"
  | "profile_excerpt_evidence"
  | "learned_language_prior"
  | "learned_concept_prior"
  | "learned_program_prior"
  | "unknown_prior";

export type TruthProofVerdict =
  | "certified"
  | "insufficient_evidence"
  | "contradicted"
  | "unsupported_prior_only"
  | "source_bound_only"
  | "ambiguous";

export type EvidenceForce =
  | "evidence.direct_source_span"
  | "evidence.source_bound_profile_excerpt"
  | "evidence.learned_prior"
  | "evidence.unknown_prior";

export function evidenceForceFromProofForceClass(forceClass: EvidenceForceClass): EvidenceForce {
  if (forceClass === "direct_evidence") return "evidence.direct_source_span";
  if (forceClass === "profile_excerpt_evidence") return "evidence.source_bound_profile_excerpt";
  if (forceClass === "unknown_prior") return "evidence.unknown_prior";
  return "evidence.learned_prior";
}

export function truthStateFromProofVerdict(verdict: TruthProofVerdict): TruthState {
  if (verdict === "certified") return "truth.certified";
  if (verdict === "contradicted") return "truth.contradicted";
  if (verdict === "source_bound_only") return "truth.source_bound_only";
  if (verdict === "unsupported_prior_only") return "truth.unsupported_prior_only";
  if (verdict === "ambiguous") return "truth.ambiguous";
  return "truth.insufficient_evidence";
}

export function isUnsupportedTruthState(state: TruthState): boolean {
  return state === "truth.unsupported_prior_only" || state === "truth.insufficient_evidence";
}

export function isSourceBackedTruthState(state: TruthState): boolean {
  return state === "truth.certified" || state === "truth.source_bound_only";
}
