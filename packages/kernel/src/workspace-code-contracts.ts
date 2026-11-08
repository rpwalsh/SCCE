// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
import {canonicalStringify,createHasher} from "./primitives.js";
import {informationLabelAllowsRead,joinInformationLabels} from "./information-flow.js";
import {codeLanguageForPath} from "./code-request.js";
import type {ScceStorage} from "./storage.js";
import type {InformationAccessContext,EvidenceSpan,InformationLabel,JsonValue} from "./types.js";
export const SOURCE_OWNED_CONTRACT_COMPILER_RECIPE="scce.source_owned_contract_snapshot_compiler.v1";
export const WORKSPACE_CONTRACT_PROJECTION_SCHEMA="scce.workspace.source_contract_projection.v1";
export interface WorkspaceContractOwner {readonly path:string;readonly sourceId:string;readonly sourceVersionId:string;readonly contentHash:string;readonly namespace:string;readonly byteLength:number;readonly evidenceIds:readonly string[];readonly informationLabel:InformationLabel}
export interface WorkspaceContractReceipt {readonly schema:typeof WORKSPACE_CONTRACT_PROJECTION_SCHEMA;readonly workspaceId:string;readonly componentRecipe:string;readonly blobHash:string;readonly contractCount:number;readonly ownerCount:number;readonly sourceRecordCount:number;readonly complete:boolean;readonly informationLabel:InformationLabel}
export interface WorkspaceContractProjection {readonly schema:typeof WORKSPACE_CONTRACT_PROJECTION_SCHEMA;readonly workspaceId:string;readonly componentRecipe:string;readonly complete:boolean;readonly owners:readonly WorkspaceContractOwner[];readonly contracts:readonly JsonValue[];readonly informationLabel:InformationLabel}
export function workspaceContractComponentRecipe(input:{readonly complete:boolean;readonly records:readonly {readonly path:string;readonly contentHash?:string;readonly sourceVersionId?:string;readonly ingestionStatus:string}[];readonly owners:readonly WorkspaceContractOwner[]}):string {
 const files=input.records.map(row=>[row.path,row.contentHash,row.sourceVersionId,row.ingestionStatus==="missing"]).sort((a,b)=>String(a[0]).localeCompare(String(b[0])));
 return `${SOURCE_OWNED_CONTRACT_COMPILER_RECIPE}:${createHasher().digestHex(canonicalStringify({complete:input.complete,files,owners:input.owners}))}`;
}
export function workspaceContractOwnerIsCurrent(value:WorkspaceContractOwner,current:WorkspaceContractOwner):boolean {
 return canonicalStringify(value)===canonicalStringify(current);
}

export interface WorkspaceProgramContext {readonly schema:"scce.workspace.program-context.v1";readonly workspaceId:string;readonly expectedWorkspaceUpdatedAt:number}
export type WorkspaceContractReadResult={readonly status:"available";readonly contracts:readonly {readonly patternJson:JsonValue}[];readonly evidence:readonly EvidenceSpan[];readonly sourceVersionIds:readonly string[]}
 |{readonly status:"unavailable";readonly reasonId:string};
export async function readWorkspaceOwnedProgramContracts(input:{storage:ScceStorage;context:unknown;informationAccess:InformationAccessContext|undefined;sourceVersionAllowlist?:readonly string[]}):Promise<WorkspaceContractReadResult>{
 const unavailable=(reasonId:string):WorkspaceContractReadResult=>({status:"unavailable",reasonId});
 const context=object(input.context);
 if(context.schema!=="scce.workspace.program-context.v1"||typeof context.workspaceId!=="string"||(typeof context.expectedWorkspaceUpdatedAt!=="number"||!Number.isFinite(context.expectedWorkspaceUpdatedAt))||!input.informationAccess)return unavailable("workspace.contracts.context_unavailable");
 const workspace=await input.storage.workspace.getWorkspace(context.workspaceId);
 if(!workspace||workspace.updatedAt!==context.expectedWorkspaceUpdatedAt)return unavailable("workspace.contracts.stale_workspace");
 const receipt=object(object(workspace.metadata).sourceContracts);
 if(receipt.schema!==WORKSPACE_CONTRACT_PROJECTION_SCHEMA||receipt.workspaceId!==workspace.id||typeof receipt.componentRecipe!=="string"||!receipt.componentRecipe.startsWith(`${SOURCE_OWNED_CONTRACT_COMPILER_RECIPE}:`)
  ||typeof receipt.blobHash!=="string"||!Number.isSafeInteger(receipt.sourceRecordCount)||Number(receipt.sourceRecordCount)<1||receipt.complete!==true)return unavailable("workspace.contracts.projection_unavailable");
 if(!readableLabel(receipt.informationLabel,input.informationAccess))return unavailable("workspace.contracts.owner_scope_unavailable");
 const records=await input.storage.workspace.listSourceFiles({workspaceId:workspace.id,limit:Number(receipt.sourceRecordCount)+1});
 if(records.length!==receipt.sourceRecordCount)return unavailable("workspace.contracts.source_inventory_changed");
 const ids=[...new Set(records.flatMap(record=>record.evidenceIds.map(String)))];
 if(!ids.length)return unavailable("workspace.contracts.original_source_binding_unavailable");
 const [evidence,versions]=await Promise.all([input.storage.evidence.getEvidenceBatch(ids as never[]),input.storage.evidence.sourceVersionsForEvidence(ids as never[])]);
 const owners:WorkspaceContractOwner[]=[],admitted:EvidenceSpan[]=[];
 for(const record of records.filter(row=>codeLanguageForPath(row.path)!==undefined||row.path.endsWith(".json"))){
  if(record.ingestionStatus!=="ingested"&&record.ingestionStatus!=="skipped")continue;
  const matches=versions.filter(version=>String(version.contentHash)===record.contentHash&&version.role!=="evidence-derivative"&&(!record.sourceVersionId||record.sourceVersionId===version.sourceVersionId)
   &&object(object(version.metadata).workspace).id===workspace.id&&object(object(version.metadata).workspaceFile).path===record.path);
  const unique=[...new Map(matches.map(version=>[String(version.sourceVersionId),version])).values()];
  if(unique.length!==1)continue;
  const version=unique[0]!;
  if(!version.informationLabel||!readableLabel(version.informationLabel,input.informationAccess)
   ||input.sourceVersionAllowlist!==undefined&&!input.sourceVersionAllowlist.includes(String(version.sourceVersionId)))continue;
  const spans=evidence.filter(span=>span.sourceVersionId===version.sourceVersionId&&span.status==="promoted"&&(!span.informationLabel||readableLabel(span.informationLabel,input.informationAccess!))&&record.evidenceIds.map(String).includes(String(span.id)));
  if(!spans.length)continue;
  owners.push({path:record.path,sourceId:String(version.sourceId),sourceVersionId:String(version.sourceVersionId),contentHash:String(version.contentHash),namespace:version.namespace,
   byteLength:version.byteLength,evidenceIds:spans.map(span=>String(span.id)).sort(),informationLabel:version.informationLabel});
  admitted.push(...spans);
 }
 owners.sort((a,b)=>a.path.localeCompare(b.path));
 if(!owners.length||workspaceContractComponentRecipe({complete:true,records,owners})!==receipt.componentRecipe)return unavailable("workspace.contracts.current_owner_scope_changed");
 try{if(canonicalStringify(joinInformationLabels(owners.map(owner=>owner.informationLabel)))!==canonicalStringify(receipt.informationLabel))return unavailable("workspace.contracts.owner_scope_changed");}
 catch{return unavailable("workspace.contracts.owner_merge_unavailable");}
 let bytes:Uint8Array,value:Record<string,JsonValue>;
 try{bytes=await input.storage.blobs.get(receipt.blobHash as never);if(`sha256_${createHasher().digestHex(bytes)}`!==receipt.blobHash)return unavailable("workspace.contracts.projection_hash_mismatch");value=object(JSON.parse(new TextDecoder().decode(bytes)));}
 catch{return unavailable("workspace.contracts.projection_bytes_unavailable");}
 if(value.schema!==WORKSPACE_CONTRACT_PROJECTION_SCHEMA||value.workspaceId!==workspace.id||value.componentRecipe!==receipt.componentRecipe||value.complete!==true
  ||canonicalStringify(value.owners)!==canonicalStringify(owners)||canonicalStringify(value.informationLabel)!==canonicalStringify(receipt.informationLabel)||!Array.isArray(value.contracts)||value.contracts.length!==receipt.contractCount)
  return unavailable("workspace.contracts.projection_owner_mismatch");
 const current=new Map(owners.map(owner=>[owner.sourceVersionId,owner]));
 for(const raw of value.contracts){
  const contract=object(raw),owner=current.get(String(contract.sourceVersionId));
  if(contract.schema!=="scce.source_owned_test_contract.v1"||!owner||contract.sourceHash!==owner.contentHash||contract.sourcePath!==owner.path||!Array.isArray(contract.cases))return unavailable("workspace.contracts.contract_owner_mismatch");
  for(const rawCase of contract.cases){const row=object(rawCase),test=current.get(String(row.testSourceVersionId));
   if(!test||test.path!==row.testPath||test.contentHash!==row.testHash)return unavailable("workspace.contracts.assertion_owner_mismatch");
   if(Array.isArray(row.invocations))for(const rawInvocation of row.invocations){const invocation=object(rawInvocation),source=current.get(String(invocation.sourceVersionId));
    if(!source||source.path!==invocation.sourcePath||source.contentHash!==invocation.sourceHash)return unavailable("workspace.contracts.invocation_owner_mismatch");
   }
  }
 }
 return {status:"available",contracts:value.contracts.map(patternJson=>({patternJson})),evidence:admitted,sourceVersionIds:owners.map(owner=>owner.sourceVersionId)};
}
function object(value:unknown):Record<string,JsonValue>{return value&&typeof value==="object"&&!Array.isArray(value)?value as Record<string,JsonValue>:{};}

function readableLabel(value:unknown,access:InformationAccessContext):boolean{try{return informationLabelAllowsRead(value as InformationLabel,access);}catch{return false;}}
