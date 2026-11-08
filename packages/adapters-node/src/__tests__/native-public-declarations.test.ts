// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
import {describe,it,expect} from "vitest";
import {createHash} from "node:crypto";
import {mkdtemp,writeFile,rm} from "node:fs/promises";
import {tmpdir} from "node:os";
import path from "node:path";
import {execFile} from "node:child_process";
import {promisify} from "node:util";
import {compileSourceOwnedContracts} from "../source-owned-contract-compiler.js";
import {grammarSourceOwnedNativeDeclarations} from "../grammar-source-owned-test-contracts.js";
import {publishWorkspaceOwnedContracts} from "../workspace-owned-contracts.js";
import {findCodeVerifierCapability} from "../code-verifier-discovery.js";
import {NodeBuildTestAdapter} from "../process.js";
import type {ScceRuntimeConfig} from "../config.js";
import {sourceOwnedProgramBehaviorFromDocumentation,projectSourceOwnedProgramBehavior,codeRequestSignal,programIntentForTurn,COGNITIVE_OPERATOR_IDS,createHasher,createClock,createIdFactory,createProgramGraphBuilder,replanOwnerBehaviorProgramIntent,ownedNativeCallableAbi,nativeCallableAbiId,readWorkspaceOwnedProgramContracts,type ScceStorage,type WorkspaceRecord,type WorkspaceSourceFileRecord,type SourceVersion,type EvidenceSpan,type SemanticEntailmentResult} from "@scce/kernel";
const hash=(text:string)=>`sha256:${createHash("sha256").update(text).digest("hex")}`;
const declaration=`\u{1fab6}
\`\`\`rust
pub fn x0(records: &mut std::collections::HashMap<String, String>, key: &str, value: &str);
pub fn x1(records: &std::collections::HashMap<String, String>, key: &str) -> String;
pub fn x2(records: &mut std::collections::HashMap<String, String>, key: &str);
\`\`\`
`;
const source=(text=declaration)=>({path:"specification.txt",text,sourceHash:hash(text),sourceVersionId:"version.public-declarations"});
const request=`Rust module.rs.
x0(key,value); x1(key); x2(key).
x0("a","one"); x1("a") => "one"
x0("a","two"); x1("a") => "two"
x2("a"); x1("a") => "~"
x0("b","three"); x1("b") => "three"`;
async function acquired(text=declaration){
 const file=source(text),projections=await compileSourceOwnedContracts({root:".",files:[{...file,bytes:Buffer.from(text)}],sourceUriBase:"fixture://public",knownPaths:[file.path],complete:true,maxFileBytes:Buffer.byteLength(text),maxTotalBytes:Buffer.byteLength(text)});
 const intent={languageId:"rust",symbols:[],references:[{sourceFamily:"fixture://public",relativePath:file.path,sourceHash:file.sourceHash,score:1}],audit:null};
 const behavior=sourceOwnedProgramBehaviorFromDocumentation({requestText:request,intent,patterns:[...projections.values()].flat().map(patternJson=>({patternJson}))});
 const codeSignal=projectSourceOwnedProgramBehavior({codeSignal:codeRequestSignal(request),intent,sourceBehavior:behavior});
 const programIntent=programIntentForTurn({requestedAuthority:"program",activeOperatorIds:[COGNITIVE_OPERATOR_IDS.programPlanning],codeSignal,evidence:[]})!;
 const hasher=createHasher(),ids=createIdFactory({clock:createClock({fixedTime:1}),hasher,deterministicReplay:true});
 const builder=createProgramGraphBuilder({idFactory:ids,hasher});
 const build=(intent=programIntent)=>builder.build({episodeId:ids.episodeId(),text:request,createdAt:1,evidence:[],entailment:emptyEntailment(ids),programIntent:intent});
 return {file,behavior,programIntent,hasher,ids,build};
}
describe("source-owned public declaration ABI",()=>{
 it("acquires exact Unicode document declaration spans and mutable state positions without assertions",async()=>{
  const file=source(),abis=await grammarSourceOwnedNativeDeclarations(file);
  expect(file.text.startsWith(String.fromCodePoint(0x1fab6))).toBe(true);
  expect(abis.map(abi=>abi.callableName)).toEqual(["x0","x1","x2"]);
  for(const abi of abis){expect(file.text.slice(abi.signatureSpan.start,abi.signatureSpan.end)).toBe(abi.signatureText);expect(ownedNativeCallableAbi(abi,{...abi.owner,callableName:abi.callableName,languageId:"rust"})).toEqual(abi);}
  expect(abis.map(abi=>abi.stateParameter?.mutable)).toEqual([true,false,true]);
  const compiled=await acquired();expect(compiled.behavior.behaviorRequirements).toEqual([]);expect(compiled.behavior.statefulBehaviorRequirements).toEqual([]);
  expect(compiled.programIntent.nativeDeclarations).toHaveLength(3);expect(compiled.programIntent.statefulBehaviorRequirements!.length).toBeGreaterThan(1);
 });
 it("rejects mutable-port tampering, duplicate declarations, bodies, unbound aliases and wrong exact source bytes",async()=>{
  const abis=await grammarSourceOwnedNativeDeclarations(source()),abi=abis[0]!;
  const altered={...abi,stateParameter:{...abi.stateParameter!,mutable:false}};altered.id=nativeCallableAbiId(altered);
  expect(ownedNativeCallableAbi(altered,{...abi.owner,callableName:abi.callableName,languageId:"rust"})).toBeUndefined();
  for(const text of [declaration.replace("std::collections::HashMap","HashMap"),declaration.replace("pub fn x1","pub fn x0"),declaration.replace("value: &str);","value: &str) {}")])expect(await grammarSourceOwnedNativeDeclarations(source(text))).toEqual([]);
  expect(await grammarSourceOwnedNativeDeclarations({...source(),sourceHash:hash("different")})).toEqual([]);
 });
 it("accepts Go package-owned declaration prototypes and preserves a non-leading Rust map port",async()=>{
  const go="```go\npackage main\nfunc a(key string, value string)\nfunc b(key string) string\n```\n";
  const abis=await grammarSourceOwnedNativeDeclarations(source(go));expect(abis.map(abi=>[abi.callableName,abi.packageName,abi.parameters.map(parameter=>parameter.type.text)])).toEqual([["a","main",["string","string"]],["b","main",["string"]]]);
  const moved=declaration.replace("x0(records: &mut std::collections::HashMap<String, String>, key: &str, value: &str)","x0(key: &str, records: &mut std::collections::HashMap<String, String>, value: &str)");
  expect((await grammarSourceOwnedNativeDeclarations(source(moved)))[0]!.stateParameter?.index).toBe(1);
 });
 it("publishes cached original doc bytes once and cold-reads only exact accessible owners without new model profiles",async()=>{
  const file=source(),contentHash=`sha256_${file.sourceHash.slice(7)}`,blobs=new Map<string,Uint8Array>([[contentHash,Buffer.from(file.text)]]);
  const label={tenantId:"fixture",principals:["owner"],compartments:[],exportClass:"confidential",mergePolicy:"same_owner"} as const;
  const version={sourceId:"source.public",sourceVersionId:file.sourceVersionId,contentHash,byteLength:Buffer.byteLength(file.text),namespace:"public-workspace",informationLabel:label,metadata:{workspace:{id:"workspace.public"},workspaceFile:{path:file.path}}} as unknown as SourceVersion;
  const evidence={id:"evidence.public",sourceVersionId:file.sourceVersionId,status:"promoted",informationLabel:label} as unknown as EvidenceSpan;
  const row={workspaceId:"workspace.public",path:file.path,ingestionStatus:"ingested",contentHash,sourceVersionId:file.sourceVersionId,evidenceIds:[evidence.id]} as WorkspaceSourceFileRecord;
  let workspace={id:"workspace.public",updatedAt:1,metadata:{sourceContracts:{schema:"scce.workspace.source_contract_projection.v1",componentRecipe:"scce.source_owned_contract_snapshot_compiler.v1:old",blobHash:"old"}}} as unknown as WorkspaceRecord;
  let writes=0,reads=0;
  const storage={transaction:async(fn:()=>Promise<unknown>)=>fn(),blobs:{get:async(id:string)=>{reads++;const bytes=blobs.get(id);if(!bytes)throw Error("missing");return bytes;},put:async(bytes:Uint8Array)=>{writes++;const id=`sha256_${createHash("sha256").update(bytes).digest("hex")}`;blobs.set(id,bytes);return id;}},
   workspace:{getWorkspace:async()=>workspace,putWorkspace:async(value:WorkspaceRecord)=>{workspace=value;},listSourceFiles:async()=>[row]},evidence:{getEvidenceBatch:async()=>[evidence],sourceVersionsForEvidence:async()=>[version]}} as unknown as ScceStorage;
  const publish=()=>publishWorkspaceOwnedContracts({storage,workspace,root:".",records:[row],bindings:new Map([[file.path,{sourceVersionId:file.sourceVersionId,evidenceIds:[String(evidence.id)],sourceVersion:version,evidence:[evidence]}]]),complete:true,maxFileBytes:Buffer.byteLength(file.text)});
  expect(await publish()).toMatchObject({status:"compiled",contracts:3,sourceVersions:1});expect(writes).toBe(1);
  const access={tenantId:"fixture",principalId:"owner",compartments:[],maximumExportClass:"restricted" as const},context={schema:"scce.workspace.program-context.v1",workspaceId:workspace.id,expectedWorkspaceUpdatedAt:1};
  const read=await readWorkspaceOwnedProgramContracts({storage,context,informationAccess:access});expect(read.status).toBe("available");if(read.status==="available")expect(read.contracts).toHaveLength(3);
  expect(await readWorkspaceOwnedProgramContracts({storage,context,informationAccess:{...access,principalId:"foreign"}})).toMatchObject({status:"unavailable"});
  const beforeReads=reads;expect(await publish()).toMatchObject({status:"current",contracts:3});expect(reads).toBe(beforeReads);expect(writes).toBe(1);
 });
 it("keeps missing or conflicting public declaration owners unavailable",async()=>{
  const item=await acquired(),probe=item.build();expect(probe.program).toBeDefined();
  const declarations=item.programIntent.nativeDeclarations!;
  const missing=item.build({...item.programIntent,nativeDeclarations:declarations.filter(abi=>abi.callableName!=="x0")});expect(missing.program).toBeUndefined();
  const copied={...declarations[0]!,owner:{...declarations[0]!.owner,sourceVersionId:"other-public-version"}};copied.id=nativeCallableAbiId(copied);
  const ambiguous=item.build({...item.programIntent,nativeDeclarations:[...declarations,copied]});expect(ambiguous.program).toBeUndefined();
 });
 it("refuses a selected write through an immutable source-declared state port after a real probe failure",async()=>{
  const item=await acquired(declaration.replace("x0(records: &mut", "x0(records: &")),root=await mkdtemp(path.join(tmpdir(),"scce-immutable-native-map-"));
  try{
   const probe=item.build(),native=new NodeBuildTestAdapter({runtime:{tempRoot:root}} as ScceRuntimeConfig);
   expect(probe.program).toBeDefined();const failed=await native.executeProgram({episodeId:probe.episodeId,construct:probe});expect(failed.build.code,failed.build.stderr).toBe(0);expect(failed.passed).toBe(false);
   const retry=replanOwnerBehaviorProgramIntent({intent:item.programIntent,program:probe.program!,hasher:item.hasher,failure:{observationId:"immutable-native-probe",programId:probe.program!.id,planHash:item.hasher.digestHex(JSON.stringify(probe.program!.files)),validatorId:"native-rust",checkId:"tests",status:"failed",ownerRequirementIds:item.programIntent.statefulBehaviorRequirements!.map(row=>row.id),command:probe.program!.test}});
   const refused=item.build(retry.intent);expect(refused.program).toBeUndefined();
   expect(refused.nodes.find(node=>node.kind==="program_emission_unavailable")?.metadata).toMatchObject({reasonIds:["program.emission.rust.state_port_unsupported"]});
  }finally{await rm(root,{recursive:true,force:true});}
 });
 it.each([false,true])("executes genuine external Rust ABI through native fail/retry, raw keys and independent stores (non-leading port=%s)",async moved=>{
  const text=moved?declaration.replace("x0(records: &mut std::collections::HashMap<String, String>, key: &str, value: &str)","x0(key: &str, records: &mut std::collections::HashMap<String, String>, value: &str)").replace("x1(records: &std::collections::HashMap<String, String>, key: &str)","x1(key: &str, records: &std::collections::HashMap<String, String>)"):declaration;
  const acquired_=await acquired(text),root=await mkdtemp(path.join(tmpdir(),"scce-external-rust-"));
  try{
   const probe=acquired_.build(),native=new NodeBuildTestAdapter({runtime:{tempRoot:root}} as ScceRuntimeConfig);
   expect(probe.program).toBeDefined();
   const failed=await native.executeProgram({episodeId:probe.episodeId,construct:probe});expect(failed.build.code,failed.build.stderr).toBe(0);expect(failed.passed).toBe(false);
   const retry=replanOwnerBehaviorProgramIntent({intent:acquired_.programIntent,program:probe.program!,hasher:acquired_.hasher,failure:{observationId:"real-native-failure",programId:probe.program!.id,planHash:acquired_.hasher.digestHex(JSON.stringify(probe.program!.files)),validatorId:"native-rust",checkId:"tests",status:"failed",ownerRequirementIds:acquired_.programIntent.statefulBehaviorRequirements!.map(row=>row.id),command:probe.program!.test}});
   const selected=acquired_.build(retry.intent),passed=await native.executeProgram({episodeId:selected.episodeId,construct:selected});expect(passed.passed,`${passed.build.stderr}\n${passed.test.stderr}`).toBe(true);
   const module=selected.program!.files.find(file=>file.path==="module.rs")!;expect(module).toBeDefined();
   await writeFile(path.join(root,"module.rs"),module.content);
   const driver=`mod module;use std::collections::HashMap;fn main(){let mut a=HashMap::new();let mut b=HashMap::new();module::x0(&mut a,"\u{1fab6} raw-key","unseen");assert_eq!(a.get("\u{1fab6} raw-key").unwrap(),"unseen");module::x0(&mut a,"other","retained");module::x0(&mut a,"\u{1fab6} raw-key","overwrite");assert_eq!(module::x1(&a,"\u{1fab6} raw-key"),"overwrite");assert_eq!(module::x1(&b,"\u{1fab6} raw-key"),"~");module::x0(&mut b,"\u{1fab6} raw-key","second");module::x2(&mut a,"\u{1fab6} raw-key");assert!(!a.contains_key("\u{1fab6} raw-key"));assert_eq!(module::x1(&a,"other"),"retained");assert_eq!(module::x1(&b,"\u{1fab6} raw-key"),"second");}`;
   await writeFile(path.join(root,"private.rs"),moved?driver.replaceAll(/module::x0\(&mut ([ab]),"([^"\n]+)",/gu,'module::x0("$2",&mut $1,').replaceAll(/module::x1\(&([ab]),"([^"\n]+)"\)/gu,'module::x1("$2",&$1)'):driver);
   const capability=await findCodeVerifierCapability("rust");expect(capability.status).toBe("available");if(capability.status!=="available")throw new Error(capability.reason);
   await promisify(execFile)(capability.verifier.command,["--edition=2021","private.rs","-o","private.exe"],{cwd:root,timeout:60000});await promisify(execFile)(path.join(root,"private.exe"),[],{cwd:root,timeout:60000});
   expect(JSON.stringify(acquired_.behavior)).not.toContain("raw-key");
  }finally{await rm(root,{recursive:true,force:true});}
 });
});

function emptyEntailment(ids: ReturnType<typeof createIdFactory>): SemanticEntailmentResult {
  const claimId = ids.claimId("public native source contract"), proofId = ids.proofId({ claimId, evidenceIds: [], transforms: [], validatorVersion: "fixture" });
  return { claim: { id: claimId, text: "", normalized: "", features: [], polarity: 1 }, verdict: "underdetermined", semanticVerdict: "underdetermined",
    force: "unknown", support: 0, contradiction: 0, faithfulnessLcb: 0,
    confidence: { verdict: "underdetermined", support: 0, contradiction: 0, faithfulnessLcb: 0, supportingEvidence: 0, sourceVersions: [], structuralCoverage: 0, roleCoverage: 0,
      relationCompatibility: 0, transformationSupport: 0, causalMass: 0, stability: 1, satisfiedObligations: 0, requiredObligations: 0 },
    scores: { structuralCoverage: 0, roleCoverage: 0, relationCompatibility: 0, transformationSupport: 0, causalMass: 0, faithfulnessLCB: 0, contradiction: 0, stability: 1 },
    obligations: [], mappings: [], transforms: [], counterexamples: [], missing: [], evidenceIds: [], boundaries: [],
    proof: { id: proofId, claimId, verdict: "unknown", confidence: {}, proofGraph: { nodes: [], edges: [] }, evidenceIds: [], transformIds: [], scores: {}, validatorVersion: "fixture", createdAt: 1 } };
}
