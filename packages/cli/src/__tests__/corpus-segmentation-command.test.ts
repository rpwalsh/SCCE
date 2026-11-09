// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
import { expect,it,vi } from "vitest";
import type { ScceStorage } from "@scce/kernel";
import { corpusSegmentationInputRecipe } from "../../../adapters-node/src/corpus-segmentation-producer.js";
import { prepareLanguageTrainingSegmentationInput,languageTrainingSegmentationLoader } from "../../../adapters-node/src/language-training-segmentation.js";
import { rawCorpusSegmentationFixture } from "../../../kernel/src/__tests__/fixtures/raw-corpus-segmentation.js";
import { parseCorpusSegmentationPlan,runCorpusSegmentationCommand } from "../corpus-segmentation-command.js";
vi.mock("@scce/adapters-node",async()=>({corpusSegmentationInputRecipe:(await import("../../../adapters-node/src/corpus-segmentation-producer.js")).corpusSegmentationInputRecipe,
  validatePopulationWorkerExecution:(await import("../../../adapters-node/src/population-candidate-execution.js")).validatePopulationWorkerExecution}));
const plan=()=>({schema:"scce.corpus_segmentation_plan.v1",runId:"owned-study",scope:{informationLabel:{tenantId:"owner",principals:["owner"],compartments:[],exportClass:"internal",mergePolicy:"same_owner"},sourceSystems:["wikipedia"],sourceVersionIds:["opaque-owned-version"]},bounds:{pageRows:3,maxPageBytes:12000},windowUtf16:128,maxPopulations:2});
it("accepts only an explicit bounded worker declaration and forwards it without changing learned policy",()=>{
  const execution={backend:"node_workers.v1",workers:2,workerHeapMb:384,maxNodeRssBytes:7*1024**3,totalPgConnections:12,abortGraceMs:30000};
  const parsed=parseCorpusSegmentationPlan({...plan(),execution},1);expect(parsed.execution).toEqual(execution);
  expect(parsed.maxPopulations).toBe(2);expect(parseCorpusSegmentationPlan(plan(),1).execution).toBeUndefined();
  expect(()=>parseCorpusSegmentationPlan({...plan(),execution:{...execution,workers:0}},1)).toThrow("declaration");
  expect(()=>parseCorpusSegmentationPlan({...plan(),execution:{...execution,ignoreWorkerErrors:true}},1)).toThrow("declaration");
});
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
  expect(result.trainingDeclaration).toEqual({scope:parseCorpusSegmentationPlan(plan(),123).scope,recipeId:corpusSegmentationInputRecipe(128),
    normalizationContractId:model.normalizationContractId,bounds:plan().bounds});
});
it("round-trips the exact receipt declaration into snapshot-bound training without reusing mutable plan objects",async()=>{
  const {model,loader}=await rawCorpusSegmentationFixture(),input=plan(),expected=parseCorpusSegmentationPlan(input,123);
  const consolidate=vi.fn(async()=>{input.scope.sourceVersionIds.push("not-the-consolidated-owner");input.bounds.pageRows=99;
    return {runId:"owned-study",alreadyComplete:false,minimumPoolConnections:2,model};});
  const receipt=await runCorpusSegmentationCommand({corpusSegmentation:{consolidate}} as unknown as ScceStorage,input,{createdAt:123});
  const declaration=JSON.parse(JSON.stringify(receipt.trainingDeclaration)) as typeof receipt.trainingDeclaration;
  expect(declaration.scope).toEqual(expected.scope);expect(declaration.bounds).toEqual(expected.bounds);
  const readActive=vi.fn(async()=>({inference:model,loader}));
  const storage={corpusSegmentation:{readActive}} as unknown as ScceStorage;
  const selected=await prepareLanguageTrainingSegmentationInput(storage,declaration);
  expect(readActive).toHaveBeenCalledWith(expected.scope,{recipeId:corpusSegmentationInputRecipe(expected.windowUtf16),normalizationContractId:model.normalizationContractId},expected.bounds,{lockForCommit:false});
  expect(selected.identity.population).toEqual(loader.identity);
  declaration.normalizationContractId="different-normalization";
  await expect(languageTrainingSegmentationLoader(storage,declaration,selected)).rejects.toThrow("preparation changed");
});
it("propagates canonical ownership/resource failures and never fabricates a success receipt",async()=>{
  await expect(runCorpusSegmentationCommand({} as ScceStorage,plan(),{createdAt:1})).rejects.toThrow(/unavailable/);
  const failure=new Error("owned source changed"),storage={corpusSegmentation:{consolidate:async()=>{throw failure;}}} as unknown as ScceStorage;
  await expect(runCorpusSegmentationCommand(storage,plan(),{createdAt:1})).rejects.toBe(failure);
});
