// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.

import sqlite3InitModule, { type Database, type SqlValue } from "@sqlite.org/sqlite-wasm";
import { createPortableCognitiveRuntime, type PortableLearnedSource } from "@scce/kernel/dist/browser-cognitive-runtime.js";

const SCHEMA_VERSION = 2;
const DEFAULT_DATABASE = "/scce/browser-state-v2.sqlite3";
const WRITER_LOCK = "scce.browser-state-v2.writer";

export interface BrowserTaskRecord {
  id: string;
  status: "reserved" | "running" | "succeeded" | "failed" | "cancelled" | "interrupted";
  createdAt: number;
  updatedAt: number;
  latestSequence: number;
  requestText?: string;
  result?: Record<string, unknown>;
  error?: string;
}

export interface BrowserTaskFrame {
  id: string;
  taskId: string;
  sequence: number;
  kind: string;
  phase?: string;
  answer?: string;
  error?: string;
  observedAt: number;
}

export interface DurableOperationReceipt {
  requestId: string;
  payloadDigest: string;
  response: unknown;
}

export interface BrowserStateRepository {
  readonly epoch: string;
  putSource(record: PortableLearnedSource): void;
  loadSources(): PortableLearnedSource[];
  putTask(record: BrowserTaskRecord): void;
  getTask(id: string): BrowserTaskRecord | undefined;
  putFrame(frame: BrowserTaskFrame): void;
  listFrames(taskId: string, afterSequence?: number, limit?: number): BrowserTaskFrame[];
  getReceipt(requestId: string): DurableOperationReceipt | undefined;
  putReceipt(receipt: DurableOperationReceipt): void;
  close(): Promise<void>;
}

interface HeldWriterLock {
  release(): Promise<void>;
}

export async function openBrowserStateRepository(options: { filename?: string } = {}): Promise<BrowserStateRepository> {
  const writerLock = await acquireWriterLock();
  try {
    const sqlite3 = await sqlite3InitModule();
    if (!sqlite3.oo1.OpfsDb || !sqlite3.capi.sqlite3_vfs_find("opfs")) {
      throw new Error("SCCE browser durability requires SQLite OPFS. Serve the workbench with COOP same-origin and COEP require-corp in a browser that supports OPFS.");
    }
    const db = new sqlite3.oo1.OpfsDb(options.filename ?? DEFAULT_DATABASE, "c");
    try {
      initialize(db);
      const epoch = advanceEpoch(db);
      return createRepository(db, epoch, writerLock);
    } catch (error) {
      db.close();
      throw error;
    }
  } catch (error) {
    await writerLock.release();
    throw error;
  }
}

function initialize(db: Database): void {
  db.exec("PRAGMA foreign_keys = ON; PRAGMA synchronous = FULL; PRAGMA journal_mode = DELETE;");
  db.exec(`
    CREATE TABLE IF NOT EXISTS scce_metadata (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    ) STRICT;
    CREATE TABLE IF NOT EXISTS source_versions (
      source_version_id TEXT PRIMARY KEY,
      source_id TEXT NOT NULL,
      canonical_uri TEXT NOT NULL,
      observed_at INTEGER NOT NULL,
      exact_bytes BLOB NOT NULL,
      source_json TEXT NOT NULL,
      evidence_json TEXT NOT NULL,
      language_profile_json TEXT NOT NULL
    ) STRICT;
    CREATE INDEX IF NOT EXISTS source_versions_identity ON source_versions(source_id, source_version_id);
    CREATE TABLE IF NOT EXISTS turn_tasks (
      task_id TEXT PRIMARY KEY,
      status TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      latest_sequence INTEGER NOT NULL,
      task_json TEXT NOT NULL
    ) STRICT;
    CREATE TABLE IF NOT EXISTS turn_frames (
      task_id TEXT NOT NULL REFERENCES turn_tasks(task_id) ON DELETE CASCADE,
      sequence INTEGER NOT NULL,
      frame_json TEXT NOT NULL,
      PRIMARY KEY(task_id, sequence)
    ) STRICT;
    CREATE TABLE IF NOT EXISTS operation_receipts (
      request_id TEXT PRIMARY KEY,
      payload_digest TEXT NOT NULL,
      response_json TEXT NOT NULL
    ) STRICT;
  `);
  const version = db.selectValue("SELECT value FROM scce_metadata WHERE key = 'schema_version'");
  if (version === undefined) {
    db.exec({ sql: "INSERT INTO scce_metadata(key, value) VALUES('schema_version', ?)", bind: [String(SCHEMA_VERSION)] });
  } else if (version !== String(SCHEMA_VERSION)) {
    throw new Error(`Unsupported SCCE browser database schema ${String(version)}`);
  }
}

function advanceEpoch(db: Database): string {
  db.exec("BEGIN IMMEDIATE");
  try {
    const prior = Number(db.selectValue("SELECT value FROM scce_metadata WHERE key = 'epoch_counter'") ?? 0);
    const next = Number.isSafeInteger(prior) && prior >= 0 ? prior + 1 : 1;
    db.exec({
      sql: "INSERT INTO scce_metadata(key, value) VALUES('epoch_counter', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
      bind: [String(next)]
    });
    db.exec("COMMIT");
    return `browser-opfs:${next}`;
  } catch (error) {
    rollback(db);
    throw error;
  }
}

function createRepository(db: Database, epoch: string, writerLock: HeldWriterLock): BrowserStateRepository {
  const cognitive = createPortableCognitiveRuntime();
  let closed = false;
  const affirmOpen = () => {
    if (closed) throw new Error("SCCE browser state repository is closed");
    db.affirmOpen();
  };
  return {
    epoch,
    putSource(record) {
      affirmOpen();
      cognitive.verifySource(record);
      const sourceJson = JSON.stringify(record.source);
      const evidenceJson = JSON.stringify({ ...record.evidence, text: undefined });
      const profileJson = JSON.stringify(record.languageProfile);
      db.exec("BEGIN IMMEDIATE");
      try {
        const existing = db.selectObject("SELECT exact_bytes, source_json, evidence_json, language_profile_json FROM source_versions WHERE source_version_id = ?", [String(record.source.sourceVersionId)]);
        if (existing) {
          const existingBytes = bytes(existing.exact_bytes, "exact source bytes");
          if (!equalBytes(existingBytes, record.sourceBytes)
            || text(existing.source_json, "source JSON") !== sourceJson
            || text(existing.evidence_json, "evidence JSON") !== evidenceJson
            || text(existing.language_profile_json, "language profile JSON") !== profileJson) {
            throw new Error("immutable source-version identity collision");
          }
        } else {
          db.exec({
            sql: `INSERT INTO source_versions(
              source_version_id, source_id, canonical_uri, observed_at, exact_bytes,
              source_json, evidence_json, language_profile_json
            ) VALUES(?, ?, ?, ?, ?, ?, ?, ?)`,
            bind: [
              String(record.source.sourceVersionId), String(record.source.sourceId), record.source.canonicalUri,
              record.source.observedAt, record.sourceBytes, sourceJson, evidenceJson, profileJson
            ]
          });
        }
        db.exec("COMMIT");
      } catch (error) {
        rollback(db);
        throw error;
      }
    },
    loadSources() {
      affirmOpen();
      return db.selectObjects(`SELECT exact_bytes, source_json, evidence_json, language_profile_json
        FROM source_versions ORDER BY source_version_id`).map(row => {
        const sourceBytes = bytes(row.exact_bytes, "exact source bytes").slice();
        const source = JSON.parse(text(row.source_json, "source JSON"));
        const evidenceStored = JSON.parse(text(row.evidence_json, "evidence JSON"));
        const evidence = { ...evidenceStored, text: new TextDecoder("utf-8", { fatal: true }).decode(sourceBytes) };
        const languageProfile = JSON.parse(text(row.language_profile_json, "language profile JSON"));
        const record = { source, sourceBytes, evidence, languageProfile } as PortableLearnedSource;
        cognitive.verifySource(record);
        return record;
      });
    },
    putTask(record) {
      affirmOpen();
      db.exec({
        sql: `INSERT INTO turn_tasks(task_id, status, created_at, updated_at, latest_sequence, task_json)
          VALUES(?, ?, ?, ?, ?, ?)
          ON CONFLICT(task_id) DO UPDATE SET status = excluded.status, updated_at = excluded.updated_at,
            latest_sequence = excluded.latest_sequence, task_json = excluded.task_json`,
        bind: [record.id, record.status, record.createdAt, record.updatedAt, record.latestSequence, JSON.stringify(record)]
      });
    },
    getTask(id) {
      affirmOpen();
      const value = db.selectValue("SELECT task_json FROM turn_tasks WHERE task_id = ?", [id]);
      return value === undefined ? undefined : JSON.parse(text(value, "task JSON")) as BrowserTaskRecord;
    },
    putFrame(frame) {
      affirmOpen();
      db.exec({
        sql: "INSERT INTO turn_frames(task_id, sequence, frame_json) VALUES(?, ?, ?) ON CONFLICT(task_id, sequence) DO NOTHING",
        bind: [frame.taskId, frame.sequence, JSON.stringify(frame)]
      });
    },
    listFrames(taskId, afterSequence = 0, limit = 50) {
      affirmOpen();
      if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new Error("frame page size must be between 1 and 100");
      return db.selectValues(`SELECT frame_json FROM turn_frames WHERE task_id = ? AND sequence > ?
        ORDER BY sequence LIMIT ?`, [taskId, afterSequence, limit]).map(value => JSON.parse(text(value, "frame JSON")) as BrowserTaskFrame);
    },
    getReceipt(requestId) {
      affirmOpen();
      const row = db.selectObject("SELECT payload_digest, response_json FROM operation_receipts WHERE request_id = ?", [requestId]);
      if (!row) return undefined;
      return {
        requestId,
        payloadDigest: text(row.payload_digest, "operation payload digest"),
        response: JSON.parse(text(row.response_json, "operation response JSON"))
      };
    },
    putReceipt(receipt) {
      affirmOpen();
      const responseJson = JSON.stringify(receipt.response);
      db.exec({
        sql: "INSERT INTO operation_receipts(request_id, payload_digest, response_json) VALUES(?, ?, ?)",
        bind: [receipt.requestId, receipt.payloadDigest, responseJson]
      });
    },
    async close() {
      if (closed) return;
      closed = true;
      db.close();
      await writerLock.release();
    }
  };
}

async function acquireWriterLock(): Promise<HeldWriterLock> {
  const manager = navigator.locks;
  if (!manager) throw new Error("SCCE browser durability requires the Web Locks API");
  let releaseHold: (() => void) | undefined;
  let resolveAcquired!: (held: boolean) => void;
  const acquired = new Promise<boolean>(resolve => { resolveAcquired = resolve; });
  const lockRequest = manager.request(WRITER_LOCK, { mode: "exclusive", ifAvailable: true }, lock => {
    if (!lock) { resolveAcquired(false); return; }
    resolveAcquired(true);
    return new Promise<void>(resolve => { releaseHold = resolve; });
  });
  if (!await acquired) {
    await lockRequest;
    throw new Error("Another SCCE browser worker owns the durable writer lock. Close the other workbench tab before continuing.");
  }
  return {
    async release() {
      releaseHold?.();
      releaseHold = undefined;
      await lockRequest;
    }
  };
}

function rollback(db: Database): void {
  try { db.exec("ROLLBACK"); } catch { /* preserve the original failure */ }
}

function bytes(value: SqlValue | undefined, label: string): Uint8Array {
  if (value instanceof Uint8Array) return value;
  throw new Error(`${label} is not a SQLite BLOB`);
}

function text(value: SqlValue | undefined, label: string): string {
  if (typeof value === "string") return value;
  throw new Error(`${label} is not SQLite TEXT`);
}

function equalBytes(left: Uint8Array, right: Uint8Array): boolean {
  if (left.byteLength !== right.byteLength) return false;
  for (let index = 0; index < left.byteLength; index++) if (left[index] !== right[index]) return false;
  return true;
}
