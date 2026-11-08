// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
import { afterEach, describe, expect, it } from "vitest";
import { createPostgresStorageAdapter, type PostgresStorageAdapter } from "../postgres.js";
import { STORAGE_STATUS_POPULATION_LIMITS } from "../../../kernel/src/storage.js";

const adapters: PostgresStorageAdapter[] = [];

afterEach(async () => {
  await Promise.all(adapters.splice(0).map(adapter => adapter.close()));
});

describe("Postgres count semantics", () => {
  it("checks default readiness through schema and active metadata without scanning table rows", async () => {
    const adapter = fixture(), statements: string[] = [];
    adapter.verify = async () => ({ ok: true, tables: ["storage_meta", "source_versions", "evidence_spans"], errors: [] });
    adapter.query = async <T>(sql: string): Promise<T[]> => {
      statements.push(sql);
      if (sql.includes("COUNT(*)")) throw new Error("readiness must not count rows");
      if (sql.includes("schema_version")) return [{ value_json: { version: "fixture" } }] as T[];
      return [];
    };
    const status = await adapter.status() as Record<string, unknown>;
    expect(statements.filter(sql => sql.includes("COUNT(*)"))).toEqual([]);
    expect(statements.every(sql => sql.includes('"storage_meta"') && sql.includes("WHERE key=")
      || sql.includes('"model_state"') && sql.includes("WHERE id='scce2.active_brain'"))).toBe(true);
    expect(status).toMatchObject({ ok: true, detail: "readiness", countSemantics: "postgres_schema_readiness" });
    expect(status.tableCounts).toBeUndefined();
    expect(status.tablePopulation).toBeUndefined();
  });

  it("labels planner statistics as estimates", async () => {
    const adapter = fixture();
    adapter.query = async <T>(): Promise<T[]> => [
      { relname: "evidence_spans", estimated_rows: "21064" }
    ] as T[];

    expect(await adapter.stats()).toEqual({
      schema: "scce.postgres.stats.v1",
      exact: false,
      countSemantics: "postgres_planner_estimate",
      tables: [{ table: "evidence_spans", rows: 21064, estimated: true }]
    });
  });

  it("publishes exact table counts through status and fails closed on a count error", async () => {
    const adapter = fixture();
    adapter.verify = async () => ({
      ok: true,
      tables: ["source_versions", "evidence_spans"],
      errors: []
    });
    adapter.query = async <T>(sql: string): Promise<T[]> => {
      if (sql.includes("FROM \"fixture\".\"source_versions\"")) return [{ count: "21413" }] as T[];
      if (sql.includes("FROM \"fixture\".\"evidence_spans\"")) throw new Error("fixture count unavailable");
      return [];
    };

    const status = await adapter.status({ detail: "exact" }) as Record<string, unknown>;
    expect(status).toMatchObject({
      schema: "scce.postgres.status.v1",
      ok: false,
      countSemantics: "postgres_exact_table_counts",
      tableCounts: { source_versions: 21413 },
      health: "needs_migration"
    });
    expect(status.errors).toEqual(["exact count failed for evidence_spans: fixture count unavailable"]);
  });

  it.each(["launch", "questions"] as const)("measures %s population only up to its explicit caps", async population => {
    const adapter = fixture(), calls: Array<{ sql: string; params: unknown[] }> = [];
    const limits = STORAGE_STATUS_POPULATION_LIMITS[population];
    adapter.verify = async () => ({ ok: true, tables: Object.keys(limits), errors: [] });
    adapter.query = async <T>(sql: string, params: unknown[] = []): Promise<T[]> => {
      calls.push({ sql, params });
      if (sql.includes("population_probe")) {
        expect(sql).toContain("LIMIT $1");
        return [{ count: sql.includes('"ngram_observations"') ? "0" : String(params[0]) }] as T[];
      }
      if (sql.includes("COUNT(*)")) throw new Error("unbounded count forbidden for population");
      return [];
    };
    const status = await adapter.status({ detail: "population", population }) as Record<string, any>;
    expect(status).toMatchObject({ ok: true, detail: "population", population, countSemantics: "postgres_bounded_population" });
    expect(status.tableCounts).toBeUndefined();
    expect(calls.filter(call => call.sql.includes("population_probe"))).toHaveLength(Object.keys(limits).length);
    expect(status.tablePopulation.ngram_observations).toEqual({ sampledRows: 0, cap: 1, exact: true, capReached: false });
    for (const [table, cap] of Object.entries(limits)) if (table !== "ngram_observations") {
      expect(status.tablePopulation[table]).toEqual({ sampledRows: cap, cap, exact: false, capReached: true });
    }
  });

  it("reports sub-cap populations exactly and refuses a failed population probe", async () => {
    const adapter = fixture();
    adapter.verify = async () => ({ ok: true, tables: ["source_versions", "evidence_spans"], errors: [] });
    adapter.query = async <T>(sql: string): Promise<T[]> => {
      if (sql.includes('"source_versions"')) return [{ count: "9999" }] as T[];
      if (sql.includes('"evidence_spans"')) throw new Error("probe unavailable");
      return [];
    };
    expect(await adapter.status({ detail: "population", population: "launch" })).toMatchObject({ ok: false,
      tablePopulation: { source_versions: { sampledRows: 9999, cap: 10000, exact: true, capReached: false } },
      errors: ["population probe failed for evidence_spans: probe unavailable"] });
  });

  it("shares only concurrent work of the same detail and rereads completed or failed checks", async () => {
    const adapter = fixture();
    let verifications = 0;
    const releases: Array<() => void> = [];
    adapter.verify = async () => { verifications++; await new Promise<void>(resolve => releases.push(resolve)); return { ok: true, tables: [], errors: [] }; };
    adapter.query = async <T>(): Promise<T[]> => [];
    const first = adapter.status(), concurrent = adapter.status(), exact = adapter.status({ detail: "exact" });
    expect(verifications).toBe(2);
    releases.splice(0).forEach(release => release());
    await Promise.all([first, concurrent, exact]);
    const next = adapter.status();
    expect(verifications).toBe(3);
    releases.splice(0).forEach(release => release());
    await next;
    adapter.verify = async () => { verifications++; throw new Error("not ready"); };
    expect(await adapter.status()).toMatchObject({ ok: false });
    expect(await adapter.status()).toMatchObject({ ok: false });
    expect(verifications).toBe(5);
  });

  it.each([{ detail: "all" }, { detail: "population", population: "unknown" }, { detail: "population", population: "" },
    { detail: "exact", population: "launch" }, { population: "questions" }])("rejects invalid detail without a database read: %j", async options => {
    const adapter = fixture();
    let reads = 0;
    adapter.verify = async () => { reads++; return { ok: true, tables: [], errors: [] }; };
    await expect(adapter.status(options as never)).rejects.toThrow("invalid storage status detail");
    expect(reads).toBe(0);
  });
});

function fixture(): PostgresStorageAdapter {
  const adapter = createPostgresStorageAdapter({
    url: "postgres://fixture:fixture@127.0.0.1/fixture",
    schema: "fixture"
  });
  adapters.push(adapter);
  return adapter;
}
