// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import { readScceRuntimeConfig } from '../packages/adapters-node/dist/config.js';
import { createPostgresStorageAdapter } from '../packages/adapters-node/dist/postgres.js';
import { buildLanguageProfileClusters, createClock, createHasher, createIdFactory, createLanguageAcquisitionEngine,
  createEvidenceExtractor, createLanguageMemoryRuntime } from '../packages/kernel/dist/index.js';
import { createSurfaceLanguageRuntime } from '../packages/kernel/dist/surface-language-runtime.js';

const args = process.argv.slice(2);
const value = flag => { const index = args.indexOf(flag); return index < 0 ? undefined : args[index + 1]; };
if (!value('--config') || args.some((arg, index) => index % 2 === 0 && !['--config', '--output'].includes(arg))) {
  throw Error('Usage: node tools/verify-admission-revisions.mjs --config <local-config.json> [--output <receipt.json>]');
}
const config = await readScceRuntimeConfig(value('--config'));
if (!['localhost', '127.0.0.1', '[::1]', '::1'].includes(new URL(config.database.url).hostname)) throw Error('This rollback-only fixture requires local PostgreSQL');
const access = config.security.informationAccess;
const suffix = randomUUID(), compartment = `native.admission.${suffix}`;
const reader = createPostgresStorageAdapter({ ...config.database, informationAccess: access });
const writer = createPostgresStorageAdapter({ ...config.database, informationAccess: { ...access, compartments: [...access.compartments, compartment] } });
const report = { schema: 'scce.native_admission_revision_verification.v1', at: new Date().toISOString(), checks: [],
  capabilityEvaluation: false, fixtureRolledBack: false,
  isolation: 'single_backend_outer_rollback_with_adapter_transaction_savepoints' };
const check = (name, operation) => { operation(); report.checks.push({ name, passed: true }); };
let physical;
let outerOpen = false, sequence = 0;
const originalReaderQuery = reader.pool.query, originalWriterConnect = writer.pool.connect, originalWriterQuery = writer.pool.query;
const readRevision = () => reader.languageMemory.readRevision();
const modelIds = [], profileIds = [], sourceIds = [], evidenceIds = [];
let initialRevision;
try {
  const verified = await writer.verify();
  assert.equal(verified.ok, true, 'Canonical storage verification failed');
  initialRevision = await readRevision();
  physical = await writer.pool.connect();
  await physical.query('BEGIN'); outerOpen = true;
  // Real adapter transaction commits flush the existing dirty revision and release a savepoint.
  // Their effects are visible to this backend only; the enclosing native transaction always rolls back.
  const connect = async () => {
    const name = `admission_${++sequence}`;
    return { async query(sql, params) {
      if (sql === 'BEGIN') return physical.query(`SAVEPOINT ${name}`);
      if (sql === 'COMMIT') return physical.query(`RELEASE SAVEPOINT ${name}`);
      if (sql === 'ROLLBACK') { await physical.query(`ROLLBACK TO SAVEPOINT ${name}`); return physical.query(`RELEASE SAVEPOINT ${name}`); }
      return physical.query(sql, params);
    }, release() {} };
  };
  writer.pool.connect = connect;
  writer.pool.query = (sql, params) => physical.query(sql, params);
  reader.pool.query = (sql, params) => physical.query(sql, params);
  const clock = createClock({ fixedTime: 1 }), hasher = createHasher();
  const ids = createIdFactory({ hasher, clock, namespace: suffix, deterministicReplay: true });
  const label = { tenantId: access.tenantId, principals: [access.principalId], compartments: [],
    exportClass: access.maximumExportClass, mergePolicy: 'same_owner' };
  const text = `oma vela. oma neri. oma vela. ${suffix}`;
  const uri = `fixture://native-admission/${suffix}`, sourceId = ids.sourceId('native-admission', uri);
  const sourceVersionId = ids.sourceVersionId(`${sourceId}:${text}`), bytes = Buffer.from(text, 'utf8');
  const sourceTrust = { identity: 1, integrity: 1, parserReliability: 1, directness: 1, authority: 1, freshness: 1,
    independenceGroup: sourceId, accessScope: 'fixture', licenseStatus: 'test_authored' };
  const profile = { ...createLanguageAcquisitionEngine({ idFactory: ids }).acquire({ sourceVersionId, text, createdAt: 1 }), informationLabel: label };
  const contentHash = await writer.blobs.put(bytes, 'text/plain');
  const source = { sourceId, sourceVersionId, namespace: 'native-admission', canonicalUri: uri, contentHash,
    byteLength: bytes.length, mediaType: 'text/plain', observedAt: 1, sourceTrust, informationLabel: label, metadata: {} };
  const extracted = createEvidenceExtractor({ hasher, idFactory: ids }).extract({ sourceId, sourceVersionId,
    namespace: source.namespace, uri, text, mediaType: source.mediaType, sourceTrust, languageProfile: profile,
    observedAt: 1, metadata: {}, exactSourceText: true, maxChunkBytes: 65536 }).spans;
  const spans = extracted.map(span => ({ ...span, features: [...span.features].sort(), status: 'quarantined', informationLabel: label }));
  assert.ok(spans.length > 0, 'Acquisition emitted no evidence');
  sourceIds.push(sourceVersionId); profileIds.push(profile.id); evidenceIds.push(...spans.map(span => span.id));
  await writer.evidence.putSourceVersion(source);
  await writer.evidence.putEvidenceSpans(spans);
  await writer.model.putLanguageProfile(profile);
  const memory = createLanguageMemoryRuntime({ hasher, idFactory: ids });
  const trained = memory.train({ streamId: uri, sourceSystem: 'wikipedia', profile, text, sourceVersionId,
    evidence: spans, createdAt: 1, retainObservations: false }).models.map(model => ({ ...model, informationLabel: label }));
  assert.ok(trained.length > 0, 'Acquisition emitted no model');
  modelIds.push(...trained.map(model => model.id));
  await writer.languageMemory.putNgramModels(trained);
  const revisionBeforeReplay = await readRevision();
  await writer.evidence.putSourceVersion(source);
  await writer.evidence.putEvidenceSpans(spans);
  const revisionAfterReplay = await readRevision();
  check('exact-source-and-evidence-replay-no-revision', () => assert.equal(revisionAfterReplay, revisionBeforeReplay));
  const runtime = () => createSurfaceLanguageRuntime({ deps: { storage: reader }, languageMemoryRuntime: memory,
    hasher, clock, cacheMs: 100_000, profileLimit: 32 });
  const warm = runtime(), cluster = buildLanguageProfileClusters([profile])[0];
  assert.ok(cluster, 'Acquired profile has no cluster');
  const before = await warm.hydrateSurfaceLanguageMemoryCached(12, cluster);
  check('warm-acquired-model-positive', () => assert.equal(before.state.models.length, trained.length));
  const restricted = { ...source, informationLabel: { ...label, compartments: [compartment] } };
  const abort = Error('native fixture rollback');
  try { await writer.transaction(async () => { await writer.evidence.putSourceVersion(restricted); throw abort; }); }
  catch (error) { if (error !== abort) throw error; }
  const afterAbort = await readRevision();
  check('outer-adapter-rollback-keeps-revision', () => assert.equal(afterAbort, revisionBeforeReplay));
  const rollbackModels = await reader.languageMemory.listNgramModels({ profileIds });
  check('rollback-keeps-source-readable', () => assert.equal(rollbackModels.length, trained.length));
  await writer.evidence.putSourceVersion(restricted);
  const restrictedRevision = await readRevision();
  check('source-acl-change-advances-once', () => assert.equal(BigInt(restrictedRevision), BigInt(afterAbort) + 1n));
  const coldRows = await reader.languageMemory.listNgramModels({ profileIds });
  check('cold-source-ownership-refuses-restricted-parent', () => assert.equal(coldRows.length, 0));
  await warm.synchronizeWithStorage();
  const after = await warm.hydrateSurfaceLanguageMemoryCached(12, cluster);
  const cold = await runtime().hydrateSurfaceLanguageMemoryCached(12, cluster);
  check('warm-and-cold-cache-admission-agree-after-restriction', () => { assert.equal(after.state.models.length, 0); assert.equal(cold.state.models.length, 0); });
  const priorPromotion = await readRevision();
  const promoted = await writer.evidence.promoteEvidence(evidenceIds, 'native fixture confirms');
  const afterPromotion = await readRevision();
  check('promotion-status-change-and-matched-count', () => { assert.equal(promoted, spans.length); assert.equal(BigInt(afterPromotion), BigInt(priorPromotion) + 1n); });
  const repeated = await writer.evidence.promoteEvidence(evidenceIds, 'native fixture confirms');
  await writer.evidence.putEvidenceSpans(spans);
  const afterPromotionReplay = await readRevision();
  check('repeated-promotion-count-and-quarantined-replay-preserve-promotion', () => { assert.equal(repeated, spans.length); assert.equal(afterPromotionReplay, afterPromotion); });
  const promotedRows = await writer.evidence.getEvidenceBatch(evidenceIds);
  check('supported-replay-does-not-demote', () => assert.ok(promotedRows.every(span => span.status === 'promoted')));
  await writer.transaction(async () => {
    for (const span of spans) await writer.evidence.putEvidenceSpan({ ...span, informationLabel: { ...label, compartments: [compartment] } });
  });
  const afterEvidenceAcl = await readRevision();
  check('evidence-acl-batch-coalesces-one-revision', () => assert.equal(BigInt(afterEvidenceAcl), BigInt(afterPromotionReplay) + 1n));
  const unreadable = await reader.evidence.getEvidenceBatch(evidenceIds);
  check('cold-evidence-acl-refuses-restricted-spans', () => assert.equal(unreadable.length, 0));
} catch (error) {
  report.error = { name: error?.name ?? 'Error', code: typeof error?.code === 'string' ? error.code : null,
    lastPassedCheck: report.checks.at(-1)?.name ?? null };
  process.exitCode = 1;
} finally {
  if (outerOpen) {
    try { await physical.query('ROLLBACK'); report.fixtureRolledBack = true; }
    catch (error) { report.error ??= { name: error?.name ?? 'Error', code: typeof error?.code === 'string' ? error.code : null }; process.exitCode = 1; }
  }
  writer.pool.connect = originalWriterConnect;
  writer.pool.query = originalWriterQuery;
  reader.pool.query = originalReaderQuery;
  physical?.release();
  try {
    const revision = await reader.languageMemory.readRevision();
    check('outer-native-rollback-restores-revision', () => assert.equal(revision, initialRevision));
    const [remaining] = await reader.query(`SELECT
      (SELECT count(*) FROM ${reader.table('source_versions')} WHERE id=ANY($1::text[])) +
      (SELECT count(*) FROM ${reader.table('evidence_spans')} WHERE id=ANY($2::text[])) +
      (SELECT count(*) FROM ${reader.table('language_profiles')} WHERE id=ANY($3::text[])) +
      (SELECT count(*) FROM ${reader.table('ngram_models')} WHERE id=ANY($4::text[])) AS count`, [sourceIds, evidenceIds, profileIds, modelIds]);
    check('fixture-records-not-retained', () => assert.equal(Number(remaining.count), 0));
  } catch (error) { report.error ??= { name: error?.name ?? 'Error', code: typeof error?.code === 'string' ? error.code : null }; process.exitCode = 1; }
  await Promise.all([writer.close(), reader.close()]);
  report.passed = !report.error && report.fixtureRolledBack;
  if (value('--output')) await writeFile(value('--output'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report));
}
