// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
import {createHash} from "node:crypto";
import {codeLanguageForPath,SOURCE_OWNED_CONTRACT_COMPILER_RECIPE,type JsonValue} from "@scce/kernel";
import {buildTypeScriptSemanticProgramIndex,type TypeScriptSemanticProgramIndex} from "./typescript-semantic-program-index.js";
import {grammarSourceOwnedTestCases,grammarSourceOwnedNativeDeclarations} from "./grammar-source-owned-test-contracts.js";
import {sourceOwnedTestCases,sourceOwnedTestContractProjections} from "./source-owned-test-contracts.js";

export {SOURCE_OWNED_CONTRACT_COMPILER_RECIPE};
export interface OwnedContractSnapshotFile {readonly path:string;readonly bytes:Uint8Array;readonly sourceHash:string;readonly sourceVersionId?:string}
export async function compileSourceOwnedContracts(input:{readonly root:string;readonly files:readonly OwnedContractSnapshotFile[];readonly sourceUriBase:string;
 readonly knownPaths:readonly string[];readonly complete:boolean;readonly maxFileBytes:number;readonly maxTotalBytes:number;readonly semanticProgram?:TypeScriptSemanticProgramIndex}):Promise<Map<string,JsonValue[]>>{
 const files=input.files.map(file=>{
  const bytes=Buffer.from(file.bytes),hash=`sha256:${createHash("sha256").update(bytes).digest("hex")}`,text=bytes.toString("utf8");
  if(hash!==file.sourceHash.replace(/^sha256_/u,"sha256:") || !Buffer.from(text,"utf8").equals(bytes)) throw new Error(`source contract snapshot differs from exact UTF-8 bytes: ${file.path}`);
  return {...file,text,languageId:codeLanguageForPath(file.path),contentHash:hash as `sha256:${string}`};
 });
 const cases=await grammarSourceOwnedTestCases(files.flatMap(file=>file.sourceVersionId && (file.languageId==="python"||file.languageId==="go"||file.languageId==="rust")
  ?[{path:file.path,text:file.text,languageId:file.languageId,sourceHash:file.sourceHash,sourceVersionId:file.sourceVersionId}]:[]),{knownPaths:input.knownPaths,complete:input.complete});
 const ecma=files.filter(file=>file.languageId==="typescript"||file.languageId==="javascript");
 if(ecma.length && (input.semanticProgram || files.some(file=>file.path==="tsconfig.json"))){
  const compilerFiles=files.filter(file=>file.languageId==="typescript"||file.languageId==="javascript"||file.path.endsWith(".json"));
  const program=input.semanticProgram??await buildTypeScriptSemanticProgramIndex({workspaceRoot:input.root,tsconfigPath:"tsconfig.json",compileOnlyBoundedFiles:true,
   bounds:{workspacePaths:compilerFiles.map(file=>file.path),observedTestPaths:ecma.map(file=>file.path),maxFiles:compilerFiles.length,maxFileBytes:input.maxFileBytes,maxTotalBytes:input.maxTotalBytes},
   sourceSnapshot:compilerFiles.map(file=>({path:file.path,bytes:file.bytes,contentHash:file.contentHash}))});
  const versions=new Map(ecma.flatMap(file=>file.sourceVersionId?[[file.path,{sourceVersionId:file.sourceVersionId,sourceHash:file.sourceHash}] as const]:[]));
  cases.push(...sourceOwnedTestCases({program,sourceVersions:versions,testVersions:versions,sourceTexts:new Map(files.map(file=>[file.path,file.text]))}));
 }
 const projections=sourceOwnedTestContractProjections(cases,input.sourceUriBase);
 for(const file of files.filter(file=>file.sourceVersionId && /\.(?:txt|md)$/u.test(file.path))){
  const declarations=await grammarSourceOwnedNativeDeclarations({...file,sourceVersionId:file.sourceVersionId!});
  if(!declarations.length)continue;
  const rows=projections.get(file.path)??[];
  for(const abi of declarations)rows.push({schema:"scce.source_owned_native_declaration.v1",repositoryFamily:input.sourceUriBase,
   sourcePath:file.path,sourceHash:file.sourceHash,sourceVersionId:file.sourceVersionId!,formalLanguage:abi.languageId,
   targetName:abi.callableName,targetSymbolId:abi.owner.targetSymbolId,nativeAbi:abi} as unknown as JsonValue);
  projections.set(file.path,rows);
 }
 return projections;
}
