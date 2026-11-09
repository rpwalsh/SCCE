// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
import {readFileSync} from "node:fs";
import {beforeAll,expect,it} from "vitest";
import {collectBoundaryTrainingObservations,measureSurfaceBoundaries} from "../surface-lattice.js";
import {compileBoundaryStatistics,type BoundarySufficientStatistics} from "../boundary-estimator.js";
import {learnPagedSegmentationPopulations,PagedPopulationWorkspace,type PagedPopulationCandidateExecution} from "../paged-segmentation-population.js";
import type {BoundaryStatisticsCursor,CorpusSegmentationDocumentCursor} from "../corpus-segmentation-cursor.js";
import {fixtureSegmentationScratch} from "./fixtures/corpus-segmentation-scratch.js";
import {canonicalStringify,createHasher,toJsonValue} from "../primitives.js";
const hasher=createHasher();let statistics:BoundarySufficientStatistics[];
beforeAll(()=>{
  const read=(file:string)=>JSON.parse(readFileSync(new URL(`./fixtures/${file}`,import.meta.url),"utf8")) as {turns:{surface:string}[]};
  const messages=[...read("dolly-human-window-160-193.json").turns.slice(0,14),...read("oasst-human-russian-creative-pair.json").turns];
  statistics=messages.map(({surface},ordinal)=>compileBoundaryStatistics({populationId:"population.human",sourceDocumentIds:[`owner.human.${ordinal}`],hasher,
    observations:collectBoundaryTrainingObservations({lattices:[measureSurfaceBoundaries({documentId:`owner.human.${ordinal}`,text:surface,maxUnits:Number.MAX_SAFE_INTEGER})]})}));
});
function fixture(){
  const memory=fixtureSegmentationScratch(2),collections=new Set<string>();let signaturePhase=false,signatureReads=0;
  const scratch={...memory,
    async deleteCollection(collection:string){if(collection.endsWith(".signatures"))signaturePhase=await memory.count(collection)===0;await memory.deleteCollection(collection);},
    pages(query:Parameters<typeof memory.pages>[0]){if(query.collection.endsWith(".signatures"))signaturePhase=false;return memory.pages(query);},
    async putMany(collection:string,rows:Parameters<typeof memory.putMany>[1]){collections.add(collection);await memory.putMany(collection,rows);}};
  const cursors=statistics.map(({rows,sourceDocumentIds,...header}):BoundaryStatisticsCursor=>({header:{...header,rowCount:rows.length,sourceInventory:{id:hasher.digestHex(JSON.stringify(sourceDocumentIds)),count:1}},
    async *rows(){if(signaturePhase)signatureReads++;for(let index=0;index<rows.length;index+=2)yield rows.slice(index,index+2);},async *sourceDocuments(){yield sourceDocumentIds;}}));
  const documents=cursors.map((cursor,ordinal)=>({ordinal,documentId:`owner.human.${ordinal}`,sourceFamilyId:`source.human.${ordinal}`,statistics:cursor.header}));
  const source:CorpusSegmentationDocumentCursor={scratch,documentCount:documents.length,sourceInventory:{id:hasher.digestHex(canonicalStringify(documents)),count:documents.length},
    async *documents(){yield documents;},statistics:document=>cursors[document.ordinal]!};
  return {source,scratch,memory,collections,signatureReads:()=>signatureReads};
}
const fit=(f:ReturnType<typeof fixture>,candidateExecution?:PagedPopulationCandidateExecution)=>learnPagedSegmentationPopulations({source:f.source,
  namespace:"fit",rootPopulationId:"population.human",featureContextId:"context.human",maxPopulations:3,candidateExecution});
async function retained(f:ReturnType<typeof fixture>){const output=[];
  for(const collection of [...f.collections].sort()){const rows=[];for await(const page of f.memory.pages({collection,pageRows:2,maxPageBytes:f.memory.maxPageBytes}))rows.push(...page);if(rows.length)output.push({collection,rows});}
  return output;
}
it("reads each real human document once per distinct fit cohort and retains the original complete artifact digest",async()=>{
  const f=fixture(),result=await fit(f),fitCount=await f.memory.count("fit.partition.fit"),finalCount=fitCount+await f.memory.count("fit.partition.modelSelection")+await f.memory.count("fit.partition.mergeGuard");
  expect(result.model.selection.candidates).toHaveLength(3);
  const digest=hasher.digestHex(canonicalStringify(toJsonValue({model:result.model,rows:await retained(f)})));
  // Captured from 91e2e417 before shared ranking, including all retained scratch rows and the complete model.
  expect(digest).toBe("df00c0b0c4934026ed8d57c9964b7553b700775e2f9eb90da8c142c473601eeb");
  expect(f.signatureReads()).toBe(fitCount+(finalCount===fitCount?0:finalCount));
  expect(await f.memory.count("fit.candidateFit.ranked")).toBe(0);expect(await f.memory.count("fit.final.ranked")).toBe(0);
});
it("binds the shared ranking into worker preparation and releases it after an execution failure",async()=>{
  const f=fixture(),primary=Error("candidate execution failed");let ranked="";
  await expect(fit(f,{async fitCandidates(prepared,jobs){
    const ranking=prepared.fitRanking!;ranked=ranking.collection;expect(ranking.documentCount).toBeGreaterThan(0);
    expect(prepared.collections.find(collection=>collection.name===ranked)?.count).toBe(ranking.documentCount);
    expect(jobs.every(job=>canonicalStringify(job.ranking)===canonicalStringify(ranking))).toBe(true);throw primary;
  }})).rejects.toBe(primary);
  expect(await f.memory.count(ranked)).toBe(0);expect(await f.memory.count("fit.documents")).toBe(16);
});
it("rejects changed ranked rows through the same prepared workspace digest used by workers",async()=>{
  const f=fixture(),primary=Error("ranking changed");let ranked="";
  await expect(fit(f,{async fitCandidates(prepared){
    ranked=prepared.fitRanking!.collection;let changed=false;
    for await(const page of f.memory.pages({collection:ranked,pageRows:2,maxPageBytes:f.memory.maxPageBytes})){
      const row=page[0]!;await f.memory.putMany(ranked,[{...row,value:{changed:true}}]);changed=true;break;
    }
    expect(changed).toBe(true);const work=new PagedPopulationWorkspace(f.source,prepared.rootPopulationId,prepared.namespace);
    await expect(work.verifyPrepared(prepared)).rejects.toThrow("changed");throw primary;
  }})).rejects.toBe(primary);expect(await f.memory.count(ranked)).toBe(0);
});
it("retains execution and cleanup errors when shared ranking disposal fails",async()=>{
  const f=fixture(),primary=Error("candidate failed"),cleanup={opaque:"ranking disposal failed"},remove=f.scratch.deleteCollection;let failed=false;
  f.scratch.deleteCollection=async collection=>{if(failed&&collection==="fit.candidateFit.ranked")throw cleanup;await remove(collection);};
  let result:unknown;try{await fit(f,{async fitCandidates(){failed=true;throw primary;}});}catch(error){result=error;}
  expect(result).toBeInstanceOf(AggregateError);expect((result as AggregateError).errors).toEqual([primary,cleanup]);
  expect(await f.memory.count("fit.documents")).toBe(16);
});
it.each(["source","sort","final-assignment"] as const)("releases signature/ranking storage after a %s failure while retaining canonical prepared documents",async failure=>{
  const f=fixture(),primary=Error(`ranking ${failure} failed`),put=f.scratch.putMany,statistics=f.source.statistics;
  if(failure==="source")f.source.statistics=document=>{const original=statistics(document);return {...original,rows:async function*(){throw primary;yield [];}};};
  else f.scratch.putMany=async(collection,rows)=>{f.collections.add(collection);if(failure==="sort"&&collection.startsWith("fit.candidateFit.ranked.sort.1.")||failure==="final-assignment"&&collection==="fit.final.assignment.0")throw primary;await put(collection,rows);};
  await expect(fit(f)).rejects.toBe(primary);
  for(const collection of f.collections)if(collection.startsWith("fit.candidateFit.")||collection.startsWith("fit.final.ranked")||collection==="fit.final.signatures")expect(await f.memory.count(collection)).toBe(0);
  expect(await f.memory.count("fit.documents")).toBe(16);
});
