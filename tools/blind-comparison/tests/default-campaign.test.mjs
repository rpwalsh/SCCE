import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, rm, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { canonical, hash, readJson, writeJson, packetFor } from '../protocol.mjs';
import { campaignOptions, prepareCampaign, custodianCampaign } from '../campaign.mjs';
import { defaultInventory, coverageGaps, createDefaultPool } from '../providers/default/cases.mjs';
import { statefulSource } from '../providers/default/native-fixtures.mjs';
import { numericSource } from '../providers/default/numeric-fixtures.mjs';
import { execute } from '../runner.mjs';
import { runReferenceNative } from '../adapters/reference-native-lib.mjs';
import { runScceNative } from '../adapters/scce-native-lib.mjs';

const roots = [];
after(async () => { for (const root of roots) await rm(root, { recursive: true, force: true }); });
async function root() { const dir = await mkdtemp(path.join(tmpdir(), 'scce-campaign-test-')); roots.push(dir); return dir; }
const capabilities = { formalLanguages: ['typescript', 'javascript', 'python', 'rust', 'go'], naturalLanguages: ['en', 'ru', 'es', 'ca'] };
function tools() {
  return Object.fromEntries(['node', ...capabilities.formalLanguages].map(language => [language, { available: true, path: process.execPath, compilerPath: process.execPath, budget: { timeMs: 10000, outputBytes: 131072 } }]));
}
async function options(base, inventory = defaultInventory(capabilities)) {
  return { seed: 'Private unit-test custodian seed; not an evaluation seed.', privateRoot: path.join(base, 'private'), inventory, tools: tools(), count: 2, attempts: 2, hiddenVectors: 4, toolCalls: 8, budgets: { timeMs: 10000, outputBytes: 131072, artifactBytes: 131072, caseBytes: 262144, maxSteps: 4 } };
}
test('default inventory unions admitted formal languages but never treats script identity as a locale or capability proof', () => {
  const inventory = defaultInventory(capabilities, [{ schema: 'scce.admitted_language_inventory.v1', formal: [{ language: 'typescript', models: 573 }, { language: 'java', models: 1 }], natural: [{ language: 'script:Latn', models: 102 }] }]);
  assert.ok(inventory.formalLanguages.includes('java'));
  assert.equal(inventory.naturalLanguages.includes('script:Latn'), false);
  assert.equal(inventory.priorFormalAdmission.find(v => v.language === 'rust').reportedCanonicalModels, 0);
  assert.equal(inventory.priorFormalAdmission.find(v => v.language === 'typescript').reportedCanonicalModels, 573);
  assert.ok(coverageGaps(inventory, tools()).some(v => v.language === 'java' && v.kind === 'missing_native_provider'));
});
test('factory creates actual six-category tasks and separate repair/generation/stateful/numeric/planning cells with opaque IDs', async () => {
  const base = await root(), o = await options(base);
  const result = await createDefaultPool(o);
  const rows = (await readFile(result.poolFile, 'utf8')).trim().split('\n').map(JSON.parse);
  assert.equal(rows.length, o.inventory.cells.length * 2);
  assert.ok(rows.every(row => /^[a-f0-9]{64}$/u.test(row.id)));
  assert.equal(new Set(rows.map(r => r.id)).size, rows.length);
  const categories = new Set(rows.map(r => r.category));
  for (const category of ['chat', 'creative', 'corpus_facts', 'learning_updates', 'code_repair_stateful', 'code_generation_stateful', 'code_repair_numeric', 'code_generation_numeric', 'agentic_autonomous', 'agentic_given_plan']) assert.ok(categories.has(category));
  for (const language of capabilities.naturalLanguages) {
    const facts = rows.filter(r => r.category === 'corpus_facts' && r.language === language);
    assert.deepEqual(facts.map(r => r.private.family).sort(), ['supported_private_paraphrase', 'unsupported_query']);
    assert.ok(facts.every(r => !r.public.outputContract.includes('negative') && !Object.hasOwn(r.public, 'private')));
    const update = rows.find(r => r.category === 'learning_updates' && r.language === language);
    assert.equal(update.public.steps.length, 2);
    assert.equal(update.public.steps[0].sources[0].id, update.public.steps[1].sources[0].id);
    assert.notEqual(update.private.expected[0].answer, update.private.expected[1].answer);
    assert.equal(update.public.steps[0].sources.some(s => s.text.includes(update.private.expected[1].answer)), false);
  }
  const stateful = rows.find(r => r.category === 'code_generation_stateful');
  const vectors = await readJson(path.join(o.privateRoot, stateful.private.files[1].path));
  const hiddenKey = vectors[0].operations.find(op => op[0] === 'W')[1];
  assert.equal(canonical(stateful.public).includes(hiddenKey), false);
  assert.ok(stateful.private.hiddenKeyCount > 0);
  const autonomous = rows.find(r => r.category === 'agentic_autonomous');
  assert.equal(Object.hasOwn(JSON.parse(autonomous.public.outputContract), 'executiveGoal'), false);
  assert.equal(JSON.parse(rows.find(r => r.category === 'agentic_given_plan').public.outputContract).operation, 'tool_use');
});
test('changing the post-freeze seed changes opaque cases and hidden inputs, without putting private keys in public packets', async () => {
  const base = await root();
  const inventory = { ...defaultInventory(capabilities), cells: [{ category: 'code_generation_stateful', language: 'javascript', grading: 'native' }] };
  const a = await options(path.join(base, 'a'), inventory), b = { ...await options(path.join(base, 'b'), inventory), seed: 'Different independent custodian seed' };
  const one = await createDefaultPool(a), two = await createDefaultPool(b);
  const first = JSON.parse((await readFile(one.poolFile, 'utf8')).split('\n')[0]);
  const second = JSON.parse((await readFile(two.poolFile, 'utf8')).split('\n')[0]);
  assert.notEqual(first.id, second.id);
  assert.notEqual(hash(first.public), hash(second.public));
  assert.notDeepEqual(await readJson(path.join(a.privateRoot, first.private.files[1].path)), await readJson(path.join(b.privateRoot, second.private.files[1].path)));
});
test('a missing provider/toolchain blocks heldout generation and is retained as explicit diagnostic error coverage', async () => {
  const base = await root(), inventory = defaultInventory({ formalLanguages: ['java'], naturalLanguages: ['en'] });
  const o = await options(base, inventory);
  await assert.rejects(() => createDefaultPool(o), /blocked by missing coverage/);
  const result = await createDefaultPool({ ...o, allowMissingCoverage: true });
  const row = (await readFile(result.poolFile, 'utf8')).trim().split('\n').map(JSON.parse).find(r => r.language === 'java');
  const input = { ...row.public, category: row.category, language: row.language, caseId: row.id, budgets: o.budgets, history: [] };
  const cwd = await root();
  const scce = await runScceNative(input, { cwd }, { request: async () => assert.fail('Missing coverage must not call product') });
  const reference = await runReferenceNative(input, { cwd }, { ask: async () => assert.fail('Missing coverage must not call model') });
  assert.equal(scce.status, 'error'); assert.equal(reference.status, 'error');
  assert.equal(scce.identity.coverageGap.kind, 'missing_native_provider');
});
test('native JS validators execute real submitted code and catch hidden-key overfit while numeric boundaries use a separate family', async () => {
  const base = await root(), inventory = { ...defaultInventory(capabilities), cells: [{ category: 'code_generation_stateful', language: 'javascript', grading: 'native' }, { category: 'code_generation_numeric', language: 'javascript', grading: 'native' }] };
  const o = await options(base, inventory), generated = await createDefaultPool(o);
  const rows = (await readFile(generated.poolFile, 'utf8')).trim().split('\n').map(JSON.parse);
  for (const row of rows) {
    const cwd = path.join(base, row.id); await mkdir(cwd);
    for (const [name, content] of Object.entries(row.public.steps[0].files)) await writeFile(path.join(cwd, name), content);
    const driver = row.public.steps[0].files['driver.cjs'];
    let source;
    if (row.category.endsWith('stateful')) {
      const match = [...driver.matchAll(/m\.(\w+)\(/gu)].map(m => m[1]);
      source = statefulSource('javascript', { write: match[0], remove: match[1], read: match[2] });
    } else source = numericSource('javascript', /m\.(\w+)\(/u.exec(driver)[1]);
    await writeFile(path.join(cwd, 'module.cjs'), source);
    const publicResult = await execute([process.execPath, 'public-check.mjs'], { cwd, input: '', timeMs: 10000, outputBytes: 131072 });
    assert.equal(publicResult.code, 0, publicResult.stderr);
    for (const f of row.private.files) await writeFile(path.join(cwd, f.target), await readFile(path.join(o.privateRoot, f.path)));
    const privateResult = await execute([process.execPath, '.sealed-check.mjs'], { cwd, input: '', timeMs: 10000, outputBytes: 131072 });
    assert.equal(privateResult.code, 0, privateResult.stderr);
    if (row.category.endsWith('stateful')) {
      const fit = JSON.parse(row.public.steps[0].files['public-vectors.json'])[0].operations;
      const allowed = [...new Set(fit.map(op => op[1]))];
      const overfit = source.replace('records[key] = value;', `if(${canonical(allowed)}.includes(key)) records[key] = value;`);
      await writeFile(path.join(cwd, 'module.cjs'), overfit);
      assert.equal((await execute([process.execPath, 'public-check.mjs'], { cwd, input: '', timeMs: 10000, outputBytes: 131072 })).code, 0);
      assert.notEqual((await execute([process.execPath, '.sealed-check.mjs'], { cwd, input: '', timeMs: 10000, outputBytes: 131072 })).code, 0);
    }
  }
});
test('autonomous reference selects and executes bounded public read/write/check tools, not a supplied plan or prose assertion', async () => {
  const base = await root(), inventory = { ...defaultInventory(capabilities), cells: [{ category: 'agentic_autonomous', language: 'en', grading: 'native' }] };
  const o = await options(base, inventory), generated = await createDefaultPool(o), row = JSON.parse((await readFile(generated.poolFile, 'utf8')).split('\n')[0]);
  const cwd = path.join(base, 'public'); await mkdir(cwd);
  for (const [name, text] of Object.entries(row.public.steps[0].files)) await writeFile(path.join(cwd, name), text);
  const input = { ...row.public, category: row.category, language: row.language, caseId: row.id, budgets: o.budgets, history: [] };
  const data = JSON.parse(row.public.steps[0].files['input.json']), sums = new Map();
  for (const r of data) sums.set(r.group, (sums.get(r.group) ?? 0) + r.value);
  const report = [...sums].sort(([a], [b]) => a.localeCompare(b)).map(([group, total]) => ({ group, total }));
  const result = await runReferenceNative(input, { cwd }, { ask: async () => ({ status: 'ok', modelDigest: 'a'.repeat(64), answer: canonical({ answer: '', artifacts: {}, complete: true, toolCalls: [{ tool: 'workspace.read', path: 'input.json' }, { tool: 'workspace.write', path: 'report.json', content: canonical(report) }, { tool: 'public.check', index: 0 }] }) }) });
  assert.equal(result.identity.productOutcome, 'completed');
  assert.equal(result.identity.trace.at(-1).publicToolReceipts.length, 3);
  assert.deepEqual(JSON.parse(result.artifacts['report.json']), report);
  const noPlan = await runReferenceNative(input, { cwd }, { ask: async () => ({ status: 'ok', modelDigest: 'a'.repeat(64), answer: canonical({ answer: 'Done.', artifacts: {}, complete: true, toolCalls: [{ tool: 'workspace.read', path: '../private/key.json' }] }) }) });
  assert.equal(noPlan.identity.productOutcome, 'failed');
});
test('bootstrap freezes before custodian seed, keeps private custody outside public roots, and refuses changed code', async () => {
  const base = await root(), frozenFile = path.join(base, 'frozen-code.mjs'); await writeFile(frozenFile, 'export const frozen=true;\n');
  const out = path.join(base, 'campaign');
  const fakeDiscovery = { config: { server: 'http://127.0.0.1:9999', schema: 'fixture', configFile: '/operator/config.json', allowedRoots: [base], token: 'PRIVATE_TEST_BEARER_NEVER_PIN' }, model: { name: 'qwen2.5:3b', digest: 'a'.repeat(64) }, tools: tools(), publicSnapshot: { candidate: { readinessHash: 'fixture-readiness' }, hardwarePolicy: { threads: 1, requestedDevice: 'cpu' }, limitations: 'Offline selftest mock; not a live measurement.' } };
  const { prepared } = await prepareCampaign({ out, diagnostic: true }, { discover: async () => fakeDiscovery, files: async () => [frozenFile] });
  assert.equal((await readFile(path.join(out, 'plan.json'), 'utf8')).includes('PRIVATE_TEST_BEARER_NEVER_PIN'), false);
  const privateRoot = path.join(base, 'custodian');
  const custody = await custodianCampaign({ preparedFile: path.join(out, 'prepared.json'), freezeDigest: prepared.freezeDigest, privateRoot });
  assert.equal(custody.independentCustodianAttested, false);
  const bundle = await readJson(path.join(custody.publicBundleRoot, 'bundle.json'));
  const packet = await packetFor(path.join(custody.publicBundleRoot, 'bundle.json'), bundle.cases[0], 4 * 1024 * 1024);
  assert.equal(Object.hasOwn(packet, 'private'), false);
  assert.equal(canonical(bundle).includes('PRIVATE_TEST_BEARER_NEVER_PIN'), false);
  assert.equal(canonical(bundle).includes(await readFile(path.join(privateRoot, 'selection-seed.txt'), 'utf8')), false);
  await writeFile(frozenFile, 'export const frozen=false;\n');
  await assert.rejects(() => custodianCampaign({ preparedFile: path.join(out, 'prepared.json'), freezeDigest: prepared.freezeDigest, privateRoot: path.join(base, 'second-private') }), /Changed pinned artifact/);
});
