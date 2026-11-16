// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
import { createHash } from "node:crypto";

export const EVENT_LEDGER_HEAD_KEY = "events.ledger_head.v1";
export const EVENT_LEDGER_POSITION_MAX = 9_223_372_036_854_775_807n;
export interface PositionedEventLedgerHead { eventId: string; eventHash: string; ledgerHash: string; ledgerPosition: string }
export type LedgerQuery = <T>(sql: string, params?: unknown[]) => Promise<T[]>;

export function ledgerPosition(value: unknown): bigint {
  const text = typeof value === "bigint" ? value.toString() : typeof value === "number" && Number.isSafeInteger(value) ? String(value) : value;
  if (typeof text !== "string" || text.trim() !== text || !/^[1-9][0-9]*$/u.test(text)) throw Error("event append position is missing or invalid; explicit retained-event position maintenance is required");
  const position = BigInt(text);
  if (position > EVENT_LEDGER_POSITION_MAX) throw Error("event append position exceeds PostgreSQL BIGINT");
  return position;
}

export function ledgerEventCount(position: bigint): number | string {
  return position <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(position) : position.toString();
}

export function positionedLedgerHead(value: unknown): PositionedEventLedgerHead {
  const row = value as Partial<PositionedEventLedgerHead> | undefined;
  if (!row || [row.eventId, row.eventHash, row.ledgerHash].some(item => typeof item !== "string" || !item)) throw Error("invalid canonical event ledger head");
  return { eventId: row.eventId!, eventHash: row.eventHash!, ledgerHash: row.ledgerHash!, ledgerPosition: ledgerPosition(row.ledgerPosition).toString() };
}

export async function readPositionedLedgerHead(query: LedgerQuery, eventsTable: string, metadataTable: string): Promise<PositionedEventLedgerHead | undefined> {
  // One SQL snapshot prevents a legitimate concurrent append from appearing beyond a separately read head.
  const [row] = await query<{ head: unknown; present: boolean; unpositioned: boolean; tail_position: string | null }>(
    `SELECT /* event_ledger_position_snapshot */ (SELECT value_json FROM ${metadataTable} WHERE key=$1) AS head,
      EXISTS (SELECT 1 FROM ${eventsTable}) AS present,
      EXISTS (SELECT 1 FROM ${eventsTable} WHERE ledger_position IS NULL) AS unpositioned,
      (SELECT ledger_position FROM ${eventsTable} WHERE ledger_position IS NOT NULL ORDER BY ledger_position DESC LIMIT 1) AS tail_position`, [EVENT_LEDGER_HEAD_KEY]);
  if (!row) throw Error("event ledger position snapshot is unavailable");
  if (row.unpositioned) throw Error("retained events require explicit append-position maintenance");
  if (!row.present) { if (row.head) throw Error("canonical event head has no event"); return undefined; }
  if (!row.head) throw Error("retained events lack a positioned canonical head; explicit event position maintenance is required");
  const head = positionedLedgerHead(row.head);
  if (ledgerPosition(row.tail_position).toString() !== head.ledgerPosition) throw Error("canonical event head omits positioned events");
  return head;
}

export function ledgerLink(previous: string, eventHash: string): string {
  return createHash("sha256").update(`${previous}\u001f${eventHash}`).digest("hex");
}

export interface LedgerPositionHeader { id: string; hash: string; ledger_hash: string; ledger_position?: string | number | null }
export interface RetainedLedgerOrderProof { schema: string; eventIds: readonly string[]; snapshotHead: { eventId: string; eventHash: string; ledgerHash: string }; appendOrderProven: boolean }

/** The receipt supplies candidate order only. Every row, link and terminal head is independently checked. */
export function qualifyRetainedLedgerPositions(rows: readonly LedgerPositionHeader[], proof: RetainedLedgerOrderProof,
  currentHead: { eventId: string; eventHash: string; ledgerHash: string }): Array<{ id: string; ledger_position: string }> {
  if (proof?.schema !== "scce.ledger_header_order_proof.v1" || proof.appendOrderProven !== true
    || !Array.isArray(proof.eventIds) || !rows.length || rows.length !== proof.eventIds.length) throw Error("retained append-order proof has incomplete row coverage");
  const byId = new Map(rows.map(row => [row.id, row]));
  if (byId.size !== rows.length || new Set(proof.eventIds).size !== rows.length) throw Error("retained append-order proof repeats an event identity");
  let previous = "";
  const positions = proof.eventIds.map((id, index) => {
    const row = byId.get(id), position = BigInt(index) + 1n;
    if (!row || row.ledger_hash !== ledgerLink(previous, row.hash)) throw Error("retained append-order proof has a missing event or broken rolling link");
    if (row.ledger_position !== undefined && row.ledger_position !== null && ledgerPosition(row.ledger_position) !== position) throw Error("retained event already has a conflicting append position");
    previous = row.ledger_hash;
    return { id, ledger_position: position.toString() };
  });
  const last = byId.get(proof.eventIds.at(-1)!)!;
  for (const head of [proof.snapshotHead, currentHead]) if (!head || head.eventId !== last.id || head.eventHash !== last.hash || head.ledgerHash !== previous) throw Error("retained append-order proof differs from the canonical head");
  return positions;
}
