import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { exportRetainedCorpus } from '../retained-corpus.mjs';
import { createRetainedPool, loadRetainedCorpus } from '../providers/retained-cases.mjs';
import { canonical, hash, readJson, packetFor } from '../protocol.mjs';
import { campaignOptions, prepareCampaign, custodianCampaign } from '../campaign.mjs';
import { admitReference } from '../campaign-reference-admission.mjs';
import { admissionExecutor } from './reference-admission-fixture.mjs';
import { referenceContextIssue } from '../adapters/reference-runner-config.mjs';
import { sha256Bytes } from '../../sealed-eval/harness/lib/util.mjs';

async function sourceFixture() {
  const authentic = await readFile(new URL('../../../packages/kernel/src/__tests__/fixtures/alice-acquisition-excerpt.txt', import.meta.url), 'utf8');
  const bytes = Buffer.from(authentic.replaceAll('\r\n', '\n').normalize('NFC'));
  const contentHash = `sha256_${sha256Bytes(bytes)}`;
  const owner = { source_version_id: 'source.version.derivative', source_id: 'source.alice', content_hash: contentHash,
    byte_length: bytes.length, canonical_uri: 'fixture://authentic-alice' };
  const evidence = { id: 'evidence.alice', source_id: owner.source_id, source_version_id: owner.source_version_id,
    content_hash: contentHash, byte_start: 0, byte_end: bytes.length, char_start: 0, char_end: [...bytes.toString('utf8')].length, status: 'promoted' };
  const queries = [];
  const client = { query: async (sql, parameters) => {
    queries.push(sql); assert.match(sql, /^\s*SELECT\b/iu);
    if (sql.includes('source_versions')) return { rows: [owner] };
    if (sql.includes('evidence_spans')) return { rows: [evidence] };
    if (sql.includes('blobs')) return { rows: [{ content: bytes, byte_length: bytes.length, range_parent_hash: null,
      range_start: null, range_end: null, archive_reference: null }] };
    throw new Error('Unexpected read-only query');
  } };
  return { bytes, contentHash, owner, evidence, queries, client };
}

test('per-case reference accounting rejects missing, changed, exhausted, or truncating contexts', () => {
  const args = ['--num-ctx', '32768', '--num-predict', '4096'];
  const valid = { status: 'ok', metadata: { contextPolicy: { truncate: false, shift: false },
    inference: { done_reason: 'stop', prompt_eval_count: 19000, eval_count: 20 }, residency: { context_length: 32768 } } };
  assert.equal(referenceContextIssue(valid, args), undefined);
  for (const [change, reason] of [
    [{ contextPolicy: { truncate: true, shift: false } }, 'no_truncation_policy_missing'],
    [{ inference: { ...valid.metadata.inference, done_reason: 'length' } }, 'incomplete_generation'],
    [{ inference: { ...valid.metadata.inference, prompt_eval_count: null } }, 'missing_token_accounting'],
    [{ residency: { context_length: 4096 } }, 'context_allocation_changed'],
    [{ inference: { ...valid.metadata.inference, eval_count: 4097 } }, 'context_or_output_budget_exceeded'],
    [{ inference: { ...valid.metadata.inference, prompt_eval_count: 32760 } }, 'context_or_output_budget_exceeded']
  ]) {
    const issue = referenceContextIssue({ ...valid, metadata: { ...valid.metadata, ...change } }, args);
    assert.equal(issue.schema, 'scce.blind-reference-context-invalid.v1'); assert.equal(issue.reason, reason);
  }
});

test('retained campaign freezes sources before custodian selection and seals five private cloze keys', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'scce-retained-campaign-')), fixture = await sourceFixture();
  try {
    const result = await exportRetainedCorpus({ out: path.join(root, 'public'), schema: 'fixture', language: 'en', sourcePrefix: 'fixture://',
      seed: 'public-source-selection', documents: 1, minBytes: 1, maxBytes: fixture.bytes.length }, { client: fixture.client });
    const frozenFile = path.join(root, 'implementation.mjs'); await writeFile(frozenFile, 'export const frozen = true;\n');
    const discovery = { config: { server: 'http://127.0.0.1:9999', schema: 'fixture', configFile: '/operator/config.json', allowedRoots: [root], token: 'PRIVATE_TEST_BEARER_NEVER_PIN' },
      model: { name: 'qwen2.5:3b', digest: 'a'.repeat(64) }, tools: { node: { available: true, path: process.execPath } },
      publicSnapshot: { candidate: { readinessHash: 'fixture-readiness' }, hardwarePolicy: { threads: 1, requestedDevice: 'cpu' }, limitations: 'Offline fixture; no live measurement.' },
      finalization: { schema: 'scce.language_identity_finalization.v1', ready: true, stable: true, recipeCurrent: true, revision: '1', profileCount: 3,
        assignedProfileCount: 3, missingProfileCount: 0, unknownIdentityCount: 0, discoveryRecipe: 'scce.language_identity_discovery.v3', identityCount: 3,
        assignmentDigest: 'a'.repeat(64), persistedCatalogDigest: 'b'.repeat(64), loadedCatalogDigest: 'b'.repeat(64),
        activeBrain: { activeBrainVersion: 'fixture.brain', activeImportRunIds: ['fixture.import'] }, competenceVerified: false } };
    const out = path.join(root, 'campaign');
    const { prepared } = await prepareCampaign({ out, diagnostic: true, retainedCorpusFile: result.manifestFile, count: 5 },
      { discover: async () => discovery, files: async () => [frozenFile], admission: config => admitReference(config, { executeCommand: admissionExecutor(), randomBytes: n => Buffer.alloc(n, 65) }) });
    const frozen = await readJson(path.join(out, 'freeze.json'));
    assert.deepEqual(frozen.plan.cells, [{ category: 'corpus_facts', language: 'en', grading: 'semantic', count: 5 }]);
    assert.equal(frozen.plan.artifacts.some(row => row.id === 'retained-source-manifest' && row.path === result.manifestFile), true);
    assert.equal(frozen.plan.artifacts.filter(row => /^retained-source-\d+$/u.test(row.id)).length, 1);
    const privateRoot = path.join(root, 'custodian');
    const custody = await custodianCampaign({ preparedFile: path.join(out, 'prepared.json'), freezeDigest: prepared.freezeDigest, privateRoot });
    assert.equal(custody.cases, 5);
    const bundleFile = path.join(custody.publicBundleRoot, 'bundle.json'), bundle = await readJson(bundleFile), key = await readJson(custody.privateKeyFile);
    assert.equal(key.cases.length, 5);
    const privateSeed = (await readFile(path.join(privateRoot, 'selection-seed.txt'), 'utf8')).trim();
    for (const row of bundle.cases) {
      const packet = await packetFor(bundleFile, row, 4 * 1024 * 1024);
      assert.equal(Object.hasOwn(packet, 'private'), false);
      assert.equal(packet.steps[0].sources[0].text, fixture.bytes.toString('utf8'));
      assert.equal(canonical(packet).includes(privateSeed), false);
      assert.equal(Object.hasOwn(JSON.parse(packet.outputContract), 'expected'), false);
    }
    assert.equal(canonical(frozen).includes('PRIVATE_TEST_BEARER_NEVER_PIN'), false);
    const corpus = await loadRetainedCorpus(result.manifestFile); await writeFile(corpus.documents[0].file, 'changed canonical export');
    await assert.rejects(custodianCampaign({ preparedFile: path.join(out, 'prepared.json'), freezeDigest: prepared.freezeDigest,
      privateRoot: path.join(root, 'second-custodian') }), /Changed pinned artifact/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('retained export writes only canonical exact UTF-8 bytes and preserves source/evidence ownership', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'scce-retained-export-')), fixture = await sourceFixture();
  try {
    const result = await exportRetainedCorpus({ out: path.join(root, 'public'), schema: 'fixture', language: 'en', sourcePrefix: 'fixture://',
      seed: 'public-selection-before-freeze', documents: 1, minBytes: 1, maxBytes: fixture.bytes.length }, { client: fixture.client });
    const corpus = await loadRetainedCorpus(result.manifestFile);
    assert.equal(result.documents, 1);
    assert.deepEqual(await readFile(corpus.documents[0].file), fixture.bytes);
    assert.equal(corpus.documents[0].binding.sourceVersionId, fixture.owner.source_version_id);
    assert.equal(corpus.documents[0].binding.contentHash, fixture.contentHash);
    assert.deepEqual(corpus.documents[0].binding.evidenceIds, [fixture.evidence.id]);
    assert.ok(fixture.queries.every(sql => /^\s*SELECT\b/iu.test(sql)));
    await assert.rejects(exportRetainedCorpus({ out: path.join(root, 'insufficient'), schema: 'fixture', language: 'en', sourcePrefix: 'fixture://',
      seed: 'public-selection-before-freeze', documents: 2, minBytes: 1, maxBytes: fixture.bytes.length }, { client: fixture.client }), /Insufficient retained canonical sources/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('five post-freeze retained cases reuse source cloze generation, keep gold private, and are seed-replayable', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'scce-retained-provider-')), fixture = await sourceFixture();
  try {
    const result = await exportRetainedCorpus({ out: path.join(root, 'public'), schema: 'fixture', language: 'en', sourcePrefix: 'fixture://',
      seed: 'public-selection-before-freeze', documents: 1, minBytes: 1, maxBytes: fixture.bytes.length }, { client: fixture.client });
    const options = { retainedCorpusFile: result.manifestFile, count: 5, seed: 'private-custodian-seed-after-freeze', budgets: { caseBytes: 4 * 1024 * 1024 } };
    const build = async (name, seed = options.seed) => {
      const pool = await createRetainedPool({ ...options, seed, privateRoot: path.join(root, name) });
      return (await readFile(pool.poolFile, 'utf8')).trim().split('\n').map(JSON.parse);
    };
    const first = await build('private-a'), replay = await build('private-b'), changed = await build('private-c', 'independent-new-custodian-seed');
    assert.equal(first.length, 5);
    assert.deepEqual(first, replay);
    assert.notEqual(hash(first), hash(changed));
    assert.equal(new Set(first.map(row => row.id)).size, 5);
    for (const row of first) {
      assert.equal(row.private.family, 'retained_source_cloze');
      assert.equal(row.grading, 'semantic');
      assert.equal(row.public.steps.length, 1);
      assert.equal(row.public.steps[0].sources[0].text, fixture.bytes.toString('utf8'));
      assert.equal(row.public.steps[0].prompt.includes('____'), true);
      assert.equal(Object.hasOwn(row.public, 'private'), false);
      const contract = JSON.parse(row.public.outputContract);
      assert.deepEqual(contract.retainedSources.sources[0].evidenceIds, [fixture.evidence.id]);
      for (const forbidden of ['gold', 'expected', 'answerStart', 'answerEnd', 'acceptedAnswers']) assert.equal(Object.hasOwn(contract, forbidden), false);
      const witness = row.private.provenance;
      assert.equal(fixture.bytes.toString('utf8').slice(witness.answerStart, witness.answerEnd), row.private.expected[0].answer);
      assert.equal(row.private.expected[0].status, 'answered');
    }
    const corpus = await loadRetainedCorpus(result.manifestFile);
    await writeFile(corpus.documents[0].file, 'changed after freeze');
    await assert.rejects(createRetainedPool({ ...options, privateRoot: path.join(root, 'private-d') }), /hash differs/);
    assert.equal(campaignOptions({ retainedCorpusFile: result.manifestFile }).count, 5);
    assert.throws(() => campaignOptions({ count: 5 }), /even default/);
  } finally { await rm(root, { recursive: true, force: true }); }
});
