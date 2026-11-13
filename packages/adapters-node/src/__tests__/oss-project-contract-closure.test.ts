// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { createClock,sourceOwnedProgramBehaviorFromDocumentation,searchProgramTransformations,evaluateProgramExpression,type JsonValue, type EvidenceSpan, type SourceVersion, type IngestionCheckpoint } from "@scce/kernel";
import { storageFixtureForEvaluation } from "../../../kernel/src/__tests__/evidence-promotion-evaluation-fixture.js";
import { createCapabilityTestKernel } from "../../../kernel/src/__tests__/fixtures/capability-runtime.js";
import { trainOssCorpus, ingestMaterialSnapshot } from "../oss-corpus.js";
import { inspectEngineeringCorpusFolder } from "../engineering-corpus-folder.js";
import { collectTypeScriptContractClosure, type ContractClosureBudget } from "../typescript-contract-closure.js";
import * as kernel from "@scce/kernel";
import { NodeBuildTestAdapter } from "../process.js";
import type { ScceRuntimeConfig } from "../config.js";
import { createApprovalSession } from "../approval-session.js";

const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
const entries: Record<string, string> = {
  "00-base.json": JSON.stringify({ compilerOptions: { strict: true, target: "ES2022", module: "NodeNext", moduleResolution: "NodeNext", baseUrl: ".", paths: { "@owned/*": ["src/*"] } } }),
  "package.json": JSON.stringify({ name: "owned-public-fixture", type: "module" }),
  "tsconfig.json": JSON.stringify({ extends: "./00-base.json", compilerOptions: { noEmit: true }, include: ["src/**/*.ts", "spec/**/*.ts", "types/**/*.ts"] }),
  "src/index.ts": "export { measured as f0 } from './value.js';\n",
  "src/value.ts": "import type {Scalar} from '../types/value.js'; export function measured(value:Scalar):Scalar {return value*value+value;}\n",
  "types/value.d.ts": "export type Scalar=number;\n",
  "spec/first.spec.ts": "import {test,expect} from 'vitest';import {f0 as observed} from '@owned/index.js';test('first',()=>{expect(observed(2)).toBe(6);expect(observed(4)).toBe(20);});\n",
  "spec/second.spec.ts": "import {it,expect} from 'vitest';import {f0 as observed} from '@owned/index.js';it('second',()=>{expect(observed(1)).toBe(2);expect(observed(5)).toBe(30);});\n"
};
async function fixture(files = entries) {
  const root = await mkdtemp(path.join(tmpdir(), "scce-oss-project-closure-")); roots.push(root);
  for (const [name, text] of Object.entries(files)) { const file = path.join(root, name); await mkdir(path.dirname(file), { recursive: true }); await writeFile(file, text); }
  const clock = createClock({ fixedTime: 100, stepMs: 1 }), evidence: EvidenceSpan[] = [], versions = new Map<string, SourceVersion>(), checkpoints = new Map<string, IngestionCheckpoint>(), blobs = new Map<string, Uint8Array>();
  const recorded = storageFixtureForEvaluation({ evidence, clockNow: () => clock.now() }), storage = recorded.storage;
  storage.evidence.putSourceVersion = async row => { versions.set(String(row.sourceVersionId), structuredClone(row)); };
  storage.evidence.sourceVersionById = async id => versions.get(String(id)) ?? null;
  storage.evidence.putEvidenceSpan = async row => { const at = evidence.findIndex(span => span.id === row.id); if (at < 0) evidence.push(row); else evidence[at] = row; };
  storage.evidence.sourceVersionsForEvidence = async ids => [...new Set(evidence.filter(span => ids.includes(span.id)).map(span => String(span.sourceVersionId)))].map(id => versions.get(id)!);
  storage.evidence.searchEvidence = async query => evidence.filter(span => (!query.sourceVersionId || span.sourceVersionId === query.sourceVersionId) && (!query.status || span.status === query.status)).slice(0, query.limit).map(span => ({ span, score: 1, reason: "owned fixture" }));
  storage.blobs.put = async bytes => { const hash = `sha256_${createHash("sha256").update(bytes).digest("hex")}`; blobs.set(hash, new Uint8Array(bytes)); return hash as never; };
  storage.blobs.get = async hash => { const bytes = blobs.get(hash); if (!bytes) throw new Error("canonical blob absent"); return bytes; };
  storage.ingestion = { get: async id => checkpoints.get(id) ?? null, put: async row => { checkpoints.set(row.id, structuredClone(row)); }, list: async () => [...checkpoints.values()] };
  const options = { storage, rootPath: root, includeDocs: false, maxFiles: 100, maxFilesPerRun: 1, ngramMaxOrder: 2, ngramMaxCountersPerOrder: 16, ngramVocabularyLimit: 128 };
  return { root, files, storage, versions, evidence, checkpoints, blobs, options, events:recorded.events };
}

it("composes two formally requested source-owned structural operations in an ordinary native kernel turn", async () => {
  const f=await fixture({
    "package.json":JSON.stringify({name:"public-structural-operations",type:"module"}),
    "tsconfig.json":JSON.stringify({compilerOptions:{allowJs:true,noEmit:true,target:"ES2022",module:"NodeNext",moduleResolution:"NodeNext"},include:["src/**/*.js","spec/**/*.js"]}),
    "src/a.js":"export function f0(value){return value.filter(item=>item);}\n",
    "src/b.js":"export function f1(value){return value.rows.map(row=>({name:row.profile.label}));}\n",
    "src/c.js":"export function value(x){return x+1;}\n",
    "spec/a.spec.js":"import {test} from 'node:test';import {deepStrictEqual} from 'node:assert';import {f0} from '../src/a.js';test('sequence',()=>{deepStrictEqual(f0([false,true]),[true]);deepStrictEqual(f0([true,false,true]),[true,true]);deepStrictEqual(f0([false,true,false]),[true]);});\n",
    "spec/b.spec.js":"import {it,expect} from 'vitest';import {f1} from '../src/b.js';it('projection',()=>{expect(f1({rows:[{profile:{label:'A'}},{profile:{label:'B'}}]})).toStrictEqual([{name:'A'},{name:'B'}]);expect(f1({rows:[{profile:{label:'C'}}]})).toStrictEqual([{name:'C'}]);expect(f1({rows:[{profile:{label:'D'}},{profile:{label:'E'}},{profile:{label:'F'}}]})).toStrictEqual([{name:'D'},{name:'E'},{name:'F'}]);});\n",
    "spec/c.spec.js":"import {it,expect} from 'vitest';import {value} from '../src/c.js';it('unselected',()=>{expect(value(2)).toBe(3);expect(value(4)).toBe(5);});\n"
  });
  const trained=await trainOssCorpus({...f.options,includeDocs:true,maxFilesPerRun:100});
  expect(trained.filesSkipped).toEqual([]);expect(trained.sourceContractClosure?.complete).toBe(true);
  const patterns=await f.storage.languageMemory.listLanguagePatterns({patternKind:"source_code_assertion_contract"});expect(patterns).toHaveLength(3);
  const text="JavaScript function f0(value); function f1(value).";
  const docs=f.evidence.filter(span=>(span.provenance as {sourceSystem?:string}).sourceSystem==="oss_docs");
  const intent=kernel.codeIntentFromDocumentation({requestText:text,documentation:docs,languageId:"javascript"});
  const declaredCallableIds=kernel.codeRequestSignal(text).declaredCallableIds;
  const selected=()=>kernel.sourceOwnedProgramBehaviorFromDocumentation({requestText:text,intent,patterns,declaredCallableIds});
  expect(declaredCallableIds).toEqual(["f0","f1"]);
  for(const damage of ["scope","config","duplicate","unbound","foreign","stale"]){
    const changed=structuredClone(patterns),body=changed[1]!.patternJson as Record<string,JsonValue>,closure=body.sourceContractClosure as Record<string,JsonValue>;
    if(damage==="scope")closure.scopeIdentity="f".repeat(64);
    if(damage==="config")closure.configHash="e".repeat(64);
    if(damage==="duplicate")body.targetName="f0";
    if(damage==="foreign")body.repositoryFamily="scce://foreign-repository";
    if(damage==="stale")body.sourceHash="c".repeat(64);
    expect(kernel.sourceOwnedProgramBehaviorFromDocumentation({requestText:text,intent,patterns:changed,declaredCallableIds:damage==="unbound"?[]:declaredCallableIds}).behaviorRequirements,damage).toEqual([]);
  }
  expect(kernel.sourceOwnedProgramBehaviorFromDocumentation({requestText:text,intent,patterns:[patterns[0]!],declaredCallableIds:["unimplemented"]}).behaviorRequirements.some(row=>row.callableId==="unimplemented")).toBe(false);
  const clock=kernel.createClock({fixedTime:99000,stepMs:1});
  f.storage.model.readModel=async()=>({languageProfiles:await f.storage.model.listLanguageProfiles({limit:100}),latentConcepts:[],learnedProgramPatterns:[],learningGoals:[],trainingSteps:1});
  const native=new NodeBuildTestAdapter({runtime:{tempRoot:f.root}} as ScceRuntimeConfig),executions:Array<Awaited<ReturnType<NodeBuildTestAdapter["executeProgram"]>>>=[];
  const runtimeStorage:kernel.ScceStorage={...f.storage,userModelClaims:{putClaim:async()=>undefined,listClaims:async()=>[]},
    taskResumption:{putSnapshot:async()=>undefined,getLatestSnapshot:async()=>null},
    documentGeneration:{putSession:async()=>undefined,getSession:async()=>null,compareAndPutSession:async()=>({stored:true,currentUpdatedAt:null})}};
  const approvals=createApprovalSession();
  const runtime=createCapabilityTestKernel({storage:runtimeStorage,clock,idFactory:kernel.createIdFactory({clock,hasher:kernel.createHasher(),deterministicReplay:true}),deterministicReplay:true,
    approvals,functionalCognitionAuthorizeCapabilities:true,policy:{allowMutation:false,dryRunByDefault:true,requireTwoPhaseCommit:true},
    files:{streamPath:async function*(){}},buildTest:{executeProgram:async input=>{const result=await native.executeProgram(input);executions.push(result);return result;}}});
  let turn=await runtime.turn({text,requestedAuthority:"program"});
  for(let round=0;round<3&&!turn.buildTest?.passed;round++){
    const pending=approvals.snapshot().pending;expect(pending.length).toBeGreaterThan(0);
    expect(turn.constructGraph.program).toBeDefined();
    for(const plan of pending){
      expect(plan.capabilityId).toBe("process.build_test");
      const descriptor=plan.input as {schema:string;provider:kernel.JsonValue;workingDirectory:string;build:kernel.JsonValue;test:kernel.JsonValue;ownerRequirementIds:string[];files:Array<{path:string;hash:string;byteLength:number}>};
      const prior=kernel.programValidationApprovalInput(turn.constructGraph.program!) as typeof descriptor;
      expect(descriptor).toMatchObject({schema:prior.schema,provider:prior.provider,workingDirectory:prior.workingDirectory,build:prior.build,test:prior.test,ownerRequirementIds:prior.ownerRequirementIds});
      expect(descriptor.files.map(file=>file.path)).toEqual(prior.files.map(file=>file.path));
      expect(descriptor.files.every(file=>/^sha256_[a-f0-9]{64}$/u.test(file.hash)&&Number.isSafeInteger(file.byteLength)&&file.byteLength>0)).toBe(true);
      approvals.approve(plan.planId);
      const changed=structuredClone(plan.input) as typeof descriptor;changed.files[0]!.hash=`sha256_${"0".repeat(64)}`;
      expect(approvals.isApproved({capabilityId:plan.capabilityId,input:changed})).toBe(false);
    }
    expect(approvals.snapshot().operatorGrant).toBe(false);
    turn=await runtime.turn({text,requestedAuthority:"program"});
  }
  expect(turn.constructGraph.program,JSON.stringify({answer:turn.answer,buildPassed:turn.buildTest?.passed})).toBeDefined();
  expect(selected().behaviorRequirements).toHaveLength(6);
  expect(selected().behaviorRequirements.filter(row=>row.verificationRole==="held_out")).toHaveLength(2);
  expect(executions.length).toBeGreaterThanOrEqual(2);expect(executions[0]!.passed).toBe(false);expect(executions.at(-1)!.passed).toBe(true);
  const program=turn.constructGraph.program!;
  expect(program.nodes.filter(node=>node.kind==="owner_behavior_requirement")).toHaveLength(6);
  expect(program.nodes.filter(node=>node.kind==="program.module").length).toBeGreaterThanOrEqual(3);
  const reserved=await mkdtemp(path.join(tmpdir(),"scce-unseen-structural-"));roots.push(reserved);
  for(const file of program.files){const target=path.join(reserved,file.path);await mkdir(path.dirname(target),{recursive:true});await writeFile(target,file.content);}
  const unseen=path.join(reserved,"independent.test.mjs");
  await writeFile(unseen,`import assert from 'node:assert/strict';import {f0,f1} from './${program.entrypoint}';assert.deepEqual(f0([true,false,false,true,true,false]),[true,true,true]);assert.deepEqual(f0([]),[]);assert.deepEqual(f1({rows:[{profile:{label:'雪'}},{profile:{label:'e\\u0301'}},{profile:{label:'__proto__'}}]}),[{name:'雪'},{name:'e\\u0301'},{name:'__proto__'}]);`);
  expect(()=>execFileSync(process.execPath,[unseen],{cwd:reserved,stdio:"pipe",timeout:30000})).not.toThrow();
},60000);

it("crosses one-file ingestion windows with original bytes, extends, aliases, reexports and type declarations without clobbering roots", async () => {
  const f = await fixture(); let cursor = 0, snapshotHash: string | undefined, last: Awaited<ReturnType<typeof trainOssCorpus>> | undefined;
  for (let index = 0; index < Object.keys(entries).length; index++) {
    const report = await trainOssCorpus({ ...f.options, startFileIndex: cursor, ...(snapshotHash ? { expectedSnapshotHash: snapshotHash } : {}) });
    cursor = report.nextFileIndex; snapshotHash = report.snapshotHash; last = report;
  }
  const patterns = await f.storage.languageMemory.listLanguagePatterns({ patternKind: "source_code_assertion_contract" });
  expect(patterns, JSON.stringify({closure:last?.sourceContractClosure,versions:[...f.versions.values()].map(row=>({id:row.sourceVersionId,namespace:row.namespace,uri:row.canonicalUri,role:row.role}))})).toHaveLength(2);
  expect(patterns.map(pattern => (pattern.patternJson as {cases:Array<{expectedResult:number}>}).cases.map(row => row.expectedResult)).sort()).toEqual([[2, 30], [6, 20]]);
  expect(patterns.every(pattern => (pattern.patternJson as {sourcePath:string}).sourcePath === "src/value.ts")).toBe(true);
  const body=patterns[0]!.patternJson as {repositoryFamily:string;sourceHash:string};
  const behavior=(rows:readonly {patternJson:JsonValue}[])=>sourceOwnedProgramBehaviorFromDocumentation({requestText:"TypeScript measured",ownerCallableIds:["measured"],intent:{languageId:"typescript",symbols:[],references:[{sourceFamily:body.repositoryFamily,relativePath:"src/value.ts",sourceHash:body.sourceHash,score:1}],audit:null},patterns:rows});
  const joined=behavior(patterns);
  expect(joined.behaviorRequirements).toHaveLength(4);
  expect(joined.behaviorRequirements.map(row=>row.expectedResult)).toEqual([6,20,2,30]);
  expect(joined.behaviorRequirements.every(row=>row.sourceContract?.projectClosure?.scopeIdentity)).toBe(true);
  const selected=searchProgramTransformations(joined.behaviorRequirements).selected;
  expect(selected).toHaveLength(1);expect(evaluateProgramExpression(selected[0]!.producedIr,[-7])).toBe(42);
  expect(behavior([...patterns,patterns[0]!])).toEqual({behaviorRequirements:[],statefulBehaviorRequirements:[]});
  for(const damage of ["root","version","scope","config"]){
    const changed=structuredClone(patterns),second=changed[1]!.patternJson as {sourceContractClosure:Record<string,JsonValue>;cases:Array<Record<string,JsonValue>>};
    if(damage==="root")second.sourceContractClosure.testSourceId="foreign";
    if(damage==="version")second.cases[0]!.testSourceVersionId="foreign";
    if(damage==="scope")second.sourceContractClosure.scopeIdentity="a".repeat(64);
    if(damage==="config")second.sourceContractClosure.configHash="b".repeat(64);
    expect(behavior(changed),damage).toEqual({behaviorRequirements:[],statefulBehaviorRequirements:[]});
  }
  const sourceWrites = vi.spyOn(f.storage.evidence, "putSourceVersion"), modelWrites = vi.spyOn(f.storage.languageMemory, "putNgramModel"), publications = vi.spyOn(f.storage.languageMemory, "replaceLanguagePatternProjection");
  const final = await trainOssCorpus({ ...f.options, startFileIndex: cursor, expectedSnapshotHash: snapshotHash });
  expect(final.sourceContractClosure).toMatchObject({ complete: true, nextCandidateIndex: 0 });
  expect(sourceWrites).not.toHaveBeenCalled(); expect(modelWrites).not.toHaveBeenCalled(); expect(publications).not.toHaveBeenCalled();
  expect(final.sourceContractClosure!.filesLoaded).toBeLessThanOrEqual(127); expect(final.sourceContractClosure!.bytesLoaded).toBeLessThanOrEqual(8 * 1024 * 1024);
});

it("acquires an encountered test's pinned project context before the linear cursor reaches its dependencies", async () => {
  const files = {
    ...entries,
    "src/index.ts": "export {add,divide} from './value.js';\n",
    "src/value.ts": "import type {Scalar} from '../types/value.js';export function add(a:Scalar,b:Scalar):Scalar{return a+b;}export function divide(a:Scalar,b:Scalar):Scalar{return a/b;}\n",
    "spec/first.spec.ts": "import {test,expect} from 'vitest';import {add,divide} from '@owned/index.js';test('arithmetic',()=>{expect(add(10,5)).toBe(15);expect(add(3,7)).toBe(10);expect(add(10,-5)).toBe(5);expect(add(6,-1)).toBe(5);expect(divide(12,3)).toBe(4);expect(divide(20,4)).toBe(5);expect(divide(30,6)).toBe(5);expect(divide(15,5)).toBe(3);});\n",
    "spec/second.spec.ts": "export const untouched = 1;\n"
  };
  for (let index = 0; index < 32; index++) Object.assign(files, { [`a/${String(index).padStart(2, "0")}.ts`]: `export const value=${index};\n` });
  const f = await fixture(files);
  const inspection = await inspectEngineeringCorpusFolder(f.root, { maxFiles: 100, maxFileBytes: 1_000_000, includeUnsupported: false });
  const inventory = inspection.files.filter(file => file.importable);
  const startFileIndex = inventory.findIndex(file => file.path === "spec/first.spec.ts");
  const report = await trainOssCorpus({ ...f.options, startFileIndex, expectedSnapshotHash: ingestMaterialSnapshot(inventory).snapshotHash });
  expect(report.nextFileIndex).toBe(startFileIndex + 1);
  expect(report.filesConsidered).toBe(1);
  expect(report.filesTotal).toBe(inventory.length);
  expect(report.trainingComplete).toBe(false);
  expect(report.contextAcquisition?.roots).toEqual([{ path: "spec/first.spec.ts", status: "acquired", reasons: [],
    dependencyPaths: ["00-base.json", "package.json", "src/index.ts", "src/value.ts", "tsconfig.json", "types/value.d.ts"] }]);
  expect(report.contextAcquisition?.preacquiredPaths).toEqual(report.contextAcquisition?.roots[0]?.dependencyPaths);
  const patterns = await f.storage.languageMemory.listLanguagePatterns({ patternKind: "source_code_assertion_contract" });
  expect(patterns, JSON.stringify(report.sourceContractClosure)).toHaveLength(2);
  expect(report.sourceContractClosure?.roots.find(root => root.path === "spec/first.spec.ts")).toMatchObject({ status: "compiled", contracts: 2 });
  expect(report.sourceContractClosure?.nextCandidateIndex).toBe(31);
  expect(report.sourceContractClosure?.complete).toBe(false);
  expect([...f.versions.values()].some(owner => owner.canonicalUri.endsWith("#path=a%2F00.ts"))).toBe(false);
  for (const owner of f.versions.values()) {
    const name = decodeURIComponent(owner.canonicalUri.split("#path=")[1]!);
    expect(owner.contentHash).toBe(`sha256_${createHash("sha256").update(files[name as keyof typeof files]!).digest("hex")}`);
  }
  const body = patterns[0]!.patternJson as { repositoryFamily: string; sourceHash: string };
  const behavior = sourceOwnedProgramBehaviorFromDocumentation({ requestText: "TypeScript add divide", ownerCallableIds: ["add", "divide"],
    intent: { languageId: "typescript", symbols: [], references: [{ sourceFamily: body.repositoryFamily, relativePath: "src/value.ts", sourceHash: body.sourceHash, score: 1 }], audit: null }, patterns });
  expect(behavior.behaviorRequirements).toHaveLength(8);
  const selected = searchProgramTransformations(behavior.behaviorRequirements).selected;
  expect(selected).toHaveLength(2);
  expect(selected.map(row => evaluateProgramExpression(row.producedIr, [21, 7])).sort((a, b) => Number(a) - Number(b)), JSON.stringify(selected)).toEqual([3, 28]);
  const writes = vi.spyOn(f.storage.evidence, "putSourceVersion");
  const next = await trainOssCorpus({ ...f.options, startFileIndex: report.nextFileIndex, expectedSnapshotHash: report.snapshotHash });
  expect(next.nextFileIndex).toBe(report.nextFileIndex + 1);
  expect(writes).toHaveBeenCalled();
  expect((await f.storage.languageMemory.listLanguagePatterns({ patternKind: "source_code_assertion_contract" })).map(row => row.id).sort()).toEqual(patterns.map(row => row.id).sort());
  writes.mockClear();
  const alreadyAcquiredIndex = inventory.findIndex(file => file.path === "src/value.ts");
  const replay = await trainOssCorpus({ ...f.options, startFileIndex: alreadyAcquiredIndex, expectedSnapshotHash: report.snapshotHash });
  expect(replay.nextFileIndex).toBe(alreadyAcquiredIndex + 1);
  expect(writes).not.toHaveBeenCalled();
});

it("reports an unresolved dependency without promoting a partially collected context as owned", async () => {
  const f = await fixture({ ...entries, "src/value.ts": "import {missing} from '../absent.js';export function measured(value:number){return missing(value);}\n" });
  const inspection = await inspectEngineeringCorpusFolder(f.root, { maxFiles: 100, maxFileBytes: 1_000_000, includeUnsupported: false });
  const inventory = inspection.files.filter(file => file.importable);
  const startFileIndex = inventory.findIndex(file => file.path === "spec/first.spec.ts");
  const report = await trainOssCorpus({ ...f.options, startFileIndex, expectedSnapshotHash: ingestMaterialSnapshot(inventory).snapshotHash });
  expect(report.contextAcquisition?.preacquiredPaths).toEqual([]);
  const context = report.contextAcquisition?.roots[0];
  expect(context).toMatchObject({ path: "spec/first.spec.ts", status: "incomplete", dependencyPaths: [] });
  expect(context?.reasons).toContain("module_dependency_unavailable:src/value.ts:../absent.js");
  expect([...f.versions.values()].every(owner => owner.canonicalUri.endsWith("#path=spec%2Ffirst.spec.ts"))).toBe(true);
  expect(await f.storage.languageMemory.listLanguagePatterns({ patternKind: "source_code_assertion_contract" })).toEqual([]);
  expect(report.trainingComplete).toBe(false);
});

it("publishes the native smoke's mixed Node and Vitest roots through the same canonical closure", async () => {
  const f=await fixture({...entries,"spec/first.spec.ts":"import {test} from 'node:test';import {strictEqual} from 'node:assert';import {f0 as observed} from '@owned/index.js';test('first',()=>{strictEqual(observed(2),6);strictEqual(observed(4),20);});\n"});
  const report=await trainOssCorpus({...f.options,maxFilesPerRun:100});
  const patterns=await f.storage.languageMemory.listLanguagePatterns({patternKind:"source_code_assertion_contract"});
  expect(patterns,JSON.stringify(report.sourceContractClosure)).toHaveLength(2);
  expect(patterns.flatMap(row=>(row.patternJson as {cases:Array<{expectedResult:number}>}).cases.map(item=>item.expectedResult)).sort((a,b)=>a-b)).toEqual([2,6,20,30]);
});

it("enforces the shared decoded-byte ledger before loading dependencies and reports missing context", async () => {
  const known = Object.entries(entries).map(([name, text]) => ({ path: name, byteLength: Buffer.byteLength(text), contentHash: `sha256:${createHash("sha256").update(text).digest("hex")}` }));
  const root = await mkdtemp(path.join(tmpdir(), "scce-pure-closure-")); roots.push(root);
  const load = vi.fn(async (name: string) => ({ path: name, bytes: Buffer.from(entries[name]!), sourceHash: known.find(file => file.path === name)!.contentHash, sourceVersionId: `owner:${name}` }));
  const budget: ContractClosureBudget = { maxFiles: 127, maxFileBytes: 65536, maxTotalBytes: Buffer.byteLength(entries["spec/first.spec.ts"]!), files: new Map(), usedBytes: 0 };
  const result = await collectTypeScriptContractClosure({ root, testPath: "spec/first.spec.ts", inventory: known, budget, load });
  expect(result.complete).toBe(false); expect(result.reasons.some(reason => reason.startsWith("max_total_bytes:"))).toBe(true);
  expect(budget.usedBytes).toBeLessThanOrEqual(budget.maxTotalBytes); expect(load.mock.calls).toEqual([["spec/first.spec.ts"]]);
});

it("continues beyond the first 32 candidates and never calls a wrapped unavailable round complete", async () => {
  const files: Record<string,string> = {"tsconfig.json":JSON.stringify({compilerOptions:{target:"ES2022",module:"NodeNext",moduleResolution:"NodeNext",noEmit:true},include:["**/*.ts"]}),
    "value.ts":"export function f0(value:number):number{return value*value+value;}\n",
    "z/check.spec.ts":"import {test,expect} from 'vitest';import {f0} from '../value.js';test('late',()=>{expect(f0(2)).toBe(6);expect(f0(4)).toBe(20);});\n"};
  for(let index=0;index<32;index++) files[`a/${String(index).padStart(2,"0")}.ts`]=`export const value=${index};\n`;
  const f=await fixture(files), first=await trainOssCorpus({...f.options,maxFilesPerRun:100});
  expect(first.sourceContractClosure).toMatchObject({candidateCount:34,nextCandidateIndex:31,complete:false});
  expect(first.sourceContractClosure!.roots).toHaveLength(32);
  expect(await f.storage.languageMemory.listLanguagePatterns({patternKind:"source_code_assertion_contract"})).toHaveLength(1);
  const sourceWrite=vi.spyOn(f.storage.evidence,"putSourceVersion");
  const tail=await trainOssCorpus({...f.options,startFileIndex:first.nextFileIndex,expectedSnapshotHash:first.snapshotHash});
  expect(tail.sourceContractClosure).toMatchObject({nextCandidateIndex:0,complete:true});
  expect(await f.storage.languageMemory.listLanguagePatterns({patternKind:"source_code_assertion_contract"})).toHaveLength(1);
  expect(sourceWrite).not.toHaveBeenCalled();
  for(const span of f.evidence)if(f.versions.get(String(span.sourceVersionId))?.canonicalUri.endsWith("#path=value.ts"))span.status="quarantined";
  await trainOssCorpus({...f.options,startFileIndex:first.nextFileIndex,expectedSnapshotHash:first.snapshotHash});
  const unavailable=await trainOssCorpus({...f.options,startFileIndex:first.nextFileIndex,expectedSnapshotHash:first.snapshotHash});
  expect(unavailable.sourceContractClosure).toMatchObject({nextCandidateIndex:0,complete:false});
  expect(unavailable.sourceContractClosure!.incompleteInRound).toBeGreaterThan(0);
});

it("preserves referenced-project configuration and refuses absent declaration outputs", async()=>{
  const f=await fixture({
    "tsconfig.json":JSON.stringify({compilerOptions:{target:"ES2022",module:"NodeNext",moduleResolution:"NodeNext",noEmit:true},include:["spec/**/*.ts"],references:[{path:"./dep"}]}),
    "dep/tsconfig.json":JSON.stringify({compilerOptions:{composite:true,declaration:true,rootDir:".",outDir:"../generated"},files:["source.ts"]}),
    "dep/source.ts":"export function f0(value:number):number{return value+1;}\n",
    "spec/check.spec.ts":"import {test,expect} from 'vitest';import {f0} from '../dep/source.js';test('owned',()=>{expect(f0(1)).toBe(2);expect(f0(2)).toBe(3);});\n"
  });
  const report=await trainOssCorpus({...f.options,maxFilesPerRun:100});
  expect(report.sourceContractClosure).toMatchObject({complete:false});
  expect(report.sourceContractClosure!.roots.find(root=>root.path==="spec/check.spec.ts")).toMatchObject({status:"incomplete"});
  expect(report.sourceContractClosure!.roots.find(root=>root.path==="spec/check.spec.ts")!.reasons.some(reason=>reason.startsWith("compiler_diagnostic:"))).toBe(true);
  expect(await f.storage.languageMemory.listLanguagePatterns({patternKind:"source_code_assertion_contract"})).toEqual([]);
});

it.each(["bytes","acl","owner"])("refuses changed canonical %s context and withdraws the previously complete root without source retraining",async damage=>{
  const f=await fixture(), first=await trainOssCorpus({...f.options,maxFilesPerRun:100});
  expect(first.sourceContractClosure?.complete).toBe(true);
  const version=[...f.versions.values()].find(row=>row.role==="original"&&row.canonicalUri.endsWith("#path=types%2Fvalue.d.ts"))!;
  const originalBytes=f.blobs.get(version.contentHash)!;
  if(damage==="bytes")f.blobs.set(version.contentHash,Buffer.from(Buffer.from(originalBytes).toString("utf8").replace("number","string")));
  if(damage==="acl")f.versions.set(String(version.sourceVersionId),{...version,informationLabel:{...version.informationLabel!,tenantId:"foreign"}});
  if(damage==="owner")f.versions.set(String(version.sourceVersionId),{...version,sourceId:"foreign" as never});
  const sourceWrite=vi.spyOn(f.storage.evidence,"putSourceVersion"),read=vi.spyOn(f.storage.blobs,"get");
  const report=await trainOssCorpus({...f.options,startFileIndex:first.nextFileIndex,expectedSnapshotHash:first.snapshotHash});
  expect(report.sourceContractClosure?.complete).toBe(false);
  expect(report.sourceContractClosure!.roots.filter(root=>root.path.startsWith("spec/")).every(root=>root.status==="incomplete")).toBe(true);
  const heads=[...f.checkpoints.values()].filter(row=>(row.metadata as {schema?:string}).schema==="scce.oss_owned_contract_root.v1");
  expect(heads).toHaveLength(2);expect(heads.every(row=>row.status==="pending")).toBe(true);
  expect(sourceWrite).not.toHaveBeenCalled();
  if(damage!=="bytes")expect(read.mock.calls.some(([hash])=>hash===version.contentHash)).toBe(false);
});

it("rejects private/outside inventory dependencies without attempting a canonical read",async()=>{
  const root=await mkdtemp(path.join(tmpdir(),"scce-closure-scope-"));roots.push(root);
  const load=vi.fn(async()=>undefined),budget:ContractClosureBudget={maxFiles:127,maxFileBytes:4096,maxTotalBytes:8192,files:new Map(),usedBytes:0};
  const result=await collectTypeScriptContractClosure({root,testPath:"spec/public.ts",inventory:[{path:"../private/heldout.ts",byteLength:1}],budget,load});
  expect(result.complete).toBe(false);expect(result.reasons).toEqual(["inventory_path_outside_scope:../private/heldout.ts"]);expect(load).not.toHaveBeenCalled();
});
