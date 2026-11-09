// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
import {createHasher} from "./primitives.js";
import type {FileArtifact} from "./types.js";
export const FILE_ARTIFACT_CONTENTS_SCHEMA="scce.file_artifact_contents.v1";
export const FILE_ARTIFACT_CONTENT_REF_SCHEMA="scce.file_artifact_content_ref.v1";
export interface FileArtifactContentReference {schema:typeof FILE_ARTIFACT_CONTENT_REF_SCHEMA;contentHash:string;artifactIdentityHash:string}
export type ReferencedFileArtifact=Omit<FileArtifact,"content">&{contentRef:FileArtifactContentReference};
export interface FileArtifactContents {schema:typeof FILE_ARTIFACT_CONTENTS_SCHEMA;additional:Record<string,string>}
const object=(value:unknown):value is Record<string,unknown>=>Boolean(value)&&typeof value==="object"&&!Array.isArray(value);
const hashPattern=/^sha256_[a-f0-9]{64}$/u;
function identity(value:Record<string,unknown>):boolean {
 return typeof value.artifactId==="string"&&value.artifactId.length>0&&typeof value.path==="string"&&value.path.length>0
  &&typeof value.mediaType==="string"&&value.mediaType.length>0&&typeof value.contentHash==="string"&&hashPattern.test(value.contentHash)
  &&typeof value.role==="string"&&["source","test","config","doc"].includes(value.role);
}
function artifactIdentityHash(value:Record<string,unknown>):string {
 return `sha256_${createHasher().digestHex(JSON.stringify([value.artifactId,value.path,value.mediaType,value.role,value.contentHash]))}`;
}
function contents(){
 const values=new Map<string,string>(),hasher=createHasher();
 return {values,put(hash:string,content:string){const prior=values.get(hash);if(prior!==undefined){if(prior!==content)throw Error("artifact content hash collision");return;}
  if(!hashPattern.test(hash)||`sha256_${hasher.digestHex(content)}`!==hash)throw Error("artifact content hash mismatch");values.set(hash,content);}};
}
/** Lossless transport only. The final public files retain their exact content. */
export function encodeProgramArtifactWire(input:Record<string,unknown>):Record<string,unknown>{
 if(Object.hasOwn(input,"artifactContents"))throw Error("artifact content wire header collision");
 const pool=contents(),finalHashes=new Set<string>(),additional:Record<string,string>={};let references=0;
 if(Array.isArray(input.programArtifacts))for(const artifact of input.programArtifacts){
  if(!object(artifact)||!identity(artifact)||typeof artifact.content!=="string"||Object.hasOwn(artifact,"contentRef"))throw Error("invalid final artifact identity");
  pool.put(String(artifact.contentHash),artifact.content);finalHashes.add(String(artifact.contentHash));
 }
 const visit=(value:unknown):unknown=>{
  if(Array.isArray(value))return value.map(visit);if(!object(value)||typeof value.toJSON==="function")return value;
  if(identity(value)&&typeof value.content==="string"){
   if(Object.hasOwn(value,"contentRef"))throw Error("artifact content reference collision");
   const hash=String(value.contentHash);pool.put(hash,value.content);if(!finalHashes.has(hash))additional[hash]=value.content;
   references++;const ref={schema:FILE_ARTIFACT_CONTENT_REF_SCHEMA,contentHash:hash,artifactIdentityHash:artifactIdentityHash(value)};
   return Object.fromEntries(Object.entries(value).map(([key,item])=>key==="content"?["contentRef",ref]:[key,visit(item)]));
  }
  return Object.fromEntries(Object.entries(value).map(([key,item])=>[key,visit(item)]));
 };
 const output=Object.fromEntries(Object.entries(input).map(([key,value])=>[key,key==="programArtifacts"?value:visit(value)]));
 return references?{...output,artifactContents:{schema:FILE_ARTIFACT_CONTENTS_SCHEMA,additional}}:output;
}
/** Restore exact ledger payloads before verifying their hashes or using files. */
export function decodeProgramArtifactWire(input:Record<string,unknown>):Record<string,unknown>{
 const header=input.artifactContents,pool=contents(),additional=new Set<string>(),used=new Set<string>();
 if(header!==undefined&&(!object(header)||header.schema!==FILE_ARTIFACT_CONTENTS_SCHEMA||!object(header.additional)
  ||Object.keys(header).some(key=>key!=="schema"&&key!=="additional")))throw Error("invalid artifact content wire header");
 if(Array.isArray(input.programArtifacts))for(const artifact of input.programArtifacts){
  if(!object(artifact)||!identity(artifact)||typeof artifact.content!=="string"||Object.hasOwn(artifact,"contentRef"))throw Error("invalid final artifact identity");
  pool.put(String(artifact.contentHash),artifact.content);
 }
 if(object(header)&&object(header.additional))for(const [hash,value]of Object.entries(header.additional)){
  if(typeof value!=="string")throw Error("invalid artifact content entry");if(pool.values.has(hash))throw Error("duplicate final artifact content entry");pool.put(hash,value);additional.add(hash);
 }
 const visit=(value:unknown):unknown=>{
  if(Array.isArray(value))return value.map(visit);if(!object(value)||typeof value.toJSON==="function")return value;
  if(object(value.contentRef)&&value.contentRef.schema===FILE_ARTIFACT_CONTENT_REF_SCHEMA&&!identity(value))throw Error("invalid artifact descriptor identity");
  if(Object.hasOwn(value,"contentRef")&&identity(value)){
   const ref=value.contentRef;
   if(header===undefined)throw Error("missing artifact content wire header");
   if(Object.hasOwn(value,"content")||!object(ref)||ref.schema!==FILE_ARTIFACT_CONTENT_REF_SCHEMA||ref.contentHash!==value.contentHash||ref.artifactIdentityHash!==artifactIdentityHash(value)
    ||Object.keys(ref).some(key=>key!=="schema"&&key!=="contentHash"&&key!=="artifactIdentityHash"))throw Error("invalid artifact content reference identity");
   const content=pool.values.get(String(ref.contentHash));if(content===undefined)throw Error("dangling artifact content reference");
   used.add(String(ref.contentHash));
   return Object.fromEntries(Object.entries(value).map(([key,item])=>key==="contentRef"?["content",content]:[key,visit(item)]));
  }
  return Object.fromEntries(Object.entries(value).map(([key,item])=>[key,visit(item)]));
 };
 const output=Object.fromEntries(Object.entries(input).filter(([key])=>key!=="artifactContents").map(([key,value])=>[key,key==="programArtifacts"?value:visit(value)]));
 for(const hash of additional)if(!used.has(hash))throw Error("unreferenced artifact content entry");
 return output;
}
