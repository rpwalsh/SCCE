// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
import { canonicalStringify, createHasher, hashEvent, toJsonValue, type EventChainVerification,
  type EventLedgerGovernanceObservation, type JsonValue, type ScceEvent } from "@scce/kernel";
import { ledgerEventCount, ledgerLink, ledgerPosition, readPositionedLedgerHead, type LedgerQuery,
  type PositionedEventLedgerHead } from "./event-ledger-position.js";

export interface PositionedGovernanceEventRow {
  id: string; episode_id: string; type_id: string; t: string | number; payload_json: JsonValue;
  parents: string[]; hash: string; ledger_hash: string; ledger_position?: string | number | null;
}
type Header = Omit<PositionedGovernanceEventRow, "payload_json"> & { payload_stored_bytes?: string | number };
type ParentHeader = Pick<Header, "id" | "hash" | "ledger_position">;
type Store = { query: LedgerQuery; table(name: string): string };
const HEADER_COLUMNS = "id, episode_id, type_id, t, parents, hash, ledger_hash, ledger_position, pg_column_size(payload_json) AS payload_stored_bytes";
const ascending = (a: Header, b: Header) => ledgerPosition(a.ledger_position) < ledgerPosition(b.ledger_position) ? -1 : ledgerPosition(a.ledger_position) > ledgerPosition(b.ledger_position) ? 1 : 0;
const event = (row: PositionedGovernanceEventRow) => ({ id: row.id, episodeId: row.episode_id, typeId: row.type_id,
  t: Number(row.t), payload: row.payload_json, parents: row.parents, hash: row.hash }) as ScceEvent;
const emptyVerification = (rows: readonly Header[]): EventChainVerification => ({ ok: true, events: rows.length,
  firstEventId: rows[0]?.id as never, lastEventId: rows.at(-1)?.id as never, brokenHashes: [], missingParents: [], timeViolations: [], typeHistogram: {} });

function verifyEvent(row: PositionedGovernanceEventRow, parents: ReadonlyMap<string, ParentHeader>, result: EventChainVerification): void {
  result.typeHistogram[row.type_id] = (result.typeHistogram[row.type_id] ?? 0) + 1;
  for (const id of row.parents) {
    const parent = parents.get(id);
    if (!parent || ledgerPosition(parent.ledger_position) >= ledgerPosition(row.ledger_position)) result.missingParents.push({ eventId: row.id as never, parentId: id as never });
  }
  const expected = hashEvent(event(row), row.parents.map(id => parents.get(id)?.hash ?? ""), createHasher());
  if (expected !== row.hash) result.brokenHashes.push({ eventId: row.id as never, expected, observed: row.hash });
  result.ok = result.brokenHashes.length === 0 && result.missingParents.length === 0;
}

function verifyRolling(rows: readonly Header[], previousHash: string, previousPosition: bigint) {
  const brokenLedgerHashes: Array<{ eventId: string; expected: string; observed: string }> = [];
  const brokenPositions: Array<{ eventId: string; expected: string; observed: string }> = [];
  for (const row of rows) {
    const position = ledgerPosition(row.ledger_position), expectedPosition = previousPosition + 1n;
    if (position !== expectedPosition) brokenPositions.push({ eventId: row.id, expected: expectedPosition.toString(), observed: position.toString() });
    const expected = ledgerLink(previousHash, row.hash);
    if (row.ledger_hash !== expected) brokenLedgerHashes.push({ eventId: row.id, expected, observed: row.ledger_hash });
    previousHash = row.ledger_hash; previousPosition = position;
  }
  return { brokenLedgerHashes, brokenPositions };
}

function matchesHead(row: Header | undefined, head: PositionedEventLedgerHead): boolean {
  return !!row && row.id === head.eventId && row.hash === head.eventHash && row.ledger_hash === head.ledgerHash
    && ledgerPosition(row.ledger_position).toString() === head.ledgerPosition;
}

async function snapshotHead(storage: Store): Promise<PositionedEventLedgerHead | undefined> {
  return readPositionedLedgerHead(storage.query.bind(storage), storage.table("events"), storage.table("storage_meta"));
}

async function verifyPayloadPages(storage: Store, headers: readonly Header[], boundary: readonly Header[] = []): Promise<EventChainVerification> {
  const byId = new Map<string, ParentHeader>([...boundary, ...headers].map(row => [row.id, row]));
  if (new Set(headers.map(row => row.id)).size !== headers.length) throw Error("duplicate governance event header");
  const externalIds = [...new Set(headers.flatMap(row => row.parents).filter(id => !byId.has(id)))];
  for (let offset = 0; offset < externalIds.length; offset += 512) {
    const rows = await storage.query<ParentHeader>(`SELECT id, hash, ledger_position FROM ${storage.table("events")} WHERE id=ANY($1::text[])`, [externalIds.slice(offset, offset + 512)]);
    for (const row of rows) byId.set(row.id, row);
  }
  const result = emptyVerification(headers);
  for (let offset = 0; offset < headers.length;) {
    let end = offset, bytes = 0;
    while (end < headers.length && end - offset < 64) {
      const size = Math.max(0, Number(headers[end]!.payload_stored_bytes ?? 0));
      if (end > offset && bytes + size > 2 * 1024 * 1024) break;
      bytes += size; end++;
    }
    const page = headers.slice(offset, end);
    const rows = await storage.query<PositionedGovernanceEventRow>(`SELECT id, episode_id, type_id, t, payload_json, parents, hash, ledger_hash, ledger_position FROM ${storage.table("events")} WHERE id=ANY($1::text[])`, [page.map(row => row.id)]);
    const bodies = new Map(rows.map(row => [row.id, row]));
    if (rows.length !== page.length || bodies.size !== page.length) throw Error("governance payload page has incomplete or duplicate coverage");
    for (const header of page) {
      const row = bodies.get(header.id);
      if (!row || row.episode_id !== header.episode_id || row.type_id !== header.type_id || Number(row.t) !== Number(header.t)
        || row.hash !== header.hash || row.ledger_hash !== header.ledger_hash || ledgerPosition(row.ledger_position) !== ledgerPosition(header.ledger_position)
        || canonicalStringify(row.parents) !== canonicalStringify(header.parents)) throw Error("governance event changed between header and payload reads");
      verifyEvent(row, byId, result);
      await new Promise<void>(resolve => setImmediate(resolve));
    }
    offset = end;
  }
  return result;
}

function observation(rows: readonly Header[], head: PositionedEventLedgerHead, chain: EventChainVerification,
  rolling: ReturnType<typeof verifyRolling>, mode: string, extra: Record<string, JsonValue> = {}): EventLedgerGovernanceObservation {
  const endpointMatches = matchesHead(rows.at(-1), head), positionsValid = !rolling.brokenPositions.length;
  const passed = chain.ok && !rolling.brokenLedgerHashes.length && positionsValid && endpointMatches;
  return { available: true, passed, reason: passed ? mode === "incremental_suffix" ? "verified_incremental" : mode === "full_scan" ? "verified" : "verified_bounded_window"
    : !positionsValid ? "event_append_position_invalid" : !chain.ok ? "event_hash_chain_invalid" : !endpointMatches ? "canonical_event_head_mismatch" : "postgres_ledger_hash_chain_invalid",
    events: ledgerEventCount(ledgerPosition(head.ledgerPosition)), latestLedgerHash: head.ledgerHash,
    evidence: toJsonValue({ mode, ledgerPosition: head.ledgerPosition, ordering: "ledger_position_ascending", timestampSemantics: "immutable_event_data",
      eventChain: chain, endpointMatches, brokenPositions: rolling.brokenPositions.slice(0, 32), brokenLedgerHashes: rolling.brokenLedgerHashes.slice(0, 32), ...extra }) };
}

/** Live verification never reconstructs append order or scans history. Every call ends at a captured canonical head. */
export function createPositionedEventLedgerObserver(storage: Store, windowSize: number): () => Promise<EventLedgerGovernanceObservation> {
  let checkpoint: PositionedEventLedgerHead | undefined;
  return async () => {
    try {
      const head = await snapshotHead(storage);
      if (!head) return { available: true, passed: false, reason: "event_ledger_empty", events: 0, evidence: toJsonValue({ mode: "bounded_first_scan" }) };
      let rows: Header[], boundary: Header[] = [], previousHash = "", previousPosition = 0n, mode = "bounded_first_scan";
      if (checkpoint) {
        if (ledgerPosition(head.ledgerPosition) < ledgerPosition(checkpoint.ledgerPosition)) throw Error("canonical event ledger head moved behind its verified checkpoint");
        const anchors = await storage.query<Header>(`SELECT id, hash, ledger_hash, ledger_position FROM ${storage.table("events")} WHERE id = $1`, [checkpoint.eventId]);
        if (!matchesHead(anchors[0], checkpoint)) {
          checkpoint = undefined;
          return { available: true, passed: false, reason: "checkpoint_anchor_mutated_or_missing", events: 0, evidence: toJsonValue({ mode: "incremental_suffix" }) };
        }
        mode = "incremental_suffix"; previousHash = checkpoint.ledgerHash; previousPosition = ledgerPosition(checkpoint.ledgerPosition);
        rows = await storage.query<Header>(`SELECT ${HEADER_COLUMNS} FROM ${storage.table("events")} WHERE ledger_position > $1::bigint AND ledger_position <= $2::bigint ORDER BY ledger_position ASC`, [checkpoint.ledgerPosition, head.ledgerPosition]);
        boundary = anchors;
        if (!rows.length && head.ledgerPosition === checkpoint.ledgerPosition) {
          if (!matchesHead(anchors[0], head)) throw Error("canonical event head differs from its checkpoint");
          return { available: true, passed: true, reason: "verified_incremental", events: ledgerEventCount(ledgerPosition(head.ledgerPosition)), latestLedgerHash: head.ledgerHash,
            evidence: toJsonValue({ mode, ledgerPosition: head.ledgerPosition, suffixEvents: 0 }) };
        }
      } else {
        const tail = await storage.query<Header>(`SELECT ${HEADER_COLUMNS} FROM ${storage.table("events")} WHERE ledger_position <= $1::bigint ORDER BY ledger_position DESC LIMIT ${windowSize + 1}`, [head.ledgerPosition]);
        rows = [...tail].sort(ascending);
        if (rows.length > windowSize) { boundary = [rows.shift()!]; previousHash = boundary[0]!.ledger_hash; previousPosition = ledgerPosition(boundary[0]!.ledger_position); }
      }
      const chain = await verifyPayloadPages(storage, rows, boundary), rolling = verifyRolling(rows, previousHash, previousPosition);
      const result = observation(rows, head, chain, rolling, mode, { windowEvents: rows.length, suffixEvents: mode === "incremental_suffix" ? rows.length : 0,
        unverifiedOlderEvents: (ledgerPosition(head.ledgerPosition) - BigInt(rows.length)).toString(), wholeHistoryAssurance: "scce db audit" });
      checkpoint = result.passed ? head : undefined;
      return result;
    } catch (error) {
      checkpoint = undefined;
      return { available: false, passed: false, reason: "event_ledger_probe_failed", events: 0,
        evidence: toJsonValue({ error: error instanceof Error ? error.message : String(error), appendOrderReconstruction: false }) };
    }
  };
}

export async function fullyVerifyPositionedEventLedger(storage: Store): Promise<EventLedgerGovernanceObservation> {
  const head = await snapshotHead(storage);
  if (!head) return { available: true, passed: false, reason: "event_ledger_empty", events: 0, evidence: {} };
  const rows = await storage.query<Header>(`SELECT ${HEADER_COLUMNS} FROM ${storage.table("events")} WHERE ledger_position <= $1::bigint ORDER BY ledger_position ASC`, [head.ledgerPosition]);
  return observation(rows, head, await verifyPayloadPages(storage, rows), verifyRolling(rows, "", 0n), "full_scan");
}

export function verifyPositionedEventLedgerRows(rows: readonly PositionedGovernanceEventRow[]): EventLedgerGovernanceObservation {
  if (!rows.length) return { available: true, passed: false, reason: "event_ledger_empty", events: 0, evidence: {} };
  const parents = new Map(rows.map(row => [row.id, row])), chain = emptyVerification(rows);
  for (const row of rows) verifyEvent(row, parents, chain);
  const last = rows.at(-1)!;
  return observation(rows, { eventId: last.id, eventHash: last.hash, ledgerHash: last.ledger_hash, ledgerPosition: ledgerPosition(last.ledger_position).toString() }, chain, verifyRolling(rows, "", 0n), "full_scan");
}
