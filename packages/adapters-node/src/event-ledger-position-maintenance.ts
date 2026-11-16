// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
import { createHash } from "node:crypto";
import { canonicalStringify, POSTGRES_REQUIRED_TABLES, POSTGRES_SCHEMA_VERSION } from "@scce/kernel";
import { EVENT_LEDGER_HEAD_KEY, ledgerPosition, qualifyRetainedLedgerPositions, type LedgerPositionHeader, type LedgerQuery, type RetainedLedgerOrderProof } from "./event-ledger-position.js";
import { requiredSchemaErrors, schemaStatements } from "./postgres-schema.js";
import type { PostgresStorageAdapter } from "./postgres.js";

/** Select only the three additive event-position clauses from the production schema. */
export function retainedEventPositionSchemaStatements(schema: string): string[] {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/u.test(schema)) throw Error("unsafe retained event schema identifier");
  const q = `"${schema}"`;
  const expected = [
    `ALTER TABLE ${q}.events ADD COLUMN IF NOT EXISTS ledger_position BIGINT CHECK (ledger_position > 0)`,
    `CREATE UNIQUE INDEX IF NOT EXISTS idx_${schema}_event_ledger_position ON ${q}.events(ledger_position)`,
    `CREATE INDEX IF NOT EXISTS idx_${schema}_event_unpositioned ON ${q}.events(id) WHERE ledger_position IS NULL`
  ];
  const selected = schemaStatements(q).filter(sql => expected.includes(sql));
  if (selected.length !== 3 || selected.some((sql, index) => sql !== expected[index])) throw Error("event-position schema clauses do not match the reviewed additive contract");
  return selected;
}

async function verifyPositionSchema(query: LedgerQuery, schema: string) {
  const [column] = await query<{ bigint: boolean; nonnull: boolean }>(`SELECT a.atttypid='int8'::regtype AS bigint,a.attnotnull AS nonnull
    FROM pg_attribute a JOIN pg_class t ON t.oid=a.attrelid JOIN pg_namespace n ON n.oid=t.relnamespace
    WHERE n.nspname=$1 AND t.relname='events' AND a.attname='ledger_position' AND NOT a.attisdropped`, [schema]);
  if (!column?.bigint || !column.nonnull) throw Error("event ledger position must be BIGINT NOT NULL");
  const indexes = await query<{ name: string; unique: boolean; valid: boolean; ready: boolean; columns: string[]; predicate: string | null }>(`SELECT index.relname AS name,i.indisunique AS unique,i.indisvalid AS valid,i.indisready AS ready,
    ARRAY(SELECT a.attname::text FROM unnest(i.indkey) WITH ORDINALITY key(attnum,ordinality)
      JOIN pg_attribute a ON a.attrelid=t.oid AND a.attnum=key.attnum ORDER BY key.ordinality) AS columns,
    pg_get_expr(i.indpred,i.indrelid) AS predicate
    FROM pg_index i JOIN pg_class index ON index.oid=i.indexrelid JOIN pg_class t ON t.oid=i.indrelid
    JOIN pg_namespace n ON n.oid=t.relnamespace WHERE n.nspname=$1 AND t.relname='events'`, [schema]);
  // The reviewed schema restricts names to ASCII; PostgreSQL stores at most 63 identifier bytes.
  const position = indexes.find(index => index.name === `idx_${schema}_event_ledger_position`.slice(0, 63));
  const pending = indexes.find(index => index.name === `idx_${schema}_event_unpositioned`.slice(0, 63));
  if (!position?.valid || !position.ready || !position.unique || position.predicate !== null || canonicalStringify(position.columns) !== '["ledger_position"]'
    || !pending?.valid || !pending.ready || canonicalStringify(pending.columns) !== '["id"]' || pending.predicate?.replace(/[()\s"]/gu, "").toLowerCase() !== "ledger_positionisnull") {
    throw Error("event ledger position indexes do not match the required usable indexed contract");
  }
}

async function qualification(storage: Pick<PostgresStorageAdapter, "schema" | "table">, query: LedgerQuery, proof: RetainedLedgerOrderProof) {
  const [column] = await query<{ present: boolean }>(`SELECT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema=$1 AND table_name='events' AND column_name='ledger_position') AS present`, [storage.schema]);
  const rows = await query<LedgerPositionHeader>(`SELECT id, hash, ledger_hash, ${column?.present ? "ledger_position" : "NULL::bigint AS ledger_position"} FROM ${storage.table("events")}`);
  const [metadata] = await query<{ value_json: { eventId: string; eventHash: string; ledgerHash: string; ledgerPosition?: string } }>(`SELECT value_json FROM ${storage.table("storage_meta")} WHERE key=$1`, [EVENT_LEDGER_HEAD_KEY]);
  if (!metadata?.value_json) throw Error("retained event position maintenance requires its exact canonical head");
  const positions = qualifyRetainedLedgerPositions(rows, proof, metadata.value_json);
  if (metadata.value_json.ledgerPosition !== undefined && ledgerPosition(metadata.value_json.ledgerPosition) !== BigInt(positions.length)) throw Error("canonical head already has a conflicting append position");
  return { columnPresent: column?.present === true, unpositioned: rows.filter(row => row.ledger_position === null || row.ledger_position === undefined).length, positions, head: metadata.value_json,
    orderSha256: createHash("sha256").update(canonicalStringify(positions)).digest("hex") };
}

/** Read-only plan: the receipt's order has no authority until every stored rolling link and head qualifies. */
export async function planRetainedEventLedgerPositions(storage: Pick<PostgresStorageAdapter, "schema" | "table" | "query">, proof: RetainedLedgerOrderProof) {
  const result = await qualification(storage, storage.query.bind(storage), proof);
  return { schema: "scce.retained_event_position_plan.v1", mode: "read_only", events: result.positions.length,
    columnPresent: result.columnPresent, orderSha256: result.orderSha256, snapshotHead: result.head,
    finalLedgerPosition: String(result.positions.length), immutableEventWrites: 0, positionWrites: 0 };
}

/** Explicit maintenance only. No runtime or migration invokes this, and it never discovers an ordering. */
export async function applyRetainedEventLedgerPositions(storage: PostgresStorageAdapter, proof: RetainedLedgerOrderProof) {
  return storage.tx(async client => {
    const query: LedgerQuery = async <T>(sql: string, params: unknown[] = []) => (await client.query(sql, params)).rows as T[];
    const events = storage.table("events"), metadata = storage.table("storage_meta");
    await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [`${events}:ledger_append`]);
    await client.query(`LOCK TABLE ${events} IN ACCESS EXCLUSIVE MODE`);
    const qualified = await qualification(storage, query, proof);
    const [versionRow] = await query<{ value_json: { version?: unknown } }>(`SELECT value_json FROM ${metadata} WHERE key='schema_version' FOR UPDATE`);
    const previousSchemaVersion = versionRow?.value_json?.version;
    if (POSTGRES_SCHEMA_VERSION !== 42 || (previousSchemaVersion !== 41 && previousSchemaVersion !== 42)) throw Error("retained event position maintenance requires schema version 41 or 42 and the reviewed version-42 source contract");
    const baselineErrors = await requiredSchemaErrors(client, storage.schema, { allowAbsentLedgerPosition: true });
    if (baselineErrors.length) throw Error(`retained event position baseline schema is incomplete: ${baselineErrors.slice(0, 12).join("; ")}`);
    const fingerprint = async () => (await query<{ digest: string }>(`SELECT md5(string_agg(md5((to_jsonb(event)-'ledger_position')::text),E'\\n' ORDER BY id)) AS digest FROM ${events} event`))[0]!.digest;
    const immutableBefore = await fingerprint();
    const ddl = retainedEventPositionSchemaStatements(storage.schema);
    for (const statement of ddl) await client.query(statement);
    // PostgreSQL DDL is transactional. The table lock prevents readers/writers from observing the temporary
    // trigger state, and any failure rolls the trigger and every metadata change back together.
    const needsPositions = qualified.unpositioned > 0;
    if (needsPositions) await client.query(`ALTER TABLE ${events} DISABLE TRIGGER events_immutable`);
    let assigned = 0;
    for (let offset = 0; offset < qualified.positions.length; offset += 512) {
      const rows = await query<{ id: string }>(`UPDATE ${events} event SET ledger_position=input.ledger_position
        FROM jsonb_to_recordset($1::jsonb) AS input(id text,ledger_position bigint)
        WHERE event.id=input.id AND event.ledger_position IS NULL RETURNING event.id`, [JSON.stringify(qualified.positions.slice(offset, offset + 512))]);
      assigned += rows.length;
    }
    if (needsPositions) await client.query(`ALTER TABLE ${events} ENABLE TRIGGER events_immutable`);
    const immutableAfter = await fingerprint();
    if (immutableBefore !== immutableAfter) throw Error("event position maintenance changed immutable event content");
    const positioned = await qualification(storage, query, proof);
    if (positioned.positions.length !== qualified.positions.length || positioned.orderSha256 !== qualified.orderSha256) throw Error("event position backfill changed its qualified order");
    await client.query(`ALTER TABLE ${events} ALTER COLUMN ledger_position SET NOT NULL`);
    await verifyPositionSchema(query, storage.schema);
    const head = { ...qualified.head, ledgerPosition: String(qualified.positions.length) };
    if (qualified.head.ledgerPosition !== head.ledgerPosition) {
      const changed = await query<{ key: string }>(`UPDATE ${metadata} SET value_json=$2::jsonb,updated_at=NOW() WHERE key=$1 AND value_json=$3::jsonb RETURNING key`,
        [EVENT_LEDGER_HEAD_KEY, JSON.stringify(head), JSON.stringify(qualified.head)]);
      if (changed.length !== 1) throw Error("canonical event head changed during position maintenance");
    }
    const schemaErrors = await requiredSchemaErrors(client, storage.schema);
    if (schemaErrors.length) throw Error(`event position upgrade schema is incomplete: ${schemaErrors.slice(0, 12).join("; ")}`);
    if (previousSchemaVersion !== POSTGRES_SCHEMA_VERSION) await client.query(`UPDATE ${metadata} SET value_json=$1::jsonb,updated_at=NOW() WHERE key='schema_version'`,
      [JSON.stringify({ version: POSTGRES_SCHEMA_VERSION, requiredTables: POSTGRES_REQUIRED_TABLES })]);
    return { schema: "scce.retained_event_position_backfill.v1", mode: "explicit_maintenance", events: qualified.positions.length,
      assignedPositions: assigned, orderSha256: qualified.orderSha256, immutableBefore, immutableAfter, immutableContentPreserved: true,
      canonicalHead: head, previousSchemaVersion, schemaVersion: POSTGRES_SCHEMA_VERSION, additiveSchemaStatements: ddl.length, sourceOrNgramWrites: 0 };
  });
}
