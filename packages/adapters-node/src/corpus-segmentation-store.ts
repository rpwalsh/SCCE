// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
import { createHash } from "node:crypto";
import { canonicalStringify, validatePagedSegmentationInference, type SegmentationPopulationInferenceModel, type InformationLabel, type JsonValue } from "@scce/kernel";
import type { CorpusSegmentationScratch, CorpusSegmentationScratchRow } from "@scce/kernel";
import { assertEvidenceTextReferenceMaintenance } from "./evidence-text-reference-schema.js";
import { currentCorpusSegmentationDerivations } from "./corpus-segmentation-owner.js";
import type { PostgresStorageAdapter } from "./postgres.js";

import type { CorpusSegmentationScope, SegmentationPageBounds } from "@scce/kernel";
export type { CorpusSegmentationScope, SegmentationPageBounds } from "@scce/kernel";
export interface CorpusSegmentationRun {
  runId: string;
  scopeId: string;
  scope: CorpusSegmentationScope;
  recipeId: string;
  normalizationContractId: string;
  createdAt: number;
  fitPolicy?: {maxPopulations:number|null;mergeDescriptionMarginNats:number|null;heldoutRegressionToleranceNats:number|null};
  execution?:import("@scce/kernel").CorpusSegmentationWorkerExecution;
}
function positive(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`Invalid segmentation ${name}`);
  return value;
}
function ascii(value: string, name: string): string {
  if (typeof value !== "string" || !value || !/^[\x20-\x7e]+$/u.test(value)) throw new Error(`Invalid segmentation ${name}: ASCII order key required`);
  return value;
}
export function segmentationOrdinalKey(value: number): string {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error("Invalid segmentation ordinal");
  return String(value).padStart(16, "0");
}

function freezeOwned<T>(value:T):T {
  if(value&&typeof value==="object"){for(const child of Object.values(value))freezeOwned(child);Object.freeze(value);}return value;
}
/** One explicit run. Immutable inputs and mutable iteration scratch use separate namespaces. */
export class PostgresCorpusSegmentationRun {
  readonly scratch: CorpusSegmentationScratch;
  constructor(private readonly storage: PostgresStorageAdapter, readonly run: CorpusSegmentationRun, readonly bounds: SegmentationPageBounds) {
    this.run=freezeOwned(structuredClone(run));
    this.bounds=Object.freeze({pageRows:positive(bounds.pageRows,"pageRows"),maxPageBytes:positive(bounds.maxPageBytes,"maxPageBytes")});
    this.scratch = { ...this.bounds,
      pages: query => this.pages(`scratch/${query.collection}`, query),
      putMany: (collection, rows) => this.put(`scratch/${collection}`, rows, "scratch"),
      deleteCollection: collection => this.remove(`scratch/${collection}`),
      count: collection => this.count(`scratch/${collection}`),
      digestChunks: async chunks => {
        const hash = createHash("sha256"); for await (const chunk of chunks) hash.update(chunk); return hash.digest("hex");
      } };
  }
  private access(start: number) { return this.storage.informationAccessPredicate("r", start); }
  async state():Promise<"building"|"fitting"|"complete"|"failed"> {
    const access=this.access(2);
    const rows=await this.storage.query<{state:string}>(`SELECT r.state FROM ${this.storage.table("segmentation_consolidation_runs")} r WHERE r.run_id=$1 AND ${access.sql}`,[this.run.runId,...access.params]);
    const state=rows[0]?.state;
    if(state!=="building"&&state!=="fitting"&&state!=="complete"&&state!=="failed")throw new Error("Segmentation run is unavailable or has incompatible state");return state;
  }
  async assertState(state?: string | readonly string[]): Promise<void> {
    const current=await this.state();
    if(state&&!(Array.isArray(state)?state.includes(current):current===state))throw new Error("Segmentation run is unavailable or has incompatible state");
  }
  async putInput(collection: string, rows: readonly CorpusSegmentationScratchRow[]): Promise<void> { return this.put(`input/${collection}`, rows, "building"); }
  /** Resume rebuilds these physical workspaces; immutable inputs and completed runs are never reset. */
  async discardIncompleteMergeScratch(phase: "building" | "fitting"): Promise<number> {
    if(phase!=="building"&&phase!=="fitting")throw new Error("Invalid segmentation scratch reset phase");
    const prefix=phase==="building"?"scratch/producer/document.":"scratch/fit.",access=this.access(4);
    const rows=await this.storage.query<{authorized:boolean;count:string}>(`WITH owned AS MATERIALIZED (
      SELECT r.run_id FROM ${this.storage.table("segmentation_consolidation_runs")} r
      WHERE r.run_id=$1 AND r.state=$2 AND ${access.sql} FOR SHARE OF r
    ), removed AS (
      DELETE FROM ${this.storage.table("segmentation_consolidation_rows")} v USING owned r
      WHERE v.run_id=r.run_id AND starts_with(v.collection,$3::text) RETURNING 1
    ) SELECT EXISTS(SELECT 1 FROM owned) AS authorized,(SELECT COUNT(*)::text FROM removed) AS count`,[this.run.runId,phase,prefix,...access.params]);
    const count=Number(rows[0]?.count);
    if(rows.length!==1||!rows[0]!.authorized||!Number.isSafeInteger(count)||count<0)throw new Error("Segmentation scratch reset requires the current accessible incomplete run");
    return count;
  }
  private async put(collection: string, rows: readonly CorpusSegmentationScratchRow[], state: "building" | "scratch"): Promise<void> {
    ascii(collection, "collection"); await this.assertState(state === "scratch" ? ["building", "fitting"] : "building");
    let batch: CorpusSegmentationScratchRow[] = [], bytes = 2;
    const flush = async () => {
      if (!batch.length) return;
      const access = this.access(4);
      const sql = state === "building" ? `WITH requested AS MATERIALIZED (
        SELECT v."orderKey",v.value FROM jsonb_to_recordset($3::jsonb) AS v("orderKey" text,value jsonb)
      ), owned AS MATERIALIZED (
        SELECT r.run_id FROM ${this.storage.table("segmentation_consolidation_runs")} r
        WHERE r.run_id=$1 AND r.state='building' AND ${access.sql} FOR SHARE
      ), inserted AS (
        INSERT INTO ${this.storage.table("segmentation_consolidation_rows")}(run_id,collection,order_key,row_json)
        SELECT r.run_id,$2::text,v."orderKey",v.value FROM owned r CROSS JOIN requested v
        ON CONFLICT(run_id,collection,order_key) DO NOTHING RETURNING order_key
      ) SELECT order_key FROM inserted
      UNION ALL SELECT v."orderKey" AS order_key FROM requested v CROSS JOIN owned r
        JOIN ${this.storage.table("segmentation_consolidation_rows")} existing
          ON existing.run_id=r.run_id AND existing.collection=$2::text AND existing.order_key=v."orderKey"
        WHERE existing.row_json=v.value AND NOT EXISTS(SELECT 1 FROM inserted i WHERE i.order_key=v."orderKey")`
        : `INSERT INTO ${this.storage.table("segmentation_consolidation_rows")} AS existing(run_id,collection,order_key,row_json)
        SELECT r.run_id,$2,v."orderKey",v.value FROM ${this.storage.table("segmentation_consolidation_runs")} r
        CROSS JOIN LATERAL jsonb_to_recordset($3::jsonb) AS v("orderKey" text,value jsonb)
        WHERE r.run_id=$1 AND r.state IN ('building','fitting') AND ${access.sql}
        ON CONFLICT(run_id,collection,order_key) DO UPDATE SET row_json=EXCLUDED.row_json RETURNING order_key`;
      const written = await this.storage.query<{order_key: string}>(sql, [this.run.runId, collection, JSON.stringify(batch), ...access.params]);
      if (written.length !== batch.length) throw new Error("Segmentation row write conflicts with immutable input or run state");
      batch = []; bytes = 2;
    };
    for (const row of rows) {
      ascii(row.orderKey, "row key");
      const rowBytes = Buffer.byteLength(JSON.stringify(row), "utf8") + 1;
      if (rowBytes + 2 > this.bounds.maxPageBytes) throw new Error("Segmentation row exceeds decoded JSON byte budget");
      if (batch.length && (batch.length >= this.bounds.pageRows || bytes + rowBytes > this.bounds.maxPageBytes)) await flush();
      batch.push(row); bytes += rowBytes;
    }
    await flush();
  }
  async *pages(collection: string, query: Partial<SegmentationPageBounds> & {afterKey?: string; prefix?: string} = {}): AsyncIterable<readonly CorpusSegmentationScratchRow[]> {
    ascii(collection, "collection");
    const pageRows = positive(query.pageRows ?? this.bounds.pageRows, "pageRows"), maxBytes = positive(query.maxPageBytes ?? this.bounds.maxPageBytes, "maxPageBytes");
    if (pageRows > this.bounds.pageRows || maxBytes > this.bounds.maxPageBytes) throw new Error("Segmentation page exceeds declared run bounds");
    let after = query.afterKey ?? "";
    const prefix = query.prefix === undefined ? "" : query.prefix;
    if (prefix !== "") ascii(prefix, "prefix");
    for (;;) {
      const access = this.access(6);
      const rows = await this.storage.query<{order_key: string; row_json: JsonValue | null; decoded_bytes: number; admitted: boolean}>(`
        WITH candidate AS MATERIALIZED (
          SELECT v.order_key,v.row_json,octet_length(convert_to(json_build_object('orderKey',v.order_key,'value',v.row_json)::text,'UTF8')) AS decoded_bytes
          FROM ${this.storage.table("segmentation_consolidation_rows")} v JOIN ${this.storage.table("segmentation_consolidation_runs")} r ON r.run_id=v.run_id
          WHERE v.run_id=$1 AND v.collection=$2 AND v.order_key COLLATE "C" > $3::text COLLATE "C"
            AND v.order_key COLLATE "C" >= $4::text COLLATE "C"
            AND v.order_key COLLATE "C" < ($4::text || chr(127)) COLLATE "C"
            AND starts_with(v.order_key,$4) AND ${access.sql} ORDER BY v.order_key COLLATE "C" LIMIT $5
        ), measured AS (SELECT *,SUM(decoded_bytes) OVER(ORDER BY order_key COLLATE "C") AS running_bytes FROM candidate)
        SELECT order_key,decoded_bytes,running_bytes <= $${6 + access.params.length} AS admitted,
          CASE WHEN running_bytes <= $${6 + access.params.length} THEN row_json ELSE NULL END AS row_json
        FROM measured ORDER BY order_key COLLATE "C"`, [this.run.runId, collection, after, prefix, pageRows, ...access.params, maxBytes]);
      if (!rows.length) { await this.assertState(); return; }
      const admitted = rows.filter(row => row.admitted);
      if (!admitted.length) throw new Error("Segmentation row exceeds decoded JSON byte budget");
      yield admitted.map(row => ({ orderKey: row.order_key, value: row.row_json! }));
      after = admitted.at(-1)!.order_key;
    }
  }
  async count(collection: string): Promise<number> {
    ascii(collection, "collection"); const access = this.access(3);
    const rows = await this.storage.query<{count: string}>(`SELECT COUNT(*)::text AS count FROM ${this.storage.table("segmentation_consolidation_rows")} v JOIN ${this.storage.table("segmentation_consolidation_runs")} r ON r.run_id=v.run_id WHERE v.run_id=$1 AND v.collection=$2 AND ${access.sql}`, [this.run.runId, collection, ...access.params]);
    await this.assertState(); const count = Number(rows[0]?.count);
    if (!Number.isSafeInteger(count) || count < 0) throw new Error("Invalid segmentation row count"); return count;
  }
  private async remove(collection: string): Promise<void> {
    ascii(collection, "collection"); await this.assertState(["building", "fitting"]); const access = this.access(3);
    await this.storage.query(`DELETE FROM ${this.storage.table("segmentation_consolidation_rows")} v USING ${this.storage.table("segmentation_consolidation_runs")} r WHERE v.run_id=r.run_id AND v.run_id=$1 AND v.collection=$2 AND r.state IN ('building','fitting') AND ${access.sql}`, [this.run.runId, collection, ...access.params]);
  }
  async digest(collection: string): Promise<{id: string; count: number}> {
    const hash = createHash("sha256"); let count = 0;
    for await (const page of this.pages(collection)) for (const row of page) { hash.update(canonicalStringify(row)); hash.update("\n"); count++; }
    return { id: `sha256:${hash.digest("hex")}`, count };
  }
}


export function corpusSegmentationScopeId(scope: CorpusSegmentationScope): string {
  return `segmentation_scope.${createHash("sha256").update(canonicalStringify(scope)).digest("hex")}`;
}
/** Membership is explicit promoted evidence, exact declared label, accessible source, and caller filters. */
function inventorySql(storage: PostgresStorageAdapter, scope: CorpusSegmentationScope, firstParameter: number) {
  const params: unknown[] = [JSON.stringify(scope.informationLabel)];
  const bind = (value: unknown) => { params.push(value); return `$${firstParameter + params.length - 1}`; };
  const where = ["e.status='promoted'", `e.information_label=$${firstParameter}::jsonb`, `sv.information_label=$${firstParameter}::jsonb`];
  if (scope.sourceVersionIds) where.push(`sv.id=ANY(${bind([...scope.sourceVersionIds])}::text[])`);
  if (scope.sourceSystems) where.push(`e.provenance_json->>'sourceSystem'=ANY(${bind([...scope.sourceSystems])}::text[])`);
  if (scope.activeImportVersion !== undefined) where.push(`sv.metadata_json->>'activeImportVersion'=${bind(scope.activeImportVersion)}`);
  const evidenceAccess = storage.informationAccessPredicate("e", firstParameter + params.length); params.push(...evidenceAccess.params); where.push(evidenceAccess.sql);
  const sourceAccess = storage.informationAccessPredicate("sv", firstParameter + params.length); params.push(...sourceAccess.params); where.push(sourceAccess.sql);
  return { params, sql: `SELECT e.id AS evidence_id, jsonb_build_object(
    'evidenceId',e.id,'sourceId',e.source_id,'sourceVersionId',sv.id,'sourceContentHash',sv.content_hash,
    'evidenceContentHash',e.content_hash,
    'byteStart',e.byte_start,'byteEnd',e.byte_end,'charStart',e.char_start,'charEnd',e.char_end,
    'codePoints',e.char_end-e.char_start,'informationLabel',e.information_label,'sourceInformationLabel',sv.information_label,
    'sourceFamilyId',e.source_id,'parentSourceVersionId',sv.metadata_json#>'{_scceSourceVersion,derivation,derivedFromSourceVersionId}') AS row_json
    FROM ${storage.table("evidence_spans")} e JOIN ${storage.table("source_versions")} sv ON sv.id=e.source_version_id
    WHERE ${where.join(" AND ")}` };
}

export async function createCorpusSegmentationRun(storage: PostgresStorageAdapter, input: CorpusSegmentationRun, bounds: SegmentationPageBounds): Promise<PostgresCorpusSegmentationRun> {
  storage.requireWritableInformationLabel(input.scope.informationLabel);
  await assertEvidenceTextReferenceMaintenance(storage);
  for (const ids of [input.scope.sourceVersionIds,input.scope.sourceSystems]) if (ids !== undefined
    && (!Array.isArray(ids) || !ids.length || ids.some(id => typeof id !== "string" || !id.trim()))) throw new Error("Invalid corpus segmentation source scope");
  if(input.scope.ownerFamilyBindings){if(!Array.isArray(input.scope.ownerFamilyBindings))throw new Error("Invalid corpus segmentation family bindings");const seen=new Set<string>();for(const binding of input.scope.ownerFamilyBindings){
    if(typeof binding.sourceId!=="string"||!binding.sourceId.trim()||typeof binding.familyId!=="string"||!binding.familyId.trim()||seen.has(binding.sourceId))throw new Error("Invalid corpus segmentation family binding");seen.add(binding.sourceId);
  }}
  if (input.scope.activeImportVersion !== undefined && (typeof input.scope.activeImportVersion !== "string" || !input.scope.activeImportVersion.trim())) throw new Error("Invalid corpus segmentation import scope");
  if (typeof input.runId!=="string"||!input.runId.trim() || input.scopeId !== corpusSegmentationScopeId(input.scope) || typeof input.recipeId!=="string"||!input.recipeId.trim()||typeof input.normalizationContractId!=="string"||!input.normalizationContractId.trim()
    || !Number.isSafeInteger(input.createdAt)) throw new Error("Invalid corpus segmentation run declaration");
  const run = new PostgresCorpusSegmentationRun(storage, input, bounds);
  const declared=run.run;
  if(Buffer.byteLength(JSON.stringify(declared),"utf8")>run.bounds.maxPageBytes)throw new Error("Corpus segmentation run declaration exceeds decoded JSON budget");
  await storage.transaction(async () => {
    const inserted=await storage.query<{run_id:string}>(`INSERT INTO ${storage.table("segmentation_consolidation_runs")}(run_id,scope_id,state,run_json,information_label,created_at)
      VALUES($1,$2,'building',$3::jsonb,$4::jsonb,TO_TIMESTAMP($5/1000.0)) ON CONFLICT(run_id) DO NOTHING RETURNING run_id`,
      [declared.runId, declared.scopeId, JSON.stringify(declared), JSON.stringify(declared.scope.informationLabel), declared.createdAt]);
    const access=storage.informationAccessPredicate("r",2);
    const records = await storage.query<{run_json: CorpusSegmentationRun}>(`SELECT r.run_json FROM ${storage.table("segmentation_consolidation_runs")} r WHERE r.run_id=$1 AND ${access.sql} FOR UPDATE`, [declared.runId,...access.params]);
    if (!records[0] || canonicalStringify(records[0].run_json) !== canonicalStringify(declared)) throw new Error("Segmentation run identity conflict");
    await run.assertState("building");
    if(inserted.length){
    const inventory = inventorySql(storage, declared.scope, 2);
    await storage.query(`INSERT INTO ${storage.table("segmentation_consolidation_rows")}(run_id,collection,order_key,row_json)
      SELECT $1,'input/inventory',lpad(row_number() OVER(ORDER BY evidence_id COLLATE "C")::text,16,'0'),row_json
      FROM (${inventory.sql}) inventory ON CONFLICT(run_id,collection,order_key) DO NOTHING`, [declared.runId, ...inventory.params]);
    }
  });
  return run;
}

/** Rehash the exact current membership without hydrating corpus text or aggregating arrays. */
export async function currentCorpusSegmentationDependency(storage: PostgresStorageAdapter, run: PostgresCorpusSegmentationRun): Promise<{id: string; count: number}> {
  await assertEvidenceTextReferenceMaintenance(storage);
  const hash = createHash("sha256"); let count = 0, after = "";
  let inventory: {id:string;count:number};
  for (;;) {
    const selection = inventorySql(storage, run.run.scope, 2);
    const rows = await storage.query<{evidence_id: string; row_json: JsonValue | null; admitted: boolean}>(`WITH candidate AS MATERIALIZED (
      SELECT *,octet_length(convert_to(row_json::text,'UTF8')) AS decoded_bytes FROM (${selection.sql}) inventory
      WHERE evidence_id COLLATE "C" > $1::text COLLATE "C" ORDER BY evidence_id COLLATE "C" LIMIT $${2 + selection.params.length}
    ), measured AS (SELECT *,SUM(decoded_bytes) OVER(ORDER BY evidence_id COLLATE "C") AS running_bytes FROM candidate)
    SELECT evidence_id,running_bytes <= $${3 + selection.params.length} AS admitted,
      CASE WHEN running_bytes <= $${3 + selection.params.length} THEN row_json ELSE NULL END AS row_json FROM measured ORDER BY evidence_id COLLATE "C"`,
      [after, ...selection.params, run.bounds.pageRows, run.bounds.maxPageBytes]);
    if (!rows.length) {inventory={id:`sha256:${hash.digest("hex")}`,count};break;}
    const admitted = rows.filter(row => row.admitted);
    if (!admitted.length) throw new Error("Segmentation dependency exceeds decoded JSON byte budget");
    for (const row of admitted) { hash.update(canonicalStringify({ orderKey: segmentationOrdinalKey(count + 1), value: row.row_json })); hash.update("\n"); count++; after = row.evidence_id; }
  }
  return combinedDependency(run.run.scopeId,inventory,await currentCorpusSegmentationDerivations(storage,run));
}
function combinedDependency(scopeId:string,inventory:{id:string;count:number},derivations:{id:string;count:number}):{id:string;count:number}{
  return {id:`sha256:${createHash("sha256").update(canonicalStringify({scopeId,inventory,derivations})).digest("hex")}`,count:inventory.count};
}
export async function snapshotCorpusSegmentationDependency(run:PostgresCorpusSegmentationRun):Promise<{id:string;count:number}>{
  return combinedDependency(run.run.scopeId,await run.digest("input/inventory"),await run.digest("input/derivations"));
}

export async function sealCorpusSegmentationInputs(storage: PostgresStorageAdapter, run: PostgresCorpusSegmentationRun, snapshot: JsonValue): Promise<void> {
  const dependency = await snapshotCorpusSegmentationDependency(run);
  if (!dependency.count) throw new Error("Corpus segmentation inventory is empty");
  const header = snapshot as {completeUnicodeCoverage?:boolean;documentCount?:number;windowCount?:number;coveredUtf16?:number;featureContextId?:string;normalizationContractId?:string};
  if (!header || typeof header !== "object" || header.completeUnicodeCoverage !== true
    || header.documentCount !== dependency.count || !Number.isSafeInteger(header.windowCount) || header.windowCount! < 0
    || !Number.isSafeInteger(header.coveredUtf16) || header.coveredUtf16! < 0 || !header.featureContextId
    || header.normalizationContractId !== run.run.normalizationContractId
    || await run.count("input/documents") !== header.documentCount || await run.count("input/owners") !== header.documentCount
    || await run.count("input/coverage") !== header.windowCount) throw new Error("Incomplete corpus segmentation source/statistics coverage");
  const current = await currentCorpusSegmentationDependency(storage, run);
  if (canonicalStringify(current) !== canonicalStringify(dependency)) throw new Error("Corpus segmentation dependency changed during preparation");
  await run.assertState("building");
  const access=storage.informationAccessPredicate("r",3);
  const changed=await storage.query<{run_id:string}>(`UPDATE ${storage.table("segmentation_consolidation_runs")} r SET state='fitting',snapshot_json=$2::jsonb WHERE r.run_id=$1 AND r.state='building' AND ${access.sql} RETURNING run_id`,
    [run.run.runId, JSON.stringify({ dependency, snapshot }),...access.params]);
  if(changed.length!==1)throw new Error("Corpus segmentation seal lost its owned run state");
}


export async function openCorpusSegmentationRun(storage: PostgresStorageAdapter, runId: string, bounds: SegmentationPageBounds): Promise<PostgresCorpusSegmentationRun> {
  positive(bounds.pageRows,"pageRows");positive(bounds.maxPageBytes,"maxPageBytes");
  const access = storage.informationAccessPredicate("r", 3);
  const rows = await storage.query<{run_json: CorpusSegmentationRun|null;fits:boolean}>(`SELECT octet_length(convert_to(r.run_json::text,'UTF8')) <= $2 AS fits,
    CASE WHEN octet_length(convert_to(r.run_json::text,'UTF8')) <= $2 THEN r.run_json ELSE NULL END AS run_json
    FROM ${storage.table("segmentation_consolidation_runs")} r WHERE r.run_id=$1 AND ${access.sql}`, [runId,bounds.maxPageBytes,...access.params]);
  if (!rows[0]) throw new Error("Corpus segmentation run is unavailable");
  if(!rows[0].fits||!rows[0].run_json)throw new Error("Corpus segmentation run exceeds decoded JSON budget");
  return new PostgresCorpusSegmentationRun(storage, rows[0].run_json, bounds);
}

async function lockCorpusSegmentationDependencies(storage: PostgresStorageAdapter): Promise<void> {
  storage.requireActiveTransaction("Corpus segmentation commit read");
  await storage.query(`LOCK TABLE ${storage.table("evidence_spans")},${storage.table("source_versions")} IN SHARE MODE`);
}

/** Publish only one complete matched immutable inference/context snapshot, never an unscoped latest row. */
export async function activateCorpusSegmentationRun(storage: PostgresStorageAdapter, run: PostgresCorpusSegmentationRun, inference: SegmentationPopulationInferenceModel): Promise<void> {
  const model=validatePagedSegmentationInference(structuredClone(inference));
  if(Buffer.byteLength(JSON.stringify(model),"utf8")>run.bounds.maxPageBytes)throw new Error("Corpus segmentation inference exceeds declared decoded JSON budget");
  await storage.transaction(async () => {
    const access = storage.informationAccessPredicate("r", 2);
    const rows = await storage.query<{snapshot_json: {dependency: {id: string; count: number}; snapshot: {featureContextId: string; completeUnicodeCoverage: boolean; documentCount: number}}}>(`SELECT r.snapshot_json FROM ${storage.table("segmentation_consolidation_runs")} r WHERE r.run_id=$1 AND r.state='fitting' AND ${access.sql} FOR UPDATE`, [run.run.runId, ...access.params]);
    const snapshot = rows[0]?.snapshot_json;
    if (!snapshot || !snapshot.snapshot.completeUnicodeCoverage || !snapshot.dependency.count
      || model.normalizationContractId !== run.run.normalizationContractId
      || model.featureContextId !== snapshot.snapshot.featureContextId
      || canonicalStringify(model.sourceInventory) !== canonicalStringify(snapshot.dependency)) throw new Error("Corpus segmentation inference does not match its complete owned snapshot");
    // All dependency reads and the pointer publication share a stable membership boundary.
    await lockCorpusSegmentationDependencies(storage);
    const current = await currentCorpusSegmentationDependency(storage, run);
    if (canonicalStringify(current) !== canonicalStringify(snapshot.dependency)) throw new Error("Corpus segmentation dependency changed before activation");
    const publicationAccess=storage.informationAccessPredicate("r",4);
    const publicationBudgetParameter=4+publicationAccess.params.length;
    const published=await storage.mutateLanguageMemory(`WITH completed AS (
      UPDATE ${storage.table("segmentation_consolidation_runs")} r SET state='complete',inference_json=$3::jsonb WHERE r.run_id=$1 AND r.state='fitting' AND ${publicationAccess.sql}
        AND octet_length(convert_to(jsonb_build_object('run_json',r.run_json,'snapshot_json',r.snapshot_json,'inference_json',$3::jsonb)::text,'UTF8')) <= $${publicationBudgetParameter} RETURNING r.run_id
    ) INSERT INTO ${storage.table("segmentation_consolidation_active")}(scope_id,run_id,header_json,activated_at)
      SELECT $2,run_id,$3::jsonb,NOW() FROM completed
      ON CONFLICT(scope_id) DO UPDATE SET run_id=EXCLUDED.run_id,header_json=EXCLUDED.header_json,activated_at=EXCLUDED.activated_at`,
      [run.run.runId, run.run.scopeId, JSON.stringify(model),...publicationAccess.params,run.bounds.maxPageBytes]);
    if(!published)throw new Error("Corpus segmentation publication lost state or exceeds decoded JSON budget");
  });
}


export async function readActiveCorpusSegmentationRun(storage: PostgresStorageAdapter, scope: CorpusSegmentationScope, required: {recipeId:string;normalizationContractId:string}, bounds: SegmentationPageBounds, consistency?: {lockForCommit?:boolean}): Promise<{run: PostgresCorpusSegmentationRun; inference: SegmentationPopulationInferenceModel} | null> {
  positive(bounds.pageRows,"pageRows");positive(bounds.maxPageBytes,"maxPageBytes");
  if (consistency?.lockForCommit) await lockCorpusSegmentationDependencies(storage);
  const scopeId = corpusSegmentationScopeId(scope), access = storage.informationAccessPredicate("r", 2);
  const rows = await storage.query<{run_json: CorpusSegmentationRun; snapshot_json: {dependency: {id: string;count: number}}; inference_json: JsonValue;fits:boolean}>(`
    WITH selected AS (SELECT r.run_json,r.snapshot_json,r.inference_json,
      octet_length(convert_to(jsonb_build_object('run_json',r.run_json,'snapshot_json',r.snapshot_json,'inference_json',r.inference_json)::text,'UTF8')) <= $${2+access.params.length} AS fits
      FROM ${storage.table("segmentation_consolidation_active")} a JOIN ${storage.table("segmentation_consolidation_runs")} r ON r.run_id=a.run_id AND r.scope_id=a.scope_id
      WHERE a.scope_id=$1 AND r.state='complete' AND a.header_json=r.inference_json AND ${access.sql}${consistency?.lockForCommit ? ' FOR SHARE OF a' : ''})
    SELECT fits,CASE WHEN fits THEN run_json ELSE NULL END AS run_json,CASE WHEN fits THEN snapshot_json ELSE NULL END AS snapshot_json,
      CASE WHEN fits THEN inference_json ELSE NULL END AS inference_json FROM selected`, [scopeId,...access.params,bounds.maxPageBytes]);
  if (!rows.length) return null;
  if(!rows[0]!.fits)throw new Error("Active corpus segmentation exceeds decoded JSON budget");
  if (rows.length !== 1 || canonicalStringify(rows[0]!.run_json.scope) !== canonicalStringify(scope)) throw new Error("Malformed corpus segmentation active scope");
  const record = rows[0]!;
  if(record.run_json.recipeId!==required.recipeId || record.run_json.normalizationContractId!==required.normalizationContractId)throw new Error("Active corpus segmentation recipe or normalization is incompatible");
  const run = new PostgresCorpusSegmentationRun(storage,record.run_json,bounds);
  const current = await currentCorpusSegmentationDependency(storage,run);
  if (canonicalStringify(current) !== canonicalStringify(record.snapshot_json.dependency)) throw new Error("Active corpus segmentation source dependencies changed");
  return {run,inference:freezeOwned(structuredClone(validatePagedSegmentationInference(record.inference_json)))};
}
