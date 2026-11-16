// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
import {canonicalStringify,createHasher} from "./primitives.js";
import {informationLabelAllowsRead,joinInformationLabels} from "./information-flow.js";
import {codeLanguageForPath} from "./code-request.js";
import type {ScceStorage,WorkspaceSourceFileRecord} from "./storage.js";
import type {InformationAccessContext,EvidenceSpan,InformationLabel,JsonValue,SourceVersion} from "./types.js";
export const SOURCE_OWNED_CONTRACT_COMPILER_RECIPE="scce.source_owned_contract_snapshot_compiler.v3";
export const PYTHON_SOURCE_TEST_COMPONENT_RECIPE="scce.python_source_test_contract_compiler.v2";
export const WORKSPACE_CONTRACT_PROJECTION_SCHEMA="scce.workspace.source_contract_projection.v1";
export interface WorkspaceContractOwner {readonly path:string;readonly sourceId:string;readonly sourceVersionId:string;readonly contentHash:string;readonly namespace:string;readonly byteLength:number;readonly evidenceIds:readonly string[];readonly informationLabel:InformationLabel;readonly lineage?:WorkspaceSourceLineage}
export interface WorkspaceSourceLineage {
 readonly schema:"scce.workspace.source_lineage.v1";
 readonly targetCoordinateSpace:"original-source-bytes";
 readonly evidenceCoordinateSpace:"per-source-version-bytes";
 readonly chains:readonly {readonly evidenceSourceVersionId:string;readonly hops:readonly {readonly sourceVersionId:string;readonly contentHash:string;readonly byteLength:number;readonly role:"original"|"evidence-derivative";readonly parentSourceVersionId?:string;readonly derivationHash?:string}[]}[];
}
export interface WorkspaceResolvedSourceOwnership {
 readonly sourceVersionId:string;readonly sourceVersion:SourceVersion;readonly evidence:readonly EvidenceSpan[];readonly evidenceIds:readonly string[];
 readonly verificationLevel:"metadata"|"bytes";readonly sourceBytes?:Uint8Array;readonly lineage?:WorkspaceSourceLineage;
}
export interface WorkspaceContractReceipt {readonly schema:typeof WORKSPACE_CONTRACT_PROJECTION_SCHEMA;readonly workspaceId:string;readonly componentRecipe:string;readonly blobHash:string;readonly contractCount:number;readonly ownerCount:number;readonly sourceRecordCount:number;readonly complete:boolean;readonly informationLabel:InformationLabel}
export interface WorkspaceContractProjection {readonly schema:typeof WORKSPACE_CONTRACT_PROJECTION_SCHEMA;readonly workspaceId:string;readonly componentRecipe:string;readonly complete:boolean;readonly owners:readonly WorkspaceContractOwner[];readonly contracts:readonly JsonValue[];readonly informationLabel:InformationLabel}
export function workspaceContractComponentRecipe(input:{readonly complete:boolean;readonly records:readonly {readonly path:string;readonly contentHash?:string;readonly sourceVersionId?:string;readonly ingestionStatus:string}[];readonly owners:readonly WorkspaceContractOwner[]}):string {
 const files=input.records.map(row=>[row.path,row.contentHash,row.sourceVersionId,row.ingestionStatus==="missing"]).sort((a,b)=>String(a[0]).localeCompare(String(b[0])));
 const pythonTests=input.records.some(row=>codeLanguageForPath(row.path)==="python")?{pythonSourceTests:PYTHON_SOURCE_TEST_COMPONENT_RECIPE}:{};
 return `${SOURCE_OWNED_CONTRACT_COMPILER_RECIPE}:${createHasher().digestHex(canonicalStringify({complete:input.complete,files,owners:input.owners,...pythonTests}))}`;
}
export function workspaceContractOwnerIsCurrent(value:WorkspaceContractOwner,current:WorkspaceContractOwner):boolean {
 return canonicalStringify(value)===canonicalStringify(current);
}

export interface WorkspaceCodeContractScope {readonly schema:"scce.workspace.program-context.v1";readonly workspaceId:string;readonly expectedWorkspaceUpdatedAt:number}
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
 if(!records.some(record=>record.evidenceIds.length))return unavailable("workspace.contracts.original_source_binding_unavailable");
 const bindings=await resolveWorkspaceSourceOwnership({storage:input.storage,records,informationAccess:input.informationAccess,sourceVersionAllowlist:input.sourceVersionAllowlist});
 const owners:WorkspaceContractOwner[]=[],admitted:EvidenceSpan[]=[];
 for(const record of records.filter(row=>codeLanguageForPath(row.path)!==undefined||/\.(?:json|md|txt)$/u.test(row.path))){
  const binding=bindings.get(record.path);if(!binding||binding.verificationLevel!=="bytes")continue;
  owners.push(workspaceContractOwnerFromBinding(record,binding));admitted.push(...binding.evidence);
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
  if(!["scce.source_owned_test_contract.v1","scce.source_owned_native_declaration.v1"].includes(String(contract.schema))||!owner||contract.sourceHash!==owner.contentHash||contract.sourcePath!==owner.path||contract.schema==="scce.source_owned_test_contract.v1"&&!Array.isArray(contract.cases))return unavailable("workspace.contracts.contract_owner_mismatch");
  for(const rawCase of Array.isArray(contract.cases)?contract.cases:[]){const row=object(rawCase),test=current.get(String(row.testSourceVersionId));
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

export function workspaceContractOwnerFromBinding(record:WorkspaceSourceFileRecord,binding:WorkspaceResolvedSourceOwnership):WorkspaceContractOwner {
 const version=binding.sourceVersion;
 return {path:record.path,sourceId:String(version.sourceId),sourceVersionId:String(version.sourceVersionId),contentHash:String(version.contentHash),namespace:version.namespace,
  byteLength:version.byteLength,evidenceIds:[...binding.evidenceIds].sort(),informationLabel:version.informationLabel!,...(binding.lineage?{lineage:binding.lineage}:{})};
}

/** One immutable, call-local snapshot. Evidence remains in its own source coordinates; only ownership follows lineage. */
export async function resolveWorkspaceSourceOwnership(input:{storage:ScceStorage;records:readonly WorkspaceSourceFileRecord[];
 informationAccess?:InformationAccessContext;sourceVersionAllowlist?:readonly string[];verifyBytes?:boolean}):Promise<ReadonlyMap<string,WorkspaceResolvedSourceOwnership>> {
 const result=new Map<string,WorkspaceResolvedSourceOwnership>(),store=input.storage.evidence,hasher=createHasher(),records=input.records.map(record=>structuredClone(record));
 const verifyBytes=input.verifyBytes!==false;
 const ids=[...new Set(records.flatMap(record=>record.evidenceIds.map(String)))];
 if(!ids.length||!store?.getEvidenceBatch||!store.sourceVersionsForEvidence||!input.storage.blobs?.get)return result;
 const [evidence,initialVersions]=await Promise.all([store.getEvidenceBatch(ids as never[]),store.sourceVersionsForEvidence(ids as never[])]);
 const versions=new Map<string,Promise<SourceVersion|null>>(),ambiguousVersions=new Set<string>(),seenVersions=new Map<string,string>();
 for(const inputVersion of initialVersions){
  const version=structuredClone(inputVersion);
  const id=String(version.sourceVersionId),signature=canonicalStringify(version),prior=seenVersions.get(id);
  if(prior!==undefined&&prior!==signature)ambiguousVersions.add(id);
  seenVersions.set(id,signature);versions.set(id,Promise.resolve(version));
 }
 const loadVersion=(id:string):Promise<SourceVersion|null>=>{
  if(ambiguousVersions.has(id))return Promise.resolve(null);
  let pending=versions.get(id);if(!pending){pending=(store.sourceVersionById?store.sourceVersionById(id as never):Promise.resolve(null)).then(row=>row&&String(row.sourceVersionId)===id?structuredClone(row):null);versions.set(id,pending);}
  return pending;
 };
 // Read and validate each content-addressed blob once, retaining exact bytes only for this batch.
 const blobs=new Map<string,Promise<Uint8Array|null>>();
 const loadBytes=(version:SourceVersion):Promise<Uint8Array|null>=>{
  const hash=String(version.contentHash);let pending=blobs.get(hash);
  if(!pending){pending=(async()=>{try{const bytes=new Uint8Array(await input.storage.blobs.get(version.contentHash));return `sha256_${hasher.digestHex(bytes)}`===hash?bytes:null;}catch{return null;}})();blobs.set(hash,pending);}
  return pending.then(bytes=>bytes&&bytes.byteLength===version.byteLength?bytes:null);
 };
 const spansById=new Map<string,EvidenceSpan>(),ambiguousSpans=new Set<string>();
 for(const inputSpan of evidence){const span=structuredClone(inputSpan),id=String(span.id),old=spansById.get(id);if(old&&canonicalStringify(old)!==canonicalStringify(span))ambiguousSpans.add(id);spansById.set(id,span);}
 const chainCache=new Map<string,Promise<readonly SourceVersion[]|undefined>>();
 const allowlist=input.sourceVersionAllowlist===undefined?undefined:new Set(input.sourceVersionAllowlist);
 const loadChain=(leafId:string):Promise<readonly SourceVersion[]|undefined>=>{
  let pending=chainCache.get(leafId);if(!pending){pending=(async()=>{
   const chain:SourceVersion[]=[],seen=new Set<string>();let id=leafId;
   while(!seen.has(id)){
    seen.add(id);const version=await loadVersion(id);if(!version||!version.informationLabel
      ||allowlist!==undefined&&!allowlist.has(id)||input.informationAccess!==undefined&&!readableLabel(version.informationLabel,input.informationAccess)
      ||verifyBytes&&!await loadBytes(version))return undefined;
    chain.push(version);
    if(version.role!=="evidence-derivative")return version.derivation===undefined&&(chain.length===1||version.role==="original")?chain:undefined;
    const derivation=version.derivation;
    if(!derivation||!derivation.transformId||!["redacted-text","extracted-text"].includes(derivation.kind)||!["source-bytes","extracted-text-utf8"].includes(derivation.originalCoordinateSpace)||!Array.isArray(derivation.redactionMap))return undefined;
    id=String(derivation.derivedFromSourceVersionId);if(!id)return undefined;
   }
   return undefined;
  })();chainCache.set(leafId,pending);}return pending;
 };
 for(const record of records){
  if(!record.contentHash||!["ingested","skipped"].includes(record.ingestionStatus))continue;
  const candidates=new Map<string,{version:SourceVersion;bytes:Uint8Array|undefined;spans:EvidenceSpan[];chains:Map<string,readonly SourceVersion[]>}>();
  for(const evidenceId of record.evidenceIds){
   if(ambiguousSpans.has(String(evidenceId)))continue;
   const span=spansById.get(String(evidenceId));if(!span||span.status!=="promoted")continue;
   const chain=await loadChain(String(span.sourceVersionId));if(!chain)continue;
   const original=chain.at(-1)!;
   if(String(original.contentHash)!==String(record.contentHash)||original.byteLength!==record.byteLength||record.sourceVersionId&&String(record.sourceVersionId)!==String(original.sourceVersionId)||!original.informationLabel)continue;
   const label=canonicalStringify(original.informationLabel);
   if(chain.some(version=>version.sourceId!==original.sourceId||version.namespace!==original.namespace||version.canonicalUri!==original.canonicalUri
    ||canonicalStringify(version.informationLabel)!==label||object(object(version.metadata).workspace).id!==record.workspaceId||object(object(version.metadata).workspaceFile).path!==record.path
    ||allowlist!==undefined&&!allowlist.has(String(version.sourceVersionId))||input.informationAccess!==undefined&&!readableLabel(version.informationLabel,input.informationAccess)))continue;
   if(span.sourceId!==original.sourceId||span.informationLabel!==undefined&&canonicalStringify(span.informationLabel)!==label
    ||input.informationAccess!==undefined&&span.informationLabel!==undefined&&!readableLabel(span.informationLabel,input.informationAccess))continue;
   const leaf=chain[0]!;
   if(!Number.isSafeInteger(span.byteStart)||!Number.isSafeInteger(span.byteEnd)||span.byteStart<0||span.byteEnd<span.byteStart||span.byteEnd>leaf.byteLength)continue;
   if(verifyBytes){const leafBytes=(await loadBytes(leaf))!,bytes=leafBytes.subarray(span.byteStart,span.byteEnd);
    if(`sha256_${hasher.digestHex(bytes)}`!==String(span.contentHash)||new TextDecoder().decode(bytes)!==span.text)continue;}
   const id=String(original.sourceVersionId),candidate:NonNullable<ReturnType<typeof candidates.get>>=candidates.get(id)??{version:original,bytes:verifyBytes?(await loadBytes(original))!:undefined,spans:[],chains:new Map()};
   candidate.spans.push(span);candidate.chains.set(String(leaf.sourceVersionId),chain);candidates.set(id,candidate);
  }
  // Multiple retained originals are ambiguous even when their current bytes happen to agree.
  if(candidates.size!==1)continue;
  const candidate=[...candidates.values()][0]!,lineageChains=[...candidate.chains].filter(([,chain])=>chain.length>1).sort((a,b)=>a[0].localeCompare(b[0]));
  const lineage:WorkspaceSourceLineage|undefined=lineageChains.length?{
   schema:"scce.workspace.source_lineage.v1",targetCoordinateSpace:"original-source-bytes",evidenceCoordinateSpace:"per-source-version-bytes",
   chains:lineageChains.map(([evidenceSourceVersionId,chain])=>({evidenceSourceVersionId,hops:chain.map(version=>({
    sourceVersionId:String(version.sourceVersionId),contentHash:String(version.contentHash),byteLength:version.byteLength,role:version.role!,
    ...(version.derivation?{parentSourceVersionId:String(version.derivation.derivedFromSourceVersionId),derivationHash:`sha256_${hasher.digestHex(canonicalStringify(version.derivation))}`}:{})
   }))}))
  }:undefined;
  result.set(record.path,{sourceVersionId:String(candidate.version.sourceVersionId),sourceVersion:candidate.version,verificationLevel:verifyBytes?"bytes":"metadata",...(candidate.bytes?{sourceBytes:candidate.bytes}:{}),evidence:candidate.spans,
   evidenceIds:candidate.spans.map(span=>String(span.id)),...(lineage?{lineage}:{})});
 }
 return result;
}
