// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
import { createHash, randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdir, readFile, rename, stat, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { canonicalStringify } from "@scce/kernel";

const MANIFEST_SCHEMA_VERSION = 1 as const;
const FILE_CACHE_SCHEMA_VERSION = 1 as const;
const DEFAULT_CHUNK_SIZE = 1024 * 1024;
const MAX_CHUNK_SIZE = 64 * 1024 * 1024;
const HASH_PATTERN = /^[0-9a-f]{64}$/u;
const CREDENTIAL_KEY = /(?:^|_)(?:password|passwd|secret|token|api_key|credential|authorization|private_key|access_key)(?:$|_)/u;

export interface WikipediaInputFileStat {
  readonly size: string;
  readonly mtimeNs: string;
  readonly ctimeNs: string;
  readonly dev: string;
  readonly ino: string;
}

export interface WikipediaInputSourceFile {
  readonly path: string;
  readonly sha256: `sha256:${string}`;
  readonly byteLength: number;
  readonly stat: WikipediaInputFileStat;
}

export interface WikipediaInputManifest {
  readonly schemaVersion: typeof MANIFEST_SCHEMA_VERSION;
  readonly kind: "wikipedia-input-manifest";
  readonly identity: `sha256:${string}`;
  readonly inputs: {
    readonly dump: WikipediaInputSourceFile;
    readonly index?: WikipediaInputSourceFile;
  };
  readonly semantics: {
    readonly normalizationIdentity: string;
    readonly compilerIdentity: string;
    readonly config: unknown;
  };
}

export interface WikipediaInputManifestOptions {
  readonly dumpPath: string;
  readonly indexPath?: string;
  readonly cacheDir: string;
  readonly normalizationIdentity: string;
  readonly compilerIdentity: string;
  /** The caller supplies only semantic inputs. Scheduling caps and timestamps are intentionally not accepted here. */
  readonly semanticConfig: unknown;
  readonly chunkSize?: number;
  readonly hashFile?: WikipediaInputHasher;
}

export type WikipediaInputHasher = (filePath: string, chunkSize: number) => Promise<{
  readonly sha256: string;
  readonly byteLength: number;
}>;

interface CachedFileHash {
  readonly schemaVersion: typeof FILE_CACHE_SCHEMA_VERSION;
  readonly kind: "wikipedia-input-file-hash";
  readonly path: string;
  readonly stat: WikipediaInputFileStat;
  readonly sha256: string;
  readonly byteLength: number;
}

/** Hash a source with a bounded read stream. The full file is never buffered. */
export async function hashWikipediaInputFile(filePath: string, options: { readonly chunkSize?: number } = {}): Promise<{ sha256: string; byteLength: number }> {
  const chunkSize = normalizeChunkSize(options.chunkSize);
  const hash = createHash("sha256");
  let byteLength = 0;
  const stream = createReadStream(filePath, { highWaterMark: chunkSize });
  for await (const chunk of stream) {
    hash.update(chunk as Buffer);
    byteLength += (chunk as Buffer).byteLength;
  }
  return { sha256: hash.digest("hex"), byteLength };
}

/**
 * Build a reproducible input identity for a dump and, when present, its matching index.
 * Path and stat values are retained for provenance and source-change checks, but are not
 * part of `identity`, so moving an unchanged corpus does not create a different corpus identity.
 */
export async function createWikipediaInputManifest(options: WikipediaInputManifestOptions): Promise<WikipediaInputManifest> {
  const dumpPath = resolveRequiredPath(options.dumpPath, "dumpPath");
  const indexPath = resolveOptionalPath(options.indexPath);
  const cacheDir = path.resolve(options.cacheDir);
  const chunkSize = normalizeChunkSize(options.chunkSize);
  const hashFile = options.hashFile ?? ((filePath, requestedChunkSize) => hashWikipediaInputFile(filePath, { chunkSize: requestedChunkSize }));

  await mkdir(cacheDir, { recursive: true });
  const dump = await resolveSourceFile(dumpPath, cacheDir, chunkSize, hashFile);
  const index = indexPath === undefined ? undefined : await resolveSourceFile(indexPath, cacheDir, chunkSize, hashFile);
  const semantics = {
    normalizationIdentity: options.normalizationIdentity,
    compilerIdentity: options.compilerIdentity,
    config: sanitizeSemanticConfig(options.semanticConfig)
  } as const;
  const identityPayload = {
    schemaVersion: MANIFEST_SCHEMA_VERSION,
    kind: "wikipedia-input-manifest" as const,
    inputs: {
      dump: { sha256: dump.sha256, byteLength: dump.byteLength },
      ...(index === undefined ? {} : { index: { sha256: index.sha256, byteLength: index.byteLength } })
    },
    semantics
  };
  const identity = `sha256:${createHash("sha256").update(canonicalStringify(identityPayload), "utf8").digest("hex")}` as `sha256:${string}`;
  return deepFreeze({
    schemaVersion: MANIFEST_SCHEMA_VERSION,
    kind: "wikipedia-input-manifest",
    identity,
    inputs: { dump, ...(index === undefined ? {} : { index }) },
    semantics
  });
}

/** Check source metadata only; this deliberately performs no content hashing. */
export async function wikipediaInputSourcesStillMatch(manifest: WikipediaInputManifest): Promise<boolean> {
  const files = [manifest.inputs.dump, ...(manifest.inputs.index === undefined ? [] : [manifest.inputs.index])];
  for (const source of files) {
    try {
      if (!sameStat(source.stat, await readFileStat(source.path))) return false;
    } catch {
      return false;
    }
  }
  return true;
}

async function resolveSourceFile(filePath: string, cacheDir: string, chunkSize: number, hashFile: WikipediaInputHasher): Promise<WikipediaInputSourceFile> {
  let before = await readFileStat(filePath);
  const cachePath = fileHashCachePath(cacheDir, filePath, before);
  const cached = await readCachedFileHash(cachePath, filePath, before);
  if (cached !== undefined) return {
    path: filePath,
    sha256: `sha256:${cached.sha256}`,
    byteLength: cached.byteLength,
    stat: before
  };

  // A source can be replaced or written while a multi-gigabyte hash is in flight. Retry once,
  // but never publish a hash whose surrounding stat signatures disagree.
  for (let attempt = 0; attempt < 2; attempt++) {
    const result = await hashFile(filePath, chunkSize);
    const after = await readFileStat(filePath);
    if (sameStat(before, after) && Number.isSafeInteger(result.byteLength) && result.byteLength >= 0 && BigInt(result.byteLength) === BigInt(before.size)) {
      if (!HASH_PATTERN.test(result.sha256)) throw new Error(`Wikipedia input has an invalid SHA-256 result: ${filePath}`);
      const cacheEntry: CachedFileHash = {
        schemaVersion: FILE_CACHE_SCHEMA_VERSION,
        kind: "wikipedia-input-file-hash",
        path: filePath,
        stat: before,
        sha256: result.sha256,
        byteLength: result.byteLength
      };
      await writeCachedFileHash(cachePath, cacheEntry);
      return { path: filePath, sha256: `sha256:${result.sha256}`, byteLength: result.byteLength, stat: before };
    }
    before = after;
  }
  throw new Error(`Wikipedia input changed while hashing: ${filePath}`);
}

async function readFileStat(filePath: string): Promise<WikipediaInputFileStat> {
  const info = await stat(filePath, { bigint: true });
  if (!info.isFile()) throw new Error(`Wikipedia input is not a regular file: ${filePath}`);
  return {
    size: info.size.toString(),
    mtimeNs: info.mtimeNs.toString(),
    ctimeNs: info.ctimeNs.toString(),
    dev: info.dev.toString(),
    ino: info.ino.toString()
  };
}

function sameStat(left: WikipediaInputFileStat, right: WikipediaInputFileStat): boolean {
  return left.size === right.size && left.mtimeNs === right.mtimeNs && left.ctimeNs === right.ctimeNs && left.dev === right.dev && left.ino === right.ino;
}

async function readCachedFileHash(cachePath: string, filePath: string, sourceStat: WikipediaInputFileStat): Promise<CachedFileHash | undefined> {
  try {
    const parsed: unknown = JSON.parse(await readFile(cachePath, "utf8"));
    if (!isCachedFileHash(parsed) || parsed.path !== filePath || !sameStat(parsed.stat, sourceStat)) return undefined;
    return parsed;
  } catch {
    // Missing, unreadable, truncated, and malformed cache entries are all safe cache misses.
    return undefined;
  }
}

async function writeCachedFileHash(cachePath: string, entry: CachedFileHash): Promise<void> {
  const temporaryPath = `${cachePath}.${process.pid}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporaryPath, `${canonicalStringify(entry)}\n`, { encoding: "utf8", flag: "wx" });
    try {
      await rename(temporaryPath, cachePath);
    } catch (error) {
      // Concurrent writers may have already installed this exact key. Keep their valid entry;
      // replace only an invalid one so malformed cache data can never block recovery.
      const existing = await readCachedFileHash(cachePath, entry.path, entry.stat);
      if (existing === undefined) {
        await unlink(cachePath).catch(() => undefined);
        await rename(temporaryPath, cachePath);
      }
    }
  } finally {
    await unlink(temporaryPath).catch(() => undefined);
  }
}

function fileHashCachePath(cacheDir: string, filePath: string, sourceStat: WikipediaInputFileStat): string {
  const key = canonicalStringify({ schemaVersion: FILE_CACHE_SCHEMA_VERSION, path: filePath, stat: sourceStat });
  const digest = createHash("sha256").update(key, "utf8").digest("hex");
  return path.join(cacheDir, `wikipedia-input-file-${digest}.json`);
}

function isCachedFileHash(value: unknown): value is CachedFileHash {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Record<string, unknown>;
  const sourceStat = candidate.stat;
  if (typeof sourceStat !== "object" || sourceStat === null) return false;
  const statRecord = sourceStat as Record<string, unknown>;
  return candidate.schemaVersion === FILE_CACHE_SCHEMA_VERSION
    && candidate.kind === "wikipedia-input-file-hash"
    && typeof candidate.path === "string"
    && typeof candidate.sha256 === "string" && HASH_PATTERN.test(candidate.sha256)
    && typeof candidate.byteLength === "number" && Number.isSafeInteger(candidate.byteLength) && candidate.byteLength >= 0
    && ["size", "mtimeNs", "ctimeNs", "dev", "ino"].every(key => typeof statRecord[key] === "string");
}

function sanitizeSemanticConfig(value: unknown): unknown {
  return sanitize(value, new WeakSet<object>());
}

function sanitize(value: unknown, seen: WeakSet<object>): unknown {
  if (value === null || typeof value === "string" || typeof value === "boolean" || typeof value === "number") return value;
  if (typeof value === "bigint") return value.toString();
  if (value instanceof Date) return value.toISOString();
  if (value instanceof Uint8Array) return Array.from(value);
  if (Array.isArray(value)) return value.map(item => sanitize(item, seen));
  if (typeof value === "object") {
    if (seen.has(value)) throw new Error("Wikipedia semantic config cannot contain cycles");
    seen.add(value);
    const output: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      const normalizedKey = key.replace(/([a-z])([A-Z])/gu, "$1_$2").toLowerCase();
      if (CREDENTIAL_KEY.test(normalizedKey)) continue;
      output[key] = sanitize((value as Record<string, unknown>)[key], seen);
    }
    seen.delete(value);
    return output;
  }
  return String(value);
}

function deepFreeze<T>(value: T): T {
  if (typeof value === "object" && value !== null && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
  }
  return value;
}

function normalizeChunkSize(value: number | undefined): number {
  const chunkSize = value ?? DEFAULT_CHUNK_SIZE;
  if (!Number.isSafeInteger(chunkSize) || chunkSize < 1 || chunkSize > MAX_CHUNK_SIZE) throw new Error(`Wikipedia input hash chunk size must be an integer from 1 to ${MAX_CHUNK_SIZE}`);
  return chunkSize;
}

function resolveRequiredPath(value: string, name: string): string {
  if (typeof value !== "string" || value.trim().length === 0) throw new Error(`Wikipedia input ${name} is required`);
  return path.resolve(value);
}

function resolveOptionalPath(value: string | undefined): string | undefined {
  return value === undefined || value.trim().length === 0 ? undefined : path.resolve(value);
}
