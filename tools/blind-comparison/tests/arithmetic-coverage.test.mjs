import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { arithmeticCase } from '../providers/default/arithmetic-cases.mjs';
import { defaultInventory, createDefaultPool, randomStream } from '../providers/default/cases.mjs';
import { canonical, hash, validateCase } from '../protocol.mjs';
import { exactIntegerCheck, semanticCheck } from '../grading.mjs';
import { nativeContract } from '../adapters/native-contract.mjs';
import { runScceNative } from '../adapters/scce-native-lib.mjs';
import { runReferenceNative } from '../adapters/reference-native-lib.mjs';

const roots = [];
after(async () => { for (const root of roots) await rm(root, { recursive: true, force: true }); });
async function workspace() { const dir = await mkdtemp(path.join(tmpdir(), 'blind-arithmetic-test-')); roots.push(dir); return dir; }
const languages = ['en', 'ru', 'es', 'ca'];
const capabilities = { formalLanguages: ['typescript', 'javascript', 'python', 'rust', 'go'], naturalLanguages: languages };
const budgets = { timeMs: 10000, outputBytes: 131072, artifactBytes: 131072, caseBytes: 262144, maxSteps: 4 };
const outputs = answer => [{ response: { status: 'ok', answer, artifacts: {} } }];

test('adds all four ordinary arithmetic cells without removing any existing default cell', () => {
  const inventory = defaultInventory(capabilities);
  assert.equal(inventory.cells.length, 48);
  const old = [];
  for (const language of languages) for (const category of ['chat', 'creative', 'corpus_facts', 'learning_updates', 'agentic_autonomous', 'agentic_given_plan'])
    old.push({ language, category, grading: ['chat', 'creative'].includes(category) ? 'human' : category === 'agentic_autonomous' ? 'native' : 'semantic' });
  for (const language of capabilities.formalLanguages) for (const category of ['code_repair_stateful', 'code_generation_stateful', 'code_repair_numeric', 'code_generation_numeric']) old.push({ language, category, grading: 'native' });
  assert.equal(old.length, 44);
  for (const cell of old) assert.ok(inventory.cells.some(row => canonical(row) === canonical(cell)));
  assert.deepEqual(inventory.cells.filter(row => row.category === 'math_reasoning').map(row => row.language).sort(), [...languages].sort());
});

test('balances private families with fresh seeded inputs and exposes no solutions or execution hints', async () => {
  const base = await workspace(), inventory = { ...defaultInventory({ formalLanguages: [], naturalLanguages: languages }) };
  inventory.cells = inventory.cells.filter(row => row.category === 'math_reasoning');
  const settings = { seed: 'New unit-test seed, never an evaluation seed', privateRoot: path.join(base, 'private'), inventory, tools: {}, count: 2, attempts: 3, budgets };
  const pool = await createDefaultPool(settings);
  assert.equal(pool.cases, 8);
  const rows = (await readFile(pool.poolFile, 'utf8')).trim().split('\n').map(JSON.parse);
  assert.equal(rows.length, 8);
  for (const language of languages) {
    const local = rows.filter(row => row.language === language);
    assert.deepEqual(local.map(row => row.private.family).sort(), ['unitless_multistep_arithmetic', 'unitless_single_operation']);
    for (const row of local) {
      validateCase(row, { cells: inventory.cells, budgets });
      const contract = JSON.parse(row.public.outputContract);
      assert.equal(contract.operation, 'turn'); assert.equal(contract.maxPublicAttempts, settings.attempts);
      assert.equal(contract.requestedAuthority, undefined); assert.equal(contract.answerMode, undefined);
      assert.deepEqual(row.public.steps[0].sources, []); assert.deepEqual(row.public.steps[0].files, {});
      assert.equal(row.private.answerType, 'exact_integer');
      assert.ok(!canonical(row.public).includes('expected')); assert.ok(!canonical(row.public).includes('family'));
      assert.ok(!/[+*/=]/u.test(row.public.steps[0].prompt));
      assert.notEqual(hash(row.public), hash(arithmeticCase(row, 0, randomStream('Another private unit seed', language)).public));
    }
  }
});

test('computes exact private results for each natural-language operation and multistep order', () => {
  for (const language of languages) for (let operation = 0; operation < 4; operation++) for (const multi of [false, true]) {
    const values = [operation, 5, 9, 13], generated = arithmeticCase({ language }, multi ? 1 : 0, { integer: () => values.shift() });
    const expected = (multi ? ['270', '-60', '92', '-8'] : ['18', '-4', '77', '7'])[operation];
    assert.deepEqual(generated.private.expected, [expected]);
    assert.deepEqual(exactIntegerCheck(generated.private.expected, outputs(expected)), { pass: true, reason: null });
  }
});

test('exact integer grading rejects refusals, incorrect values, equations and additional numeric answers', () => {
  for (const answer of ['123', '+123', '000123', ' 123\n']) assert.equal(exactIntegerCheck(['123'], outputs(answer)).pass, true);
  for (const answer of ['', 'I cannot answer', 'нет ответа', 'no ho sé', '124', '123 124', '123\n123', '100 + 23 = 123', 'Answer: 123', '123.', '[123]', '"123"', 'null', 'NaN', '1.23e2', 123])
    assert.equal(exactIntegerCheck(['123'], outputs(answer)).pass, false, String(answer));
  assert.equal(exactIntegerCheck(['-8'], outputs('-8')).pass, true);
  assert.equal(exactIntegerCheck(['0'], outputs('-0')).pass, true);
  assert.equal(exactIntegerCheck(['1'], []).pass, false);
  assert.equal(semanticCheck(['123'], outputs('123'), 'exact_integer').pass, true);
  assert.equal(semanticCheck(['123'], outputs('124'), 'exact_integer').pass, false);
  assert.throws(() => exactIntegerCheck([123], outputs('123')), /Invalid private/);
  assert.equal(semanticCheck([{ status: 'abstained', answer: null }], outputs('{"status":"abstained","answer":null}')).pass, true);
  assert.throws(() => semanticCheck(['123'], outputs('123'), 'unknown_grader'), /Unknown private/);
});

test('both native adapters keep arithmetic on their ordinary text turn without numeric schema or calculator routes', async () => {
  const generated = arithmeticCase({ language: 'ca' }, 1, randomStream('Public flow unit-test seed', 'ordinary'));
  const input = { ...generated.public, schema: 'scce.blind-input.v1', caseId: 'ordinary-arithmetic-unit', category: 'math_reasoning', language: 'ca', history: [], budgets };
  const cwd = await workspace(), answer = generated.private.expected[0], calls = [];
  const candidate = await runScceNative(input, { cwd }, { request: async (route, body) => {
    calls.push({ route, body }); return { status: 200, body: { answer, episodeId: 'ordinary.turn' } };
  } });
  assert.equal(calls.length, 1); assert.equal(calls[0].route, '/api/turn?full=1');
  assert.equal(calls[0].body.requestedAuthority, undefined);
  assert.ok(calls[0].body.text.includes(input.steps[0].prompt));
  const reference = await runReferenceNative(input, { cwd }, { ask: async (prompt, options) => {
    assert.ok(prompt.includes(input.steps[0].prompt)); assert.equal(options.format, undefined);
    assert.equal(prompt.includes('exact_integer'), false); assert.equal(prompt.includes('unitless_multistep_arithmetic'), false);
    return { status: 'ok', answer, modelDigest: 'a'.repeat(64) };
  } });
  assert.equal(candidate.answer, answer); assert.equal(reference.answer, answer);
  assert.equal(exactIntegerCheck(generated.private.expected, outputs(candidate.answer)).pass, true);
  for (const extra of [{ requestedAuthority: 'factual' }, { operation: 'tool_use' }])
    assert.throws(() => nativeContract({ ...input, outputContract: canonical({ ...JSON.parse(input.outputContract), ...extra }) }), /ordinary source-free turn/);
});
