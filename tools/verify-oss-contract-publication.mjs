// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
// Development SQL verification, not a capability evaluation. Requires a fresh, migrated local database.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { readScceRuntimeConfig } from '../packages/adapters-node/dist/config.js';
import { createPostgresStorageAdapter } from '../packages/adapters-node/dist/postgres.js';
import { trainOssCorpus } from '../packages/adapters-node/dist/oss-corpus.js';
import { sourceOwnedProgramBehaviorFromDocumentation, searchProgramTransformations, evaluateProgramExpression } from '../packages/kernel/dist/index.js';

const args = process.argv.slice(2);
const value = flag => args[args.indexOf(flag) + 1];
if (!args.includes('--config') || !value('--config') || args.length % 2 || args.some((arg, index) => index % 2 === 0 && !['--config', '--output'].includes(arg))) {
  throw Error('Usage: node tools/verify-oss-contract-publication.mjs --config <fresh-local-config.json> [--output <receipt.json>]');
}
const config = await readScceRuntimeConfig(value('--config'));
if (!['localhost', '127.0.0.1', '[::1]', '::1'].includes(new URL(config.database.url).hostname)) throw Error('Local PostgreSQL required');
const suffix = randomUUID(), compartment = `native.oss.${suffix}`, access = config.security.informationAccess;
const storage = createPostgresStorageAdapter({ ...config.database, informationAccess: { ...access, compartments: [...access.compartments, compartment] } });
const report = { schema: 'scce.native_oss_contract_publication_verification.v1', capabilityEvaluation: false,
  checks: [], fixtureRolledBack: false, isolation: 'real_adapter_transactions_on_single_backend_outer_rollback', at: new Date().toISOString() };
const check = (name, operation) => { operation(); report.checks.push({ name, passed: true }); };
const root = await mkdtemp(path.join(tmpdir(), 'scce-native-oss-'));
const files = {
  '00-base.json': JSON.stringify({ compilerOptions: { strict: true, target: 'ES2022', module: 'NodeNext', moduleResolution: 'NodeNext', baseUrl: '.', paths: { '@owned/*': ['src/*'] } } }),
  'package.json': JSON.stringify({ name: 'owned-public-fixture', type: 'module' }),
  'tsconfig.json': JSON.stringify({ extends: './00-base.json', compilerOptions: { noEmit: true }, include: ['src/**/*.ts', 'spec/**/*.ts', 'types/**/*.ts'] }),
  'src/index.ts': "export { measured as f0 } from './value.js';\n",
  'src/value.ts': "import type {Scalar} from '../types/value.js'; export function measured(value:Scalar):Scalar {return value*value+value;}\n",
  'types/value.d.ts': 'export type Scalar=number;\n',
  'spec/first.spec.ts': "import {test} from 'node:test';import {strictEqual} from 'node:assert';import {f0 as observed} from '@owned/index.js';test('first',()=>{strictEqual(observed(2),6);strictEqual(observed(4),20);});\n",
  'spec/second.spec.ts': "import {it,expect} from 'vitest';import {f0 as observed} from '@owned/index.js';it('second',()=>{expect(observed(1)).toBe(2);expect(observed(5)).toBe(30);});\n"
};
let physical, outerOpen = false, sequence = 0, tail = Promise.resolve(), initialRevision;
const originalConnect = storage.pool.connect, originalQuery = storage.pool.query;
const nativeQuery = (sql, params) => {
  const result = tail.then(() => physical.query(sql, params)); tail = result.then(() => undefined, () => undefined); return result;
};
const patterns = () => storage.languageMemory.listLanguagePatterns({ patternKind: 'source_code_assertion_contract', patternSchemas: ['scce.source_owned_test_contract.v1'], limit: 32 });
async function temporary(operation) {
  const name = `negative_${++sequence}`; await nativeQuery(`SAVEPOINT ${name}`);
  try { await operation(); } finally { await nativeQuery(`ROLLBACK TO SAVEPOINT ${name}`); await nativeQuery(`RELEASE SAVEPOINT ${name}`); }
}
try {
  const verified = await storage.verify(); assert.equal(verified.ok, true, verified.errors.join('; '));
  for (const table of ['sources', 'source_versions', 'evidence_spans', 'language_profiles', 'language_patterns', 'ngram_models', 'ingestion_checkpoints']) {
    const [row] = await storage.query(`SELECT count(*)::text AS count FROM ${storage.table(table)}`);
    assert.equal(row.count, '0', `Fresh database required: ${table} is not empty`);
  }
  initialRevision = await storage.languageMemory.readRevision();
  physical = await storage.pool.connect(); await nativeQuery('BEGIN'); outerOpen = true;
  // Only transaction transport is adapted. Every statement and outcome is real PostgreSQL.
  storage.pool.connect = async () => {
    const name = `adapter_${++sequence}`;
    return { async query(sql, params) {
      if (sql === 'BEGIN') return nativeQuery(`SAVEPOINT ${name}`);
      if (sql === 'COMMIT') return nativeQuery(`RELEASE SAVEPOINT ${name}`);
      if (sql === 'ROLLBACK') { await nativeQuery(`ROLLBACK TO SAVEPOINT ${name}`); return nativeQuery(`RELEASE SAVEPOINT ${name}`); }
      return nativeQuery(sql, params);
    }, release() {} };
  };
  storage.pool.query = nativeQuery;
  for (const [name, text] of Object.entries(files)) { const file = path.join(root, name); await mkdir(path.dirname(file), { recursive: true }); await writeFile(file, text); }
  const options = { storage, rootPath: root, sourceUriBase: `scce://native-oss/${suffix}`, includeDocs: false, maxFiles: 100, maxFilesPerRun: 1,
    ngramMaxOrder: 2, ngramMaxCountersPerOrder: 16, ngramVocabularyLimit: 128 };
  let cursor = 0, snapshotHash, last;
  for (let index = 0; index < Object.keys(files).length; index++) {
    last = await trainOssCorpus({ ...options, startFileIndex: cursor, ...(snapshotHash ? { expectedSnapshotHash: snapshotHash } : {}) });
    cursor = last.nextFileIndex; snapshotHash = last.snapshotHash;
    assert.equal(last.filesConsidered, 1, 'Fixture must cross real one-file training windows');
  }
  const published = await patterns();
  check('two-independent-node-vitest-roots-published', () => {
    assert.equal(published.length, 2, JSON.stringify(last.sourceContractClosure));
    assert.deepEqual(published.flatMap(row => row.patternJson.cases.map(item => item.expectedResult)).sort((a, b) => a - b), [2, 6, 20, 30]);
    assert.ok(published.every(row => row.patternJson.sourcePath === 'src/value.ts'));
  });
  const body = published[0].patternJson;
  const joined = sourceOwnedProgramBehaviorFromDocumentation({ requestText: 'TypeScript measured', ownerCallableIds: ['measured'],
    intent: { languageId: 'typescript', symbols: [], references: [{ sourceFamily: body.repositoryFamily, relativePath: 'src/value.ts', sourceHash: body.sourceHash, score: 1 }], audit: null }, patterns: published });
  check('normal-program-contract-consumer-composes-current-owned-cases', () => {
    assert.equal(joined.behaviorRequirements.length, 4);
    const selected = searchProgramTransformations(joined.behaviorRequirements).selected; assert.equal(selected.length, 1);
    assert.equal(evaluateProgramExpression(selected[0].producedIr, [-7]), 42);
  });
  const heads = (await storage.query(`SELECT value_json FROM ${storage.table('storage_meta')} WHERE value_json->>'schema'='scce.language_pattern_active_projection.v1'`))
    .map(row => row.value_json).filter(row => row.sourceContractRoot);
  check('independent-root-heads-retain-all-original-projected-dependencies', () => {
    assert.equal(heads.length, 2); assert.equal(new Set(heads.map(head => head.sourceContractRoot.sourceId)).size, 2);
    for (const head of heads) { assert.ok(head.sourceDependencies.length >= 6); assert.ok(head.sourceDependencies.every(dep => dep.originalSourceVersionId && dep.originalContentHash && dep.evidenceIds.length)); }
  });
  report.publication = { patternIds: published.map(row => row.id), rootCheckpointIds: heads.map(head => head.sourceContractRoot.checkpointId),
    sourceDependencyCounts: heads.map(head => head.sourceDependencies.length), windows: Object.keys(files).length, behaviorRequirements: joined.behaviorRequirements.length };
  for (const head of heads) assert.ok(await storage.languageMemory.getLanguagePatternProjection(head));
  const beforeReplay = await storage.languageMemory.readRevision();
  await trainOssCorpus({ ...options, startFileIndex: cursor, expectedSnapshotHash: snapshotHash });
  const afterReplay = await storage.languageMemory.readRevision();
  check('cached-eof-replay-no-revision-or-pattern-identity-change', () => assert.equal(afterReplay, beforeReplay));
  assert.deepEqual((await patterns()).map(row => row.id).sort(), published.map(row => row.id).sort());
  await temporary(async () => {
    const head = heads[0], rootHead = await storage.ingestion.get(head.sourceContractRoot.checkpointId);
    assert.ok(rootHead); await storage.ingestion.put({ ...rootHead, metadata: { ...rootHead.metadata, inputDigest: '0'.repeat(64) } });
    check('stale-root-head-is-refused-independently', () => {});
    assert.equal(await storage.languageMemory.getLanguagePatternProjection(head), undefined);
    assert.equal((await patterns()).length, 1);
  });
  await temporary(async () => {
    const snapshot = await storage.ingestion.get(heads[0].sourceContractRoot.snapshotCheckpointId); assert.ok(snapshot);
    const before = await storage.languageMemory.readRevision();
    const changed = { ...snapshot, metadata: { ...snapshot.metadata, identity: '0'.repeat(64) } };
    await storage.ingestion.put(changed); const after = await storage.languageMemory.readRevision();
    check('snapshot-only-change-invalidates-unvisited-roots-and-warm-revision', () => assert.equal(BigInt(after), BigInt(before) + 1n));
    await storage.ingestion.put({ ...changed, updatedAt: changed.updatedAt + 1 });
    assert.equal(await storage.languageMemory.readRevision(), after, 'Timestamp-only snapshot replay must be a no-op');
    assert.equal((await patterns()).length, 0);
    for (const head of heads) assert.equal(await storage.languageMemory.getLanguagePatternProjection(head), undefined);
  });
  await temporary(async () => {
    const dependency = heads[0].sourceDependencies.find(row => row.sourceVersionId !== heads[0].sourceVersionId && row.sourceId !== heads[0].sourceContractRoot.sourceId);
    assert.ok(dependency); const source = await storage.evidence.sourceVersionById(dependency.originalSourceVersionId); assert.ok(source);
    await storage.evidence.putSourceVersion({ ...source, informationLabel: { ...source.informationLabel, compartments: [compartment] } });
    assert.equal((await patterns()).length, 0, 'Shared imported/config dependency revocation must withdraw both roots');
    for (const head of heads) assert.equal(await storage.languageMemory.getLanguagePatternProjection(head), undefined);
    const rows = published.filter(row => heads[0].patternIds.includes(row.id));
    await assert.rejects(storage.languageMemory.replaceLanguagePatternProjection({ projection: heads[0], patterns: rows }), /stale, revoked or foreign/);
    check('canonical-source-acl-change-refuses-read-and-republication', () => {});
  });
  const identities = async () => (await storage.query(`SELECT id FROM ${storage.table('ngram_models')} ORDER BY id`)).map(row => row.id);
  const modelIds = await identities();
  const changedConfig = JSON.parse(files['00-base.json']); changedConfig.compilerOptions.strict = false;
  await writeFile(path.join(root, '00-base.json'), JSON.stringify(changedConfig));
  // Acquire only the changed canonical config. The following EOF pass must resolve
  // prior-window code/tests using their already admitted owners, not train them again.
  const acquired = await trainOssCorpus({ ...options, startFileIndex: 0 });
  assert.equal(acquired.filesConsidered, 1);
  const revised = await trainOssCorpus({ ...options, startFileIndex: cursor });
  const current = await patterns();
  check('changed-canonical-project-context-republishes-without-retraining-prior-files', () => {
    assert.equal(revised.codeTrained, 0); assert.equal(current.length, 2);
    assert.notEqual(current[0].patternJson.sourceContractClosure.configHash, published[0].patternJson.sourceContractClosure.configHash);
  });
  const currentIds = new Set(await identities()); assert.ok(modelIds.every(id => currentIds.has(id)), 'Prior model identities must be retained');
  for (const head of heads) assert.equal(await storage.languageMemory.getLanguagePatternProjection(head), undefined, 'Old context receipt must not remain current');
  report.passed = true;
} catch (error) { report.passed = false; report.error = { name: error?.name, message: String(error?.message ?? error), code: error?.code }; process.exitCode = 1; }
finally {
  if (outerOpen) { try { await nativeQuery('ROLLBACK'); report.fixtureRolledBack = true; } catch (error) { report.passed = false; report.rollbackError = String(error); process.exitCode = 1; } }
  storage.pool.connect = originalConnect; storage.pool.query = originalQuery; physical?.release();
  try {
    if (initialRevision !== undefined) assert.equal(await storage.languageMemory.readRevision(), initialRevision);
    for (const table of ['sources', 'source_versions', 'evidence_spans', 'language_profiles', 'language_patterns', 'ngram_models', 'ingestion_checkpoints']) {
      const [remaining] = await storage.query(`SELECT count(*)::text AS count FROM ${storage.table(table)}`); assert.equal(remaining.count, '0', `Rollback retained ${table}`);
    }
    check('outer-rollback-restores-empty-database-and-language-revision', () => {});
  } catch (error) { report.passed = false; report.cleanupError = String(error); process.exitCode = 1; }
  await storage.close(); await rm(root, { recursive: true, force: true });
  if (args.includes('--output')) await writeFile(value('--output'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report));
}
