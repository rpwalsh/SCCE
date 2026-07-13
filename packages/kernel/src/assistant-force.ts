import type { ClaimBasis } from "./cognitive-planner.js";
import type { AssistantForceClass, EpistemicForce, EvidenceId, JsonValue, RequestedAuthority, TruthState } from "./types.js";
import { clamp01, toJsonValue } from "./primitives.js";
import { isUnsupportedTruthState } from "./truth-contract.js";

export interface AssistantForceClaim {
  readonly id: string;
  readonly basis: ClaimBasis;
  readonly evidenceIds?: readonly EvidenceId[] | readonly string[];
  readonly priorIds?: readonly string[];
  readonly actionReceiptId?: string;
  readonly actionStatus?: "succeeded" | "failed";
  readonly certified?: boolean;
}

export interface AssistantForceSelectedProposal {
  readonly id: string;
  readonly claims: readonly AssistantForceClaim[];
}

/**
 * A receipt is admissible only after a durable store has assigned its stable id
 * and content hash. `actionReceiptId` on a claim is only a reference and is not
 * itself evidence that the action ran.
 */
export interface DurableActionReceipt {
  readonly id: string;
  readonly durable: true;
  readonly status: "succeeded" | "failed";
  readonly receiptHash: `sha256:${string}`;
}

export interface AssistantForceClaimDecision {
  readonly claimId: string;
  readonly basis: ClaimBasis;
  readonly force: AssistantForceClass;
  readonly reasonIds: readonly string[];
  readonly evidenceCount: number;
  readonly actionReceiptId: string | null;
  readonly verifiedActionReceipt: boolean;
}

export interface AssistantForceInput {
  requestedAuthority?: RequestedAuthority;
  selectedProposal?: AssistantForceSelectedProposal;
  actionReceipts?: readonly DurableActionReceipt[];
  certifiedClaimIds?: readonly string[];
  epistemicForce?: EpistemicForce;
  proofVerdict?: string;
  outputForce?: string;
  forceClass?: string;
  evidenceIds?: readonly EvidenceId[] | readonly string[];
  directEvidenceIds?: readonly EvidenceId[] | readonly string[];
  learnedPriorEvidenceIds?: readonly string[];
  constructForces?: readonly string[];
  support?: number;
  contradiction?: number;
  targetLanguageChanged?: boolean;
}

export interface AssistantForceDecision {
  force: AssistantForceClass;
  reasonIds: string[];
  audit: JsonValue;
}

export function assistantForceClass(input: AssistantForceInput): AssistantForceClass {
  return assistantForceDecision(input).force;
}

export function assistantForceDecision(input: AssistantForceInput): AssistantForceDecision {
  const evidenceIds = new Set((input.evidenceIds ?? []).map(String));
  const directEvidenceIds = new Set((input.directEvidenceIds ?? []).map(String));
  const learnedPriorEvidenceIds = new Set((input.learnedPriorEvidenceIds ?? []).map(String));
  const constructForces = new Set(input.constructForces ?? []);
  const proof = String(input.proofVerdict ?? "");
  const truthState = truthStateFromProof(input.proofVerdict);
  const support = clamp01(input.support ?? 0);
  const contradiction = clamp01(input.contradiction ?? 0);
  const hasEvidence = evidenceIds.size > 0;
  const hasDirectEvidence = directEvidenceIds.size > 0 || (hasEvidence && input.forceClass === "direct_evidence");
  const onlyLearnedEvidence = hasEvidence && [...evidenceIds].every(id => learnedPriorEvidenceIds.has(id));
  const learnedForce = input.forceClass === "learned_language_prior" || input.forceClass === "learned_concept_prior" || input.forceClass === "learned_program_prior" || onlyLearnedEvidence;
  const translation = input.requestedAuthority === "translation" || input.targetLanguageChanged || input.outputForce === "translation" || constructForces.has("TranslationConstruct");
  const creative = input.requestedAuthority === "creative" || input.epistemicForce === "invented" || input.outputForce === "creative" || constructForces.has("CreativeConstruct");
  const contradicted = contradiction >= 0.52 || truthState === "truth.contradicted" || proof === "scce.verdict.001";
  const underSupported = input.epistemicForce === "unknown" || isUnsupportedTruthState(truthState) || proof === "scce.verdict.004";
  const proposalClaims = input.selectedProposal?.claims ?? [];
  if (proposalClaims.length > 0) {
    return proposalForceDecision({
      input,
      claims: proposalClaims,
      truthState,
      contradicted,
      support,
      contradiction
    });
  }
  let force: AssistantForceClass;
  const reasonIds: string[] = [];
  if (contradicted) {
    force = "insufficient_support";
    reasonIds.push("assistant_force.contradiction_pressure");
  } else if (translation) {
    force = "translation_answer";
    reasonIds.push(input.requestedAuthority === "translation" ? "assistant_force.requested_translation_authority" : "assistant_force.translation_surface");
  } else if (creative) {
    force = "creative_answer";
    reasonIds.push(input.requestedAuthority === "creative" ? "assistant_force.requested_creative_authority" : "assistant_force.creative_construct");
  } else if ((input.epistemicForce === "proved" || truthState === "truth.certified" || proof === "scce.verdict.002") && hasDirectEvidence) {
    force = "certified_fact";
    reasonIds.push("assistant_force.certified_direct_evidence");
  } else if (hasDirectEvidence || (input.epistemicForce === "observed" && hasEvidence)) {
    force = "source_grounded_answer";
    reasonIds.push(hasDirectEvidence ? "assistant_force.source_evidence_present" : "assistant_force.observed_without_certification");
  } else if (!learnedForce && (input.epistemicForce === "inferred" || support >= 0.34)) {
    force = "reasoned_answer";
    reasonIds.push("assistant_force.reasoned_support");
  } else if (input.epistemicForce === "conjectured") {
    force = "conjecture";
    reasonIds.push("assistant_force.conjectural_force");
  } else if (learnedForce) {
    force = "learned_corpus_answer";
    reasonIds.push("assistant_force.learned_prior_only");
  } else if (underSupported) {
    force = "insufficient_support";
    reasonIds.push("assistant_force.insufficient_support");
  } else {
    force = "insufficient_support";
    reasonIds.push("assistant_force.default_boundary");
  }
  return {
    force,
    reasonIds,
    audit: toJsonValue({
      source: "assistant.force",
      force,
      reasonIds,
      requestedAuthority: input.requestedAuthority ?? null,
      epistemicForce: input.epistemicForce ?? null,
      proofVerdict: input.proofVerdict ?? null,
      truthState,
      outputForce: input.outputForce ?? null,
      forceClass: input.forceClass ?? null,
      evidenceCount: evidenceIds.size,
      directEvidenceCount: directEvidenceIds.size,
      learnedPriorEvidenceCount: learnedPriorEvidenceIds.size,
      support,
      contradiction,
      constructForces: [...constructForces]
    })
  };
}

function proposalForceDecision(input: {
  input: AssistantForceInput;
  claims: readonly AssistantForceClaim[];
  truthState: TruthState;
  contradicted: boolean;
  support: number;
  contradiction: number;
}): AssistantForceDecision {
  const certifiedClaimIds = new Set(input.input.certifiedClaimIds ?? []);
  const directEvidenceIds = new Set((input.input.directEvidenceIds ?? []).map(String));
  const globallyCertified = input.input.epistemicForce === "proved"
    || input.truthState === "truth.certified"
    || input.input.proofVerdict === "certified"
    || input.input.proofVerdict === "scce.verdict.002";
  const receipts = new Map((input.input.actionReceipts ?? []).map(receipt => [receipt.id, receipt] as const));
  const claimDecisions = input.claims.map(claim => claimForceDecision({
    claim,
    certified: claim.certified === true
      || certifiedClaimIds.has(claim.id)
      || globallyCertified && hasVerifiedDirectEvidence(claim, directEvidenceIds),
    receipt: claim.actionReceiptId ? receipts.get(claim.actionReceiptId) : undefined
  }));
  const invalidActionClaims = claimDecisions.filter(decision => decision.basis === "action_result" && !decision.verifiedActionReceipt);
  let force: AssistantForceClass;
  const reasonIds: string[] = [];
  if (input.contradicted) {
    force = "insufficient_support";
    reasonIds.push("assistant_force.contradiction_pressure");
  } else if (invalidActionClaims.length > 0) {
    force = "insufficient_support";
    reasonIds.push("assistant_force.action_result_without_durable_receipt");
  } else {
    force = selectProposalForce(claimDecisions);
    reasonIds.push(reasonForProposalForce(force));
  }
  return {
    force,
    reasonIds,
    audit: toJsonValue({
      source: "assistant.force.claim_basis",
      force,
      reasonIds,
      selectedProposalId: input.input.selectedProposal?.id ?? null,
      requestedAuthority: input.input.requestedAuthority ?? null,
      epistemicForce: input.input.epistemicForce ?? null,
      proofVerdict: input.input.proofVerdict ?? null,
      truthState: input.truthState,
      support: input.support,
      contradiction: input.contradiction,
      precedence: [
        "action_result",
        "translation_answer",
        "creative_answer",
        "certified_fact",
        "source_grounded_answer",
        "reasoned_answer",
        "learned_corpus_answer",
        "conjecture",
        "insufficient_support"
      ],
      durableReceiptCount: [...receipts.values()].filter(isDurableActionReceipt).length,
      invalidActionClaimIds: invalidActionClaims.map(decision => decision.claimId),
      claimBasis: claimDecisions.map(decision => ({
        claimId: decision.claimId,
        basis: decision.basis,
        force: decision.force,
        reasonIds: decision.reasonIds,
        evidenceCount: decision.evidenceCount,
        actionReceiptId: decision.actionReceiptId,
        verifiedActionReceipt: decision.verifiedActionReceipt
      }))
    })
  };
}

function claimForceDecision(input: {
  claim: AssistantForceClaim;
  certified: boolean;
  receipt?: DurableActionReceipt;
}): AssistantForceClaimDecision {
  const evidenceCount = input.claim.evidenceIds?.length ?? 0;
  const priorCount = input.claim.priorIds?.length ?? 0;
  let force: AssistantForceClass;
  let reasonId: string;
  let verifiedActionReceipt = false;
  switch (input.claim.basis) {
    case "direct_evidence":
      if (evidenceCount === 0) {
        force = "insufficient_support";
        reasonId = "assistant_force.claim.direct_evidence_missing";
      } else if (input.certified) {
        force = "certified_fact";
        reasonId = "assistant_force.claim.direct_evidence_certified";
      } else {
        force = "source_grounded_answer";
        reasonId = "assistant_force.claim.direct_evidence_observed";
      }
      break;
    case "source_synthesis":
      force = evidenceCount > 0 ? "source_grounded_answer" : "insufficient_support";
      reasonId = evidenceCount > 0 ? "assistant_force.claim.source_synthesis" : "assistant_force.claim.source_synthesis_missing_evidence";
      break;
    case "reasoned_inference":
    case "causal_inference":
    case "temporal_inference":
    case "counterfactual":
      force = "reasoned_answer";
      reasonId = `assistant_force.claim.${input.claim.basis}`;
      break;
    case "learned_prior":
      force = priorCount > 0 ? "learned_corpus_answer" : "insufficient_support";
      reasonId = priorCount > 0 ? "assistant_force.claim.learned_prior" : "assistant_force.claim.learned_prior_missing";
      break;
    case "invented":
      force = "creative_answer";
      reasonId = "assistant_force.claim.invented";
      break;
    case "conjectured":
      force = "conjecture";
      reasonId = "assistant_force.claim.conjectured";
      break;
    case "translated":
      force = "translation_answer";
      reasonId = "assistant_force.claim.translated";
      break;
    case "action_result": {
      verifiedActionReceipt = isDurableActionReceipt(input.receipt)
        && input.receipt.id === input.claim.actionReceiptId
        && input.receipt.status === (input.claim.actionStatus ?? "succeeded");
      force = verifiedActionReceipt ? "action_result" : "insufficient_support";
      reasonId = verifiedActionReceipt
        ? "assistant_force.claim.verified_action_result"
        : "assistant_force.claim.action_result_without_durable_receipt";
      break;
    }
    case "unsupported":
      force = "insufficient_support";
      reasonId = "assistant_force.claim.unsupported";
      break;
  }
  return {
    claimId: input.claim.id,
    basis: input.claim.basis,
    force,
    reasonIds: [reasonId],
    evidenceCount,
    actionReceiptId: input.claim.actionReceiptId ?? null,
    verifiedActionReceipt
  };
}

function selectProposalForce(claims: readonly AssistantForceClaimDecision[]): AssistantForceClass {
  const forces = new Set(claims.map(claim => claim.force));
  const precedence: readonly AssistantForceClass[] = [
    "action_result",
    "translation_answer",
    "creative_answer",
    "certified_fact",
    "source_grounded_answer",
    "reasoned_answer",
    "learned_corpus_answer",
    "conjecture",
    "insufficient_support"
  ];
  return precedence.find(force => forces.has(force)) ?? "insufficient_support";
}

function reasonForProposalForce(force: AssistantForceClass): string {
  switch (force) {
    case "action_result": return "assistant_force.proposal.verified_action_result";
    case "translation_answer": return "assistant_force.proposal.translated";
    case "creative_answer": return "assistant_force.proposal.invented";
    case "certified_fact": return "assistant_force.proposal.certified_direct_evidence";
    case "source_grounded_answer": return "assistant_force.proposal.source_grounded";
    case "reasoned_answer": return "assistant_force.proposal.reasoned";
    case "learned_corpus_answer": return "assistant_force.proposal.learned_prior";
    case "conjecture": return "assistant_force.proposal.conjectured";
    case "insufficient_support": return "assistant_force.proposal.unsupported";
  }
}

function hasVerifiedDirectEvidence(claim: AssistantForceClaim, directEvidenceIds: ReadonlySet<string>): boolean {
  const evidenceIds = claim.evidenceIds?.map(String) ?? [];
  return evidenceIds.length > 0 && (directEvidenceIds.size === 0 || evidenceIds.some(id => directEvidenceIds.has(id)));
}

function isDurableActionReceipt(receipt: DurableActionReceipt | undefined): receipt is DurableActionReceipt {
  return Boolean(receipt)
    && receipt?.durable === true
    && (receipt.status === "succeeded" || receipt.status === "failed")
    && receipt.id.trim().length > 0
    && /^sha256:[0-9a-f]{64}$/u.test(receipt.receiptHash);
}

function truthStateFromProof(value: unknown): TruthState {
  if (value === "truth.certified" || value === "truth.contradicted" || value === "truth.source_bound_only" || value === "truth.unsupported_prior_only" || value === "truth.insufficient_evidence" || value === "truth.ambiguous") {
    return value;
  }
  if (value === "certified") return "truth.certified";
  if (value === "contradicted") return "truth.contradicted";
  if (value === "source_bound_only") return "truth.source_bound_only";
  if (value === "unsupported_prior_only") return "truth.unsupported_prior_only";
  if (value === "ambiguous") return "truth.ambiguous";
  return "truth.insufficient_evidence";
}
