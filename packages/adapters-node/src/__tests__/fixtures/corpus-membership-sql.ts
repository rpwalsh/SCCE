// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
import type { CorpusSegmentationScratch, CorpusSegmentationScratchRow, JsonValue } from "@scce/kernel";
import { CORPUS_COUNT_PAGE_SCHEMA, CORPUS_MEMBERSHIP_SCHEMA, corpusMembershipHash } from "../../corpus-segmentation-membership.js";
import { durableJoinProgramJsonByteLengths } from "../../durable-join-program-storage.js";

export async function corpusMembershipSqlFixture(sql: string, params: unknown[], memory: CorpusSegmentationScratch): Promise<unknown[] | undefined> {
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
    const stored: CorpusSegmentationScratchRow[] = [];
    let packed: JsonValue[] = [];
    const row = (entries: JsonValue[]): CorpusSegmentationScratchRow => ({ orderKey: String((entries[0] as JsonValue[])[0]),
      value: { schema: CORPUS_COUNT_PAGE_SCHEMA, endHash: String((entries.at(-1) as JsonValue[])[0]), entries } });
    for (const entry of entries) {
      const value: JsonValue = [entry[0], entry[1]];
      if (durableJoinProgramJsonByteLengths(row([value])).decodedJsonbBytes + 2 > Number(params[2])) return [{ authorized: true, valid: false, expected: "0", matched: "0" }];
      if (packed.length && durableJoinProgramJsonByteLengths(row([...packed, value])).decodedJsonbBytes + 2 > Number(params[2])) { stored.push(row(packed)); packed = []; }
      packed.push(value);
    }
    if (packed.length) stored.push(row(packed));
    await memory.putMany(`input/${kind}-counts`, stored);
    return [{ authorized: true, valid: true, expected: String(stored.length), matched: String(stored.length) }];
  }
  if (sql.includes("page_members AS MATERIALIZED") && sql.includes("SELECT q.key")) {
    const requested = JSON.parse(String(params[2])) as Array<{ key: string; hash: string }>;
    const pages = await all(String(params[1]));
    return requested.map(request => {
      const page = pages.filter(page => page.orderKey <= request.hash).at(-1), value = page?.value as Record<string, JsonValue> | undefined;
      const groups = value?.entries as JsonValue[][] | undefined;
      const group = groups?.find(group => group[0] === request.hash);
      const found = (group?.[1] as JsonValue[][] | undefined)?.find(pair => pair[0] === request.key);
      return { key: request.key, count: String(found?.[1] ?? 0), valid: !page || value?.schema === CORPUS_COUNT_PAGE_SCHEMA && String(value.endHash) >= page.orderKey };
    });
  }
  return undefined;
}
