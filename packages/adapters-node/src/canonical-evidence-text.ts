// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
import { createHash } from "node:crypto";
import { canonicalStringify } from "@scce/kernel";
import { readContentAddressedWikipediaArchiveBlob } from "./wikipedia.js";
import type { WikipediaInputFileStat, WikipediaInputSourceFile, WikipediaInputVerificationCache } from "./wikipedia-input-manifest.js";

export interface CanonicalBlobHost {
  table(name: string): string;
  query<T>(sql: string, params?: unknown[]): Promise<T[]>;
}

interface CanonicalBlobRow {
  content: Buffer;
  byte_length: string;
  range_parent_hash: string | null;
  range_start: string | null;
  range_end: string | null;
  archive_reference: { archiveId: string; page: unknown } | null;
  archive: unknown;
}

export const CORPUS_ARCHIVE_KEY_PREFIX = "corpus_archive:";
const CORPUS_ARCHIVE_VERIFICATION_KEY_PREFIX = "corpus_archive_verification:";

interface WikipediaSourceVerificationReceipt {
  schema: "scce.wikipedia_source_verification.v1";
  archiveId: string;
  expectedSha256: string;
  expectedByteLength: number;
  currentStat: WikipediaInputFileStat;
}

function wikipediaSourceVerificationReceipt(archiveId: string, source: WikipediaInputSourceFile,
  currentStat: WikipediaInputFileStat): WikipediaSourceVerificationReceipt {
  return { schema: "scce.wikipedia_source_verification.v1", archiveId, expectedSha256: source.sha256,
    expectedByteLength: source.byteLength, currentStat: structuredClone(currentStat) };
}

function wikipediaSourceVerificationKey(archiveId: string, source: WikipediaInputSourceFile): string {
  const digest = createHash("sha256").update(canonicalStringify({ archiveId, path: source.path,
    expectedSha256: source.sha256, expectedByteLength: source.byteLength }), "utf8").digest("hex");
  return `${CORPUS_ARCHIVE_VERIFICATION_KEY_PREFIX}${digest}`;
}

/** A database-local derived receipt; a miss only causes the pinned source to be hashed again. */
function wikipediaSourceVerificationCache(host: CanonicalBlobHost, archiveId: string): WikipediaInputVerificationCache {
  return {
    async read(source, currentStat) {
      const rows = await host.query<{ value_json: unknown }>(
        `SELECT value_json FROM ${host.table("storage_meta")} WHERE key=$1`,
        [wikipediaSourceVerificationKey(archiveId, source)]
      );
      const stored = rows[0]?.value_json;
      return stored !== undefined && canonicalStringify(stored) === canonicalStringify(
        wikipediaSourceVerificationReceipt(archiveId, source, currentStat));
    },
    async write(source, currentStat) {
      await host.query(
        `INSERT INTO ${host.table("storage_meta")}(key,value_json,updated_at) VALUES($1,$2::jsonb,NOW())
         ON CONFLICT(key) DO UPDATE SET value_json=EXCLUDED.value_json,updated_at=EXCLUDED.updated_at`,
        [wikipediaSourceVerificationKey(archiveId, source), canonicalStringify(
          wikipediaSourceVerificationReceipt(archiveId, source, currentStat))]
      );
    }
  };
}

export function corpusArchiveIdentity(archive: unknown): string {
  return `sha256:${createHash("sha256").update(canonicalStringify(archive)).digest("hex")}`;
}

// Preserve the pinned file objects used by source-stat verification across SQL
// JSON decodes. Only descriptor metadata is retained: at most 16 entries and
// 1 MiB of canonical UTF-8 descriptor/key bytes, with no corpus bodies.
const archiveDescriptors = new Map<string, { archive: unknown; bytes: number }>();
let archiveDescriptorBytes = 0;
function verifiedArchiveDescriptor(archive: unknown, identity: string): unknown {
  const serialized = canonicalStringify(archive);
  if (`sha256:${createHash("sha256").update(serialized).digest("hex")}` !== identity) {
    throw new Error("canonical corpus archive identity mismatch");
  }
  const cached = archiveDescriptors.get(identity);
  if (cached) {
    archiveDescriptors.delete(identity); archiveDescriptors.set(identity, cached);
    return cached.archive;
  }
  const bytes = Buffer.byteLength(serialized, "utf8") + Buffer.byteLength(identity, "utf8");
  if (bytes > 1024 * 1024) return archive;
  while (archiveDescriptors.size && (archiveDescriptors.size >= 16 || archiveDescriptorBytes + bytes > 1024 * 1024)) {
    const oldest = archiveDescriptors.keys().next().value!;
    archiveDescriptorBytes -= archiveDescriptors.get(oldest)!.bytes;
    archiveDescriptors.delete(oldest);
  }
  archiveDescriptors.set(identity, { archive, bytes });
  archiveDescriptorBytes += bytes;
  return archive;
}

/** Blobs may own bytes, refer to a retained source archive, or select a byte range of either. */
export function canonicalBlobSchemaStatements(q: string): string[] {
  return [
    `ALTER TABLE ${q}.blobs ADD COLUMN IF NOT EXISTS range_parent_hash TEXT REFERENCES ${q}.blobs(content_hash),
       ADD COLUMN IF NOT EXISTS range_start BIGINT, ADD COLUMN IF NOT EXISTS range_end BIGINT,
       ADD COLUMN IF NOT EXISTS archive_reference JSONB`,
    // NOT VALID avoids scanning old corpus bodies during startup; PostgreSQL still
    // enforces the representation contract on every new or changed blob row.
    `DO $scce_canonical_blob_shape$ BEGIN
      IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_constraint
        WHERE conrelid='${q}.blobs'::regclass AND conname='scce_canonical_blob_shape') THEN
        ALTER TABLE ${q}.blobs ADD CONSTRAINT scce_canonical_blob_shape CHECK (
          byte_length>=0 AND (
            (range_parent_hash IS NULL AND range_start IS NULL AND range_end IS NULL
              AND archive_reference IS NULL AND octet_length(content)=byte_length)
            OR (range_parent_hash IS NOT NULL AND range_parent_hash<>content_hash
              AND range_start IS NOT NULL AND range_end IS NOT NULL
              AND range_start>=0 AND range_end>=range_start AND range_end-range_start=byte_length
              AND archive_reference IS NULL AND octet_length(content)=0)
            OR (range_parent_hash IS NULL AND range_start IS NULL AND range_end IS NULL
              AND archive_reference IS NOT NULL AND jsonb_typeof(archive_reference)='object'
              AND archive_reference ? 'archiveId' AND jsonb_typeof(archive_reference->'archiveId')='string'
              AND archive_reference ? 'page' AND octet_length(content)=0)
          )
        ) NOT VALID;
      END IF;
    END $scce_canonical_blob_shape$`
  ];
}

/** One operation retains at most 16 MiB/64 verified parent bodies, never a corpus population. */
export function createCanonicalBlobReader(host: CanonicalBlobHost): (hash: string) => Promise<Buffer> {
  const parents = new Map<string, Buffer>();
  let retainedBytes = 0;
  const retainParent = (hash: string, bytes: Buffer) => {
    if (bytes.byteLength > 16 * 1024 * 1024) return;
    const prior = parents.get(hash);
    if (prior) { retainedBytes -= prior.byteLength; parents.delete(hash); }
    while (parents.size && (parents.size >= 64 || retainedBytes + bytes.byteLength > 16 * 1024 * 1024)) {
      const oldest = parents.keys().next().value!;
      retainedBytes -= parents.get(oldest)!.byteLength;
      parents.delete(oldest);
    }
    parents.set(hash, bytes);
    retainedBytes += bytes.byteLength;
  };
  const read = async (hash: string, ancestors: ReadonlySet<string>): Promise<Buffer> => {
    if (!/^sha256_[a-f0-9]{64}$/u.test(hash) || ancestors.has(hash) || ancestors.size > 1) {
      throw new Error("invalid or cyclic canonical blob reference");
    }
    const cached = parents.get(hash);
    if (cached) {
      parents.delete(hash); parents.set(hash, cached);
      return ancestors.size ? cached : Buffer.from(cached);
    }
    const rows = await host.query<CanonicalBlobRow>(`SELECT blob.content,blob.byte_length,
      blob.range_parent_hash,blob.range_start,blob.range_end,blob.archive_reference,archive.value_json AS archive
      FROM ${host.table("blobs")} blob
      LEFT JOIN ${host.table("storage_meta")} archive
        ON archive.key=$2 || (blob.archive_reference->>'archiveId')
      WHERE blob.content_hash=$1`, [hash, CORPUS_ARCHIVE_KEY_PREFIX]);
    const row = rows[0];
    if (!row) throw new Error(`blob not found: ${hash}`);
    const expectedLength = Number(row.byte_length);
    if (!Number.isSafeInteger(expectedLength) || expectedLength < 0) throw new Error("invalid canonical blob length");
    if (!(row.content instanceof Uint8Array)) throw new Error("canonical blob body is missing");
    let bytes: Buffer;
    if (row.range_parent_hash !== null) {
      if (row.archive_reference !== null || row.content.byteLength !== 0) throw new Error("ambiguous canonical blob representation");
      const start = Number(row.range_start), end = Number(row.range_end);
      if (row.range_start === null || row.range_end === null || !Number.isSafeInteger(start) || !Number.isSafeInteger(end)
        || start < 0 || end < start || end - start !== expectedLength) throw new Error("invalid canonical blob range");
      const parent = await read(row.range_parent_hash, new Set([...ancestors, hash]));
      if (end > parent.length) throw new Error("canonical blob range exceeds its source");
      bytes = Buffer.from(parent.subarray(start, end));
    } else if (row.archive_reference !== null) {
      if (row.range_start !== null || row.range_end !== null || row.content.byteLength !== 0) {
        throw new Error("ambiguous canonical archive blob representation");
      }
      if (!row.archive) throw new Error("canonical corpus archive descriptor is missing");
      const archive = verifiedArchiveDescriptor(row.archive, row.archive_reference.archiveId);
      bytes = await readContentAddressedWikipediaArchiveBlob(archive, row.archive_reference.page,
        { contentHash: hash, byteLength: expectedLength },
        { verificationCache: wikipediaSourceVerificationCache(host, row.archive_reference.archiveId) });
    } else {
      if (row.range_start !== null || row.range_end !== null) throw new Error("orphan canonical blob range coordinates");
      bytes = row.content;
    }
    if (bytes.length !== expectedLength || `sha256_${createHash("sha256").update(bytes).digest("hex")}` !== hash) {
      throw new Error(`canonical blob integrity mismatch: ${hash}`);
    }
    if (ancestors.size && row.range_parent_hash === null) retainParent(hash, bytes);
    return bytes;
  };
  return hash => read(hash, new Set());
}

/** The caller selects and authorizes the source/evidence before requesting any bytes. */
export function readCanonicalBlob(host: CanonicalBlobHost, hash: string): Promise<Buffer> {
  return createCanonicalBlobReader(host)(hash);
}
