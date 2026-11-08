import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, cp, readFile, writeFile, rm, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { smoke } from '../smoke.mjs';
import { hash, canonical, readJson, fileHash, signed, verified, freeze, seal, checkFreeze, validateCase, validatePlan, jsonLines, writeJson } from '../protocol.mjs';
import { collect, checkpoint, execute, checkJournal, receiptName, readReceipt, materializeFiles } from '../runner.mjs';
import { grade, semanticCheck } from '../grading.mjs';

let root, base, options;
before(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'scce-blind-'));
  base = path.join(root, 'base');
  options = await smoke(base);
});
after(async () => { await rm(root, { recursive: true, force: true }); });
async function fresh(name) {
  const out = path.join(root, name);
  await cp(options.out, out, { recursive: true });
  return { ...options, out, reportFile: path.join(root, `${name}-report.json`) };
}
test('complete runnable rehearsal exposes every category, native failure, negative facts and pending human cells', async () => {
  const report = await readJson(options.reportFile);
  assert.equal(report.comparativeGatePassed, false);
  assert.equal(report.purpose, 'rehearsal');
  assert.equal(report.cells.length, 6);
  assert.equal(report.cells.find(c => c.category === 'code').wins, 1);
  assert.equal(report.cells.find(c => c.category === 'corpus_facts').ties, 1);
  assert.equal(report.cells.find(c => c.category === 'chat').ungraded, 1);
  assert.equal(report.cells.find(c => c.category === 'creative').ungraded, 1);
  assert.ok(report.cells.every(c => !c.passesPreregisteredGate));
});
test('cold persisted semantic checks require complete exact JSON, including negative types and extra fields', () => {
  const out = answer => [{ response: { answer } }];
  const expected = [{ value: null, supported: false }];
  assert.equal(semanticCheck(expected, out('{"supported":false,"value":null}')).pass, true);
  for (const answer of ['unknown', '{"value":"null","supported":false}', '{"value":null,"supported":true}', '{"value":null,"supported":false,"guess":1}']) assert.equal(semanticCheck(expected, out(answer)).pass, false);
});
test('resume accepts identical committed receipts without changing the journal or invoking adapters', async () => {
  const o = await fresh('resume');
  const first = await fileHash(path.join(o.out, 'journal-0.jsonl'));
  await collect(o);
  assert.equal(await fileHash(path.join(o.out, 'journal-0.jsonl')), first);
  const point = await checkpoint({ ...o, checkpointFile: path.join(root, 'resume-point.json') });
  assert.equal(point.digest, o.checkpointDigest);
});
test('public schema rejects private grading data and path traversal at every structured boundary', async () => {
  const bundle = await readJson(options.bundleFile);
  const key = await readJson(options.keyFile);
  const row = structuredClone(key.cases.find(c => c.grading === 'semantic'));
  delete row.packetHash;
  validateCase(row, bundle.plan);
  for (const mutate of [r => { r.public.gold = 'leak'; }, r => { r.public.outputContract = { gold: 'leak' }; }, r => { r.public.steps[0].private = {}; }, r => { r.public.steps[0].sources[0].expected = 'leak'; }, r => { r.public.steps[0].files['../private'] = 'leak'; }, r => { r.public.steps[0].files['C:/private'] = 'leak'; }]) {
    const bad = structuredClone(row); mutate(bad);
    assert.throws(() => validateCase(bad, bundle.plan));
  }
  const publicFiles = await readdir(path.join(path.dirname(options.bundleFile), 'cases'));
  for (const file of publicFiles) {
    const packet = await readJson(path.join(path.dirname(options.bundleFile), 'cases', file));
    assert.equal(Object.hasOwn(packet, 'private'), false);
    assert.equal(Object.hasOwn(packet, 'expected'), false);
  }
});
test('source updates are hidden until their step and both systems record equal public inputs', async () => {
  const bundle = await readJson(options.bundleFile);
  const receipts = await Promise.all(bundle.plan.systems.map(s => readReceipt(options.out, 'learning_updates', s.id)));
  for (const r of receipts) {
    assert.deepEqual(r.outputs.map(o => JSON.parse(o.response.answer).value), ['Larch', 'Birch']);
    assert.equal(r.outputs.some(o => Object.hasOwn(o.response, 'identity')), false);
  }
  assert.deepEqual(receipts[0].outputs.map(o => o.publicInputHash), receipts[1].outputs.map(o => o.publicInputHash));
});
test('changing private gold while recomputing its local hash fails the public commitment', async () => {
  const o = await fresh('gold');
  const key = await readJson(o.keyFile);
  key.cases.find(c => c.grading === 'semantic').private.expected[0].value = 'tampered';
  const { digest, ...body } = key;
  o.keyFile = path.join(root, 'tampered-key.json');
  await writeJson(o.keyFile, signed(body));
  await assert.rejects(() => grade(o), /gold or rubric changed/);
});
test('self-hash edits and independently recorded freeze digest changes are detected', async () => {
  const file = path.join(base, 'freeze.json');
  const frozen = await readJson(file);
  const altered = structuredClone(frozen); altered.plan.purpose = 'heldout';
  assert.throws(() => verified(altered), /Commitment/);
  await assert.rejects(() => checkFreeze(file, '0'.repeat(64)), /Commitment/);
  const local = path.join(root, 'frozen-artifact.txt');
  await writeFile(local, 'before');
  const plan = structuredClone(frozen.plan);
  plan.artifacts.push({ id: 'extra-corpus', role: 'corpus', path: local });
  const planFile = path.join(root, 'changed-plan.json');
  await writeJson(planFile, plan);
  const extra = path.join(root, 'changed-freeze.json');
  const result = await freeze(planFile, extra);
  await writeFile(local, 'after');
  await assert.rejects(() => checkFreeze(extra, result.digest), /Changed pinned artifact/);
});
test('a changed adapter budget receipt is rejected even with a recomputed local digest', async () => {
  const o = await fresh('asymmetry');
  const file = path.join(o.out, 'receipts', receiptName('code', 'candidate-fixture'));
  const { digest, ...r } = await readJson(file);
  r.budgetsHash = hash({ different: true });
  await writeFile(file, canonical(signed(r)));
  await assert.rejects(() => grade(o), /Commitment|Asymmetric/);
});
test('journal changes, missing receipts and coherent rehashed output rewrites cannot pass the retained checkpoint', async () => {
  const o = await fresh('rewrite');
  const journal = path.join(o.out, 'journal-0.jsonl');
  const events = [];
  let previous = o.bundleDigest;
  for await (const old of jsonLines(journal, 65536)) {
    const file = path.join(o.out, 'receipts', old.receipt);
    const { digest, ...body } = await readJson(file);
    if (body.caseId === 'chat') body.outputs[0].response.answer = 'rewritten after collection';
    const replacement = signed(body);
    await writeFile(file, canonical(replacement));
    const event = signed({ bundleDigest: o.bundleDigest, previous, receipt: old.receipt, receiptDigest: replacement.digest });
    previous = event.digest; events.push(event);
  }
  await writeFile(journal, events.map(canonical).join('\n') + '\n');
  await assert.rejects(() => grade(o), /changed since checkpoint/);
  const missing = await fresh('missing-receipt');
  await rm(path.join(missing.out, 'receipts', events[0].receipt));
  await assert.rejects(() => checkJournal(missing.out, missing.bundleDigest, 0), /ENOENT/);
});
test('partial shard collection is resumable and preserves missing cells instead of hiding them', async () => {
  const o = { ...options, out: path.join(root, 'partial'), checkpointFile: path.join(root, 'partial-checkpoint.json'), reportFile: path.join(root, 'partial-report.json'), shardCount: 2, shardIndex: 0 };
  await collect(o);
  o.checkpointDigest = (await checkpoint(o)).digest;
  const report = await grade(o);
  assert.ok(report.cells.some(c => c.missing));
  assert.equal(report.cells.length, 6);
  assert.equal(report.comparativeGatePassed, false);
  await assert.rejects(() => collect({ ...o, shardCount: 1 }), /shard count changed/);
});
test('only registered, complete human ballots are accepted; rehearsal cannot become superiority evidence', async () => {
  const o = await fresh('ratings');
  const index = await readJson(path.join(options.ballotsDir, 'index.json'));
  const ratings = [];
  for (const id of index.ballots) {
    const ballot = await readJson(path.join(options.ballotsDir, `${id}.json`));
    assert.equal(Object.hasOwn(ballot, 'elapsedMs'), false);
    assert.equal(Object.hasOwn(ballot, 'systemId'), false);
    ratings.push({ ballotId: id, judgeId: 'independent-judge', humanAttestation: true, preference: 'tie', scores: Object.fromEntries(['A', 'B'].map(side => [side, Object.fromEntries(ballot.dimensions.map(d => [d, 2]))])), rationale: 'Equivalent complete rehearsal responses.' });
  }
  o.ratingsFile = path.join(root, 'ratings.json');
  await writeJson(o.ratingsFile, ratings);
  o.ratingsDigest = await fileHash(o.ratingsFile);
  const report = await grade(o);
  assert.equal(report.cells.find(c => c.category === 'chat').ungraded, 0);
  assert.equal(report.comparativeGatePassed, false);
  ratings[0].humanAttestation = false;
  await writeFile(o.ratingsFile, canonical(ratings));
  o.ratingsDigest = await fileHash(o.ratingsFile);
  o.reportFile = path.join(root, 'bad-ratings-report.json');
  await assert.rejects(() => grade(o), /Independent human/);
});
test('process provider strips undeclared secrets and bounds output and wall time', async () => {
  process.env.SCCE_PRIVATE_EVAL_CANARY = 'not-public';
  try {
    const env = await execute([process.execPath, '-e', 'console.log(process.env.SCCE_PRIVATE_EVAL_CANARY ?? "scrubbed")'], { cwd: root, input: '', timeMs: 5000, outputBytes: 1000 });
    assert.equal(env.stdout.trim(), 'scrubbed');
    const output = await execute([process.execPath, '-e', 'console.log("x".repeat(10000))'], { cwd: root, input: '', timeMs: 5000, outputBytes: 100 });
    assert.equal(output.failure, 'output-budget');
    const time = await execute([process.execPath, '-e', 'setTimeout(()=>{},10000)'], { cwd: root, input: '', timeMs: 20, outputBytes: 100 });
    assert.equal(time.failure, 'time-budget');
  } finally { delete process.env.SCCE_PRIVATE_EVAL_CANARY; }
});
test('bounded streaming parser rejects oversized rows and seal rejects duplicate or unsorted provider IDs', async () => {
  const file = path.join(root, 'oversized.jsonl');
  await writeFile(file, JSON.stringify({ big: 'x'.repeat(100) }));
  await assert.rejects(async () => { for await (const row of jsonLines(file, 10)) assert.fail(row); }, /byte budget/);
  const rows = (await readFile(path.join(base, 'pool.jsonl'), 'utf8')).trim().split('\n');
  const bad = path.join(root, 'duplicate-pool.jsonl');
  await writeFile(bad, `${rows[0]}\n${rows[0]}\n`);
  const frozen = await readJson(path.join(base, 'freeze.json'));
  await assert.rejects(() => seal({ freezeFile: path.join(base, 'freeze.json'), freezeDigest: frozen.digest, poolFile: bad, seedFile: path.join(base, 'seed.txt'), outDir: path.join(root, 'bad-seal') }), /unique and sorted/);
});
test('heldout campaigns reject unpinned models, unequal corpus access and omitted independent language cells', async () => {
  const plan = await readJson(path.join(base, 'plan.json'));
  plan.purpose = 'heldout';
  assert.throws(() => validatePlan(plan), /Qwen/);
  const inventory = path.join(root, 'coverage.json');
  await writeJson(inventory, { cells: [...plan.cells, { category: 'code', language: 'python', grading: 'native' }] });
  plan.artifacts.push({ id: 'model', role: 'model', path: inventory }, { id: 'coverage', role: 'coverage', path: inventory });
  plan.coverageInventoryArtifact = 'coverage';
  plan.systems[1].identity = { model: 'qwen2.5:3b' };
  plan.systems[1].expectedModelDigest = 'f'.repeat(64);
  plan.systems[0].preparation = { publicCorpusArtifacts: ['corpus'], receiptArtifact: 'isolation' };
  plan.systems[1].preparation = { publicCorpusArtifacts: [], receiptArtifact: 'isolation' };
  assert.throws(() => validatePlan(plan), /identical pinned public corpus/);
  plan.systems[1].preparation.publicCorpusArtifacts = ['corpus'];
  validatePlan(plan);
  const file = path.join(root, 'heldout-plan.json');
  await writeJson(file, plan);
  await assert.rejects(() => freeze(file, path.join(root, 'heldout-freeze.json')), /Missing required coverage.*python/);
});
test('Unicode output survives byte-split process chunks without changing the semantic contract', async () => {
  const text = 'Привет 世界 👋';
  const script = `const b=Buffer.from(${JSON.stringify(text)});let i=0;const t=setInterval(()=>{process.stdout.write(b.subarray(i,i+1));if(++i===b.length)clearInterval(t)},1)`;
  const result = await execute([process.execPath, '-e', script], { cwd: root, input: '', timeMs: 5000, outputBytes: 1000 });
  assert.equal(result.stdout, text);
  assert.equal(result.bytes, Buffer.byteLength(text));
});
test('multistep native work preserves prior submitted edits and explicit later public corrections', () => {
  const steps = [{ files: { 'a.py': 'old', 'b.rs': 'old' } }, { files: { 'b.rs': 'public correction' } }, { files: {} }];
  const outputs = [{ response: { artifacts: { 'a.py': 'fixed', 'b.rs': 'fixed' } } }, { response: { artifacts: {} } }];
  assert.deepEqual({ ...materializeFiles(steps, outputs) }, { 'a.py': 'fixed', 'b.rs': 'public correction' });
});
