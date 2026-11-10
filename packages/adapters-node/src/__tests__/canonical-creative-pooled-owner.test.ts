// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
import { readFileSync } from "node:fs";
import { afterEach, beforeAll, expect, it } from "vitest";
import { canonicalStringify, createClock, createIdFactory, createUniversalCreativeEventConstructionCompiler, type LanguagePatternRecord } from "@scce/kernel";
import { pooledProfileOwnerFixture } from "../../../kernel/src/__tests__/fixtures/pooled-profile-owner.js";
import { PostgresStorageAdapter } from "../postgres.js";
import { createCanonicalCreativeEventCodec } from "../canonical-creative-event-store.js";
import { CREATIVE_EVENT_NORMALIZATION_TABLES, creativeEventStorageJson } from "../creative-event-normalization.js";
import { profileSourceOwnershipSql } from "../pooled-profile-ownership.js";

const label = { tenantId: "tenant.pooled", principals: [], compartments: [], exportClass: "public" as const, mergePolicy: "same_owner" as const };
const cold = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;
let pool: ReturnType<typeof pooledProfileOwnerFixture>, patterns: LanguagePatternRecord[];
beforeAll(() => {
  const texts = ["dolly-human-16.json", "dolly-human-creative-pair.json"].map(name =>
    (JSON.parse(readFileSync(new URL(`../../../kernel/src/__tests__/fixtures/${name}`, import.meta.url), "utf8")) as { text: string }).text);
  pool = pooledProfileOwnerFixture(texts, "canonical.pooled.human");
  expect(pool.pages.some(page => page.profile.sourceVersionId === pool.owned.sourceVersionId)).toBe(false);
  const compiled = createUniversalCreativeEventConstructionCompiler().compile({ profileId: pool.owned.id, evidence: pool.evidence, hasher: pool.hasher, updatedAt: 1 });
  if (compiled.status !== "compiled") throw Error("genuine pooled human source did not compile");
  patterns = (compiled.patterns ?? [compiled.pattern]).filter(pattern => typeof pattern.patternJson === "object" && pattern.patternJson !== null
    && !Array.isArray(pattern.patternJson) && pattern.patternJson.bundle).map(pattern => ({ ...pattern, informationLabel: label }));
});

const adapters: PostgresStorageAdapter[] = [];
afterEach(async () => { await Promise.all(adapters.splice(0).map(adapter => adapter.close())); });
function fixture() {
  const ids = createIdFactory({ hasher: pool.hasher, clock: createClock({ fixedTime: 1 }), deterministicReplay: true, namespace: "canonical.pooled.source" });
  const adapter = new PostgresStorageAdapter({ url: "postgres://offline.invalid/none", schema: "pooled_creative",
    informationAccess: { tenantId: label.tenantId, principalId: "principal.pooled", compartments: [], maximumExportClass: "restricted" } });
  adapters.push(adapter);
  const state = { profile: cold({ ...pool.owned, informationLabel: label }), current: true, promoted: true, accessible: true, complete: true,
    foreignMember: false, profilePayloads: 0, inserted: 0 };
  const tables = new Map(CREATIVE_EVENT_NORMALIZATION_TABLES.map(table => [table, new Map<string, Record<string, unknown>>()]));
  const lexicalPages = new Map<string, { id: Buffer; kind: string; member_ids: Buffer[]; value_json: Record<string, unknown> }>();
  let transactionDepth = 0;
  adapter.transaction = async work => { transactionDepth++; try { return await work(); } finally { transactionDepth--; } };
  const calls: string[] = [];
  adapter.query = async <T>(sql: string, params: unknown[] = []): Promise<T[]> => {
    calls.push(sql);
    if (sql.includes("lexical-page writer lock")) { expect(transactionDepth).toBeGreaterThan(0); return [{ isolation: "read committed" }] as T[]; }
    if (sql.includes('"creative_event_lexical_pages"')) {
      if (sql.includes("lexical-page insert")) {
        const id = params[0] as Buffer, key = id.toString("hex");
        if (!lexicalPages.has(key)) { lexicalPages.set(key, { id: Buffer.from(id), kind: "lexical_forms_page", member_ids: (params[1] as Buffer[]).map(value => Buffer.from(value)), value_json: JSON.parse(String(params[2])) }); state.inserted++; }
        return [];
      }
      const ids = (params[0] as Buffer[]).map(value => value.toString("hex"));
      const selected = [...lexicalPages.values()].filter(row => sql.includes("lexical-page membership") ? row.member_ids.some(id => ids.includes(id.toString("hex"))) : ids.includes(row.id.toString("hex")));
      return selected.map(row => sql.includes("lexical-page sizes") ? { id: row.id, stored_bytes: Buffer.byteLength(JSON.stringify(row.value_json)) }
        : sql.includes("lexical-page membership") ? { id: row.id } : { ...row, value_json: cold(row.value_json) }) as T[];
    }
    const parameters = new Set([...sql.matchAll(/\$(\d+)/gu)].map(match => Number(match[1])));
    expect(parameters.size).toBe(params.length);
    if (parameters.size) expect(Math.max(...parameters)).toBe(params.length);
    if (sql.includes("SELECT profile.id AS profile_id")) {
      // There is deliberately no source_versions row for the pooled profile's virtual version.
      if (sql.includes("version.id=profile.source_version_id") || !sql.includes("admitted_profiles AS MATERIALIZED")
        || !sql.includes("pooled_members AS MATERIALIZED")) return [];
      const historical = !sql.includes("pooled_evidence.status='promoted'");
      if (!state.accessible || !state.complete || !historical && (!state.current || !state.promoted)) return [];
      const requested = JSON.parse(String(params[0])) as Array<{ profileId: string; evidenceId: string }>;
      let sent = false;
      return requested.flatMap(item => {
        const span = pool.evidence.find(span => span.id === item.evidenceId), page = span && pool.pages.find(page => page.profile.sourceVersionId === span.sourceVersionId);
        if (!span || !page || item.profileId !== state.profile.id) return [];
        const profile = sent ? null : state.profile;
        if (profile) state.profilePayloads++;
        sent = true;
        return [{ profile_id: state.profile.id, profile_source_version_id: state.profile.sourceVersionId, has_pooled_binding: true, pooled_profile: profile,
          source_id: state.foreignMember ? "source.foreign" : span.sourceId, source_version_id: span.sourceVersionId,
          source_content_hash: ids.contentHash(page.text), evidence_id: span.id, evidence_content_hash: span.contentHash,
          char_start: span.charStart, char_end: span.charEnd, byte_start: span.byteStart, byte_end: span.byteEnd,
          profile_label: label, source_label: label, evidence_label: label }];
      }) as T[];
    }
    const table = CREATIVE_EVENT_NORMALIZATION_TABLES.find(table => sql.includes(`"${table}"`));
    if (!table) return [];
    const saved = tables.get(table)!;
    if (sql.startsWith("INSERT INTO")) {
      for (const row of JSON.parse(String(params[0])) as Record<string, unknown>[]) if (!saved.has(String(row.id))) { saved.set(String(row.id), cold(row)); state.inserted++; }
      return [];
    }
    if (sql.includes("AS expected")) return (JSON.parse(String(params[0])) as Record<string, unknown>[])
      .filter(row => saved.has(String(row.id)) && creativeEventStorageJson(row) === creativeEventStorageJson(saved.get(String(row.id))))
      .map(row => ({ id: row.id })) as T[];
    return (params[0] as string[]).flatMap(id => saved.has(id) ? [cold(saved.get(id))] : []) as T[];
  };
  return { adapter, codec: createCanonicalCreativeEventCodec(adapter), state, calls, tables };
}

it("normalizes genuine pooled-profile events through their actual parents without a fake virtual source version", async () => {
  const { codec, state, calls, tables } = fixture();
  const original = patterns.map(pattern => pattern.patternJson), encoded = await codec.encodeMany(original.map(value => ({ value, informationLabel: label })));
  expect(tables.get("creative_event_occurrences")!.size).toBe(patterns.length);
  expect(state.profilePayloads).toBe(1);
  const decoded = await codec.decodeMany(cold(encoded));
  expect(decoded.map(value => pool.hasher.digestHex(canonicalStringify(value)))).toEqual(original.map(value => pool.hasher.digestHex(canonicalStringify(value))));
  expect(decoded).toEqual(original);
  expect(state.profilePayloads).toBe(2);
  const insertions = state.inserted;
  await codec.encodeMany(original.map(value => ({ value, informationLabel: label })));
  expect(state.inserted).toBe(insertions);
  const query = calls.find(sql => sql.includes("SELECT profile.id AS profile_id"))!;
  expect(query).toContain("version.id=evidence.source_version_id AND version.source_id=evidence.source_id");
  expect(query).toContain('SELECT DISTINCT "profileId" FROM requested');
  expect(query).toContain("pooled_evidence.status='promoted'");
  expect(query).toContain("pooled_newer.source_id=pooled_parent.source_id");
  for (const field of ["sourceId", "sourceVersionId", "contentHash", "byteStart", "byteEnd", "charStart", "charEnd"]) expect(query).toContain(`member.value->>'${field}'`);
  expect(query).toContain("ROW_NUMBER() OVER (PARTITION BY profile.id ORDER BY evidence.id)=1");
});

it.each(["current", "promoted", "accessible", "complete"] as const)("refuses current publication when any pooled parent is not %s", async field => {
  const { codec, state, tables } = fixture(); state[field] = false;
  await expect(codec.encode(patterns[0]!.patternJson, label)).rejects.toThrow("source owner missing");
  expect([...tables.values()].every(rows => rows.size === 0)).toBe(true);
});

it("rejects a changed cold profile digest and exact-evidence membership mismatch", async () => {
  for (const kind of ["digest", "membership"] as const) {
    const { codec, state, tables } = fixture();
    if (kind === "digest") state.profile.entropy += 1; else state.foreignMember = true;
    await expect(codec.encode(patterns[0]!.patternJson, label)).rejects.toThrow(kind === "digest" ? "invalid pooled profile ownership" : "outside the verified receipt");
    expect([...tables.values()].every(rows => rows.size === 0)).toBe(true);
  }
});

it("reconstructs immutable historical bytes after retraction while active profile admission remains current-only", async () => {
  const { codec, adapter, state, calls } = fixture();
  const original = patterns[0]!.patternJson, encoded = await codec.encode(original, label);
  state.current = false; state.promoted = false;
  await expect(codec.encode(original, label)).rejects.toThrow("source owner missing");
  const beforeRead = calls.length;
  expect(await codec.decodeMany([cold(encoded)])).toEqual([original]);
  const historical = calls.slice(beforeRead).find(sql => sql.includes("SELECT profile.id AS profile_id"))!;
  expect(historical).not.toContain("pooled_evidence.status='promoted'");
  expect(historical).not.toContain("pooled_newer.source_id");
  expect(historical).toContain("pooled_parent.information_label");
  expect(historical).toContain("pooled_evidence.information_label");
  const defaultCurrent = profileSourceOwnershipSql(adapter, [], "profile");
  expect(defaultCurrent).toContain("pooled_evidence.status='promoted'");
  expect(defaultCurrent).toContain("pooled_newer.source_id");
});
