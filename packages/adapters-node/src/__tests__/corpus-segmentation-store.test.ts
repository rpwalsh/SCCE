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
