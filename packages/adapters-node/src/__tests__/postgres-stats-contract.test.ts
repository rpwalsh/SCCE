import { afterEach, describe, expect, it } from "vitest";
import { createPostgresStorageAdapter, type PostgresStorageAdapter } from "../postgres.js";

const adapters: PostgresStorageAdapter[] = [];

afterEach(async () => {
  await Promise.all(adapters.splice(0).map(adapter => adapter.close()));
});

describe("Postgres count semantics", () => {
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

    const status = await adapter.status() as Record<string, unknown>;
    expect(status).toMatchObject({
      schema: "scce.postgres.status.v1",
      ok: false,
      countSemantics: "postgres_exact_table_counts",
      tableCounts: { source_versions: 21413 },
      health: "needs_migration"
    });
    expect(status.errors).toEqual(["exact count failed for evidence_spans: fixture count unavailable"]);
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
