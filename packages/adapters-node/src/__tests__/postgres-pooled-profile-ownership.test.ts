// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
import { afterEach, expect, it } from "vitest";
import { PostgresStorageAdapter } from "../postgres.js";
import { pooledProfileOwnerFixture } from "../../../kernel/src/__tests__/fixtures/pooled-profile-owner.js";
import { canonicalDigestHex, type PooledLanguageProfileOwnership } from "@scce/kernel";

const label = { tenantId: "tenant.fixture", principals: ["principal.fixture"], compartments: [], exportClass: "restricted" as const, mergePolicy: "isolated" as const };
const adapters: PostgresStorageAdapter[] = [];
afterEach(async () => { for (const adapter of adapters.splice(0)) await adapter.close(); });

function fixture() {
  const owner = pooledProfileOwnerFixture(["the river is in the valley.", "the boat is in the harbour."]);
  const profile = { ...owner.owned, informationLabel: label };
  const adapter = new PostgresStorageAdapter({ url: "postgres://offline.invalid/none", schema: "pooled_owned",
    informationAccess: { tenantId: label.tenantId, principalId: label.principals[0]!, compartments: [], maximumExportClass: "restricted" } });
  adapters.push(adapter);
  const state = { current: true, accessible: true, complete: true, promoted: true, profile };
  const calls: Array<{ sql: string; params: unknown[] }> = [];
  const modelOwners = [...Array.from({ length: 8 }, () => profile.id), "profile.direct-source"];
  const accepted = (binding: PooledLanguageProfileOwnership) => state.current && state.accessible && state.complete && state.promoted
    && binding.evidence.every(row => owner.evidence.some(span => span.id === row.id && span.sourceId === row.sourceId && span.sourceVersionId === row.sourceVersionId
      && span.contentHash === row.contentHash && span.byteStart === row.byteStart && span.byteEnd === row.byteEnd && span.charStart === row.charStart && span.charEnd === row.charEnd))
    && binding.parents.every(parent => owner.evidence.some(span => span.sourceVersionId === parent));
  const hasGuard = (sql: string) => sql.includes("scce.pooled_language_profile_ownership.v1") && sql.includes("pooled_evidence.status='promoted'")
    && sql.includes("pooled_newer.source_id=pooled_parent.source_id") && sql.includes("pooled_parent.information_label") && sql.includes("pooled_evidence.information_label");
  adapter.transaction = async work => work();
  adapter.query = async <T>(sql: string, params: unknown[] = []): Promise<T[]> => {
    calls.push({ sql, params });
    if (sql.endsWith(" AS accepted")) return [{ accepted: hasGuard(sql) && accepted(JSON.parse(String(params[0])) as PooledLanguageProfileOwnership) }] as T[];
    const owned = hasGuard(sql) && accepted(state.profile.pooledSourceBinding!);
    if (sql.includes("SELECT lp.profile_json FROM")) return (owned ? [{ profile_json: state.profile }] : []) as T[];
    if (sql.includes("SELECT lp.id, lp.language_id")) return (owned ? [{ id: state.profile.id, language_id: "language.measured" }] : []) as T[];
    if (sql.includes("WITH population AS MATERIALIZED")) return [{ symbol: "the", contexts: owned ? "80" : "1",
      model_count: modelOwners.filter(profileId => profileId === "profile.direct-source" || owned && profileId === state.profile.id).length }] as T[];
    return [];
  };
  return { adapter, owner, state, calls };
}

it("publishes only exact current accessible pooled ownership and admits eight Wiki models alongside one direct model", async () => {
  const { adapter, owner, state, calls } = fixture();
  await adapter.model.putLanguageProfile(state.profile);
  expect(calls.some(call => call.sql.endsWith(" AS accepted"))).toBe(true);
  expect((await adapter.languageIdentities.listPooledProfileSignatures!()).map(row => row.id)).toEqual([owner.profile.id]);
  expect(await adapter.languageIdentities.listProfileLanguages({ profileIds: [owner.profile.id] })).toEqual([{ profileId: owner.profile.id, languageId: "language.measured" }]);
  expect((await adapter.languageMemory.continuationPopulation!({ languageId: "language.measured" }))?.modelCount).toBe(9);
  const discovery = calls.length;
  await adapter.languageIdentities.listProfileSignatures({ limit: 100 });
  expect(calls[discovery]!.sql).toContain("lp.profile_json->'pooledSourceBinding' IS NULL");
});

it("loads an exact pooled owner assignment and includes its eight-model population on a cold read", async () => {
  const { adapter, owner } = fixture();
  expect(await adapter.languageIdentities.listProfileLanguages({ profileIds: [owner.profile.id] })).toEqual([{ profileId: owner.profile.id, languageId: "language.measured" }]);
  expect((await adapter.languageMemory.continuationPopulation!({ languageId: "language.measured" }))?.modelCount).toBe(9);
});

it.each(["current", "accessible", "complete", "promoted"] as const)("refuses pooled publication and continuation ownership when %s parent proof is missing", async field => {
  const { adapter, state } = fixture(); state[field] = false;
  await expect(adapter.model.putLanguageProfile(state.profile)).rejects.toThrow("parents are not current accessible promoted evidence");
  expect(await adapter.languageIdentities.listPooledProfileSignatures!()).toEqual([]);
  expect(await adapter.languageIdentities.listProfileLanguages({ profileIds: [state.profile.id] })).toEqual([]);
  expect((await adapter.languageMemory.continuationPopulation!({ languageId: "language.measured" }))?.modelCount).toBe(1);
});

it("rejects a changed profile digest before parent SQL or any publication", async () => {
  const { adapter, state, calls } = fixture();
  await expect(adapter.model.putLanguageProfile({ ...state.profile, entropy: state.profile.entropy + 1 })).rejects.toThrow("invalid pooled profile ownership");
  expect(calls.some(call => call.sql.startsWith("INSERT INTO"))).toBe(false);
});

it("does not accept recomputed caller JSON as a new source-preparation proof", async () => {
  const { adapter, state, owner } = fixture();
  const profile = JSON.parse(JSON.stringify(state.profile)) as typeof state.profile;
  profile.entropy += 1;
  const { informationLabel: _label, pooledSourceBinding: previous, ...body } = profile;
  const { id: _id, ...ownership } = previous!;
  ownership.profileDigest = canonicalDigestHex(body, owner.hasher);
  profile.pooledSourceBinding = { ...ownership, id: canonicalDigestHex(ownership, owner.hasher) };
  await expect(adapter.model.putLanguageProfile(profile)).rejects.toThrow("requires a verified source preparation");
});
