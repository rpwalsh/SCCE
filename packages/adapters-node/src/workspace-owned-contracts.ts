// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
import {canonicalStringify,resolveWorkspaceSourceOwnership,workspaceContractOwnerFromBinding,codeLanguageForPath,joinInformationLabels,WORKSPACE_CONTRACT_PROJECTION_SCHEMA,workspaceContractComponentRecipe,type EvidenceSpan,type SourceVersion,type ScceStorage,type WorkspaceRecord,type WorkspaceSourceFileRecord,type WorkspaceContractOwner,type WorkspaceContractReceipt,type WorkspaceContractProjection,type JsonValue} from "@scce/kernel";
import {compileSourceOwnedContracts,type OwnedContractSnapshotFile} from "./source-owned-contract-compiler.js";
export interface WorkspaceContractBinding {readonly sourceVersionId:string;readonly evidenceIds:readonly string[];readonly sourceVersion?:SourceVersion;readonly evidence?:readonly EvidenceSpan[];readonly sourceBytes?:Uint8Array;readonly lineage?:WorkspaceContractOwner["lineage"]}
export interface WorkspaceContractCompilation {readonly status:"current"|"compiled"|"unavailable";readonly contracts:number;readonly sourceVersions:number;readonly reasonIds:readonly string[]}
export async function publishWorkspaceOwnedContracts(input:{storage:ScceStorage;workspace:WorkspaceRecord;root:string;records:readonly WorkspaceSourceFileRecord[];
 bindings:ReadonlyMap<string,WorkspaceContractBinding>;complete:boolean;maxFileBytes:number}):Promise<WorkspaceContractCompilation>{
 const unavailable=(reason:string):WorkspaceContractCompilation=>({status:"unavailable",contracts:0,sourceVersions:0,reasonIds:[reason]});
 if(!input.storage.blobs?.get||!input.storage.blobs.put||!input.storage.workspace?.putWorkspace)return unavailable("workspace.contracts.canonical_store_unavailable");
 const resolved=await resolveWorkspaceSourceOwnership({storage:input.storage,records:input.records,verifyBytes:false});
 const candidates=input.records.filter(row=>codeLanguageForPath(row.path)!==undefined||/\.(?:json|md|txt)$/u.test(row.path)).flatMap(record=>{
  const declared=input.bindings.get(record.path),binding=resolved.get(record.path),version=binding?.sourceVersion;
  if(!declared||!binding||declared.sourceVersionId!==binding.sourceVersionId||!version)return [];
  const owner=workspaceContractOwnerFromBinding(record,binding);

  return [{record,version,owner}];
 }).sort((a,b)=>a.owner.path.localeCompare(b.owner.path));
 if(!candidates.length)return unavailable("workspace.contracts.original_source_binding_unavailable");
 const owners=candidates.map(row=>row.owner),componentRecipe=workspaceContractComponentRecipe({complete:input.complete,records:input.records,owners});
 const metadata=record(input.workspace.metadata),previous=record(metadata.sourceContracts);
 let informationLabel:WorkspaceContractProjection["informationLabel"];
 try{informationLabel=joinInformationLabels(owners.map(owner=>owner.informationLabel));}catch{return unavailable("workspace.contracts.owner_merge_unavailable");}
 if(previous.schema===WORKSPACE_CONTRACT_PROJECTION_SCHEMA&&previous.componentRecipe===componentRecipe&&previous.workspaceId===input.workspace.id
  && canonicalStringify(previous.informationLabel)===canonicalStringify(informationLabel))return {status:"current",contracts:Number(previous.contractCount),sourceVersions:owners.length,reasonIds:[]};
 const verified=await resolveWorkspaceSourceOwnership({storage:input.storage,records:input.records});
 const files:OwnedContractSnapshotFile[]=[];
 for(const candidate of candidates){
  const binding=verified.get(candidate.record.path);
  if(!binding||binding.verificationLevel!=="bytes"||!binding.sourceBytes||canonicalStringify(workspaceContractOwnerFromBinding(candidate.record,binding))!==canonicalStringify(candidate.owner))return unavailable("workspace.contracts.canonical_bytes_mismatch");
  const raw=binding.sourceBytes;
  files.push({path:candidate.owner.path,bytes:raw,sourceHash:candidate.owner.contentHash,sourceVersionId:candidate.owner.sourceVersionId});
 }
 let compiled:Awaited<ReturnType<typeof compileSourceOwnedContracts>>;
 try{compiled=await compileSourceOwnedContracts({root:input.root,files,sourceUriBase:`scce://workspace/${encodeURIComponent(input.workspace.id)}`,knownPaths:input.records.filter(row=>row.ingestionStatus!=="missing").map(row=>row.path),complete:input.complete,
  maxFileBytes:input.maxFileBytes,maxTotalBytes:files.reduce((sum,row)=>sum+row.bytes.byteLength,0)});}catch{return unavailable("workspace.contracts.bounded_compilation_unavailable");}
 const contracts=[...compiled.values()].flat(),projection:WorkspaceContractProjection={schema:WORKSPACE_CONTRACT_PROJECTION_SCHEMA,workspaceId:input.workspace.id,componentRecipe,complete:input.complete,owners,contracts,informationLabel};
 await input.storage.transaction(async()=>{
  const blobHash=await input.storage.blobs.put(Buffer.from(canonicalStringify(projection),"utf8"),"application/vnd.scce.workspace-source-contracts+json");
  const receipt:WorkspaceContractReceipt={schema:WORKSPACE_CONTRACT_PROJECTION_SCHEMA,workspaceId:input.workspace.id,componentRecipe,blobHash:String(blobHash),contractCount:contracts.length,ownerCount:owners.length,sourceRecordCount:input.records.length,complete:input.complete,informationLabel};
  await input.storage.workspace.putWorkspace({...input.workspace,metadata:{...metadata,sourceContracts:receipt as unknown as JsonValue}});
 });
 return {status:"compiled",contracts:contracts.length,sourceVersions:owners.length,reasonIds:[]};
}
function record(value:unknown):Record<string,JsonValue>{return value && typeof value==="object"&&!Array.isArray(value)?value as Record<string,JsonValue>:{};}
