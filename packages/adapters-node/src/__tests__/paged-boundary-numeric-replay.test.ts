// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
import { readFileSync } from "node:fs";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, expect, it } from "vitest";
import { canonicalStringify, collectBoundaryTrainingObservations, compileBoundaryStatistics, createHasher, measureSurfaceBoundaries,
  type BoundaryFitNumericReplay, type BoundaryStatisticsCursor, type BoundarySufficientStatistics } from "@scce/kernel";
import { fitPagedBoundaryEstimator } from "../../../kernel/src/paged-boundary-estimator.js";
import { createBoundaryFitNumericFile } from "../boundary-fit-numeric-file.js";

const roots:string[]=[],hasher=createHasher();
afterEach(async()=>{for(const root of roots.splice(0))await rm(root,{recursive:true,force:true});});
let measured:BoundarySufficientStatistics[]|undefined;
function genuine(){return measured??= ["dolly-human-creative-pair.json","oasst-human-russian-creative-pair.json"].map((name,index)=>{
  const text=(JSON.parse(readFileSync(new URL(`../../../kernel/src/__tests__/fixtures/${name}`,import.meta.url),"utf8")) as {text:string}).text;
  const documentId=`human.${index}.\u732b`,boundary=measureSurfaceBoundaries({documentId,text,maxUnits:Number.MAX_SAFE_INTEGER});
  return compileBoundaryStatistics({populationId:"population.genuine",observations:collectBoundaryTrainingObservations({lattices:[boundary]}),hasher});});}
function cursor(statistics:BoundarySufficientStatistics,onRead=()=>{}):BoundaryStatisticsCursor{
  const{rows,sourceDocumentIds,...header}=statistics;return{header:{...header,rowCount:rows.length,
    sourceInventory:{id:hasher.digestHex(JSON.stringify(sourceDocumentIds)),count:sourceDocumentIds.length}},
    async *rows(){onRead();for(let index=0;index<rows.length;index+=128)yield rows.slice(index,index+128);},async *sourceDocuments(){yield sourceDocumentIds;}};}
async function directory(){const root=await mkdtemp(path.join(tmpdir(),"scce-fit-replay-test-"));roots.push(root);return root;}

it("preserves complete genuine-source 96/160-pass inference with one bounded two-section file and only one preparation read per source",async()=>{
  const data=genuine(),baselineReads:[number,number]=[0,0],reads:[number,number]=[0,0],replays={training:0,calibration:0},root=await directory();let files=0,pages=0;
  const inputs=(counters:[number,number])=>({statistics:cursor(data[0]!,()=>{counters[0]++;}),calibrationStatistics:cursor(data[1]!,()=>{counters[1]++;}),hasher});
  const expected=await fitPagedBoundaryEstimator(inputs(baselineReads));
  const actual=await fitPagedBoundaryEstimator({...inputs(reads),numericReplay:async():Promise<BoundaryFitNumericReplay>=>{
    const original=await createBoundaryFitNumericFile({pageRows:4096,maxPageBytes:65536},{directory:root,onFile:()=>{files++;}});
    return{...original,append:async(section,binding,values)=>{pages++;expect(values.byteLength).toBeLessThanOrEqual(original.maxPageBytes);
      expect(values.length/binding.rowWidth).toBeLessThanOrEqual(original.pageRows);await original.append(section,binding,values);},
      pages:async function*(section,binding){replays[section]++;yield* original.pages(section,binding);}};
  }});
  expect(actual).toEqual(expected);expect(hasher.digestHex(canonicalStringify(actual))).toBe(hasher.digestHex(canonicalStringify(expected)));
  expect(actual.iterations).toBe(96);expect(actual.calibration.method).toBe("platt_heldout");
  expect(baselineReads).toEqual([97,161]);expect(reads).toEqual([2,2]);expect(replays).toEqual({training:96,calibration:160});
  expect(files).toBe(1);expect(pages).toBeGreaterThan(0);expect(await readdir(root)).toEqual([]);
});

it.each(["source-error","canonical-key-error"] as const)("refuses %s during first canonical preparation and removes the partial file without reread fallback",async fault=>{
  const root=await directory(),original=cursor(genuine()[0]!),primary=Error("source failed during preparation");let reads=0;
  original.rows=async function*(){reads++;const rows=genuine()[0]!.rows;
    if(fault==="canonical-key-error"){yield [...rows.slice(0,3)].reverse();return;}
    yield rows.slice(0,3);throw primary;};
  const pending=fitPagedBoundaryEstimator({statistics:original,hasher,numericReplay:()=>createBoundaryFitNumericFile({pageRows:2,maxPageBytes:4096},{directory:root})});
  if(fault==="source-error")await expect(pending).rejects.toBe(primary);else await expect(pending).rejects.toThrow(/not canonical/u);
  expect(reads).toBe(1);expect(await readdir(root)).toEqual([]);
});

it("preserves source failure plus unknown cleanup failure after closing the private snapshot",async()=>{
  const root=await directory(),source=cursor(genuine()[0]!),primary=Error("source unavailable"),cleanup={opaque:"cleanup failed"};
  source.rows=async function*(){throw primary;};let disposals=0,received:unknown;
  const numericReplay=async():Promise<BoundaryFitNumericReplay>=>{const original=await createBoundaryFitNumericFile({pageRows:2,maxPageBytes:4096},{directory:root});
    return{...original,dispose:async()=>{disposals++;await original.dispose();throw cleanup;}};};
  try{await fitPagedBoundaryEstimator({statistics:source,hasher,numericReplay});}catch(error){received=error;}
  expect(received).toBeInstanceOf(AggregateError);expect((received as AggregateError).errors).toEqual([primary,cleanup]);
  expect(disposals).toBe(1);expect(await readdir(root)).toEqual([]);
});
