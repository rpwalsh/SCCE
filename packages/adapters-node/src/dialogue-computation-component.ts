// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
import {acquireSourceComputationConstructions,createHasher,canonicalStringify,SOURCE_COMPUTATION_CONSTRUCTION_SCHEMA as SCHEMA,SOURCE_COMPUTATION_CONSTRUCTION_RECIPE as RECIPE,SOURCE_COMPUTATION_SOURCE_SYSTEM as SYSTEM,type ConversationalConstructionDocument,type InformationLabel,type LanguagePatternProjection,type ScceStorage,type SourceVersionId,type TranscriptTurn} from "@scce/kernel";
import {corpusSourceVersionIdFor} from "./language-corpus-trainer.js";
import {runDialogueComputationComponent} from "./dialogue-conversational-checkpoint.js";
export interface DialogueComputationReport {schema:"scce.dialogue_computation_report.v1";pairs:number;patternsPersisted:number;rejected:readonly {bindingId:string;reason:string}[];unchanged:boolean}
export async function persistDialogueComputationComponent(input:{storage:ScceStorage;rootUri:string;informationLabel:InformationLabel;authorship:string;sources:readonly {sourceUri:string;text:string;transcriptTurns?:readonly TranscriptTurn[]}[]}):Promise<DialogueComputationReport>{
 const hasher=createHasher(),sources=input.sources.map(source=>({...source,sourceVersionId:String(corpusSourceVersionIdFor(source)),contentHash:hasher.digestHex(source.text),byteLength:Buffer.byteLength(source.text,"utf8")}));
 return runDialogueComputationComponent<DialogueComputationReport>({storage:input.storage,rootUri:input.rootUri,informationLabel:input.informationLabel,authorship:input.authorship,sources:sources.map(({sourceUri,sourceVersionId,contentHash,byteLength,transcriptTurns})=>({sourceUri,sourceVersionId,contentHash,byteLength,transcriptDigest:hasher.digestHex(canonicalStringify(transcriptTurns??[]))})),
  unchanged:()=>({schema:"scce.dialogue_computation_report.v1",pairs:0,patternsPersisted:0,rejected:[],unchanged:true}),
  compile:async()=>{
   if(!input.storage.languageMemory.replaceLanguagePatternProjection)throw Error("Source computation requires canonical active projection publication");
   const versions=sources.map(source=>source.sourceVersionId as SourceVersionId),profiles=versions.length?await input.storage.model.listLanguageProfiles({sourceVersionIds:versions,limit:versions.length+1}):[];
   const profilesByVersion=new Map<string,typeof profiles>();
   for(const profile of profiles){const key=String(profile.sourceVersionId),group=profilesByVersion.get(key)??[];group.push(profile);profilesByVersion.set(key,group);}
   const documents:ConversationalConstructionDocument[]=[];
   for(const source of sources){
    const owners=profilesByVersion.get(source.sourceVersionId)??[];if(owners.length!==1)throw Error("Source computation requires one exact profile per source version");
    const found=await input.storage.evidence.searchEvidence({sourceVersionId:source.sourceVersionId as SourceVersionId,status:"promoted",limit:4096});
    const spans=found.map(row=>row.span);if(!spans.length)throw Error("Source computation requires promoted owner evidence");
    documents.push({sourceVersionId:source.sourceVersionId,profileId:owners[0]!.id,spans,transcriptTurns:source.transcriptTurns});
   }
   const acquired=acquireSourceComputationConstructions({documents,hasher,updatedAt:Date.now()}),projections:LanguagePatternProjection[]=[];
   const familiesByOwner=new Map<string,typeof acquired.families>();
   for(const family of acquired.families){const key=family.pattern.profileId,group=familiesByOwner.get(key)??[];group.push(family);familiesByOwner.set(key,group);}
   const pooledVersions=new Set(versions.map(String));let persisted=0;
   for(const document of documents){
    const owner=document.spans[0]!,key={profileId:document.profileId,sourceId:owner.sourceId,sourceVersionId:owner.sourceVersionId,sourceSystem:SYSTEM,patternSchema:SCHEMA,componentRecipe:RECIPE,informationLabel:input.informationLabel};
    const previous=await input.storage.languageMemory.getLanguagePatternProjection?.(key);
    if(previous?.sourceDependencies?.some(dependency=>!pooledVersions.has(String(dependency.sourceVersionId)))){projections.push(previous);continue;}
    const families=familiesByOwner.get(document.profileId)??[],patterns=families.map(family=>({...family.pattern,informationLabel:input.informationLabel}));
    if(!patterns.length&&!previous)continue;
    const dependencyOwners=new Map<string,NonNullable<LanguagePatternProjection["sourceDependencies"]>[number]>();
    for(const dependency of families.flatMap(family=>family.sourceDependencies)){
      const previous=dependencyOwners.get(String(dependency.sourceVersionId));
      if(previous&&previous.sourceId!==dependency.sourceId)throw Error("Computation dependency has conflicting real source ownership");
      dependencyOwners.set(String(dependency.sourceVersionId),{...dependency,evidenceIds:[...new Set([...(previous?.evidenceIds??[]),...dependency.evidenceIds])].sort()});
    }
    const dependencies=[...dependencyOwners.values()].sort((a,b)=>String(a.sourceVersionId).localeCompare(String(b.sourceVersionId)));
    const projection:LanguagePatternProjection={...key,patternIds:patterns.map(pattern=>pattern.id).sort(),sourceDependencies:dependencies};
    await input.storage.languageMemory.replaceLanguagePatternProjection({patterns,projection});persisted+=patterns.length;projections.push(projection);
   }
   return {projections,report:{schema:"scce.dialogue_computation_report.v1" as const,pairs:acquired.pairs,patternsPersisted:persisted,rejected:acquired.rejected,unchanged:false}};
  }});
}
