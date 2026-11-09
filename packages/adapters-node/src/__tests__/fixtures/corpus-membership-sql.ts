// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
import type { CorpusSegmentationScratch, CorpusSegmentationScratchRow, JsonValue } from "@scce/kernel";
import { CORPUS_COUNT_PAGE_SCHEMA, CORPUS_MEMBERSHIP_SCHEMA, corpusMembershipHash } from "../../corpus-segmentation-membership.js";
import { durableJoinProgramJsonByteLengths } from "../../durable-join-program-storage.js";

export async function corpusMembershipSqlFixture(sql: string, params: unknown[], memory: CorpusSegmentationScratch, blockSize = 8192): Promise<unknown[] | undefined> {
  const all = async (collection: string) => {
    const rows: CorpusSegmentationScratchRow[] = [];
    for await (const page of memory.pages({ collection, pageRows: memory.pageRows, maxPageBytes: memory.maxPageBytes })) rows.push(...page);
    return rows;
  };
  if (sql.includes("WITH admitted_run AS MATERIALIZED")) {
    const kind = String(params[4]), collection = String(params[1]);
    const pages = await all(collection), owners = await all("input/inventory");
    const distinct = new Map<string, Set<string>>();
    for (const page of pages) {
      const value = page.value as Record<string, JsonValue>;
      if (value.schema !== CORPUS_MEMBERSHIP_SCHEMA || value.kind !== kind || !Array.isArray(value.entries)
        || !owners.some(owner => { const row = owner.value as Record<string, JsonValue>; return row.evidenceId === value.documentId && row.sourceVersionId === value.sourceVersionId; }))
        return [{ authorized: true, valid: false, expected: "0", matched: "0" }];
      for (const entry of value.entries) {
        if (kind === "class" ? typeof entry !== "string" : !Array.isArray(entry) || entry.length !== 2 || entry.some(member => typeof member !== "string"))
          return [{ authorized: true, valid: false, expected: "0", matched: "0" }];
        const key = kind === "class" ? String(entry) : String((entry as JsonValue[])[0]);
        const member = kind === "class" ? String(value.documentId) : String((entry as JsonValue[])[1]);
        const set = distinct.get(key) ?? new Set<string>(); set.add(member); distinct.set(key, set);
      }
    }
    const grouped = new Map<string, Array<[string, number]>>();
    for (const [key, members] of distinct) { const hash = corpusMembershipHash(key), group = grouped.get(hash) ?? []; group.push([key, members.size]); grouped.set(hash, group); }
    const entries = [...grouped].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([hash, members]) =>
      [hash, members.sort(([a], [b]) => Buffer.compare(Buffer.from(a), Buffer.from(b)))] as const);
    const stored: CorpusSegmentationScratchRow[] = [], target = Math.min(blockSize, Number(params[2]));
    let packed: Record<string, JsonValue> = {};
    const row = (entries: Record<string, JsonValue>): CorpusSegmentationScratchRow => {
      const hashes = Object.keys(entries).sort();
      const members = Object.fromEntries(Object.values(entries).flatMap(group => Object.entries(group as Record<string, JsonValue>)));
      return { orderKey: hashes[0]!, value: { schema: CORPUS_COUNT_PAGE_SCHEMA, endHash: hashes.at(-1)!, entries: members } };
    };
    for (const [hash, members] of entries) {
      const atomic = { [hash]: Object.fromEntries(members) }, candidate = { ...packed, ...atomic };
      const atomicBytes = durableJoinProgramJsonByteLengths(row(atomic)).decodedJsonbBytes + 2;
      if (atomicBytes > Number(params[2])) return [{ authorized: true, valid: false, expected: "0", matched: "0" }];
      if (Object.keys(packed).length && durableJoinProgramJsonByteLengths(row(candidate)).decodedJsonbBytes + 2 > target) { stored.push(row(packed)); packed = {}; }
      if (atomicBytes > target) stored.push(row(atomic)); else packed = { ...packed, ...atomic };
    }
    if (Object.keys(packed).length) stored.push(row(packed));
    await memory.putMany(`input/${kind}-counts`, stored);
    return [{ authorized: true, valid: true, expected: String(stored.length), matched: String(stored.length),
      leaf_byte_capacity: Math.max(target, ...stored.map(row => durableJoinProgramJsonByteLengths(row).decodedJsonbBytes + 2)) }];
  }
  if (sql.includes("selected_pages AS MATERIALIZED") && sql.includes("SELECT q.key")) {
    const requested = JSON.parse(String(params[2])) as Array<{ key: string; hash: string }>;
    const pages = await all(String(params[1]));
    return requested.map(request => {
      const page = pages.filter(page => page.orderKey <= request.hash).at(-1), value = page?.value as Record<string, JsonValue> | undefined;
      const entries = value?.entries as Record<string, JsonValue> | undefined;
      const found = entries && Object.hasOwn(entries, request.key) ? entries[request.key] : 0;
      return { key: request.key, count: String(found ?? 0), valid: !page || value?.schema === CORPUS_COUNT_PAGE_SCHEMA && String(value.endHash) >= page.orderKey };
    });
  }
  return undefined;
}
