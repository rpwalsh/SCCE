// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
import { createHash } from "node:crypto";
import type { CorpusSegmentationScratch, CorpusSegmentationScratchRow } from "../../corpus-segmentation-cursor.js";

export function fixtureSegmentationScratch(pageRows: number, maxPageBytes = 8192): CorpusSegmentationScratch {
  const collections = new Map<string, Map<string, CorpusSegmentationScratchRow>>();
  return { pageRows, maxPageBytes,
    async *pages(query) {
      const rows = [...(collections.get(query.collection)?.values() ?? [])]
        .filter(row => (!query.afterKey || row.orderKey > query.afterKey) && (!query.prefix || row.orderKey.startsWith(query.prefix)))
        .sort((left, right) => left.orderKey < right.orderKey ? -1 : left.orderKey > right.orderKey ? 1 : 0);
      let page: CorpusSegmentationScratchRow[] = []; let bytes = 0;
      for (const row of rows) {
        const size = Buffer.byteLength(JSON.stringify(row));
        if (size > query.maxPageBytes) throw new Error("fixture scratch row too large");
        if (page.length && (page.length >= query.pageRows || bytes + size > query.maxPageBytes)) { yield page; page = []; bytes = 0; }
        page.push(JSON.parse(JSON.stringify(row)) as CorpusSegmentationScratchRow); bytes += size;
      }
      if (page.length) yield page;
    },
    async putMany(collection, rows) {
      let target = collections.get(collection);
      if (!target) { target = new Map(); collections.set(collection, target); }
      for (const row of rows) target.set(row.orderKey, JSON.parse(JSON.stringify(row)) as CorpusSegmentationScratchRow);
    },
    async count(collection) { return collections.get(collection)?.size ?? 0; },
    async deleteCollection(collection) { collections.delete(collection); },
    async digestChunks(chunks) { const hash = createHash("sha256"); for await (const chunk of chunks) hash.update(chunk); return hash.digest("hex"); }
  };
}
