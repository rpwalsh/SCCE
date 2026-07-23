import { afterEach, describe, expect, it } from "vitest";
import { POSTGRES_REQUIRED_TABLES } from "@scce/kernel";
import { createPostgresStorageAdapter, type PostgresStorageAdapter } from "../postgres.js";

const adapters: PostgresStorageAdapter[] = [];

afterEach(async () => {
  await Promise.all(adapters.splice(0).map(adapter => adapter.close()));
});

describe("Postgres graph-node rank contract", () => {
  it("keeps latest fallback ordering aligned with the alpha-rank index", async () => {
    const { adapter, calls } = fixture();

    await adapter.graph.getSlice({ allowLatestFallback: true, limitNodes: 3000, limitEdges: 6000 });

    expect(calls).toHaveLength(1);
    expect(calls[0]?.sql).toContain("FROM \"fixture\".\"graph_nodes\"");
    expect(calls[0]?.sql).toContain("ORDER BY alpha DESC, updated_at DESC, id LIMIT $1");
    expect(calls[0]?.params).toEqual([3000]);
  });

  it("migrates one idempotent index matching the exact fallback rank", async () => {
    const { adapter } = fixture();
    const statements: string[] = [];
    const client = {
      async query(sql: string): Promise<{ rows: Array<Record<string, string>> }> {
        statements.push(sql);
        if (sql.includes("information_schema.tables")) {
          return { rows: POSTGRES_REQUIRED_TABLES.map(table_name => ({ table_name })) };
        }
        if (sql.includes("information_schema.columns")) {
          const identifiers = [...new Set(statements
            .filter(statement => statement.startsWith("CREATE TABLE"))
            .flatMap(statement => statement.match(/[A-Za-z_][A-Za-z0-9_]*/g) ?? []))];
          return {
            rows: POSTGRES_REQUIRED_TABLES.flatMap(table_name => identifiers.map(column_name => ({ table_name, column_name })))
          };
        }
        return { rows: [] };
      },
      release(): void {}
    };
    (adapter.pool as unknown as { connect: () => Promise<typeof client> }).connect = async () => client;

    await adapter.migrate();

    expect(statements.filter(statement => statement.includes("nodes_alpha_rank"))).toEqual([
      `CREATE INDEX IF NOT EXISTS idx_fixture_nodes_alpha_rank ON "fixture".graph_nodes(alpha DESC,updated_at DESC,id)`
    ]);
  });
});

function fixture(): {
  adapter: PostgresStorageAdapter;
  calls: Array<{ sql: string; params: unknown[] }>;
} {
  const adapter = createPostgresStorageAdapter({ url: "postgres://fixture:fixture@127.0.0.1/fixture", schema: "fixture" });
  adapters.push(adapter);
  const calls: Array<{ sql: string; params: unknown[] }> = [];
  adapter.query = async <T>(sql: string, params: unknown[] = []): Promise<T[]> => {
    calls.push({ sql, params });
    return [];
  };
  return { adapter, calls };
}
