// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
import { expect, it } from "vitest";
import { segmentationOrdinalKey, sortSegmentationScratch } from "../corpus-segmentation-sort.js";
import type { CorpusSegmentationScratch, CorpusSegmentationScratchRow } from "../corpus-segmentation-cursor.js";
import { fixtureSegmentationScratch } from "./fixtures/corpus-segmentation-scratch.js";

async function fixture(fanIn=16){
  const memory=fixtureSegmentationScratch(2,2048),rows=Array.from({length:302},(_,index)=>({orderKey:segmentationOrdinalKey(index),value:{rank:index,group:(301-index)%11,text:`\u732b.e\u0301.\ud83e\udded.${index}`}}));
  await memory.putMany("source",rows);await memory.putMany("unrelated",[{orderKey:"x",value:"retained"}]);
  const writes:Array<{collection:string;rows:number}>=[];let active=0,maximum=0;
  const store:CorpusSegmentationScratch={...memory,sortMergeBudget:{maxResidentBytes:2048+fanIn*(2048+4),residentBytesPerInput:2048,residentOutputBytes:2048},
    async putMany(collection,values){writes.push({collection,rows:values.length});await memory.putMany(collection,values);},
    async *pages(query){const input=query.collection.startsWith("sorted.sort.");if(input){active++;maximum=Math.max(maximum,active);}
      try{yield* memory.pages(query);}finally{if(input)active--;}}};
  return{memory,store,rows,writes,maximum:()=>maximum,active:()=>active};
}
async function read(store:CorpusSegmentationScratch,collection:string){const rows:CorpusSegmentationScratchRow[]=[];
  for await(const page of store.pages({collection,pageRows:store.pageRows,maxPageBytes:store.maxPageBytes}))rows.push(...page);return rows;}

it("reduces 151 initial runs to two physical merge levels within the declared resident page/head budget",async()=>{
  const f=await fixture(),compare=(a:CorpusSegmentationScratchRow,b:CorpusSegmentationScratchRow)=>Number((a.value as {group:number}).group)-Number((b.value as {group:number}).group);
  await sortSegmentationScratch(f.store,"source","sorted",compare);
  const expected=[...f.rows].sort(compare).map((row,index)=>({...row,orderKey:segmentationOrdinalKey(index)}));
  expect(await read(f.store,"sorted")).toEqual(expected);
  const levels=f.writes.flatMap(row=>{const match=/\.sort\.(\d+)\./u.exec(row.collection);return match?[Number(match[1])]:[];});
  expect(Math.max(...levels)).toBe(2);expect(f.writes.reduce((sum,row)=>sum+row.rows,0)).toBe(f.rows.length*4);
  expect(f.maximum()).toBeLessThanOrEqual(16);expect(f.maximum()*2052+2048).toBeLessThanOrEqual(f.store.sortMergeBudget!.maxResidentBytes);
  expect(f.active()).toBe(0);expect(await f.memory.count("unrelated")).toBe(1);
});

it.each([2,7,64])("retains complete comparator ties, source order and cursor/prefix behavior at fan-in %i",async fanIn=>{
  const f=await fixture(fanIn);await sortSegmentationScratch(f.store,"source","sorted",()=>0);
  expect(await read(f.store,"sorted")).toEqual(f.rows);
  const prefix="00000000000002",afterKey=segmentationOrdinalKey(290),rows=[];
  for await(const page of f.store.pages({collection:"sorted",prefix,afterKey,pageRows:2,maxPageBytes:2048}))rows.push(...page);
  expect(rows).toEqual(f.rows.filter(row=>row.orderKey.startsWith(prefix)&&row.orderKey>afterKey));expect(f.active()).toBe(0);
});

it("closes every opened input and retains write plus unknown iterator cleanup failures",async()=>{
  const f=await fixture(7),primary=Error("output write failed"),cleanup={opaque:"input close failed"},put=f.store.putMany,pages=f.store.pages;let failure=false,opened=0,closed=0;
  f.store.putMany=async(collection,rows)=>{if(collection==="sorted.sort.1.0"){failure=true;throw primary;}await put(collection,rows);};
  f.store.pages=async function*(query){const input=query.collection.startsWith("sorted.sort.0.");if(input)opened++;
    try{yield* pages(query);}finally{if(input){closed++;if(failure&&query.collection==="sorted.sort.0.6")throw cleanup;}}};
  let received:unknown;try{await sortSegmentationScratch(f.store,"source","sorted",()=>0);}catch(error){received=error;}
  const flatten=(error:unknown):unknown[]=>error instanceof AggregateError?error.errors.flatMap(flatten):[error];
  expect(received).toBeInstanceOf(AggregateError);expect(flatten(received)).toContain(primary);expect(flatten(received)).toContain(cleanup);
  expect(opened).toBe(7);expect(closed).toBe(opened);expect(f.active()).toBe(0);
});

it("rejects insufficient or invalid declared budgets and preserves empty/single-run output",async()=>{
  const f=await fixture(),invalid={...f.store,sortMergeBudget:{maxResidentBytes:4096,residentBytesPerInput:2048,residentOutputBytes:2048}};
  await expect(sortSegmentationScratch(invalid,"source","sorted",()=>0)).rejects.toThrow("cannot hold");
  const empty=fixtureSegmentationScratch(2,2048);await sortSegmentationScratch(empty,"empty","sorted",()=>0);expect(await read(empty,"sorted")).toEqual([]);
  await empty.putMany("one",[{orderKey:"old",value:"\ud83e\udded"}]);await sortSegmentationScratch(empty,"one","sorted",()=>0);
  expect(await read(empty,"sorted")).toEqual([{orderKey:segmentationOrdinalKey(0),value:"\ud83e\udded"}]);
});
