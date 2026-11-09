// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
import type { CorpusSegmentationScratch, CorpusSegmentationScratchRow } from "./corpus-segmentation-cursor.js";

export function segmentationOrdinalKey(ordinal: number): string {
  if (!Number.isSafeInteger(ordinal) || ordinal < 0) throw new Error("invalid segmentation scratch ordinal");
  return String(ordinal).padStart(String(Number.MAX_SAFE_INTEGER).length, "0");
}

export async function* segmentationScratchRows(store: CorpusSegmentationScratch, collection: string): AsyncGenerator<CorpusSegmentationScratchRow> {
  for await (const page of store.pages({ collection, pageRows: store.pageRows, maxPageBytes: store.maxPageBytes })) for (const row of page) yield row;
}

/** Stable two-way external merges retain only the two input pages and one output page. */
export async function sortSegmentationScratch(store: CorpusSegmentationScratch, source: string, target: string,
  compare: (left: CorpusSegmentationScratchRow, right: CorpusSegmentationScratchRow) => number): Promise<void> {
  if (source === target) throw new Error("segmentation external sort requires a distinct destination");
  let runCount = 0;
  const runName = (level: number, ordinal: number) => `${target}.sort.${level}.${ordinal}`;
  for await (const page of store.pages({ collection: source, pageRows: store.pageRows, maxPageBytes: store.maxPageBytes })) {
    if (!page.length) continue;
    const name = runName(0, runCount++);
    await store.deleteCollection(name);
    await store.putMany(name, [...page].sort(compare).map((row, index) => ({ ...row, orderKey: segmentationOrdinalKey(index) })));
  }
  let level = 0;
  while (runCount > 1) {
    let nextRun = 0;
    for (let index = 0; index < runCount; index += 2) {
      const leftName = runName(level, index); const rightName = index + 1 < runCount ? runName(level, index + 1) : undefined;
      const left = segmentationScratchRows(store, leftName); const right = rightName ? segmentationScratchRows(store, rightName) : undefined;
      const destination = runName(level + 1, nextRun++);
      await store.deleteCollection(destination);
      let leftRow = await left.next(); let rightRow = right ? await right.next() : { done: true as const, value: undefined };
      let ordinal = 0; let buffer: CorpusSegmentationScratchRow[] = []; let bytes = 0;
      const flush = async () => { if (buffer.length) await store.putMany(destination, buffer); buffer = []; bytes = 0; };
      try {
        while (!leftRow.done || !rightRow.done) {
          const takeLeft = rightRow.done || !leftRow.done && compare(leftRow.value, rightRow.value!) <= 0;
          const row = takeLeft ? leftRow.value! : rightRow.value!;
          const output = { ...row, orderKey: segmentationOrdinalKey(ordinal++) };
          const size = Buffer.byteLength(JSON.stringify(output));
          if (size > store.maxPageBytes) throw new Error("segmentation scratch row exceeds declared page bytes");
          if (buffer.length && (buffer.length >= store.pageRows || bytes + size > store.maxPageBytes)) await flush();
          buffer.push(output); bytes += size;
          if (takeLeft) leftRow = await left.next(); else rightRow = await right!.next();
        }
        await flush();
      } finally { await left.return(undefined); await right?.return(undefined); }
      await store.deleteCollection(leftName);
      if (rightName) await store.deleteCollection(rightName);
    }
    level++; runCount = nextRun;
  }
  await store.deleteCollection(target);
  if (!runCount) return;
  const final = runName(level, 0);
  for await (const page of store.pages({ collection: final, pageRows: store.pageRows, maxPageBytes: store.maxPageBytes })) await store.putMany(target, page);
  await store.deleteCollection(final);
}
