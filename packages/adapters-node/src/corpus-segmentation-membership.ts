// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
import { createHash } from "node:crypto";
import { canonicalStringify, toJsonValue, type JsonValue } from "@scce/kernel";
import type { PostgresStorageAdapter } from "./postgres.js";
import type { PostgresCorpusSegmentationRun } from "./corpus-segmentation-store.js";
import { durableJoinProgramJsonByteLengths } from "./durable-join-program-storage.js";

export const CORPUS_MEMBERSHIP_SCHEMA = "scce.corpus_segmentation_membership_page.v1";
export const CORPUS_COUNT_PAGE_SCHEMA = "scce.corpus_segmentation_count_page.v3";
const RECEIPT_SCHEMA = "scce.corpus_segmentation_count_receipt.v3";
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
  const headerBytes = durableJoinProgramJsonByteLengths({ orderKey: orderKey(), value: { ...value(), entries: [] } }).decodedJsonbBytes + 2;
  const flush = async () => {
    if (!entries.length) return;
    await run.scratch.putMany(membershipCollection(input.kind), [{ orderKey: orderKey(), value: toJsonValue(value()) }]);
    entries = []; entryBytes = 0; page++;
    if (!Number.isSafeInteger(page)) throw Error("Corpus membership page ordinal exceeds its exact representation");
  };
  for (const entry of input.entries) {
    if (input.kind === "class" ? typeof entry !== "string" : !Array.isArray(entry) || entry.length !== 2 || entry.some(value => typeof value !== "string")) return fail();
    const bytes = durableJoinProgramJsonByteLengths(entry).decodedJsonbBytes + 2;
    if (headerBytes + bytes > run.bounds.maxPageBytes) throw Error("Corpus membership entry exceeds decoded JSON page budget");
    if (entries.length && headerBytes + entryBytes + bytes > run.bounds.maxPageBytes) await flush();
    entries.push(entry); entryBytes += bytes;
  }
  await flush(); return page;
}

async function aggregate(storage: CorpusMembershipStorage, run: CorpusMembershipRun, kind: CorpusMembershipKind): Promise<number> {
  await run.assertState("building");
  const access = storage.informationAccessPredicate("r", 7);
  const key = kind === "class" ? "member.value #>> '{}'" : "member.value->>0";
  const distinct = kind === "class" ? "page.document_id" : "member.value->>1";
  const memberValid = kind === "class" ? "jsonb_typeof(member.value)='string'"
    : "jsonb_typeof(member.value)='array' AND jsonb_array_length(member.value)=2 AND jsonb_typeof(member.value->0)='string' AND jsonb_typeof(member.value->1)='string'";
  const rows = await storage.query<{ authorized: boolean; valid: boolean; expected: string; matched: string; leaf_byte_capacity: number }>(`
    WITH admitted_run AS MATERIALIZED (
      SELECT r.run_id FROM ${storage.table("segmentation_consolidation_runs")} r WHERE r.run_id=$1 AND r.state='building' AND ${access.sql} FOR SHARE OF r
    ), owned_pages AS MATERIALIZED (
      SELECT payload.schema AS page_schema,payload.kind AS page_kind,payload."documentId" AS document_id,
        payload.entries,inventory.order_key AS owner_key FROM ${storage.table("segmentation_consolidation_rows")} page
      JOIN admitted_run r ON r.run_id=page.run_id
      CROSS JOIN LATERAL jsonb_to_record(page.row_json) AS payload(schema text,kind text,"documentId" text,"sourceVersionId" text,entries jsonb)
      LEFT JOIN ${storage.table("segmentation_consolidation_rows")} inventory ON inventory.run_id=page.run_id AND inventory.collection='input/inventory'
        AND inventory.row_json->>'evidenceId'=payload."documentId" AND inventory.row_json->>'sourceVersionId'=payload."sourceVersionId"
      WHERE page.collection=$2
    ), validity AS MATERIALIZED (
      SELECT NOT EXISTS(SELECT 1 FROM owned_pages page WHERE owner_key IS NULL OR page.page_schema IS DISTINCT FROM $4
        OR page.page_kind IS DISTINCT FROM $5 OR jsonb_typeof(page.entries) IS DISTINCT FROM 'array'
        OR EXISTS(SELECT 1 FROM jsonb_array_elements(CASE WHEN jsonb_typeof(page.entries)='array' THEN page.entries ELSE '[]'::jsonb END) member(value)
          WHERE NOT (${memberValid}))) AS valid
    ), exact_counts AS MATERIALIZED (
      SELECT (${key}) COLLATE "C" AS key,COUNT(DISTINCT (${distinct}) COLLATE "C") AS count
      FROM owned_pages page CROSS JOIN validity
      CROSS JOIN LATERAL jsonb_array_elements(CASE WHEN validity.valid THEN page.entries ELSE '[]'::jsonb END) member(value)
      WHERE validity.valid GROUP BY (${key}) COLLATE "C"
    ), hash_groups AS MATERIALIZED (
      SELECT encode(sha256(convert_to(key,'UTF8')),'hex') AS hash,jsonb_object_agg(key,count ORDER BY key COLLATE "C") AS members
      FROM exact_counts GROUP BY encode(sha256(convert_to(key,'UTF8')),'hex')
    ), sized AS MATERIALIZED (
      SELECT hash,members,octet_length(convert_to(members::text,'UTF8')) AS bytes FROM hash_groups
    ), geometry AS MATERIALIZED (
      SELECT LEAST($3,current_setting('block_size')::int) AS target_bytes,
        octet_length(convert_to(json_build_object('orderKey',repeat('0',64),'value',
          jsonb_build_object('schema',$6::text,'endHash',repeat('0',64),'entries','{}'::jsonb))::text,'UTF8')) AS overhead
    ), capacity AS MATERIALIZED (
      SELECT geometry.*,COALESCE(MAX(bytes),0) AS max_bytes,
        COALESCE(MAX(bytes) FILTER(WHERE bytes+geometry.overhead <= geometry.target_bytes),0) AS normal_max_bytes
      FROM geometry LEFT JOIN sized ON TRUE GROUP BY geometry.target_bytes,geometry.overhead
    ), marked AS MATERIALIZED (
      SELECT sized.*,bytes+capacity.overhead > capacity.target_bytes AS large,
        SUM(CASE WHEN bytes+capacity.overhead > capacity.target_bytes THEN 1 ELSE 0 END) OVER(ORDER BY hash COLLATE "C") AS segment
      FROM sized CROSS JOIN capacity WHERE capacity.max_bytes+capacity.overhead <= $3
    ), numbered AS MATERIALIZED (
      SELECT marked.*,CASE WHEN large THEN 'large.' || hash ELSE 'normal.' || segment::text || '.' ||
        FLOOR((ROW_NUMBER() OVER(PARTITION BY segment,large ORDER BY hash COLLATE "C")-1)/
          GREATEST(1,FLOOR((capacity.target_bytes-capacity.overhead)/NULLIF(capacity.normal_max_bytes,0))))::text END AS page
      FROM marked CROSS JOIN capacity
    ), pages AS MATERIALIZED (
      SELECT MIN(numbered.hash COLLATE "C") AS order_key,jsonb_build_object('schema',$6::text,'endHash',MAX(numbered.hash COLLATE "C"),
        'entries',jsonb_object_agg(member.key,member.value ORDER BY numbered.hash COLLATE "C",member.key COLLATE "C")) AS row_json
      FROM numbered CROSS JOIN LATERAL jsonb_each(numbered.members) member(key,value) GROUP BY numbered.page
    ), inserted AS (
      INSERT INTO ${storage.table("segmentation_consolidation_rows")}(run_id,collection,order_key,row_json)
      SELECT $1,'${countCollection(kind)}',order_key,row_json FROM pages CROSS JOIN validity WHERE validity.valid
      ON CONFLICT(run_id,collection,order_key) DO NOTHING RETURNING order_key
    ) SELECT EXISTS(SELECT 1 FROM admitted_run) AS authorized,
      validity.valid AND (capacity.max_bytes=0 OR capacity.max_bytes+capacity.overhead <= $3) AS valid,
      GREATEST(capacity.target_bytes,capacity.max_bytes+capacity.overhead) AS leaf_byte_capacity,
      (SELECT COUNT(*)::text FROM pages) AS expected,
      (SELECT COUNT(*)::text FROM pages p WHERE EXISTS(SELECT 1 FROM inserted i WHERE i.order_key=p.order_key)
        OR EXISTS(SELECT 1 FROM ${storage.table("segmentation_consolidation_rows")} saved
          WHERE saved.run_id=$1 AND saved.collection='${countCollection(kind)}' AND saved.order_key=p.order_key AND saved.row_json=p.row_json)) AS matched
      FROM validity CROSS JOIN capacity`,
  [run.run.runId, `scratch/${membershipCollection(kind)}`, run.bounds.maxPageBytes, CORPUS_MEMBERSHIP_SCHEMA, kind, CORPUS_COUNT_PAGE_SCHEMA, ...access.params]);
  if (rows.length !== 1 || !rows[0]!.authorized || !rows[0]!.valid || rows[0]!.expected !== rows[0]!.matched) return fail();
  const leafBytes = Number(rows[0]!.leaf_byte_capacity);
  if (!Number.isSafeInteger(leafBytes) || leafBytes < 1 || leafBytes > run.bounds.maxPageBytes) return fail();
  return leafBytes;
}

export function corpusCountPageEntries(value: JsonValue): Array<{ hash: string; key: string; count: number }> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return fail();
  const page = value as Record<string, JsonValue>;
  if (!page || page.schema !== CORPUS_COUNT_PAGE_SCHEMA || typeof page.endHash !== "string" || !page.entries || typeof page.entries !== "object" || Array.isArray(page.entries)) return fail();
  const result = Object.entries(page.entries).map(([key, count]) => {
    if (!Number.isSafeInteger(count) || Number(count) < 1) return fail();
    return { hash: corpusMembershipHash(key), key, count: Number(count) };
  }).sort((a, b) => a.hash < b.hash ? -1 : a.hash > b.hash ? 1 : Buffer.compare(Buffer.from(a.key), Buffer.from(b.key)));
  if (!result.length || result.at(-1)!.hash !== page.endHash) return fail();
  return result;
}

async function countDigest(run: CorpusMembershipRun, kind: CorpusMembershipKind, leafByteCapacity: number): Promise<{ id: string; count: number }> {
  const digest = createHash("sha256"); let count = 0, previous = "";
  const pageRows = Math.min(run.bounds.pageRows, Math.max(1, Math.floor(run.bounds.maxPageBytes / leafByteCapacity)));
  for await (const page of run.pages(countCollection(kind), { pageRows })) for (const row of page) {
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
  let leafByteCapacity: number;
  if (!receipts.length) leafByteCapacity = Math.max(await aggregate(storage, run, "class"), await aggregate(storage, run, "context"));
  else {
    const saved = receipts[0];
    if (!saved || typeof saved !== "object" || Array.isArray(saved) || saved.schema !== RECEIPT_SCHEMA) return fail();
    leafByteCapacity = Number(saved.leafByteCapacity);
    if (!Number.isSafeInteger(leafByteCapacity) || leafByteCapacity < 1 || leafByteCapacity > run.bounds.maxPageBytes) return fail();
  }
  const classDigest = await countDigest(run, "class", leafByteCapacity), contextDigest = await countDigest(run, "context", leafByteCapacity);
  const receipt = { schema: RECEIPT_SCHEMA, dependency, recipeId: run.run.recipeId, leafByteCapacity, classDigest, contextDigest };
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
    const requestedKeys = new Set(batch.map(row => row.key));
    const access = storage.informationAccessPredicate("r", 4);
    const rows = await storage.query<{ key: string; count: string; valid: boolean }>(`WITH requested AS MATERIALIZED (
      SELECT q.* FROM jsonb_to_recordset($3::jsonb) q(key text,hash text)
      CROSS JOIN (SELECT r.run_id FROM ${storage.table("segmentation_consolidation_runs")} r WHERE r.run_id=$1 AND ${access.sql}) admitted
    ), located AS MATERIALIZED (
      SELECT q.key,matched.order_key,matched.count,matched.page_schema,matched.end_hash
      FROM requested q LEFT JOIN LATERAL (
        SELECT leaf.order_key,payload.entries->>q.key AS count,payload.schema AS page_schema,payload."endHash" AS end_hash
        FROM (SELECT v.order_key,v.row_json FROM ${storage.table("segmentation_consolidation_rows")} v
          JOIN ${storage.table("segmentation_consolidation_runs")} r ON r.run_id=v.run_id
          WHERE v.run_id=$1 AND v.collection=$2 AND v.order_key COLLATE "C" <= q.hash COLLATE "C" AND ${access.sql}
          ORDER BY v.order_key COLLATE "C" DESC LIMIT 1) leaf
        CROSS JOIN LATERAL jsonb_to_record(leaf.row_json) AS payload(schema text,"endHash" text,entries jsonb)
      ) matched ON TRUE
    ) SELECT q.key,COALESCE(q.count,'0') AS count,
      q.order_key IS NULL OR (q.page_schema=$${4 + access.params.length} AND q.end_hash >= q.order_key COLLATE "C") AS valid
      FROM located q`,
    [run.run.runId, countCollection(kind), JSON.stringify(batch), ...access.params, CORPUS_COUNT_PAGE_SCHEMA]);
    if (rows.length !== batch.length) return fail();
    for (const row of rows) {
      const key = row.key, count = Number(row.count);
      if (!row.valid || !requestedKeys.has(key) || Object.hasOwn(result, key) || !Number.isSafeInteger(count) || count < 0) return fail();
      result[key] = count;
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
