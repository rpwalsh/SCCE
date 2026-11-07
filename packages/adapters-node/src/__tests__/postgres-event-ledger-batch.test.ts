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
  return statements.filter(statement => statement.sql.includes("INSERT INTO") && statement.sql.includes("(id, episode_id, type_id, t, payload_json"));
}

function mutableLedgerAdapter() {
  const stored = new Map<string, Record<string, unknown>>();
  let head: unknown;
  let failNextEventInsert = false;
  const statements: RecordedStatement[] = [];
  const adapter = new PostgresStorageAdapter({ url: "postgres://offline.invalid/none", schema: "offline_ledger" });
  const client = {
    async query(sql: string, params: readonly unknown[] = []) {
      statements.push({ sql, params });
      if (sql.startsWith("SELECT value_json")) return { rows: head ? [{ value_json: head }] : [] };
      if (sql.startsWith("WITH RECURSIVE ledger_type_ids")) {
        const tail = [...stored.values()].sort((a, b) => Number(b.t) - Number(a.t) || String(b.id).localeCompare(String(a.id)))[0];
        return { rows: tail ? [{ ledger_hash: tail.ledger_hash }] : [] };
      }
      if (sql.startsWith("SELECT id, hash") || sql.startsWith("SELECT *")) return { rows: (params[0] as string[]).flatMap(id => stored.has(id) ? [stored.get(id)!] : []) };
      if (sql.includes("INSERT INTO") && sql.includes("(id, episode_id")) {
        if (failNextEventInsert) {
          failNextEventInsert = false;
          throw new Error("injected event insert failure");
        }
        for (let index = 0; index < params.length; index += 8) {
          const [id, episode_id, type_id, t, payload, parents, hash, ledger_hash] = params.slice(index, index + 8);
          if (!stored.has(String(id))) stored.set(String(id), { id, episode_id, type_id, t, payload_json: JSON.parse(String(payload)), parents, hash, ledger_hash });
        }
      } else if (sql.includes("INSERT INTO") && sql.includes("storage_meta")) head = JSON.parse(String(params[1]));
      return { rows: [] };
    },
    release() {}
  };
  (adapter.pool as unknown as { connect: () => Promise<unknown> }).connect = async () => client;
  (adapter.pool as unknown as { query: typeof client.query }).query = client.query;
  return { adapter, stored, statements, failEventInsert: () => { failNextEventInsert = true; } };
}

describe("postgres event ledger batch append", () => {
  it("chains only newly committed identities, including repeated events inside one batch", async () => {
    const { adapter, stored } = mutableLedgerAdapter();
    const first = event(0), second = event(1), third = event(2);
    await adapter.events.appendBatch([first, first]);
    await adapter.events.appendBatch([first, second, second, third]);
    let previous = "";
    for (const source of [first, second, third]) {
      previous = createHash("sha256").update(`${previous}${UNIT_SEPARATOR}${source.hash}`).digest("hex");
      expect(stored.get(String(source.id))?.ledger_hash).toBe(previous);
    }
    expect(stored.size).toBe(3);
    expect(await adapter.events.latestLedgerHash()).toBe(previous);
    await adapter.events.appendBatch([third, first]);
    expect(stored.size).toBe(3);
    expect(await adapter.events.latestLedgerHash()).toBe(previous);
  });

  it("preserves append order when an older episode finishes after a newer timestamp", async () => {
    const { adapter, stored, statements } = mutableLedgerAdapter();
    const newer = event(20), older = event(1), final = event(21);
    for (const source of [newer, older, final]) await adapter.events.append(source);
    let previous = "";
    for (const source of [newer, older, final]) {
      previous = createHash("sha256").update(`${previous}${UNIT_SEPARATOR}${source.hash}`).digest("hex");
      expect(stored.get(String(source.id))?.ledger_hash).toBe(previous);
    }
    const lock = statements.findIndex(row => row.sql.includes("pg_advisory_xact_lock"));
    const firstRead = statements.findIndex(row => row.sql.startsWith("SELECT value_json"));
    expect(lock).toBeGreaterThan(-1);
    expect(lock).toBeLessThan(firstRead);
  });

  it("serializes concurrent appends sharing one ambient transaction client", async () => {
    const { adapter, stored } = mutableLedgerAdapter();
    const first = event(20), second = event(1);
    await adapter.transaction(() => Promise.all([
      adapter.events.append(first),
      adapter.events.append(second)
    ]));
    const firstHash = createHash("sha256").update(`${UNIT_SEPARATOR}${first.hash}`).digest("hex");
    const secondHash = createHash("sha256").update(`${firstHash}${UNIT_SEPARATOR}${second.hash}`).digest("hex");
    expect(stored.get(String(first.id))?.ledger_hash).toBe(firstHash);
    expect(stored.get(String(second.id))?.ledger_hash).toBe(secondHash);
    expect(await adapter.events.latestLedgerHash()).toBe(secondHash);
  });

  it("does not issue queued SQL after an append fails on the shared transaction client", async () => {
    const { adapter, stored, statements, failEventInsert } = mutableLedgerAdapter();
    const first = event(0), second = event(1);
    failEventInsert();
    await expect(adapter.transaction(() => Promise.all([
      adapter.events.append(first),
      adapter.events.append(second)
    ]))).rejects.toThrow("injected event insert failure");
    expect(inserts(statements)).toHaveLength(1);
    expect(stored.size).toBe(0);
    expect(statements.some(statement => statement.sql.includes("storage_meta") && statement.sql.includes("INSERT INTO"))).toBe(false);
  });

  it("rejects content collisions before issuing event inserts", async () => {
    const { adapter, stored, statements } = mutableLedgerAdapter();
    const original = event(0);
    await expect(adapter.events.appendBatch([original, { ...original, payload: { changed: true } }])).rejects.toMatchObject({ code: "SCCE_EVENT_IDENTITY_CONFLICT" });
    expect(stored.size).toBe(0);
    await adapter.events.append(original);
    const count = inserts(statements).length;
    await expect(adapter.events.append({ ...original, payload: { changed: true } })).rejects.toMatchObject({ code: "SCCE_EVENT_IDENTITY_CONFLICT" });
    await expect(adapter.events.append({ ...original, hash: "different" })).rejects.toMatchObject({ code: "SCCE_EVENT_IDENTITY_CONFLICT" });
    expect(inserts(statements)).toHaveLength(count);
    expect(stored.get(String(original.id))?.payload_json).toEqual(original.payload);
  });

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
