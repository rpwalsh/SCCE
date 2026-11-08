import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, readdir, rm } from 'node:fs/promises';
import { gzipSync } from 'node:zlib';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { prepareOasst } from '../prepare-oasst.mjs';
import { fileHash } from '../../blind-comparison/protocol.mjs';
import { sha256Text } from '../../sealed-eval/harness/lib/util.mjs';
const roots = [];
after(async () => { for (const root of roots) await rm(root, { recursive: true, force: true }); });
function message(id, parent, role, text, extra = {}) { return { message_id: id, parent_id: parent, message_tree_id: 'r1', role, lang: 'ca', text, review_result: true, review_count: 2, deleted: false, synthetic: false, model_name: null, ...extra }; }
async function fixture(rows) {
  const root = await mkdtemp(path.join(tmpdir(), 'scce-oasst-prepare-')); roots.push(root);
  const archive = path.join(root, 'source.messages.jsonl.gz');
  const bytes = gzipSync(rows.map(row => JSON.stringify(row)).join('\n') + '\n');
  await writeFile(archive, bytes); await writeFile(path.join(root, 'LICENSE'), 'Pinned fixture license, source metadata only.\n');
  await writeFile(path.join(root, 'capture.json'), JSON.stringify({ schema: 'scce.captured_source.v1', dataset: 'OpenAssistant/oasst1', revision: 'a'.repeat(40), file: path.basename(archive), sha256: await fileHash(archive), bytes: bytes.length, license: 'fixture-license', url: 'https://example.invalid/pinned-human-source' }));
  return { root, archive, out: path.join(root, 'prepared'), limits: { ca: 128 } };
}
async function documents(report, out) { return Promise.all(report.documents.map(async row => JSON.parse(await readFile(path.join(out, row.relativePath), 'utf8')))); }
test('root pairs preserve exact Unicode source/NFC spans, declared reply edges, flags and licensed lineage without fabricated authority', async () => {
  const rows = [message('r1', null, 'prompter', 'Qüestió 👋 amb accent.'), message('a1', 'r1', 'assistant', 'Resposta e\u0301 amb detall.'), message('a2', 'r1', 'assistant', 'Una altra branca.'), message('r2', 'a1', 'prompter', 'Segueix el fil.'), message('a3', 'r2', 'assistant', 'Continuació real.')];
  const config = await fixture(rows), report = await prepareOasst(config), [doc] = await documents(report, config.out);
  assert.equal(report.locales.ca.availableRoots, 1);
  assert.equal(report.locales.ca.verifiedCandidatePaths, 2);
  assert.equal(report.locales.ca.retainedDocuments, 1);
  assert.equal(doc.turns.length, 2);
  assert.equal(doc.turns[1].replyToTurnIndex, 0);
  assert.equal(doc.turns[1].commitmentScope, 'conversation');
  assert.ok(doc.turns.every(turn => !Object.hasOwn(turn, 'requestAuthority') && !Object.hasOwn(turn, 'supportingSourceRanges')));
  assert.equal(doc.text, doc.text.normalize('NFC'));
  for (const turn of doc.turns) assert.equal([...doc.text].slice(turn.startCodePoint, turn.endCodePoint).join(''), turn.surface);
  for (const row of doc.sourceMetadata.lineage) {
    const original = rows.find(value => value.message_id === row.id);
    assert.equal(row.originalTextSha256, sha256Text(original.text));
    assert.equal(row.nfcTextSha256, sha256Text(original.text.normalize('NFC')));
    assert.equal(row.sourceFlags.synthetic, false);
    assert.equal(row.sourceFlags.review_result, true);
    assert.equal(row.sourceFlags.model_name, null);
  }
  assert.equal((await readdir(config.out)).includes('.source-preparation-index'), false);
});
test('paths include only verified actual ancestor chains and never concatenate sibling branches or unrelated pairs', async () => {
  const rows = [message('r1', null, 'prompter', 'Original request'), message('a1', 'r1', 'assistant', 'First branch'), message('a2', 'r1', 'assistant', 'Sibling branch'), message('r2', 'a1', 'prompter', 'Real followup'), message('a3', 'r2', 'assistant', 'Real continuation'), message('foreign', null, 'prompter', 'Separate root', { message_tree_id: 'foreign' }), message('foreign-a', 'foreign', 'assistant', 'Separate reply', { message_tree_id: 'foreign' })];
  const config = await fixture(rows), report = await prepareOasst({ ...config, mode: 'paths' });
  for (const doc of await documents(report, config.out)) {
    const ids = doc.sourceMetadata.lineage.map(row => row.id);
    for (let i = 1; i < ids.length; i++) assert.equal(rows.find(row => row.message_id === ids[i]).parent_id, ids[i - 1]);
    assert.equal(ids.includes('a1') && ids.includes('a2'), false);
    assert.ok(ids.every(id => rows.find(row => row.message_id === id).message_tree_id === doc.sourceMetadata.rootMessageId));
  }
});
test('human/review/model/deletion filters retain rejection counts and cannot manufacture missing ancestors', async () => {
  const rows = [message('r1', null, 'prompter', 'Kept request'), message('good', 'r1', 'assistant', 'Kept reply'), message('model', 'r1', 'assistant', 'Model reply', { model_name: 'generator' }), message('synthetic', 'r1', 'assistant', 'Synthetic reply', { synthetic: true }), message('deleted', 'r1', 'assistant', 'Deleted reply', { deleted: true }), message('unreviewed', 'r1', 'assistant', 'Unreviewed reply', { review_result: false }), message('orphan', 'missing', 'assistant', 'No ancestor'), message('other-lang', 'r1', 'assistant', 'Different locale', { lang: 'es' })];
  const config = await fixture(rows), report = await prepareOasst(config), [doc] = await documents(report, config.out);
  assert.equal(doc.sourceMetadata.replyMessageId, 'good');
  assert.equal(report.locales.ca.sourceRejections.synthetic_model_or_unspecified, 2);
  assert.equal(report.locales.ca.sourceRejections.deleted_or_unspecified, 1);
  assert.equal(report.locales.ca.sourceRejections.not_source_reviewed, 1);
  assert.equal(report.locales.ca.pathRejections.missing_eligible_ancestor, 1);
});
test('hash-order selection is deterministic, one branch per source root, and bounded by explicit locale limits', async () => {
  const rows = [];
  for (let n = 0; n < 12; n++) {
    const id = `r${n}`;
    rows.push(message(id, null, 'prompter', `Request ${n}`, { message_tree_id: id }), message(`${id}-a`, id, 'assistant', `Reply ${n}`, { message_tree_id: id }), message(`${id}-b`, id, 'assistant', `Sibling ${n}`, { message_tree_id: id }));
  }
  const config = await fixture(rows), a = await prepareOasst({ ...config, limits: { ca: 3 } });
  const b = await prepareOasst({ ...config, out: path.join(config.root, 'second'), limits: { ca: 3 } });
  assert.deepEqual(a.documents, b.documents);
  assert.equal(a.locales.ca.availableRoots, 12);
  assert.equal(a.locales.ca.retainedDocuments, 3);
  assert.equal(new Set(a.documents.map(row => row.rootMessageId)).size, 3);
});
test('pinned archive tampering and duplicate message identities fail before any training can be invoked', async () => {
  const config = await fixture([message('r1', null, 'prompter', 'Request'), message('a1', 'r1', 'assistant', 'Reply')]);
  await writeFile(config.archive, gzipSync('tampered source\n'));
  await assert.rejects(() => prepareOasst(config), /pinned capture/);
  const duplicate = await fixture([message('r1', null, 'prompter', 'Request'), message('r1', null, 'prompter', 'Other request')]);
  await assert.rejects(() => prepareOasst(duplicate), /Duplicate source message/);
});
