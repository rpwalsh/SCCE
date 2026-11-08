// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
import {createHash} from "node:crypto";
import {canonicalStringify,codeLanguageForPath,joinInformationLabels,WORKSPACE_CONTRACT_PROJECTION_SCHEMA,workspaceContractComponentRecipe,type EvidenceSpan,type SourceVersion,type ScceStorage,type WorkspaceRecord,type WorkspaceSourceFileRecord,type WorkspaceContractOwner,type WorkspaceContractReceipt,type WorkspaceContractProjection,type JsonValue} from "@scce/kernel";
import {compileSourceOwnedContracts,type OwnedContractSnapshotFile} from "./source-owned-contract-compiler.js";
export interface WorkspaceContractBinding {readonly sourceVersionId:string;readonly evidenceIds:readonly string[];readonly sourceVersion?:SourceVersion;readonly evidence?:readonly EvidenceSpan[]}
export interface WorkspaceContractCompilation {readonly status:"current"|"compiled"|"unavailable";readonly contracts:number;readonly sourceVersions:number;readonly reasonIds:readonly string[]}
export async function publishWorkspaceOwnedContracts(input:{storage:ScceStorage;workspace:WorkspaceRecord;root:string;records:readonly WorkspaceSourceFileRecord[];
 bindings:ReadonlyMap<string,WorkspaceContractBinding>;complete:boolean;maxFileBytes:number}):Promise<WorkspaceContractCompilation>{
 const unavailable=(reason:string):WorkspaceContractCompilation=>({status:"unavailable",contracts:0,sourceVersions:0,reasonIds:[reason]});
 if(!input.storage.blobs?.get||!input.storage.blobs.put||!input.storage.workspace?.putWorkspace)return unavailable("workspace.contracts.canonical_store_unavailable");
 const candidates=input.records.filter(row=>codeLanguageForPath(row.path)!==undefined||row.path.endsWith(".json")).flatMap(record=>{
  const binding=input.bindings.get(record.path),version=binding?.sourceVersion;
  if(!binding||!version||version.role==="evidence-derivative"||String(version.contentHash)!==record.contentHash||!version.informationLabel
   || (record.ingestionStatus!=="ingested"&&record.ingestionStatus!=="skipped"))return [];
  const evidence=(binding.evidence??[]).filter(span=>span.status==="promoted"&&span.sourceVersionId===version.sourceVersionId);
  if(!evidence.length)return [];
  const owner:WorkspaceContractOwner={path:record.path,sourceId:String(version.sourceId),sourceVersionId:String(version.sourceVersionId),contentHash:String(version.contentHash),namespace:version.namespace,
   byteLength:version.byteLength,evidenceIds:evidence.map(span=>String(span.id)).sort(),informationLabel:version.informationLabel};
  return [{record,version,owner}];
 }).sort((a,b)=>a.owner.path.localeCompare(b.owner.path));
 if(!candidates.length)return unavailable("workspace.contracts.original_source_binding_unavailable");
 const owners=candidates.map(row=>row.owner),componentRecipe=workspaceContractComponentRecipe({complete:input.complete,records:input.records,owners});
 const metadata=record(input.workspace.metadata),previous=record(metadata.sourceContracts);
 let informationLabel:WorkspaceContractProjection["informationLabel"];
 try{informationLabel=joinInformationLabels(owners.map(owner=>owner.informationLabel));}catch{return unavailable("workspace.contracts.owner_merge_unavailable");}
 if(previous.schema===WORKSPACE_CONTRACT_PROJECTION_SCHEMA&&previous.componentRecipe===componentRecipe&&previous.workspaceId===input.workspace.id
  && canonicalStringify(previous.informationLabel)===canonicalStringify(informationLabel))return {status:"current",contracts:Number(previous.contractCount),sourceVersions:owners.length,reasonIds:[]};
 const files:OwnedContractSnapshotFile[]=[];
 for(const candidate of candidates){
  let raw:Uint8Array;
  try{raw=await input.storage.blobs.get(candidate.version.contentHash);}catch{return unavailable("workspace.contracts.canonical_bytes_unavailable");}
  if(raw.byteLength!==candidate.owner.byteLength||`sha256_${createHash("sha256").update(raw).digest("hex")}`!==candidate.owner.contentHash)return unavailable("workspace.contracts.canonical_bytes_mismatch");
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
