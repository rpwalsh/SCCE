// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
import { BOUNDARY_FEATURE_ORDER, BOUNDARY_STATISTICS_SCHEMA, compileBoundaryStatistics, type BoundaryStatisticsRow } from "./boundary-estimator.js";
import type { BoundaryStatisticsCursor, BoundaryStatisticsCursorHeader, CorpusSegmentationScratch, CorpusSegmentationScratchRow } from "./corpus-segmentation-cursor.js";
import { segmentationOrdinalKey, segmentationScratchRows, sortSegmentationScratch } from "./corpus-segmentation-sort.js";
import { createHasher, toJsonValue } from "./primitives.js";
import type { Hasher, JsonValue } from "./types.js";

function record(value: JsonValue): Record<string, JsonValue> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("invalid segmentation scratch record");
  return value;
}
function string(value: JsonValue | undefined): string { if (typeof value !== "string") throw new Error("invalid segmentation scratch string"); return value; }
function integer(value: JsonValue | undefined): number { if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) throw new Error("invalid segmentation scratch integer"); return value; }
function decode(value: JsonValue): BoundaryStatisticsRow {
  const row = record(value);
  if (!Array.isArray(row.featuresFixed)) throw new Error("invalid segmentation scratch features");
  const featuresFixed = row.featuresFixed.map(integer);
  const key = string(row.key);
  if (featuresFixed.length !== BOUNDARY_FEATURE_ORDER.length || key !== featuresFixed.join(":") || featuresFixed.some(value => value > 1_000_000)) throw new Error("noncanonical segmentation scratch features");
  return { key, featuresFixed, anchoredPositiveMass: integer(row.anchoredPositiveMass), anchoredNegativeMass: integer(row.anchoredNegativeMass),
    latentPositiveMass: integer(row.latentPositiveMass), latentNegativeMass: integer(row.latentNegativeMass),
    positiveMass: integer(row.positiveMass), negativeMass: integer(row.negativeMass) };
}
function add(left: number, right: number): number { const sum = left + right; if (!Number.isSafeInteger(sum)) throw new Error("boundary sufficient statistics exceed exact integer range"); return sum; }

async function disposeAll(operations: readonly (() => Promise<void>)[]): Promise<void> {
  const failures: unknown[] = [];
  for (const operation of operations) try { await operation(); } catch (error) { failures.push(error); }
  if (failures.length === 1) throw failures[0];
  if (failures.length) throw new AggregateError(failures, "boundary statistics scratch cleanup failed");
}

export function openPagedBoundaryStatistics(input: { header: BoundaryStatisticsCursorHeader; scratch: CorpusSegmentationScratch;
  storage: { rowsCollection: string; sourceDocumentsCollection: string } }): BoundaryStatisticsCursor {
  const { scratch, storage, header } = input;
  return { header, storage,
    async *rows() { for await (const page of scratch.pages({ collection: storage.rowsCollection, pageRows: scratch.pageRows, maxPageBytes: scratch.maxPageBytes })) yield page.map(item => decode(item.value)); },
    async *sourceDocuments() { for await (const page of scratch.pages({ collection: storage.sourceDocumentsCollection, pageRows: scratch.pageRows, maxPageBytes: scratch.maxPageBytes })) yield page.map(item => string(record(item.value).id)); },
    async dispose() { await disposeAll([() => scratch.deleteCollection(storage.rowsCollection), () => scratch.deleteCollection(storage.sourceDocumentsCollection)]); } };
}

type MergeInput = { sources: () => AsyncIterable<BoundaryStatisticsCursor>; scratch: CorpusSegmentationScratch;
  populationId: string; collectionPrefix: string; hasher?: Hasher };

export async function mergePagedBoundaryStatistics(input: MergeInput): Promise<BoundaryStatisticsCursor> {
  const lease = input.scratch.boundaryMergeScratch?.();
  if (!lease) return mergePagedBoundaryStatisticsInner(input);
  try {
    // The private algorithm never reacquires a factory, even if the leased scratch also exposes one.
    const cursor = await mergePagedBoundaryStatisticsInner({ ...input, scratch: lease.scratch });
    let disposal: Promise<void> | undefined;
    return { ...cursor, dispose() {
      return disposal ??= disposeAll([() => cursor.dispose?.() ?? Promise.resolve(), () => lease.dispose()]);
    } };
  } catch (error) {
    try { await lease.dispose(); }
    catch (cleanup) { throw new AggregateError([error, cleanup], "boundary statistics merge and scratch cleanup failed"); }
    throw error;
  }
}

async function mergePagedBoundaryStatisticsInner(input: MergeInput): Promise<BoundaryStatisticsCursor> {
  const store = input.scratch; const prefix = input.collectionPrefix;
  const rawRows = `${prefix}.rawRows`; const rawDocuments = `${prefix}.rawDocuments`;
  await store.deleteCollection(rawRows); await store.deleteCollection(rawDocuments);
  let normalizationContractId: string | undefined; let sourcePopulation: string | undefined; let rowOrdinal = 0; let sourceOrdinal = 0;
  for await (const source of input.sources()) {
    const header = source.header;
    if (header.schema !== BOUNDARY_STATISTICS_SCHEMA || header.scale !== 1_000_000 || header.featureOrder.join("\u001f") !== BOUNDARY_FEATURE_ORDER.join("\u001f")
      || normalizationContractId !== undefined && normalizationContractId !== header.normalizationContractId
      || sourcePopulation !== undefined && sourcePopulation !== header.populationId) throw new Error("boundary statistics merge requires one schema and population");
    normalizationContractId = header.normalizationContractId; sourcePopulation = header.populationId;
    let count = 0; let positive = 0; let negative = 0;
    for await (const page of source.rows()) {
      await store.putMany(rawRows, page.map(row => {
        const value = decode({ ...row }); count++; positive = add(positive, value.positiveMass); negative = add(negative, value.negativeMass);
        return { orderKey: segmentationOrdinalKey(rowOrdinal++), value: { ...value } };
      }));
    }
    if (count !== header.rowCount || positive !== header.positiveMass || negative !== header.negativeMass) throw new Error("boundary cursor inventory changed during merge");
    let documents = 0;
    for await (const page of source.sourceDocuments()) {
      await store.putMany(rawDocuments, page.map(id => { documents++; const first = sourceOrdinal++; return {
        orderKey: segmentationOrdinalKey(first), value: { id, first } }; }));
    }
    if (documents !== header.sourceInventory.count) throw new Error("boundary source inventory changed during merge");
  }
  if (normalizationContractId === undefined) normalizationContractId = compileBoundaryStatistics({ populationId: input.populationId, observations: [], hasher: input.hasher ?? createHasher() }).normalizationContractId;
  const sortedRows = `${prefix}.sortedRows`;
  await sortSegmentationScratch(store, rawRows, sortedRows, (left, right) => string(record(left.value).key).localeCompare(string(record(right.value).key)));
  const rowsCollection = `${prefix}.rows`; await store.deleteCollection(rowsCollection);
  let pending: BoundaryStatisticsRow | undefined; let rowCount = 0; let positiveMass = 0; let negativeMass = 0; let anchoredMass = 0; let latentMass = 0; let signals = 0;
  const signalKinds = new Set<string>(); let buffer: CorpusSegmentationScratchRow[] = []; let bufferBytes = 0;
  const flush = async () => { if (buffer.length) await store.putMany(rowsCollection, buffer); buffer = []; bufferBytes = 0; };
  const finish = async () => {
    if (!pending) return;
    pending.positiveMass = add(pending.anchoredPositiveMass, pending.latentPositiveMass);
    pending.negativeMass = add(pending.anchoredNegativeMass, pending.latentNegativeMass);
    if (pending.positiveMass + pending.negativeMass <= 0) return;
    positiveMass = add(positiveMass, pending.positiveMass); negativeMass = add(negativeMass, pending.negativeMass);
    const anchored = add(pending.anchoredPositiveMass, pending.anchoredNegativeMass); const latent = add(pending.latentPositiveMass, pending.latentNegativeMass);
    anchoredMass = add(anchoredMass, anchored); latentMass = add(latentMass, latent);
    if (anchored) { signalKinds.add("external_anchor"); signals++; }
    if (latent) { signalKinds.add("packed_forest_marginal"); signals++; }
    const output = { orderKey: segmentationOrdinalKey(rowCount++), value: { ...pending } };
    const bytes = Buffer.byteLength(JSON.stringify(output));
    if (bytes > store.maxPageBytes) throw new Error("segmentation scratch row exceeds declared page bytes");
    if (buffer.length && bufferBytes + bytes > store.maxPageBytes) await flush();
    buffer.push(output); bufferBytes += bytes;
    if (buffer.length >= store.pageRows) await flush();
  };
  for await (const item of segmentationScratchRows(store, sortedRows)) {
    const row = decode(item.value);
    if (!pending || pending.key !== row.key) { await finish(); pending = row; continue; }
    pending.anchoredPositiveMass = add(pending.anchoredPositiveMass, row.anchoredPositiveMass);
    pending.anchoredNegativeMass = add(pending.anchoredNegativeMass, row.anchoredNegativeMass);
    pending.latentPositiveMass = add(pending.latentPositiveMass, row.latentPositiveMass);
    pending.latentNegativeMass = add(pending.latentNegativeMass, row.latentNegativeMass);
  }
  await finish(); await flush();
  const documentsById = `${prefix}.documentsById`;
  await sortSegmentationScratch(store, rawDocuments, documentsById, (left, right) => {
    const a = string(record(left.value).id); const b = string(record(right.value).id);
    return a < b ? -1 : a > b ? 1 : integer(record(left.value).first) - integer(record(right.value).first);
  });
  const uniqueDocuments = `${prefix}.uniqueDocuments`; await store.deleteCollection(uniqueDocuments);
  let previous: string | undefined; let documentCount = 0;
  for await (const item of segmentationScratchRows(store, documentsById)) {
    const id = string(record(item.value).id);
    if (id === previous) continue;
    previous = id;
    await store.putMany(uniqueDocuments, [{ orderKey: segmentationOrdinalKey(documentCount++), value: item.value }]);
  }
  const documentsCollection = uniqueDocuments;
  const encoder = new TextEncoder();
  async function* documentBytes() { yield encoder.encode("["); let first = true;
    for await (const item of segmentationScratchRows(store, documentsCollection)) { if (!first) yield encoder.encode(","); first = false; yield encoder.encode(JSON.stringify(string(record(item.value).id))); }
    yield encoder.encode("]"); }
  const sourceInventory = { id: `boundary_sources.${await store.digestChunks(documentBytes())}`, count: documentCount };
  async function* canonicalBytes() {
    yield encoder.encode(JSON.stringify({ schema: BOUNDARY_STATISTICS_SCHEMA, populationId: input.populationId, normalizationContractId,
      featureOrder: BOUNDARY_FEATURE_ORDER, scale: 1_000_000 }).slice(0, -1) + ',"rows":[');
    let first = true;
    for await (const item of segmentationScratchRows(store, rowsCollection)) { if (!first) yield encoder.encode(","); first = false; yield encoder.encode(JSON.stringify(decode(item.value))); }
    yield encoder.encode('],"sourceDocumentIds":');
    yield* documentBytes(); yield encoder.encode("}");
  }
  const id = `boundary_statistics.${(await store.digestChunks(canonicalBytes())).slice(0, 40)}`;
  for (const collection of [rawRows, rawDocuments, sortedRows, documentsById]) await store.deleteCollection(collection);
  return openPagedBoundaryStatistics({ scratch: store, storage: { rowsCollection, sourceDocumentsCollection: documentsCollection }, header: { schema: BOUNDARY_STATISTICS_SCHEMA, populationId: input.populationId, normalizationContractId, featureOrder: BOUNDARY_FEATURE_ORDER,
    scale: 1_000_000, rowCount, sourceInventory, id, positiveMass, negativeMass, anchoredMass, latentMass,
    audit: toJsonValue({ compiler: "kernel.boundary_statistics.v2", normalizationContractId, exactIntegerMass: true, canonicalRowOrder: true,
      detectorDecisionsAcceptedAsLabels: false, rows: rowCount, signals, signalKinds: [...signalKinds].sort(), anchoredMass, latentMass, sourceDocuments: documentCount }) } });
}
