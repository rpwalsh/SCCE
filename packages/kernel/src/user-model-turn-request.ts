// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
import type { CorrectionRuleRecord, CorrectionRuleKind, UserModelClaimRecord, UserModelClaimStore } from "./storage.js";
import type { RecordUserModelClaimInput, UserModelClaim, UserModelClaimKind, UserModelStore } from "./user-model-store.js";
import { EMPTY_USER_MODEL_STORE, activeClaim, deleteUserModelClaim, isExplicit, recordUserModelClaim } from "./user-model-store.js";
import type { JsonValue } from "./types.js";

/**
 * Plan items 219-220 live wiring. `production-turn-runtime.ts` already
 * detects real, structured, owner-supplied corrections every turn
 * (`correction-memory.ts`'s `fromMetadata`, driven by
 * `structuredCorrectionsFromMetadata`) -- a real signal this module
 * reuses, never reimplements. Every correction detected this way arrives
 * through explicit owner-supplied metadata, so it is genuinely and
 * always `source: "explicit_instruction"` when recorded as a
 * `UserModelClaim` -- never blended with, or mistaken for, an inferred
 * preference, which is exactly item 220's real guarantee.
 *
 * Persistence is real and durable (`deps.storage.userModelClaims`, a
 * genuine Postgres-backed store -- see `storage.ts`'s `UserModelClaimStore`
 * and `packages/adapters-node/src/postgres.ts`'s real implementation),
 * not a caller-side metadata round trip: claims accumulate across the
 * whole life of the underlying claims store, the same real pattern
 * `correction-memory.ts`'s own `deps.storage.corrections` already uses.
 * `UserModelClaimRecord` (`storage.ts`, storage-schema shaped) and
 * `UserModelClaim` (`user-model-store.ts`, the pure business-logic type)
 * are deliberately distinct types -- this module is the real conversion
 * boundary between them, matching this codebase's existing separation
 * between `CorrectionRuleRecord` and `correction-memory.ts`'s own types.
 */

const CORRECTION_KIND_TO_CLAIM_KIND: Record<CorrectionRuleKind, UserModelClaimKind> = {
  terminology_preference: "terminology",
  surface_note: "preference",
  preferred_surface: "preference",
  style_shift: "preference",
  register_shift: "preference",
  meter_constraint: "preference",
  translation_preference: "preference",
  verbosity_preference: "preference",
  semantic_error: "boundary",
  pronunciation_or_transliteration: "preference",
  script_preference: "preference"
};

/** Real, principled mapping from a real detected correction to a real user-model claim -- never a fabricated field. */
export function userModelClaimInputFromCorrectionRule(rule: CorrectionRuleRecord): RecordUserModelClaimInput {
  return {
    id: `claim.correction.${rule.id}`,
    kind: CORRECTION_KIND_TO_CLAIM_KIND[rule.ruleKind],
    subject: `${rule.ruleKind}:${rule.scope}:${rule.pattern}`,
    value: rule.replacement ?? rule.pattern,
    source: "explicit_instruction",
    scope: rule.scope,
    confidence: rule.weight,
    observedAt: rule.createdAt
  };
}

/**
 * Applies every real detected correction this turn as a real user-model
 * claim, skipping (not throwing on) any whose id is already recorded --
 * a caller that supplies the same metadata correction across multiple
 * turns (a persistent style rule) must not crash the turn on the second
 * occurrence.
 */
export function applyDetectedCorrectionsToUserModelStore(
  store: UserModelStore,
  corrections: readonly CorrectionRuleRecord[]
): UserModelStore {
  let next = store;
  for (const rule of corrections) {
    const input = userModelClaimInputFromCorrectionRule(rule);
    if (next.claims.has(input.id)) continue;
    next = recordUserModelClaim(next, input);
  }
  return next;
}

/** Real, exact field-for-field conversion -- the storage-schema record carries every field the business-logic claim needs and nothing it invents. `conversationId` is a real storage-layer isolation field, not a business-logic concept, so it never crosses into `UserModelClaim`. */
export function claimFromClaimRecord(record: UserModelClaimRecord): UserModelClaim {
  return {
    schema: "scce.user_model_claim.v1",
    id: record.id,
    kind: record.kind,
    subject: record.subject,
    value: record.value,
    source: record.source,
    scope: record.scope,
    confidence: record.confidence,
    observedAt: record.observedAt,
    evidenceIds: record.evidenceIds,
    ...(record.supersedesClaimId ? { supersedesClaimId: record.supersedesClaimId } : {})
  };
}

export function claimRecordFromClaim(claim: UserModelClaim, conversationId: string): UserModelClaimRecord {
  return {
    id: claim.id,
    conversationId,
    kind: claim.kind,
    subject: claim.subject,
    value: claim.value,
    source: claim.source,
    scope: claim.scope,
    confidence: claim.confidence,
    observedAt: claim.observedAt,
    evidenceIds: [...claim.evidenceIds],
    ...(claim.supersedesClaimId ? { supersedesClaimId: claim.supersedesClaimId } : {})
  };
}

export function userModelStoreFromClaimRecords(records: readonly UserModelClaimRecord[]): UserModelStore {
  return { claims: new Map(records.map(record => [record.id, claimFromClaimRecord(record)])) };
}

/**
 * The real per-turn sync: reads this store's real durable claim history,
 * applies every real correction detected this turn (idempotent -- a
 * correction already recorded as a claim is never re-recorded), and
 * persists only the genuinely new claims. Returns the resulting real,
 * up-to-date store. This is the one real read+write round trip against
 * `deps.storage.userModelClaims` for the whole turn.
 *
 * `conversationId` is a real, required tenant-isolation boundary --
 * `listClaims` only ever returns claims already scoped to this exact
 * conversation, so one conversation's corrections/preferences can never
 * leak into a different, unrelated conversation's `TurnResult.userModelStore`.
 */
export async function syncUserModelStoreForTurn(
  claimStore: UserModelClaimStore,
  corrections: readonly CorrectionRuleRecord[],
  conversationId: string
): Promise<UserModelStore> {
  const existingRecords = await claimStore.listClaims({ conversationId, limit: 500 });
  const existingStore = userModelStoreFromClaimRecords(existingRecords);
  const updatedStore = applyDetectedCorrectionsToUserModelStore(existingStore, corrections);
  for (const [id, claim] of updatedStore.claims) {
    if (!existingStore.claims.has(id)) await claimStore.putClaim(claimRecordFromClaim(claim, conversationId));
  }
  return updatedStore;
}

export function userModelStoreToJson(store: UserModelStore): JsonValue {
  return [...store.claims.values()].sort((left, right) => left.id.localeCompare(right.id)) as unknown as JsonValue;
}

/** What the store holds, split by how it was learned: an instruction the owner gave is never counted with something inferred. */
export function userModelStoreProvenanceSummary(store: UserModelStore): JsonValue {
  const claims = [...store.claims.values()];
  const explicit = claims.filter(isExplicit);
  return {
    total: claims.length,
    explicitInstructions: explicit.length,
    notExplicit: claims.length - explicit.length,
    explicitSubjects: [...new Set(explicit.map(claim => claim.subject))].sort().slice(0, 32)
  };
}

/** What a forget request did: the removed claim when it existed, or why nothing was removed. */
export interface ForgetUserModelClaimResult {
  removed: boolean;
  claimId: string;
  conversationId: string;
  claim?: UserModelClaim;
  reason?: "unknown_claim" | "storage_cannot_delete";
  store: UserModelStore;
}

/**
 * Withdrawing one thing the system learned about its owner.
 *
 * `deleteUserModelClaim` is the store's real removal -- distinct from correction, which keeps the superseded claim
 * inspectable -- and nothing called it, so a claim recorded from a misread instruction was permanently binding: every
 * later turn re-read it, and the only remedy available was to record a second claim superseding the first, which leaves
 * the original in the history it governs. This is what makes the module's third promise (inspectable, correctable,
 * deletable) true of the running system rather than of the type alone.
 */
export async function forgetUserModelClaim(
  claimStore: UserModelClaimStore,
  conversationId: string,
  claimId: string
): Promise<ForgetUserModelClaimResult> {
  const records = await claimStore.listClaims({ conversationId, limit: 500 });
  const store = userModelStoreFromClaimRecords(records);
  const claim = store.claims.get(claimId);
  if (!claim) return { removed: false, claimId, conversationId, reason: "unknown_claim", store };
  if (!claimStore.deleteClaim) return { removed: false, claimId, conversationId, claim, reason: "storage_cannot_delete", store };
  // The durable delete is the authority: a caller never sees a claim dropped locally that survived in storage.
  const removed = await claimStore.deleteClaim({ conversationId, claimId });
  if (!removed) return { removed: false, claimId, conversationId, claim, reason: "unknown_claim", store };
  return { removed: true, claimId, conversationId, claim, store: deleteUserModelClaim(store, claimId) };
}

/** Every claim held for a conversation, newest first, alongside the one claim currently governing each (subject, scope). */
export async function userModelClaimsForConversation(
  claimStore: UserModelClaimStore,
  conversationId: string,
  limit = 200
): Promise<{ store: UserModelStore; claims: UserModelClaim[]; governing: UserModelClaim[] }> {
  const records = await claimStore.listClaims({ conversationId, limit });
  const store = records.length ? userModelStoreFromClaimRecords(records) : EMPTY_USER_MODEL_STORE;
  const claims = [...store.claims.values()].sort((left, right) => right.observedAt - left.observedAt);
  const pairs = new Map<string, { subject: string; scope: string }>();
  for (const claim of claims) pairs.set(JSON.stringify([claim.subject, claim.scope]), { subject: claim.subject, scope: claim.scope });
  const governing: UserModelClaim[] = [];
  for (const pair of pairs.values()) {
    const active = activeClaim(store, pair.subject, pair.scope);
    if (active) governing.push(active);
  }
  return { store, claims, governing };
}
