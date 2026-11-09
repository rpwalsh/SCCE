// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
import { expect, it } from "vitest";
import { BOUNDARY_FEATURE_ORDER, compileBoundaryStatistics, type BoundaryFeatureVector } from "../boundary-estimator.js";
import type { BoundaryStatisticsCursor, CorpusSegmentationDocumentCursor, CorpusSegmentationScratch, CorpusSegmentationScratchRow } from "../corpus-segmentation-cursor.js";
import { learnPagedSegmentationPopulations } from "../paged-segmentation-population.js";
import { fixtureSegmentationScratch } from "./fixtures/corpus-segmentation-scratch.js";
import { canonicalStringify, createHasher, toJsonValue } from "../primitives.js";

const hasher=createHasher();
function source(scratch:CorpusSegmentationScratch):CorpusSegmentationDocumentCursor {
  const statistics=Array.from({length:8},(_,index)=>compileBoundaryStatistics({populationId:"population.source",sourceDocumentIds:[`owner.${index}.\u732b`],hasher,
    observations:[0,1].map(vector=>({sourceDocumentId:`owner.${index}.\u732b`,signalId:`signal.${vector}`,
      features:Object.fromEntries(BOUNDARY_FEATURE_ORDER.map((key,ordinal)=>[key,((ordinal+vector)%3)/3])) as unknown as BoundaryFeatureVector,
      positiveMass:vector?1:10+index,negativeMass:vector?10+index:1,supervision:"independent_anchor" as const,signalKind:"external_anchor" as const}))}));
  const cursors=statistics.map(({rows,sourceDocumentIds,...header}):BoundaryStatisticsCursor=>({
    header:{...header,rowCount:rows.length,sourceInventory:{id:hasher.digestHex(JSON.stringify(sourceDocumentIds)),count:sourceDocumentIds.length}},
    async *rows(){yield rows;},async *sourceDocuments(){yield sourceDocumentIds;}}));
  const documents=cursors.map((cursor,ordinal)=>({ordinal,documentId:`owner.${ordinal}.\u732b`,sourceFamilyId:`family.${ordinal}`,statistics:cursor.header}));
  return {scratch,documentCount:documents.length,sourceInventory:{id:hasher.digestHex(JSON.stringify(documents)),count:documents.length},
    async *documents(){yield documents;},statistics:document=>cursors[document.ordinal]!};
}
const fit=(scratch:CorpusSegmentationScratch)=>learnPagedSegmentationPopulations({rootPopulationId:"population.source",source:source(scratch),
  namespace:"fit",featureContextId:"context.owned",maxPopulations:1,hasher});
type Failure="heldout-creation"|"provisional-estimator"|"final-estimator"|"after-final-group";
function tracked(failure?:Failure,cleanupFailure?:unknown) {
  const primary=Error(`fit failure ${failure}`), leases:Array<{name:string;disposed:number;scratch:CorpusSegmentationScratch;collections:Set<string>}>=[];
  const scratch=fixtureSegmentationScratch(2),write=scratch.putMany;
  scratch.putMany=async(collection,rows)=>{if(failure==="after-final-group"&&collection==="fit.finalAssignments")throw primary;await write(collection,rows);};
  scratch.boundaryMergeScratch=()=>{
    const memory=fixtureSegmentationScratch(2),lease={name:"",disposed:0,scratch:memory,collections:new Set<string>()};leases.push(lease);
    const reads=new Map<string,number>();let triggered=false;
    const leased:CorpusSegmentationScratch={...memory,
      async putMany(collection,rows){lease.name ||= collection;lease.collections.add(collection);await memory.putMany(collection,rows);},
      async deleteCollection(collection){lease.name ||= collection;
        if(failure==="heldout-creation"&&collection==="fit.population.0.provisionalFit.heldout.rawRows")throw primary;
        await memory.deleteCollection(collection);},
      async *pages(query){const count=(reads.get(query.collection)??0)+1;reads.set(query.collection,count);
        const target=failure==="provisional-estimator"?"fit.population.0.provisionalFit.training.rows":failure==="final-estimator"?"fit.population.0.finalFit.training.rows":"";
        if(query.collection===target&&count===2){triggered=true;throw primary;}
        yield* memory.pages(query);}
    };
    return {scratch:leased,async dispose(){lease.disposed++;for(const collection of lease.collections)await memory.deleteCollection(collection);
      if(triggered&&cleanupFailure!==undefined)throw cleanupFailure;}};
  };
  return {scratch,leases,primary};
}
const flatten=(value:unknown):unknown[]=>value instanceof AggregateError?value.errors.flatMap(flatten):[value];
async function scratchRows(scratch:CorpusSegmentationScratch,collection:string){const rows:CorpusSegmentationScratchRow[]=[];
  for await(const page of scratch.pages({collection,pageRows:scratch.pageRows,maxPageBytes:scratch.maxPageBytes}))rows.push(...page);return rows;}
async function cursorValue(cursor:BoundaryStatisticsCursor){const rows=[],documents=[];
  for await(const page of cursor.rows())rows.push(...page);for await(const page of cursor.sourceDocuments())documents.push(...page);return{header:cursor.header,rows,documents};}

it.each(["heldout-creation","provisional-estimator","final-estimator","after-final-group"] as const)("releases every acquired cursor after %s failure without replacing the primary error",async failure=>{
  const f=tracked(failure);await expect(fit(f.scratch)).rejects.toBe(f.primary);
  expect(f.leases.length).toBeGreaterThan(1);
  expect(f.leases.every(lease=>lease.disposed===1)).toBe(true);
  for(const lease of f.leases)for(const collection of lease.collections)expect(await lease.scratch.count(collection)).toBe(0);
});

it("preserves an estimator failure plus an unknown cleanup failure and attempts heldout and provisional cleanup",async()=>{
  const cleanup={opaque:"cleanup refused"},f=tracked("provisional-estimator",cleanup);let received:unknown;
  try{await fit(f.scratch);}catch(error){received=error;}
  expect(received).toBeInstanceOf(AggregateError);expect(flatten(received)).toContain(f.primary);expect(flatten(received)).toContain(cleanup);
  expect(f.leases.some(lease=>lease.name.includes(".heldout."))).toBe(true);
  expect(f.leases.every(lease=>lease.disposed===1)).toBe(true);
  expect(await f.scratch.count("fit.population.0.provisionalFit.calibration.fit")).toBe(0);
  expect(await f.scratch.count("fit.population.0.provisionalFit.calibration.holdout")).toBe(0);
});

it("retains full model and artifact parity while returned population statistics remain live until caller disposal",async()=>{
  const baselineScratch=fixtureSegmentationScratch(2),expected=await fit(baselineScratch),f=tracked(),actual=await fit(f.scratch);
  const partitions:Record<string,CorpusSegmentationScratchRow[]>={},populationStatistics:Array<Awaited<ReturnType<typeof cursorValue>>>=[];
  expect(actual.model).toEqual(expected.model);
  expect(await scratchRows(f.scratch,actual.artifacts.assignments)).toEqual(await scratchRows(baselineScratch,expected.artifacts.assignments));
  for(const partition of Object.keys(actual.artifacts.partitions) as Array<keyof typeof actual.artifacts.partitions>){
    partitions[partition]=await scratchRows(f.scratch,actual.artifacts.partitions[partition]);
    expect(partitions[partition]).toEqual(await scratchRows(baselineScratch,expected.artifacts.partitions[partition]));}
  for(const [index,cursor] of actual.artifacts.populationStatistics.entries()){
    const artifact=await cursorValue(cursor);populationStatistics.push(artifact);
    expect(artifact).toEqual(await cursorValue(expected.artifacts.populationStatistics[index]!));
    const lease=f.leases.find(lease=>lease.name===`${cursor.storage!.rowsCollection.slice(0,-5)}.rawRows`)!;
    expect(lease.disposed).toBe(0);await cursor.dispose!();expect(lease.disposed).toBe(1);
  }
  expect(f.leases.every(lease=>lease.disposed===1)).toBe(true);
  // Captured from the original fitter at 388bdb3c, including every returned logical artifact.
  expect(hasher.digestHex(canonicalStringify(toJsonValue({model:actual.model,
    assignments:await scratchRows(f.scratch,actual.artifacts.assignments),partitions,populationStatistics}))))
    .toBe("35f9a6487677839e7ffc7205e4859452ea8bff8e3298ff5c39ebd843807acf48");
});
