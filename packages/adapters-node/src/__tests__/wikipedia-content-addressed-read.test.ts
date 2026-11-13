// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { beforeEach, expect, it, vi } from "vitest";
import { createWikipediaInputManifest } from "../wikipedia-input-manifest.js";
import { normalizeWikiText, readContentAddressedWikipediaArchiveBlob, readWikipediaArchiveBlob,
  type WikipediaArchiveDescriptor, type WikipediaArchiveReference } from "../wikipedia.js";
import { WIKIPEDIA_SURFACE_TRANSFORM } from "../wikipedia-markup.js";

const meter = vi.hoisted(() => ({ file: "" }));
vi.mock("node:fs", async importOriginal => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return { ...actual, createReadStream: vi.fn(actual.createReadStream) };
});
vi.mock("node:child_process", async importOriginal => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  return { ...actual, spawn: (...args: Parameters<typeof actual.spawn>) => {
    // Observe the actual decoder's compressed bytes read, without replacing its codec or range logic.
    const argv = args[1] as string[];
    if (meter.file && argv?.[0] === "-c" && argv[1]?.includes("read += len(chunk)")) {
      argv[1] += "\nwith open(sys.argv[5],'w') as meter: meter.write(str(read))";
      argv.push(meter.file);
    }
    return actual.spawn(...args);
  } };
});
const hash = (bytes: Uint8Array) => `sha256_${createHash("sha256").update(bytes).digest("hex")}`;
const compress = (text: string) => execFileSync("python", ["-c",
  "import bz2,sys;sys.stdout.buffer.write(bz2.compress(sys.stdin.buffer.read()))"], { input: text, windowsHide: true });

async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), "scce-pinned-wiki-read-"));
  const dumpPath = path.join(root, "dump.xml.bz2"), indexPath = path.join(root, "index.txt");
  const raw = `'''${path.basename(root)}''' 雪 preserves its source bytes.`;
  const xml = `<mediawiki><page><title>Opaque</title><ns>0</ns><id>7</id><revision><id>13</id><text>${raw}</text></revision></page></mediawiki>`;
  const selected = compress(xml), unrelated = compress("unrelated".repeat(10000));
  await writeFile(dumpPath, Buffer.concat([selected, unrelated]));
  await writeFile(indexPath, "0:7:Opaque\n");
  const manifest = await createWikipediaInputManifest({ dumpPath, indexPath, cacheDir: path.join(root, "hashes"),
    normalizationIdentity: WIKIPEDIA_SURFACE_TRANSFORM, compilerIdentity: "fixture", semanticConfig: { maxArticleChars: 4096 } });
  const archive: WikipediaArchiveDescriptor = { schema: "scce.wikipedia_archive.v1", manifest, python: "python",
    maxBlockBytes: 1024 * 1024, maxArticleChars: 4096 };
  const reference: WikipediaArchiveReference = { schema: "scce.wikipedia_archive_page.v1", blockOffset: 0,
    blockEnd: selected.length, pageId: "7", revisionId: "13", representation: "original",
    transformId: `${WIKIPEDIA_SURFACE_TRANSFORM}+redact-secrets` };
  const bytes = Buffer.from(raw), identity = { contentHash: hash(bytes), byteLength: bytes.length };
  meter.file = path.join(root, "bytes-read.txt");
  vi.mocked(createReadStream).mockClear();
  return { root, dumpPath, indexPath, selected, unrelated, xml, raw, archive, reference, bytes, identity };
}
beforeEach(() => { meter.file = ""; vi.mocked(createReadStream).mockClear(); });

it("reads only the indexed compressed block and hashes the consumed article despite unrelated container/index changes", async () => {
  const f = await fixture();
  await writeFile(f.dumpPath, Buffer.concat([f.selected, compress("changed unrelated bytes".repeat(10000))]));
  await writeFile(f.indexPath, "changed locator index; never consumed during retained article reconstruction");
  expect(await readContentAddressedWikipediaArchiveBlob(f.archive, f.reference, f.identity)).toEqual(f.bytes);
  expect(Number(await readFile(meter.file, "utf8"))).toBe(f.selected.length);
  expect(vi.mocked(createReadStream)).not.toHaveBeenCalled();
  await expect(readWikipediaArchiveBlob(f.archive, f.reference)).rejects.toThrow("retained Wikipedia archive changed");
  await expect(readWikipediaArchiveBlob(f.archive, f.reference,
    { contentIdentity: f.identity } as Parameters<typeof readWikipediaArchiveBlob>[2]))
    .rejects.toThrow("retained Wikipedia archive changed");
});

it("rejects changed requested article bytes after decoding the real compressed block", async () => {
  const f = await fixture(), changed = compress(f.xml.replace("preserves", "corrupts!"));
  await writeFile(f.dumpPath, Buffer.concat([changed, f.unrelated]));
  await expect(readContentAddressedWikipediaArchiveBlob(f.archive, { ...f.reference, blockEnd: changed.length }, f.identity))
    .rejects.toThrow("article content integrity mismatch");
  expect(Number(await readFile(meter.file, "utf8"))).toBe(changed.length);
  expect(vi.mocked(createReadStream)).not.toHaveBeenCalled();
});

it("checks the exact content identity on cache hits and for both original and evidence representations", async () => {
  const f = await fixture();
  expect(await readContentAddressedWikipediaArchiveBlob(f.archive, f.reference, f.identity)).toEqual(f.bytes);
  const evidence = Buffer.from(normalizeWikiText(f.raw));
  expect(await readContentAddressedWikipediaArchiveBlob(f.archive, { ...f.reference, representation: "evidence" },
    { contentHash: hash(evidence), byteLength: evidence.length })).toEqual(evidence);
  for (const identity of [{ ...f.identity, contentHash: hash(Buffer.from("forged")) }, { ...f.identity, byteLength: f.bytes.length + 1 }]) {
    await expect(readContentAddressedWikipediaArchiveBlob(f.archive, f.reference, identity)).rejects.toThrow("article content integrity mismatch");
  }
  await expect(readContentAddressedWikipediaArchiveBlob(f.archive, { ...f.reference, transformId: "forged" }, f.identity))
    .rejects.toThrow("invalid retained Wikipedia archive reference");
  await expect(readContentAddressedWikipediaArchiveBlob(f.archive, { ...f.reference, revisionId: "99" }, f.identity))
    .rejects.toThrow("page/revision identity mismatch");
});

it("refuses malformed or missing content identity before decoding and retains the strict maintenance reader", async () => {
  const f = await fixture();
  for (const identity of [undefined, { ...f.identity, contentHash: "forged" }, { ...f.identity, byteLength: -1 },
    { ...f.identity, byteLength: Number.NaN }]) {
    await expect(readContentAddressedWikipediaArchiveBlob(f.archive, f.reference, identity!)).rejects.toThrow("invalid retained Wikipedia article content identity");
  }
  expect(await readWikipediaArchiveBlob(f.archive, f.reference)).toEqual(f.bytes);
});
