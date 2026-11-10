// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
import { afterEach, expect, it } from "vitest";
import { createHasher, normalizePriorKey, POSTGRES_REQUIRED_TABLES, POSTGRES_SCHEMA_VERSION, type JsonValue, type SemanticFrameRecord } from "@scce/kernel";
import { PostgresStorageAdapter, schemaStatements } from "../postgres.js";
import { requiredHydrationColumns } from "../postgres-schema.js";

const adapters: PostgresStorageAdapter[] = [];
afterEach(async () => { await Promise.all(adapters.splice(0).map(adapter => adapter.close())); });
const hasher = createHasher();
const key = (surface: string) => hasher.digestHex(normalizePriorKey(surface));
const label = { tenantId: "tenant.owned", principals: ["principal.owned"], compartments: [], exportClass: "restricted" as const, mergePolicy: "isolated" as const };
const record = (id: string, frameJson: JsonValue): SemanticFrameRecord => ({ id, frameJson, embedding: Array.from({ length: 64 }, () => 1), evidenceIds: [], alpha: 1, createdAt: 1, informationLabel: label });

function adapterFixture() {
  const adapter = new PostgresStorageAdapter({ url: "postgres://offline.invalid/none", schema: "surface_key", informationAccess: {
    tenantId: "tenant.owned", principalId: "principal.owned", compartments: [], maximumExportClass: "restricted"
  } });
  adapters.push(adapter);
  return adapter;
}

it("keeps the canonical surface hash index in the current schema and retires only the raw long-surface index", () => {
  expect(POSTGRES_SCHEMA_VERSION).toBe(34);
  const statements = schemaStatements('"surface_key"');
  expect(statements).toContain('ALTER TABLE "surface_key".semantic_frames ADD COLUMN IF NOT EXISTS normalized_surface_hash TEXT');
  expect(statements).toContain('DROP INDEX IF EXISTS "surface_key".idx_surface_key_semantic_frames_surface_rank');
  const index = statements.find(sql => sql.includes("CREATE INDEX") && sql.includes("_semantic_frames_normalized_surface_hash_rank"))!;
  expect(index).toContain("semantic_frames(normalized_surface_hash,alpha DESC,created_at DESC,id ASC)");
  expect(index).not.toContain("frame_json");
  expect(statements.some(sql => sql.includes("CREATE INDEX") && sql.includes("_semantic_frames_surface_rank"))).toBe(false);
  expect(requiredHydrationColumns().semantic_frames).toContain("normalized_surface_hash");
});

it("writes exact canonical-JS keys outside unchanged JSON, including long, empty, and absent surfaces", async () => {
  const adapter = adapterFixture();
  const calls: Array<{ sql: string; params: unknown[] }> = [];
  adapter.transaction = async operation => operation();
  adapter.query = async <T>(sql: string, params: unknown[] = []): Promise<T[]> => { calls.push({ sql, params }); return []; };
  const frames = ["İ", "i\u0307", "ΟΣ", "ος", "οσ", "ẞ", "ß", "КВАРТУН\tБОБ", "αλφα\u2003βήτα", "", "\t\n", "🧪甲".repeat(12000)]
    .map((surface, index) => record(`frame.${index}`, { surface, original: { retained: true } }));
  frames.push(record("frame.absent", { preview: "source output" }), record("frame.numeric", { surface: 9 }));
  await adapter.languageMemory.putSemanticFrames!(frames);
  const write = calls.find(call => call.sql.includes("INSERT INTO") && call.sql.includes("semantic_frames"))!;
  expect(write).toBeDefined();
  const payload = JSON.parse(String(write.params[0])) as Array<{ id: string; frame_json: JsonValue; normalized_surface_hash: string | null }>;
  expect(payload).toHaveLength(frames.length);
  payload.forEach((row, index) => {
    expect(row.frame_json).toEqual(frames[index]!.frameJson);
    const surface = (row.frame_json as { surface?: unknown }).surface;
    expect(row.normalized_surface_hash).toBe(typeof surface === "string" ? key(surface) : null);
    if (row.normalized_surface_hash) expect(row.normalized_surface_hash).toMatch(/^[0-9a-f]{64}$/u);
  });
  expect(write.sql).toContain("normalized_surface_hash=EXCLUDED.normalized_surface_hash");
  expect(write.sql).toContain("sf.normalized_surface_hash IS DISTINCT FROM EXCLUDED.normalized_surface_hash");
});

it.each(["İ", "i\u0307", "ΟΣ", "ος", "οσ", "ẞ", "ß", "КВАРТУН БОБ", "αλφα\u2003βήτα"])(
  "uses the fixed JS hash and checks exact normalized bytes after lookup for %s", async requestSurface => {
    const adapter = adapterFixture();
    const frames = ["İ", "i\u0307", "ΟΣ", "ος", "οσ", "ẞ", "ß", "Квартун\tБоб", "αλφα βήτα", "αλφα\u2003βήτα"]
      .map((surface, index) => record(`frame.${index}`, { surface }));
    const calls: Array<{ sql: string; params: unknown[] }> = [];
    // Every candidate is returned deliberately, including simulated hash collisions.
    adapter.query = async <T>(sql: string, params: unknown[] = []): Promise<T[]> => {
      calls.push({ sql, params });
      return frames.map(row => ({ id: row.id, frame_json: row.frameJson, embedding: JSON.stringify(row.embedding), evidence_ids: [], alpha: "1", created_at: new Date(1), information_label: label })) as unknown as T[];
    };
    const matched = await adapter.languageMemory.listSemanticFrames({ requestSurface, limit: 128 });
    expect(matched).toEqual(frames.filter(row => normalizePriorKey((row.frameJson as { surface: string }).surface) === normalizePriorKey(requestSurface)));
    expect(calls[0]!.params[0]).toBe(key(requestSurface));
    expect(calls[0]!.sql).toContain("frame.normalized_surface_hash=$1");
    expect(calls[0]!.sql).not.toContain("lower(");
    expect(calls[0]!.sql).not.toContain("ILIKE");
    expect(calls[0]!.sql).toContain("frame.information_label->>'tenantId'");
  });

it("retains raw surface equality alongside the indexed prefilter, including legacy nonstring text extraction", async () => {
  const adapter = adapterFixture();
  const calls: Array<{ sql: string; params: unknown[] }> = [];
  adapter.query = async <T>(sql: string, params: unknown[] = []): Promise<T[]> => { calls.push({ sql, params }); return []; };
  await adapter.languageMemory.listSemanticFrames({ surface: "ΟΣ", limit: 8 });
  expect(calls[0]!.params.slice(0, 2)).toEqual(["ΟΣ", key("ΟΣ")]);
  expect(calls[0]!.sql).toContain("frame.frame_json->>'surface'=$1");
  expect(calls[0]!.sql).toContain("frame.normalized_surface_hash=$2");
  expect(calls[0]!.sql).toContain("frame.normalized_surface_hash IS NULL AND jsonb_typeof(frame.frame_json->'surface') IS DISTINCT FROM 'string'");
});

function migrationFixture(options: { changeSurface?: boolean; failUpdate?: boolean; unicodeIds?: boolean } = {}) {
  const adapter = adapterFixture();
  const frames = Array.from({ length: 300 }, (_, index) => ({ id: `frame.${String(index).padStart(4, "0")}`, frameJson: { surface: ["İ", "ΟΣ", "ẞ", ""][index % 4]! } as JsonValue, hash: null as string | null }));
  if (options.unicodeIds) { frames[298]!.id = "frame.é"; frames[299]!.id = "frame.z"; }
  frames.push({ id: "frame.numeric", frameJson: { surface: 9 }, hash: null }, { id: "frame.absent", frameJson: { preview: "original source" }, hash: null },
    { id: "frame.ready", frameJson: { surface: "ready" }, hash: key("ready") });
  const calls: Array<{ sql: string; params: unknown[] }> = [];
  let transactionHashes: Array<string | null> | undefined;
  adapter.query = async <T>(): Promise<T[]> => [];
  const client = { release() {}, async query(sql: string, params: unknown[] = []) {
    calls.push({ sql, params });
    let rows: unknown[] = [];
    if (sql === "BEGIN") transactionHashes = frames.map(row => row.hash);
    else if (sql === "ROLLBACK") frames.forEach((row, index) => { row.hash = transactionHashes![index]!; });
    else if (sql.includes("to_regclass")) rows = [{ present: "surface_key.ngram_models" }];
    else if (sql.includes("SELECT id,frame_json->>'surface' AS surface")) {
      rows = frames.filter(row => row.hash === null && typeof (row.frameJson as { surface?: unknown }).surface === "string"
        && (params[0] === null || row.id.localeCompare(String(params[0])) > 0)).sort((a, b) => a.id.localeCompare(b.id)).slice(0, Number(params[1]))
        .map(row => ({ id: row.id, surface: (row.frameJson as { surface: string }).surface }));
      if (options.changeSurface && rows.length) (frames[0]!.frameJson as { surface: string }).surface = "changed concurrently";
    } else if (sql.startsWith("UPDATE") && sql.includes("normalized_surface_hash=observed.hash")) {
      if (options.failUpdate) throw new Error("injected backfill failure");
      for (const observed of JSON.parse(String(params[0])) as Array<{ id: string; surface: string; hash: string }>) {
        const row = frames.find(row => row.id === observed.id)!;
        if (row.hash === null && (row.frameJson as { surface?: unknown }).surface === observed.surface) row.hash = observed.hash;
      }
    } else if (sql.includes("AS pending")) rows = [{ pending: frames.some(row => row.hash === null && typeof (row.frameJson as { surface?: unknown }).surface === "string") }];
    else if (sql.includes("information_schema.tables")) rows = POSTGRES_REQUIRED_TABLES.map(table_name => ({ table_name }));
    else if (sql.includes("information_schema.columns")) rows = Object.entries(requiredHydrationColumns()).flatMap(([table_name, columns]) => columns.map(column_name => ({ table_name, column_name })));
    return { rows, rowCount: rows.length };
  } };
  Object.defineProperty(adapter.pool, "connect", { configurable: true, value: async () => client });
  return { adapter, frames, calls };
}

it.each([false, true])("backfills only missing string-surface hashes in database-ordered primary-key pages (Unicode IDs: %s)", async unicodeIds => {
  const f = migrationFixture({ unicodeIds });
  const original = structuredClone(f.frames.map(row => ({ id: row.id, frameJson: row.frameJson })));
  await f.adapter.migrate();
  const reads = f.calls.filter(call => call.sql.includes("SELECT id,frame_json->>'surface' AS surface"));
  expect(reads).toHaveLength(3);
  expect(reads.map(call => call.params[0])).toEqual([null, "frame.0255", unicodeIds ? "frame.z" : "frame.0299"]);
  expect(reads.every(call => call.params[1] === 256)).toBe(true);
  expect(reads.every(call => call.sql.includes("ORDER BY id ASC LIMIT $2"))).toBe(true);
  for (const call of reads) {
    expect(call.sql).toContain("normalized_surface_hash IS NULL");
    expect(call.sql).toContain("jsonb_typeof(frame_json->'surface')='string'");
    expect(call.sql).not.toContain("SELECT frame_json");
  }
  expect(f.frames.map(row => ({ id: row.id, frameJson: row.frameJson }))).toEqual(original);
  f.frames.forEach(row => {
    const surface = (row.frameJson as { surface?: unknown }).surface;
    expect(row.hash).toBe(typeof surface === "string" ? key(surface) : null);
  });
  const write = f.calls.findIndex(call => call.sql.startsWith("UPDATE") && call.sql.includes("normalized_surface_hash"));
  const publish = f.calls.findIndex(call => call.sql.includes("VALUES('schema_version'"));
  expect(publish).toBeGreaterThan(write);
  expect(f.calls[write]!.sql).toContain("frame.frame_json->>'surface'=observed.surface");
  expect(f.calls[publish]!.params[0]).toContain(`"version":${POSTGRES_SCHEMA_VERSION}`);
  const start = f.calls.length;
  await f.adapter.migrate();
  const repeat = f.calls.slice(start);
  expect(repeat.filter(call => call.sql.includes("SELECT id,frame_json->>'surface' AS surface"))).toHaveLength(1);
  expect(repeat.some(call => call.sql.startsWith("UPDATE") && call.sql.includes("normalized_surface_hash"))).toBe(false);
});

it.each([{ changeSurface: true }, { failUpdate: true }])("does not publish or retain a partially backfilled migration: %j", async options => {
  const f = migrationFixture(options);
  const hashes = f.frames.map(row => row.hash);
  await expect(f.adapter.migrate()).rejects.toThrow(options.failUpdate ? "injected backfill failure" : "changed during migration");
  expect(f.calls.some(call => call.sql === "ROLLBACK")).toBe(true);
  expect(f.calls.some(call => call.sql === "COMMIT" || call.sql.includes("VALUES('schema_version'"))).toBe(false);
  expect(f.frames.map(row => row.hash)).toEqual(hashes);
});
