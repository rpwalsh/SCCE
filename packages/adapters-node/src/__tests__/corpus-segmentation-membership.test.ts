// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
import { readFileSync } from "node:fs";
import { expect, it } from "vitest";
import { boundaryContextKey, createHasher, measureSurfaceBoundaries, type JsonValue } from "@scce/kernel";
import { fixtureSegmentationScratch } from "../../../kernel/src/__tests__/fixtures/corpus-segmentation-scratch.js";
import { corpusSegmentationWindows } from "../corpus-segmentation-windows.js";
import { corpusCountPageEntries, prepareCorpusMembershipCounts, readCorpusMembershipCounts, writeCorpusMembershipPages,
  type CorpusMembershipRun, type CorpusMembershipStorage } from "../corpus-segmentation-membership.js";
import { durableJoinProgramJsonByteLengths } from "../durable-join-program-storage.js";
import { corpusMembershipSqlFixture } from "./fixtures/corpus-membership-sql.js";

function fixture(pageRows = 2, maxPageBytes = 12000) {
  const memory = fixtureSegmentationScratch(pageRows, maxPageBytes), calls: Array<{ sql: string; params: unknown[] }> = [];
  const writes: Array<{ collection: string; bytes: number; members: number }> = [];
  const bounds = { pageRows, maxPageBytes };
  let accessible = true;
  const run: CorpusMembershipRun = { run: { runId: "owned", recipeId: "scce.corpus_segmentation_input.v2:256" }, bounds,
    scratch: { ...memory, pages: query => memory.pages({ ...query, collection: `scratch/${query.collection}` }),
      putMany: async (collection, rows) => { for (const row of rows) { const value = row.value as Record<string, JsonValue>;
        writes.push({ collection, bytes: durableJoinProgramJsonByteLengths(row).decodedJsonbBytes + 2, members: (value.entries as JsonValue[]).length }); }
        await memory.putMany(`scratch/${collection}`, rows); },
      count: collection => memory.count(`scratch/${collection}`), deleteCollection: collection => memory.deleteCollection(`scratch/${collection}`) },
    pages: (collection, query) => memory.pages({ ...bounds, ...query, collection }),
    putInput: (collection, rows) => memory.putMany(`input/${collection}`, rows), assertState: async () => { if (!accessible) throw Error("inaccessible run"); } };
  const storage: CorpusMembershipStorage = { table: name => `"fixture"."${name}"`,
    informationAccessPredicate: (alias, index) => ({ sql: `${alias}.information_label->>'tenantId'=$${index}`, params: ["owner"] }),
    query: async <T>(sql: string, params: unknown[] = []): Promise<T[]> => {
      calls.push({ sql, params });
      const indexes = [...sql.matchAll(/\$(\d+)/gu)].map(match => Number(match[1]));
      expect(Math.max(...indexes)).toBe(params.length);
      if (!accessible) return [];
      const result = await corpusMembershipSqlFixture(sql, params, memory);
      if (!result) throw Error("unimplemented membership SQL");
      return result as T[];
    } };
  return { memory, run, storage, calls, writes, deny: () => { accessible = false; } };
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
  await prepareCorpusMembershipCounts(f.storage, f.run, { id: "owned.inventory", count: texts.length });
  expect(await readCorpusMembershipCounts(f.storage, f.run, "class", [...classes.keys(), "unseen 雪"])).toEqual({ ...Object.fromEntries([...classes].map(([key, docs]) => [key, docs.size])), "unseen 雪": 0 });
  expect(await readCorpusMembershipCounts(f.storage, f.run, "context", [...contexts.keys(), "unseen 🧭"])).toEqual({ ...Object.fromEntries([...contexts].map(([key, members]) => [key, members.size])), "unseen 🧭": 0 });
  for (const kind of ["class", "context"]) {
    expect(await f.memory.count(`scratch/producer/${kind}-membership`)).toBe(0);
    for await (const page of f.memory.pages({ collection: `input/${kind}-counts`, ...f.run.bounds })) for (const row of page) {
      expect(durableJoinProgramJsonByteLengths(row).decodedJsonbBytes + 2).toBeLessThanOrEqual(f.run.bounds.maxPageBytes);
      expect(corpusCountPageEntries(row.value).length).toBeGreaterThan(0);
    }
  }
  expect(await f.memory.count("input/class-documents")).toBe(0);
  expect(await f.memory.count("input/context-classes")).toBe(0);
  const aggregations = f.calls.filter(call => call.sql.includes("exact_counts AS MATERIALIZED"));
  expect(aggregations).toHaveLength(2);
  expect(aggregations.every(call => call.sql.includes('COUNT(DISTINCT') && call.sql.includes('COLLATE "C"') && call.sql.includes("ON CONFLICT(run_id,collection,order_key) DO NOTHING"))).toBe(true);
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
