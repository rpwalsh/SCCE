import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { canonical } from '../protocol.mjs';
import { sha256Text } from '../../sealed-eval/harness/lib/util.mjs';
import { nativeContract } from '../adapters/native-contract.mjs';
import { verifyRetainedSources } from '../adapters/retained-sources.mjs';
import { runScceNative } from '../adapters/scce-native-lib.mjs';
import { runReferenceNative } from '../adapters/reference-native-lib.mjs';

function fixture() {
  const text = '🧭 민수는 서울에 산다. ليلى تقيم في بغداد.';
  const bytes = Buffer.from(text), start = [...text.slice(0, text.indexOf('ليلى'))].length;
  const fragment = [...text].slice(start).join(''), fragmentBytes = Buffer.from(fragment);
  const contentHash = `sha256_${sha256Text(text)}`, fragmentHash = `sha256_${sha256Text(fragment)}`;
  const source = { id: 'public.book', sourceId: 'source.book', sourceVersionId: 'version.book', contentHash, canonicalUri: 'fixture://book', evidenceIds: ['evidence.book'] };
  const owner = { source_version_id: source.sourceVersionId, source_id: source.sourceId, content_hash: contentHash, canonical_uri: source.canonicalUri, byte_length: bytes.length };
  const evidence = { id: 'evidence.book', source_id: source.sourceId, source_version_id: source.sourceVersionId, content_hash: fragmentHash,
    byte_start: bytes.length - fragmentBytes.length, byte_end: bytes.length, char_start: start, char_end: [...text].length, status: 'promoted' };
  const blobs = new Map([[contentHash, { content: bytes, byte_length: bytes.length, range_parent_hash: null, range_start: null, range_end: null, archive_reference: null }],
    [fragmentHash, { content: Buffer.alloc(0), byte_length: fragmentBytes.length, range_parent_hash: contentHash,
      range_start: evidence.byte_start, range_end: evidence.byte_end, archive_reference: null }]]);
  const calls = [], blobHashes = [];
  const state = { owners: [owner], evidence: [evidence] };
  const client = { query: async (sql, params) => {
    calls.push(sql);
    assert.match(sql, /^\s*SELECT\b/iu);
    if (sql.includes('source_versions')) return { rows: state.owners };
    if (sql.includes('evidence_spans')) return { rows: state.evidence };
    if (sql.includes('FROM "fixture"."blobs"')) { blobHashes.push(params[0]); return { rows: blobs.has(params[0]) ? [blobs.get(params[0])] : [] }; }
    throw new Error('Unexpected canonical query');
  } };
  const contract = { schema: 'scce.blind-native-task.v1', operation: 'turn', maxPublicAttempts: 1, writablePaths: [], publicChecks: [], approvals: [],
    requestedAuthority: 'factual', answerMode: 'answer_or_abstain', retainedSources: { schema: 'scce.blind-retained-sources.v1', sources: [source] } };
  const input = { schema: 'scce.blind-input.v1', caseId: 'retained-case', category: 'corpus_facts', language: 'ko', outputContract: canonical(contract),
    steps: [{ prompt: '🧭 ____', sources: [{ id: source.id, text }], files: {} }], history: [],
    budgets: { timeMs: 10000, outputBytes: 131072, caseBytes: 262144, artifactBytes: 65536, maxSteps: 4 }, isolation: { mode: 'trusted-host' } };
  const verify = () => verifyRetainedSources({ input, contract: nativeContract(input), client, schema: 'fixture' });
  const publicEvidence = { id: evidence.id, sourceId: source.sourceId, sourceVersionId: source.sourceVersionId, contentHash: fragmentHash, status: 'promoted' };
  return { input, contract, source, owner, evidence, blobs, state, client, calls, blobHashes, text, contentHash, fragmentHash, verify, publicEvidence };
}

test('canonical retained source verification reuses the real blob/range reader and exact Unicode coordinates', async () => {
  const f = fixture(), receipt = await f.verify();
  assert.equal(receipt.sources[0].contentHash, f.contentHash);
  assert.deepEqual(receipt.sources[0].evidence, [{ id: f.evidence.id, contentHash: f.fragmentHash }]);
  assert.deepEqual(new Set(f.blobHashes), new Set([f.contentHash, f.fragmentHash]));
  assert.ok(f.calls.every(sql => /^\s*SELECT\b/iu.test(sql)));
});

for (const change of ['source', 'version', 'uri', 'hash', 'missing-evidence', 'quarantine', 'coordinates', 'blob']) test(`rejects changed retained ${change} before a turn`, async () => {
  const f = fixture();
  if (change === 'source') f.owner.source_id = 'foreign.source';
  else if (change === 'version') f.owner.source_version_id = 'foreign.version';
  else if (change === 'uri') f.owner.canonical_uri = 'fixture://foreign';
  else if (change === 'hash') f.owner.content_hash = `sha256_${'0'.repeat(64)}`;
  else if (change === 'missing-evidence') f.state.evidence = [];
  else if (change === 'quarantine') f.evidence.status = 'quarantined';
  else if (change === 'coordinates') f.evidence.char_start++;
  else f.blobs.get(f.contentHash).content = Buffer.from('changed');
  await assert.rejects(f.verify());
});

test('all visible source packets must have exact mandatory manifest bindings and cannot declare an update', () => {
  for (const mutate of [
    f => { f.input.steps[0].sources = []; },
    f => { f.input.steps[0].sources.push({ id: 'undeclared', text: 'foreign' }); },
    f => { f.input.steps[0].sources[0].text += 'changed'; },
    f => { f.contract.retainedSources.sources[0].evidenceIds = []; f.input.outputContract = canonical(f.contract); },
    f => { f.contract.operation = 'learning_update'; f.input.outputContract = canonical(f.contract); }
  ]) { const f = fixture(); mutate(f); assert.throws(() => nativeContract(f.input), /[Rr]etained|Every public source/); }
});

test('both native adapters receive identical verified public bytes while candidate skips every ingestion route', async () => {
  const f = fixture(), root = await mkdtemp(path.join(tmpdir(), 'scce-retained-source-'));
  const calls = [], prompts = [];
  try {
    const candidate = await runScceNative(f.input, { cwd: root }, {
      verifyRetainedSources: async () => f.verify(),
      request: async (route, body) => { calls.push({ route, body }); return { status: 200, body: { answer: 'بغداد', evidence: [f.publicEvidence] } }; }
    });
    const reference = await runReferenceNative(f.input, { cwd: root, expectedModelDigest: 'a'.repeat(64) }, { ask: async prompt => {
      prompts.push(prompt); return { status: 'ok', answer: canonical({ status: 'answered', answer: 'بغداد' }), modelDigest: 'a'.repeat(64) };
    } });
    assert.deepEqual(calls.map(call => call.route), ['/api/turn']);
    assert.equal(calls[0].body.text, f.input.steps[0].prompt);
    assert.ok(prompts[0].includes(f.text));
    assert.equal(candidate.answer, reference.answer);
    assert.equal(candidate.identity.publicContextHash, reference.identity.publicContextHash);
    assert.deepEqual(candidate.identity.publicSourceRevisions, reference.identity.publicSourceRevisions);
    assert.equal(candidate.identity.productOutcome, 'completed');
    assert.equal(candidate.identity.trace[0].retainedSourceVerification.sources[0].sourceVersionId, f.source.sourceVersionId);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('a retained answer with foreign or absent evidence fails instead of silently using another corpus', async () => {
  const f = fixture(), root = await mkdtemp(path.join(tmpdir(), 'scce-retained-source-'));
  try {
    for (const evidence of [[], [{ ...f.publicEvidence, sourceId: 'foreign.source' }], [{ ...f.publicEvidence, contentHash: f.contentHash }]]) {
      const result = await runScceNative(f.input, { cwd: root }, { verifyRetainedSources: async () => f.verify(),
        request: async () => ({ status: 200, body: { answer: 'بغداد', evidence } }) });
      assert.equal(result.identity.reason, 'retained_source_answer_provenance_mismatch');
    }
    let turns = 0;
    f.state.evidence = [];
    await assert.rejects(runScceNative(f.input, { cwd: root }, { verifyRetainedSources: async () => f.verify(),
      request: async () => { turns++; throw Error('must not run'); } }));
    assert.equal(turns, 0);
  } finally { await rm(root, { recursive: true, force: true }); }
});
