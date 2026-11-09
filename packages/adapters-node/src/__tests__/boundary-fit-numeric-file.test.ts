// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
import { afterEach, expect, it } from "vitest";
import { mkdtemp, open, readFile, readdir, rename, rm, stat, truncate, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createBoundaryFitNumericFile } from "../boundary-fit-numeric-file.js";
import type { BoundaryFitNumericReplay, BoundaryFitNumericSection } from "@scce/kernel";

const roots:string[]=[];
afterEach(async()=>{for(const root of roots.splice(0))await rm(root,{recursive:true,force:true});});
const binding={statisticsId:"statistics.owned",headerDigest:"a".repeat(64),rowWidth:3,rowCount:3};
async function fixture(){const directory=await mkdtemp(path.join(tmpdir(),"scce-numeric-test-"));roots.push(directory);let file="";
  const replay=await createBoundaryFitNumericFile({pageRows:2,maxPageBytes:112},{directory,onFile:value=>{file=value;}});return{directory,file,replay};}
async function values(replay:BoundaryFitNumericReplay,section:BoundaryFitNumericSection,owner=binding){const result:number[]=[];
  for await(const page of replay.pages(section,owner))result.push(...page);return result;}

it("stores two exact IEEE sections in one byte-bounded private file and deletes it idempotently",async()=>{
  const f=await fixture(),first=new Float64Array([1/3,-0,9007199254740991,1e-300,-17.5,0]);
  try{
    await f.replay.append("training",binding,first);first.fill(99);
    await f.replay.append("training",binding,new Float64Array([1,2,3]));await f.replay.seal("training",binding);
    expect(await readdir(f.directory)).toEqual([path.basename(f.file)]);
    expect((await stat(f.file)).size).toBe(40+6*8+40+3*8);
    const restored=await values(f.replay,"training");expect(restored).toEqual([1/3,-0,9007199254740991,1e-300,-17.5,0,1,2,3]);expect(Object.is(restored[1],-0)).toBe(true);
    const heldout={...binding,statisticsId:"statistics.heldout",rowCount:1};
    await f.replay.append("calibration",heldout,new Float64Array([-0,1/1024,2/1024]));await f.replay.seal("calibration",heldout);
    expect(await values(f.replay,"calibration",heldout)).toEqual([-0,1/1024,2/1024]);
    expect(await values(f.replay,"training")).toEqual(restored);
    await expect(values(f.replay,"training",{...binding,statisticsId:"foreign"})).rejects.toThrow("changed binding");
  }finally{await f.replay.dispose();await f.replay.dispose();}
  expect(await readdir(f.directory)).toEqual([]);
  await expect(values(f.replay,"training")).rejects.toThrow("disposed");
});

it.each(["tamper","truncate","append"] as const)("rejects %s before returning an altered numeric page",async fault=>{
  const f=await fixture();try{
    const owner={...binding,rowCount:1};await f.replay.append("training",owner,new Float64Array([1,2,3]));await f.replay.seal("training",owner);
    if(fault==="tamper"){const handle=await open(f.file,"r+");try{await handle.write(new Uint8Array([255]),0,1,40);}finally{await handle.close();}}
    if(fault==="truncate")await truncate(f.file,43);
    if(fault==="append"){const handle=await open(f.file,"a");try{await handle.write("unexpected");}finally{await handle.close();}}
    let yielded=0;await expect((async()=>{for await(const page of f.replay.pages("training",owner))yielded+=page.length;})()).rejects.toThrow(/checksum|length|truncated/u);
    expect(yielded).toBe(0);
  }finally{await f.replay.dispose();}expect(await readdir(f.directory)).toEqual([]);
});

it("rejects over-budget, partial, reordered and nonfinite writes without changing file identity",async()=>{
  const f=await fixture();try{
    await expect(f.replay.append("calibration",binding,new Float64Array([1,2,3]))).rejects.toThrow("out of order");
    await expect(f.replay.append("training",binding,new Float64Array(9))).rejects.toThrow("bounds");
    await expect(f.replay.append("training",binding,new Float64Array([NaN,2,3]))).rejects.toThrow("not finite");
    await f.replay.append("training",binding,new Float64Array([1,2,3]));
    await expect(f.replay.seal("training",binding)).rejects.toThrow("inventory");
    await expect(values(f.replay,"training")).rejects.toThrow("unavailable");
  }finally{await f.replay.dispose();}expect(await readdir(f.directory)).toEqual([]);
});

it("closes and removes its file when preparation fails and refuses to unlink a replacement path",async()=>{
  const directory=await mkdtemp(path.join(tmpdir(),"scce-numeric-create-"));roots.push(directory);const primary=Error("preparation failed");
  await expect(createBoundaryFitNumericFile({pageRows:2,maxPageBytes:112},{directory,onFile:()=>{throw primary;}})).rejects.toBe(primary);
  expect(await readdir(directory)).toEqual([]);
  const f=await fixture();await rename(f.file,`${f.file}.owned`);await writeFile(f.file,"unrelated replacement");
  await expect(f.replay.dispose()).rejects.toThrow("no longer identifies");
  expect(await readFile(f.file,"utf8")).toBe("unrelated replacement");
});
