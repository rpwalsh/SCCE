// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
import { createHash } from "node:crypto";
import { canonicalStringify, joinInformationLabels, type InformationLabel, type JsonValue } from "@scce/kernel";
import type { PostgresStorageAdapter } from "./postgres.js";
import type { PostgresCorpusSegmentationRun } from "./corpus-segmentation-store.js";
interface Derivation {sourceVersionId:string;sourceId:string;parentSourceVersionId:string|null;sourceRole:string|null;informationLabel:InformationLabel}
const key=(value:string)=>createHash("sha256").update(value).digest("hex");
async function sourceRows(storage:PostgresStorageAdapter,run:PostgresCorpusSegmentationRun,ids:readonly string[]):Promise<Derivation[]> {
  const access=storage.informationAccessPredicate("sv",3);
  const rows=await storage.query<{value:JsonValue|null;fits:boolean}>(`WITH selected AS (
    SELECT sv.id,jsonb_build_object('sourceVersionId',sv.id,'sourceId',sv.source_id,'sourceRole',sv.metadata_json#>'{_scceSourceVersion,role}','parentSourceVersionId',sv.metadata_json#>'{_scceSourceVersion,derivation,derivedFromSourceVersionId}','informationLabel',sv.information_label) AS value
    FROM ${storage.table("source_versions")} sv WHERE sv.id=ANY($1::text[]) AND ${access.sql}
  ), measured AS (SELECT *,SUM(octet_length(convert_to(value::text,'UTF8'))) OVER(ORDER BY id COLLATE "C") AS decoded_bytes FROM selected)
    SELECT decoded_bytes <= $2 AS fits,CASE WHEN decoded_bytes <= $2 THEN value ELSE NULL END AS value FROM measured`,[ids,run.bounds.maxPageBytes,...access.params]);
  return rows.map(row=>{
    const value=row.value as unknown as Derivation;
    if(!row.fits||!value?.sourceVersionId||!value.sourceId||value.parentSourceVersionId!==null&&(typeof value.parentSourceVersionId!=="string"||!value.parentSourceVersionId.trim()))throw new Error("Malformed corpus segmentation derivation owner");
    if(value.sourceRole!==null&&value.sourceRole!=="original"&&value.sourceRole!=="evidence-derivative"
      ||value.sourceRole==="evidence-derivative"&&value.parentSourceVersionId===null
      ||value.sourceRole==="original"&&value.parentSourceVersionId!==null)throw new Error("Malformed canonical segmentation derivation role");
    const joined=joinInformationLabels([run.run.scope.informationLabel,value.informationLabel]);
    if(canonicalStringify(joined)!==canonicalStringify(run.run.scope.informationLabel))throw new Error("Corpus segmentation derivation exceeds declared owner scope");
    return value;
  });
}
/** Exact declared raw-owner lineage; cycles and unavailable parents never become independent families. */
export async function resolveCorpusSegmentationOwner(storage:PostgresStorageAdapter,run:PostgresCorpusSegmentationRun,sourceVersionId:string,sourceId:string,signal?:AbortSignal):Promise<string> {
  const cacheKey=key(sourceVersionId);
  for await(const page of run.pages("input/owner-families",{prefix:cacheKey,pageRows:1})){
    const cached=page[0]!.value as {sourceVersionId:string;sourceId:string;sourceFamilyId:string};
    if(cached.sourceVersionId!==sourceVersionId||cached.sourceId!==sourceId)throw new Error("Corpus segmentation owner identity collision");return cached.sourceFamilyId;
  }
  await run.scratch.deleteCollection("producer/owner-path");
  let current=sourceVersionId,rawOwner:string;
  for(;;){
    if(signal?.aborted)throw signal.reason??new Error("Corpus segmentation owner resolution aborted");
    const currentKey=key(current);
    for await(const ignored of run.scratch.pages({collection:"producer/owner-path",prefix:currentKey,pageRows:1,maxPageBytes:run.bounds.maxPageBytes})){
      void ignored;throw new Error("Corpus segmentation derivation cycle");
    }
    await run.scratch.putMany("producer/owner-path",[{orderKey:currentKey,value:current}]);
    const rows=await sourceRows(storage,run,[current]);
    if(rows.length!==1)throw new Error("Corpus segmentation derivation parent is missing or inaccessible");
    const record=rows[0]!;
    if(current===sourceVersionId&&record.sourceId!==sourceId)throw new Error("Corpus segmentation source/evidence owner binding differs");
    await run.putInput("derivations",[{orderKey:currentKey,value:record as unknown as JsonValue}]);
    if(record.parentSourceVersionId===null){rawOwner=record.sourceId;break;}
    current=record.parentSourceVersionId;
  }
  const bindings=run.run.scope.ownerFamilyBindings??[];
  const rootBinding=bindings.find(binding=>binding.sourceId===rawOwner),childBinding=bindings.find(binding=>binding.sourceId===sourceId);
  if(sourceId!==rawOwner&&childBinding&&(!rootBinding||childBinding.familyId!==rootBinding.familyId))throw new Error("Conflicting corpus segmentation owner family declarations");
  const sourceFamilyId=rootBinding?.familyId??rawOwner;
  await run.putInput("owner-families",[{orderKey:cacheKey,value:{sourceVersionId,sourceId,sourceFamilyId}}]);
  await run.scratch.deleteCollection("producer/owner-path");return sourceFamilyId;
}
export async function currentCorpusSegmentationDerivations(storage:PostgresStorageAdapter,run:PostgresCorpusSegmentationRun):Promise<{id:string;count:number}> {
  const hash=createHash("sha256");let count=0;
  for await(const page of run.pages("input/derivations")){
    const current=await sourceRows(storage,run,page.map(row=>(row.value as unknown as Derivation).sourceVersionId));
    const byId=new Map(current.map(value=>[value.sourceVersionId,value]));
    for(const row of page){const old=row.value as unknown as Derivation,value=byId.get(old.sourceVersionId);
      if(!value||canonicalStringify(value)!==canonicalStringify(old))throw new Error("Corpus segmentation derivation dependencies changed");
      hash.update(canonicalStringify({orderKey:row.orderKey,value}));hash.update("\n");count++;}
  }
  return {id:`sha256:${hash.digest("hex")}`,count};
}
