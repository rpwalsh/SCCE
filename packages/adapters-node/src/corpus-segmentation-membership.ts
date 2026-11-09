// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
import { createHash } from "node:crypto";
import { canonicalStringify, toJsonValue, type JsonValue } from "@scce/kernel";
import type { PostgresStorageAdapter } from "./postgres.js";
import type { PostgresCorpusSegmentationRun } from "./corpus-segmentation-store.js";
import { durableJoinProgramJsonByteLengths } from "./durable-join-program-storage.js";

export const CORPUS_MEMBERSHIP_SCHEMA = "scce.corpus_segmentation_membership_page.v1";
export const CORPUS_COUNT_PAGE_SCHEMA = "scce.corpus_segmentation_count_page.v1";
const RECEIPT_SCHEMA = "scce.corpus_segmentation_count_receipt.v1";
export type CorpusMembershipRun = Pick<PostgresCorpusSegmentationRun, "bounds" | "scratch" | "pages" | "putInput" | "assertState">
  & { run: Pick<PostgresCorpusSegmentationRun["run"], "runId" | "recipeId"> };
export type CorpusMembershipStorage = Pick<PostgresStorageAdapter, "table" | "query" | "informationAccessPredicate">;
export type CorpusMembershipKind = "class" | "context";
export const corpusMembershipHash = (key: string) => createHash("sha256").update(key, "utf8").digest("hex");
const membershipCollection = (kind: CorpusMembershipKind) => `producer/${kind}-membership`;
const countCollection = (kind: CorpusMembershipKind) => `input/${kind}-counts`;
const fail = (): never => { throw Error("Invalid or incomplete corpus segmentation membership pages"); };

/** Physical page rows are byte bounded; members do not inherit the SQL row-count limit. */
export async function writeCorpusMembershipPages(run: CorpusMembershipRun, input: {
  kind: CorpusMembershipKind; windowKey: string; documentId: string; sourceVersionId: string; entries: Iterable<string | readonly [string, string]>;
}): Promise<number> {
  let entries: Array<string | readonly [string, string]> = [], page = 0, entryBytes = 0;
  const orderKey = () => `${input.windowKey}:${String(page).padStart(16, "0")}`;
  const value = () => ({ schema: CORPUS_MEMBERSHIP_SCHEMA, kind: input.kind, documentId: input.documentId, sourceVersionId: input.sourceVersionId, entries });
  const overhead = () => durableJoinProgramJsonByteLengths({ orderKey: orderKey(), value: { ...value(), entries: [] } }).decodedJsonbBytes + 2;
  const flush = async () => {
    if (!entries.length) return;
    await run.scratch.putMany(membershipCollection(input.kind), [{ orderKey: orderKey(), value: toJsonValue(value()) }]);
    entries = []; entryBytes = 0; page++;
  };
  for (const entry of input.entries) {
    if (input.kind === "class" ? typeof entry !== "string" : !Array.isArray(entry) || entry.length !== 2 || entry.some(value => typeof value !== "string")) return fail();
    const bytes = durableJoinProgramJsonByteLengths(entry).decodedJsonbBytes + 2;
    if (overhead() + bytes > run.bounds.maxPageBytes) throw Error("Corpus membership entry exceeds decoded JSON page budget");
    if (entries.length && overhead() + entryBytes + bytes > run.bounds.maxPageBytes) await flush();
    entries.push(entry); entryBytes += bytes;
  }
  await flush(); return page;
}

async function aggregate(storage: CorpusMembershipStorage, run: CorpusMembershipRun, kind: CorpusMembershipKind): Promise<void> {
  await run.assertState("building");
  const access = storage.informationAccessPredicate("r", 7);
  const key = kind === "class" ? "member.value #>> '{}'" : "member.value->>0";
  const distinct = kind === "class" ? "page.row_json->>'documentId'" : "member.value->>1";
  const memberValid = kind === "class" ? "jsonb_typeof(member.value)='string'"
    : "jsonb_typeof(member.value)='array' AND jsonb_array_length(member.value)=2 AND jsonb_typeof(member.value->0)='string' AND jsonb_typeof(member.value->1)='string'";
  const rows = await storage.query<{ authorized: boolean; valid: boolean; expected: string; matched: string }>(`
    WITH admitted_run AS MATERIALIZED (
      SELECT r.run_id FROM ${storage.table("segmentation_consolidation_runs")} r WHERE r.run_id=$1 AND r.state='building' AND ${access.sql}
    ), owned_pages AS MATERIALIZED (
      SELECT page.row_json,inventory.order_key AS owner_key FROM ${storage.table("segmentation_consolidation_rows")} page
      JOIN admitted_run r ON r.run_id=page.run_id
      LEFT JOIN ${storage.table("segmentation_consolidation_rows")} inventory ON inventory.run_id=page.run_id AND inventory.collection='input/inventory'
        AND inventory.row_json->>'evidenceId'=page.row_json->>'documentId' AND inventory.row_json->>'sourceVersionId'=page.row_json->>'sourceVersionId'
      WHERE page.collection=$2
    ), validity AS MATERIALIZED (
      SELECT NOT EXISTS(SELECT 1 FROM owned_pages page WHERE owner_key IS NULL OR page.row_json->>'schema' IS DISTINCT FROM $4
        OR page.row_json->>'kind' IS DISTINCT FROM $5 OR jsonb_typeof(page.row_json->'entries') IS DISTINCT FROM 'array'
        OR EXISTS(SELECT 1 FROM jsonb_array_elements(CASE WHEN jsonb_typeof(page.row_json->'entries')='array' THEN page.row_json->'entries' ELSE '[]'::jsonb END) member(value)
          WHERE NOT (${memberValid}))) AS valid
    ), exact_counts AS MATERIALIZED (
      SELECT ${key} COLLATE "C" AS key,COUNT(DISTINCT (${distinct}) COLLATE "C") AS count
      FROM owned_pages page CROSS JOIN validity
      CROSS JOIN LATERAL jsonb_array_elements(CASE WHEN validity.valid THEN page.row_json->'entries' ELSE '[]'::jsonb END) member(value)
      WHERE validity.valid GROUP BY ${key} COLLATE "C"
    ), hash_groups AS MATERIALIZED (
      SELECT encode(sha256(convert_to(key,'UTF8')),'hex') AS hash,jsonb_agg(jsonb_build_array(key,count) ORDER BY key COLLATE "C") AS members
      FROM exact_counts GROUP BY encode(sha256(convert_to(key,'UTF8')),'hex')
    ), sized AS MATERIALIZED (
      SELECT hash,jsonb_build_array(hash,members) AS entry,
        octet_length(convert_to(jsonb_build_array(hash,members)::text,'UTF8'))+2 AS bytes FROM hash_groups
    ), capacity AS MATERIALIZED (
      SELECT COALESCE(MAX(bytes),0) AS max_bytes,
        octet_length(convert_to(json_build_object('orderKey',repeat('0',64),'value',
          jsonb_build_object('schema',$6::text,'endHash',repeat('0',64),'entries','[]'::jsonb))::text,'UTF8')) AS overhead FROM sized
    ), numbered AS MATERIALIZED (
      SELECT sized.*,FLOOR((ROW_NUMBER() OVER(ORDER BY hash COLLATE "C")-1)/GREATEST(1,FLOOR(($3-capacity.overhead)/NULLIF(capacity.max_bytes,0)))) AS page
      FROM sized CROSS JOIN capacity WHERE capacity.max_bytes+capacity.overhead <= $3
    ), pages AS MATERIALIZED (
      SELECT MIN(hash COLLATE "C") AS order_key,jsonb_build_object('schema',$6::text,'endHash',MAX(hash COLLATE "C"),
        'entries',jsonb_agg(entry ORDER BY hash COLLATE "C")) AS row_json FROM numbered GROUP BY page
    ), inserted AS (
      INSERT INTO ${storage.table("segmentation_consolidation_rows")}(run_id,collection,order_key,row_json)
      SELECT $1,'${countCollection(kind)}',order_key,row_json FROM pages CROSS JOIN validity WHERE validity.valid
      ON CONFLICT(run_id,collection,order_key) DO NOTHING RETURNING order_key
    ) SELECT EXISTS(SELECT 1 FROM admitted_run) AS authorized,
      validity.valid AND (capacity.max_bytes=0 OR capacity.max_bytes+capacity.overhead <= $3) AS valid,
      (SELECT COUNT(*)::text FROM pages) AS expected,
      (SELECT COUNT(*)::text FROM pages p WHERE EXISTS(SELECT 1 FROM inserted i WHERE i.order_key=p.order_key)
        OR EXISTS(SELECT 1 FROM ${storage.table("segmentation_consolidation_rows")} saved
          WHERE saved.run_id=$1 AND saved.collection='${countCollection(kind)}' AND saved.order_key=p.order_key AND saved.row_json=p.row_json)) AS matched
      FROM validity CROSS JOIN capacity`,
  [run.run.runId, `scratch/${membershipCollection(kind)}`, run.bounds.maxPageBytes, CORPUS_MEMBERSHIP_SCHEMA, kind, CORPUS_COUNT_PAGE_SCHEMA, ...access.params]);
  if (rows.length !== 1 || !rows[0]!.authorized || !rows[0]!.valid || rows[0]!.expected !== rows[0]!.matched) return fail();
}

export function corpusCountPageEntries(value: JsonValue): Array<{ hash: string; key: string; count: number }> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return fail();
  const page = value as Record<string, JsonValue>;
  if (!page || page.schema !== CORPUS_COUNT_PAGE_SCHEMA || typeof page.endHash !== "string" || !Array.isArray(page.entries)) return fail();
  const result: Array<{ hash: string; key: string; count: number }> = [];
  let previous = "";
  for (const group of page.entries) {
    if (!Array.isArray(group) || group.length !== 2 || typeof group[0] !== "string" || group[0] <= previous || !Array.isArray(group[1]) || !group[1].length) return fail();
    const hash = group[0]; previous = hash; let previousKey: string | undefined;
    for (const member of group[1]) {
      if (!Array.isArray(member) || member.length !== 2 || typeof member[0] !== "string" || corpusMembershipHash(member[0]) !== hash
        || !Number.isSafeInteger(member[1]) || Number(member[1]) < 1 || previousKey !== undefined && Buffer.compare(Buffer.from(member[0]), Buffer.from(previousKey)) <= 0) return fail();
      previousKey = member[0]; result.push({ hash, key: member[0], count: Number(member[1]) });
    }
  }
  if (!result.length || previous !== page.endHash) return fail();
  return result;
}

async function countDigest(run: CorpusMembershipRun, kind: CorpusMembershipKind): Promise<{ id: string; count: number }> {
  const digest = createHash("sha256"); let count = 0, previous = "";
  for await (const page of run.pages(countCollection(kind))) for (const row of page) {
    const entries = corpusCountPageEntries(row.value);
    if (row.orderKey !== entries[0]!.hash || row.orderKey <= previous) return fail();
    previous = entries.at(-1)!.hash;
    for (const entry of entries) { digest.update(canonicalStringify([entry.key, entry.count])); digest.update("\n"); count++; }
  }
  return { id: `sha256:${digest.digest("hex")}`, count };
}

/** Complete immutable count pages replace disposable membership scratch before compilation. */
export async function prepareCorpusMembershipCounts(storage: CorpusMembershipStorage, run: CorpusMembershipRun, dependency: { id: string; count: number }) {
  const receipts: JsonValue[] = [];
  for await (const page of run.pages("input/context-count-receipt")) for (const row of page) {
    receipts.push(row.value); if (receipts.length > 1) return fail();
  }
  if (!receipts.length) {
    await aggregate(storage, run, "class"); await aggregate(storage, run, "context");
  }
  const classDigest = await countDigest(run, "class"), contextDigest = await countDigest(run, "context");
  const receipt = { schema: RECEIPT_SCHEMA, dependency, recipeId: run.run.recipeId, classDigest, contextDigest };
  if (receipts.length && canonicalStringify(receipts[0]) !== canonicalStringify(receipt)) return fail();
  if (!receipts.length) await run.putInput("context-count-receipt", [{ orderKey: "complete", value: toJsonValue(receipt) }]);
  for (const kind of ["class", "context"] as const) await run.scratch.deleteCollection(membershipCollection(kind));
  return { classDigest, contextDigest };
}

/** Seek one indexed hash-range page, then require the exact complete Unicode key. */
export async function readCorpusMembershipCounts(storage: CorpusMembershipStorage, run: CorpusMembershipRun, kind: CorpusMembershipKind, keys: readonly string[]): Promise<Record<string, number>> {
  const result: Record<string, number> = Object.create(null);
  let batch: Array<{ key: string; hash: string }> = [], bytes = 2;
  const flush = async () => {
    if (!batch.length) return;
    const access = storage.informationAccessPredicate("r", 4);
    const rows = await storage.query<{ key: string; count: string; valid: boolean }>(`WITH requested AS MATERIALIZED (
      SELECT q.* FROM jsonb_to_recordset($3::jsonb) q(key text,hash text)
      CROSS JOIN (SELECT r.run_id FROM ${storage.table("segmentation_consolidation_runs")} r WHERE r.run_id=$1 AND ${access.sql}) admitted
    ), located AS MATERIALIZED (
      SELECT q.*,matched.order_key FROM requested q LEFT JOIN LATERAL (SELECT v.order_key FROM ${storage.table("segmentation_consolidation_rows")} v
        JOIN ${storage.table("segmentation_consolidation_runs")} r ON r.run_id=v.run_id
        WHERE v.run_id=$1 AND v.collection=$2 AND v.order_key COLLATE "C" <= q.hash COLLATE "C" AND ${access.sql}
        ORDER BY v.order_key COLLATE "C" DESC LIMIT 1) matched ON TRUE
    ), selected_pages AS MATERIALIZED (
      SELECT v.order_key,v.row_json FROM ${storage.table("segmentation_consolidation_rows")} v
      JOIN (SELECT DISTINCT order_key FROM located WHERE order_key IS NOT NULL) needed ON needed.order_key=v.order_key
      WHERE v.run_id=$1 AND v.collection=$2
    ), page_members AS MATERIALIZED (
      SELECT page.order_key,hash_group.value->>0 AS hash,member.value->>0 AS key,member.value->>1 AS count
      FROM selected_pages page CROSS JOIN LATERAL jsonb_array_elements(page.row_json->'entries') hash_group(value)
      CROSS JOIN LATERAL jsonb_array_elements(hash_group.value->1) member(value)
    ) SELECT q.key,COALESCE(member.count,'0') AS count,
      q.order_key IS NULL OR (page.row_json->>'schema'=$${4 + access.params.length} AND page.row_json->>'endHash' >= q.order_key COLLATE "C") AS valid
      FROM located q LEFT JOIN selected_pages page ON page.order_key=q.order_key
      LEFT JOIN page_members member ON member.order_key=q.order_key AND member.hash=q.hash AND member.key=q.key`,
    [run.run.runId, countCollection(kind), JSON.stringify(batch), ...access.params, CORPUS_COUNT_PAGE_SCHEMA]);
    if (rows.length !== batch.length) return fail();
    for (const row of rows) {
      const count = Number(row.count);
      if (!row.valid || !batch.some(item => item.key === row.key) || Object.hasOwn(result, row.key) || !Number.isSafeInteger(count) || count < 0) return fail();
      result[row.key] = count;
    }
    batch = []; bytes = 2;
  };
  for (const key of new Set(keys)) {
    const row = { key, hash: corpusMembershipHash(key) }, size = Buffer.byteLength(JSON.stringify(row)) + 1;
    if (size + 2 > run.bounds.maxPageBytes) throw Error("Corpus boundary context key exceeds decoded JSON budget");
    if (batch.length && (batch.length >= run.bounds.pageRows || bytes + size > run.bounds.maxPageBytes)) await flush();
    batch.push(row); bytes += size;
  }
  await flush(); return result;
}
