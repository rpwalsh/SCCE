// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
import { readFileSync } from "node:fs";
import { expect, it } from "vitest";
import { canonicalStringify, collectBoundaryTrainingObservations, compileBoundaryStatistics, createHasher, measureSurfaceBoundaries,
  type BoundaryStatisticsCursor, type BoundarySufficientStatistics, type CorpusSegmentationDocumentCursor, type CorpusSegmentationScratch, type JsonValue } from "@scce/kernel";
import { mergePagedBoundaryStatistics } from "../../../kernel/src/paged-boundary-statistics.js";
import { fitPagedBoundaryEstimator } from "../../../kernel/src/paged-boundary-estimator.js";
import { learnPagedSegmentationPopulations } from "../../../kernel/src/paged-segmentation-population.js";
import { fixtureSegmentationScratch } from "../../../kernel/src/__tests__/fixtures/corpus-segmentation-scratch.js";
import { segmentationOrdinalKey } from "../corpus-segmentation-store.js";
import { BOUNDARY_MERGE_PAGE_SCHEMA, createPackedBoundaryMergeScratch, withPackedBoundaryMerges } from "../corpus-segmentation-merge-scratch.js";
import { languageArtifactJsonByteLengths } from "../durable-language-artifact-storage.js";
import { sortSegmentationScratch } from "../../../kernel/src/corpus-segmentation-sort.js";

function fixture(pageRows = 4096, maxPageBytes = 16000) {
  const memory = fixtureSegmentationScratch(pageRows, maxPageBytes);
  const writes: Array<{ collection: string; value: JsonValue }> = [], physicalReads: number[] = [];
  const names = new Set<string>();
  const store: CorpusSegmentationScratch = { ...memory,
    async putMany(collection, rows) { for (const row of rows) { writes.push({ collection, value: row.value });
      if (row.value && typeof row.value === "object" && !Array.isArray(row.value) && row.value.schema === BOUNDARY_MERGE_PAGE_SCHEMA)
        expect(languageArtifactJsonByteLengths(row).decodedJsonbBytes + 2).toBeLessThanOrEqual(maxPageBytes); }
      names.add(collection); await memory.putMany(collection, rows); },
    pages(query) { physicalReads.push(query.pageRows); return memory.pages(query); } };
  return { memory, store, writes, physicalReads, names };
}
async function read(store: CorpusSegmentationScratch, collection: string, prefix = "", afterKey = "") {
  const rows = []; for await (const page of store.pages({ collection, prefix, afterKey, pageRows: store.pageRows, maxPageBytes: store.maxPageBytes })) rows.push(...page); return rows;
}
const hasher = createHasher();
it("uses the declared Node working budget to eliminate physical binary merge passes with identical packed rows",async()=>{
  const results=[],writes:number[]=[],levels:number[]=[];
  for(const binary of [true,false]){
    const f=fixture(2,2048),store=binary?{...f.store,sortMergeBudget:{maxResidentBytes:8192+2*(4096+4),residentBytesPerInput:4096,residentOutputBytes:8192}}:f.store;
    const lease=createPackedBoundaryMergeScratch(store),rows=Array.from({length:302},(_,index)=>({orderKey:segmentationOrdinalKey(index),value:{rank:301-index,text:"\u732b\ud83e\udded.e\u0301"}}));
    try{
      await lease.scratch.putMany("source",rows);await sortSegmentationScratch(lease.scratch,"source","sorted",(a,b)=>Number((a.value as {rank:number}).rank)-Number((b.value as {rank:number}).rank));
      results.push(await read(lease.scratch,"sorted"));
      const physical=f.writes.filter(row=>row.collection.startsWith("sorted.sort."));writes.push(physical.length);
      levels.push(Math.max(...physical.map(row=>Number(/\.sort\.(\d+)\./u.exec(row.collection)![1]))));
      expect(lease.scratch.sortMergeBudget!.maxResidentBytes).toBe(binary?16392:64*1024*1024);
    }finally{await lease.dispose();}
    for(const name of f.names)expect(await f.memory.count(name)).toBe(0);
  }
  expect(results[1]).toEqual(results[0]);expect(levels).toEqual([8,1]);expect(writes[1]!).toBeLessThan(writes[0]!/2);
});
function cursor(statistics: BoundarySufficientStatistics, chunk = 4096): BoundaryStatisticsCursor {
  const { rows, sourceDocumentIds, ...header } = statistics;
  return { header: { ...header, rowCount: rows.length, sourceInventory: { id: hasher.digestHex(JSON.stringify(sourceDocumentIds)), count: sourceDocumentIds.length } },
    async *rows() { for (let start = 0; start < rows.length; start += chunk) yield rows.slice(start, start + chunk); },
    async *sourceDocuments() { yield sourceDocumentIds; } };
}
async function materialize(source: BoundaryStatisticsCursor) {
  const rows = [], documents = [];
  for await (const page of source.rows()) rows.push(...page);
  for await (const page of source.sourceDocuments()) documents.push(...page);
  return { header: source.header, rows, documents };
}
function genuine() {
  return ["dolly-human-16.json", "dolly-human-creative-pair.json"].map((name, index) => {
    const text = (JSON.parse(readFileSync(new URL(`../../../kernel/src/__tests__/fixtures/${name}`, import.meta.url), "utf8")) as { text: string }).text;
    const lattice = measureSurfaceBoundaries({ documentId: `human.${index}`, text: text.slice(0, 512), maxUnits: Number.MAX_SAFE_INTEGER });
    return compileBoundaryStatistics({ populationId: "population.source", observations: collectBoundaryTrainingObservations({ lattices: [lattice] }), hasher });
  });
}

it("coalesces singleton appends, snapshots inputs and preserves logical prefix/cursor/count/reset semantics", async () => {
  const f = fixture(4096, 4096), lease = createPackedBoundaryMergeScratch(f.store);
  await f.memory.putMany("unrelated", [{ orderKey: "0", value: "untouched" }]);
  const expected = [];
  for (let index = 0; index < 100; index++) {
    const row = { orderKey: segmentationOrdinalKey(index), value: { index, text: "雪🧭é" } };
    expected.push(JSON.parse(JSON.stringify(row)));
    await lease.scratch.putMany("ordered", [row]); row.value.text = "mutated after write";
  }
  expect(await lease.scratch.count("ordered")).toBe(100);
  expect(await f.memory.count("ordered")).toBeLessThan(10);
  expect(await read(lease.scratch, "ordered")).toEqual(expected);
  expect(await read(lease.scratch, "ordered", "00000000000000", segmentationOrdinalKey(94))).toEqual(expected.slice(95));
  expect(f.physicalReads.every(rows => rows === 1)).toBe(true);
  await lease.scratch.deleteCollection("ordered");
  await lease.scratch.putMany("ordered", [{ orderKey: segmentationOrdinalKey(0), value: { changed: true } }]);
  expect(await lease.scratch.count("ordered")).toBe(1);
  expect(await read(lease.scratch, "ordered")).toEqual([{ orderKey: segmentationOrdinalKey(0), value: { changed: true } }]);
  await lease.dispose(); await lease.dispose();
  expect(await f.memory.count("ordered")).toBe(0); expect(await f.memory.count("unrelated")).toBe(1);
});

it("packs every sorter intermediate and retains complete genuine-source rows, header hashes and fitted values", async () => {
  const sources = genuine(), original = fixture(), packed = fixture();
  const merge = (scratch: CorpusSegmentationScratch) => mergePagedBoundaryStatistics({ scratch, populationId: "population.merged", collectionPrefix: "owned.merge", hasher,
    sources: async function* () { for (const source of sources) yield cursor(source, 1); } });
  const baseline = await merge(original.store), actual = await merge(withPackedBoundaryMerges(packed.store));
  expect(await materialize(actual)).toEqual(await materialize(baseline));
  expect(hasher.digestHex(canonicalStringify(await materialize(actual)))).toBe(hasher.digestHex(canonicalStringify(await materialize(baseline))));
  expect(await fitPagedBoundaryEstimator({ statistics: actual, hasher })).toEqual(await fitPagedBoundaryEstimator({ statistics: baseline, hasher }));
  expect(packed.writes.length).toBeLessThan(original.writes.length / 4);
  expect(packed.writes.some(row => row.collection.includes(".sort."))).toBe(true);
  expect(packed.writes.every(row => row.value && typeof row.value === "object" && !Array.isArray(row.value) && row.value.schema === BOUNDARY_MERGE_PAGE_SCHEMA)).toBe(true);
  await actual.dispose?.();
  for (const name of packed.names) expect(await packed.memory.count(name)).toBe(0);
  await baseline.dispose?.();
});

it("cleans all touched temporary collections and pending singleton rows after a source failure", async () => {
  const f = fixture(), statistics = genuine(), lease = createPackedBoundaryMergeScratch(f.store), source = cursor(statistics[1]!, 1);
  source.rows = async function* () { yield statistics[1]!.rows.slice(0, 1); throw Error("source failed"); };
  await expect(mergePagedBoundaryStatistics({ scratch: { ...f.store, boundaryMergeScratch: () => lease }, populationId: "population.merged", collectionPrefix: "failed", hasher,
    sources: async function* () { yield cursor(statistics[0]!, 1); yield source; } })).rejects.toThrow("source failed");
  expect(f.names.size).toBeGreaterThan(0);
  for (const name of f.names) expect(await f.memory.count(name)).toBe(0);
  await expect(lease.scratch.count("failed.rawRows")).rejects.toThrow("disposed");
});

it("uses packed merges throughout full fitting while preserving arbitrary workspace updates and returned artifact lifetime", async () => {
  const documents = Array.from({ length: 8 }, (_, index) => {
    const documentId = `test.owner.${index}`, lattice = measureSurfaceBoundaries({ documentId, text: `${index} 雪🧭 ${index % 2} 雪.`, maxUnits: Number.MAX_SAFE_INTEGER });
    return { documentId, sourceFamilyId: documentId, statistics: compileBoundaryStatistics({ populationId: "population.test", observations: collectBoundaryTrainingObservations({ lattices: [lattice] }), hasher }) };
  });
  const input = (scratch: CorpusSegmentationScratch): CorpusSegmentationDocumentCursor => {
    const metadata = documents.map((doc, ordinal) => ({ ordinal, documentId: doc.documentId, sourceFamilyId: doc.sourceFamilyId, statistics: cursor(doc.statistics).header }));
    return { scratch, documentCount: metadata.length, sourceInventory: { id: hasher.digestHex(JSON.stringify(metadata.map(doc => doc.documentId))), count: metadata.length },
      async *documents() { yield [...metadata].reverse(); }, statistics(doc) { return cursor(documents[doc.ordinal]!.statistics); } };
  };
  const baseline = fixture(), packed = fixture();
  const expected = await learnPagedSegmentationPopulations({ rootPopulationId: "population.test", source: input(baseline.store), namespace: "fit", featureContextId: "context", maxPopulations: 1, hasher });
  const actual = await learnPagedSegmentationPopulations({ rootPopulationId: "population.test", source: input(withPackedBoundaryMerges(packed.store)), namespace: "fit", featureContextId: "context", maxPopulations: 1, hasher });
  expect(actual.model).toEqual(expected.model);
  expect(await read(packed.store,actual.artifacts.assignments)).toEqual(await read(baseline.store,expected.artifacts.assignments));
  for(const partition of Object.keys(actual.artifacts.partitions) as Array<keyof typeof actual.artifacts.partitions>)
    expect(await read(packed.store,actual.artifacts.partitions[partition])).toEqual(await read(baseline.store,expected.artifacts.partitions[partition]));
  expect(packed.writes.some(row => row.collection.includes("familyLookup") && typeof row.value === "string")).toBe(true);
  const merges = packed.writes.filter(row => row.collection.includes(".rawRows") || row.collection.endsWith(".rows") || row.collection.includes(".sortedRows"));
  expect(merges.length).toBeGreaterThan(1);
  expect(merges.every(row => row.value && typeof row.value === "object" && !Array.isArray(row.value) && row.value.schema === BOUNDARY_MERGE_PAGE_SCHEMA)).toBe(true);
  for (const [index, source] of actual.artifacts.populationStatistics.entries()) {
    expect(await materialize(source)).toEqual(await materialize(expected.artifacts.populationStatistics[index]!));
    await source.dispose?.(); await expected.artifacts.populationStatistics[index]!.dispose?.();
  }
  expect(await packed.memory.count(actual.artifacts.assignments)).toBeGreaterThan(0);
});
