import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import type { ScceEvent } from "@scce/kernel";
import { PostgresStorageAdapter } from "../postgres.js";

interface RecordedStatement { readonly sql: string; readonly params: readonly unknown[] }

const UNIT_SEPARATOR = String.fromCharCode(31);

function offlineAdapter(rows: (sql: string) => unknown[] = () => []): { adapter: PostgresStorageAdapter; statements: RecordedStatement[] } {
  const adapter = new PostgresStorageAdapter({ url: "postgres://offline.invalid/none", schema: "offline_ledger" });
  const statements: RecordedStatement[] = [];
  const client = {
    async query(sql: string, params: readonly unknown[] = []) {
      statements.push({ sql, params });
      return { rows: rows(sql) };
    },
    release() { /* offline */ }
  };
  (adapter.pool as unknown as { connect: () => Promise<unknown> }).connect = async () => client;
  // Migration preflight also queries the pool directly; keep that path offline.
  (adapter.pool as unknown as { query: typeof client.query }).query = client.query;
  return { adapter, statements };
}

function event(index: number): ScceEvent {
  return {
    id: `event_${index}`,
    episodeId: "episode_batch",
    typeId: "OwnerAsked",
    t: 1_000 + index,
    payload: { schema: "test", index },
    parents: [],
    hash: createHash("sha256").update(`event_${index}`).digest("hex")
  } as unknown as ScceEvent;
}

function inserts(statements: readonly RecordedStatement[]): RecordedStatement[] {
  return statements.filter(statement => statement.sql.includes("INSERT INTO"));
}

describe("postgres event ledger batch append", () => {
  it("writes a whole turn's events in one statement instead of one per event", async () => {
    const { adapter, statements } = offlineAdapter();
    const events = Array.from({ length: 37 }, (_, index) => event(index));

    await adapter.events.appendBatch(events);

    const written = inserts(statements);
    expect(written).toHaveLength(1);
    expect(written[0]!.params).toHaveLength(37 * 8);
    expect(written[0]!.sql).toContain("ON CONFLICT(id) DO NOTHING");
    expect(statements.map(statement => statement.sql)).toContain("BEGIN");
    expect(statements.map(statement => statement.sql)).toContain("COMMIT");
  });

  it("reads the ledger tail through an indexed column rather than sorting the whole table", async () => {
    const { adapter, statements } = offlineAdapter();

    await adapter.events.appendBatch([event(0)]);

    const tail = statements.find(statement => statement.sql.includes("ledger_hash") && !statement.sql.includes("INSERT INTO"));
    expect(tail).toBeDefined();
    // Without an index on (t, id) the unqualified ordering is a full-table sort; the tail must be scoped by type_id.
    expect(tail!.sql).toContain("type_id");
  });

  it("chains ledger hashes in the same order the events were given", async () => {
    const { adapter, statements } = offlineAdapter();
    const events = Array.from({ length: 5 }, (_, index) => event(index));

    await adapter.events.appendBatch(events);

    const params = inserts(statements)[0]!.params;
    let previous = "";
    for (const [index, source] of events.entries()) {
      const expected = createHash("sha256").update(`${previous}${UNIT_SEPARATOR}${source.hash}`).digest("hex");
      expect(params[index * 8 + 7]).toBe(expected);
      expect(params[index * 8]).toBe(source.id);
      previous = expected;
    }
  });

  it("splits a batch that would exceed the wire protocol's bind parameter limit", async () => {
    const { adapter, statements } = offlineAdapter();
    const events = Array.from({ length: 9_000 }, (_, index) => event(index));

    await adapter.events.appendBatch(events);

    const written = inserts(statements);
    expect(written.length).toBeGreaterThan(1);
    for (const statement of written) expect(statement.params.length).toBeLessThanOrEqual(65_535);
    expect(written.reduce((total, statement) => total + statement.params.length, 0)).toBe(9_000 * 8);
  });

  it("writes nothing for an empty batch", async () => {
    const { adapter, statements } = offlineAdapter();

    await adapter.events.appendBatch([]);

    expect(statements).toHaveLength(0);
  });
});

function rankedNgramIndexStatements(statements: readonly RecordedStatement[]): string[] {
  return statements.map(statement => statement.sql).filter(sql => sql.includes("_ngram_model_source_system_ranked") || sql.includes("_ngram_model_profile_ranked"));
}

describe("ngram model ranking indexes", () => {
  it("creates both ranking indexes when the migration is creating the schema", async () => {
    const { adapter, statements } = offlineAdapter(sql => sql.includes("to_regclass") ? [{ present: null }] : []);

    // The schema fake is deliberately incomplete, so the migration reports that and rolls back; the statements it
    // issued before that point are what this asserts on.
    await expect(adapter.migrate()).rejects.toThrow(/schema migration incomplete/);

    expect(rankedNgramIndexStatements(statements)).toHaveLength(2);
  });

  it("skips both ranking indexes on a schema that already has ngram_models", async () => {
    const { adapter, statements } = offlineAdapter(sql => sql.includes("to_regclass") ? [{ present: "offline_ledger.ngram_models" }] : []);

    await expect(adapter.migrate()).rejects.toThrow(/schema migration incomplete/);

    expect(rankedNgramIndexStatements(statements)).toHaveLength(0);
  });
});
