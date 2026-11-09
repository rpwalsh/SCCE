// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
import {readFileSync} from "node:fs";
import {beforeAll,expect,it} from "vitest";
import {boundaryNegativeLogLikelihood,compileBoundaryStatistics,type BoundaryEstimatorInferenceModel,type BoundarySufficientStatistics} from "../boundary-estimator.js";
import {collectBoundaryTrainingObservations,measureSurfaceBoundaries} from "../surface-lattice.js";
import {fitPagedBoundaryEstimator,pagedBoundaryNegativeLogLikelihood,pagedBoundaryNegativeLogLikelihoods} from "../paged-boundary-estimator.js";
import {PagedPopulationWorkspace} from "../paged-segmentation-population.js";
import {segmentationLogSumExp} from "../segmentation-population.js";
import type {BoundaryStatisticsCursor,CorpusSegmentationDocumentCursor} from "../corpus-segmentation-cursor.js";
import {fixtureSegmentationScratch} from "./fixtures/corpus-segmentation-scratch.js";
import {canonicalStringify,createHasher} from "../primitives.js";
const hasher=createHasher();
let statistics:BoundarySufficientStatistics[],models:BoundaryEstimatorInferenceModel[];
function cursor(value:BoundarySufficientStatistics,pageRows=7){
  const {rows,sourceDocumentIds,...header}=value,counters={reads:0,pages:0,closed:0};
  const source:BoundaryStatisticsCursor={header:{...header,rowCount:rows.length,sourceInventory:{id:hasher.digestHex(JSON.stringify(sourceDocumentIds)),count:sourceDocumentIds.length}},
    async *rows(){counters.reads++;try{for(let index=0;index<rows.length;index+=pageRows){counters.pages++;yield rows.slice(index,index+pageRows);}}finally{counters.closed++;}},
    async *sourceDocuments(){yield sourceDocumentIds;}};
  return {source,counters};
}
beforeAll(async()=>{
  const read=(file:string)=>JSON.parse(readFileSync(new URL(`./fixtures/${file}`,import.meta.url),"utf8")) as {text:string;turns:{surface:string}[]};
  const dolly=read("dolly-human-creative-pair.json"),russian=read("oasst-human-russian-creative-pair.json");
  const messages=[dolly.turns[0]!.surface,russian.turns[0]!.surface,russian.turns[1]!.surface];
  statistics=messages.map((text,index)=>compileBoundaryStatistics({populationId:`population.human.${index}`,hasher,
    observations:collectBoundaryTrainingObservations({lattices:[measureSurfaceBoundaries({documentId:`owner.human.${index}`,text,maxUnits:Number.MAX_SAFE_INTEGER})]})}));
  models=await Promise.all(statistics.map((value,index)=>fitPagedBoundaryEstimator({statistics:cursor(value).source,calibrationStatistics:cursor(statistics[(index+1)%statistics.length]!).source,hasher})));
  expect(new Set(models.map(model=>canonicalStringify({weights:model.weights,intercept:model.intercept,calibration:model.calibration})))).toHaveProperty("size",3);
});
it.each([1,7,97])("scores three genuinely fitted multilingual models in one complete %i-row canonical scan",async pageRows=>{
  const target=statistics[2]!,{source,counters}=cursor(target,pageRows);
  const expected=models.map(model=>boundaryNegativeLogLikelihood(model,target));
  expect(await pagedBoundaryNegativeLogLikelihoods(models,source)).toEqual(expected);
  expect(counters).toEqual({reads:1,pages:Math.ceil(target.rows.length/pageRows),closed:1});
  const scalar=cursor(target,pageRows),separate=[];for(const model of models)separate.push(await pagedBoundaryNegativeLogLikelihood(model,scalar.source));
  expect(separate).toEqual(expected);expect(scalar.counters.reads).toBe(3);expect(scalar.counters.pages).toBe(counters.pages*3);
});
it("the actual population mixture consumer opens its immutable statistics only once for all models",async()=>{
  const target=statistics[2]!,tracked=cursor(target),document={ordinal:0,documentId:"owner.human.2",sourceFamilyId:"owner.human.2",statistics:tracked.source.header};
  const source:CorpusSegmentationDocumentCursor={scratch:fixtureSegmentationScratch(2),sourceInventory:{id:"owned",count:1},documentCount:1,
    async *documents(){yield [document];},statistics:()=>tracked.source};
  const work=new PagedPopulationWorkspace(source,"population.root","fit");
  const priors=[0.2,0.3,0.5];
  const result=await work.mixtureLoss(document,models,priors);
  const expected=-segmentationLogSumExp(models.map((model,index)=>Math.log(Math.max(1e-12,priors[index]??0))-boundaryNegativeLogLikelihood(model,target).negativeLogLikelihood));
  expect(result).toBe(expected);expect(tracked.counters.reads).toBe(1);expect(tracked.counters.closed).toBe(1);
});
it("rejects incomplete or noncanonical batches without returning partial model scores",async()=>{
  const incomplete=cursor(statistics[2]!);incomplete.source.header.rowCount++;
  await expect(pagedBoundaryNegativeLogLikelihoods(models,incomplete.source)).rejects.toThrow("inventory changed");expect(incomplete.counters.closed).toBe(1);
  const reordered=cursor(statistics[2]!);reordered.source.rows=async function*(){yield [...statistics[2]!.rows].reverse();};
  await expect(pagedBoundaryNegativeLogLikelihoods(models,reordered.source)).rejects.toThrow("not canonical");
});
it("propagates owner cancellation and closes a partial source scan before any batch can succeed",async()=>{
  const primary=Error("owner cancelled source scan"),source=cursor(statistics[2]!).source;let closed=0;
  source.rows=async function*(){try{yield statistics[2]!.rows.slice(0,1);throw primary;}finally{closed++;}};
  await expect(pagedBoundaryNegativeLogLikelihoods(models,source)).rejects.toBe(primary);expect(closed).toBe(1);
});
