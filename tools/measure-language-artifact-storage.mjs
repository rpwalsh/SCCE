// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, writeFile, mkdir, stat } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const args = new Map();
for (let i = 2; i < process.argv.length; i += 2) {
  const name = process.argv[i], value = process.argv[i + 1];
  if (!['--config', '--input', '--output'].includes(name) || !value || value.startsWith('--') || args.has(name)) {
    throw Error('Use --config local.json [--input logical-artifacts.json] [--output receipt.json]; without --input the complete pinned Dolly fixture is compiled.');
  }
  args.set(name, path.resolve(value));
}
if (!args.has('--config')) throw Error('A local PostgreSQL --config is required. Only transaction-scoped temporary tables are written.');
const output = args.get('--output') ?? path.join(root, '.scce/verification/language-artifact-storage.json');
if ([args.get('--config'), args.get('--input')].includes(output)) throw Error('Receipt must not replace an input or connection config.');
const [{ readScceRuntimeConfig, createPostgresStorageAdapter }, kernel, codec] = await Promise.all([
  import('../packages/adapters-node/dist/index.js'), import('../packages/kernel/dist/index.js'),
  import('../packages/adapters-node/dist/durable-language-artifact-storage.js')
]);
const sha = value => createHash('sha256').update(value).digest('hex');
const exact = value => JSON.stringify(value, (_key, child) => child && typeof child === 'object' && !Array.isArray(child)
  ? Object.fromEntries(Object.keys(child).sort().map(key => [key, child[key]])) : child);
const started = performance.now();
let fixture;
if (args.has('--input')) {
  if ((await stat(args.get('--input'))).size > 64 * 1024 * 1024) throw Error('Logical fixture exceeds the explicit64MiB file budget.');
  fixture = JSON.parse(await readFile(args.get('--input'), 'utf8'));
} else {
  const text = JSON.parse(await readFile(path.join(root, 'packages/kernel/src/__tests__/fixtures/dolly-human-16.json'), 'utf8')).text;
  assert.equal(Buffer.byteLength(text), 17248);
  const hasher = kernel.createHasher();
  assert.equal(hasher.digestHex(text), '307c6758d4173c6dd87d0b77460c74fafe62c3e58d934eabbf5e05268de3dadc');
  const idFactory = kernel.createIdFactory({ hasher, clock: kernel.createClock({ fixedTime: 1 }), deterministicReplay: true, namespace: 'artifact-storage-measurement' });
  const sourceVersionId = idFactory.sourceVersionId(text), sourceId = idFactory.sourceId('fixture', 'fixture://dolly-human-16');
  const profile = kernel.createLanguageAcquisitionEngine({ idFactory }).acquire({ sourceVersionId, text, createdAt: 1 });
  const evidence = kernel.createEvidenceExtractor({ idFactory, hasher }).extract({ sourceId, sourceVersionId, namespace: 'fixture',
    uri: 'fixture://dolly-human-16', mediaType: 'text/plain', text, languageProfile: profile, exactSourceText: true,
    sourceTrust: { identity: 1, integrity: 1, parserReliability: 1, directness: 1, authority: 1, freshness: 1,
      independenceGroup: 'human-dolly-fixture', accessScope: 'local', licenseStatus: 'fixture' }, observedAt: 1, maxChunkBytes: 64000 }).spans
    .map(span => ({ ...span, status: 'promoted' }));
  const compiled = kernel.compileLanguageTrainingBatch({ runtime: kernel.createLanguageMemoryRuntime({ hasher, idFactory }), hasher,
    batch: { streamId: 'fixture://dolly-human-16', sourceSystem: 'fixture', sourceVersionId, profile, text, evidence,
      canonicalSource: { sourceId, contentHash: idFactory.contentHash(text) }, createdAt: 1, retainNgramObservations: false,
      maxCountersPerOrder: 512, vocabularyLimit: 2048 } });
  fixture = { schema: 'scce.language_artifact_storage_fixture.v1', sourceBytes: Buffer.byteLength(text),
    patterns: compiled.patterns.map(pattern => ({ id: pattern.id, patternJson: pattern.patternJson })) };
}
if (fixture?.schema !== 'scce.language_artifact_storage_fixture.v1' || !Number.isSafeInteger(fixture.sourceBytes) || fixture.sourceBytes < 1
  || !Array.isArray(fixture.patterns) || !fixture.patterns.length || fixture.patterns.length > 4096
  || fixture.patterns.some(pattern => !pattern || typeof pattern.id !== 'string' || !pattern.id || !pattern.patternJson)
  || new Set(fixture.patterns.map(pattern => pattern.id)).size !== fixture.patterns.length) throw Error('Invalid or over-budget logical fixture.');
const prepareMs = performance.now() - started;
const encoded = fixture.patterns.map(pattern => ({ id: pattern.id, payload: codec.encodeLanguageArtifacts(pattern.patternJson) }));
const config = await readScceRuntimeConfig(args.get('--config'));
if (!['localhost', '127.0.0.1', '[::1]', '::1'].includes(new URL(config.database.url).hostname)) throw Error('Measurement requires the configured local PostgreSQL.');
const storage = createPostgresStorageAdapter({ ...config.database, informationAccess: config.security.informationAccess });
const report = { schema: 'scce.language_artifact_storage_measurement.v1', at: new Date().toISOString(),
  revision: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim(),
  sourceBytes: fixture.sourceBytes, patterns: fixture.patterns.length, logicalFixtureSha256: sha(exact(fixture)), prepareMs,
  scope: 'Selected pattern payload heap, TOAST and primary-key allocations only. Other brain tables and common metadata columns are outside this paired comparison.',
  applicationTablesWritten: false, transactionReadOnly: true, fixtureRolledBack: false };
let client;
try {
  client = await storage.pool.connect();
  // PostgreSQL permits writes to existing temporary tables in a read-only transaction, but not CREATE TABLE.
  for (const name of ['scce_artifact_baseline', 'scce_artifact_candidate']) {
    await client.query(`CREATE TEMP TABLE ${name}(id TEXT PRIMARY KEY,pattern_json JSONB NOT NULL) ON COMMIT PRESERVE ROWS`);
  }
  await client.query('BEGIN READ ONLY');
  const metrics = {};
  for (const [name, rows] of [['scce_artifact_baseline', fixture.patterns.map(pattern => ({ id: pattern.id, payload: pattern.patternJson }))], ['scce_artifact_candidate', encoded]]) {
    // Names come exclusively from the fixed tuple above, never caller input.
    for (let offset = 0; offset < rows.length; offset += 128) await client.query(`INSERT INTO pg_temp.${name}(id,pattern_json)
      SELECT id,payload FROM jsonb_to_recordset($1::jsonb) AS input(id text,payload jsonb)`, [JSON.stringify(rows.slice(offset, offset + 128))]);
    const [allocation] = (await client.query(`SELECT pg_table_size($1::regclass)::text AS "heapToastAuxBytes",
      pg_indexes_size($1::regclass)::text AS "indexBytes",pg_total_relation_size($1::regclass)::text AS "totalBytes"`, ['pg_temp.' + name])).rows;
    const [payload] = (await client.query(`SELECT count(*)::text AS rows,COALESCE(sum(pg_column_size(pattern_json)),0)::text AS "storedJsonBytes" FROM pg_temp.${name}`)).rows;
    metrics[name] = { ...allocation, ...payload };
  }
  const cold = (await client.query('SELECT id,pattern_json FROM pg_temp.scce_artifact_candidate ORDER BY id')).rows;
  const expected = [...fixture.patterns].sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
  assert.equal(cold.length, expected.length);
  for (let index = 0; index < cold.length; index++) {
    assert.equal(cold[index].id, expected[index].id);
    assert.deepStrictEqual(codec.decodeLanguageArtifacts(cold[index].pattern_json), expected[index].patternJson);
  }
  report.metrics = metrics; report.fullLogicalParity = true;
  report.retainedFraction = Number(metrics.scce_artifact_candidate.totalBytes) / Number(metrics.scce_artifact_baseline.totalBytes);
  assert.ok(Number.isFinite(report.retainedFraction));
  await client.query('ROLLBACK'); report.fixtureRolledBack = true;
  report.peakRssBytes = process.resourceUsage().maxRSS * 1024;
  report.codecSha256 = sha(await readFile(path.join(root, 'packages/adapters-node/dist/durable-language-artifact-storage.js')));
  await mkdir(path.dirname(output), { recursive: true }); await writeFile(output, JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ output, ...report }));
} finally {
  if (client) { if (!report.fixtureRolledBack) await client.query('ROLLBACK'); client.release(); }
  await storage.close();
}
