// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
import { createHash } from "node:crypto";
import { expect, it } from "vitest";
import { canonicalNormalizationContract, canonicalStringify, createHasher, learnPagedSegmentationPopulations, prepareCorpusSegmentationMeasurement, type JsonValue } from "@scce/kernel";
import { fixtureSegmentationScratch } from "../../../kernel/src/__tests__/fixtures/corpus-segmentation-scratch.js";
import { activateCorpusSegmentationRun, readActiveCorpusSegmentationRun, createCorpusSegmentationRun, corpusSegmentationScopeId, segmentationOrdinalKey } from "../corpus-segmentation-store.js";
import { consolidateCorpusSegmentation, loadCorpusSegmentationContextSlice, corpusSegmentationInputRecipe, prepareCorpusSegmentationInput } from "../corpus-segmentation-producer.js";
import type { PostgresStorageAdapter } from "../postgres.js";

async function fixture(pageRows:number, corrupt=false, sourceCount=2, sharedFamily=true, initialize=true) {
  const memory=fixtureSegmentationScratch(pageRows,12000), calls:Array<{sql:string;params:unknown[]}>=[];
  const label={tenantId:"owner",principals:["owner"],compartments:[],exportClass:"internal" as const,mergePolicy:"same_owner" as const};
  const texts=Array.from({length:sourceCount},(_,index)=>index%2===0?`opaque alpha delta. opaque beta delta. opaque alpha delta. e\u0301?? ${index}`:`opaque alpha delta. opaque gamma delta. opaque alpha delta. ??? ${index}`);
  const owners=texts.map((text,index)=>({evidenceId:`evidence.${index}`,sourceId:`source.${index}`,sourceVersionId:`version.${index}`,
    sourceContentHash:`hash.${index}`,evidenceContentHash:`sha256_${createHash("sha256").update(text).digest("hex")}`,textSha256:createHash("sha256").update(text).digest("hex"),
    codePoints:[...text].length,sourceFamilyId:`source.${index}`,byteStart:0,byteEnd:Buffer.byteLength(text),charStart:0,charEnd:[...text].length,
    informationLabel:label,sourceInformationLabel:label}));
  let state="building", runJson:JsonValue=null, snapshot:unknown, active:JsonValue|null=null, failPublication=false;
  let leased=false;
  const pool={options:{max:2},connect:async()=>({query:async(sql:string)=>{
    if(sql.includes("pg_try_advisory_lock")){const acquired=!leased;if(acquired)leased=true;return {rows:[{acquired}]};}
    const released=leased;leased=false;return {rows:[{released}]};},release:(destroy?:boolean)=>{if(destroy)leased=false;}})};
  const storage={pool,schema:"fixture",table:(name:string)=>`"fixture"."${name}"`,requireWritableInformationLabel:()=>label,
    informationAccessPredicate:(alias:string,index:number)=>({sql:`${alias}.information_label->>'tenantId'=$${index}`,params:["owner"]}),
    transaction:async<T>(operation:()=>Promise<T>)=>{const previousState=state,previousActive=active;try{return await operation();}catch(error){state=previousState;active=previousActive;throw error;}},
    mutateLanguageMemory:async(sql:string,params:unknown[])=>{calls.push({sql,params});state="complete";active=JSON.parse(String(params[2]));if(failPublication)throw new Error("publication failed");return true;},
    query:async<T>(sql:string,params:unknown[]=[]):Promise<T[]>=>{ calls.push({sql,params});
      if(sql.includes("pg_catalog.pg_trigger"))return [{valid:true}] as T[];
      if(sql.includes("INSERT INTO")&&sql.includes("(run_id,scope_id,state,run_json")){runJson=JSON.parse(String(params[2]));return [{run_id:"owned-run"}] as T[];}
      if(sql.includes("segmentation_consolidation_active")&&sql.includes("SELECT r.run_json"))return active&&params[0]===(runJson as Record<string,JsonValue>).scopeId?[{run_json:runJson,snapshot_json:snapshot,inference_json:active,fits:true}] as T[]:[];
      if(sql.includes("END AS run_json")&&!sql.includes("segmentation_consolidation_active"))return [{fits:true,run_json:runJson}] as T[];
      if(sql.includes("SELECT r.run_json"))return [{run_json:runJson}] as T[];
      if(sql.includes("SELECT r.snapshot_json"))return sql.includes("JOIN")&&(!active||state!=="complete"||(active as Record<string,JsonValue>).id!==params[1])?[]:[{snapshot_json:snapshot}] as T[];
      if(sql.startsWith("LOCK TABLE"))return [];
      if(sql.includes("SELECT r.state"))return [{state}] as T[];
      if(sql.includes("'input/inventory'")) {await memory.putMany("input/inventory",owners.map((value,index)=>({orderKey:segmentationOrdinalKey(index+1),value})));return [];}
      if(sql.includes("RETURNING order_key")){const rows=JSON.parse(String(params[2]));await memory.putMany(String(params[1]),rows);return rows.map((row:any)=>({order_key:row.orderKey})) as T[];}
      if(sql.includes("WITH selected AS"))return (params[0] as string[]).flatMap(id=>{const source=owners.find(owner=>owner.sourceVersionId===id);return source?[{fits:true,value:{sourceVersionId:source.sourceVersionId,sourceId:source.sourceId,parentSourceVersionId:null,sourceRole:"original",informationLabel:label}}]:[];}) as T[];
      if(sql.includes("SELECT substring")){const index=owners.findIndex(owner=>owner.evidenceId===params[0]);const text=texts[index]!;
        return [{text:corrupt?"changed":[...text].slice(Number(params[2])-1,Number(params[2])-1+Number(params[3])).join("")}] as T[];}
      if(sql.includes("SELECT q.key")){const requested=JSON.parse(String(params[2])) as Array<{key:string}>;const field=sql.includes("'surfaceFormClassId'=q.key")?"surfaceFormClassId":"contextKey";const pairs:Array<{orderKey:string;value:JsonValue}>=[];
        for await(const page of memory.pages({collection:String(params[1]),pageRows,maxPageBytes:12000}))pairs.push(...page);
        return requested.map(row=>({key:row.key,count:String(pairs.filter(pair=>(pair.value as Record<string,JsonValue>)[field]===row.key).length)})) as T[];}
      if(sql.includes("WITH candidate")&&sql.includes("evidence_id"))return owners.filter(owner=>owner.evidenceId>String(params[0])).slice(0,pageRows).map(row_json=>({evidence_id:row_json.evidenceId,row_json,admitted:true})) as T[];
      if(sql.includes("WITH candidate")){const rows=[];for await(const page of memory.pages({collection:String(params[1]),afterKey:String(params[2]),prefix:String(params[3]),pageRows:Number(params[4]),maxPageBytes:12000})){rows.push(...page);break;}
        return rows.map(row=>({order_key:row.orderKey,row_json:row.value,admitted:true,decoded_bytes:Buffer.byteLength(JSON.stringify(row))})) as T[];}
      if(sql.startsWith("DELETE")){await memory.deleteCollection(String(params[1]));return [];}
      if(sql.includes("SET state='fitting'")){state="fitting";snapshot=JSON.parse(String(params[1]));return [{run_id:"owned-run"}] as T[];}
      if(sql.includes("AS count"))return [{count:String(await memory.count(String(params[1])))}] as T[];
      throw new Error(`Unimplemented fixture SQL: ${sql.slice(0,80)}`);
    }} as unknown as PostgresStorageAdapter;
  const scope={informationLabel:label,ownerFamilyBindings:sharedFamily?owners.map(owner=>({sourceId:owner.sourceId,familyId:"one-owned-family"})):[]}, declaration={runId:"owned-run",scopeId:corpusSegmentationScopeId(scope),scope,
    normalizationContractId:canonicalNormalizationContract(createHasher()).id,recipeId:corpusSegmentationInputRecipe(28),createdAt:1};
  const bounds={pageRows,maxPageBytes:12000};
  const run=initialize?await createCorpusSegmentationRun(storage,declaration,bounds):null!;
  return {storage,run,declaration,bounds,memory,calls,owners,texts,getSnapshot:()=>snapshot,getState:()=>state,getActive:()=>active,setPublicationFailure:(value:boolean)=>{failPublication=value;}};
}
it("compiles all owned Unicode windows through the real statistics producer without inflating documents or families",async()=>{
  const f=await fixture(2), cursor=await prepareCorpusSegmentationInput({storage:f.storage,run:f.run,windowUtf16:28});
  const documents=[];for await(const page of cursor.documents())documents.push(...page);
  expect(documents.map(document=>document.documentId)).toEqual(f.owners.map(owner=>owner.evidenceId));
  expect(documents.every(document=>document.sourceFamilyId==="one-owned-family")).toBe(true);
  expect(cursor.sourceInventory.count).toBe(2);expect(await f.memory.count("input/coverage")).toBeGreaterThan(2);
  for(const document of documents){const statistics=cursor.statistics(document);expect(statistics.header.sourceInventory.count).toBe(1);
    const ids=[];for await(const page of statistics.sourceDocuments())ids.push(...page);expect(ids).toEqual([document.documentId]);
    expect(statistics.header.positiveMass+statistics.header.negativeMass).toBeGreaterThan(0);}
  expect(f.getState()).toBe("fitting");expect(f.getSnapshot()).toMatchObject({snapshot:{completeUnicodeCoverage:true,documentCount:2,coveredUtf16:f.texts.reduce((sum,text)=>sum+text.length,0)}});
  expect(await f.memory.count("scratch/producer/windows")).toBe(0);
  expect(f.calls.some(call=>call.sql.includes("e.status='promoted'")&&call.sql.includes("sv.information_label=")&&call.sql.includes("e.information_label="))).toBe(true);
  const inventorySql=f.calls.filter(call=>call.sql.includes("'evidenceContentHash'"));
  expect(inventorySql.length).toBeGreaterThan(0);
  expect(inventorySql.every(call=>call.sql.includes("encode(e.text_sha256,'hex')")&&call.sql.includes("'codePoints',e.char_end-e.char_start"))).toBe(true);
  expect(inventorySql.some(call=>/sha256\(.*text_content|char_length\(e.text_content\)/u.test(call.sql))).toBe(false);
});
it("has identical source/statistics identities across storage page sizes",async()=>{
  const results=[];
  for(const size of [1,3]){const f=await fixture(size);const cursor=await prepareCorpusSegmentationInput({storage:f.storage,run:f.run,windowUtf16:28});const documents=[];
    for await(const page of cursor.documents())documents.push(...page);results.push(canonicalStringify({sourceInventory:cursor.sourceInventory,documents,context:cursor.featureContextId}));}
  expect(results[0]).toBe(results[1]);
});
it("refuses changed canonical bytes before a fit snapshot can be sealed",async()=>{
  const f=await fixture(2,true);await expect(prepareCorpusSegmentationInput({storage:f.storage,run:f.run,windowUtf16:28})).rejects.toThrow(/length differs|hash differs/);
  expect(f.getState()).toBe("building");expect(f.getSnapshot()).toBeUndefined();
});

it("reuses complete owned preparation across an owner abort without rereading source bytes",async()=>{
  const f=await fixture(2),controller=new AbortController();
  await expect(prepareCorpusSegmentationInput({storage:f.storage,run:f.run,windowUtf16:28,signal:controller.signal,onProgress:progress=>{
    if(progress.phase==="collecting-context"&&progress.completedOwners===1)controller.abort(new Error("owner stop"));
  }})).rejects.toThrow("owner stop");
  expect(f.getState()).toBe("building");
  const firstReads=f.calls.filter(call=>call.sql.includes("SELECT substring")&&call.params[0]==="evidence.0").length;
  const resumed=await prepareCorpusSegmentationInput({storage:f.storage,run:f.run,windowUtf16:28});
  expect(resumed.documentCount).toBe(2);
  expect(f.calls.filter(call=>call.sql.includes("SELECT substring")&&call.params[0]==="evidence.0")).toHaveLength(firstReads);
});

it("fits real source observations then publishes one matched snapshot atomically and validates cold scoped reads",async()=>{
  const f=await fixture(3,false,8,false),cursor=await prepareCorpusSegmentationInput({storage:f.storage,run:f.run,windowUtf16:28});
  let rootPopulationId="";for await(const page of cursor.documents()){rootPopulationId=page[0]!.statistics.populationId;break;}
  const {model}=await learnPagedSegmentationPopulations({rootPopulationId,source:cursor,namespace:"fit",featureContextId:cursor.featureContextId,maxPopulations:1});
  f.setPublicationFailure(true);
  await expect(activateCorpusSegmentationRun(f.storage,f.run,model)).rejects.toThrow("publication failed");
  expect(f.getActive()).toBeNull();expect(f.getState()).toBe("fitting");
  f.setPublicationFailure(false);await activateCorpusSegmentationRun(f.storage,f.run,model);
  expect(f.getState()).toBe("complete");
  const required={recipeId:f.run.run.recipeId,normalizationContractId:f.run.run.normalizationContractId};
  const read=await readActiveCorpusSegmentationRun(f.storage,f.run.run.scope,required,f.run.bounds);
  expect(read?.inference).toEqual(model);
  const preparation=prepareCorpusSegmentationMeasurement({documentId:"new-window",text:"novel ???"});
  const slice=await loadCorpusSegmentationContextSlice({storage:f.storage,run:f.run,measurement:preparation,expected:model});
  expect(slice.binding).toMatchObject({measurementId:preparation.id,snapshotId:model.sourceInventory.id,contextId:model.featureContextId});
  expect(Object.keys(slice.featureContext.documentCountBySurfaceFormClass).sort()).toEqual([...preparation.requiredClassIds].sort());
  expect(Object.values(slice.featureContext.documentCountBySurfaceFormClass)).toContain(0);
  await expect(readActiveCorpusSegmentationRun(f.storage,f.run.run.scope,{...required,recipeId:"different"},f.run.bounds)).rejects.toThrow(/incompatible/);
  await expect(loadCorpusSegmentationContextSlice({storage:f.storage,run:f.run,measurement:preparation,expected:{...model,featureContextId:"different"}})).rejects.toThrow(/does not match/);
  const owned=f.owners[0]!,originalDigest=owned.textSha256;
  const identityBefore={evidenceId:owned.evidenceId,sourceVersionId:owned.sourceVersionId,evidenceContentHash:owned.evidenceContentHash};
  owned.textSha256=createHash("sha256").update("same declared hash, modified actual body").digest("hex");
  await expect(readActiveCorpusSegmentationRun(f.storage,f.run.run.scope,required,f.run.bounds)).rejects.toThrow(/dependencies changed/);
  expect({evidenceId:owned.evidenceId,sourceVersionId:owned.sourceVersionId,evidenceContentHash:owned.evidenceContentHash}).toEqual(identityBefore);
  owned.textSha256=originalDigest;
  expect((await readActiveCorpusSegmentationRun(f.storage,f.run.run.scope,required,f.run.bounds))?.inference.id).toBe(model.id);
  f.owners[0]!.sourceVersionId="changed-version";
  await expect(readActiveCorpusSegmentationRun(f.storage,f.run.run.scope,required,f.run.bounds)).rejects.toThrow(/dependencies changed|derivation dependencies/);
});

it("exposes one ordinary consolidation workflow with idempotent resume and declared fit-policy binding",async()=>{
  const f=await fixture(3,false,8,false,false),options={storage:f.storage,scope:f.declaration.scope,runId:"owned-run",createdAt:1,bounds:f.bounds,windowUtf16:28,maxPopulations:1};
  const created=await consolidateCorpusSegmentation(options);expect(created.alreadyComplete).toBe(false);
  const reads=f.calls.filter(call=>call.sql.includes("SELECT substring")).length,writes=f.calls.filter(call=>call.sql.includes("INSERT INTO")).length;
  const resumed=await consolidateCorpusSegmentation({...options,resume:true});
  expect(resumed).toMatchObject({alreadyComplete:true,runId:created.runId});expect(resumed.model).toEqual(created.model);
  expect(f.calls.filter(call=>call.sql.includes("SELECT substring"))).toHaveLength(reads);
  expect(f.calls.filter(call=>call.sql.includes("INSERT INTO"))).toHaveLength(writes);
  await expect(consolidateCorpusSegmentation({...options,resume:true,maxPopulations:2})).rejects.toThrow(/declaration differs/);
});

it("singleflights identical in-process jobs while refusing conflicting scope or fit declarations",async()=>{
  const f=await fixture(3,false,8,false,false),options={storage:f.storage,scope:f.declaration.scope,runId:"owned-run",createdAt:1,bounds:f.bounds,windowUtf16:28,maxPopulations:1};
  const first=consolidateCorpusSegmentation(options),second=consolidateCorpusSegmentation({...options,resume:true});
  await expect(consolidateCorpusSegmentation({...options,maxPopulations:2})).rejects.toThrow(/declaration differs/);
  const [a,b]=await Promise.all([first,second]);expect(a.model.id).toBe(b.model.id);expect(a.runId).toBe(b.runId);
  expect(f.calls.filter(call=>call.sql.includes("(run_id,scope_id,state,run_json"))).toHaveLength(1);
});

it("rejects disagreement between the declared span hash and the actual maintained body digest",async()=>{
  const f=await fixture(2);f.owners[0]!.textSha256=createHash("sha256").update("tampered body").digest("hex");
  await f.memory.putMany("input/inventory",f.owners.map((value,index)=>({orderKey:segmentationOrdinalKey(index+1),value})));
  await expect(prepareCorpusSegmentationInput({storage:f.storage,run:f.run,windowUtf16:28})).rejects.toThrow(/source ownership/);
  expect(f.getState()).toBe("building");expect(f.getSnapshot()).toBeUndefined();
});
