// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
import { DIALOGUE_ACT_IDS, type DialogueActId } from "./dialogue-pragmatics.js";
import {
  CONVERSATION_INTERNAL_PROVENANCE_METHOD_ID,
  type ConversationInternalSpanLicence,
  type ConversationTurnSurface,
  type SurfaceMeaningPlan
} from "./language-construction.js";
import { canonicalStringify } from "./primitives.js";
import type { RequestCommunicativeActClassification } from "./request-communicative-act.js";
import type { Hasher } from "./types.js";

export const CONVERSATIONAL_ACT_BINDING_SCHEMA = "scce.conversational_act_binding.v1" as const;

// The licence kind and its method id live with the realizer that must verify them; re-exported for this lane.
export { CONVERSATION_INTERNAL_PROVENANCE_METHOD_ID };
export type { ConversationInternalSpanLicence, ConversationTurnSurface };

/**
 * The four authority classes a surface can hold, derived from discriminators `PlannedClaim` already
 * carries. They are derived, never declared on a surface, so no producer can assert its own class.
 */
export type SurfaceAuthorityClassId =
  | "authority.conversation_bound"
  | "authority.hypothetical_proposed"
  | "authority.grounded_factual"
  | "authority.unsupported_factual";

export const SURFACE_AUTHORITY_CLASS_IDS = {
  conversationBound: "authority.conversation_bound",
  hypotheticalProposed: "authority.hypothetical_proposed",
  groundedFactual: "authority.grounded_factual",
  unsupportedFactual: "authority.unsupported_factual"
} as const satisfies Record<string, SurfaceAuthorityClassId>;

/** The discriminators the class is read off. `PlannedClaim` already carries all three. */
export interface AuthorityClassifiable {
  externallyFactual: boolean;
  hypothetical: boolean;
  evidenceIds: readonly string[];
}

export function surfaceAuthorityClass(claim: AuthorityClassifiable): SurfaceAuthorityClassId {
  if (claim.externallyFactual) {
    return claim.evidenceIds.length > 0
      ? SURFACE_AUTHORITY_CLASS_IDS.groundedFactual
      : SURFACE_AUTHORITY_CLASS_IDS.unsupportedFactual;
  }
  return claim.hypothetical
    ? SURFACE_AUTHORITY_CLASS_IDS.hypotheticalProposed
    : SURFACE_AUTHORITY_CLASS_IDS.conversationBound;
}

/** Only a grounded factual surface may be asserted as known. Evidence gates the claim, never the speech. */
export function authorityClassMayAssertAsKnown(classId: SurfaceAuthorityClassId): boolean {
  return classId === SURFACE_AUTHORITY_CLASS_IDS.groundedFactual;
}

/** A filler taken from a code-point span of one turn of this conversation. It carries no evidence or relation id. */
export interface ConversationalSlotFiller {
  slotIndex: number;
  surface: string;
  sourceTurnId: string;
  startCodePoint: number;
  endCodePoint: number;
}

/**
 * What a learned conversational construction binds to. The key is the same opaque (bindingId, slotIndex)
 * pair the factual lane derives from a relation predicate; here it is derived from an induced act instead.
 * The type carries no relation, node, fact or evidence id, so it cannot express an external world claim.
 */
export interface ConversationalActBinding {
  schema: typeof CONVERSATIONAL_ACT_BINDING_SCHEMA;
  id: string;
  actId: DialogueActId;
  bindingId: string;
  profileKey: string;
  conversationId: string;
  turnId: string;
  turnIndex: number;
  fillers: readonly ConversationalSlotFiller[];
}

export const CONVERSATIONAL_BINDING_REFUSAL_IDS = {
  actNotEarned: "conversational_binding.refuse.act_not_earned",
  actIsSourceLookup: "conversational_binding.refuse.act_is_source_lookup",
  actMismatch: "conversational_binding.refuse.act_mismatch",
  bindingKeyMismatch: "conversational_binding.refuse.binding_key_mismatch",
  noFillers: "conversational_binding.refuse.no_fillers",
  duplicateSlot: "conversational_binding.refuse.duplicate_slot",
  fillerNotConversationInternal: "conversational_binding.refuse.filler_not_conversation_internal",
  fillerFromUnknownTurn: "conversational_binding.refuse.filler_from_unknown_turn",
  fillerFromFutureTurn: "conversational_binding.refuse.filler_from_future_turn",
  literalInvarianceUnmeasured: "conversational_binding.refuse.literal_invariance_unmeasured",
  literalResidueNotInvariant: "conversational_binding.refuse.literal_residue_not_invariant"
} as const;

export type ConversationalBindingRefusalId =
  typeof CONVERSATIONAL_BINDING_REFUSAL_IDS[keyof typeof CONVERSATIONAL_BINDING_REFUSAL_IDS];

/** The non-factual epistemic record an admitted binding produces. Mirrors `PlannedClaim`'s discriminators exactly. */
export interface ConversationBoundMove {
  schema: "scce.conversation_bound_move.v1";
  bindingId: string;
  actId: DialogueActId;
  conversationId: string;
  turnId: string;
  externallyFactual: false;
  hypothetical: false;
  evidenceIds: readonly [];
  relationIds: readonly [];
  authorityClassId: typeof SURFACE_AUTHORITY_CLASS_IDS.conversationBound;
}

export type ConversationalBindingAdmission =
  | { status: "admissible"; binding: ConversationalActBinding; move: ConversationBoundMove }
  | { status: "refused"; reasonIds: readonly ConversationalBindingRefusalId[] };

/** The act-keyed analogue of the factual lane's relation-keyed bundle key. Same shape, different source. */
export function conversationalActBindingId(hasher: Hasher, profileId: string, actId: DialogueActId): string {
  return `surface.conversational_act.binding.${hasher.digestHex(canonicalStringify(["surface.conversational_act.binding", profileId, actId]))}`;
}

export function conversationalActBindingRecordId(hasher: Hasher, binding: Omit<ConversationalActBinding, "id" | "schema">): string {
  return `${CONVERSATIONAL_ACT_BINDING_SCHEMA}.${hasher.digestHex(canonicalStringify([CONVERSATIONAL_ACT_BINDING_SCHEMA, binding]))}`;
}

export interface LiteralResidueLiteral {
  surface: string;
  origins: readonly {
    sourceExampleId: string;
    observedSurface: string;
    evidenceIds: readonly string[];
  }[];
}

export interface LiteralResidueSourceExample {
  id: string;
  sourceVersionId: string;
  evidenceId: string;
}

/** Literal form provenance measured from this construction's exact source realizations. */
export type LiteralInvarianceEvidence =
  | { status: "observed_once"; literalCount: number; independentSourceVersionCount: 1 }
  | { status: "measured_invariant"; literalCount: number; independentSourceVersionCount: number }
  | { status: "invalid"; literalCount: number; reason: "no_literals" | "missing_origin" | "unknown_source_example" | "source_evidence_mismatch" | "literal_surface_mismatch" };

/**
 * A source realization can support its literal form without a population-wide threshold. One exact source
 * remains observable but unmeasured; repeated exact literals in independent versions establish invariance.
 */
export function literalResidueIsCorpusInvariant(input: {
  literals: readonly LiteralResidueLiteral[];
  sourceExamples: readonly LiteralResidueSourceExample[];
}): LiteralInvarianceEvidence {
  const literals = input.literals.filter(literal => literal.surface.trim().length > 0);
  if (!literals.length) return { status: "invalid", literalCount: 0, reason: "no_literals" };
  const examples = new Map(input.sourceExamples.map(example => [example.id, example] as const));
  let minimumIndependentVersions = Number.POSITIVE_INFINITY;
  for (const literal of literals) {
    if (!literal.origins.length) return { status: "invalid", literalCount: literals.length, reason: "missing_origin" };
    const versions = new Set<string>();
    for (const origin of literal.origins) {
      const example = examples.get(origin.sourceExampleId);
      if (!example || !example.sourceVersionId) return { status: "invalid", literalCount: literals.length, reason: "unknown_source_example" };
      if (!origin.evidenceIds.includes(example.evidenceId)) return { status: "invalid", literalCount: literals.length, reason: "source_evidence_mismatch" };
      if (origin.observedSurface !== literal.surface) return { status: "invalid", literalCount: literals.length, reason: "literal_surface_mismatch" };
      versions.add(example.sourceVersionId);
    }
    if (!versions.size) return { status: "invalid", literalCount: literals.length, reason: "missing_origin" };
    minimumIndependentVersions = Math.min(minimumIndependentVersions, versions.size);
  }
  return minimumIndependentVersions >= 2
    ? { status: "measured_invariant", literalCount: literals.length, independentSourceVersionCount: minimumIndependentVersions }
    : { status: "observed_once", literalCount: literals.length, independentSourceVersionCount: 1 };
}

export interface AdmitConversationalActBindingInput {
  binding: ConversationalActBinding;
  classification: RequestCommunicativeActClassification;
  /** Every turn of this conversation the caller observed, in order. Nothing outside it may fill a slot. */
  conversationTurns: readonly ConversationTurnSurface[];
  literalInvariance: LiteralInvarianceEvidence;
  hasher: Hasher;
}

/**
 * Decides whether a proposed conversational construction binding is licensed. Refusal is the default:
 * every check must pass, and none of them can be satisfied by material from outside the conversation.
 */
export function admitConversationalActBinding(
  input: AdmitConversationalActBindingInput
): ConversationalBindingAdmission {
  const reasonIds: ConversationalBindingRefusalId[] = [];
  const { binding, classification } = input;

  // I1: an inert, bypassed, disabled or failed classifier licenses nothing.
  if (classification.status !== "active") reasonIds.push(CONVERSATIONAL_BINDING_REFUSAL_IDS.actNotEarned);
  // I2: the neutral act is by construction the accepted evidence-bearing lookup shape -- the factual lane.
  if (binding.actId === DIALOGUE_ACT_IDS.neutral) reasonIds.push(CONVERSATIONAL_BINDING_REFUSAL_IDS.actIsSourceLookup);
  if (classification.actId !== binding.actId) reasonIds.push(CONVERSATIONAL_BINDING_REFUSAL_IDS.actMismatch);
  // I3: the bundle key must be act-derived, so a relation-keyed factual bundle cannot be relabelled.
  if (binding.bindingId !== conversationalActBindingId(input.hasher, binding.profileKey, binding.actId)) {
    reasonIds.push(CONVERSATIONAL_BINDING_REFUSAL_IDS.bindingKeyMismatch);
  }

  if (binding.fillers.length === 0) reasonIds.push(CONVERSATIONAL_BINDING_REFUSAL_IDS.noFillers);
  const seenSlots = new Set<number>();
  const turnById = new Map(input.conversationTurns.map(turn => [turn.turnId, turn] as const));
  for (const filler of binding.fillers) {
    if (seenSlots.has(filler.slotIndex)) reasonIds.push(CONVERSATIONAL_BINDING_REFUSAL_IDS.duplicateSlot);
    seenSlots.add(filler.slotIndex);
    const turn = turnById.get(filler.sourceTurnId);
    if (!turn) {
      reasonIds.push(CONVERSATIONAL_BINDING_REFUSAL_IDS.fillerFromUnknownTurn);
      continue;
    }
    // I5: a filler may not come from a turn that has not happened yet.
    if (turn.turnIndex > binding.turnIndex) reasonIds.push(CONVERSATIONAL_BINDING_REFUSAL_IDS.fillerFromFutureTurn);
    // I4: the filler must be the exact code-point span it claims, of that turn's own surface.
    if (!spanIsExact(turn.surface, filler)) reasonIds.push(CONVERSATIONAL_BINDING_REFUSAL_IDS.fillerNotConversationInternal);
  }

  // I8: every literal must be traceable to its own exact source realization. A single observation is usable,
  // with uncertainty preserved; missing or contradictory provenance is not.
  if (input.literalInvariance.status === "invalid") reasonIds.push(CONVERSATIONAL_BINDING_REFUSAL_IDS.literalResidueNotInvariant);

  if (reasonIds.length > 0) return { status: "refused", reasonIds: [...new Set(reasonIds)].sort() };
  return {
    status: "admissible",
    binding,
    move: {
      schema: "scce.conversation_bound_move.v1",
      bindingId: binding.bindingId,
      actId: binding.actId,
      conversationId: binding.conversationId,
      turnId: binding.turnId,
      externallyFactual: false,
      hypothetical: false,
      evidenceIds: [],
      relationIds: [],
      authorityClassId: SURFACE_AUTHORITY_CLASS_IDS.conversationBound
    }
  };
}

/** I6/I7: a conversation-bound move can never certify a world claim, whatever else a caller believes about it. */
export function conversationBoundMoveMayAssertAsKnown(move: ConversationBoundMove): boolean {
  return authorityClassMayAssertAsKnown(surfaceAuthorityClass(move));
}

export interface ConversationalSurfacePlanResult {
  plan: SurfaceMeaningPlan;
  licences: readonly ConversationInternalSpanLicence[];
}

/**
 * The surface plan an admitted binding would realize from. Every variant carries an empty evidence id list and
 * its conversation-internal licence, so `realizeLearnedSurface` realizes it only when the caller also supplies
 * the conversation turns the licence is re-cut from; without them the plan is still rejected for want of a licence.
 */
export function conversationalSurfaceMeaningPlan(input: {
  binding: ConversationalActBinding;
  roleIdForSlot(slotIndex: number): string;
  occurrenceIdForSlot(slotIndex: number): string;
  formClassIdForSlot?(slotIndex: number): string | undefined;
  hasher: Hasher;
}): ConversationalSurfacePlanResult {
  const fillers = [...input.binding.fillers].sort((left, right) => left.slotIndex - right.slotIndex);
  const repetitions = new Map<string, string[]>();
  for (const filler of fillers) {
    const key = canonicalStringify([input.roleIdForSlot(filler.slotIndex), filler.sourceTurnId, filler.startCodePoint, filler.endCodePoint, filler.surface]);
    const occurrences = repetitions.get(key) ?? [];
    occurrences.push(input.occurrenceIdForSlot(filler.slotIndex));
    repetitions.set(key, occurrences);
  }
  const variantId = (filler: ConversationalSlotFiller): string =>
    `surface.conversational_variant.${input.hasher.digestHex(canonicalStringify([input.binding.id, filler.slotIndex, filler.surface]))}`;
  const licenceFor = (filler: ConversationalSlotFiller): ConversationInternalSpanLicence => ({
    schema: CONVERSATION_INTERNAL_PROVENANCE_METHOD_ID,
    variantId: variantId(filler),
    slotIndex: filler.slotIndex,
    conversationId: input.binding.conversationId,
    sourceTurnId: filler.sourceTurnId,
    startCodePoint: filler.startCodePoint,
    endCodePoint: filler.endCodePoint
  });
  return {
    plan: {
      id: `surface.conversational_plan.${input.hasher.digestHex(canonicalStringify(["surface.conversational_plan", input.binding.id]))}`,
      profileKey: input.binding.profileKey,
      roleSignature: [...new Set(fillers.map(filler => input.roleIdForSlot(filler.slotIndex)))],
      intentionalRepetitions: [...repetitions.entries()].filter(([, occurrenceIds]) => occurrenceIds.length > 1)
        .map(([key, occurrenceIds]) => ({ id: `surface.conversational_repetition.${input.hasher.digestHex(key)}`, occurrenceIds })),
      slots: fillers.map(filler => {
        const formClassId = input.formClassIdForSlot?.(filler.slotIndex);
        return {
          roleId: input.roleIdForSlot(filler.slotIndex),
          occurrenceId: input.occurrenceIdForSlot(filler.slotIndex),
          variants: [{
            id: variantId(filler),
            profileKey: input.binding.profileKey,
            surface: filler.surface,
            evidenceIds: [],
            conversationInternalLicence: licenceFor(filler),
            ...(formClassId ? { formClassId } : {})
          }]
        };
      })
    },
    licences: fillers.map(licenceFor)
  };
}

function spanIsExact(surface: string, filler: ConversationalSlotFiller): boolean {
  const points = [...surface];
  if (!Number.isInteger(filler.startCodePoint) || !Number.isInteger(filler.endCodePoint)) return false;
  if (filler.startCodePoint < 0 || filler.endCodePoint > points.length || filler.startCodePoint >= filler.endCodePoint) return false;
  return points.slice(filler.startCodePoint, filler.endCodePoint).join("") === filler.surface;
}
