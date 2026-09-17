// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
import path from "node:path";
import { describe, expect, it } from "vitest";
import { resolveWikipediaCorpusTarget } from "../wikipedia.js";

// Measured: with indexPath set to the dump, every block offset read is a line of XML rather than a stream
// start, so each seek fails "Invalid data stream" and a 62s run reported 6 blocks and 0 pages into a clean brain.
const dump = path.resolve("C:/dumps/enwiki-latest-pages-articles-multistream1.xml-p1p41242.bz2");

function configWith(indexPath: string | undefined): never {
  return { runtime: { corpora: { wikipedia: { enabled: true, dumpPath: dump, indexPath } } } } as never;
}

describe("a wikipedia dump is not its own index", () => {
  it("ignores an index path equal to the dump path, so the ingestor magic-scans instead of seeking garbage", () => {
    const resolved = resolveWikipediaCorpusTarget(configWith(dump), dump);
    expect(resolved?.dumpPath).toBe(dump);
    expect(resolved?.indexPath).toBeUndefined();
  });

  it("still honours a real index path, so the fix does not disable index mode", () => {
    const index = path.resolve("C:/dumps/enwiki-latest-pages-articles-multistream-index.txt.bz2");
    expect(resolveWikipediaCorpusTarget(configWith(index), dump)?.indexPath).toBe(index);
  });

  it("treats an absent or blank index path as no index", () => {
    expect(resolveWikipediaCorpusTarget(configWith(undefined), dump)?.indexPath).toBeUndefined();
    expect(resolveWikipediaCorpusTarget(configWith("   "), dump)?.indexPath).toBeUndefined();
  });
});
