// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
import { describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { grammarSourceOwnedTestCases } from "../grammar-source-owned-test-contracts.js";
import { sourceOwnedTestContractProjections } from "../source-owned-test-contracts.js";
import { scalarSourceContractFixtures, statefulSourceContractFixtures } from "./fixtures/polyglot-source-contracts.js";
import { createClock, createHasher, createIdFactory, createProgramPlanner, sourceOwnedProgramBehaviorFromDocumentation,
  projectSourceOwnedProgramBehavior, codeRequestSignal, programIntentForTurn, COGNITIVE_OPERATOR_IDS, type SemanticEntailmentResult,
  createProgramGraphBuilder, replanOwnerBehaviorProgramIntent, validateProgramGraphHydration } from "@scce/kernel";
import { NodeBuildTestAdapter } from "../process.js";
import { findCodeVerifierCapability } from "../code-verifier-discovery.js";
import type { ScceRuntimeConfig } from "../config.js";

const hash = (text: string) => `sha256:${createHash("sha256").update(text).digest("hex")}`;
const fixtures = [scalarSourceContractFixtures[1], statefulSourceContractFixtures[1], statefulSourceContractFixtures[2]];
async function acquired(item: { languageId: "go" | "rust"; sourcePath: string; files: Readonly<Record<string, string>> },requestedPath?:string) {
  const files = Object.entries(item.files).filter(([name]) => /\.(?:go|rs)$/u.test(name)).map(([name, text]) => ({
    path: name, text, languageId: item.languageId, sourceHash: hash(text), sourceVersionId: `source_version_${hash(text).slice(7)}` }));
  const cases = await grammarSourceOwnedTestCases(files), source = files.find(file => file.path === item.sourcePath)!;
  const patterns = [...sourceOwnedTestContractProjections(cases, "fixture://native-backends").values()].flat().map(patternJson => ({ patternJson }));
  const requestText = `Create the documented public module.${requestedPath?` ${requestedPath}`:""}`;
  const intent = { languageId: item.languageId, symbols: [], references: [{ sourceFamily: "fixture://native-backends", relativePath: source.path, sourceHash: source.sourceHash, score: 1 }], audit: null };
  const behavior = sourceOwnedProgramBehaviorFromDocumentation({ requestText, intent, patterns });
  const codeSignal = projectSourceOwnedProgramBehavior({ codeSignal: codeRequestSignal(requestText), intent, sourceBehavior: behavior });
  const programIntent = programIntentForTurn({ requestedAuthority: "program", activeOperatorIds: [COGNITIVE_OPERATOR_IDS.programPlanning], codeSignal, evidence: [] })!;
  const hasher = createHasher(), clock = createClock({ fixedTime: 1 }), ids = createIdFactory({ clock, hasher, deterministicReplay: true });
  return { cases, behavior, programIntent, hasher, ids, input: { episodeId: ids.episodeId(), requestText, evidence: [], programIntent, entailment: emptyEntailment(ids) } };
}

const nullableFixtures = [
 { languageId: "go", sourcePath: "provider.go", files: {
  "provider.go": `package opaque
var values=map[string]any{}
func f0(key string,value any) { values[key]=value }
func f1(key string)*any { value,present:=values[key]; if !present { return nil }; return &value }
func f2(key string) { delete(values,key) }
`,
  "provider_test.go": `package opaque
import "testing"
func TestSequence(t *testing.T) {
 if f1("a")!=nil {t.Fatal("case")}
 f0("a",nil)
 if *f1("a")!=nil {t.Fatal("case")}
 f0("a",111)
 if *f1("a")!=111 {t.Fatal("case")}
 f0("a",222)
 if *f1("a")!=222 {t.Fatal("case")}
 f2("a")
 if f1("a")!=nil {t.Fatal("case")}
 f0("a",333)
 if *f1("a")!=333 {t.Fatal("case")}
}
` } },
 { languageId: "rust", sourcePath: "lib.rs", files: {
  "lib.rs": `use std::sync::{Mutex,OnceLock};
use std::collections::HashMap;
static VALUES:OnceLock<Mutex<HashMap<String,Option<i64>>>>=OnceLock::new();
pub fn f0(key:&str,value:Option<i64>) { VALUES.get_or_init(||Mutex::new(HashMap::new())).lock().unwrap().insert(key.to_owned(),value); }
pub fn f1(key:&str)->Option<Option<i64>> { VALUES.get_or_init(||Mutex::new(HashMap::new())).lock().unwrap().get(key).cloned() }
pub fn f2(key:&str) { VALUES.get_or_init(||Mutex::new(HashMap::new())).lock().unwrap().remove(key); }
#[cfg(test)] mod checks {
 use super::f0; use super::f1; use super::f2;
 #[test] fn sequence() {
  assert_eq!(f1("a"),::std::option::Option::None);
  f0("a",::std::option::Option::None);
  assert_eq!(f1("a"),::std::option::Option::Some(::std::option::Option::None));
  f0("a",::std::option::Option::Some(111));
  assert_eq!(f1("a"),::std::option::Option::Some(::std::option::Option::Some(111)));
  f0("a",::std::option::Option::Some(222));
  assert_eq!(f1("a"),::std::option::Option::Some(::std::option::Option::Some(222)));
  f2("a");
  assert_eq!(f1("a"),::std::option::Option::None);
  f0("a",::std::option::Option::Some(333));
  assert_eq!(f1("a"),::std::option::Option::Some(::std::option::Option::Some(333)));
 }
}
` } }
] as const;

describe("native Go and Rust stateful ProgramGraph emission", () => {
  it.each(fixtures)("admits $languageId owned native signatures in the existing ProgramGraph emitter", async item => {
    const source = await acquired(item);
    const emitted = createProgramPlanner({ idFactory: source.ids, hasher: source.hasher }).emitIfAvailable(source.input);
    expect(emitted.availability).toEqual({ status: "available", languageId: item.languageId, reasonIds: [] });
    expect(emitted.program?.language).toBe(item.languageId);
    expect(emitted.program?.files.some(file => /\.(?:mjs|js|ts)$/u.test(file.path))).toBe(false);
  });

  it.each([scalarSourceContractFixtures[1], statefulSourceContractFixtures[1]])("executes Go owned ABI through real native failure, retry, public types and private values", async item => {
    const source = await acquired(item), root = await mkdtemp(path.join(tmpdir(), "scce-private-native-go-"));
    try {
      const builder = createProgramGraphBuilder({ idFactory: source.ids, hasher: source.hasher });
      const build = (programIntent: typeof source.programIntent) => builder.build({ episodeId: source.ids.episodeId(), text: source.input.requestText,
        createdAt: 1, evidence: [], entailment: source.input.entailment, programIntent });
      const probe = build(source.programIntent), native = new NodeBuildTestAdapter({ runtime: { tempRoot: root } } as ScceRuntimeConfig);
      expect(validateProgramGraphHydration(probe.program!)).toEqual({ valid: true, diagnostics: [] });
      const failed = await native.executeProgram({ episodeId: probe.episodeId, construct: probe });
      expect(failed.build.code, failed.build.stderr).toBe(0);
      expect(failed.passed).toBe(false); expect(failed.test.code).not.toBe(0);
      const retry = replanOwnerBehaviorProgramIntent({ intent: source.programIntent, program: probe.program!, hasher: source.hasher,
        failure: { observationId: "native-go-probe-failure", programId: probe.program!.id,
          planHash: source.hasher.digestHex(JSON.stringify(probe.program!.files)), validatorId: "validator.actual-go", checkId: "tests", status: "failed",
          ownerRequirementIds: [...source.behavior.behaviorRequirements, ...source.behavior.statefulBehaviorRequirements].map(row => row.id), command: probe.program!.test } });
      const selected = build(retry.intent), passed = await native.executeProgram({ episodeId: selected.episodeId, construct: selected });
      expect(selected.program!.language).toBe("go"); expect(passed.passed, `${passed.build.stderr}\n${passed.test.stderr}`).toBe(true);
      expect(passed.testExecutionReceipt?.status).toBe("executed");
      const privateRoot = path.join(root, "sealed");
      for (const artifact of passed.artifacts) { const target = path.join(privateRoot, artifact.path); await mkdir(path.dirname(target), { recursive: true }); await writeFile(target, artifact.content); }
      const stateful = source.behavior.statefulBehaviorRequirements.length > 0;
      const tests = stateful ? `var _ func(string,int)=f0
var _ func(string)int=f1
func TestPrivateState(t *testing.T) { f0("sealed-key",993); if f1("sealed-key")!=993 {t.Fatal("free ABI")}; p,q:=CreateStatefulProgram(),CreateStatefulProgram(); p.f0("x",994); p.f0("y",995); p.f0("x",996); if p.f1("x")!=996||p.f1("y")!=995||q.f1("x")!=0 {t.Fatal("overwrite or instance isolation")} }
func TestKeyedIR(t *testing.T) { p:=CreateStatefulProgram(); first:=map[string]any{"🪶":[]any{1,"__proto__"},"n":nil}; second:=map[string]any{"n":nil,"🪶":[]any{float64(1),"__proto__"}}; p._invoke("f0",[]any{first,nil}); got:=p._invoke("f1",[]any{second}); if !got.Present||!got.Defined||got.Value!=nil {t.Fatal("present null/object key")}; if p._invoke("f1",[]any{"missing"}).Present {t.Fatal("missing")}; p._invoke("f0",[]any{1,"value"}); if p._invoke("f1",[]any{float64(1)}).Value!="value" {t.Fatal("numeric key")}; p._invoke("f0",[]any{math.Copysign(0,-1),"zero"}); if p._invoke("f1",[]any{0}).Value!="zero" {t.Fatal("negative zero key")} }`
        : `var _ func(int)int=f0
func TestPrivateScalar(t *testing.T) { if f0(17)!=18||f0(-7)!=-6 {t.Fatal("unseen scalar")}; wide:=int(9007199254740993); if f0(wide)!=9007199254740994 {t.Fatal("integer precision")}; max:=int(^uint(0)>>1); if f0(max)!=-max-1 {t.Fatal("native integer overflow semantics")} }`;
      await writeFile(path.join(privateRoot, "src", "sealed_test.go"), `package opaque\nimport ("testing"${stateful ? ';"math"' : ""})\n${tests}\n`);
      const capability = await findCodeVerifierCapability("go"); expect(capability.status).toBe("available");
      if (capability.status !== "available") throw new Error(capability.reason);
      await promisify(execFile)(capability.verifier.command, ["test", "./src"], { cwd: privateRoot, timeout: 60000 });
      expect(JSON.stringify(source.cases)).not.toContain("sealed-key");
      expect(JSON.stringify(source.cases)).not.toContain("9007199254740993");
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it.each([{item:scalarSourceContractFixtures[1],target:"lib/opaque.go"},{item:statefulSourceContractFixtures[2],target:"lib/opaque.rs"}])("executes native output at the requested $target with the same verifier and retry",async({item,target})=>{
    const source=await acquired(item,target),root=await mkdtemp(path.join(tmpdir(),"scce-native-requested-path-"));
    try{
      expect(source.programIntent.entrypointPath).toBe(target);
      const builder=createProgramGraphBuilder({idFactory:source.ids,hasher:source.hasher});
      const build=(programIntent:typeof source.programIntent)=>builder.build({episodeId:source.ids.episodeId(),text:source.input.requestText,createdAt:1,evidence:[],entailment:source.input.entailment,programIntent});
      const probe=build(source.programIntent),native=new NodeBuildTestAdapter({runtime:{tempRoot:root}} as ScceRuntimeConfig);
      expect(probe.program!.entrypoint).toBe(target);
      expect(validateProgramGraphHydration(probe.program!)).toEqual({valid:true,diagnostics:[]});
      const failed=await native.executeProgram({episodeId:probe.episodeId,construct:probe});
      expect(failed.build.code,failed.build.stderr).toBe(0);expect(failed.passed).toBe(false);
      const retry=replanOwnerBehaviorProgramIntent({intent:source.programIntent,program:probe.program!,hasher:source.hasher,
       failure:{observationId:"native-requested-path-failure",programId:probe.program!.id,planHash:source.hasher.digestHex(JSON.stringify(probe.program!.files)),validatorId:"validator.actual-native",checkId:"tests",status:"failed",
        ownerRequirementIds:[...source.behavior.behaviorRequirements,...source.behavior.statefulBehaviorRequirements].map(row=>row.id),command:probe.program!.test}});
      const selected=build(retry.intent),passed=await native.executeProgram({episodeId:selected.episodeId,construct:selected});
      expect(selected.program!.files.some(file=>file.path===target&&file.content.length>0)).toBe(true);
      expect(passed.passed,`${passed.build.stderr}\n${passed.test.stderr}`).toBe(true);
    }finally{await rm(root,{recursive:true,force:true});}
  });

  it("does not substitute f64 wrappers for a source-declared Rust integer ABI",async()=>{
    const original=scalarSourceContractFixtures[2];
    const item={...original,files:{"lib.rs":original.files["lib.rs"].replaceAll("f64","i64").replace(/([0-9]+)\.0/gu,"$1")}};
    const source=await acquired(item);
    const emitted=createProgramPlanner({idFactory:source.ids,hasher:source.hasher}).emitIfAvailable(source.input);
    expect(emitted.availability).toEqual({status:"unavailable",languageId:"rust",reasonIds:["program.emission.rust.signature_unsupported"]});
    expect(emitted.program).toBeUndefined();
  });

  it("retains source-observed Rust negative-zero float tags across persisted contracts",async()=>{
    const original=statefulSourceContractFixtures[2];
    const item={...original,files:{"lib.rs":original.files["lib.rs"].replaceAll("i64","f64").replaceAll("111","-0.0").replaceAll("222","1.0")}};
    const source=await acquired(item);
    expect(source.behavior.statefulBehaviorRequirements[0]!.sourceContract!.nativeExpected).toMatchObject({kind:"value",nativeNumberKind:"float",nativeNegativeZero:true});
    expect(source.behavior.statefulBehaviorRequirements[0]!.sourceContract!.invocations[0]!.nativeArguments?.[1]).toMatchObject({kind:"value",nativeNegativeZero:true});
    const emitted=createProgramPlanner({idFactory:source.ids,hasher:source.hasher}).emitIfAvailable(source.input);
    expect(emitted.availability.status).toBe("available");
    expect(emitted.program!.files.find(file=>file.role==="test")!.content).toContain("let value: f64 = -0.0;");
  });

  it.each(nullableFixtures)("preserves $languageId missing, present null, overwrite and deletion through acquired native traces", async item => {
    const source=await acquired(item), root=await mkdtemp(path.join(tmpdir(),"scce-private-native-nullable-"));
    try {
      expect(source.cases).toHaveLength(6);
      const builder=createProgramGraphBuilder({idFactory:source.ids,hasher:source.hasher});
      const build=(programIntent:typeof source.programIntent)=>builder.build({episodeId:source.ids.episodeId(),text:source.input.requestText,
        createdAt:1,evidence:[],entailment:source.input.entailment,programIntent});
      const probe=build(source.programIntent), native=new NodeBuildTestAdapter({runtime:{tempRoot:root}} as ScceRuntimeConfig);
      const failed=await native.executeProgram({episodeId:probe.episodeId,construct:probe});
      expect(failed.build.code,failed.build.stderr).toBe(0); expect(failed.passed).toBe(false);
      const retry=replanOwnerBehaviorProgramIntent({intent:source.programIntent,program:probe.program!,hasher:source.hasher,
        failure:{observationId:"native-nullable-failure",programId:probe.program!.id,planHash:source.hasher.digestHex(JSON.stringify(probe.program!.files)),
          validatorId:"validator.actual-native",checkId:"tests",status:"failed",ownerRequirementIds:source.behavior.statefulBehaviorRequirements.map(row=>row.id),command:probe.program!.test}});
      const selected=build(retry.intent),passed=await native.executeProgram({episodeId:selected.episodeId,construct:selected});
      expect(passed.passed,`${passed.build.stderr}\n${passed.test.stderr}\n${passed.test.stdout}`).toBe(true);
      expect(passed.testExecutionReceipt?.status).toBe("executed");
      const sealed=path.join(root,"sealed");
      for(const artifact of passed.artifacts){const target=path.join(sealed,artifact.path);await mkdir(path.dirname(target),{recursive:true});await writeFile(target,artifact.content);}
      const capability=await findCodeVerifierCapability(item.languageId);expect(capability.status).toBe("available");
      if(capability.status!=="available") throw new Error(capability.reason);
      if(item.languageId==="go"){
        await writeFile(path.join(sealed,"src/sealed_test.go"),`package opaque
import "testing"
var _ func(string,any)=f0
var _ func(string)*any=f1
var _ func(string)=f2
func TestSealedNullable(t *testing.T){ p,q:=CreateStatefulProgram(),CreateStatefulProgram();if p.f1("sealed")==nil {} else {t.Fatal("missing")};p.f0("sealed",nil);if p.f1("sealed")==nil||*p.f1("sealed")!=nil{t.Fatal("present null")};p.f0("sealed",float64(1));value:=*p.f1("sealed");if _,ok:=value.(float64);!ok{t.Fatal("numeric tag")};p.f2("sealed");if p.f1("sealed")!=nil{t.Fatal("delete")};q.f0("sealed",993);if p.f1("sealed")!=nil||*q.f1("sealed")!=993{t.Fatal("isolation")}}
`);
        await promisify(execFile)(capability.verifier.command,["test","./src"],{cwd:sealed,timeout:60000});
      }else{
        const validator=path.join(root,"sealed_nullable.rs"),executable=path.join(root,"sealed_nullable.exe");
        await writeFile(validator,`include!(${JSON.stringify(path.join(sealed,selected.program!.entrypoint).replaceAll("\\","/"))});
#[test] fn sealed_nullable(){let _:fn(&str,Option<i64>)=f0;let _:fn(&str)->Option<Option<i64>>=f1;let _:fn(&str)=f2;let(mut p,mut q)=(create_stateful_program(),create_stateful_program());assert_eq!(p.f1("sealed"),None);p.f0("sealed",None);assert_eq!(p.f1("sealed"),Some(None));p.f0("sealed",Some(i64::MAX));assert_eq!(p.f1("sealed"),Some(Some(i64::MAX)));p.f2("sealed");assert_eq!(p.f1("sealed"),None);q.f0("sealed",Some(993));assert_eq!(p.f1("sealed"),None);assert_eq!(q.f1("sealed"),Some(Some(993)));}
`);
        await promisify(execFile)(capability.verifier.command,["--edition","2021","--test",validator,"-o",executable],{timeout:60000});
        await promisify(execFile)(executable,[],{timeout:30000});
      }
      expect(JSON.stringify(source.cases)).not.toContain("sealed");
    } finally {await rm(root,{recursive:true,force:true});}
  });

  it("executes Rust state through real native failure and retry while retaining its public typed ABI", async () => {
    const source = await acquired(statefulSourceContractFixtures[2]), root = await mkdtemp(path.join(tmpdir(), "scce-private-native-rust-state-"));
    try {
      const builder = createProgramGraphBuilder({ idFactory: source.ids, hasher: source.hasher });
      const build = (programIntent: typeof source.programIntent) => builder.build({ episodeId: source.ids.episodeId(), text: source.input.requestText,
        createdAt: 1, evidence: [], entailment: source.input.entailment, programIntent });
      const probe = build(source.programIntent), native = new NodeBuildTestAdapter({ runtime: { tempRoot: root } } as ScceRuntimeConfig);
      expect(validateProgramGraphHydration(probe.program!)).toEqual({ valid: true, diagnostics: [] });
      const failed = await native.executeProgram({ episodeId: probe.episodeId, construct: probe });
      expect(failed.build.code, failed.build.stderr).toBe(0); expect(failed.passed).toBe(false); expect(failed.test.code).not.toBe(0);
      const retry = replanOwnerBehaviorProgramIntent({ intent: source.programIntent, program: probe.program!, hasher: source.hasher,
        failure: { observationId: "native-rust-state-probe-failure", programId: probe.program!.id,
          planHash: source.hasher.digestHex(JSON.stringify(probe.program!.files)), validatorId: "validator.actual-rust", checkId: "tests", status: "failed",
          ownerRequirementIds: source.behavior.statefulBehaviorRequirements.map(row => row.id), command: probe.program!.test } });
      const selected = build(retry.intent), passed = await native.executeProgram({ episodeId: selected.episodeId, construct: selected });
      expect(selected.program!.language).toBe("rust"); expect(passed.passed, `${passed.build.stderr}\n${passed.test.stderr}`).toBe(true);
      expect(passed.testExecutionReceipt?.status).toBe("executed");
      const privateRoot = path.join(root, "sealed");
      for (const artifact of passed.artifacts) { const target = path.join(privateRoot, artifact.path); await mkdir(path.dirname(target), { recursive: true }); await writeFile(target, artifact.content); }
      const sourcePath = path.join(privateRoot, selected.program!.entrypoint).replaceAll("\\", "/");
      const validator = path.join(root, "private_state.rs"), executable = path.join(root, "private_state.exe");
      await writeFile(validator, `include!(${JSON.stringify(sourcePath)});
#[test] fn private_public_abi() { let _:fn(&str,i64)=f0; let _:fn(&str)->i64=f1; f0("sealed-key",993); assert_eq!(f1("sealed-key"),993); let(mut p,mut q)=(create_stateful_program(),create_stateful_program()); p.f0("🪶",994); p.f0("__proto__",995); p.f0("🪶",996); assert_eq!(p.f1("🪶"),996); assert_eq!(p.f1("__proto__"),995); p.f0("wide",i64::MAX); assert_eq!(p.f1("wide"),i64::MAX); q.f0("🪶",997); assert_eq!(q.f1("🪶"),997); assert_eq!(p.f1("🪶"),996); }
#[test] fn private_keyed_ir() { let mut p=create_stateful_program(); let first=_NativeValue::Object([("🪶".to_owned(),_NativeValue::List(vec![_NativeValue::Signed(1),_NativeValue::Text("__proto__".to_owned())])),("n".to_owned(),_NativeValue::Null)].into_iter().collect()); let second=_NativeValue::Object([("n".to_owned(),_NativeValue::Null),("🪶".to_owned(),_NativeValue::List(vec![_NativeValue::Float(1.0),_NativeValue::Text("__proto__".to_owned())]))].into_iter().collect()); p._invoke("f0",vec![first,_NativeValue::Null]); let result=p._invoke("f1",vec![second]); assert!(result.present); assert_eq!(result.value,Some(_NativeValue::Null)); assert!(!p._invoke("f1",vec![_NativeValue::Text("missing".to_owned())]).present); p._invoke("f0",vec![_NativeValue::Signed(1),_NativeValue::Text("value".to_owned())]); assert_eq!(p._invoke("f1",vec![_NativeValue::Float(1.0)]).value,Some(_NativeValue::Text("value".to_owned()))); p._invoke("f0",vec![_NativeValue::Float(-0.0),_NativeValue::Float(-0.0)]); let result=p._invoke("f1",vec![_NativeValue::Signed(0)]); match result.value {Some(_NativeValue::Float(value))=>assert_eq!(value.to_bits(),(-0.0f64).to_bits()),_=>panic!("stored native float representation changed")}; }
`);
      const capability = await findCodeVerifierCapability("rust"); expect(capability.status).toBe("available");
      if (capability.status !== "available") throw new Error(capability.reason);
      await promisify(execFile)(capability.verifier.command, ["--edition", "2021", "--test", validator, "-o", executable], { timeout: 60000 });
      await promisify(execFile)(executable, [], { timeout: 30000 });
      expect(JSON.stringify(source.cases)).not.toContain("sealed-key");
    } finally { await rm(root, { recursive: true, force: true }); }
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
