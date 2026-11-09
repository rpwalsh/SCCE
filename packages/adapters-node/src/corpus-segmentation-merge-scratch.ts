// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
import type { CorpusSegmentationScratch, CorpusSegmentationScratchRow, JsonValue } from "@scce/kernel";
import { durableJoinProgramJsonByteLengths } from "./durable-join-program-storage.js";
import { createBoundaryFitNumericFile } from "./boundary-fit-numeric-file.js";

export const BOUNDARY_MERGE_PAGE_SCHEMA = "scce.boundary_merge_scratch_page.v1";
const invalid = (): never => { throw Error("Invalid packed boundary merge scratch"); };
const ascii = (key: string, empty = false) => typeof key === "string" && (empty || key.length > 0) && /^[\x20-\x7e]*$/u.test(key);
function logical(value: JsonValue): CorpusSegmentationScratchRow {
  if (!value || typeof value !== "object" || Array.isArray(value) || typeof value.orderKey !== "string"
    || !ascii(value.orderKey) || !Object.hasOwn(value, "value")) return invalid();
  return { ...value, orderKey: value.orderKey, value: value.value! };
}

/** The existing merge algorithm alone acquires this ordered temporary storage lease. */
export function withPackedBoundaryMerges(store: CorpusSegmentationScratch): CorpusSegmentationScratch {
  return { ...store, boundaryMergeScratch: () => createPackedBoundaryMergeScratch(store),
    boundaryFitNumericReplay: store.boundaryFitNumericReplay ?? (() => createBoundaryFitNumericFile(store)) };
}

/** One pending physical page coalesces singleton writes without retaining one buffer per sort run. */
export function createPackedBoundaryMergeScratch(store: CorpusSegmentationScratch): { scratch: CorpusSegmentationScratch; dispose(): Promise<void> } {
  const owned = new Set<string>(), states = new Map<string, { count: number; lastKey: string }>();
  let pending: { collection: string; rows: CorpusSegmentationScratchRow[]; bytes: number; headerBytes: number } | undefined;
  let disposed = false;
  const active = () => { if (disposed) throw Error("Boundary merge scratch lease is disposed"); };
  const headerBase = durableJoinProgramJsonByteLengths({ orderKey: "", value: { schema: BOUNDARY_MERGE_PAGE_SCHEMA, rows: [] } }).decodedJsonbBytes;
  const headerBytes = (key: string) => headerBase + Buffer.byteLength(JSON.stringify(key));
  const flush = async () => {
    if (!pending?.rows.length) return;
    const page = pending;
    const value: JsonValue = JSON.parse(JSON.stringify({ schema: BOUNDARY_MERGE_PAGE_SCHEMA, rows: page.rows }));
    await store.putMany(page.collection, [{ orderKey: page.rows[0]!.orderKey, value }]);
    pending = undefined;
  };
  const scratch: CorpusSegmentationScratch = {
    pageRows: store.pageRows, maxPageBytes: store.maxPageBytes,
    async putMany(collection, rows) {
      active();
      if (pending && pending.collection !== collection) await flush();
      for (const input of rows) {
        const row = logical(JSON.parse(JSON.stringify(input)) as JsonValue), state = states.get(collection) ?? { count: 0, lastKey: "" };
        if (row.orderKey <= state.lastKey) throw Error("Boundary merge scratch requires ordered append or collection reset");
        const bytes = durableJoinProgramJsonByteLengths(row).decodedJsonbBytes + 2;
        if (headerBytes(row.orderKey) + bytes > store.maxPageBytes) throw Error("Boundary merge scratch row exceeds decoded page bytes");
        if (pending && pending.headerBytes + pending.bytes + bytes > store.maxPageBytes) await flush();
        pending ??= { collection, rows: [], bytes: 0, headerBytes: headerBytes(row.orderKey) };
        pending.rows.push(row); pending.bytes += bytes;
        state.count++; state.lastKey = row.orderKey;
        if (!Number.isSafeInteger(state.count)) return invalid();
        states.set(collection, state); owned.add(collection);
      }
    },
    async *pages(query) {
      active(); await flush();
      if (!Number.isSafeInteger(query.pageRows) || query.pageRows < 1 || query.pageRows > store.pageRows
        || !Number.isSafeInteger(query.maxPageBytes) || query.maxPageBytes < 1 || query.maxPageBytes > store.maxPageBytes
        || !ascii(query.afterKey ?? "", true) || !ascii(query.prefix ?? "", true)) return invalid();
      let previous = "", count = 0, output: CorpusSegmentationScratchRow[] = [], bytes = 0;
      const expectedCount = states.get(query.collection)?.count;
      for await (const physical of store.pages({ collection: query.collection, pageRows: 1, maxPageBytes: store.maxPageBytes })) for (const stored of physical) {
        if (!stored.value || typeof stored.value !== "object" || Array.isArray(stored.value)
          || stored.value.schema !== BOUNDARY_MERGE_PAGE_SCHEMA || !Array.isArray(stored.value.rows) || !stored.value.rows.length) return invalid();
        let first = true;
        for (const value of stored.value.rows) {
          const row = logical(value);
          if (first && stored.orderKey !== row.orderKey || row.orderKey <= previous) return invalid();
          first = false; previous = row.orderKey; count++;
          if (query.afterKey && row.orderKey <= query.afterKey || query.prefix && !row.orderKey.startsWith(query.prefix)) continue;
          const size = durableJoinProgramJsonByteLengths(row).decodedJsonbBytes + 2;
          if (size > query.maxPageBytes) throw Error("Boundary merge scratch row exceeds requested decoded page bytes");
          if (output.length && (output.length >= query.pageRows || bytes + size > query.maxPageBytes)) { yield output; output = []; bytes = 0; }
          output.push(row); bytes += size;
        }
      }
      if (expectedCount !== undefined && count !== expectedCount) return invalid();
      if (output.length) yield output;
    },
    async count(collection) {
      let count = 0;
      for await (const page of scratch.pages({ collection, pageRows: store.pageRows, maxPageBytes: store.maxPageBytes })) count += page.length;
      if (!Number.isSafeInteger(count)) return invalid();
      return count;
    },
    async deleteCollection(collection) {
      active();
      if (pending?.collection === collection) pending = undefined;
      await store.deleteCollection(collection); states.delete(collection); owned.delete(collection);
    },
    digestChunks: chunks => store.digestChunks(chunks)
  };
  return { scratch, async dispose() {
    if (disposed && !owned.size) return;
    disposed = true; pending = undefined; states.clear();
    const errors: unknown[] = [];
    for (const collection of owned) {
      try { await store.deleteCollection(collection); owned.delete(collection); } catch (error) { errors.push(error); }
    }
    if (errors.length) throw new AggregateError(errors, "Could not dispose boundary merge scratch pages");
  } };
}
