// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
import test from "node:test";
import assert from "node:assert/strict";
import * as acceptance from "./application-acceptance.mjs";
const { CATEGORY_LANGUAGES, PLAN_SCHEMA, REQUIRED_CATEGORIES, ACCEPTANCE_BUDGETS, applicationReportStatus, executeCase, requestApplication, validateExecutionReceipt, validatePlan } = acceptance;
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { canonical } from "./blind-comparison/protocol.mjs";
import { encodeProgramArtifactWire } from "../packages/kernel/dist/program-artifact-wire.js";

const hash = value => createHash('sha256').update(value).digest('hex');
test('contains no global grants or diagnostic fallback routes', async () => {
  const source = await readFile(new URL('./application-acceptance.mjs',import.meta.url),'utf8');
  assert.equal(source.includes('/api/session/operator-grant'),false,'global operator grants are forbidden');
  assert.equal(source.includes('/api/turn?full=1'),false,'diagnostic fallback routes are forbidden');
});
function validation(language = 'javascript') {
  const tool = { path: process.execPath, version: process.version, sha256: 'a'.repeat(64) };
  const permission = { schema: 'scce.blind-native-validation-permission.v1', provider: { id: `fixture:${language}`, languageId: language, commandName: language },
    workingDirectory: 'ephemeral_program_workspace', build: { command: process.execPath, args: ['--check', 'app.mjs'], cwd: '.' },
    test: { command: process.execPath, args: ['--test', 'public.test.mjs'], cwd: '.' }, toolId: 'node', tool, targetPaths: ['app.mjs'],
    protectedPaths: ['public.test.mjs'], allowNewFiles: true, maxFiles: 32, maxBytes: ACCEPTANCE_BUDGETS.artifactBytes };
  const toolInventory = { language, target: 'app.mjs', tools: { node: tool } };
  return { permission, toolInventory, sha256: hash(canonical({ permission, toolInventory })) };
}

function completePlan() {
  return {
    schema: PLAN_SCHEMA,
    cases: REQUIRED_CATEGORIES.map((category, index) => ({
      id: `case-${index}`,
      category,
      expectedLanguage: CATEGORY_LANGUAGES[category] ?? "typescript",
      spec: `independent application specification ${index}`,
      requiredGeneratedPaths: ["src/main"],
      publicValidation: validation(CATEGORY_LANGUAGES[category] ?? 'typescript'),
      heldOut: {
        files: [
          { kind: "unit", sourcePath: "heldout/unit.test.mjs", targetPath: "heldout/unit.test.mjs", sha256: "a".repeat(64) },
          { kind: "e2e", sourcePath: "heldout/e2e.test.mjs", targetPath: "heldout/e2e.test.mjs", sha256: "b".repeat(64) }
        ],
        command: "node",
        args: ["heldout/test.mjs"],
        cwd: "."
      }
    }))
  };
}

test("acceptance plans require every application category and independent held-out commands", () => {
  assert.deepEqual(validatePlan(completePlan()), []);
  const incomplete = completePlan();
  incomplete.cases.pop();
  assert.ok(validatePlan(incomplete).some(error => error.includes("at least 4 entries")));
});

test("acceptance plan can add a new language/category without treating it as implemented", () => {
  const plan = completePlan();
  plan.cases.push({ ...plan.cases[0], id: "future-rust-case", category: "rust_service", expectedLanguage: "rust", publicValidation: validation('rust') });
  assert.deepEqual(validatePlan(plan), []);
});

test('an explicit unavailable required cell performs no API/native action and prevents aggregate PASS', async t => {
  const plan=completePlan(), cell=plan.cases.find(row=>row.category==='kotlin_android_phonebook');
  delete cell.publicValidation; delete cell.heldOut; delete cell.requiredGeneratedPaths;
  cell.coverageBlocker={schema:'scce.application_coverage_blocker.v1',languageId:'kotlin',reasonId:'program.emission.native_backend_unavailable',detail:'The installed product has no Kotlin backend descriptor.'};
  assert.deepEqual(validatePlan(plan),[]);
  t.mock.method(globalThis,'fetch',()=>{throw Error('blocked case must not contact API');});
  const result=await executeCase(cell,{});
  assert.equal(result.status,'failed');assert.equal(result.nativeChecks,'not_attempted');assert.deepEqual(result.calls,[]);
  assert.equal(applicationReportStatus(plan.cases.map(row=>row===cell?result:{status:'passed'}),4),'failed');
  assert.equal(applicationReportStatus([{status:'passed',coverageBlocker:cell.coverageBlocker}],1),'failed');
  delete cell.coverageBlocker;
  assert.ok(validatePlan(plan).some(error=>error.includes('publicValidation is required')));
});

const artifact = (name, content) => ({ artifactId: `artifact:${name}`, path: name, mediaType: 'text/javascript', role: 'source', content, contentHash: `sha256_${hash(content)}` });
function pendingFor(policy, files = [artifact('app.mjs', 'export const app=1;')]) {
  const input = { schema: 'scce.program.native_validation_approval.v1', program: 'program:current', provider: policy.permission.provider,
    workingDirectory: policy.permission.workingDirectory, build: policy.permission.build, test: policy.permission.test,
    ownerRequirementIds: ['owner:requirement'], files: files.map(file => ({ path: file.path, hash: file.contentHash, byteLength: Buffer.byteLength(file.content) })).sort((a,b)=>a.path.localeCompare(b.path)) };
  return { capabilityId: 'process.build_test', planId: 'plan:current', fingerprint: hash(`process.build_test\u001f${canonical(input)}`), input };
}
const caseInput = () => ({ id: 'app', spec: 'Public phonebook application contract.', expectedLanguage: 'javascript', publicValidation: validation() });
const options = () => ({ serverUrl: 'http://127.0.0.1:12345', token: 'test-only-token', runId: 'fixture', remainingMs: () => 1000 });

test('ordinary compact transport approves only the pinned scope, retries unchanged input and restores exact probe bytes', async t => {
  const testCase = caseInput(), pending = pendingFor(testCase.publicValidation), final = artifact('app.mjs', 'export const app=1;');
  const probe = artifact('probe.mjs', 'export const probe=null;'), calls = [];
  t.mock.method(globalThis, 'fetch', async (url, init) => {
    calls.push({ path: url.pathname, body: JSON.parse(init.body) });
    assert.equal(url.search, ''); assert.equal(init.headers.authorization, 'Bearer test-only-token');
    const body = url.pathname === '/api/session/approve' ? { approved: { planId: pending.planId, fingerprint: pending.fingerprint, input: pending.input } }
      : calls.length === 1 ? { pendingApproval: pending } : encodeProgramArtifactWire({ programArtifacts: [final], buildTest: { attempts: [{ artifacts: [probe] }] } });
    return new Response(JSON.stringify(body), { status: calls.length === 1 ? 202 : 200 });
  });
  const result = await requestApplication(testCase, options());
  assert.deepEqual(calls.map(call => call.path), ['/api/turn', '/api/session/approve', '/api/turn']);
  assert.deepEqual(calls[0].body, calls[2].body);
  assert.equal(JSON.stringify(calls).includes('heldOut'), false);
  assert.equal(result.body.buildTest.attempts[0].artifacts[0].content, probe.content);
});

for (const mutation of ['command', 'protected-file', 'fingerprint', 'stale-response', 'changed-approval']) test(`rejects ${mutation} approval without a global grant`, async t => {
  const testCase = caseInput(), pending = pendingFor(testCase.publicValidation); let calls = 0, approvals = 0;
  if (mutation === 'command') pending.input.build = { ...pending.input.build, args: ['foreign.mjs'] };
  if (mutation === 'protected-file') pending.input.files[0].path = 'public.test.mjs';
  if (mutation === 'fingerprint') pending.fingerprint = 'b'.repeat(64);
  if (['command', 'protected-file'].includes(mutation)) pending.fingerprint = hash(`process.build_test\u001f${canonical(pending.input)}`);
  t.mock.method(globalThis, 'fetch', async (url) => {
    calls++; assert.ok(['/api/turn','/api/session/approve'].includes(url.pathname));
    if (url.pathname === '/api/session/approve') { approvals++; return new Response(JSON.stringify({ approved: { ...pending,
      ...(mutation === 'changed-approval' ? { input: { ...pending.input, files: [] } } : {}) } })); }
    return new Response(JSON.stringify({ pendingApproval: pending }), { status: 202 });
  });
  await assert.rejects(requestApplication(testCase, options()), /approval/);
  assert.equal(approvals, ['stale-response','changed-approval'].includes(mutation) ? 1 : 0);
  assert.ok(calls <= 3);
});

test('rejects corrupt wire identities and unchanged response-size ceiling', async t => {
  const final = artifact('app.mjs', 'export const app=1;');
  const wire = encodeProgramArtifactWire({ programArtifacts: [final], buildTest: { artifacts: [final] } });
  wire.buildTest.artifacts[0].contentRef.artifactIdentityHash = `sha256_${'0'.repeat(64)}`;
  t.mock.method(globalThis, 'fetch', async () => new Response(JSON.stringify(wire)));
  await assert.rejects(requestApplication(caseInput(), options()), /artifact/);
  t.mock.method(globalThis, 'fetch', async () => new Response(' '.repeat(ACCEPTANCE_BUDGETS.outputBytes + 1)));
  await assert.rejects(requestApplication(caseInput(), options()), /byte budget/);
});

test('default loopback requests follow the server contract without inventing bearer authentication', async t => {
  let calls=0;
  t.mock.method(globalThis,'fetch',async(url,init)=>{
    calls++;assert.equal(url.hostname,'127.0.0.1');assert.equal(Object.hasOwn(init.headers,'authorization'),false);
    return new Response(JSON.stringify({answer:'local response'}));
  });
  const response=await requestApplication(caseInput(),{...options(),token:undefined});
  assert.equal(response.status,200);assert.equal(response.body.answer,'local response');assert.equal(calls,1);
});

test('configured bearer failures never trigger an anonymous retry', async t => {
  let calls=0;
  t.mock.method(globalThis,'fetch',async(_url,init)=>{calls++;assert.equal(init.headers.authorization,'Bearer test-only-token');return new Response(JSON.stringify({error:'unauthorized'}),{status:401});});
  const response=await requestApplication(caseInput(),options());
  assert.equal(response.status,401);assert.equal(calls,1);
});

test('rejects nonlocal, unpinned and expired requests before network activity', async t => {
  t.mock.method(globalThis,'fetch',()=>{throw Error('unexpected network');});
  await assert.rejects(requestApplication(caseInput(),{...options(),serverUrl:'https://example.invalid'}),/loopback/);
  const unpinned=caseInput();unpinned.publicValidation.permission.build.args=['changed.mjs'];
  await assert.rejects(requestApplication(unpinned,options()),/owner-pinned/);
  await assert.rejects(requestApplication(caseInput(),{...options(),remainingMs:()=>0}),/time budget/);
});

test('nonce, changed hashes and zero independent execution remain failures', () => {
  const receipt = { schema:'scce.application_test_receipt.v1',caseId:'app',runNonce:'stale',tests:[] };
  const errors = validateExecutionReceipt(receipt,{testCase:caseInput(),nonce:'fresh',generated:[]});
  assert.ok(errors.some(error=>error.includes('nonce')));
  assert.ok(errors.some(error=>error.includes('unit')));
  assert.ok(errors.some(error=>error.includes('e2e')));
});

for (const mode of ['correct','incorrect','tampered-test','approval-file-swap']) test(`actual independent application unit/E2E checks: ${mode}`, async t => {
  const root = await mkdtemp(path.join(tmpdir(),'scce-app-harness-test-'));
  t.after(async()=>{ assert.ok(path.basename(root).startsWith('scce-app-harness-test-')); await rm(root,{recursive:true,force:true}); });
  await mkdir(path.join(root,'heldout')); await mkdir(path.join(root,'outputs'));
  const e2e = `import assert from 'node:assert/strict'; export function check(m){const a=m.create(),b=m.create();a.put('λ','one');assert.equal(b.get('λ'),undefined);a.put('λ','two');assert.equal(a.get('λ'),'two');}`;
  const unit = `import assert from 'node:assert/strict';import fs from 'node:fs';import path from 'node:path';import {pathToFileURL} from 'node:url';import {createHash} from 'node:crypto';import {check} from './e2e.mjs';
assert.equal(process.env.SCCE_HARNESS_TEST_SECRET,undefined);const p=path.join(process.env.SCCE_GENERATED_ROOT,'app.mjs');const m=await import(pathToFileURL(p));const a=m.create();a.put('key','first');assert.equal(a.get('key'),'first');a.put('key','second');assert.equal(a.get('key'),'second');check(m);const sha256=createHash('sha256').update(fs.readFileSync(p)).digest('hex');fs.writeFileSync(process.env.SCCE_ACCEPTANCE_RECEIPT_PATH,JSON.stringify({schema:'scce.application_test_receipt.v1',caseId:process.env.SCCE_ACCEPTANCE_CASE,runNonce:process.env.SCCE_ACCEPTANCE_RUN_NONCE,tests:['unit','e2e'].map(kind=>({kind,executedCount:2,passedCount:2,failedCount:0,generatedArtifacts:[{path:'app.mjs',sha256}]}))}));`;
  const heldOut = [ ['unit','heldout/unit.mjs',unit],['e2e','heldout/e2e.mjs',e2e] ];
  for(const [,name,content] of heldOut)await writeFile(path.join(root,name),content);
  const testCase={...caseInput(),category:'javascript_phonebook',requiredGeneratedPaths:['app.mjs','program.graph.json'],heldOut:{files:heldOut.map(([kind,name,content])=>({kind,sourcePath:name,targetPath:name,sha256:hash(content)})),command:process.execPath,args:['heldout/unit.mjs'],cwd:'.'}};
  const code=(mode==='tampered-test'?`import fs from 'node:fs';fs.appendFileSync(new URL('../heldout/e2e.mjs',import.meta.url),'\\n// changed');`:'')+`export function create(){const m=new Map();return{put:(k,v)=>m.set(k,v),get:k=>${mode==='incorrect'?'undefined':'m.get(k)'}}}`;
  const manifest=JSON.stringify({kind:'program_graph',shape:{target:{language:'javascript'}},sourceEmission:{entrypoint:'app.mjs'},validation:{build:testCase.publicValidation.permission.build,test:testCase.publicValidation.permission.test}});
  const artifacts=[artifact('app.mjs',code),artifact('program.graph.json',manifest)];
  const reply=encodeProgramArtifactWire({programArtifacts:artifacts,programReadiness:{status:'ready',artifactCount:artifacts.length,artifactIds:artifacts.map(item=>item.artifactId)},buildTest:{passed:true,build:{code:0},test:{code:0},testExecutionReceipt:{status:'executed',...testCase.publicValidation.permission.test}},events:[{typeId:'BuildExecuted',payload:{code:0}},{typeId:'TestExecuted',payload:{passed:true}}]});
  let calls=0;const pending=pendingFor(testCase.publicValidation,[artifact('app.mjs','export const old=true;'),artifacts[1]]);
  t.mock.method(globalThis,'fetch',async(url,init)=>{calls++;assert.equal(JSON.stringify(JSON.parse(init.body)).includes('heldout'),false);
    if(mode==='approval-file-swap'&&calls===1)return new Response(JSON.stringify({pendingApproval:pending}),{status:202});
    if(url.pathname==='/api/session/approve')return new Response(JSON.stringify({approved:pending}));
    assert.equal(url.pathname,'/api/turn');return new Response(JSON.stringify(reply));});
  const oldSecret=process.env.SCCE_HARNESS_TEST_SECRET;process.env.SCCE_HARNESS_TEST_SECRET='test-only';t.after(()=>{if(oldSecret===undefined)delete process.env.SCCE_HARNESS_TEST_SECRET;else process.env.SCCE_HARNESS_TEST_SECRET=oldSecret;});
  const result=await executeCase(testCase,{...options(),outputRoot:path.join(root,'outputs'),planDirectory:root});
  assert.equal(result.status,mode==='correct'?'passed':'failed',JSON.stringify(result.failures));
  if(mode==='correct')assert.equal(result.independentTest.receipt.tests.length,2);
  if(mode==='tampered-test')assert.ok(result.failures.some(message=>message.includes('immutable')));
  if(mode==='approval-file-swap'){assert.ok(result.failures.some(message=>message.includes('explicitly approved')));assert.equal(result.independentTest,undefined);}
});

test("acceptance plans reject unsafe artifact and held-out paths", () => {
  const plan = completePlan();
  plan.cases[0].requiredGeneratedPaths = ["../../outside.mjs"];
  plan.cases[1].heldOut.files[0].sourcePath = "../untrusted.test.mjs";
  plan.cases[2].heldOut.files[0].targetPath = "generated/src/main.mjs";
  assert.ok(validatePlan(plan).some(error => error.includes("unsafe generated path")));
  assert.ok(validatePlan(plan).some(error => error.includes("sourcePath/targetPath")));
  assert.ok(validatePlan(plan).some(error => error.includes("cannot overwrite generated artifacts")));
});

test("acceptance plans reject unhashed or missing held-out tests", () => {
  const plan = completePlan();
  plan.cases[0].heldOut.files[0].sha256 = "not-a-digest";
  plan.cases[1].heldOut.command = "";
  assert.ok(validatePlan(plan).some(error => error.includes("lowercase SHA-256")));
  assert.ok(validatePlan(plan).some(error => error.includes("heldOut.command is required")));
});

test("application test receipt requires nonzero unit and E2E counts bound to generated hashes", () => {
  const testCase = completePlan().cases[0];
  const receipt = {
    schema: "scce.application_test_receipt.v1",
    caseId: testCase.id,
    runNonce: "fresh-run-nonce",
    tests: ["unit", "e2e"].map(kind => ({ kind, executedCount: 1, passedCount: 1, failedCount: 0,
      generatedArtifacts: [{ path: "src/main", sha256: "c".repeat(64) }] }))
  };
  const input = { testCase, nonce: "fresh-run-nonce", generated: [{ path: "src/main", sha256: "c".repeat(64) }] };
  assert.deepEqual(validateExecutionReceipt(receipt, input), []);
  receipt.tests[0].executedCount = 0;
  receipt.tests[0].passedCount = 0;
  assert.ok(validateExecutionReceipt(receipt, input).some(error => error.includes("positive, fully passing execution counts")));
  receipt.tests[0].executedCount = 1;
  receipt.tests[0].passedCount = 1;
  receipt.tests[1].generatedArtifacts[0].sha256 = "d".repeat(64);
  assert.ok(validateExecutionReceipt(receipt, input).some(error => error.includes("unknown or changed generated artifact")));
});
