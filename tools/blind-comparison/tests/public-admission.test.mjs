import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { exportPublicAdmission, requirePublicAccess } from '../export-public-admission.mjs';
import { admissionArtifacts } from '../public-admission.mjs';
import { defaultInventory } from '../providers/default/cases.mjs';
import { prepareCampaign } from '../campaign.mjs';
import { admitReference } from '../campaign-reference-admission.mjs';
import { admissionExecutor } from './reference-admission-fixture.mjs';

const label = { tenantId: 'fixture', principals: [], compartments: [], exportClass: 'public', mergePolicy: 'same_owner' };
const access = { tenantId: 'fixture', principalId: 'operator', compartments: [], maximumExportClass: 'restricted' };
const bytes = Buffer.from('Exact retained public source. \u{1f9ed}\n');
const contentHash = `sha256_${createHash('sha256').update(bytes).digest('hex')}`;
async function fixture(t, overrides = {}) {
  const out = await mkdtemp(path.join(tmpdir(), 'scce-public-export-test-'));
  t.after(() => rm(out, { recursive: true, force: true }));
  const state = { owner: { id: 'version.a', source_id: 'source.a', content_hash: contentHash, byte_length: bytes.length,
    media_type: 'text/plain', observed_at: '2026-11-15T00:00:00Z', canonical_uri: 'fixture://a', current: true, information_label: label },
    evidence: { id: 'evidence.a', source_id: 'source.a', source_version_id: 'version.a', content_hash: contentHash,
      byte_start: 0, byte_end: bytes.length, char_start: 0, char_end: [...bytes.toString()].length, status: 'promoted', information_label: label },
    readBytes: 0, ...overrides };
  const calls = [], client = { query: async (sql, params) => {
    calls.push(sql); assert.match(sql, /^\s*SELECT\b/iu);
    if (sql.includes('sv.id>$1')) return { rows: params[0] ? [] : [state.owner] };
    if (sql.includes('evidence_spans') && !sql.includes('source_versions')) return { rows: params[1] ? [] : [state.evidence] };
    if (sql.includes('language_profiles') || sql.includes('ngram_models')) return { rows: [] };
    throw new Error(`Unexpected fixture query: ${sql}`);
  } };
  const options = { out, schema: 'fixture', informationAccess: access, allPublicCurrent: true };
  const dependencies = { client, reader: { bytes: async () => { state.readBytes++; return state.bytes ?? bytes; } } };
  return { out, state, calls, options, dependencies, run: () => exportPublicAdmission(options, dependencies) };
}
test('exports exact public initial priors, pins bytes and reuses only hash-verified files', async t => {
  const f = await fixture(t); f.state.owner.observed_at = new Date('2026-11-15T00:00:00Z');
  const result = await f.run();
  const manifest = JSON.parse(await readFile(result.manifestFile, 'utf8'));
  assert.equal(manifest.sourceCount, 1); assert.equal(manifest.counts.evidence, 1);
  assert.equal(manifest.sources[0].naturalLanguage, undefined);
  assert.equal(JSON.parse((await readFile(path.join(f.out, 'sources.jsonl'), 'utf8')).trim()).observedAt, '2026-11-15T00:00:00.000Z');
  assert.equal((await admissionArtifacts(manifest, result.manifestFile)).length, 3);
  const capabilities = { formalLanguages: ['typescript'], naturalLanguages: ['en'] };
  assert.deepEqual(defaultInventory(capabilities, [manifest]).cells, defaultInventory(capabilities).cells);
  await f.run(); assert.equal(f.state.readBytes, 1);
  const target = path.join(f.out, `corpus/${contentHash.slice(7)}.bin`);
  await writeFile(target, Buffer.alloc(bytes.length)); await f.run(); assert.equal(f.state.readBytes, 2);
  assert.deepEqual(await readFile(target), bytes); assert.ok(f.calls.every(sql => /^\s*SELECT\b/iu.test(sql)));
});
test('explicit source selection rejects private/access restricted records without exporting their bytes', async t => {
  for (const change of [{ exportClass: 'restricted', principals: ['operator'] }, { principals: ['someone-else'] }, { compartments: ['private'] }]) {
    const f = await fixture(t); f.state.owner.information_label = { ...label, ...change };
    f.options.allPublicCurrent = false; f.options.selection = { sources: [{ sourceVersionId: 'version.a', contentHash }] };
    await assert.rejects(f.run(), /inaccessible|public export/); assert.equal(f.state.readBytes, 0);
  }
  assert.throws(() => requirePublicAccess(undefined, access), /invalid/);
});
test('all-public selection explicitly reports exclusion and never certifies an empty export', async t => {
  const f = await fixture(t); f.state.owner.information_label = { ...label, exportClass: 'restricted', principals: ['operator'] };
  await assert.rejects(f.run(), /missing|unpromoted|inaccessible/); assert.equal(f.state.readBytes, 0);
});
test('rejects inaccessible evidence before completion even if source itself is public', async t => {
  const f = await fixture(t); f.state.evidence.information_label = { ...label, exportClass: 'restricted', principals: ['operator'] };
  await assert.rejects(f.run(), /inaccessible/);
  await assert.rejects(readFile(path.join(f.out, 'admitted-public-manifest.json')), { code: 'ENOENT' });
});
test('source identity, currentness, source bytes and publication drift remain hard failures', async t => {
  for (const change of ['hash', 'stale', 'bytes', 'drift']) {
    const f = await fixture(t); f.options.allPublicCurrent = false;
    f.options.selection = { sources: [{ sourceVersionId: 'version.a', contentHash }] };
    if (change === 'hash') f.state.owner.content_hash = `sha256_${'0'.repeat(64)}`;
    if (change === 'stale') f.state.owner.current = false;
    if (change === 'bytes') f.state.bytes = Buffer.alloc(bytes.length);
    if (change === 'drift') f.dependencies.refreshSnapshot = async () => { f.state.evidence.id = 'changed'; };
    await assert.rejects(f.run(), /changed|newer|differ/);
  }
});
test('enforces source/total/metadata limits and output containment', async t => {
  for (const limit of ['maxItemBytes', 'maxTotalBytes', 'maxMetadataBytes']) {
    const f = await fixture(t); f.options[limit] = 1; await assert.rejects(f.run(), /budget/);
  }
  const f = await fixture(t); f.options.forbiddenRoots = [f.out]; await assert.rejects(f.run(), /ingestion roots/);
});
test('new schema freezes every source artifact and rejects tampering/traversal; legacy manifests stay unchanged', async t => {
  assert.deepEqual(await admissionArtifacts({ formalLanguages: ['python'] }, 'unused.json'), []);
  const f = await fixture(t), result = await f.run(), manifest = JSON.parse(await readFile(result.manifestFile, 'utf8'));
  const altered = structuredClone(manifest); altered.artifacts[0].path = '../escape';
  await assert.rejects(admissionArtifacts(altered, result.manifestFile), /Invalid/);
  await writeFile(path.join(f.out, manifest.artifacts[0].path), 'changed');
  await assert.rejects(admissionArtifacts(manifest, result.manifestFile), /integrity differs/);
});
test('canonical range reader exports exact source bytes and rejects oversized parents before materializing them', async t => {
  for (const oversized of [false, true]) {
    const f = await fixture(t), parent = Buffer.concat([Buffer.from('prefix'), bytes]), parentHash = `sha256_${createHash('sha256').update(parent).digest('hex')}`;
    const baseQuery = f.dependencies.client.query; let parentBodies = 0;
    f.dependencies.client.query = async (sql, params) => {
      if (sql.includes('FROM "fixture"."blobs"')) {
        const isParent = params[0] === parentHash;
        if (sql.startsWith('SELECT byte_length')) return { rows: [{ byte_length: isParent ? parent.length : bytes.length, range_parent_hash: isParent ? null : parentHash }] };
        if (isParent) parentBodies++;
        return { rows: [{ content: isParent ? parent : Buffer.alloc(0), byte_length: isParent ? parent.length : bytes.length,
          range_parent_hash: isParent ? null : parentHash, range_start: isParent ? null : 6, range_end: isParent ? null : parent.length, archive_reference: null }] };
      }
      return baseQuery(sql, params);
    };
    delete f.dependencies.reader;
    if (oversized) {
      f.options.maxItemBytes = bytes.length; await assert.rejects(f.run(), /parent exceeds/); assert.equal(parentBodies, 0);
    } else {
      await f.run(); assert.equal(parentBodies, 1); assert.deepEqual(await readFile(path.join(f.out, `corpus/${contentHash.slice(7)}.bin`)), bytes);
    }
  }
});
test('a failed resume invalidates the earlier completed manifest', async t => {
  const f = await fixture(t); await f.run(); f.state.evidence.status = 'quarantined';
  f.dependencies.refreshSnapshot = async () => { f.state.owner.content_hash = `sha256_${'1'.repeat(64)}`; };
  await assert.rejects(f.run(), /changed/);
  await assert.rejects(readFile(path.join(f.out, 'admitted-public-manifest.json')), { code: 'ENOENT' });
});
test('campaign freezes referenced admission corpus without adding it to reference inference context or changing cells', async t => {
  const f = await fixture(t), exported = await f.run(), campaignOut = path.join(f.out, 'campaign');
  const finalization = { schema: 'scce.language_identity_finalization.v1', ready: true, stable: true, recipeCurrent: true, revision: '1', profileCount: 1,
    assignedProfileCount: 1, missingProfileCount: 0, unknownIdentityCount: 0, discoveryRecipe: 'fixture', identityCount: 1,
    assignmentDigest: 'a'.repeat(64), persistedCatalogDigest: 'b'.repeat(64), loadedCatalogDigest: 'b'.repeat(64),
    activeBrain: { activeBrainVersion: 'fixture.brain' }, competenceVerified: false };
  const tools = Object.fromEntries(['node','javascript','typescript','python','rust','go'].map(language => [language, { available: true, path: process.execPath }]));
  await prepareCampaign({ out: campaignOut, admittedManifests: [exported.manifestFile] }, {
    discover: async () => ({ finalization, config: { server: 'http://127.0.0.1:9999', schema: 'fixture', configFile: '/fixture.json', allowedRoots: [f.out] },
      model: { digest: 'a'.repeat(64) }, tools, publicSnapshot: { candidate: { readinessHash: 'fixture' }, hardwarePolicy: { threads: 1 }, limitations: 'Offline fixture only; no isolation attestation.' } }),
    files: async () => [], admission: config => admitReference(config, { executeCommand: admissionExecutor(), randomBytes: n => Buffer.alloc(n, 65) })
  });
  const frozen = JSON.parse(await readFile(path.join(campaignOut, 'freeze.json'), 'utf8'));
  assert.equal(frozen.plan.cells.length, 48); assert.ok(frozen.plan.cells.every(cell => cell.count === 12));
  assert.deepEqual(frozen.plan.acceptance, { minimumPairsPerCell: 12, maxLossesPerCell: 0, requireStrictWinPerCell: true, maximumOneSidedPPerCell: 0.05 });
  assert.equal(frozen.plan.artifacts.filter(a => a.id.startsWith('admitted-public-source-artifact-')).length, 3);
  assert.ok(frozen.plan.artifacts.filter(a => a.id.startsWith('admitted-public-source-artifact-')).every(a => a.role === 'preparation'));
  const priorIds = frozen.plan.artifacts.filter(a => a.id.startsWith('admitted-public-')).map(a => a.id);
  assert.ok(frozen.plan.systems.every(s => priorIds.every(id => !s.preparation.publicCorpusArtifacts.includes(id))));
  assert.equal(frozen.plan.systems[0].preparation.initialPriorReceiptArtifact, 'candidate-initial-prior');
  assert.equal(frozen.plan.systems[1].preparation.initialPriorReceiptArtifact, undefined);
  assert.equal(frozen.plan.artifacts.find(a => a.id === 'candidate-initial-prior').role, 'preparation');
  assert.deepEqual(JSON.parse(await readFile(path.join(campaignOut, 'preparation/empty-reference-corpus.json'), 'utf8')).documents, []);
});
