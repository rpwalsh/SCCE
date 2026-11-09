// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
import type { InformationLabel } from "./types.js";
import type { SegmentationPopulationInferenceModel } from "./segmentation-population.js";
import type { CorpusSegmentationBatchLoader } from "./corpus-segmentation-cursor.js";
export interface CorpusSegmentationScope {
  informationLabel:InformationLabel;
  sourceVersionIds?:readonly string[];
  sourceSystems?:readonly string[];
  activeImportVersion?:string;
  ownerFamilyBindings?:readonly {sourceId:string;familyId:string}[];
}
export interface SegmentationPageBounds {pageRows:number;maxPageBytes:number}
export interface CorpusSegmentationConsolidationOptions {
  scope:CorpusSegmentationScope;runId:string;createdAt:number;bounds:SegmentationPageBounds;windowUtf16:number;resume?:boolean;signal?:AbortSignal;
  maxPopulations?:number;mergeDescriptionMarginNats?:number;heldoutRegressionToleranceNats?:number;
  onProgress?:(progress:{phase:"collecting-context"|"compiling-statistics";completedOwners:number;documentCount:number;windowCount:number;coveredUtf16:number})=>void|Promise<void>;
}
export interface CorpusSegmentationStore {
  consolidate(input:CorpusSegmentationConsolidationOptions):Promise<{runId:string;alreadyComplete:boolean;minimumPoolConnections:2;model:SegmentationPopulationInferenceModel}>;
  readActive(scope:CorpusSegmentationScope,required:{recipeId:string;normalizationContractId:string},bounds:SegmentationPageBounds):Promise<{
    inference:SegmentationPopulationInferenceModel;loader:CorpusSegmentationBatchLoader;
  }|null>;
}
