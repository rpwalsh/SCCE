// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
import { expect, it } from "vitest";
import { createHash } from "node:crypto";
import { PostgresCorpusSegmentationRun, corpusSegmentationScopeId, segmentationOrdinalKey } from "../corpus-segmentation-store.js";
import type { PostgresStorageAdapter } from "../postgres.js";

const scope = { informationLabel: { tenantId: "owner",principals:["owner"],compartments:[],exportClass:"internal" as const,mergePolicy:"same_owner" as const } };
function fixture(state = "fitting") {
  const calls: Array<{sql:string;params:unknown[]}> = [];
  const storage = {
    table: (name:string) => `"fixture"."${name}"`, informationAccessPredicate: (alias:string,index:number) => ({sql:`${alias}.information_label->>'tenantId'=$${index}`,params:["owner"]}),
    query: async <T>(sql:string,params:unknown[]=[]):Promise<T[]> => { calls.push({sql,params});
      if (sql.includes("SELECT r.state")) return [{state}] as T[];
      if (sql.includes("RETURNING order_key")) return (JSON.parse(String(params[2])) as Array<{orderKey:string}>).map(row=>({order_key:row.orderKey})) as T[];
      if (sql.includes("AS count")) return [{count:"0"}] as T[];
      return [];
    }
  } as unknown as PostgresStorageAdapter;
  const run = new PostgresCorpusSegmentationRun(storage,{runId:"run-owned",scopeId:corpusSegmentationScopeId(scope),scope,recipeId:"recipe",normalizationContractId:"normalization",createdAt:1},{pageRows:2,maxPageBytes:400});
  return {run,calls,storage};
}
it("writes bounded batches and reclaims only the named current-run scratch collection",async()=>{
  const {run,calls}=fixture();
  await run.scratch.putMany("candidate.1",[0,1,2].map(value=>({orderKey:segmentationOrdinalKey(value),value:{value}})));
  const writes=calls.filter(call=>call.sql.includes("INSERT INTO")); expect(writes).toHaveLength(2);
  expect(writes.map(call=>JSON.parse(String(call.params[2])).length)).toEqual([2,1]);
  expect(writes.every(call=>call.params[0]==="run-owned"&&call.params[1]==="scratch/candidate.1")).toBe(true);
  await run.scratch.deleteCollection("candidate.1");
  const deletion=calls.find(call=>call.sql.startsWith("DELETE"))!;
  expect(deletion.params.slice(0,2)).toEqual(["run-owned","scratch/candidate.1"]);
  expect(deletion.sql).toContain("r.state IN ('building','fitting')"); expect(deletion.sql).not.toMatch(/TRUNCATE/iu);
});
it("keeps budget-deferred keys for the next page instead of dropping the rest of the header prefix",async()=>{
  const {run,storage,calls}=fixture(); const keys=[1,2,3].map(segmentationOrdinalKey); const original=storage.query.bind(storage);
  storage.query=async<T>(sql:string,params:unknown[]=[]):Promise<T[]>=>{
    if (!sql.includes("WITH candidate")) return original<T>(sql,params);
    calls.push({sql,params}); return keys.filter(key=>key>String(params[2])).slice(0,2).map((key,index)=>({order_key:key,admitted:index===0,row_json:index===0?{key}:null,decoded_bytes:200})) as T[];
  };
  const actual=[]; for await(const page of run.scratch.pages({collection:"rows",pageRows:2,maxPageBytes:400})) actual.push(...page.map(row=>row.orderKey));
  expect(actual).toEqual(keys);
  const reads=calls.filter(call=>call.sql.includes("WITH candidate"));
  expect(reads.map(call=>call.params[2])).toEqual(["",...keys]);
  expect(reads[0]!.sql).toContain("octet_length(convert_to(json_build_object"); expect(reads[0]!.sql).not.toContain("pg_column_size");
  expect(reads[0]!.sql).toContain('COLLATE "C"');
});
it("rejects oversized rows, foreign run access, and changed immutable input rather than reporting success",async()=>{
  const {run,storage}=fixture("building");
  await expect(run.putInput("inventory",[{orderKey:"1",value:"x".repeat(500)}])).rejects.toThrow(/byte budget/);
  storage.query=async<T>(sql:string):Promise<T[]>=>sql.includes("SELECT r.state")?[{state:"building"}] as T[]:[];
  await expect(run.putInput("inventory",[{orderKey:"1",value:"changed"}])).rejects.toThrow(/immutable input/);
  storage.query=async<T>():Promise<T[]>=>[];
  await expect(run.scratch.count("rows")).rejects.toThrow(/unavailable/);
});
it("hashes raw streamed bytes once without JSON transformation or concatenating the corpus",async()=>{
  const {run}=fixture(); async function* chunks(){yield Buffer.from("e\u0301");yield Buffer.from("??");}
  expect(await run.scratch.digestChunks(chunks())).toBe(createHash("sha256").update("e\u0301??").digest("hex"));
  expect(()=>segmentationOrdinalKey(-1)).toThrow(/ordinal/);
});

it("owns immutable copies of its scope and configured bounds",()=>{
  const {storage}=fixture();const declaration={runId:"separate",scopeId:corpusSegmentationScopeId(scope),scope:structuredClone(scope),recipeId:"recipe",normalizationContractId:"norm",createdAt:1};
  const bounds={pageRows:2,maxPageBytes:400},run=new PostgresCorpusSegmentationRun(storage,declaration,bounds);
  declaration.scope.informationLabel.principals.push("foreign");bounds.pageRows=10000;
  expect(run.run.scope.informationLabel.principals).toEqual(["owner"]);expect(run.bounds.pageRows).toBe(2);expect(run.scratch.pageRows).toBe(2);
});

it("uses indexed ASCII prefix bounds before decoded-byte measurement and preserves exact prefix and deferred cursors",async()=>{
  const {run,storage,calls}=fixture(),all=["a~0","a~1","a~2","a}0","b0"].map((orderKey,index)=>({orderKey,value:{index}}));
  const original=storage.query.bind(storage);
  storage.query=async<T>(sql:string,params:unknown[]=[]):Promise<T[]>=>{
    if(!sql.includes("WITH candidate"))return original<T>(sql,params);
    calls.push({sql,params});const after=String(params[2]),prefix=String(params[3]);
    return all.filter(row=>row.orderKey>after&&row.orderKey.startsWith(prefix)).slice(0,2).map((row,index)=>({order_key:row.orderKey,row_json:index===0?row.value:null,decoded_bytes:200,admitted:index===0})) as T[];
  };
  const rows=[];for await(const page of run.scratch.pages({collection:"rows",prefix:"a~"}))rows.push(...page);
  expect(rows).toEqual(all.slice(0,3));
  const queries=calls.filter(call=>call.sql.includes("WITH candidate"));
  expect(queries.map(call=>call.params[2])).toEqual(["","a~0","a~1","a~2"]);
  expect(queries[0]!.sql).toContain('v.order_key COLLATE "C" >= $4::text COLLATE "C"');
  expect(queries[0]!.sql).toContain('v.order_key COLLATE "C" < ($4::text || chr(127)) COLLATE "C"');
  expect(queries[0]!.sql).toContain('starts_with(v.order_key,$4)');
  expect(queries[0]!.sql.indexOf('chr(127)')).toBeLessThan(queries[0]!.sql.indexOf('), measured AS'));
  for(const prefix of ["opaque\u03bb","bad\u007f","bad\n",null as unknown as string,123 as unknown as string]){
    await expect(async()=>{for await(const _page of run.scratch.pages({collection:"rows",prefix})){} }).rejects.toThrow(/ASCII/);
  }
});

it("replays immutable inputs without rewriting their stored rows and refuses changed or snapshot-invisible conflicts",async()=>{
  const {run,storage,calls}=fixture("building"),values=new Map<string,unknown>();let identicalUpdates=0,invisible=false;
  const original=storage.query.bind(storage);
  storage.query=async<T>(sql:string,params:unknown[]=[]):Promise<T[]>=>{
    if(sql.includes("WITH candidate")){
      calls.push({sql,params});const collection=String(params[1])+":";
      return [...values].filter(([key])=>key.startsWith(collection)).map(([key,value])=>({order_key:key.slice(collection.length),row_json:value,decoded_bytes:100,admitted:true}))
        .filter(row=>row.order_key>String(params[2])&&row.order_key.startsWith(String(params[3]))).sort((a,b)=>a.order_key<b.order_key?-1:a.order_key>b.order_key?1:0).slice(0,Number(params[4])) as T[];
    }
    if(!sql.includes("INSERT INTO"))return original<T>(sql,params);
    calls.push({sql,params});const rows=JSON.parse(String(params[2])) as Array<{orderKey:string;value:unknown}>;
    const written=[];
    for(const row of rows){const key=String(params[1])+":"+row.orderKey;
      if(!values.has(key)){values.set(key,structuredClone(row.value));written.push({order_key:row.orderKey});}
      else if(!invisible&&JSON.stringify(values.get(key))===JSON.stringify(row.value)){
        if(sql.includes("DO UPDATE"))identicalUpdates++;written.push({order_key:row.orderKey});
      }
    }return written as T[];
  };
  const rows=[{orderKey:"1",value:{opaque:[1,"\u03bb",null]}},{orderKey:"2",value:{other:true}}];
  await run.putInput("inventory",rows);const before=JSON.stringify([...values]),digest=await run.digest("input/inventory");
  await run.putInput("inventory",rows);expect(JSON.stringify([...values])).toBe(before);expect(identicalUpdates).toBe(0);
  expect(digest.count).toBe(rows.length);expect(await run.digest("input/inventory")).toEqual(digest);
  const inputWrites=calls.filter(call=>call.sql.includes("INSERT INTO"));
  expect(inputWrites.every(call=>call.sql.includes("DO NOTHING")&&!call.sql.includes("DO UPDATE"))).toBe(true);
  expect(inputWrites[0]!.sql).toContain('existing.row_json=v.value');
  expect(inputWrites[0]!.sql).toContain("r.state='building'");
  expect(inputWrites[0]!.sql).toContain("r.information_label->>'tenantId'=$4");
  expect(inputWrites[0]!.sql).toContain("FOR SHARE");
  await expect(run.putInput("inventory",[{orderKey:"1",value:{changed:true}}])).rejects.toThrow(/immutable input/);
  invisible=true;await expect(run.putInput("inventory",rows)).rejects.toThrow(/immutable input/);
  expect(JSON.stringify([...values])).toBe(before);
  invisible=false;await run.scratch.putMany("rows",[{orderKey:"1",value:1}]);
  expect(calls.at(-1)!.sql).toContain("DO UPDATE SET row_json=EXCLUDED.row_json");
});
