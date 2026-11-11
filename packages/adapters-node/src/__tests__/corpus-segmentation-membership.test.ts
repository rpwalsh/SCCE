// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { expect, it, vi } from "vitest";
import { boundaryContextKey, canonicalStringify, createHasher, measureSurfaceBoundaries, type JsonValue } from "@scce/kernel";
import { fixtureSegmentationScratch } from "../../../kernel/src/__tests__/fixtures/corpus-segmentation-scratch.js";
import { corpusSegmentationWindows } from "../corpus-segmentation-windows.js";
import { CORPUS_COUNT_PAGE_SCHEMA, corpusCountPageEntries, corpusMembershipHash, prepareCorpusMembershipCounts, readCorpusMembershipCounts, writeCorpusMembershipPages,
  type CorpusMembershipRun, type CorpusMembershipStorage } from "../corpus-segmentation-membership.js";
import { decodedJsonByteLengths } from "../decoded-json-byte-ledger.js";
import * as decodedJson from "../decoded-json-byte-ledger.js";
import { corpusMembershipSqlFixture } from "./fixtures/corpus-membership-sql.js";

function fixture(pageRows = 2, maxPageBytes = 12000) {
  const memory = fixtureSegmentationScratch(pageRows, maxPageBytes), calls: Array<{ sql: string; params: unknown[] }> = [];
  const writes: Array<{ collection: string; bytes: number; members: number }> = [];
  const reads: Array<{ collection: string; pageRows: number | undefined }> = [];
  const bounds = { pageRows, maxPageBytes };
  let accessible = true, blockSize = 8192;
  const run: CorpusMembershipRun = { run: { runId: "owned", recipeId: "scce.corpus_segmentation_input.v2:256" }, bounds,
    scratch: { ...memory, pages: query => memory.pages({ ...query, collection: `scratch/${query.collection}` }),
      putMany: async (collection, rows) => { for (const row of rows) { const value = row.value as Record<string, JsonValue>;
        writes.push({ collection, bytes: decodedJsonByteLengths(row).decodedJsonbBytes + 2, members: (value.entries as JsonValue[]).length }); }
        await memory.putMany(`scratch/${collection}`, rows); },
      count: collection => memory.count(`scratch/${collection}`), deleteCollection: collection => memory.deleteCollection(`scratch/${collection}`) },
    pages: (collection, query) => { reads.push({ collection, pageRows: query?.pageRows }); return memory.pages({ ...bounds, ...query, collection }); },
    putInput: (collection, rows) => memory.putMany(`input/${collection}`, rows), assertState: async () => { if (!accessible) throw Error("inaccessible run"); } };
  const storage: CorpusMembershipStorage = { table: name => `"fixture"."${name}"`,
    informationAccessPredicate: (alias, index) => ({ sql: `${alias}.information_label->>'tenantId'=$${index}`, params: ["owner"] }),
    query: async <T>(sql: string, params: unknown[] = []): Promise<T[]> => {
      calls.push({ sql, params });
      const indexes = [...sql.matchAll(/\$(\d+)/gu)].map(match => Number(match[1]));
      expect(Math.max(...indexes)).toBe(params.length);
      if (!accessible) return [];
      const result = await corpusMembershipSqlFixture(sql, params, memory, blockSize);
      if (!result) throw Error("unimplemented membership SQL");
      return result as T[];
    } };
  return { memory, run, storage, calls, writes, reads, deny: () => { accessible = false; }, setBlockSize: (bytes: number) => { blockSize = bytes; } };
}

it("packs genuine human Unicode memberships and preserves every exact per-pair count without permanent pair rows", async () => {
  const f = fixture(16, 12000), hasher = createHasher();
  const text = (JSON.parse(readFileSync(new URL("../../../kernel/src/__tests__/fixtures/dolly-human-16.json", import.meta.url), "utf8")) as { text: string }).text;
  expect(hasher.digestHex(text)).toBe("307c6758d4173c6dd87d0b77460c74fafe62c3e58d934eabbf5e05268de3dadc");
  const texts = [text, "雪🧭é opaque 雪🧭é. opaque 反向 雪🧭é."], classes = new Map<string, Set<string>>(), contexts = new Map<string, Set<string>>();
  await f.memory.putMany("input/inventory", texts.map((_, index) => ({ orderKey: String(index), value: { evidenceId: `evidence.${index}`, sourceVersionId: `source.${index}` } })));
  let pairCount = 0;
  for (const [index, source] of texts.entries()) {
    const documentId = `evidence.${index}`; let ordinal = 0;
    for await (const window of corpusSegmentationWindows((async function* () { for (let start = 0; start < source.length; start += 128) yield source.slice(start, start + 128); })(), 256)) {
      const measured = measureSurfaceBoundaries({ documentId, text: window.text, maxUnits: Number.MAX_SAFE_INTEGER });
      const classIds = new Set<string>(), pairs = new Map<string, readonly [string, string]>();
      for (const unit of measured.units) if (unit.overlapClass !== "base_partition") {
        const classId = unit.surfaceFormClassId, key = boundaryContextKey(unit);
        const docs = classes.get(classId) ?? new Set<string>(); docs.add(documentId); classes.set(classId, docs);
        const members = contexts.get(key) ?? new Set<string>(); members.add(classId); contexts.set(key, members);
        classIds.add(classId); pairs.set(JSON.stringify([key, classId]), [key, classId]);
      }
      pairCount += classIds.size + pairs.size;
      const owner = { windowKey: `${index}:${String(++ordinal).padStart(16, "0")}`, documentId, sourceVersionId: `source.${index}` };
      await writeCorpusMembershipPages(f.run, { ...owner, kind: "class", entries: classIds });
      await writeCorpusMembershipPages(f.run, { ...owner, kind: "context", entries: pairs.values() });
    }
  }
  expect(f.writes.every(write => write.bytes <= f.run.bounds.maxPageBytes)).toBe(true);
  expect(f.writes.some(write => write.members > f.run.bounds.pageRows)).toBe(true);
  expect(f.writes.length).toBeLessThan(pairCount / 8);
  const digests = await prepareCorpusMembershipCounts(f.storage, f.run, { id: "owned.inventory", count: texts.length });
  const referenceDigest = (pairs: Map<string, Set<string>>) => {
    const digest = createHash("sha256");
    for (const [key, members] of [...pairs].sort(([a], [b]) => {
      const left = corpusMembershipHash(a), right = corpusMembershipHash(b);
      return left < right ? -1 : left > right ? 1 : Buffer.compare(Buffer.from(a), Buffer.from(b));
    })) { digest.update(canonicalStringify([key, members.size])); digest.update("\n"); }
    return { id: `sha256:${digest.digest("hex")}`, count: pairs.size };
  };
  expect(digests).toEqual({ classDigest: referenceDigest(classes), contextDigest: referenceDigest(contexts) });
  expect(await readCorpusMembershipCounts(f.storage, f.run, "class", [...classes.keys(), "unseen 雪"])).toEqual({ ...Object.fromEntries([...classes].map(([key, docs]) => [key, docs.size])), "unseen 雪": 0 });
  expect(await readCorpusMembershipCounts(f.storage, f.run, "context", [...contexts.keys(), "unseen 🧭"])).toEqual({ ...Object.fromEntries([...contexts].map(([key, members]) => [key, members.size])), "unseen 🧭": 0 });
  for (const kind of ["class", "context"]) {
    expect(await f.memory.count(`scratch/producer/${kind}-membership`)).toBe(0);
    for await (const page of f.memory.pages({ collection: `input/${kind}-counts`, ...f.run.bounds })) for (const row of page) {
      expect(decodedJsonByteLengths(row).decodedJsonbBytes + 2).toBeLessThanOrEqual(f.run.bounds.maxPageBytes);
      expect(corpusCountPageEntries(row.value).length).toBeGreaterThan(0);
    }
  }
  expect(await f.memory.count("input/class-documents")).toBe(0);
  expect(await f.memory.count("input/context-classes")).toBe(0);
  const aggregations = f.calls.filter(call => call.sql.includes("exact_counts AS MATERIALIZED"));
  expect(aggregations).toHaveLength(2);
  expect(aggregations.every(call => call.sql.includes('COUNT(DISTINCT') && call.sql.includes('COLLATE "C"') && call.sql.includes("ON CONFLICT(run_id,collection,order_key) DO NOTHING"))).toBe(true);
  expect(aggregations.every(call => call.sql.includes("FOR SHARE OF r"))).toBe(true);
  expect(f.reads.filter(read => /input\/(class|context)-counts/u.test(read.collection)).every(read => read.pageRows === 1)).toBe(true);
  const before = aggregations.length;
  await prepareCorpusMembershipCounts(f.storage, f.run, { id: "owned.inventory", count: texts.length });
  expect(f.calls.filter(call => call.sql.includes("exact_counts AS MATERIALIZED"))).toHaveLength(before);
});

it("keeps feature-count identity independent of physical page boundaries and duplicate windows", async () => {
  const results = [];
  for (const maxPageBytes of [1200, 12000]) {
    const f = fixture(1, maxPageBytes);
    await f.memory.putMany("input/inventory", [{ orderKey: "owner", value: { evidenceId: "owner.雪", sourceVersionId: "version.🧭" } }]);
    for (let window = 0; window < 2; window++) {
      const owner = { windowKey: String(window), documentId: "owner.雪", sourceVersionId: "version.🧭" };
      await writeCorpusMembershipPages(f.run, { ...owner, kind: "class", entries: Array.from({ length: 40 }, (_, index) => `class.${index}.雪`) });
      await writeCorpusMembershipPages(f.run, { ...owner, kind: "context", entries: Array.from({ length: 40 }, (_, index) => ["same.context", `class.${index}.雪`] as const) });
    }
    results.push(await prepareCorpusMembershipCounts(f.storage, f.run, { id: "same.inventory", count: 1 }));
    expect(await readCorpusMembershipCounts(f.storage, f.run, "context", ["same.context", "never observed"])).toEqual({ "same.context": 40, "never observed": 0 });
    expect(await readCorpusMembershipCounts(f.storage, f.run, "class", ["class.1.雪"])).toEqual({ "class.1.雪": 1 });
  }
  expect(results[0]).toEqual(results[1]);
});

it("refuses foreign source membership, changed count receipts and inaccessible runs", async () => {
  const f = fixture();
  await f.memory.putMany("input/inventory", [{ orderKey: "owner", value: { evidenceId: "owner", sourceVersionId: "version" } }]);
  await writeCorpusMembershipPages(f.run, { kind: "class", windowKey: "0", documentId: "owner", sourceVersionId: "foreign", entries: ["class"] });
  await expect(prepareCorpusMembershipCounts(f.storage, f.run, { id: "inventory", count: 1 })).rejects.toThrow(/membership pages/);
  await f.memory.deleteCollection("scratch/producer/class-membership");
  await writeCorpusMembershipPages(f.run, { kind: "class", windowKey: "0", documentId: "owner", sourceVersionId: "version", entries: ["class"] });
  await prepareCorpusMembershipCounts(f.storage, f.run, { id: "inventory", count: 1 });
  await expect(prepareCorpusMembershipCounts(f.storage, f.run, { id: "changed", count: 1 })).rejects.toThrow(/membership pages/);
  await f.memory.deleteCollection("input/class-counts");
  await expect(prepareCorpusMembershipCounts(f.storage, f.run, { id: "inventory", count: 1 })).rejects.toThrow(/membership pages/);
  f.deny();
  await expect(readCorpusMembershipCounts(f.storage, f.run, "class", ["class"])).rejects.toThrow(/membership pages/);
});

it("refuses an entry that cannot fit its decoded operational page budget", async () => {
  const f = fixture(1, 400);
  await expect(writeCorpusMembershipPages(f.run, { kind: "class", windowKey: "0", documentId: "owner", sourceVersionId: "version", entries: ["雪".repeat(1000)] })).rejects.toThrow(/decoded JSON page budget/);
  expect(f.writes).toEqual([]);
});

it("sizes the immutable source header once while writing many bounded pages", async () => {
  const f = fixture(16, 1200), size = vi.spyOn(decodedJson, "decodedJsonByteLengths");
  try {
    await writeCorpusMembershipPages(f.run, { kind: "class", windowKey: "0", documentId: "owner", sourceVersionId: "version",
      entries: Array.from({ length: 100 }, (_, index) => `class.${index}.雪🧭`) });
    const headers = size.mock.calls.filter(([value]) => value !== null && typeof value === "object" && !Array.isArray(value)
      && "value" in value && Array.isArray((value as { value: { entries: unknown[] } }).value.entries)
      && (value as { value: { entries: unknown[] } }).value.entries.length === 0);
    expect(headers).toHaveLength(1);
    expect(f.writes.length).toBeGreaterThan(1);
    expect(f.writes.every(write => write.bytes <= f.run.bounds.maxPageBytes)).toBe(true);
  } finally { size.mockRestore(); }
});

it("materializes page fields before member joins and collates complete text expressions", async () => {
  const f = fixture();
  await f.memory.putMany("input/inventory", [{ orderKey: "owner", value: { evidenceId: "owner", sourceVersionId: "version" } }]);
  const owner = { windowKey: "0", documentId: "owner", sourceVersionId: "version" };
  await writeCorpusMembershipPages(f.run, { ...owner, kind: "class", entries: ["class.雪"] });
  await writeCorpusMembershipPages(f.run, { ...owner, kind: "context", entries: [["context.🧭", "class.雪"] as const] });
  await prepareCorpusMembershipCounts(f.storage, f.run, { id: "inventory", count: 1 });
  const aggregates = f.calls.filter(call => call.sql.includes("exact_counts AS MATERIALIZED"));
  const context = aggregates.find(call => call.params[4] === "context")!.sql;
  expect(context).toContain('(member.value->>0) COLLATE "C" AS key');
  expect(context).toContain('GROUP BY (member.value->>0) COLLATE "C"');
  expect(aggregates.find(call => call.params[4] === "class")!.sql).toContain('COUNT(DISTINCT (page.document_id) COLLATE "C")');
  for (const { sql } of aggregates) {
    expect(sql).toContain('jsonb_to_record(page.row_json) AS payload(schema text,kind text,"documentId" text,"sourceVersionId" text,entries jsonb)');
    expect(sql.split("exact_counts AS MATERIALIZED (")[1]!.split("), hash_groups")[0]).not.toContain("row_json");
  }
  expect(await readCorpusMembershipCounts(f.storage, f.run, "context", ["context.🧭"])).toEqual({ "context.🧭": 1 });
  const lookup = f.calls.find(call => call.sql.includes("located AS MATERIALIZED"))!.sql;
  expect(lookup).toContain('jsonb_to_record(leaf.row_json) AS payload(schema text,"endHash" text,entries jsonb)');
  expect(lookup.split(") SELECT q.key")[1]).not.toContain("row_json");
  expect(lookup).toContain("payload.entries->>q.key");
  expect(lookup).not.toContain("payload.entries->q.hash");
  expect(lookup).not.toContain("jsonb_array_elements");
  expect(lookup).not.toContain("page_members");
});

it("stores block-sized exact-key leaves and reuses their receipt capacity for bounded digest batches on another host", async () => {
  const f = fixture(4096, 65536), keys = ["1", "10", "2", "__proto__", "constructor", "é", "e\u0301", ...Array.from({ length: 1600 }, (_, index) => `class.雪🧭.${index}`)];
  await f.memory.putMany("input/inventory", [{ orderKey: "owner", value: { evidenceId: "owner", sourceVersionId: "version" } }]);
  await writeCorpusMembershipPages(f.run, { kind: "class", windowKey: "0", documentId: "owner", sourceVersionId: "version", entries: keys });
  const first = await prepareCorpusMembershipCounts(f.storage, f.run, { id: "inventory", count: 1 });
  const fullKeys = new Set(keys);
  let leaves = 0, denser = false, beforeBytes = 0, afterBytes = 0, hashGroups = 0;
  for await (const page of f.memory.pages({ collection: "input/class-counts", ...f.run.bounds })) for (const row of page) {
    const value = row.value as Record<string, JsonValue>, entries = value.entries as Record<string, JsonValue>;
    expect(Object.values(entries).every(Number.isSafeInteger)).toBe(true);
    expect(Object.keys(entries).every(key => fullKeys.has(key))).toBe(true);
    const nested = new Map<string, Array<[string, JsonValue]>>();
    for (const [key, count] of Object.entries(entries)) {
      const hash = corpusMembershipHash(key), group = nested.get(hash) ?? []; group.push([key, count]); nested.set(hash, group);
    }
    const legacy = { ...row, value: { ...value, schema: "scce.corpus_segmentation_count_page.v2", entries: Object.fromEntries([...nested].map(([hash, members]) => [hash, Object.fromEntries(members)])) } };
    const currentBytes = decodedJsonByteLengths(row).decodedJsonbBytes + 2, previousBytes = decodedJsonByteLengths(legacy).decodedJsonbBytes + 2;
    expect(currentBytes).toBeLessThanOrEqual(8192); leaves++;
    beforeBytes += previousBytes; afterBytes += currentBytes; hashGroups += nested.size; denser ||= previousBytes > 8192;
  }
  expect(leaves).toBeGreaterThan(1);
  expect(denser).toBe(true);
  const hashFieldBytes = decodedJsonByteLengths({ ["0".repeat(64)]: { key: 1 } }).decodedJsonbBytes - decodedJsonByteLengths({ key: 1 }).decodedJsonbBytes;
  expect(beforeBytes - afterBytes).toBe(hashGroups * hashFieldBytes);
  expect(f.reads.filter(read => read.collection === "input/class-counts").every(read => read.pageRows === 8)).toBe(true);
  for await (const page of f.run.pages("input/class-counts", { pageRows: 8 }))
    expect(page.reduce((sum, row) => sum + decodedJsonByteLengths(row).decodedJsonbBytes + 2, 0)).toBeLessThanOrEqual(f.run.bounds.maxPageBytes);
  f.setBlockSize(16384); f.reads.length = 0;
  expect(await prepareCorpusMembershipCounts(f.storage, f.run, { id: "inventory", count: 1 })).toEqual(first);
  expect(f.reads.filter(read => read.collection === "input/class-counts").every(read => read.pageRows === 8)).toBe(true);
  expect(f.calls.filter(call => call.sql.includes("exact_counts AS MATERIALIZED"))).toHaveLength(2);
  expect(await readCorpusMembershipCounts(f.storage, f.run, "class", keys)).toEqual(Object.fromEntries(keys.map(key => [key, 1])));
  const aggregate = f.calls.find(call => call.sql.includes("exact_counts AS MATERIALIZED"))!.sql;
  expect(aggregate).toContain("LEAST($3,current_setting('block_size')::int)");
  expect(aggregate).toContain("jsonb_each(numbered.members)");
  expect(aggregate).toContain("jsonb_object_agg(member.key,member.value");
  expect(aggregate).toContain("FROM numbered CROSS JOIN LATERAL jsonb_each(numbered.members)");
});

it("retains an oversized atomic full key within the declared run budget as one variable-size leaf", async () => {
  const f = fixture(16, 65536), key = "雪".repeat(4000);
  await f.memory.putMany("input/inventory", [{ orderKey: "owner", value: { evidenceId: "owner", sourceVersionId: "version" } }]);
  await writeCorpusMembershipPages(f.run, { kind: "class", windowKey: "0", documentId: "owner", sourceVersionId: "version", entries: ["before", key, "after"] });
  await prepareCorpusMembershipCounts(f.storage, f.run, { id: "inventory", count: 1 });
  expect(await readCorpusMembershipCounts(f.storage, f.run, "class", [key, "before", "after", "unseen"])).toEqual({ [key]: 1, before: 1, after: 1, unseen: 0 });
  for await (const page of f.memory.pages({ collection: "input/class-counts", ...f.run.bounds })) for (const row of page)
    expect(decodedJsonByteLengths(row).decodedJsonbBytes + 2).toBeLessThanOrEqual(f.run.bounds.maxPageBytes);
});

it("validates a full 4096-key unordered response with linear key inspections", async () => {
  const f = fixture(4096, 1048576), keys = Array.from({ length: 4096 }, (_, index) => `unit.雪🧭.${index}`);
  let inspections = 0, queries = 0;
  const storage: CorpusMembershipStorage = { ...f.storage, query: async <T>(_sql: string, params: unknown[] = []): Promise<T[]> => {
    queries++;
    const requested = JSON.parse(String(params[2])) as Array<{ key: string; hash: string }>;
    expect(requested).toHaveLength(keys.length);
    return requested.reverse().map(item => ({ get key() { inspections++; return item.key; }, count: "7", valid: true })) as T[];
  } };
  expect(await readCorpusMembershipCounts(storage, f.run, "class", [...keys, keys[0]!])).toEqual(Object.fromEntries(keys.map(key => [key, 7])));
  expect(queries).toBe(1);
  expect(inspections).toBeLessThanOrEqual(keys.length * 4);
});

it.each(["duplicate", "foreign", "invalid_schema", "missing", "negative", "fractional", "overflow"])("retains strict response rejection for %s", async kind => {
  const f = fixture();
  const storage: CorpusMembershipStorage = { ...f.storage, query: async <T>(): Promise<T[]> => {
    const rows = [{ key: "owned.a", count: "1", valid: true }, { key: "owned.b", count: "2", valid: true }];
    if (kind === "duplicate") rows[1]!.key = "owned.a";
    if (kind === "foreign") rows[1]!.key = "foreign";
    if (kind === "invalid_schema") rows[1]!.valid = false;
    if (kind === "missing") rows.pop();
    if (kind === "negative") rows[1]!.count = "-1";
    if (kind === "fractional") rows[1]!.count = "1.5";
    if (kind === "overflow") rows[1]!.count = "9007199254740992";
    return rows as T[];
  } };
  await expect(readCorpusMembershipCounts(storage, f.run, "context", ["owned.a", "owned.b"])).rejects.toThrow(/membership pages/);
});

it("requires the exact Unicode full key even when another key occupies the same indexed range", async () => {
  const f = fixture(), requested = "雪🧭é", hash = corpusMembershipHash(requested);
  await f.memory.putMany("input/class-counts", [{ orderKey: hash, value: { schema: CORPUS_COUNT_PAGE_SCHEMA, endHash: hash, entries: { "another.雪": 99 } } }]);
  expect(await readCorpusMembershipCounts(f.storage, f.run, "class", [requested])).toEqual({ [requested]: 0 });
  await f.memory.putMany("input/class-counts", [{ orderKey: hash, value: { schema: CORPUS_COUNT_PAGE_SCHEMA, endHash: hash, entries: { [requested]: 3, "another.雪": 99 } } }]);
  expect(await readCorpusMembershipCounts(f.storage, f.run, "class", [requested])).toEqual({ [requested]: 3 });
});

it("retains empty and absent exact lookups and rejects the removed nested-hash representation", async () => {
  const f = fixture();
  expect(await readCorpusMembershipCounts(f.storage, f.run, "context", [])).toEqual({}); expect(f.calls).toEqual([]);
  expect(await readCorpusMembershipCounts(f.storage, f.run, "context", ["absent.雪"])).toEqual({ "absent.雪": 0 });
  const key = "key", hash = corpusMembershipHash(key);
  expect(() => corpusCountPageEntries({ schema: CORPUS_COUNT_PAGE_SCHEMA, endHash: hash, entries: { [hash]: { [key]: 1 } } })).toThrow(/membership pages/);
});

it("materializes only exact count scalars after one indexed predecessor leaf per requested key", async () => {
  const f=fixture(4096,65536),keys=["__proto__","constructor","e\u0301","\u00e9","\ud83e\udded","1","10","2"];
  for(const [index,key] of keys.entries()){
    const hash=corpusMembershipHash(key);
    await f.memory.putMany("input/class-counts",[{orderKey:hash,value:{schema:CORPUS_COUNT_PAGE_SCHEMA,endHash:hash,entries:{[key]:index+1}}}]);
  }
  expect(await readCorpusMembershipCounts(f.storage,f.run,"class",[...keys,"absent"])).toEqual({...Object.fromEntries(keys.map((key,index)=>[key,index+1])),absent:0});
  const sql=f.calls.at(-1)!.sql;
  expect(sql).not.toContain("selected_pages");
  expect(sql).toContain("SELECT q.key,matched.order_key,matched.count,matched.page_schema,matched.end_hash");
  expect(sql).toContain("FROM located q");
  expect(sql.split(") SELECT q.key")[1]).not.toContain("JOIN");
  expect(sql).toContain("payload.entries->>q.key AS count");
  expect(sql).toContain('ORDER BY v.order_key COLLATE "C" DESC LIMIT 1) leaf');
  expect(sql.indexOf("DESC LIMIT 1) leaf")).toBeLessThan(sql.indexOf("jsonb_to_record(leaf.row_json)"));
  expect(sql).toContain("q.order_key IS NULL OR (q.page_schema=");
  expect(sql).toContain('q.end_hash >= q.order_key COLLATE "C"');
  expect(sql.match(/r\.information_label->>'tenantId'/gu)).toHaveLength(2);
});

it.each(["schema","range"] as const)("rejects a malformed matched leaf %s after projecting its exact scalar",async fault=>{
  const f=fixture(),key="owned.\ud83e\udded",hash=corpusMembershipHash(key);
  await f.memory.putMany("input/class-counts",[{orderKey:hash,value:{schema:fault==="schema"?"foreign.schema":CORPUS_COUNT_PAGE_SCHEMA,
    endHash:fault==="range"?"0".repeat(64):hash,entries:{[key]:3}}}]);
  await expect(readCorpusMembershipCounts(f.storage,f.run,"class",[key])).rejects.toThrow(/membership pages/u);
});
