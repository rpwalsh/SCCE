// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
import { execFileSync } from "node:child_process";
import { createReadStream } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { seekWikipediaIndexByteOffset, streamWikiBlocks } from "../wikipedia.js";

vi.mock("node:fs", async importOriginal => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return { ...actual, createReadStream: vi.fn(actual.createReadStream) };
});

async function collect<T>(stream: AsyncIterable<T>): Promise<T[]> {
  const rows: T[] = [];
  for await (const row of stream) rows.push(row);
  return rows;
}

async function fixture(blocks: number, pagesPerBlock = 3) {
  const root = await mkdtemp(path.join(tmpdir(), "scce-wiki-index-seek-"));
  const indexPath = path.join(root, "index.txt");
  const starts: number[] = [];
  let text = "";
  let bytePosition = 0;
  for (let block = 0; block < blocks; block++) {
    starts.push(bytePosition);
    for (let page = 0; page < pagesPerBlock; page++) {
      const line = `${block * 100}:${block * pagesPerBlock + page + 1}:\u65e5\u672c\ud83e\uddea:${block}:title:${page}${page % 2 ? "\r\n" : "\n"}`;
      text += line;
      bytePosition += Buffer.byteLength(line);
    }
  }
  text = text.replace(/\r?\n$/u, "");
  await writeFile(indexPath, text);
  return { root, indexPath, starts, text, dumpSize: blocks * 100 + 1, close: async () => {
    if (path.dirname(root) !== path.resolve(tmpdir())) throw new Error("unexpected fixture path");
    await rm(root, { recursive: true, force: true });
  } };
}

const corpus = { python: "python" };
describe("Wikipedia sorted text index resume seeking", () => {
  it("starts sequential reads at the cursor's first page and yields exactly the full-scan blocks with absolute ordinals", async () => {
    const f = await fixture(4096);
    try {
      const full = await collect(streamWikiBlocks(f.indexPath, f.dumpSize, corpus, 0));
      const cursor = 3900;
      vi.mocked(createReadStream).mockClear();
      const resumed = await collect(streamWikiBlocks(f.indexPath, f.dumpSize, corpus, cursor * 100, false, cursor + 1));
      const options = vi.mocked(createReadStream).mock.calls[0]?.[1] as { start?: number };
      expect(options.start).toBe(f.starts[cursor]);
      expect(options.start).toBeGreaterThan(Buffer.byteLength(f.text) * 9 / 10);
      expect(resumed).toEqual(full.slice(cursor));
      expect(resumed[0]!.entries).toHaveLength(3);
      expect(await collect(streamWikiBlocks(f.indexPath, f.dumpSize, corpus, cursor * 100, true, cursor + 1))).toEqual(full.slice(cursor + 1));
      expect(await collect(streamWikiBlocks(f.indexPath, f.dumpSize, corpus, 409500, true, 4096))).toEqual([]);
    } finally { await f.close(); }
  });

  it("finds each duplicate-offset lower bound without splitting Unicode titles, CRLF, or the final line", async () => {
    const f = await fixture(13);
    try {
      for (let block = 0; block < 13; block++) {
        expect(await seekWikipediaIndexByteOffset(f.indexPath, block * 100)).toBe(f.starts[block]);
        if (block) expect(await seekWikipediaIndexByteOffset(f.indexPath, block * 100 - 1)).toBe(f.starts[block]);
      }
      expect(await seekWikipediaIndexByteOffset(f.indexPath, 1300)).toBe(Buffer.byteLength(f.text));
      await expect(collect(streamWikiBlocks(f.indexPath, f.dumpSize, corpus, 999, false, 11))).rejects.toThrow("cursor block is missing");
    } finally { await f.close(); }
  });

  it("keeps compressed-index scanning and explicit offsets without ordinal metadata semantically equivalent", async () => {
    const f = await fixture(17);
    try {
      const compressedPath = `${f.indexPath}.bz2`;
      const compressed = execFileSync("python", ["-c", "import bz2,sys; sys.stdout.buffer.write(bz2.compress(sys.stdin.buffer.read()))"], { input: f.text, windowsHide: true });
      await writeFile(compressedPath, compressed);
      const full = await collect(streamWikiBlocks(f.indexPath, f.dumpSize, corpus, 0));
      vi.mocked(createReadStream).mockClear();
      expect(await collect(streamWikiBlocks(f.indexPath, f.dumpSize, corpus, 1400))).toEqual(full.slice(14));
      expect((vi.mocked(createReadStream).mock.calls[0]?.[1] as { start?: number }).start).toBe(0);
      expect(await collect(streamWikiBlocks(compressedPath, f.dumpSize, corpus, 1400, false, 15))).toEqual(full.slice(14));
      await expect(seekWikipediaIndexByteOffset(compressedPath, 1400)).rejects.toThrow("requires uncompressed text");
    } finally { await f.close(); }
  });
});
