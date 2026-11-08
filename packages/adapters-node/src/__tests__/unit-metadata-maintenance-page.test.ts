// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
import { afterEach, expect, it, vi } from "vitest";
import type { SourceVersion } from "@scce/kernel";
import { createPostgresStorageAdapter, type PostgresStorageAdapter } from "../postgres.js";

const adapters: PostgresStorageAdapter[] = [];
afterEach(async () => { for (const adapter of adapters.splice(0)) await adapter.close(); });
function adapter() {
  const value = createPostgresStorageAdapter({ url: "postgres://offline.invalid/no_database", schema: "maintenance",
    informationAccess: { tenantId: "fixture", principalId: "owner", compartments: [], maximumExportClass: "restricted" } });
  adapters.push(value);
  return value;
}
const label = { tenantId: "fixture", principals: ["owner"], compartments: [], exportClass: "restricted", mergePolicy: "isolated" };
const row = { id: "b", profile_id: "profile", source_version_id: "version", script: "script:Latn", unit_kind: "symbol",
  unit_text: "λ", features: ["sym:λ"], competence_vector: [1], alpha: 0.8, evidence_ids: ["evidence"],
  information_label: label, metadata_json: { sourceMetadata: { transcript: "λ".repeat(200) }, sourceCompilationId: "compiled" } };

it("bounds candidate headers before decoded row measurement and defers payloads without skipping their keys", async () => {
  const storage = adapter();
  const query = vi.fn(async (_sql: string, params?: unknown[]) => params?.[0] === "b"
    ? [{ id: "c", decoded_bytes: 1000, running_decoded_bytes: 1000, unit_json: { ...row, id: "c" } }]
    : [{ id: "a", decoded_bytes: 9000, running_decoded_bytes: 0, unit_json: null },
      { id: "b", decoded_bytes: 1000, running_decoded_bytes: 1000, unit_json: row },
      { id: "c", decoded_bytes: 1000, running_decoded_bytes: 2000, unit_json: null }]);
  Object.defineProperty(storage, "query", { value: query });
  const first = await storage.languageMemory.listUnitSourceMetadataPage!({ limit: 3, maxTotalJsonBytes: 1500 });
  expect(first).toMatchObject({ decodedBytes: 1000, nextAfterId: "b", hasMore: true, oversized: [{ id: "a", byteLength: 9000 }] });
  expect(first.units).toEqual([{ id: "b", profileId: "profile", sourceVersionId: "version", script: "script:Latn", unitKind: "symbol",
    text: "λ", features: ["sym:λ"], competenceVector: [1], alpha: 0.8, evidenceIds: ["evidence"], informationLabel: label, metadata: row.metadata_json }]);
  const [sql, params] = query.mock.calls[0]!;
  const header = sql.slice(0, sql.indexOf("), sized AS MATERIALIZED"));
  expect(header).toContain("SELECT unit.id");
  expect(header).not.toContain("to_jsonb");
  expect(header).toContain("unit.information_label");
  expect(header.indexOf("unit.information_label")).toBeLessThan(header.indexOf("ORDER BY unit.id LIMIT $2 FOR UPDATE"));
  expect(sql).toContain("octet_length(to_jsonb(unit)::text)");
  expect(sql).not.toContain("pg_column_size");
  expect(sql).not.toContain("SKIP LOCKED");
  expect(sql).toContain("CASE WHEN ranked.decoded_bytes<=$3 AND ranked.running_decoded_bytes<=$3 THEN to_jsonb(unit) ELSE NULL END");
  expect(params?.slice(0, 3)).toEqual(["", 3, 1500]);
  expect(await storage.languageMemory.listUnitSourceMetadataPage!({ afterId: first.nextAfterId, limit: 3, maxTotalJsonBytes: 1500 }))
    .toMatchObject({ units: [{ id: "c" }], decodedBytes: 1000, nextAfterId: "c", hasMore: false });
});

it("keeps source chronology monotonic when maintenance replays an older canonical source version", async () => {
  const storage = adapter();
  let lastSeen = 0;
  const query = vi.fn(async (sql: string, params?: unknown[]) => {
    if (sql.includes('INSERT INTO "maintenance"."sources"')) {
      const observedAt = Number(params?.[3]);
      lastSeen = sql.includes("GREATEST(sources.last_seen_at,EXCLUDED.last_seen_at)") ? Math.max(lastSeen, observedAt) : observedAt;
    }
    return [];
  });
  Object.defineProperty(storage, "query", { value: query });
  Object.defineProperty(storage, "transaction", { value: async <T>(operation: () => Promise<T>) => operation() });
  const source: SourceVersion = { sourceId: "source" as SourceVersion["sourceId"], sourceVersionId: "version" as SourceVersion["sourceVersionId"],
    namespace: "fixture", canonicalUri: "fixture://source", contentHash: "hash" as SourceVersion["contentHash"], mediaType: "text/plain", observedAt: 200, byteLength: 1,
    informationLabel: { ...label, exportClass: "restricted", mergePolicy: "isolated" }, metadata: {},
    sourceTrust: { identity: 1, integrity: 1, parserReliability: 1, directness: 1, authority: 1, freshness: 1, independenceGroup: "fixture", accessScope: "owner_private", licenseStatus: "owner_authorized" } };
  await storage.evidence.putSourceVersion(source);
  await storage.evidence.putSourceVersion({ ...source, observedAt: 100 });
  expect(query.mock.calls.filter(([sql]) => sql.includes('INSERT INTO "maintenance"."sources"'))).toHaveLength(2);
  expect(lastSeen).toBe(200);
});
