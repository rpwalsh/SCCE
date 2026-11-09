// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { createClock,sourceOwnedProgramBehaviorFromDocumentation,searchProgramTransformations,evaluateProgramExpression,type JsonValue, type EvidenceSpan, type SourceVersion, type IngestionCheckpoint } from "@scce/kernel";
import { storageFixtureForEvaluation } from "../../../kernel/src/__tests__/evidence-promotion-evaluation-fixture.js";
import { trainOssCorpus } from "../oss-corpus.js";
import { collectTypeScriptContractClosure, type ContractClosureBudget } from "../typescript-contract-closure.js";

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
  return { root, files, storage, versions, evidence, checkpoints, blobs, options };
}

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
  expect(first.sourceContractClosure).toMatchObject({candidateCount:34,nextCandidateIndex:32,complete:false});
  expect(await f.storage.languageMemory.listLanguagePatterns({patternKind:"source_code_assertion_contract"})).toEqual([]);
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
