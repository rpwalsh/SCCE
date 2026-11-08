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
import {findCodeVerifierCapability} from "../code-verifier-discovery.js";
import {NodeBuildTestAdapter} from "../process.js";
import type {ScceRuntimeConfig} from "../config.js";
import {sourceOwnedProgramBehaviorFromDocumentation,projectSourceOwnedProgramBehavior,codeRequestSignal,programIntentForTurn,COGNITIVE_OPERATOR_IDS,createHasher,createClock,createIdFactory,createProgramGraphBuilder,replanOwnerBehaviorProgramIntent,createProgramPlanner,type ProgramExpression,type SemanticEntailmentResult} from "@scce/kernel";
import {nativeRustProgram} from "../../../kernel/src/native-rust-program.js";
const hash=(text:string)=>`sha256:${createHash("sha256").update(text).digest("hex")}`;
async function acquire(signature:string,examples:string){
 const text=`\`\`\`rust\n${signature};\n\`\`\`\n`,source={path:"public-abi.md",sourceHash:hash(text),sourceVersionId:"public.scalar-abi",bytes:Buffer.from(text)};
 const contracts=await compileSourceOwnedContracts({root:".",files:[source],sourceUriBase:"fixture://native-scalars",knownPaths:[source.path],complete:true,maxFileBytes:source.bytes.byteLength,maxTotalBytes:source.bytes.byteLength});
 const request=`Rust module.rs.\n${examples}`,intent={languageId:"rust",symbols:[],references:[{sourceFamily:"fixture://native-scalars",relativePath:source.path,sourceHash:source.sourceHash,score:1}],audit:null};
 const behavior=sourceOwnedProgramBehaviorFromDocumentation({requestText:request,intent,patterns:[...contracts.values()].flat().map(patternJson=>({patternJson}))});
 const codeSignal=projectSourceOwnedProgramBehavior({codeSignal:codeRequestSignal(request),intent,sourceBehavior:behavior}),programIntent=programIntentForTurn({requestedAuthority:"program",activeOperatorIds:[COGNITIVE_OPERATOR_IDS.programPlanning],codeSignal,evidence:[]})!;
 const hasher=createHasher(),ids=createIdFactory({clock:createClock({fixedTime:1}),hasher,deterministicReplay:true}),builder=createProgramGraphBuilder({idFactory:ids,hasher});
 const build=(intent=programIntent)=>builder.build({episodeId:ids.episodeId(),text:request,createdAt:1,evidence:[],entailment:emptyEntailment(ids),programIntent:intent});
 const planner=createProgramPlanner({idFactory:ids,hasher}),input={episodeId:ids.episodeId(),requestText:request,evidence:[],programIntent,entailment:emptyEntailment(ids)};
 return {request,programIntent,hasher,ids,build,planner,input};
}
const addExamples='z0(1) => 2\nz0(2) => 3\nz0(5) => 6\nz0(-2) => -1';
async function selected(item:Awaited<ReturnType<typeof acquire>>,root:string){
 const native=new NodeBuildTestAdapter({runtime:{tempRoot:root}} as ScceRuntimeConfig),probe=item.build();expect(probe.program).toBeDefined();
 const failed=await native.executeProgram({episodeId:probe.episodeId,construct:probe});expect(failed.build.code,failed.build.stderr).toBe(0);expect(failed.passed).toBe(false);
 const retry=replanOwnerBehaviorProgramIntent({intent:item.programIntent,program:probe.program!,hasher:item.hasher,failure:{observationId:"scalar.native.failed",programId:probe.program!.id,planHash:item.hasher.digestHex(JSON.stringify(probe.program!.files)),validatorId:"rustc",checkId:"tests",status:"failed",ownerRequirementIds:item.programIntent.behaviorRequirements!.map(row=>row.id),command:probe.program!.test}});
 const construct=item.build(retry.intent),passed=await native.executeProgram({episodeId:construct.episodeId,construct});expect(passed.passed,`${passed.build.stderr}\n${passed.test.stderr}`).toBe(true);
 return construct.program!;
}
async function privateBinary(root:string,program:Awaited<ReturnType<typeof selected>>,driver:string,optimized=false){
 await writeFile(path.join(root,"module.rs"),program.files.find(file=>file.path==="module.rs")!.content);await writeFile(path.join(root,"private.rs"),driver);
 const capability=await findCodeVerifierCapability("rust");expect(capability.status).toBe("available");if(capability.status!=="available")throw Error(capability.reason);
 await promisify(execFile)(capability.verifier.command,["--edition=2021",...(optimized?["-C","opt-level=3","-C","overflow-checks=off"]:[]),"private.rs","-o","private.exe"],{cwd:root,timeout:60000});
 await promisify(execFile)(path.join(root,"private.exe"),[],{cwd:root,timeout:60000});
}
describe("source-owned native Rust scalar programs",()=>{
 it("realizes source-declared i64 piecewise bounds using native IR, including exact unseen values beyond 2^53",async()=>{
  const item=await acquire("pub fn z0(value:i64,lower:i64,upper:i64)->i64",'z0(10,0,5) => 5\nz0(-3,0,5) => 0\nz0(3,0,5) => 3\nz0(-7,-10,-4) => -7\nz0(-15,-10,-4) => -10\nz0(99,-10,-4) => -4\nz0(4,-10,-4) => -4'),root=await mkdtemp(path.join(tmpdir(),"scce-rust-i64-bounds-"));
  try{
   const program=await selected(item,root),source=program.files.find(file=>file.path==="module.rs")!.content;expect(source).toContain("-> i64");expect(source).not.toContain("f64");
   await privateBinary(root,program,`mod module;fn main(){for (v,lo,hi,want) in [(19,-7,13,13),(-12,-7,13,-7),(0,-7,13,0),(-7,-7,13,-7),(13,-7,13,13),(9007199254740993,9007199254740992,9007199254740995,9007199254740993),(i64::MIN,i64::MIN,i64::MAX,i64::MIN),(i64::MAX,i64::MIN,i64::MAX,i64::MAX)]{assert_eq!(module::z0(v,lo,hi),want);}}`);
  }finally{await rm(root,{recursive:true,force:true});}
 });
 it.each([false,true])("keeps i64 addition exact and rejects overflow consistently (optimized=%s)",async optimized=>{
  const item=await acquire("pub fn z0(value:i64)->i64",addExamples),root=await mkdtemp(path.join(tmpdir(),"scce-rust-i64-add-"));
  try{const program=await selected(item,root);await privateBinary(root,program,`mod module;fn main(){assert_eq!(module::z0(9007199254740993),9007199254740994);assert_eq!(module::z0(-9007199254740993),-9007199254740992);assert_eq!(module::z0(i64::MAX-1),i64::MAX);assert_eq!(module::z0(i64::MIN),i64::MIN+1);assert!(std::panic::catch_unwind(||module::z0(i64::MAX)).is_err());}`,optimized);}finally{await rm(root,{recursive:true,force:true});}
 });
 it("executes the declared i8 endpoints without widening or wrapping",async()=>{
  const item=await acquire("pub fn z0(value:i8)->i8",'z0(-128) => -127\nz0(-1) => 0\nz0(0) => 1\nz0(126) => 127'),root=await mkdtemp(path.join(tmpdir(),"scce-rust-i8-"));
  try{const program=await selected(item,root);await privateBinary(root,program,`mod module;fn main(){assert_eq!(module::z0(i8::MIN),-127);assert_eq!(module::z0(125),126);assert!(std::panic::catch_unwind(||module::z0(i8::MAX)).is_err());}`);}finally{await rm(root,{recursive:true,force:true});}
 });
 it("preserves source-declared f64 scalar emission and native execution",async()=>{
  const item=await acquire("pub fn z0(value:f64)->f64",'z0(1.25) => 2.5\nz0(-2.5) => -5\nz0(3.5) => 7\nz0(0.5) => 1'),root=await mkdtemp(path.join(tmpdir(),"scce-rust-f64-"));
  try{const program=await selected(item,root);await privateBinary(root,program,`mod module;fn main(){assert_eq!(module::z0(1.125),2.25);assert_eq!(module::z0(-0.125),-0.25);}`);}finally{await rm(root,{recursive:true,force:true});}
 });
 it.each([
  {signature:"pub fn z0(value:i8)->i8",examples:"z0(128) => 1",reason:"integer_range"},
  {signature:"pub fn z0(value:i8)->i8",examples:"z0(127) => 128",reason:"integer_range"},
  {signature:"pub fn z0(value:i64)->i64",examples:"z0(1.5) => 1",reason:"integer_literal"},
  {signature:"pub fn z0(value:i64)->i64",examples:"z0(9007199254740992) => 1",reason:"integer_literal"},
  {signature:"pub fn z0(value:u8)->u8",examples:"z0(-1) => 1",reason:"integer_range"},
  {signature:"pub fn z0(value:isize)->isize",examples:"z0(1) => 2",reason:"signature"},
  {signature:"pub fn z0(value:i32)->i64",examples:"z0(1) => 2",reason:"signature"}
 ])("withholds unsupported native integer contract $signature ($reason)",async({signature,examples,reason})=>{
  const item=await acquire(signature,examples),result=item.planner.emitIfAvailable(item.input);expect(result.availability).toMatchObject({status:"unavailable",reasonIds:[`program.emission.rust.${reason}_unsupported`]});expect(result.program).toBeUndefined();
 });
 it("rejects real-number division and out-of-range/unsupported integer IR instead of rounding or truncating",async()=>{
  const item=await acquire("pub fn z0(value:i64)->i64",addExamples),plan=item.planner.plan(item.input);
  for(const ir of [{kind:"binary",operator:"divide",left:{kind:"argument",index:0},right:{kind:"literal",value:2}},{kind:"literal",value:9007199254740992},{kind:"sequence",items:[]}] as ProgramExpression[]){
   const candidate={id:"renderer.typed-control",callableId:"z0",producedIr:ir};
   const typed={...plan,ownerBehaviorImplementationPhase:"selected" as const,ownerBehaviorTransformationCandidates:[candidate] as typeof plan.ownerBehaviorTransformationCandidates,selectedOwnerBehaviorTransformationIds:[candidate.id]};
   expect(()=>nativeRustProgram(typed,{sourcePath:"module.rs",testPath:"checks.rs"})).toThrow(/division|identity|support/u);
  }
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
