import { afterEach, expect, it } from "vitest";
import { createPostgresStorageAdapter, type PostgresStorageAdapter } from "../postgres.js";
import { pooledProfileOwnerFixture } from "../../../kernel/src/__tests__/fixtures/pooled-profile-owner.js";
import type { LanguageProfile } from "@scce/kernel";

const adapters: PostgresStorageAdapter[] = [];
afterEach(async () => { await Promise.all(adapters.splice(0).map(adapter => adapter.close())); });
function fixture() {
  const adapter = createPostgresStorageAdapter({ url: "postgres://fixture:fixture@127.0.0.1/fixture", schema: "fixture",
    informationAccess: { tenantId: "tenant.fixture", principalId: "principal.fixture", compartments: [], maximumExportClass: "restricted" } });
  adapters.push(adapter);
  return adapter;
}

it("resolves either admitted parent through a complete principal-scoped current-owner query", async () => {
  const owner = pooledProfileOwnerFixture(["Aster powers pump.", "Beryl powers valve."], "pg.parent.closure"), adapter = fixture();
  let siblingCurrentAndAccessible = true;
  adapter.query = async <T>(sql: string, params: unknown[] = []): Promise<T[]> => {
    expect(sql).toContain("(lp.profile_json->'pooledSourceBinding'->'parents') ?| $1::text[]");
    for (const alias of ["lp", "sv", "pooled_parent", "pooled_evidence", "pooled_newer", "pooled_newer_evidence"]) expect(sql).toContain(`${alias}.information_label`);
    expect(sql).toContain("pooled_evidence.status='promoted'");
    expect(sql).toContain("pooled_newer.source_id=pooled_parent.source_id");
    expect(sql).toContain("pooled_evidence.content_hash=owned.value->>'contentHash'");
    expect(sql).toContain("NOT (lp.profile_json ? 'pooledSourceBinding') AND EXISTS");
    expect(params).toContain("tenant.fixture"); expect(params).toContain("principal.fixture");
    const requested = params[0] as string[];
    return (siblingCurrentAndAccessible && requested.some(id => owner.parentSourceVersionIds.includes(id))
      ? [{ profile_json: JSON.parse(JSON.stringify(owner.owned)) }] : []) as T[];
  };
  for (const parent of owner.parentSourceVersionIds) expect(await adapter.model.listLanguageProfiles({ sourceVersionIds: [parent as never], limit: 8 })).toEqual([owner.owned]);
  expect(await adapter.model.listLanguageProfiles({ sourceVersionIds: ["foreign" as never], limit: 8 })).toEqual([]);
  siblingCurrentAndAccessible = false;
  expect(await adapter.model.listLanguageProfiles({ sourceVersionIds: [owner.parentSourceVersionIds[0] as never], limit: 8 })).toEqual([]);
});

it.each([
  { limit: 8 }, { limit: 8, referencedByLanguageMemory: true },
  { limit: 8, surfaceNgrams: ["ast"] }, { limit: 8, sourceDerivedAliases: ["en"] }
])("guards every pooled resident-warming route against inaccessible or stale siblings: %j", async query => {
  const adapter = fixture();
  adapter.query = async <T>(sql: string, params: unknown[] = []): Promise<T[]> => {
    expect(sql).toContain("NOT (lp.profile_json ? 'pooledSourceBinding') OR");
    expect(sql).toContain("pooled_evidence.status='promoted'");
    expect(sql).toContain("pooled_newer.source_id=pooled_parent.source_id");
    for (const alias of ["lp", "pooled_parent", "pooled_evidence", "pooled_newer", "pooled_newer_evidence"]) expect(sql).toContain(`${alias}.information_label`);
    expect(params).toContain("principal.fixture");
    return [];
  };
  expect(await adapter.model.listLanguageProfiles(query)).toEqual([]);
});

it.each(["source", "resident"])("cryptographically rejects a forged pool returned on the %s route", async route => {
  const owner = pooledProfileOwnerFixture(["Aster powers pump.", "Beryl powers valve."], "pg.parent.forged"), adapter = fixture();
  const forged = JSON.parse(JSON.stringify(owner.owned)) as LanguageProfile;
  forged.pooledSourceBinding = { ...forged.pooledSourceBinding!, parents: [...forged.pooledSourceBinding!.parents].reverse() };
  adapter.query = async <T>(): Promise<T[]> => [{ profile_json: forged }] as T[];
  await expect(adapter.model.listLanguageProfiles(route === "source"
    ? { sourceVersionIds: [owner.parentSourceVersionIds[0] as never], limit: 8 } : { limit: 8 }))
    .rejects.toThrow("invalid pooled profile ownership");
});
