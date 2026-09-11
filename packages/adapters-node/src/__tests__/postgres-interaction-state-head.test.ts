// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
import { afterEach, describe, expect, it } from "vitest";
import { POSTGRES_REQUIRED_TABLES } from "@scce/kernel";
import { createPostgresStorageAdapter, type PostgresStorageAdapter } from "../postgres.js";

const adapters: PostgresStorageAdapter[] = [];

afterEach(async () => {
  await Promise.all(adapters.splice(0).map(adapter => adapter.close()));
});

describe("Postgres dialogue-state head contract", () => {
  it("reads the head in the compare-and-set order the partial head index serves", async () => {
    const { adapter, calls } = fixture();

    await adapter.dialogueMemory.listInteractionStates({ conversationId: "conversation.01", headSchema: "scce.dialogue_cognitive_state.v2", limit: 1 });

    expect(calls).toHaveLength(1);
    expect(calls[0]?.sql).toContain("state_json->>'schema'=$2");
    expect(calls[0]?.sql).toContain("jsonb_typeof(state_json->'turnIndex')='number'");
    expect(calls[0]?.sql).toContain("ORDER BY (state_json->>'turnIndex')::numeric DESC, created_at DESC, id DESC LIMIT $3");
    expect(calls[0]?.params).toEqual(["conversation.01", "scce.dialogue_cognitive_state.v2", 1]);
  });

  it("migrates one idempotent partial index matching the head order", async () => {
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

    expect(statements.filter(statement => statement.includes("interaction_state_head"))).toEqual([
      `CREATE INDEX IF NOT EXISTS idx_fixture_interaction_state_head ON "fixture".interaction_state_records(conversation_id,((state_json->>'turnIndex')::numeric) DESC,created_at DESC,id DESC) WHERE state_json->>'schema'='scce.dialogue_cognitive_state.v2' AND jsonb_typeof(state_json->'turnIndex')='number'`
    ]);
  });
});

function fixture(): {
  adapter: PostgresStorageAdapter;
  calls: Array<{ sql: string; params: unknown[] }>;
} {
  const adapter = createPostgresStorageAdapter({
    url: "postgres://fixture:fixture@127.0.0.1/fixture",
    schema: "fixture",
    informationAccess: { tenantId: "fixture-tenant", principalId: "fixture-principal", compartments: [], maximumExportClass: "public" }
  });
  adapters.push(adapter);
  const calls: Array<{ sql: string; params: unknown[] }> = [];
  adapter.query = async <T>(sql: string, params: unknown[] = []): Promise<T[]> => {
    calls.push({ sql, params });
    return [];
  };
  return { adapter, calls };
}
