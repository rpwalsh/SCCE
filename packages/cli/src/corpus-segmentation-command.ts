// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
import { normalizeInformationLabel,type CorpusSegmentationConsolidationOptions,type CorpusSegmentationScope,type ScceStorage } from "@scce/kernel";
import { corpusSegmentationInputRecipe } from "@scce/adapters-node";
function record(value:unknown):Record<string,unknown>{if(!value||typeof value!=="object"||Array.isArray(value))throw new Error("Corpus segmentation plan requires an object");return value as Record<string,unknown>;}
function text(value:unknown):string{if(typeof value!=="string"||!value.trim())throw new Error("Corpus segmentation plan requires nonempty identities");return value;}
function integer(value:unknown,minimum=1):number{if(typeof value!=="number"||!Number.isSafeInteger(value)||value<minimum)throw new Error("Corpus segmentation plan requires positive integer bounds");return value;}
function ids(value:unknown):string[]|undefined{if(value===undefined)return undefined;if(!Array.isArray(value)||!value.length)throw new Error("Corpus segmentation scope requires nonempty ID arrays");return value.map(text);}
export function parseCorpusSegmentationPlan(value:unknown,createdAt:number,resume=false):CorpusSegmentationConsolidationOptions{
  const plan=record(value),allowed=new Set(["schema","runId","scope","bounds","windowUtf16","maxPopulations","mergeDescriptionMarginNats","heldoutRegressionToleranceNats"]);
  if(plan.schema!=="scce.corpus_segmentation_plan.v1"||Object.keys(plan).some(key=>!allowed.has(key)))throw new Error("Unsupported corpus segmentation plan schema or fields");
  const supplied=record(plan.scope),scopeAllowed=new Set(["informationLabel","sourceVersionIds","sourceSystems","activeImportVersion","ownerFamilyBindings"]);
  if(Object.keys(supplied).some(key=>!scopeAllowed.has(key)))throw new Error("Unsupported corpus segmentation scope fields");
  const scope:CorpusSegmentationScope={informationLabel:normalizeInformationLabel(supplied.informationLabel as never)};
  const versions=ids(supplied.sourceVersionIds),systems=ids(supplied.sourceSystems);
  if(versions)scope.sourceVersionIds=versions;if(systems)scope.sourceSystems=systems;
  if(supplied.activeImportVersion!==undefined)scope.activeImportVersion=text(supplied.activeImportVersion);
  if(supplied.ownerFamilyBindings!==undefined){if(!Array.isArray(supplied.ownerFamilyBindings))throw new Error("Invalid owner family bindings");
    scope.ownerFamilyBindings=supplied.ownerFamilyBindings.map(value=>{const binding=record(value);if(Object.keys(binding).some(key=>key!=="sourceId"&&key!=="familyId"))throw new Error("Unsupported owner family binding fields");return {sourceId:text(binding.sourceId),familyId:text(binding.familyId)};});}
  const bounds=record(plan.bounds);if(Object.keys(bounds).some(key=>key!=="pageRows"&&key!=="maxPageBytes"))throw new Error("Unsupported corpus segmentation bounds");
  const options:CorpusSegmentationConsolidationOptions={scope,runId:text(plan.runId),createdAt,resume,bounds:{pageRows:integer(bounds.pageRows),maxPageBytes:integer(bounds.maxPageBytes)},windowUtf16:integer(plan.windowUtf16,2)};
  for(const key of ["maxPopulations","mergeDescriptionMarginNats","heldoutRegressionToleranceNats"] as const){const value=plan[key];if(value!==undefined){if(typeof value!=="number"||!Number.isFinite(value))throw new Error("Invalid corpus segmentation fit setting");options[key]=value;}}
  return options;
}
export async function runCorpusSegmentationCommand(storage:ScceStorage,plan:unknown,input:{createdAt:number;resume?:boolean;onProgress?:CorpusSegmentationConsolidationOptions["onProgress"]}){
  if(!storage.corpusSegmentation)throw new Error("Corpus segmentation storage capability is unavailable");
  const parsed=parseCorpusSegmentationPlan(plan,input.createdAt,input.resume);
  const result=await storage.corpusSegmentation.consolidate({...parsed,onProgress:input.onProgress});
  return {schema:"scce.corpus_segmentation_receipt.v1",runId:result.runId,alreadyComplete:result.alreadyComplete,minimumPoolConnections:result.minimumPoolConnections,
    modelId:result.model.id,sourceInventory:result.model.sourceInventory,featureContextId:result.model.featureContextId,normalizationContractId:result.model.normalizationContractId,
    selectedPopulationCount:result.model.populations.length,selection:result.model.selection,
    trainingDeclaration:{scope:structuredClone(parsed.scope),recipeId:corpusSegmentationInputRecipe(parsed.windowUtf16),
      normalizationContractId:result.model.normalizationContractId,bounds:{...parsed.bounds}}};
}
