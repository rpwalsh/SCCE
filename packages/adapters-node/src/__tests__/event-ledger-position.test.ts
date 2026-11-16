// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
import { expect, it } from "vitest";
import { EVENT_LEDGER_POSITION_MAX, ledgerPosition, ledgerLink, qualifyRetainedLedgerPositions, readPositionedLedgerHead } from "../event-ledger-position.js";
import { schemaStatements, requiredHydrationColumns, requiredSchemaErrors } from "../postgres-schema.js";
import { applyRetainedEventLedgerPositions, planRetainedEventLedgerPositions, retainedEventPositionSchemaStatements } from "../event-ledger-position-maintenance.js";
import { POSTGRES_REQUIRED_TABLES } from "@scce/kernel";
import type { PoolClient } from "pg";
import type { PostgresStorageAdapter } from "../postgres.js";

it("retains exact BIGINT positions beyond Number precision and rejects coercion or overflow", () => {
  expect(ledgerPosition("9007199254740993") + 1n).toBe(9007199254740994n);
  expect(ledgerPosition(EVENT_LEDGER_POSITION_MAX.toString())).toBe(EVENT_LEDGER_POSITION_MAX);
  for (const value of [0, -1, "01", "1.0", "1e3", "", null, undefined, Number.MAX_SAFE_INTEGER + 1, EVENT_LEDGER_POSITION_MAX + 1n]) expect(() => ledgerPosition(value)).toThrow();
});

it("backfills only an independently proved rolling order, irrespective of row order, timestamps or IDs", () => {
  let previous = "";
  const ordered = ["z", "a", "m"].map((id, i) => { previous = ledgerLink(previous, `event_hash_${i}`); return { id, hash: `event_hash_${i}`, ledger_hash: previous }; });
  const last = ordered.at(-1)!, head = { eventId: last.id, eventHash: last.hash, ledgerHash: last.ledger_hash };
  const proof = { schema: "scce.ledger_header_order_proof.v1", eventIds: ordered.map(row => row.id), appendOrderProven: true, snapshotHead: head };
  expect(qualifyRetainedLedgerPositions([...ordered].reverse(), proof, head)).toEqual([{ id: "z", ledger_position: "1" }, { id: "a", ledger_position: "2" }, { id: "m", ledger_position: "3" }]);
  for (const eventIds of [["a", "z", "m"], ["z", "a"], ["z", "z", "m"], ["z", "a", "other"]]) expect(() => qualifyRetainedLedgerPositions(ordered, { ...proof, eventIds }, head)).toThrow();
  expect(() => qualifyRetainedLedgerPositions(ordered.map((row, i) => i ? row : { ...row, hash: "changed" }), proof, head)).toThrow();
  expect(() => qualifyRetainedLedgerPositions(ordered, proof, { ...head, ledgerHash: "changed" })).toThrow();
  expect(() => qualifyRetainedLedgerPositions(ordered.map((row, i) => ({ ...row, ledger_position: String(i + 2) })), proof, head)).toThrow();
});

it("never guesses retained order or reads wall-clock ordering when canonical positions are absent", async () => {
  const calls: string[] = [];
  await expect(readPositionedLedgerHead(async <T>(sql: string) => { calls.push(sql); return [{ head: { eventId: "id", eventHash: "hash", ledgerHash: "ledger" }, present: true, unpositioned: true, tail_position: null }] as T[]; }, '"events"', '"meta"')).rejects.toThrow(/maintenance/u);
  expect(calls).toHaveLength(1);
  expect(calls[0]).not.toMatch(/ORDER BY t|ctid/u);
  expect(calls[0]).toContain("ORDER BY ledger_position DESC LIMIT 1");
});

it("adds metadata/indexes without executing a guessed backfill and requires positions for fresh events", () => {
  const sql = schemaStatements('"position_test"').filter(row => row.includes(".events"));
  expect(sql.some(row => row.includes("ledger_position BIGINT NOT NULL"))).toBe(true);
  expect(sql.some(row => row.includes("ADD COLUMN IF NOT EXISTS ledger_position BIGINT"))).toBe(true);
  expect(sql.some(row => row.includes("CREATE UNIQUE INDEX") && row.includes("(ledger_position)"))).toBe(true);
  expect(sql.some(row => row.includes("UPDATE") && !row.includes("TRIGGER"))).toBe(false);
});

it("qualifies a retained-order maintenance plan without a position column and issues no mutations", async () => {
  const rows = [{ id: "one", hash: "event.one", ledger_hash: ledgerLink("", "event.one"), ledger_position: null }];
  const head = { eventId: "one", eventHash: rows[0]!.hash, ledgerHash: rows[0]!.ledger_hash };
  const proof = { schema: "scce.ledger_header_order_proof.v1", eventIds: ["one"], appendOrderProven: true, snapshotHead: head };
  const calls: string[] = [];
  const result = await planRetainedEventLedgerPositions({ schema: "fixture", table: name => `"${name}"`,
    query: async <T>(sql: string) => {
      calls.push(sql);
      if (sql.includes("information_schema.columns")) return [{ present: false }] as T[];
      if (sql.startsWith("SELECT id, hash")) return rows as T[];
      if (sql.startsWith("SELECT value_json")) return [{ value_json: head }] as T[];
      throw Error("unexpected plan query");
    } }, proof);
  expect(result).toMatchObject({ mode: "read_only", events: 1, columnPresent: false, positionWrites: 0, immutableEventWrites: 0 });
  expect(calls.every(sql => sql.startsWith("SELECT"))).toBe(true);
});

it("selects exactly the production event-position DDL without any other migration", () => {
  const ddl = retainedEventPositionSchemaStatements("owned_schema");
  expect(ddl).toHaveLength(3);
  expect(ddl[0]).toContain('ALTER TABLE "owned_schema".events ADD COLUMN IF NOT EXISTS ledger_position BIGINT CHECK');
  expect(ddl[1]).toContain("CREATE UNIQUE INDEX IF NOT EXISTS");
  expect(ddl[2]).toContain("WHERE ledger_position IS NULL");
  expect(ddl.every(sql => !/UPDATE|DELETE|INSERT|language_|ngram_|source_/u.test(sql))).toBe(true);
  expect(() => retainedEventPositionSchemaStatements('bad"schema')).toThrow();
});

it("shares the strict required-schema checker and exempts only the absent position column explicitly", async () => {
  let omitted = new Set(["events.ledger_position"]);
  const client = { query: async (sql: string) => ({ rows: sql.includes("information_schema.tables")
    ? POSTGRES_REQUIRED_TABLES.map(table_name => ({ table_name }))
    : Object.entries(requiredHydrationColumns()).flatMap(([table_name, columns]) => columns.filter(column => !omitted.has(`${table_name}.${column}`)).map(column_name => ({ table_name, column_name }))) }) } as unknown as Pick<PoolClient, "query">;
  expect(await requiredSchemaErrors(client, "fixture")).toEqual(["missing column: events.ledger_position"]);
  expect(await requiredSchemaErrors(client, "fixture", { allowAbsentLedgerPosition: true })).toEqual([]);
  omitted = new Set(["events.ledger_position", "sources.id"]);
  expect(await requiredSchemaErrors(client, "fixture", { allowAbsentLedgerPosition: true })).toEqual(["missing column: sources.id"]);
});

it("rejects unsupported schema versions before any DDL and authenticates the proof before version admission", async () => {
  const row = { id: "one", hash: "event.one", ledger_hash: ledgerLink("", "event.one"), ledger_position: null };
  const head = { eventId: row.id, eventHash: row.hash, ledgerHash: row.ledger_hash };
  const proof = { schema: "scce.ledger_header_order_proof.v1", eventIds: [row.id], appendOrderProven: true, snapshotHead: head };
  for (const version of [undefined, 40, 43, "41"]) {
    const calls: string[] = [];
    const storage = { schema: "fixture", table: (name: string) => `"fixture"."${name}"`, tx: async (fn: (client: unknown) => Promise<unknown>) => fn({ query: async (sql: string) => {
      calls.push(sql);
      if (sql.includes("information_schema.columns")) return { rows: [{ present: false }] };
      if (sql.startsWith("SELECT id, hash")) return { rows: [row] };
      if (sql.includes("schema_version")) return { rows: [{ value_json: { version } }] };
      if (sql.startsWith("SELECT value_json")) return { rows: [{ value_json: head }] };
      if (sql.startsWith("SELECT pg_advisory") || sql.startsWith("LOCK TABLE")) return { rows: [] };
      throw Error(`unexpected query: ${sql}`);
    } }) } as unknown as PostgresStorageAdapter;
    await expect(applyRetainedEventLedgerPositions(storage, proof)).rejects.toThrow(/schema version 41 or 42/u);
    expect(calls.some(sql => /^(?:ALTER|CREATE|UPDATE|INSERT|DELETE)/u.test(sql))).toBe(false);
    calls.length = 0;
    await expect(applyRetainedEventLedgerPositions(storage, { ...proof, eventIds: ["wrong"] })).rejects.toThrow();
    expect(calls.some(sql => sql.includes("schema_version"))).toBe(false);
  }
});
