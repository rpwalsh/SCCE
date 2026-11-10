// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { compileLanguageConstructionPattern, SOURCE_EXAMPLE_CONSTRUCTION_STORAGE, canonicalDigestHex, createHasher,
  type InformationLabel, type LanguagePatternRecord, type LanguageProfile, type SourceTrust } from "@scce/kernel";
import { pooledProfileOwnerFixture } from "../../../kernel/src/__tests__/fixtures/pooled-profile-owner.js";
import { readScceRuntimeConfig } from "../config.js";
import { createPostgresStorageAdapter, type PostgresStorageAdapter } from "../postgres.js";
import { createSourcePatternFactsCodec } from "../source-pattern-facts.js";

const configPath = process.env.SCCE_NATIVE_FACTS_TEST_CONFIG?.trim();
const DATABASE = /^scce_source_facts_check_[A-Za-z0-9_]+$/u;
const SCHEMA = /^scce_source_facts_test_[a-f0-9]{32}$/u;
const label: InformationLabel = { tenantId: "source.facts.native", principals: ["operator"], compartments: [], exportClass: "restricted", mergePolicy: "isolated" };
const access = { tenantId: label.tenantId, principalId: "operator", compartments: [], maximumExportClass: "restricted" as const, explicitMergeAuthority: false };
const trust: SourceTrust = { identity: 1, integrity: 1, parserReliability: 1, directness: 1, authority: 1, freshness: 1,
  independenceGroup: "source-facts-native", accessScope: "fixture", licenseStatus: "fixture" };
const hasher = createHasher();
const texts = ["🧪甲 f9 🦉乙。\n🧪丙 f9 🦉丁。", "🧪戊 f9 🦉己。\n🧪庚 f9 🦉辛。"];
type PooledFixture = ReturnType<typeof pooledProfileOwnerFixture>;
function host(storage: PostgresStorageAdapter) {
  return { table: (name: string) => storage.table(name), query: <T>(sql: string, params: unknown[] = []) => storage.query<T>(sql, params),
    informationAccessPredicate: (alias: string, first: number) => storage.informationAccessPredicate(alias, first),
    requireWritableInformationLabel: (value: InformationLabel | undefined) => storage.requireWritableInformationLabel(value) };
}
function deferred<T>() {
  let resolve!: (value: T) => void, reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
function compiled(fixture: PooledFixture, profile: LanguageProfile, bindingId: string): LanguagePatternRecord {
  const evidence = fixture.pages[0]!.evidence[0]!;
  const result = compileLanguageConstructionPattern({ bindingId, profileId: profile.id, evidence: [evidence], hasher, updatedAt: 1000,
    storageEncoding: SOURCE_EXAMPLE_CONSTRUCTION_STORAGE, observations: [0, 10].map(start => ({ sourceVersionId: String(evidence.sourceVersionId),
      evidenceId: String(evidence.id), surfaceStartCodePoint: start, surfaceEndCodePoint: start + 9,
      roles: [{ slotIndex: 0, startCodePoint: 0, endCodePoint: 2 }, { slotIndex: 1, startCodePoint: 3, endCodePoint: 5 },
        { slotIndex: 2, startCodePoint: 6, endCodePoint: 8 }] })) });
  if (result.status !== "compiled") throw Error("native source-example fixture did not compile");
  return { ...result.pattern, informationLabel: label };
}

describe.skipIf(!configPath)("native source-fact ownership and GC (set SCCE_NATIVE_FACTS_TEST_CONFIG explicitly)", () => {
  let storage: PostgresStorageAdapter | undefined, databaseName: string, schema: string, databaseUrl: string;
  let schemaCreated = false, fixture: PooledFixture;
  const adapters: PostgresStorageAdapter[] = [];
  function adapter(): PostgresStorageAdapter {
    const result = createPostgresStorageAdapter({ url: databaseUrl, schema, informationAccess: access });
    adapters.push(result); return result;
  }
  async function verifiedDatabase(value: PostgresStorageAdapter): Promise<void> {
    const [actual] = await value.query<{ name: string }>("SELECT current_database() AS name");
    if (!actual || actual.name !== databaseName || !DATABASE.test(actual.name)) throw Error("native facts test requires the dedicated fixture database");
  }
  beforeAll(async () => {
    const config = await readScceRuntimeConfig(configPath!);
    databaseUrl = config.database.url;
    databaseName = decodeURIComponent(new URL(databaseUrl).pathname.slice(1));
    if (!DATABASE.test(databaseName)) throw Error("refusing native facts test outside scce_source_facts_check_ database prefix");
    schema = `scce_source_facts_test_${randomUUID().replaceAll("-", "")}`;
    if (!SCHEMA.test(schema)) throw Error("invalid generated native facts test schema");
    storage = adapter(); await verifiedDatabase(storage);
    await storage.query(`CREATE SCHEMA ${storage.q}`); schemaCreated = true;
    await storage.migrate();
    fixture = pooledProfileOwnerFixture(texts, "native.source.facts");
    for (const page of fixture.pages) {
      const evidence = page.evidence[0]!;
      const contentHash = await storage.blobs.put(Buffer.from(page.text, "utf8"), "text/plain");
      await storage.evidence.putSourceVersion({ sourceId: evidence.sourceId, sourceVersionId: page.profile.sourceVersionId,
        namespace: "fixture", canonicalUri: `fixture://source-facts-native/${evidence.sourceId}`, contentHash, mediaType: "text/plain",
        observedAt: 1, byteLength: Buffer.byteLength(page.text), sourceTrust: { ...trust, independenceGroup: String(evidence.sourceId) }, metadata: {}, informationLabel: label });
      for (const span of page.evidence) await storage.evidence.putEvidenceSpan({ ...span, informationLabel: label });
      await storage.languageMemory.putLanguageProfile({ ...page.profile, informationLabel: label });
    }
    await storage.languageMemory.putLanguageProfile({ ...fixture.owned, informationLabel: label });
  }, 120000);

  afterAll(async () => {
    try {
      if (schemaCreated && storage) {
        await verifiedDatabase(storage);
        if (!SCHEMA.test(schema) || storage.schema !== schema) throw Error("refusing native facts cleanup outside the generated schema");
        await storage.query(`DROP SCHEMA ${storage.q} CASCADE`);
      }
    } finally { await Promise.all(adapters.map(value => value.close())); }
  }, 120000);

  async function pageIds(patternId: string): Promise<string[]> {
    return (await storage!.query<{ page_id: string }>(`SELECT page_id FROM ${storage!.table("source_pattern_fact_refs")} WHERE pattern_id=$1 ORDER BY page_id`, [patternId]))
      .map(value => value.page_id);
  }
  async function counts(profileId: string) {
    const [result] = await storage!.query<{ patterns: string; pages: string; refs: string; orphans: string }>(`SELECT
      (SELECT COUNT(*) FROM ${storage!.table("language_patterns")} WHERE profile_id=$1) AS patterns,
      (SELECT COUNT(*) FROM ${storage!.table("source_pattern_fact_pages")} WHERE profile_id=$1) AS pages,
      (SELECT COUNT(*) FROM ${storage!.table("source_pattern_fact_refs")} ref JOIN ${storage!.table("language_patterns")} pattern ON pattern.id=ref.pattern_id WHERE pattern.profile_id=$1) AS refs,
      (SELECT COUNT(*) FROM ${storage!.table("source_pattern_fact_pages")} page WHERE page.profile_id=$1
        AND NOT EXISTS (SELECT 1 FROM ${storage!.table("source_pattern_fact_refs")} ref WHERE ref.page_id=page.id)) AS orphans`, [profileId]);
    return Object.fromEntries(Object.entries(result!).map(([key, value]) => [key, Number(value)]));
  }
  async function coldRead(originals: readonly LanguagePatternRecord[]): Promise<void> {
    const cold = adapter(); await verifiedDatabase(cold);
    const read = await cold.languageMemory.listLanguagePatterns({ patternIds: originals.map(value => value.id), limit: originals.length,
      maxTotalJsonBytes: 8 * 1024 * 1024, requireComplete: true });
    expect(read).toHaveLength(originals.length);
    const byId = new Map(read.map(value => [value.id, value]));
    for (const original of originals) expect(canonicalDigestHex(byId.get(original.id)!.patternJson, hasher)).toBe(canonicalDigestHex(original.patternJson, hasher));
    await cold.close(); adapters.splice(adapters.indexOf(cold), 1);
  }

  it("blocks a different-pattern writer at the profile boundary until committed pruning finishes", async () => {
    const profile = fixture.pages[0]!.profile, old = compiled(fixture, profile, "native.old"), next = compiled(fixture, profile, "native.next");
    await storage!.languageMemory.putLanguagePatterns!([old]);
    const initialPages = await pageIds(old.id), initial = await counts(profile.id);
    expect(initialPages.length).toBeGreaterThan(0); expect(initial).toEqual({ patterns: 1, pages: initialPages.length, refs: initialPages.length, orphans: 0 });
    const readyA = deferred<number>(), readyB = deferred<number>(), blocked = deferred<void>(), release = deferred<void>();
    let writerSettled = false;
    const codec = createSourcePatternFactsCodec(host(storage!));
    const pruning = storage!.transaction(async () => {
      const [backend] = await storage!.query<{ pid: number }>("SELECT pg_backend_pid() AS pid");
      await codec.lockProfiles([profile.id]);
      await storage!.query(`DELETE FROM ${storage!.table("language_patterns")} WHERE id=$1`, [old.id]);
      await codec.prune([profile.id]);
      readyA.resolve(backend!.pid);
      const otherPid = await readyB.promise, deadline = Date.now() + 20000;
      while (true) {
        const [state] = await storage!.query<{ blocked: boolean; advisory: boolean }>(`SELECT $2::int=ANY(pg_blocking_pids($1::int)) AS blocked,
          EXISTS(SELECT 1 FROM pg_locks WHERE pid=$1::int AND locktype='advisory' AND NOT granted) AS advisory`, [otherPid, backend!.pid]);
        if (state?.blocked && state.advisory) break;
        if (writerSettled || Date.now() >= deadline) throw Error("different-pattern writer did not wait on the shared profile advisory lock");
        await new Promise(resolve => setTimeout(resolve, 10));
      }
      blocked.resolve(); await release.promise;
    });
    void pruning.catch(error => { readyA.reject(error); blocked.reject(error); });
    const firstPid = await readyA.promise;
    const writing = storage!.transaction(async () => {
      const [backend] = await storage!.query<{ pid: number }>("SELECT pg_backend_pid() AS pid");
      expect(backend!.pid).not.toBe(firstPid);
      readyB.resolve(backend!.pid); await storage!.languageMemory.putLanguagePatterns!([next]);
    }).finally(() => { writerSettled = true; });
    void writing.catch(error => { readyB.reject(error); blocked.reject(error); });
    try { await blocked.promise; expect(writerSettled).toBe(false); }
    finally { release.resolve(); await Promise.all([pruning, writing]); }
    expect(await pageIds(next.id)).toEqual(initialPages);
    expect(await pageIds(old.id)).toEqual([]);
    expect(await counts(profile.id)).toEqual(initial);
    await coldRead([next]);
  }, 60000);

  it("cold restores a genuine pooled profile whose declared aggregate version has no source row", async () => {
    const originals = [compiled(fixture, fixture.owned, "native.pooled.first"), compiled(fixture, fixture.owned, "native.pooled.second")];
    const [aggregate] = await storage!.query<{ count: string }>(`SELECT COUNT(*) AS count FROM ${storage!.table("source_versions")} WHERE id=$1`, [fixture.sourceVersionId]);
    expect(Number(aggregate!.count)).toBe(0);
    await storage!.languageMemory.putLanguagePatterns!(originals);
    const firstPages = await pageIds(originals[0]!.id);
    expect(firstPages.length).toBeGreaterThan(0); expect(await pageIds(originals[1]!.id)).toEqual(firstPages);
    const ownerRows = await storage!.query<{ source_version_id: string }>(`SELECT source_version_id FROM ${storage!.table("source_pattern_fact_pages")} WHERE profile_id=$1`, [fixture.owned.id]);
    expect(ownerRows.map(value => value.source_version_id)).toEqual(firstPages.map(() => String(fixture.sourceVersionId)));
    expect(await counts(fixture.owned.id)).toEqual({ patterns: 2, pages: firstPages.length, refs: 2 * firstPages.length, orphans: 0 });
    await coldRead(originals);
    const [stillAbsent] = await storage!.query<{ count: string }>(`SELECT COUNT(*) AS count FROM ${storage!.table("source_versions")} WHERE id=$1`, [fixture.sourceVersionId]);
    expect(Number(stillAbsent!.count)).toBe(0);
  });
});
