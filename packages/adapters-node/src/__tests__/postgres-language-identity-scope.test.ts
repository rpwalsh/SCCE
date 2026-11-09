// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
import { afterEach, expect, it } from "vitest";
import { PostgresStorageAdapter } from "../postgres.js";
import { schemaStatements } from "../postgres-schema.js";

const adapters: PostgresStorageAdapter[] = [];
afterEach(async () => { for (const adapter of adapters.splice(0)) await adapter.close(); });
function fixture() {
  const adapter = new PostgresStorageAdapter({ url: "postgres://offline.invalid/none", schema: "identity_scope",
    informationAccess: { tenantId: "tenant.owner", principalId: "principal.owner", compartments: [], maximumExportClass: "restricted" } });
  adapters.push(adapter);
  const calls: Array<{ sql: string; params: unknown[] }> = [];
  adapter.query = async <T>(sql: string, params: unknown[] = []): Promise<T[]> => {
    calls.push({ sql, params });
    const requested = params[0] as string[];
    const ids = sql.includes("lp.id=ANY($1::text[])") ? requested : ["unrequested", ...requested];
    return ids.map(id => ({ id, language_id: `language:${id}` })) as T[];
  };
  return { adapter, calls };
}

it("selects exact assignment owners before source access checks without normalizing or limiting them", async () => {
  const { adapter, calls } = fixture();
  const profileIds = ["Profile", "profile", ...Array.from({ length: 5001 }, (_, index) => `owner:${index}`)];
  const result = await adapter.languageIdentities.listProfileLanguages({ profileIds: [...profileIds, "Profile"] });
  expect(result.map(row => row.profileId)).toEqual([...profileIds].sort());
  expect(calls).toHaveLength(1);
  const query = calls[0]!;
  expect(query.params[0]).toEqual([...profileIds].sort());
  expect(query.sql).toContain("lp.id=ANY($1::text[])");
  expect(query.sql).toContain("sv.id=lp.source_version_id");
  expect(query.sql).toContain("s.id=sv.source_id");
  for (const alias of ["lp", "sv"]) {
    for (const field of ["tenantId", "principals", "compartments", "exportClass"]) expect(query.sql).toContain(`${alias}.information_label->${field === "tenantId" || field === "exportClass" ? ">" : ""}'${field}'`);
  }
  expect(query.sql).not.toContain("LIMIT");
  expect(query.sql).not.toMatch(/SELECT\s+lp\.profile_json/iu);
  expect(query.sql).toContain("lp.profile_json->'pooledSourceBinding'");
});

it("uses source-version access labels and only declared columns on source identity rows", async () => {
  const declarations = schemaStatements("identity_scope");
  const source = declarations.find(sql => sql.startsWith("CREATE TABLE IF NOT EXISTS identity_scope.sources ("))!;
  const version = declarations.find(sql => sql.startsWith("CREATE TABLE IF NOT EXISTS identity_scope.source_versions ("))!;
  expect(source).toBeDefined();
  expect(source).not.toContain("information_label");
  expect(version).toContain("information_label JSONB NOT NULL");
  expect(version).toContain("source_id TEXT NOT NULL REFERENCES identity_scope.sources(id)");
  const { adapter, calls } = fixture();
  await adapter.languageIdentities.listProfileLanguages({ profileIds: ["owned"] });
  const query = calls[0]!.sql;
  for (const [, column] of query.matchAll(/\bs\.([a-z_]+)/gu)) {
    expect(source, `source column ${column} must exist in canonical schema DDL`).toMatch(new RegExp(`(?:\\(|,)\\s*${column}\\s+`, "u"));
  }
  expect(query).toContain("sv.information_label->>'tenantId'");
});

it("performs no storage work for an empty owner set", async () => {
  const { adapter, calls } = fixture();
  expect(await adapter.languageIdentities.listProfileLanguages({ profileIds: [] })).toEqual([]);
  expect(calls).toEqual([]);
});

it("requires active information access for assignment and identity catalog reads", async () => {
  const adapter = new PostgresStorageAdapter({ url: "postgres://offline.invalid/none", schema: "identity_scope" }); adapters.push(adapter);
  adapter.query = async () => { throw Error("unowned query must not execute"); };
  await expect(adapter.languageIdentities.listProfileLanguages({ profileIds: ["owned"] })).rejects.toThrow("explicit information access context");
  await expect(adapter.languageIdentities.listIdentities()).rejects.toThrow("explicit information access context");
});
