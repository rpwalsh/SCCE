// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
import { afterEach, expect, it } from "vitest";
import { PostgresStorageAdapter } from "../postgres.js";

const adapters: PostgresStorageAdapter[] = [];
afterEach(async () => { await Promise.all(adapters.splice(0).map(adapter => adapter.close())); });
function fixture() {
  const storage = new PostgresStorageAdapter({ url: "postgres://offline.invalid/none", schema: "fixture", informationAccess: {
    tenantId: "tenant.fixture", principalId: "principal.fixture", compartments: [], maximumExportClass: "restricted"
  } });
  adapters.push(storage);
  const calls: Array<{ sql: string; params: unknown[] }> = [];
  storage.query = async <T>(sql: string, params: unknown[] = []): Promise<T[]> => { calls.push({ sql, params });
    return sql.startsWith("SELECT lp.id,lp.source_version_id,lp.language_id")
      ? [{ id: "profile.assigned", source_version_id: "version.assigned", language_id: "identity.assigned" },
        { id: "profile.unassigned", source_version_id: "version.unassigned", language_id: null }] as T[] : [];
  };
  return { storage, calls };
}

it("enumerates actual assigned and unassigned profile owners without loading profile bodies", async () => {
  const { storage, calls } = fixture();
  expect(await storage.languageIdentities.profileAssignments!()).toEqual([
    { profileId: "profile.assigned", sourceVersionId: "version.assigned", languageId: "identity.assigned" },
    { profileId: "profile.unassigned", sourceVersionId: "version.unassigned", languageId: null }
  ]);
  expect(calls).toHaveLength(1);
  expect(calls[0]!.sql).toMatch(/^SELECT lp\.id,lp\.source_version_id,lp\.language_id FROM /u);
  expect(calls[0]!.sql).not.toMatch(/SELECT\s+lp\.profile_json/iu);
  expect(calls[0]!.sql).toContain("lp.profile_json->'pooledSourceBinding'");
  expect(calls[0]!.sql).toContain("pooled_parent.id=owned.value->>'sourceVersionId'");
  expect(calls[0]!.sql).toContain("pooled_evidence.status='promoted'");
  expect(calls[0]!.sql).toContain("pooled_parent.information_label->>'tenantId'");
  expect(calls[0]!.sql).not.toContain("language_id IS NOT NULL");
  expect(calls[0]!.sql).toContain("lp.information_label->>'tenantId'");
  expect(calls[0]!.sql).toContain("sv.information_label->>'tenantId'");
});

it("retires old owners only for accessible promoted successor versions", async () => {
  const { storage, calls } = fixture();
  await storage.languageIdentities.profileAssignments!();
  const sql = calls[0]!.sql;
  for (const marker of ["newer_version.source_id=sv.source_id", "newer_version.observed_at,newer_version.id",
    "newer_version.information_label->>'tenantId'", "newer_evidence.status='promoted'",
    "newer_evidence.source_id=newer_version.source_id", "newer_evidence.information_label->>'tenantId'"]) expect(sql).toContain(marker);
});

it("applies current owner and information access boundaries to both discovery signature populations", async () => {
  const { storage, calls } = fixture();
  await storage.languageIdentities.listProfileSignatures({ afterId: "profile.before", limit: 17 });
  const { sql, params } = calls[0]!;
  for (const marker of ["lp.source_version_id, lp.information_label", "ps.source_version_id, ps.information_label",
    "src.information_label->>'tenantId'", "sv.information_label->>'tenantId'", "newer_evidence.status='promoted'",
    "newer_version.information_label->>'tenantId'"]) expect(sql).toContain(marker);
  expect(params.slice(0, 2)).toEqual(["profile.before", 17]);
  expect(sql).toContain("ORDER BY src.id LIMIT $2");
});

it("retains inaccessible identity catalogs during source-scoped discovery replacement", async () => {
  const { storage, calls } = fixture();
  storage.transaction = async operation => operation();
  await storage.languageIdentities.replaceIdentities!([]);
  const mutation = calls.find(call => call.sql.startsWith('DELETE FROM "fixture"."language_identities"'));
  expect(mutation).toBeDefined();
  expect(mutation!.sql).toContain("identity.information_label->>'tenantId'");
  expect(mutation!.sql).toContain("NOT (identity.id = ANY($1::text[])) AND");
  expect(mutation!.params).toContain("tenant.fixture");
});
