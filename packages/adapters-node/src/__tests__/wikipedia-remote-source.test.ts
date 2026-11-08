// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createRemoteWikipediaReader, readRemoteWikipediaSource, REMOTE_WIKIPEDIA_SOURCE_SCHEMA, type RemoteWikipediaSource } from "../wikipedia-remote-source.js";
import { createWikipediaInputManifest, wikipediaInputSourcesStillMatch } from "../wikipedia-input-manifest.js";
import { streamWikipediaMultistream, type ResolvedWikipediaCorpus } from "../wikipedia.js";

const sha = (kind: string, text: string | Buffer) => createHash(kind).update(text).digest("hex");
const sourceFor = (bytes: Buffer, index = "0:1:Fixture\n"): RemoteWikipediaSource => ({
  schema: REMOTE_WIKIPEDIA_SOURCE_SCHEMA, url: "https://example.test/enwiki/20261101/enwiki-20261101-pages-articles-multistream.xml.bz2",
  byteLength: bytes.length, expectedSha1: sha("sha1", bytes), indexSha256: sha("sha256", index), etag: '"pinned-v1"'
});
interface ResponseOverride { status?: number; headers?: Record<string, string>; body?: Buffer }
function serve(bytes: Buffer, source: RemoteWikipediaSource, override: ResponseOverride = {}) {
  return vi.fn<typeof fetch>(async (_url, init) => {
    const headers = new Headers(init?.headers); const range = /^bytes=(\d+)-(\d+)$/u.exec(headers.get("Range") ?? "")!;
    const start = Number(range[1]); const end = Number(range[2]);
    return new Response(new Uint8Array(override.body ?? bytes.subarray(start, end + 1)).buffer, { status: override.status ?? 206,
      headers: { "Content-Range": `bytes ${start}-${end}/${bytes.length}`, ETag: source.etag, "Content-Length": String(end - start + 1), ...override.headers } });
  });
}
afterEach(() => vi.unstubAllGlobals());

describe("pinned remote Wikipedia multistream ranges", () => {
  it("reads only requested ranges and verifies contiguous full-source bytes without fetching again", async () => {
    const bytes = Buffer.from("a bounded fixture"); const source = sourceFor(bytes); const fetcher = serve(bytes, source);
    const reader = createRemoteWikipediaReader(source, fetcher);
    expect(await reader.block(0, 3, 3)).toEqual(bytes.subarray(0, 3));
    expect(await reader.block(3, bytes.length, bytes.length)).toEqual(bytes.subarray(3));
    expect(await reader.verifyWholeSource()).toMatchObject({ verified: true, actualSha1: source.expectedSha1, bytesFetched: bytes.length });
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(new Headers(fetcher.mock.calls[0]![1]?.headers).get("If-Match")).toBe(source.etag);
  });
  it("rechecks the whole pinned source at EOF after a resumed range", async () => {
    const bytes = Buffer.from("restart keeps its identity"); const source = sourceFor(bytes); const fetcher = serve(bytes, source);
    const reader = createRemoteWikipediaReader(source, fetcher, { resumeOffset: 4 });
    await reader.block(4, bytes.length, bytes.length);
    expect(await reader.verifyWholeSource()).toMatchObject({ verified: true, bytesFetched: bytes.length * 2 - 4 });
    expect(new Headers(fetcher.mock.calls[1]![1]?.headers).get("Range")).toBe(`bytes=0-${bytes.length - 1}`);
  });
  it("includes an unindexed leading header in a fresh run without reading the whole source twice", async () => {
    const bytes = Buffer.from("header and indexed page bytes"); const source = sourceFor(bytes); const fetcher = serve(bytes, source);
    const reader = createRemoteWikipediaReader(source, fetcher);
    await reader.block(6, bytes.length, bytes.length);
    expect(await reader.verifyWholeSource()).toMatchObject({ verified: true, bytesFetched: bytes.length });
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(new Headers(fetcher.mock.calls[0]![1]?.headers).get("Range")).toBe("bytes=0-5");
  });
  const invalidResponses: ResponseOverride[] = [
    { status: 200 }, { status: 412 }, { headers: { ETag: '"changed"' } },
    { headers: { "Content-Range": "bytes 1-5/6" } }, { headers: { "Content-Length": "99" } },
    { headers: { "Content-Encoding": "gzip" } }, { body: Buffer.from("short") }, { body: Buffer.from("too long") }
  ];
  it.each(invalidResponses)("refuses incorrect or changed HTTP representations: %j", async override => {
    const bytes = Buffer.from("abcdef"); const source = sourceFor(bytes);
    await expect(createRemoteWikipediaReader(source, serve(bytes, source, override)).block(0, 6, 6)).rejects.toThrow();
  });
  it("rejects oversized blocks before fetching and rejects a mismatched final source hash", async () => {
    const bytes = Buffer.from("abcdef"); const source = sourceFor(bytes); const fetcher = serve(bytes, source);
    const reader = createRemoteWikipediaReader({ ...source, expectedSha1: "0".repeat(40) }, fetcher);
    await expect(reader.block(0, bytes.length, 2)).rejects.toThrow("byte bound");
    expect(fetcher).not.toHaveBeenCalled();
    await reader.block(0, bytes.length, bytes.length);
    await expect(reader.verifyWholeSource()).rejects.toThrow("SHA-1");
  });
  it("binds the descriptor, source ETag and matching index into resume identity", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "scce-remote-identity-"));
    try {
      const index = "0:1:Fixture\n"; const source = sourceFor(Buffer.from("compressed"), index);
      const dumpPath = path.join(root, "enwiki-20261101-pages-articles-multistream.xml.bz2.remote.json");
      const indexPath = path.join(root, "index.txt"); await writeFile(indexPath, index); await writeFile(dumpPath, JSON.stringify(source));
      const options = { dumpPath, indexPath, cacheDir: path.join(root, "cache"), normalizationIdentity: "fixture", compilerIdentity: "fixture", semanticConfig: {} };
      const first = await createWikipediaInputManifest(options);
      expect(first.inputs.remoteDump).toEqual(source);
      expect(first.inputs.dump.sha256).toBe(`sha256:${(await readRemoteWikipediaSource(dumpPath))!.descriptorSha256}`);
      await writeFile(dumpPath, JSON.stringify({ ...source, etag: '"changed"' }));
      expect(await wikipediaInputSourcesStillMatch(first)).toBe(false);
      expect((await createWikipediaInputManifest(options)).identity).not.toBe(first.identity);
      await writeFile(indexPath, index + "1:2:wrong\n");
      await expect(createWikipediaInputManifest(options)).rejects.toThrow("index checksum");
    } finally { await rm(root, { recursive: true, force: true }); }
  });
  it("runs the existing page parser over two remote blocks and resumes by original compressed offset", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "scce-remote-parser-"));
    try {
      const page = (id: number) => `<page><title>Fixture ${id}</title><ns>0</ns><id>${id}</id><revision><id>${id + 10}</id><text>${"A source sentence with retained evidence. ".repeat(8)}</text></revision></page>`;
      const compress = (text: string) => execFileSync("python", ["-c", "import bz2,sys;sys.stdout.buffer.write(bz2.compress(sys.stdin.buffer.read()))"], { input: text });
      const first = compress(page(1)); const bytes = Buffer.concat([first, compress(page(2))]);
      const index = `0:1:Fixture 1\n${first.length}:2:Fixture 2\n`; const source = sourceFor(bytes, index);
      const dumpPath = path.join(root, "enwiki-20261101-pages-articles-multistream.xml.bz2.remote.json");
      const indexPath = path.join(root, "index.txt"); await writeFile(dumpPath, JSON.stringify(source)); await writeFile(indexPath, index);
      const fetcher = serve(bytes, source); vi.stubGlobal("fetch", fetcher);
      const corpus: ResolvedWikipediaCorpus = { dumpPath, indexPath, namespace: "wikipedia-enwiki", wikiCode: "enwiki", python: "python",
        maxPagesPerRun: 100, maxBlocksPerRun: 0, maxArticleChars: 10000, maxBlockBytes: 1048576, memorySafetyBoundMb: 1024,
        checkpointEveryPages: 100, skipRedirects: true, allowedNamespaces: [0] };
      const full = []; for await (const item of streamWikipediaMultistream(corpus)) full.push(item);
      const files = full.filter(item => item.type === "file"); expect(files).toHaveLength(2);
      expect(files[1]!.file.metadata).toMatchObject({ sourceUrl: source.url, blockOffset: first.length, dumpTransport: "http-range" });
      expect(full.at(-1)!.type === "checkpoint" && full.at(-1)!.checkpoint.metadata).toMatchObject({ reachedEnd: true, remoteIntegrity: { verified: true } });
      fetcher.mockClear(); const resumed = [];
      for await (const item of streamWikipediaMultistream(corpus, { resumeOffset: first.length, resumeBlockOrdinal: 2 })) resumed.push(item);
      expect(resumed.filter(item => item.type === "file").map(item => item.file.uri)).toEqual(["wikipedia://enwiki/pages/2/Fixture_2"]);
      expect(new Headers(fetcher.mock.calls[0]![1]?.headers).get("Range")).toBe(`bytes=${first.length}-${bytes.length - 1}`);
      const bounded = []; for await (const item of streamWikipediaMultistream({ ...corpus, maxBlocksPerRun: 1 })) bounded.push(item);
      expect(bounded.at(-1)!.type === "checkpoint" && bounded.at(-1)!.checkpoint.metadata).toMatchObject({ reachedEnd: false, stoppedAt: "maxBlocksPerRun" });
    } finally { await rm(root, { recursive: true, force: true }); }
  });
});
