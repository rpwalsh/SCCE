// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { afterEach, expect, it } from "vitest";
import { buildTypeScriptSemanticProgramIndex } from "../typescript-semantic-program-index.js";
import { sourceOwnedTestCases } from "../source-owned-test-contracts.js";
import { trainOssCorpus } from "../oss-corpus.js";
import { COGNITIVE_OPERATOR_IDS, codeRequestSignal, createClock, createHasher, createIdFactory, createProgramGraphBuilder,
  programIntentForTurn, replanOwnerBehaviorProgramIntent, type EvidenceSpan, type IngestionCheckpoint, type SourceVersion, type SemanticEntailmentResult } from "@scce/kernel";
import { sourceOwnedProgramBehaviorFromDocumentation, projectSourceOwnedProgramBehavior, type CodeIntent } from "../../../kernel/src/code-intent.js";
import { NodeBuildTestAdapter } from "../process.js";
import type { ScceRuntimeConfig } from "../config.js";
import { storageFixtureForEvaluation } from "../../../kernel/src/__tests__/evidence-promotion-evaluation-fixture.js";

const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
const sourceText = "let state = ''; export function f0(value:string) { state=value; } export function f1() { return state; } export function f2(value:number):number { return value*value+value; } export function f3(value:unknown):unknown { return value; }\n";
async function fixture(body: string, imports = "import {describe, it as check, expect as verify} from 'vitest';", source = sourceText, extraEntries: Record<string, string> = {}) {
  const root = await mkdtemp(path.join(tmpdir(), "scce-vitest-contract-")); roots.push(root);
  const testText = `${imports}\nimport {f0 as put, f1 as get, f2 as compute, f3 as echo} from '../src/opaque.js';\ndescribe('owned observations',()=>{ ${body} });\n`;
  const entries: Record<string, string> = {
    "tsconfig.json": JSON.stringify({ compilerOptions: { target: "ES2022", module: "NodeNext", moduleResolution: "NodeNext", strict: true, noEmit: true }, include: ["src/**/*.ts", "spec/**/*.ts"] }),
    "src/opaque.ts": source, "spec/opaque.spec.ts": testText, ...extraEntries
  };
  for (const [name, text] of Object.entries(entries)) { const file = path.join(root, name); await mkdir(path.dirname(file), { recursive: true }); await writeFile(file, text); }
  const program = await buildTypeScriptSemanticProgramIndex({ workspaceRoot: root, tsconfigPath: "tsconfig.json", bounds: {
    workspacePaths: Object.keys(entries), observedTestPaths: ["spec/opaque.spec.ts"], maxFiles: 8, maxFileBytes: 64_000, maxTotalBytes: 128_000 } });
  const sourceFile = program.files.find(file => file.path === "src/opaque.ts")!, testFile = program.files.find(file => file.path === "spec/opaque.spec.ts")!;
  const input = { program, sourceVersions: new Map([[sourceFile.path, { sourceVersionId: "owned-source", sourceHash: sourceFile.contentHash }]]),
    testVersions: new Map([[testFile.path, { sourceVersionId: "owned-test", sourceHash: testFile.contentHash }]]), sourceTexts: new Map([[testFile.path, testText]]) };
  return { root, entries, testText, input, cases: sourceOwnedTestCases(input) };
}

async function ingestFixture(root: string) {
  const evidence: EvidenceSpan[] = [], versions = new Map<string, SourceVersion>(), checkpoints = new Map<string, IngestionCheckpoint>();
  const clock = createClock({ fixedTime: 100, stepMs: 1 }), recorded = storageFixtureForEvaluation({ evidence, clockNow: () => clock.now() });
  recorded.storage.evidence.putSourceVersion = async row => { versions.set(String(row.sourceVersionId), row); };
  recorded.storage.evidence.sourceVersionById = async id => versions.get(String(id)) ?? null;
  recorded.storage.evidence.putEvidenceSpan = async row => { const index = evidence.findIndex(span => span.id === row.id); if (index < 0) evidence.push(row); else evidence[index] = row; };
  recorded.storage.evidence.sourceVersionsForEvidence = async ids => [...new Set(evidence.filter(span => ids.includes(span.id)).map(span => String(span.sourceVersionId)))].map(id => versions.get(id)!);
  recorded.storage.ingestion = { get: async id => checkpoints.get(id) ?? null, put: async row => { checkpoints.set(row.id, row); } } as typeof recorded.storage.ingestion;
  const report = await trainOssCorpus({ storage: recorded.storage, rootPath: root, includeDocs: false, maxFilesPerRun: 8, ngramMaxOrder: 2, ngramMaxCountersPerOrder: 16, ngramVocabularyLimit: 128 });
  expect(report.filesSkipped).toEqual([]);
  const patterns = await recorded.storage.languageMemory.listLanguagePatterns({ patternKind: "source_code_assertion_contract" });
  return { patterns, report };
}

it("extracts aliased imported Vitest assertions with exact checker targets, bytes and ordered state", async () => {
  const f = await fixture("check('trace',()=>{put('α');verify(get()).toBe('α');put('β');verify(get()).toBe('β');}); check('scalar',()=>{verify(compute(3)).toBe(12);}); check('data',()=>{verify(echo({a:[1,true,null], b:'👩‍🔬é'})).toStrictEqual({a:[1,true,null], b:'👩‍🔬é'});});");
  expect(f.cases).toHaveLength(4);
  expect(f.cases.map(row => row.targetName)).toEqual(["f1", "f1", "f2", "f3"]);
  expect(f.cases[1]!.invocations!.map(row => [row.targetName, row.arguments])).toEqual([["f0", ["α"]], ["f1", []], ["f0", ["β"]], ["f1", []]]);
  expect(f.cases[2]).toMatchObject({ sourceVersionId: "owned-source", testSourceVersionId: "owned-test", arguments: [3], expectedResult: 12 });
  for (const row of f.cases) for (const span of [row.inputSpan, row.callSpan, row.expectedSpan, row.assertionSpan]) {
    expect(span.textHash).toBe(`sha256:${createHash("sha256").update(f.testText.slice(span.start, span.end)).digest("hex")}`);
  }
  expect(f.cases[3]!.expectedResult).toEqual({ a: [1, true, null], b: "👩‍🔬é" });
  expect(sourceOwnedTestCases({ ...f.input, sourceVersions: new Map([["src/opaque.ts", { sourceVersionId: "owned-source", sourceHash: "sha256:changed" }]]) })).toEqual([]);
  expect(sourceOwnedTestCases({ ...f.input, sourceTexts: new Map([["spec/opaque.spec.ts", f.testText.replace("toBe(12)", "toBe(99)")]]) })).toEqual([]);
});

it.each([
  "verify(compute(3)).not.toBe(12)", "verify(compute(3)).toBeCloseTo(12)", "verify(compute(3)).toEqual(12)",
  "verify(echo({a:1})).toBe({a:1})", "verify(echo({a:1})).toEqual({a:1})", "verify(echo([,1])).toStrictEqual([,1])",
  "verify(echo({a:undefined})).toStrictEqual({a:undefined})", "verify(echo({__proto__:null})).toStrictEqual({__proto__:null})",
  "verify(echo(-0)).toBe(-0)", "verify(compute(3)).toBe(verify.any(Number))", "verify(compute(compute(1))).toBe(6)",
  "verify(compute(3)).resolves.toBe(12)", "if(true){verify(compute(3)).toBe(12)}"
])("declines an assertion outside the exact supported contract: %s", async assertion => {
  const f = await fixture(`check('unsupported',()=>{${assertion};});`); expect(f.cases).toEqual([]);
});

it.each([
  "check('shadow',(verify)=>{verify(compute(3)).toBe(12);});",
  "check('shadow',()=>{function local(verify:any){verify(compute(3)).toBe(12)}});",
  "check.skip('disabled',()=>{verify(compute(3)).toBe(12);});",
  "check.fails('expected failure',()=>{verify(compute(3)).toBe(12);});",
  "check('conditional',async()=>{verify(compute(3)).toBe(12);});",
  "verify.extend({toBe:()=>({pass:true})});check('custom',()=>{verify(compute(3)).toBe(12);});",
  "if(false){check('not executed',()=>{verify(compute(3)).toBe(12);});}"
])("declines shadowed, customized or nonordinary test execution: %s", async body => {
  expect((await fixture(body)).cases).toEqual([]);
});

it("does not trust a lookalike expect import or a wrapper result as a target result", async () => {
  expect((await fixture("check('foreign',()=>{verify(compute(3)).toBe(12);});", "import {describe,it as check} from 'vitest'; import {expect as verify} from './custom.js';")).cases).toEqual([]);
  const node = await fixture("check('wrapped',()=>{verify.strictEqual(echo(compute(3)),12);});", "import {test as check} from 'node:test'; import verify from 'node:assert/strict'; const describe=(_name:string,callback:()=>void)=>callback();");
  expect(node.cases).toEqual([]);
});

it("refuses a project-local module remapped to the Vitest package name", async () => {
  const f = await fixture("check('remapped',()=>{verify(compute(3)).toBe(999);});", undefined, undefined, {
    "tsconfig.json": JSON.stringify({ compilerOptions: { target: "ES2022", module: "NodeNext", moduleResolution: "NodeNext", baseUrl: ".", paths: { vitest: ["./fake-vitest.ts"] }, noEmit: true }, include: ["**/*.ts"] }),
    "fake-vitest.ts": "export function describe(_name:string,run:()=>void){run();} export const it=describe; export function expect(_actual:unknown){return {toBe(_expected:unknown){}};}\n"
  });
  expect(f.input.program.imports.some(row => row.moduleSpecifierEvidence === "vitest" && row.targetFileId)).toBe(true);
  expect(f.cases).toEqual([]);
});

it("preserves exact imported Node assertion aliases and rejects Vitest setup or mock-dependent traces", async () => {
  const node = await fixture("check('named',()=>{verify(compute(3),12);});", "import {test as check} from 'node:test'; import {strictEqual as verify} from 'node:assert/strict'; const describe=(_name:string,callback:()=>void)=>callback();");
  expect(node.cases).toMatchObject([{ targetName: "f2", arguments: [3], expectedResult: 12 }]);
  const hooked = await fixture("setup(()=>put('altered'));check('with hook',()=>{verify(get()).toBe('altered');});", "import {describe,it as check,expect as verify,beforeEach as setup} from 'vitest';");
  expect(hooked.cases).toEqual([]);
  const mocked = await fixture("mocks.mock('../src/opaque.js');check('mocked',()=>{verify(compute(3)).toBe(12);});", "import {describe,it as check,expect as verify,vi as mocks} from 'vitest';");
  expect(mocked.cases).toEqual([]);
  expect((await fixture("const escaped=verify;escaped.extend({toBe:()=>({pass:true})});check('escaped',()=>{verify(compute(3)).toBe(12);});")).cases).toEqual([]);
});

it("publishes Vitest contracts through ordinary bounded OSS ingestion", async () => {
  const f = await fixture("check('scalar',()=>{verify(compute(2)).toBe(6);verify(compute(3)).toBe(12);});");
  const { patterns } = await ingestFixture(f.root);
  expect(patterns).toHaveLength(1);
  expect(patterns[0]!.patternJson).toMatchObject({ targetName: "f2", cases: [{ arguments: [2], expectedResult: 6 }, { arguments: [3], expectedResult: 12 }] });
  expect(patterns[0]!.evidenceIds.length).toBeGreaterThan(0);
  expect(await readFile(path.join(f.root, "spec/opaque.spec.ts"), "utf8")).toBe(f.testText);
});

it("acquires seven literal observations from the unchanged public repository source and Vitest test", async () => {
  const base = new URL("./fixtures/public-vitest-contract/", import.meta.url);
  const source = await readFile(new URL("kernel-answer-primitives.ts.txt", base), "utf8");
  const test = await readFile(new URL("bounded-edit-distance.test.ts.txt", base), "utf8");
  expect(createHash("sha256").update(source).digest("hex")).toBe("0325a58530a2a0d2e560e079e275dd3f7ac381fb70869fea473d1ba126f13a49");
  expect(createHash("sha256").update(test).digest("hex")).toBe("f623033ec59a1a32f816381287340f94c136f140cf208876f002d273cee8b573");
  const entries = { "kernel-answer-primitives.ts": source, "__tests__/bounded-edit-distance.test.ts": test,
    "tsconfig.json": JSON.stringify({ compilerOptions: { target: "ES2022", module: "NodeNext", moduleResolution: "NodeNext", noEmit: true }, include: ["**/*.ts"] }) };
  const root = await mkdtemp(path.join(tmpdir(), "scce-public-vitest-")); roots.push(root);
  for (const [name, text] of Object.entries(entries)) { const file = path.join(root, name); await mkdir(path.dirname(file), { recursive: true }); await writeFile(file, text); }
  const program = await buildTypeScriptSemanticProgramIndex({ workspaceRoot: root, tsconfigPath: "tsconfig.json", bounds: {
    workspacePaths: Object.keys(entries), observedTestPaths: ["__tests__/bounded-edit-distance.test.ts"], maxFiles: 8, maxFileBytes: 64_000, maxTotalBytes: 128_000 } });
  const sourceFile = program.files.find(file => file.path === "kernel-answer-primitives.ts")!, testFile = program.files.find(file => file.path === "__tests__/bounded-edit-distance.test.ts")!;
  const cases = sourceOwnedTestCases({ program, sourceVersions: new Map([[sourceFile.path, { sourceVersionId: "public-source", sourceHash: sourceFile.contentHash }]]),
    testVersions: new Map([[testFile.path, { sourceVersionId: "public-test", sourceHash: testFile.contentHash }]]), sourceTexts: new Map([[testFile.path, test]]) });
  expect(cases.map(row => [row.targetName, row.arguments, row.expectedResult])).toEqual([
    ["boundedEditDistance", ["", "", 3], 0], ["boundedEditDistance", ["", "ab", 3], 2], ["boundedEditDistance", ["abc", "", 3], 3],
    ["boundedEditDistance", ["engine", "engine", 3], 0], ["boundedEditDistance", ["a", "abcdefgh", 3], 4],
    ["boundedEditDistance", ["kitten", "sitting", 2], 3], ["boundedEditDistance", ["kitten", "sitting", 3], 3]
  ]);
});

it("uses Vitest-owned state traces in the existing native retry and passes separate unseen behavior checks", async () => {
  const f = await fixture("check('trace',()=>{put('a','111');verify(get('a')).toBe('111');put('a','222');verify(get('a')).toBe('222');});", undefined,
    "const values=new Map<string,string>(); export function f0(key:string,value:string){values.set(key,value);} export function f1(key:string){return values.get(key);} export function f2(value:number):number{return value*value+value;} export function f3(value:unknown):unknown{return value;}\n");
  expect(f.cases).toHaveLength(2);
  const { patterns } = await ingestFixture(f.root);
  expect(patterns).toHaveLength(1);
  const contract = patterns[0]!.patternJson as { repositoryFamily: string; sourceHash: string };
  const codeIntent: CodeIntent = { languageId: "typescript", symbols: [], references: [{ relativePath: "src/opaque.ts", sourceFamily: contract.repositoryFamily, sourceHash: contract.sourceHash, languageId: "typescript", score: 1 }], audit: null };
  const requestText = "TypeScript opaque.ts", behavior = sourceOwnedProgramBehaviorFromDocumentation({ requestText, intent: codeIntent, patterns });
  expect(behavior.statefulBehaviorRequirements.map(row => row.verificationRole)).toEqual(["fit", "held_out"]);
  const signal = projectSourceOwnedProgramBehavior({ codeSignal: codeRequestSignal(requestText), intent: codeIntent, sourceBehavior: behavior });
  const intent = programIntentForTurn({ requestedAuthority: "program", activeOperatorIds: [COGNITIVE_OPERATOR_IDS.programPlanning], codeSignal: signal, evidence: [] })!;
  const hasher = createHasher(), clock = createClock({ fixedTime: 1000, stepMs: 1 }), ids = createIdFactory({ clock, hasher, deterministicReplay: true });
  const builder = createProgramGraphBuilder({ idFactory: ids, hasher });
  const build = (programIntent: typeof intent) => builder.build({ episodeId: ids.episodeId(), text: requestText, createdAt: clock.now(), evidence: [], programIntent, entailment: emptyEntailment(ids) });
  const privateRoot = await mkdtemp(path.join(tmpdir(), "scce-vitest-private-")); roots.push(privateRoot);
  const native = new NodeBuildTestAdapter({ runtime: { tempRoot: privateRoot } } as unknown as ScceRuntimeConfig), probe = build(intent);
  const failed = await native.executeProgram({ episodeId: probe.episodeId, construct: probe });
  expect(failed.passed).toBe(false); expect(failed.test.code).not.toBe(0);
  const retry = replanOwnerBehaviorProgramIntent({ intent, program: probe.program!, hasher, failure: { observationId: "actual-vitest-native-failure", programId: probe.program!.id,
    planHash: hasher.digestHex(JSON.stringify(probe.program!.files)), validatorId: "actual-native", checkId: "tests", status: "failed", ownerRequirementIds: intent.statefulBehaviorRequirements!.map(row => row.id), command: probe.program!.test } });
  const selected = build(retry.intent), passed = await native.executeProgram({ episodeId: selected.episodeId, construct: selected });
  expect(passed.passed, passed.build.stderr + "\n" + passed.test.stderr).toBe(true);
  expect(passed.testExecutionReceipt?.status).toBe("executed");
  const artifactRoot = path.join(privateRoot, "artifacts");
  for (const artifact of passed.artifacts) { const file = path.join(artifactRoot, artifact.path); await mkdir(path.dirname(file), { recursive: true }); await writeFile(file, artifact.content); }
  const checks = path.join(privateRoot, "unseen.mjs");
  await writeFile(checks, "import assert from 'node:assert/strict';const {createStatefulProgram}=await import(process.argv[2]);const a=createStatefulProgram(),b=createStatefulProgram();a.f0('👩‍🔬','first-unseen');a.f0('second','retained');a.f0('👩‍🔬','overwritten');assert.equal(a.f1('👩‍🔬'),'overwritten');assert.equal(a.f1('second'),'retained');b.f0('👩‍🔬','isolated');assert.equal(b.f1('👩‍🔬'),'isolated');assert.equal(a.f1('👩‍🔬'),'overwritten');console.log('independent checks passed');");
  const result = await promisify(execFile)(process.execPath, [checks, pathToFileURL(path.join(artifactRoot, selected.program!.entrypoint)).href], { timeout: 30000 });
  expect(result.stdout).toContain("independent checks passed");
  expect(JSON.stringify(patterns)).not.toContain("first-unseen");
  expect(selected.program!.files.every(file => !file.content.includes("overwritten"))).toBe(true);
});

function emptyEntailment(ids: ReturnType<typeof createIdFactory>): SemanticEntailmentResult {
  const claimId = ids.claimId("owned trace"), proofId = ids.proofId({ claimId, evidenceIds: [], transforms: [], validatorVersion: "fixture" });
  return { claim: { id: claimId, text: "", normalized: "", features: [], polarity: 1 }, verdict: "underdetermined", semanticVerdict: "underdetermined", force: "unknown", support: 0, contradiction: 0, faithfulnessLcb: 0,
    confidence: { verdict: "underdetermined", support: 0, contradiction: 0, faithfulnessLcb: 0, supportingEvidence: 0, sourceVersions: [], structuralCoverage: 0, roleCoverage: 0, relationCompatibility: 0, transformationSupport: 0, causalMass: 0, stability: 1, satisfiedObligations: 0, requiredObligations: 0 },
    scores: { structuralCoverage: 0, roleCoverage: 0, relationCompatibility: 0, transformationSupport: 0, causalMass: 0, faithfulnessLCB: 0, contradiction: 0, stability: 1 }, obligations: [], mappings: [], transforms: [], counterexamples: [], missing: [], evidenceIds: [], boundaries: [],
    proof: { id: proofId, claimId, verdict: "unknown", confidence: {}, proofGraph: { nodes: [], edges: [] }, evidenceIds: [], transformIds: [], scores: {}, validatorVersion: "fixture", createdAt: 1000 } };
}
