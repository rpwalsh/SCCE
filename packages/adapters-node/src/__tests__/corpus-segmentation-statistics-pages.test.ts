// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
import { readFileSync } from "node:fs";
import { expect, it } from "vitest";
import { canonicalStringify, collectBoundaryTrainingObservations, compileBoundaryStatistics, createHasher, fitBoundaryEstimator,
  measureSurfaceBoundaries, type BoundaryStatisticsRow } from "@scce/kernel";
import { fixtureSegmentationScratch } from "../../../kernel/src/__tests__/fixtures/corpus-segmentation-scratch.js";
import { languageArtifactJsonByteLengths } from "../durable-language-artifact-storage.js";
import { readCorpusStatisticsPages, writeCorpusStatisticsPages } from "../corpus-segmentation-statistics-pages.js";

function fixture(maxPageBytes: number) {
  const memory = fixtureSegmentationScratch(4096, maxPageBytes), reads: number[] = [];
  const store = { bounds: { pageRows: 4096, maxPageBytes },
    putInput: (collection: string, rows: Parameters<typeof memory.putMany>[1]) => memory.putMany(`input/${collection}`, rows),
    pages: (collection: string, query: { pageRows?: number; maxPageBytes?: number } = {}) => {
      reads.push(query.pageRows ?? 4096);
      return memory.pages({ collection, pageRows: query.pageRows ?? 4096, maxPageBytes: query.maxPageBytes ?? maxPageBytes });
    } };
  return { memory, store, reads };
}
const source = (rows: readonly BoundaryStatisticsRow[], chunk: number) => (async function* () {
  for (let start = 0; start < rows.length; start += chunk) yield rows.slice(start, start + chunk);
})();
async function flatten(pages: AsyncIterable<readonly BoundaryStatisticsRow[]>): Promise<BoundaryStatisticsRow[]> {
  const result: BoundaryStatisticsRow[] = []; for await (const page of pages) result.push(...page); return result;
}

it("packs genuine source statistics losslessly across input chunks and physical page sizes, preserving the complete fitted model", async () => {
  const hasher = createHasher();
  const text = (JSON.parse(readFileSync(new URL("../../../kernel/src/__tests__/fixtures/dolly-human-16.json", import.meta.url), "utf8")) as { text: string }).text;
  expect(hasher.digestHex(text)).toBe("307c6758d4173c6dd87d0b77460c74fafe62c3e58d934eabbf5e05268de3dadc");
  const lattice = measureSurfaceBoundaries({ documentId: "human.dolly", text: text.slice(0, 512), maxUnits: Number.MAX_SAFE_INTEGER });
  const statistics = compileBoundaryStatistics({ populationId: "human.statistics", observations: collectBoundaryTrainingObservations({ lattices: [lattice] }), hasher });
  const expectedFit = fitBoundaryEstimator({ statistics, hasher });
  expect(statistics.rows.length).toBeGreaterThan(10);
  const digests = [];
  for (const [budget, chunk] of [[1200, 1], [12000, 7]]) {
    const f = fixture(budget!);
    const result = await writeCorpusStatisticsPages(f.store, "0000000000000001", source(statistics.rows, chunk!), statistics.rows.length);
    expect(result.logicalRows).toBe(statistics.rows.length);
    expect(result.physicalRows).toBeLessThan(statistics.rows.length);
    expect(result.physicalRows).toBe(await f.memory.count("input/statistics/0000000000000001"));
    const restored = await flatten(readCorpusStatisticsPages(f.store, "0000000000000001", statistics.rows.length));
    expect(restored).toEqual(statistics.rows);
    expect(f.reads.every(rows => rows === 1)).toBe(true);
    expect(fitBoundaryEstimator({ statistics: { ...statistics, rows: restored }, hasher })).toEqual(expectedFit);
    digests.push(hasher.digestHex(canonicalStringify({ ...statistics, rows: restored })));
    for await (const page of f.memory.pages({ collection: "input/statistics/0000000000000001", ...f.store.bounds })) for (const row of page)
      expect(languageArtifactJsonByteLengths(row).decodedJsonbBytes + 2).toBeLessThanOrEqual(budget!);
  }
  expect(digests[0]).toBe(digests[1]);
});

const logical: BoundaryStatisticsRow = { key: "opaque.雪🧭", featuresFixed: [0, 1, 1000000], anchoredPositiveMass: 1, anchoredNegativeMass: 2,
  latentPositiveMass: 3, latentNegativeMass: 4, positiveMass: 4, negativeMass: 6 };
it("retains unknown JSON fields and exact logical order without flattening them into permanent tuples", async () => {
  const rows: BoundaryStatisticsRow[] = Array.from({ length: 50 }, (_, index) => ({ ...logical, key: String(index),
    extension: JSON.parse('{"__proto__":{"retained":true},"constructor":null,"text":"雪🧭é","numbers":[0,0.5,-100],"absent":null}') }));
  const f = fixture(4096), result = await writeCorpusStatisticsPages(f.store, "doc", source(rows, 13), rows.length);
  expect(result.physicalRows).toBeLessThan(rows.length / 4);
  expect(await flatten(readCorpusStatisticsPages(f.store, "doc", rows.length))).toEqual(rows);
});

it("refuses oversized rows, missing pages, raw old rows, and header count mismatches", async () => {
  const f = fixture(1200);
  await expect(writeCorpusStatisticsPages(f.store, "huge", source([{ ...logical, key: "雪".repeat(1000) }], 1), 1)).rejects.toThrow(/decoded JSON page budget/);
  expect(await f.memory.count("input/statistics/huge")).toBe(0);
  await expect(writeCorpusStatisticsPages(f.store, "missing", source([logical], 1), 2)).rejects.toThrow(/incomplete/);
  await writeCorpusStatisticsPages(f.store, "valid", source([logical], 1), 1);
  await expect(flatten(readCorpusStatisticsPages(f.store, "valid", 2))).rejects.toThrow(/incomplete/);
  await f.memory.deleteCollection("input/statistics/valid");
  await expect(flatten(readCorpusStatisticsPages(f.store, "valid", 1))).rejects.toThrow(/incomplete/);
  await f.memory.putMany("input/statistics/raw", [{ orderKey: "0000000000000001", value: JSON.parse(JSON.stringify(logical)) }]);
  await expect(flatten(readCorpusStatisticsPages(f.store, "raw", 1))).rejects.toThrow(/incomplete/);
  expect(await flatten(readCorpusStatisticsPages(f.store, "empty", 0))).toEqual([]);
});
