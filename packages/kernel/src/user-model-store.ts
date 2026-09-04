// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
import type { EvidenceId } from "./types.js";

/**
 * Plan items 219-220. A real, provenance-aware user-model store,
 * additive to `dialogue-pragmatics.ts`'s existing `UserStyleProfile`
 * (a flat weights/vocabulary structure with no source/scope/confidence/
 * time/supersession tracking at all -- confirmed absent, not merely
 * incomplete). This module is deliberately separate rather than a
 * rewrite of `UserStyleProfile`: wiring it in as `UserStyleProfile`'s
 * real backing store is future work, not attempted here, so nothing
 * about the existing, already-wired dialogue pipeline changes.
 *
 * The one property this module exists to guarantee (item 220): an
 * inferred preference is never indistinguishable from an explicit
 * instruction. `source` is a real, required field on every claim, never
 * defaulted or inferred after the fact, and every claim is individually
 * addressable by id -- inspectable, correctable (via real supersession,
 * never silent mutation of a past claim), and deletable (real removal,
 * not merely superseded-and-forgotten).
 */

export const USER_MODEL_CLAIM_SCHEMA = "scce.user_model_claim.v1" as const;

export type UserModelClaimSource = "explicit_instruction" | "demonstrated_behavior" | "inferred";
export type UserModelClaimKind = "preference" | "expertise" | "terminology" | "boundary";

export interface UserModelClaim {
  schema: typeof USER_MODEL_CLAIM_SCHEMA;
  id: string;
  kind: UserModelClaimKind;
  subject: string;
  value: string;
  source: UserModelClaimSource;
  scope: string;
  confidence: number;
  observedAt: number;
  evidenceIds: readonly EvidenceId[];
  /** Real, explicit supersession -- the claim this one corrects/replaces, if any. Never a silent overwrite. */
  supersedesClaimId?: string;
}

export interface UserModelStore {
  claims: ReadonlyMap<string, UserModelClaim>;
}

export const EMPTY_USER_MODEL_STORE: UserModelStore = { claims: new Map() };

export interface RecordUserModelClaimInput {
  id: string;
  kind: UserModelClaimKind;
  subject: string;
  value: string;
  source: UserModelClaimSource;
  scope: string;
  confidence: number;
  observedAt: number;
  evidenceIds?: readonly EvidenceId[];
  supersedesClaimId?: string;
}

/** Real, append-only recording: a claim with a real `supersedesClaimId` never mutates or removes the claim it supersedes -- both remain individually inspectable, `activeClaims` alone resolves which one currently governs. */
export function recordUserModelClaim(store: UserModelStore, input: RecordUserModelClaimInput): UserModelStore {
  if (store.claims.has(input.id)) throw new Error(`user model claim already exists: ${input.id}`);
  if (input.supersedesClaimId !== undefined && !store.claims.has(input.supersedesClaimId)) {
    throw new Error(`claim ${input.id} claims to supersede unknown claim ${input.supersedesClaimId}`);
  }
  if (input.confidence < 0 || input.confidence > 1) throw new Error("confidence must be within [0,1]");
  const claim: UserModelClaim = {
    schema: USER_MODEL_CLAIM_SCHEMA,
    id: input.id,
    kind: input.kind,
    subject: input.subject,
    value: input.value,
    source: input.source,
    scope: input.scope,
    confidence: input.confidence,
    observedAt: input.observedAt,
    evidenceIds: input.evidenceIds ?? [],
    ...(input.supersedesClaimId !== undefined ? { supersedesClaimId: input.supersedesClaimId } : {})
  };
  return { claims: new Map(store.claims).set(claim.id, claim) };
}

/** Real deletion: the claim is genuinely removed, not merely marked superseded. Distinct from correction (recordUserModelClaim with supersedesClaimId), which keeps the old claim inspectable. */
export function deleteUserModelClaim(store: UserModelStore, claimId: string): UserModelStore {
  if (!store.claims.has(claimId)) throw new Error(`unknown user model claim: ${claimId}`);
  const claims = new Map(store.claims);
  claims.delete(claimId);
  return { claims };
}

/** Every claim ever recorded for (subject, scope), still real and inspectable regardless of supersession -- the raw individual-inspection surface item 220 asks for. */
export function claimHistory(store: UserModelStore, subject: string, scope: string): UserModelClaim[] {
  return [...store.claims.values()]
    .filter(claim => claim.subject === subject && claim.scope === scope)
    .sort((left, right) => left.observedAt - right.observedAt);
}

/**
 * The real currently-governing claim for (subject, scope): the most
 * recent claim in a real supersession chain that nothing else
 * supersedes. A claim that has been superseded is never returned here,
 * even though it remains real and inspectable via `claimHistory`.
 */
export function activeClaim(store: UserModelStore, subject: string, scope: string): UserModelClaim | undefined {
  const history = claimHistory(store, subject, scope);
  const supersededIds = new Set(history.map(claim => claim.supersedesClaimId).filter((id): id is string => id !== undefined));
  const notSuperseded = history.filter(claim => !supersededIds.has(claim.id));
  return notSuperseded.at(-1);
}

export function isExplicit(claim: UserModelClaim): boolean {
  return claim.source === "explicit_instruction";
}
