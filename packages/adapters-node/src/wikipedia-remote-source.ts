// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";

export const REMOTE_WIKIPEDIA_SOURCE_SCHEMA = "scce.wikipedia.remote_multistream.v1" as const;
export interface RemoteWikipediaSource {
  schema: typeof REMOTE_WIKIPEDIA_SOURCE_SCHEMA;
  url: string;
  byteLength: number;
  expectedSha1: string;
  indexSha256: string;
  etag: string;
}

export async function readRemoteWikipediaSource(filePath: string): Promise<{ source: RemoteWikipediaSource; descriptorSha256: string } | undefined> {
  if (!filePath.endsWith(".remote.json")) return undefined;
  const bytes = await readFile(filePath);
  const value: unknown = JSON.parse(bytes.toString("utf8"));
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid remote Wikipedia source descriptor");
  const row = value as Record<string, unknown>;
  if (row.schema !== REMOTE_WIKIPEDIA_SOURCE_SCHEMA || typeof row.url !== "string"
    || !Number.isSafeInteger(row.byteLength) || Number(row.byteLength) <= 0
    || typeof row.expectedSha1 !== "string" || !/^[a-f0-9]{40}$/u.test(row.expectedSha1)
    || typeof row.indexSha256 !== "string" || !/^[a-f0-9]{64}$/u.test(row.indexSha256)
    || typeof row.etag !== "string" || !/^"[^"\r\n]+"$/u.test(row.etag)) throw new Error("Remote Wikipedia source requires length, checksums and a strong ETag");
  const url = new URL(row.url);
  if (url.protocol !== "https:" || url.username || url.password || url.hash) throw new Error("Remote Wikipedia source requires an HTTPS URL without credentials or fragment");
  return { source: { schema: REMOTE_WIKIPEDIA_SOURCE_SCHEMA, url: url.href, byteLength: Number(row.byteLength),
    expectedSha1: row.expectedSha1, indexSha256: row.indexSha256, etag: row.etag },
    descriptorSha256: createHash("sha256").update(bytes).digest("hex") };
}

export function createRemoteWikipediaReader(source: RemoteWikipediaSource, fetchSource: typeof fetch = fetch, options: { resumeOffset?: number; resumeAfterBlock?: boolean; signal?: AbortSignal } = {}) {
  let contiguousEnd = 0;
  let contiguous = true;
  const digest = createHash("sha1");
  let bytesFetched = 0;
  async function readRange(start: number, endExclusive: number, consume: (bytes: Uint8Array) => void): Promise<void> {
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(endExclusive) || start < 0 || endExclusive <= start || endExclusive > source.byteLength) throw new Error("Invalid remote Wikipedia byte range");
    const timeout = AbortSignal.timeout(300_000);
    const signal = options.signal ? AbortSignal.any([options.signal, timeout]) : timeout;
    signal.throwIfAborted();
    const response = await fetchSource(source.url, { headers: { Range: `bytes=${start}-${endExclusive - 1}`,
      "If-Match": source.etag, "Accept-Encoding": "identity", "User-Agent": "SCCE/3.0 (https://github.com/rpwalsh/SCCE)" }, redirect: "error", signal });
    try {
      if (response.status !== 206) throw new Error(`Remote Wikipedia requires HTTP 206; received ${response.status}`);
      if (response.headers.get("content-range") !== `bytes ${start}-${endExclusive - 1}/${source.byteLength}`) throw new Error("Remote Wikipedia Content-Range differs from the pinned source");
      if (response.headers.get("etag") !== source.etag) throw new Error("Remote Wikipedia ETag changed");
      const encoding = response.headers.get("content-encoding");
      if (encoding && encoding !== "identity") throw new Error("Remote Wikipedia response changed the compressed representation");
      const expected = endExclusive - start;
      const length = response.headers.get("content-length");
      if (length !== null && Number(length) !== expected) throw new Error("Remote Wikipedia Content-Length differs from the requested range");
      if (!response.body) throw new Error("Remote Wikipedia response has no body");
      let received = 0;
      const reader = response.body.getReader();
      const cancel = () => { void reader.cancel(signal.reason).catch(() => undefined); };
      signal.addEventListener("abort", cancel, { once: true });
      try {
        while (true) {
          signal.throwIfAborted();
          const next = await reader.read();
          signal.throwIfAborted();
          if (next.done) break;
          received += next.value.byteLength;
          if (received > expected) throw new Error("Remote Wikipedia range body exceeds its declared length");
          consume(next.value);
          bytesFetched += next.value.byteLength;
        }
      } finally { signal.removeEventListener("abort", cancel); await reader.cancel().catch(() => undefined); reader.releaseLock(); }
      if (received !== expected) throw new Error("Remote Wikipedia range body is truncated");
    } finally { await response.body?.cancel().catch(() => undefined); }
  }
  return {
    async block(start: number, endExclusive: number, maxCompressedBytes: number): Promise<Buffer> {
      if (endExclusive - start > maxCompressedBytes) throw new Error("Remote Wikipedia compressed block exceeds its configured byte bound");
      const chunks: Buffer[] = [];
      if (contiguous && contiguousEnd === 0 && start > 0 && start <= maxCompressedBytes && (options.resumeOffset ?? 0) === 0 && !options.resumeAfterBlock) {
        await readRange(0, start, bytes => digest.update(bytes));
        contiguousEnd = start;
      }
      if (start !== contiguousEnd) contiguous = false;
      await readRange(start, endExclusive, bytes => { chunks.push(Buffer.from(bytes)); if (contiguous) digest.update(bytes); });
      contiguousEnd = endExclusive;
      return Buffer.concat(chunks, endExclusive - start);
    },
    async verifyWholeSource(): Promise<{ expectedSha1: string; actualSha1: string; verified: true; bytesFetched: number }> {
      options.signal?.throwIfAborted();
      let actualSha1: string;
      if (contiguous && contiguousEnd === source.byteLength) actualSha1 = digest.digest("hex");
      else {
        const full = createHash("sha1");
        const verificationRangeBytes = 64 * 1024 * 1024;
        for (let start = 0; start < source.byteLength; start += verificationRangeBytes) {
          await readRange(start, Math.min(start + verificationRangeBytes, source.byteLength), bytes => full.update(bytes));
        }
        actualSha1 = full.digest("hex");
      }
      if (actualSha1 !== source.expectedSha1) throw new Error("Remote Wikipedia whole-source SHA-1 does not match its pinned checksum");
      return { expectedSha1: source.expectedSha1, actualSha1, verified: true, bytesFetched };
    }
  };
}
