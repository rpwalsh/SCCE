// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
import { expect,it } from "vitest";
import { BOUNDARY_FEATURE_ORDER,compileBoundaryStatistics,type BoundaryFeatureVector } from "../boundary-estimator.js";
import type { BoundaryStatisticsCursor,CorpusSegmentationDocumentCursor } from "../corpus-segmentation-cursor.js";
import { learnPagedSegmentationPopulations,PagedPopulationWorkspace,type PagedPopulationCandidateExecution } from "../paged-segmentation-population.js";
import { fixtureSegmentationScratch } from "./fixtures/corpus-segmentation-scratch.js";
import { canonicalStringify,createHasher,toJsonValue } from "../primitives.js";
const hasher=createHasher();
function source():CorpusSegmentationDocumentCursor{
  const cursors=Array.from({length:16},(_,index):BoundaryStatisticsCursor=>{
    const statistics=compileBoundaryStatistics({populationId:"source",sourceDocumentIds:[`owner.${index}.\u732b`],hasher,
      observations:[0,1].map(vector=>({sourceDocumentId:`owner.${index}.\u732b`,signalId:`signal.${vector}`,
        features:Object.fromEntries(BOUNDARY_FEATURE_ORDER.map((key,ordinal)=>[key,((ordinal+vector)%3)/3])) as unknown as BoundaryFeatureVector,
        positiveMass:vector?1:10+index,negativeMass:vector?10+index:1,supervision:"independent_anchor" as const,signalKind:"external_anchor" as const}))});
    const {rows,sourceDocumentIds,...header}=statistics;return {header:{...header,rowCount:rows.length,sourceInventory:{id:hasher.digestHex(JSON.stringify(sourceDocumentIds)),count:1}},
      async *rows(){yield rows;},async *sourceDocuments(){yield sourceDocumentIds;}};
  });
  const documents=cursors.map((cursor,ordinal)=>({ordinal,documentId:`owner.${ordinal}.\u732b`,sourceFamilyId:`family.${ordinal}`,statistics:cursor.header}));
  return {scratch:fixtureSegmentationScratch(2),documentCount:documents.length,sourceInventory:{id:hasher.digestHex(JSON.stringify(documents)),count:documents.length},
    async *documents(){yield documents;},statistics:document=>cursors[document.ordinal]!};
}
async function complete(input:CorpusSegmentationDocumentCursor,candidateExecution?:PagedPopulationCandidateExecution){
  const result=await learnPagedSegmentationPopulations({rootPopulationId:"source",namespace:"fit",featureContextId:"context",source:input,maxPopulations:3,candidateExecution});
  const read=async(collection:string)=>{const rows=[];for await(const page of input.scratch.pages({collection,pageRows:2,maxPageBytes:input.scratch.maxPageBytes}))rows.push(...page);return rows;};
  const statistics=[];for(const cursor of result.artifacts.populationStatistics){const rows=[],owners=[];for await(const page of cursor.rows())rows.push(...page);for await(const page of cursor.sourceDocuments())owners.push(...page);statistics.push({header:cursor.header,rows,owners});}
  const partitions=[];for(const [partition,collection] of Object.entries(result.artifacts.partitions))partitions.push({partition,rows:await read(collection)});
  return canonicalStringify(toJsonValue({model:result.model,assignments:await read(result.artifacts.assignments),statistics,partitions}));
}
it("retains every model, assignment, partition and statistics byte with independently scheduled candidates",async()=>{
  const baseline=await complete(source()),input=source(),completed:number[]=[];let active=0,peak=0;
  const actual=await complete(input,{async fitCandidates(prepared,jobs){return Promise.all(jobs.map(async job=>{
    const work=new PagedPopulationWorkspace(input,prepared.rootPopulationId,prepared.namespace);await work.verifyPrepared(prepared);
    active++;peak=Math.max(peak,active);const candidate=await work.fitCandidate(job.fit,job.holdout,job.populationCount,job.label);active--;completed.push(job.populationCount);return candidate;
  }));}});
  expect(actual).toBe(baseline);expect(peak).toBeGreaterThan(1);expect([...completed].sort()).toEqual([1,2,3]);
});
it("refuses changed prepared partitions and never runs selection after an execution failure",async()=>{
  const input=source(),failure=Error("worker stopped");
  await expect(complete(input,{async fitCandidates(prepared){
    const collection=prepared.collections.find(row=>row.name.endsWith("partition.fit"))!.name;
    await input.scratch.putMany(collection,[{orderKey:"9999999999999999",value:{foreign:true}}]);
    const work=new PagedPopulationWorkspace(input,prepared.rootPopulationId,prepared.namespace);await expect(work.verifyPrepared(prepared)).rejects.toThrow("changed");throw failure;
  }})).rejects.toBe(failure);
  expect(await input.scratch.count("fit.mergeGuardDocuments")).toBe(0);expect(await input.scratch.count("fit.finalAssignments")).toBe(0);
});
