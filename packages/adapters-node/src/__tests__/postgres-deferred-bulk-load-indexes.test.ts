// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
import { describe, expect, it } from "vitest";
import {
  BULK_LOAD_DEFERRABLE_TABLES,
  DEFERRED_INDEX_META_KEY,
  DEFERRED_INDEX_RESTORE_PARALLEL_WORKERS,
  DEFERRED_INDEX_RESTORE_SORT_MEMORY,
  deferBulkLoadIndexes,
  deferredBulkLoadIndexes,
  schemaStatements
} from "../postgres.js";

// Measured on 248,778 real observations: 20,512ms to insert with the production indexes, 13,241ms with the
// primary key alone, 7,503ms with none. Index maintenance is 63% of the insert, so a corpus build defers it --
// but a schema missing its read indexes answers slowly and ranks wrongly while looking healthy, so the
// deferral must be recorded, refused by verification, and undone by migration alone.

function fakeStorage(schema: string, options: { deferred?: string[]; indexes?: string[] } = {}) {
  const statements: Array<{ sql: string; params: readonly unknown[] }> = [];
  const storage = {
    statements,
    table: (name: string) => `"${schema}"."${name}"`,
    query: async (sql: string, params: readonly unknown[] = []) => {
      statements.push({ sql, params });
      if (sql.includes("storage_meta") && sql.includes("SELECT value_json")) {
        return options.deferred ? [{ value_json: { indexes: options.deferred } }] : [];
      }
      if (sql.includes("pg_indexes")) {
        return (options.indexes ?? []).map(indexname => ({ indexname, tablename: "ngram_observations" }));
      }
      return [];
    }
  };
  return storage as unknown as Parameters<typeof deferBulkLoadIndexes>[0] & { statements: typeof statements };
}

describe("deferring read indexes for a corpus build", () => {
  it("defers only secondary indexes, never the primary key the upsert needs", async () => {
    const storage = fakeStorage("scce4_runtime", { indexes: ["idx_a", "idx_b"] });
    const result = await deferBulkLoadIndexes(storage, "scce4_runtime");
    expect(result.deferred).toEqual(["idx_a", "idx_b"]);
    const listing = storage.statements.find(statement => statement.sql.includes("pg_indexes"))!;
    expect(listing.sql).toContain("indexname NOT LIKE '%\\_pkey'");
    expect(listing.params[1]).toEqual([...BULK_LOAD_DEFERRABLE_TABLES]);
  });

  it("records the deferral before dropping anything, so a crash mid-drop still leaves it refused", async () => {
    const storage = fakeStorage("scce4_runtime", { indexes: ["idx_a", "idx_b"] });
    await deferBulkLoadIndexes(storage, "scce4_runtime");
    const markerIndex = storage.statements.findIndex(statement => statement.params[0] === DEFERRED_INDEX_META_KEY && statement.sql.includes("INSERT"));
    const firstDropIndex = storage.statements.findIndex(statement => statement.sql.includes("DROP INDEX"));
    expect(markerIndex).toBeGreaterThan(-1);
    expect(firstDropIndex).toBeGreaterThan(markerIndex);
  });

  it("writes nothing when there is nothing to defer, so the schema stays serveable", async () => {
    const storage = fakeStorage("scce4_runtime", { indexes: [] });
    const result = await deferBulkLoadIndexes(storage, "scce4_runtime");
    expect(result.deferred).toEqual([]);
    expect(storage.statements.some(statement => statement.sql.includes("DROP INDEX"))).toBe(false);
    expect(storage.statements.some(statement => statement.sql.includes("INSERT"))).toBe(false);
  });

  it("reads back what is deferred", async () => {
    expect(await deferredBulkLoadIndexes(fakeStorage("s", { deferred: ["idx_x"] }))).toEqual(["idx_x"]);
    expect(await deferredBulkLoadIndexes(fakeStorage("s"))).toEqual([]);
  });

  it("declares every deferrable index in the always-run migration, so migrate really is the way back", () => {
    const joined = schemaStatements("fixture").join("\n");
    for (const table of BULK_LOAD_DEFERRABLE_TABLES) {
      const declared = joined.split("\n").filter(line => line.includes(`CREATE INDEX IF NOT EXISTS`) && line.includes(`.${table}(`));
      expect(declared.length).toBeGreaterThan(0);
    }
  });

  it("gives the restore real sort memory, without which deferring buys nothing", () => {
    expect(DEFERRED_INDEX_RESTORE_SORT_MEMORY).toMatch(/^\d+(MB|GB)$/u);
    const megabytes = DEFERRED_INDEX_RESTORE_SORT_MEMORY.endsWith("GB")
      ? Number.parseInt(DEFERRED_INDEX_RESTORE_SORT_MEMORY, 10) * 1024
      : Number.parseInt(DEFERRED_INDEX_RESTORE_SORT_MEMORY, 10);
    expect(megabytes).toBeGreaterThan(64);
    expect(DEFERRED_INDEX_RESTORE_PARALLEL_WORKERS).toBeGreaterThan(0);
  });
});
