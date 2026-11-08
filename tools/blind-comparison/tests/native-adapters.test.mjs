import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { sha256Text } from '../../sealed-eval/harness/lib/util.mjs';
import { canonical, hash, readJson, writeJson, freeze, seal } from '../protocol.mjs';
import { execute, collect, checkpoint } from '../runner.mjs';
import { grade, semanticCheck } from '../grading.mjs';
import { smoke } from '../smoke.mjs';
import { nativeContract } from '../adapters/native-contract.mjs';
import { runScceNative } from '../adapters/scce-native-lib.mjs';
import { runReferenceNative } from '../adapters/reference-native-lib.mjs';
import { validateReferenceRunner } from '../adapters/reference-runner-config.mjs';
import { nativeResponseSchema } from '../adapters/native-response-schema.mjs';

const roots = [];
after(async () => { for (const root of roots) await rm(root, { recursive: true, force: true }); });
async function workspace(files = {}) {
  const root = await mkdtemp(path.join(tmpdir(), 'scce-native-comparison-')); roots.push(root);
  for (const [name, content] of Object.entries(files)) { await mkdir(path.dirname(path.join(root, name)), { recursive: true }); await writeFile(path.join(root, name), content); }
  return root;
}
const good = 'module.exports = (a,b) => a+b;\n';
const bad = 'module.exports = (a,b) => a-b;\n';
const check = "const assert=require('node:assert/strict');assert.equal(require('./module.cjs')(2,3),5);console.log('public native check passed');";
const digest = 'a'.repeat(64);
function makeInput(operation, overrides = {}) {
  const publicChecks = ['code_repair', 'code_generation'].includes(operation) ? [{ argv: ['{node}', 'public-check.cjs'] }] : [];
  const contract = { schema: 'scce.blind-native-task.v1', operation, maxPublicAttempts: 1, writablePaths: ['module.cjs'], publicChecks, approvals: [], targetPaths: ['module.cjs'], validationPolicyId: 'public-native-node.v1', validationChecks: ['compiler', 'tests'], validationPolicy: { schemaVersion: 'scce.patch-validation-policy.v1', id: 'public-native-node.v1', commands: [{ executable: process.execPath, argv: ['public-check.cjs'], checkIds: ['compiler', 'tests'] }], timeoutMs: 5000, maxOutputBytes: 65536, maxWorkspaceFiles: 10, maxWorkspaceBytes: 65536, environment: {} }, ...overrides };
  const files = { 'module.cjs': bad, 'public-check.cjs': check };
  return { schema: 'scce.blind-input.v1', caseId: 'heldout-example', category: operation.startsWith('code') ? 'code' : operation === 'learning_update' ? 'learning_updates' : operation === 'tool_use' ? 'agentic' : 'chat', language: 'javascript', outputContract: canonical(contract), steps: [{ prompt: 'Implement the requested public task.', sources: [], files }], history: [], budgets: { timeMs: 10000, outputBytes: 131072, caseBytes: 262144, artifactBytes: 65536, maxSteps: 4 }, isolation: { mode: 'trusted-host' } };
}
const requestUnexpected = async () => { throw new Error('Unexpected HTTP call'); };
test('repair invokes the official CLI with current public workspace and identical public validation policy', async () => {
  const input = makeInput('code_repair'), cwd = await workspace(input.steps[0].files);
  let called = false;
  const result = await runScceNative(input, { cwd, cliPath: '/official/cli.mjs', configPath: '/operator/config.json' }, { request: requestUnexpected, executeCommand: async (argv, options) => {
    if (argv[1] !== '/official/cli.mjs') return execute(argv, options);
    called = true;
    assert.ok(argv.includes(`--root=${cwd}`));
    assert.ok(argv.includes('--path=module.cjs'));
    const policy = await readJson(argv.find(v => v.startsWith('--validation-policy=')).slice(20));
    assert.equal(policy.commands[0].executable, process.execPath);
    assert.deepEqual(policy.commands[0].argv, ['public-check.cjs']);
    await writeFile(path.join(cwd, 'module.cjs'), good);
    return { code: 0, stdout: canonical({ outcome: 'resolved', appliedOperations: [{ path: 'module.cjs', kind: 'replace' }] }), stderr: '', bytes: 100 };
  } });
  assert.equal(called, true);
  assert.equal(result.identity.productOutcome, 'completed');
  assert.equal(result.artifacts['module.cjs'], good);
  assert.equal(result.identity.trace.at(-1).publicChecks.passed, true);
});
test('an unresolved product repair is completed as a failed outcome even when the unchanged file passes native checks', async () => {
  const input = makeInput('code_repair'), cwd = await workspace({ ...input.steps[0].files, 'module.cjs': good });
  const result = await runScceNative(input, { cwd, cliPath: '/official/cli.mjs', configPath: '/config.json' }, { request: requestUnexpected, executeCommand: async () => ({ code: 1, stdout: canonical({ outcome: 'unresolved', appliedOperations: [] }), stderr: '', bytes: 100 }) });
  assert.equal(result.status, 'ok');
  assert.equal(result.identity.productOutcome, 'failed');
  assert.deepEqual(result.artifacts, {});
});
test('an engine exceeding the sealed attempt budget cannot count its later repair as a pass', async () => {
  const input = makeInput('code_repair'), cwd = await workspace(input.steps[0].files);
  const result = await runScceNative(input, { cwd, cliPath: '/official/cli.mjs', configPath: '/config.json' }, { request: requestUnexpected, executeCommand: async () => ({ code: 0, stdout: canonical({ outcome: 'resolved', attempts: 4 }), stderr: '', bytes: 100 }) });
  assert.equal(result.identity.reason, 'product_attempt_budget_exceeded');
});
test('policy mismatch fails before either system can get different native feedback', () => {
  const input = makeInput('code_repair');
  const contract = JSON.parse(input.outputContract); contract.validationPolicy.commands[0].argv = ['different-check.cjs'];
  input.outputContract = canonical(contract);
  assert.throws(() => nativeContract(input), /must be identical/);
});
test('only current public source bytes enter the official ingestion producer; actual prompt stays ordinary text', async () => {
  const admission = { sourceClass: 'owner_local', intendedUse: 'direct_evidence', promotionAuthority: 'owner' };
  const trust = { identity: 1, integrity: 1, parserReliability: 1, directness: 1, authority: 1, freshness: 1, independenceGroup: 'public-fixture', accessScope: 'owner_private', licenseStatus: 'owner_authorized' };
  const input = makeInput('learning_update', { sourceAdmission: admission, sourceTrust: trust, writablePaths: [] });
  input.steps = [{ prompt: 'Earlier question.', sources: [{ id: 'record', text: 'Original public source.' }], files: {} }, { prompt: 'Current question.', sources: [{ id: 'record', text: 'Corrected public source.' }], files: {} }];
  const cwd = await workspace(), calls = [];
  const result = await runScceNative(input, { cwd }, { request: async (route, body) => { calls.push({ route, body }); return route === '/api/ingest' ? { status: 200, body: { sources: 1, skipped: [] } } : { status: 200, body: { answer: 'Product answer.', episodeId: 'episode.real' } }; } });
  assert.equal(result.answer, 'Product answer.');
  assert.equal(calls[0].route, '/api/ingest');
  assert.equal(calls[0].body.content, 'Corrected public source.');
  assert.deepEqual(calls[0].body.sourceAdmission, admission);
  assert.equal(calls[1].body.text, 'Current question.');
  assert.equal(Object.hasOwn(calls[1].body, 'gold'), false);
  assert.equal(calls.length, 2);
});
test('actual unsupported-language 422 remains a product failure without substituting an artifact or runtime', async () => {
  const input = makeInput('code_generation'), cwd = await workspace(input.steps[0].files);
  const result = await runScceNative(input, { cwd }, { request: async route => route === '/api/workspace/init' ? { status: 200, body: { id: 'workspace.actual', updatedAt: 42 } } : { status: 422, body: { detail: { schema: 'scce.program.response_readiness.v1', reasonId: 'program.readiness.unsupported_language', languageId: 'rust' } } } });
  assert.equal(result.status, 'ok');
  assert.equal(result.identity.productOutcome, 'failed');
  assert.equal(result.identity.readiness.languageId, 'rust');
  assert.deepEqual(result.artifacts, {});
});
test('typed factual insufficient-support abstention is correct only when the private semantic contract expects it', async () => {
  const input = makeInput('turn', { answerMode: 'answer_or_abstain', requestedAuthority: 'factual', writablePaths: [] }), cwd = await workspace(input.steps[0].files);
  input.category = 'corpus_facts';
  const raw = { detail: { schema: 'scce.runtime.withheld_surface.v1', reasonId: 'withheld.surface_refused', requestedAuthority: 'factual', entailmentVerdict: 'underdetermined', truthStateId: 'truth.insufficient_evidence', evidenceCount: 1 } };
  const result = await runScceNative(input, { cwd }, { request: async () => ({ status: 422, body: raw }) });
  assert.equal(result.identity.productOutcome, 'abstained');
  assert.deepEqual(JSON.parse(result.answer), { status: 'abstained', answer: null });
  assert.equal(result.identity.rawResponseHash, hash(raw));
  assert.equal(result.identity.machineOutcomeHash, hash(JSON.parse(result.answer)));
  const submission = [{ response: result }];
  assert.equal(semanticCheck([{ status: 'abstained', answer: null }], submission).pass, true);
  assert.equal(semanticCheck([{ status: 'answered', answer: 'Known supported answer.' }], submission).pass, false);
  const other422 = await runScceNative(input, { cwd }, { request: async () => ({ status: 422, body: { detail: { schema: 'scce.program.response_readiness.v1', reasonId: 'program.readiness.unsupported_language' } } }) });
  assert.equal(other422.identity.productOutcome, 'failed');
  for (const invalid of [
    { detail: { ...raw.detail, requestedAuthority: 'creative' } },
    { detail: { ...raw.detail, reasonId: 'unknown_reason' } },
    { ...raw, answer: 'An actual answer is present.' }
  ]) {
    const unsupported = await runScceNative(input, { cwd }, { request: async () => ({ status: 422, body: invalid }) });
    assert.equal(unsupported.identity.productOutcome, 'failed');
  }
});
test('the reference uses the same explicit answer-or-abstain schema without English refusal matching', async () => {
  const input = makeInput('turn', { answerMode: 'answer_or_abstain', requestedAuthority: 'factual', writablePaths: [] }), cwd = await workspace(input.steps[0].files);
  const raw = canonical({ status: 'abstained', answer: null });
  const abstained = await runReferenceNative(input, { cwd }, { ask: async (prompt, options) => {
    assert.ok(prompt.includes('answer_or_abstain'));
    assert.equal(options.format.oneOf[1].properties.answer.type, 'null');
    return { status: 'ok', answer: raw, modelDigest: digest };
  } });
  assert.equal(abstained.identity.productOutcome, 'abstained');
  assert.equal(abstained.identity.machineOutcomeHash, hash(JSON.parse(raw)));
  const english = await runReferenceNative(input, { cwd }, { ask: async () => ({ status: 'ok', answer: "I don't know.", modelDigest: digest }) });
  assert.equal(english.identity.productOutcome, 'failed');
  const answered = await runReferenceNative(input, { cwd }, { ask: async () => ({ status: 'ok', answer: canonical({ status: 'answered', answer: 'Unknown is the literal name in the source.' }), modelDigest: digest }) });
  assert.equal(JSON.parse(answered.answer).status, 'answered');
});
test('chat and creative replies retain actual text for independent anonymous judging', async () => {
  const input = makeInput('turn', { requestedAuthority: 'creative', writablePaths: [] }), cwd = await workspace(input.steps[0].files);
  input.category = 'creative';
  const text = '🪶 A paper boat turns beneath the bridge.';
  const scce = await runScceNative(input, { cwd }, { request: async () => ({ status: 200, body: { answer: text } }) });
  const reference = await runReferenceNative(input, { cwd }, { ask: async (_, options) => { assert.equal(Object.hasOwn(options, 'format'), false); return { status: 'ok', answer: text, modelDigest: digest }; } });
  assert.equal(scce.answer, text);
  assert.equal(reference.answer, text);
  assert.equal(Object.hasOwn(scce.identity, 'machineOutcome'), false);
  assert.equal(scce.identity.publicContextHash, reference.identity.publicContextHash);
  assert.deepEqual(scce.identity.publicSourceRevisions, reference.identity.publicSourceRevisions);
});
test('verified-artifact generation uses the ordinary program turn without inventing a workspace plan or policy', async () => {
  const input = makeInput('code_generation', { programMode: 'verified_artifacts' }), cwd = await workspace(input.steps[0].files), calls = [];
  const contract = JSON.parse(input.outputContract);
  delete contract.validationPolicyId; delete contract.validationChecks; delete contract.targetPaths;
  input.outputContract = canonical(contract);
  const result = await runScceNative(input, { cwd }, { request: async (route, body) => {
    calls.push({ route, body });
    return { status: 200, body: { programReadiness: { status: 'ready', reasonId: 'program.readiness.verified', artifactCount: 1, artifactIds: ['native.id'] }, programArtifacts: [{ artifactId: 'native.id', path: 'module.cjs', content: good, contentHash: `sha256_${sha256Text(good)}` }] } };
  } });
  assert.equal(result.identity.productOutcome, 'completed');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].body.requestedAuthority, 'program');
  assert.equal(Object.hasOwn(calls[0].body, 'workspaceCoding'), false);
});
test('production reference binds the existing declared runner, explicit model options and empty side corpus', async () => {
  const root = await workspace(), manifest = path.join(root, 'empty.json');
  await writeJson(manifest, { documents: [] });
  const runner = fileURLToPath(new URL('../../sealed-eval/harness/adapters/reference-ollama.mjs', import.meta.url));
  const argv = ['--corpus-manifest', manifest, '--model', 'qwen2.5:3b', '--num-ctx', '8192', '--num-predict', '1024', '--threads', '1', '--device', 'cpu', '--seed', '10', '--request-timeout-ms', '30000'];
  await validateReferenceRunner(runner, argv);
  await assert.rejects(() => validateReferenceRunner(runner, [...argv, '--mode=rag']), /mode is fixed/);
  await assert.rejects(() => validateReferenceRunner(runner, argv.slice(0, -2)), /Pin explicit reference/);
  await writeFile(manifest, canonical({ documents: [{ path: 'side-private-corpus.txt' }] }));
  await assert.rejects(() => validateReferenceRunner(runner, argv), /separate corpus must be empty/);
});
test('generation returns only hash-verified native program artifacts and actually runs the shared public checks', async () => {
  const input = makeInput('code_generation'), cwd = await workspace(input.steps[0].files), calls = [];
  const result = await runScceNative(input, { cwd }, { request: async (route, body) => {
    calls.push({ route, body });
    return route === '/api/workspace/init' ? { status: 200, body: { id: 'workspace.native', updatedAt: 42 } } : { status: 200, body: { answer: 'Native result.', programReadiness: { status: 'ready', reasonId: 'program.readiness.verified', artifactCount: 1, artifactIds: ['artifact.native'] }, programArtifacts: [{ artifactId: 'artifact.native', path: 'module.cjs', content: good, contentHash: `sha256_${sha256Text(good)}` }] } };
  } });
  assert.equal(result.identity.productOutcome, 'completed');
  assert.equal(result.artifacts['module.cjs'], good);
  assert.equal(calls[1].body.workspaceCoding.expectedWorkspaceUpdatedAt, 42);
  assert.equal(calls[1].body.requestedAuthority, 'program');
});
test('forged program artifact hashes fail instead of manufacturing a ready result', async () => {
  const input = makeInput('code_generation'), cwd = await workspace(input.steps[0].files);
  const result = await runScceNative(input, { cwd }, { request: async route => route === '/api/workspace/init' ? { status: 200, body: { id: 'workspace.native', updatedAt: 42 } } : { status: 200, body: { programReadiness: { status: 'ready' }, programArtifacts: [{ path: 'module.cjs', content: good, contentHash: 'sha256_fake' }] } } });
  assert.equal(result.identity.reason, 'invalid_program_artifact_identity');
  assert.equal(await readFile(path.join(cwd, 'module.cjs'), 'utf8'), bad);
});
test('generation permits native emitted new tests and unchanged public files while protecting existing check bytes', async () => {
  const input = makeInput('code_generation', { programMode: 'verified_artifacts', allowNewFiles: true }), cwd = await workspace(input.steps[0].files);
  const newTest = 'require("node:assert/strict").equal(require("./module.cjs")(2,3),5);';
  const emitted = Object.entries({ 'module.cjs': good, 'generated.test.cjs': newTest, 'public-check.cjs': check }).map(([path, content], i) => ({ artifactId: `id.${i}`, path, content, contentHash: `sha256_${sha256Text(content)}` }));
  const result = await runScceNative(input, { cwd }, { request: async () => ({ status: 200, body: { programReadiness: { status: 'ready', reasonId: 'program.readiness.verified', artifactCount: emitted.length, artifactIds: emitted.map(a => a.artifactId) }, programArtifacts: emitted } }) });
  assert.equal(result.identity.productOutcome, 'completed');
  assert.equal(result.artifacts['generated.test.cjs'], newTest);
  assert.equal(await readFile(path.join(cwd, 'public-check.cjs'), 'utf8'), check);
  const reference = await runReferenceNative(input, { cwd }, { ask: async (_, options) => {
    assert.deepEqual(options.format.properties.artifacts.additionalProperties, { type: 'string' });
    return { status: 'ok', modelDigest: digest, answer: canonical({ answer: '', artifacts: { 'module.cjs': good, 'another.test.cjs': newTest } }) };
  } });
  assert.equal(reference.identity.productOutcome, 'completed');
  const attemptedCheckRewrite = await runReferenceNative(input, { cwd }, { ask: async () => ({ status: 'ok', modelDigest: digest, answer: canonical({ answer: '', artifacts: { 'public-check.cjs': '' } }) }) });
  assert.equal(attemptedCheckRewrite.identity.productOutcome, 'failed');
  assert.equal(await readFile(path.join(cwd, 'public-check.cjs'), 'utf8'), check);
});
test('generated plans pass through the exact native approval and rollback-preserving patch transaction', async () => {
  const input = makeInput('code_generation', { approvals: ['workspace.patch.apply'] }), cwd = await workspace(input.steps[0].files), calls = [];
  const plan = { schemaVersion: 'scce.patch-transaction-plan.v1', planHash: 'sha256:actual-plan', operations: [{ kind: 'replace', path: 'module.cjs', content: good }] };
  let attempts = 0;
  const result = await runScceNative(input, { cwd }, { request: async (route, body) => {
    calls.push({ route, body });
    if (route === '/api/workspace/init') return { status: 200, body: { id: 'workspace.native', updatedAt: 42 } };
    if (route.startsWith('/api/turn')) return { status: 200, body: { answer: 'Native plan.', workspaceCoding: { plan } } };
    if (route === '/api/session/approve') { assert.equal(body.planId, 'approval.exact'); return { status: 200, body: { approved: true } }; }
    assert.equal(route, '/api/workspace/patch');
    assert.deepEqual(body.plan, plan);
    if (!attempts++) return { status: 202, body: { pendingApproval: { capabilityId: 'workspace.patch.apply', planId: 'approval.exact' } } };
    await writeFile(path.join(cwd, 'module.cjs'), good);
    return { status: 200, body: { receipt: { planHash: plan.planHash, validation: { validatorId: 'public-native-node.v1' } } } };
  } });
  assert.equal(result.identity.productOutcome, 'completed');
  assert.equal(result.artifacts['module.cjs'], good);
  assert.equal(calls.filter(c => c.route === '/api/session/approve').length, 1);
  assert.deepEqual(calls.filter(c => c.route === '/api/workspace/patch').map(c => hash(c.body)), [hash(calls[2].body), hash(calls[2].body)]);
});
test('undeclared approval is a failed product outcome and is never automatically granted', async () => {
  const input = makeInput('tool_use', { executiveGoal: { schema: 'scce.local_executive_goal.v1', tasks: [] }, writablePaths: [] }), cwd = await workspace(input.steps[0].files), calls = [];
  const result = await runScceNative(input, { cwd }, { request: async route => { calls.push(route); return { status: 202, body: { pendingApproval: { capabilityId: 'process.build_test', planId: 'not-authorized' } } }; } });
  assert.equal(result.identity.productOutcome, 'failed');
  assert.deepEqual(calls, ['/api/executive/run']);
});
test('ordinary action-turn success requires actual native CapabilitySucceeded events', async () => {
  const input = makeInput('tool_use', { requiredCapabilityIds: ['process.build_test'] }), cwd = await workspace(input.steps[0].files);
  const request = events => async () => ({ status: 200, body: { answer: 'Reported result.', events } });
  const failed = await runScceNative(input, { cwd }, { request: request([]) });
  assert.equal(failed.identity.productOutcome, 'failed');
  const passed = await runScceNative(input, { cwd }, { request: request([{ typeId: 'CapabilitySucceeded', payload: { capabilityId: 'process.build_test', planId: 'native-plan' } }]) });
  assert.equal(passed.identity.productOutcome, 'completed');
});
test('reference sees the identical public sources/files/contract, returns strict machine artifacts and runs native checks', async () => {
  const input = makeInput('code_repair'), cwd = await workspace(input.steps[0].files);
  input.steps[0].sources.push({ id: 'public-doc', text: 'Same public documentation.' });
  const result = await runReferenceNative(input, { cwd, expectedModelDigest: digest }, { ask: async (prompt, options) => {
    assert.ok(prompt.includes('Same public documentation.'));
    assert.ok(prompt.includes('public-check.cjs'));
    assert.ok(prompt.includes('scce.blind-native-task.v1'));
    assert.deepEqual(Object.keys(options.format.properties.artifacts.properties), ['module.cjs']);
    assert.equal(options.format.additionalProperties, false);
    return { status: 'ok', answer: canonical({ answer: 'Changed addition.', artifacts: { 'module.cjs': good } }), modelDigest: digest };
  } });
  assert.equal(result.identity.productOutcome, 'completed');
  assert.equal(result.artifacts['module.cjs'], good);
});
test('native response schemas depend only on public task structure and constrain autonomous tools to the remaining public budget', () => {
  const input = makeInput('tool_use', { toolPolicy: { tools: ['workspace.read', 'workspace.write', 'public.check'], maxCalls: 8 }, publicChecks: [{ argv: ['{node}', 'public-check.cjs'] }] });
  input.privateGoldNeverToBeUsed = 'PRIVATE_CANARY_819204';
  const schema = nativeResponseSchema(input, nativeContract(input), 3);
  assert.equal(schema.properties.toolCalls.maxItems, 3);
  const choices = schema.properties.toolCalls.items.oneOf;
  assert.deepEqual(choices.map(c => c.properties.tool.const), ['workspace.read', 'workspace.write', 'public.check']);
  assert.equal(canonical(schema).includes('PRIVATE_CANARY_819204'), false);
  assert.equal(canonical(schema).includes('../'), false);
  const goal = { schema: 'scce.local_executive_goal.v1', tasks: [{ public: 'declared' }] };
  const given = makeInput('tool_use', { executiveGoal: goal });
  assert.deepEqual(nativeResponseSchema(given, nativeContract(given)).properties.executiveGoal.const, goal);
});
test('reference code fences are not guessed or stripped and never become accepted generated code', async () => {
  const input = makeInput('code_generation'), cwd = await workspace(input.steps[0].files);
  const result = await runReferenceNative(input, { cwd }, { ask: async () => ({ status: 'ok', answer: '```json\n' + canonical({ answer: '', artifacts: { 'module.cjs': good } }) + '\n```', modelDigest: digest }) });
  assert.equal(result.identity.productOutcome, 'failed');
  assert.equal(await readFile(path.join(cwd, 'module.cjs'), 'utf8'), bad);
});
test('reference attempts receive only public native feedback and cannot edit protected public validators', async () => {
  const input = makeInput('code_repair', { maxPublicAttempts: 2 }), cwd = await workspace(input.steps[0].files);
  let attempt = 0;
  const result = await runReferenceNative(input, { cwd }, { ask: async prompt => {
    if (attempt++) assert.ok(prompt.includes('public-check-failed'));
    return { status: 'ok', answer: canonical({ answer: '', artifacts: { 'module.cjs': attempt === 1 ? bad : good } }), modelDigest: digest };
  } });
  assert.equal(result.identity.productOutcome, 'completed');
  const protectedResult = await runReferenceNative(input, { cwd }, { ask: async () => ({ status: 'ok', answer: canonical({ answer: '', artifacts: { 'public-check.cjs': '' } }), modelDigest: digest }) });
  assert.equal(protectedResult.identity.productOutcome, 'failed');
  assert.equal(await readFile(path.join(cwd, 'public-check.cjs'), 'utf8'), check);
});
test('reference model digest changes are detected before any accepted artifact', async () => {
  const input = makeInput('code_generation'), cwd = await workspace(input.steps[0].files);
  await assert.rejects(() => runReferenceNative(input, { cwd, expectedModelDigest: digest }, { ask: async () => ({ status: 'ok', answer: '{}', modelDigest: 'b'.repeat(64) }) }), /identity changed/);
});
test('both native executive bridges execute the exact same public build/test goal rather than treating a plan as execution', async () => {
  const artifact = { path: 'main.mjs', content: 'console.log("public executed");', contentHash: `sha256_${sha256Text('console.log("public executed");')}`, role: 'source', mediaType: 'text/javascript', artifactId: 'artifact.public' };
  const goal = { schema: 'scce.local_executive_goal.v1', episodeId: 'public.episode', goalId: 'public.goal', tasks: [{ id: 'public.task', dependencyTaskIds: [], construct: { id: 'public.construct', artifacts: [artifact], program: { id: 'public.program', files: [artifact], nodes: [], edges: [], language: 'javascript', packageManager: 'node', entrypoint: 'main.mjs', build: { command: process.execPath, args: ['--check', 'main.mjs'], cwd: '.' }, test: { command: process.execPath, args: ['main.mjs'], cwd: '.' } } } }] };
  const input = makeInput('tool_use', { executiveGoal: goal, approvals: ['process.build_test'], writablePaths: [] }), cwd = await workspace(input.steps[0].files);
  let sent;
  const scce = await runScceNative(input, { cwd }, { request: async (route, body) => { assert.equal(route, '/api/executive/run'); sent = body; return { status: 200, body: { disposition: 'succeeded', results: [{ taskId: 'public.task', disposition: 'succeeded' }] } }; } });
  const reference = await runReferenceNative(input, { cwd }, { ask: async () => ({ status: 'ok', answer: canonical({ answer: '', artifacts: {}, executiveGoal: goal }), modelDigest: digest }) });
  assert.deepEqual(sent, goal);
  assert.equal(scce.identity.productOutcome, 'completed');
  assert.equal(reference.identity.productOutcome, 'completed');
  assert.equal(reference.answer, scce.answer);
  assert.equal(reference.identity.trace.at(-1).publicExecutive.receipts[0].receipts[1].stdout.trim(), 'public executed');
});
test('cold grading counts an explicit product refusal as a native loss even when the unchanged source is already correct', async () => {
  const root = await workspace();
  const original = await smoke(path.join(root, 'rehearsal'));
  const plan = await readJson(path.join(root, 'rehearsal/plan.json'));
  const adapter = path.join(root, 'refusal.mjs');
  await writeFile(adapter, `process.stdin.resume();process.stdin.on('end',()=>console.log(JSON.stringify({status:'ok',answer:'',artifacts:{},identity:{productOutcome:'failed',reason:'actual_product_decline'}})));`);
  plan.artifacts.push({ id: 'refusal-adapter', role: 'adapter', path: adapter });
  plan.systems[0].adapterArtifact = 'refusal-adapter';
  plan.systems[0].argv = [process.execPath, adapter];
  plan.systems[1].argv = plan.systems[1].argv.filter(v => v !== '--fault');
  const pool = (await readFile(path.join(root, 'rehearsal/pool.jsonl'), 'utf8')).trim().split('\n').map(JSON.parse);
  pool.find(r => r.category === 'code').public.steps[0].files['module.cjs'] = good;
  const planFile = path.join(root, 'plan.json'), poolFile = path.join(root, 'pool.jsonl'), freezeFile = path.join(root, 'freeze.json');
  await writeJson(planFile, plan);
  await writeFile(poolFile, pool.map(canonical).join('\n') + '\n');
  const frozen = await freeze(planFile, freezeFile);
  const bundle = await seal({ freezeFile, freezeDigest: frozen.digest, poolFile, seedFile: path.join(root, 'rehearsal/seed.txt'), outDir: path.join(root, 'sealed') });
  const options = { bundleFile: path.join(root, 'sealed/public/bundle.json'), bundleDigest: bundle.digest, keyFile: path.join(root, 'sealed/private/key.json'), out: path.join(root, 'run'), checkpointFile: path.join(root, 'checkpoint.json'), reportFile: path.join(root, 'report.json') };
  await collect(options);
  options.checkpointDigest = (await checkpoint(options)).digest;
  const report = await grade(options);
  const code = report.cells.find(c => c.category === 'code');
  assert.equal(code.losses, 1);
  assert.equal(code.errors, 0);
  assert.equal(code.cases[0].details[0].reason, 'product-failed');
  assert.equal(code.cases[0].details[1].pass, true);
  const factual = makeInput('turn', { answerMode: 'answer_or_abstain', requestedAuthority: 'factual', writablePaths: [] });
  const normalized = await runScceNative(factual, { cwd: await workspace(factual.steps[0].files) }, { request: async () => ({ status: 422, body: { detail: { schema: 'scce.runtime.withheld_surface.v1', reasonId: 'withheld.surface_refused', requestedAuthority: 'factual', entailmentVerdict: 'underdetermined', truthStateId: 'truth.insufficient_evidence', evidenceCount: 1 } } }) });
  const factAdapter = path.join(root, 'facts.mjs');
  await writeFile(factAdapter, `let s='';for await(const c of process.stdin)s+=c;const i=JSON.parse(s);let r=${JSON.stringify(normalized)};if(process.argv.includes('--reference')){const sources=i.steps.at(-1).sources;const v=sources.length?{status:'answered',answer:JSON.parse(sources[0].text).record}:{status:'abstained',answer:null};r={status:'ok',answer:JSON.stringify(v),artifacts:{},identity:{productOutcome:v.status==='abstained'?'abstained':'completed'}};}console.log(JSON.stringify(r));`);
  plan.cells = [{ category: 'corpus_facts', language: 'en', grading: 'semantic', count: 2 }];
  plan.artifacts.push({ id: 'facts-adapter', role: 'adapter', path: factAdapter });
  for (let i = 0; i < 2; i++) { plan.systems[i].adapterArtifact = 'facts-adapter'; plan.systems[i].argv = [process.execPath, factAdapter, ...(i ? ['--reference'] : [])]; }
  const factPool = ['negative', 'positive'].map(kind => ({ id: `facts-${kind}`, category: 'corpus_facts', language: 'en', grading: 'semantic', public: { outputContract: factual.outputContract, steps: [{ prompt: 'What is the record?', sources: kind === 'positive' ? [{ id: 'public-record', text: '{"record":"Juniper"}' }] : [], files: {} }] }, private: { kind: 'semantic', expected: [kind === 'positive' ? { status: 'answered', answer: 'Juniper' } : { status: 'abstained', answer: null }] } }));
  const factsPlan = path.join(root, 'facts-plan.json'), factsPool = path.join(root, 'facts-pool.jsonl'), factsFreeze = path.join(root, 'facts-freeze.json');
  await writeJson(factsPlan, plan);
  await writeFile(factsPool, factPool.map(canonical).join('\n') + '\n');
  const frozenFacts = await freeze(factsPlan, factsFreeze);
  const sealedFacts = await seal({ freezeFile: factsFreeze, freezeDigest: frozenFacts.digest, poolFile: factsPool, seedFile: path.join(root, 'rehearsal/seed.txt'), outDir: path.join(root, 'facts-sealed') });
  const factOptions = { bundleFile: path.join(root, 'facts-sealed/public/bundle.json'), bundleDigest: sealedFacts.digest, keyFile: path.join(root, 'facts-sealed/private/key.json'), out: path.join(root, 'facts-run'), checkpointFile: path.join(root, 'facts-checkpoint.json'), reportFile: path.join(root, 'facts-report.json') };
  await collect(factOptions);
  factOptions.checkpointDigest = (await checkpoint(factOptions)).digest;
  const factReport = await grade(factOptions);
  assert.equal(factReport.cells[0].losses, 1);
  assert.equal(factReport.cells[0].ties, 1);
  assert.equal(factReport.cells[0].errors, 0);
  assert.equal(factReport.cells[0].cases.find(c => c.id === 'facts-negative').details[0].pass, true);
  assert.equal(factReport.cells[0].cases.find(c => c.id === 'facts-positive').details[0].pass, false);
});

 test('verified code generation carries only the ordinary ingested workspace identity into the turn', async () => {
  const input=makeInput('code_generation',{prepareWorkspace:true,programMode:'verified_artifacts'}),cwd=await workspace(input.steps[0].files),calls=[];
  const result=await runScceNative(input,{cwd},{request:async(route,body)=>{
   calls.push({route,body});
   return route==='/api/workspace/ingest'?{status:200,body:{failed:0,workspace:{id:'workspace.actual-owner',updatedAt:42}}}:{status:422,body:{}};
  }});
  assert.equal(result.identity.reason,'turn_http_422');
  assert.deepEqual(calls.map(row=>row.route),['/api/workspace/ingest','/api/turn?full=1']);
  assert.deepEqual(calls[1].body.metadata,{workspaceProgramContext:{schema:'scce.workspace.program-context.v1',workspaceId:'workspace.actual-owner',expectedWorkspaceUpdatedAt:42}});
  assert.equal(calls[1].body.requestedAuthority,'program');
  assert.equal(Object.hasOwn(calls[1].body,'workspaceCoding'),false);
 });
