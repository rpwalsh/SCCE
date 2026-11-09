// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
import { expect,it,vi } from "vitest";
import type { ScceStorage } from "@scce/kernel";
import { rawCorpusSegmentationFixture } from "../../../kernel/src/__tests__/fixtures/raw-corpus-segmentation.js";
import { parseCorpusSegmentationPlan,runCorpusSegmentationCommand } from "../corpus-segmentation-command.js";
const plan=()=>({schema:"scce.corpus_segmentation_plan.v1",runId:"owned-study",scope:{informationLabel:{tenantId:"owner",principals:["owner"],compartments:[],exportClass:"internal",mergePolicy:"same_owner"},sourceSystems:["wikipedia"],sourceVersionIds:["opaque-owned-version"]},bounds:{pageRows:3,maxPageBytes:12000},windowUtf16:128,maxPopulations:2});
it("retains explicit owner/source scope and bounds and refuses injected model or malformed plans",()=>{
  const input=plan(),parsed=parseCorpusSegmentationPlan(input,123,true);
  expect(parsed).toMatchObject({runId:input.runId,createdAt:123,resume:true,scope:{sourceSystems:["wikipedia"],sourceVersionIds:["opaque-owned-version"]},bounds:input.bounds,windowUtf16:128,maxPopulations:2});
  input.scope.sourceVersionIds.push("foreign");expect(parsed.scope.sourceVersionIds).toEqual(["opaque-owned-version"]);
  expect(()=>parseCorpusSegmentationPlan({...plan(),model:{weights:[1]}},1)).toThrow(/Unsupported/);
  expect(()=>parseCorpusSegmentationPlan({...plan(),bounds:{pageRows:0,maxPageBytes:12000}},1)).toThrow(/bounds/);
  expect(()=>parseCorpusSegmentationPlan({...plan(),windowUtf16:1},1)).toThrow(/bounds/);
});
it("delegates to the canonical storage workflow and returns its actual source-trained compact receipt",async()=>{
  const {model}=await rawCorpusSegmentationFixture(),consolidate=vi.fn(async()=>({runId:"owned-study",alreadyComplete:false,minimumPoolConnections:2,model}));
  const storage={corpusSegmentation:{consolidate}} as unknown as ScceStorage;
  const result=await runCorpusSegmentationCommand(storage,plan(),{createdAt:123,resume:true});
  expect(consolidate).toHaveBeenCalledWith(expect.objectContaining({runId:"owned-study",createdAt:123,resume:true,bounds:{pageRows:3,maxPageBytes:12000}}));
  expect(result).toMatchObject({schema:"scce.corpus_segmentation_receipt.v1",minimumPoolConnections:2,modelId:model.id,sourceInventory:model.sourceInventory,featureContextId:model.featureContextId,selection:model.selection});
  expect(result).not.toHaveProperty("model");
});
it("propagates canonical ownership/resource failures and never fabricates a success receipt",async()=>{
  await expect(runCorpusSegmentationCommand({} as ScceStorage,plan(),{createdAt:1})).rejects.toThrow(/unavailable/);
  const failure=new Error("owned source changed"),storage={corpusSegmentation:{consolidate:async()=>{throw failure;}}} as unknown as ScceStorage;
  await expect(runCorpusSegmentationCommand(storage,plan(),{createdAt:1})).rejects.toBe(failure);
});
