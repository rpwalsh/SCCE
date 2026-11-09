// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { writeFile } from 'node:fs/promises';
import { artifactRowsFromPages, compareSourceArtifactStreams } from './source-artifact-parity.mjs';

export function parseSourceArtifactMetadataArgs(args) {
  const fields = new Map();
  for (let i = 0; i < args.length; i += 2) {
    const flag = args[i], value = args[i + 1];
    if (!['--source-config', '--fixture-config', '--source-system', '--output'].includes(flag)
      || !value || value.startsWith('--') || fields.has(flag)) throw Error('Expected --source-config <read-only.json> --fixture-config <fresh.json> [--source-system wikipedia] [--output receipt.json]');
    fields.set(flag, value);
  }
  if (!fields.has('--source-config') || !fields.has('--fixture-config')) throw Error('Separate read-only source and fresh fixture configs are required');
  const sourceConfigPath = fields.get('--source-config'), fixtureConfigPath = fields.get('--fixture-config'), outputPath = fields.get('--output');
  if (path.resolve(sourceConfigPath).toLowerCase() === path.resolve(fixtureConfigPath).toLowerCase()) throw Error('Source and fixture configs must be different');
  if (outputPath && [sourceConfigPath, fixtureConfigPath].some(value => path.resolve(value).toLowerCase() === path.resolve(outputPath).toLowerCase())) throw Error('Receipt must not replace a config');
  return { sourceConfigPath, fixtureConfigPath, sourceSystem: fields.get('--source-system') ?? 'wikipedia', outputPath };
}

const record = value => value && typeof value === 'object' && !Array.isArray(value) ? value : {};
const sorted = rows => [...rows].sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
async function* rows(values) { yield values; }

export async function readInternalSourceCompilationPatterns(storage, profileId, { profileSourceOwnershipSql, normalizeInformationLabel, decodeMany, jsonByteLengths }) {
  const result = [];
  let after = '';
  while (true) {
    const params = [profileId, after];
    const access = storage.informationAccessPredicate('pattern', params.length + 1); params.push(...access.params);
    const profileAccess = storage.informationAccessPredicate('profile', params.length + 1); params.push(...profileAccess.params);
    const ownership = profileSourceOwnershipSql(storage, params, 'profile');
    const page = await storage.query(`SELECT pattern.id,pattern.profile_id,pattern.pattern_kind,pattern.support,pattern.entropy,
      pattern.pattern_json,pattern.evidence_ids,pattern.updated_at,pattern.information_label
      FROM ${storage.table('language_patterns')} pattern JOIN ${storage.table('language_profiles')} profile ON profile.id=pattern.profile_id
      WHERE pattern.profile_id=$1 AND pattern.pattern_kind='source_compilation' AND pattern.id>$2
        AND ${access.sql} AND ${profileAccess.sql} AND ${ownership} ORDER BY pattern.id COLLATE "C" LIMIT 64`, params);
    if (!page.length) break;
    const values = await decodeMany(page.map(row => ({ value: row.pattern_json, profileId: row.profile_id, informationLabel: row.information_label })));
    assert.equal(values.length, page.length, 'Internal receipt decoder omitted a row');
    let decodedBytes = 0;
    for (const [index, row] of page.entries()) {
      assert.ok(row.id > after, 'Internal receipt cursor did not advance');
      assert.equal(row.pattern_kind, 'source_compilation'); assert.equal(row.profile_id, profileId);
      decodedBytes += jsonByteLengths(values[index]).decodedJsonbBytes;
      assert.ok(decodedBytes <= 64 * 1024 * 1024, 'Internal receipt page exceeded its explicit decoded byte budget');
      result.push({ id: row.id, profileId: row.profile_id, patternKind: row.pattern_kind, support: Number(row.support), entropy: Number(row.entropy),
        patternJson: values[index], evidenceIds: row.evidence_ids, updatedAt: new Date(row.updated_at).getTime(), informationLabel: normalizeInformationLabel(row.information_label) });
      after = row.id;
    }
  }
  return result;
}

export async function publishNativeArtifactSourceProjection({ source, fixture, owner, profile, sourceSystem, originalPatterns, patterns, priorCompilationId, scopes }, publisher) {
  const projections = [];
  for (const scope of scopes) {
    const query = { ...scope, sourceId: owner.sourceId, sourceVersionId: owner.sourceVersionId, profileId: profile.id,
      sourceSystem, informationLabel: profile.informationLabel, sourceCompilationId: priorCompilationId };
    const active = await source.languageMemory.getLanguagePatternProjection(query);
    const expected = originalPatterns.filter(row => record(row.patternJson).schema === scope.patternSchema).map(row => row.id).sort();
    if (!active) { assert.equal(expected.length, 0, 'Source schema lacks its required canonical active projection'); continue; }
    for (const key of ['sourceId', 'sourceVersionId', 'profileId', 'sourceSystem', 'patternSchema', 'componentRecipe', 'informationLabel'])
      assert.deepEqual(active[key], query[key], 'Canonical source projection ownership differs from its requested scope');
    assert.deepEqual([...active.patternIds].sort(), expected, 'Canonical source projection must cover its exact original member set');
    projections.push(scope);
  }
  assert.ok(projections.length > 0, 'Source fixture requires canonical active publication scopes');
  await publisher({ store: fixture.languageMemory, owner: { sourceId: owner.sourceId, sourceVersionId: owner.sourceVersionId, contentHash: owner.contentHash },
    profileId: profile.id, sourceSystem, informationLabel: profile.informationLabel, patterns, projections });
  return projections;
}

export function describeNativeArtifactPatternRead(expected, actual) {
  const actualIds = new Set(actual.map(row => row.id)), expectedIds = new Set(expected.map(row => row.id));
  return { expectedCount: expected.length, actualCount: actual.length,
    missing: expected.filter(row => !actualIds.has(row.id)).map(row => ({ id: row.id, schema: record(row.patternJson).schema ?? null })),
    extraIds: actual.filter(row => !expectedIds.has(row.id)).map(row => row.id) };
}

export async function verifySourceArtifactMetadata(options) {
  const { readScceRuntimeConfig } = await import('../packages/adapters-node/dist/config.js');
  const { createPostgresStorageAdapter } = await import('../packages/adapters-node/dist/postgres.js');
  const { createSourceArtifactMetadataCodec } = await import('../packages/adapters-node/dist/source-artifact-metadata.js');
  const { profileSourceOwnershipSql } = await import('../packages/adapters-node/dist/pooled-profile-ownership.js');
  const { durableJoinProgramJsonByteLengths } = await import('../packages/adapters-node/dist/durable-join-program-storage.js');
  const { canonicalStringify, createHasher, normalizeInformationLabel, publishCompiledLanguagePatterns, LANGUAGE_CONSTRUCTION_PUBLICATION,
    CREATIVE_EVENT_COMPATIBILITY_MODEL_SCHEMA, CREATIVE_SOURCE_SURFACE_ACQUISITION_RECIPE_ID,
    stampSourceLanguageCompilation, POSTGRES_REQUIRED_TABLES } = await import('../packages/kernel/dist/index.js');
  const [sourceConfig, fixtureConfig] = await Promise.all([readScceRuntimeConfig(options.sourceConfigPath), readScceRuntimeConfig(options.fixtureConfigPath)]);
  for (const config of [sourceConfig, fixtureConfig]) if (!['localhost', '127.0.0.1', '[::1]', '::1'].includes(new URL(config.database.url).hostname)) throw Error('Native metadata verification requires local databases');
  const sourceIdentity = new URL(sourceConfig.database.url), fixtureIdentity = new URL(fixtureConfig.database.url);
  if (sourceIdentity.hostname === fixtureIdentity.hostname && sourceIdentity.port === fixtureIdentity.port && sourceIdentity.pathname === fixtureIdentity.pathname) throw Error('Fixture must be a separate physical database');
  const create = config => createPostgresStorageAdapter({ ...config.database, informationAccess: config.security.informationAccess });
  const source = create(sourceConfig), fixture = create(fixtureConfig), readers = [];
  const report = { schema: 'scce.native_source_artifact_metadata_verification.v1', capabilityEvaluation: false,
    sourceReadOnly: true, fixtureRolledBack: false, sourceSystem: options.sourceSystem,
    provenance: 'existing learned payloads rebound by canonical compiler stamp with an exact common inherited metadata subset; original compilation identities are not claimed unchanged',
    checks: [], owners: [], physical: {}, passed: false, currentStage: 'preflight' };
  let sourcePhysical, fixturePhysical, initial, sourceOpen = false, fixtureOpen = false, sequence = 0;
  const originals = [], hasher = createHasher();
  const check = (name, operation) => { operation(); report.checks.push({ name, passed: true }); };
  const tables = POSTGRES_REQUIRED_TABLES.filter(name => name !== 'storage_meta');
  const snapshot = async () => ({ revision: await fixture.languageMemory.readRevision(), active: await fixture.brainImports.active(),
    counts: Object.fromEntries((await fixture.query(tables.map(name => `SELECT '${name}' AS name,count(*)::text AS count FROM ${fixture.table(name)}`).join(' UNION ALL '))).map(row => [row.name, row.count])) });
  const bind = (adapter, physical, readOnly) => {
    const original = { adapter, query: adapter.pool.query, connect: adapter.pool.connect }; originals.push(original);
    let tail = Promise.resolve();
    const query = (sql, params) => { const next = tail.then(() => physical.query(sql, params)); tail = next.then(() => undefined, () => undefined); return next; };
    adapter.pool.query = query;
    adapter.pool.connect = async () => { if (readOnly) throw Error('Source adapter mutation attempted in read-only verification'); const name = `metadata_adapter_${++sequence}`;
      return { async query(sql, params) { if (sql === 'BEGIN') return query(`SAVEPOINT ${name}`); if (sql === 'COMMIT') return query(`RELEASE SAVEPOINT ${name}`);
        if (sql === 'ROLLBACK') { await query(`ROLLBACK TO SAVEPOINT ${name}`); return query(`RELEASE SAVEPOINT ${name}`); } return query(sql, params); }, release() {} }; };
    return query;
  };
  const compare = (a, b) => compareSourceArtifactStreams(artifactRowsFromPages(rows(sorted(a))), artifactRowsFromPages(rows(sorted(b))),
    { canonicalStringify, jsonByteLengths: durableJoinProgramJsonByteLengths });
  try {
    assert.equal((await source.verify()).ok, true); assert.equal((await fixture.verify()).ok, true);
    initial = await snapshot();
    check('fresh-physical-fixture-is-empty', () => { assert.ok(Object.values(initial.counts).every(count => count === '0')); assert.equal(initial.active.activeBrainVersion, undefined); assert.deepEqual(initial.active.activeImportRunIds, []); });
    sourcePhysical = await source.pool.connect(); await sourcePhysical.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY'); sourceOpen = true;
    fixturePhysical = await fixture.pool.connect(); await fixturePhysical.query('BEGIN'); fixtureOpen = true;
    const sourceQuery = bind(source, sourcePhysical, true), fixtureQuery = bind(fixture, fixturePhysical, false);
    const [mode] = await source.query('SHOW transaction_read_only'); check('source-transaction-enforces-read-only', () => assert.equal(mode.transaction_read_only, 'on'));
    report.currentStage = 'read-only-source-selection';
    const ownerIds = (await source.query(`SELECT DISTINCT source_version_id COLLATE "C" AS source_version_id FROM ${source.table('language_units')} WHERE metadata_json->>'sourceSystem'=$1 ORDER BY source_version_id`, [options.sourceSystem])).map(row => row.source_version_id);
    assert.ok(ownerIds.length > 0, 'Selected source system has no materialized owners');
    const copied = new Set();
    const copyOwner = async id => {
      if (copied.has(id)) return;
      const owner = await source.evidence.sourceVersionById(id); assert.ok(owner, 'Selected source owner is inaccessible');
      if (owner.derivation?.derivedFromSourceVersionId) await copyOwner(owner.derivation.derivedFromSourceVersionId);
      const bytes = await source.blobs.get(owner.contentHash); assert.equal(await fixture.blobs.put(bytes, owner.mediaType), owner.contentHash);
      await fixture.evidence.putSourceVersion(owner); copied.add(id);
    };
    for (const id of ownerIds) await copyOwner(id);
    const allEvidenceIds = (await source.query(`SELECT id FROM (SELECT DISTINCT unnest(evidence_ids) AS id FROM ${source.table('language_patterns')} WHERE source_system=$1) owned ORDER BY id COLLATE "C"`, [options.sourceSystem])).map(row => row.id);
    for (let offset = 0; offset < allEvidenceIds.length; offset += 128) {
      const ids = allEvidenceIds.slice(offset, offset + 128), spans = await source.evidence.getEvidenceBatch(ids); assert.equal(spans.length, ids.length, 'Required evidence is inaccessible');
      for (const span of spans) { await copyOwner(span.sourceVersionId); const bytes = await source.blobs.get(span.contentHash); assert.equal(await fixture.blobs.put(bytes, span.mediaType), span.contentHash); }
      await fixture.evidence.putEvidenceSpans(spans);
    }
    for (const name of ['language_units', 'language_patterns', 'semantic_frames', 'ngram_models']) await fixture.query(`CREATE TEMP TABLE metadata_baseline_${name} (LIKE ${fixture.table(name)} INCLUDING ALL) ON COMMIT DROP`);
    let negative;
    report.currentStage = 'owner-artifact-roundtrip';
    for (const sourceVersionId of ownerIds) {
      const owner = await source.evidence.sourceVersionById(sourceVersionId);
      const profiles = await source.model.listLanguageProfiles({ sourceVersionIds: [sourceVersionId], limit: 512 });
      assert.ok(profiles.length > 0 && profiles.length < 512, 'Owner profile window must be complete');
      for (const profile of profiles) {
        await fixture.model.putLanguageProfile(profile);
        const query = { profileIds: [profile.id], sourceSystem: options.sourceSystem, limit: 4096, maxTotalJsonBytes: 64 * 1024 * 1024 };
        const units = await source.languageMemory.listLanguageUnits(query);
        const patternIds = (await source.query(`SELECT id FROM ${source.table('language_patterns')} WHERE profile_id=$1 AND pattern_kind<>'source_compilation' ORDER BY id COLLATE "C"`, [profile.id])).map(row => row.id);
        const servablePatterns = [];
        for (let offset = 0; offset < patternIds.length; offset += 64) {
          const ids = patternIds.slice(offset, offset + 64), page = await source.languageMemory.listLanguagePatterns({ ...query, patternIds: ids, limit: ids.length, requireComplete: true });
          assert.deepEqual(page.map(row => row.id).sort(), [...ids].sort(), 'Pattern source read exceeded its explicit byte window or admission scope'); servablePatterns.push(...page);
        }
        const internal = async storage => readInternalSourceCompilationPatterns(storage, profile.id, { profileSourceOwnershipSql, normalizeInformationLabel,
          decodeMany: inputs => createSourceArtifactMetadataCodec(storage).decodeMany(inputs), jsonByteLengths: durableJoinProgramJsonByteLengths });
        const internalPatterns = await internal(source), patterns = [...servablePatterns, ...internalPatterns];
        const physicalPatternIds = (await source.query(`SELECT id FROM ${source.table('language_patterns')} WHERE profile_id=$1 ORDER BY id COLLATE "C"`, [profile.id])).map(row => row.id);
        assert.deepEqual(patterns.map(row => row.id).sort(), physicalPatternIds.sort(), 'Servable and owner-checked internal reads must preserve every physical pattern');
        const models = await source.languageMemory.listNgramModels(query), frames = await source.languageMemory.listSemanticFrames(query);
        assert.ok(units.length > 0 && units.length < query.limit && models.length > 0 && models.length < query.limit && frames.length < query.limit, 'Owner artifact window is incomplete');
        for (const [table, selector, actualRows] of [['language_units', 'profile_id', units], ['ngram_models', 'profile_id', models], ['semantic_frames', "frame_json->>'profileId'", frames]]) {
          const ids = (await source.query(`SELECT id FROM ${source.table(table)} WHERE ${selector}=$1 ORDER BY id COLLATE "C"`, [profile.id])).map(row => row.id);
          assert.deepEqual(actualRows.map(row => row.id).sort(), ids.sort(), 'Owner artifact read must cover every selected current row');
        }

        const first = record(units[0].metadata), inherited = Object.fromEntries(Object.entries(first).filter(([key, value]) => key !== 'sourceCompilationId'
          && units.every(row => Object.hasOwn(record(row.metadata), key) && canonicalStringify(record(row.metadata)[key]) === canonicalStringify(value))));
        const receipt = record(record(models[0].modelJson).sourceCompilation), text = Buffer.from(await source.blobs.get(owner.contentHash)).toString('utf8');
        const chunks = [...models].sort((a, b) => record(record(a.modelJson).sourceCompilation).chunk.index - record(record(b.modelJson).sourceCompilation).chunk.index)
          .map(row => { const chunk = record(record(row.modelJson).sourceCompilation).chunk; return text.slice(chunk.start, chunk.end); });
        const stamped = stampSourceLanguageCompilation({ owner: { sourceId: owner.sourceId, sourceVersionId, contentHash: owner.contentHash }, profileId: profile.id,
          sourceSystem: options.sourceSystem, streamId: receipt.parentStreamId, text, chunks, models, options: receipt.options,
          artifacts: { units, patterns, semanticFrames: frames }, inheritedMetadata: inherited, hasher });
        const rebound = { ...stamped, patterns: stamped.patterns.map(row => row.informationLabel ? row : { ...row, informationLabel: profile.informationLabel }) };
        const holders = rebound.patterns.filter(row => row.patternKind === 'source_compilation' && record(row.patternJson).inheritedMetadata);
        assert.equal(holders.length, 1, 'Current compiler must publish exactly one metadata holder');
        await fixture.languageMemory.putLanguagePatterns(holders);
        await fixture.languageMemory.putNgramModels(rebound.models);
        await fixture.languageMemory.putLanguageUnits(rebound.units);
        await fixture.languageMemory.putLanguagePatterns(rebound.patterns.filter(row => !holders.includes(row)));
        await fixture.languageMemory.putSemanticFrames(rebound.semanticFrames);
        const expectedServable = rebound.patterns.filter(row => row.patternKind !== 'source_compilation'), expectedInternal = rebound.patterns.filter(row => row.patternKind === 'source_compilation');
        const firstPage = expectedServable.slice(0, 64), firstIds = firstPage.map(row => row.id);
        const beforePublication = await fixture.languageMemory.listLanguagePatterns({ ...query, patternIds: firstIds, limit: firstIds.length, requireComplete: true });
        const unpublishedRead = describeNativeArtifactPatternRead(firstPage, beforePublication);
        report.lastUnpublishedRead = { sourceVersionId, profileId: profile.id, ...unpublishedRead };
        report.currentStage = 'canonical-source-projection-publication';
        const publishedScopes = await publishNativeArtifactSourceProjection({ source, fixture, owner, profile, sourceSystem: options.sourceSystem,
          originalPatterns: patterns, patterns: rebound.patterns, priorCompilationId: receipt.compilationId,
          scopes: [LANGUAGE_CONSTRUCTION_PUBLICATION, { patternSchema: CREATIVE_EVENT_COMPATIBILITY_MODEL_SCHEMA, componentRecipe: CREATIVE_SOURCE_SURFACE_ACQUISITION_RECIPE_ID }] }, publishCompiledLanguagePatterns);
        report.currentStage = 'owner-artifact-roundtrip';
        const actual = { units: await fixture.languageMemory.listLanguageUnits(query), models: await fixture.languageMemory.listNgramModels(query), frames: await fixture.languageMemory.listSemanticFrames(query), patterns: [] };
        for (let offset = 0; offset < expectedServable.length; offset += 64) { const ids = expectedServable.slice(offset, offset + 64).map(row => row.id);
          const page = await fixture.languageMemory.listLanguagePatterns({ ...query, patternIds: ids, limit: ids.length, requireComplete: true });
          const diagnostic = describeNativeArtifactPatternRead(expectedServable.slice(offset, offset + 64), page);
          if (diagnostic.missing.length || diagnostic.extraIds.length) report.patternReadFailure = { sourceVersionId, profileId: profile.id, ...diagnostic };
          assert.deepEqual(page.map(row => row.id).sort(), [...ids].sort(), 'Encoded servable pattern read must preserve every requested identity'); actual.patterns.push(...page); }
        const actualInternal = await internal(fixture);
        const patternReadContracts = { servable: await compare(expectedServable, actual.patterns), internalSourceCompilation: await compare(expectedInternal, actualInternal) };
        actual.patterns.push(...actualInternal);
        const parity = {};
        for (const [family, expected] of Object.entries({ units: rebound.units, models: rebound.models, frames: rebound.semanticFrames, patterns: rebound.patterns })) parity[family] = await compare(expected, actual[family]);
        report.owners.push({ sourceVersionId, profileId: profile.id, priorCompilationId: receipt.compilationId,
          compilationId: record(record(rebound.models[0].modelJson).sourceCompilation).compilationId, unpublishedRead, publishedScopes, patternReadContracts, parity });
        options.onProgress?.({ phase: report.currentStage, completedProfiles: report.owners.length, totalSourceOwners: ownerIds.length });
        if (!negative) negative = { profileId: profile.id, holderId: holders[0].id, unitIds: rebound.units.map(row => row.id), pattern: rebound.patterns.find(row => row.patternKind !== 'source_compilation') };
      }
    }
    check('all-selected-owner-full-record-hashes-match', () => assert.ok(report.owners.length > 0));
    report.currentStage = 'same-wire-physical-baseline';
    const codec = createSourceArtifactMetadataCodec(fixture);
    for (const [table, json, profile] of [['language_units', 'metadata_json', 'profile_id'], ['language_patterns', 'pattern_json', 'profile_id'], ['semantic_frames', 'frame_json', null], ['ngram_models', 'model_json', null]]) {
      let after = '', copiedRows = 0;
      while (true) {
        const page = await fixture.query(`SELECT to_jsonb(record) AS value FROM ${fixture.table(table)} record WHERE id>$1 ORDER BY id COLLATE "C" LIMIT 64`, [after]);
        if (!page.length) break;
        const values = page.map(row => row.value), decoded = await codec.decodeMany(values.map(value => ({ value: value[json],
          profileId: profile ? value[profile] : record(value[json]).profileId, informationLabel: value.information_label,
          ...(value.source_version_id ? { sourceVersionId: value.source_version_id } : {}) })));
        const columns = (await fixture.query(`SELECT attname FROM pg_attribute WHERE attrelid=$1::regclass AND attnum>0 AND NOT attisdropped AND attgenerated='' ORDER BY attnum`, [fixture.table(table)])).map(row => row.attname);
        const names = columns.map(name => '"' + name.replaceAll('"', '""') + '"').join(',');
        for (let index = 0; index < values.length; index++) await fixture.query(`INSERT INTO metadata_baseline_${table}(${names}) SELECT ${names} FROM jsonb_populate_record(NULL::${fixture.table(table)},$1::jsonb)`, [JSON.stringify({ ...values[index], [json]: decoded[index] })]);
        after = values.at(-1).id; copiedRows += values.length;
      }
      const [measurement] = await fixture.query(`SELECT pg_total_relation_size($1::regclass)::text AS normalized_bytes,pg_total_relation_size($2::regclass)::text AS baseline_bytes`, [fixture.table(table), `metadata_baseline_${table}`]);
      report.physical[table] = { rows: copiedRows, ...measurement };
    }
    const measuredTables = new Set(['language_units', 'language_patterns', 'semantic_frames', 'ngram_models']);
    let commonBytes = 0n, baselineBytes = 0n, normalizedBytes = 0n;
    for (const name of tables.filter(name => !measuredTables.has(name))) {
      const [row] = await fixture.query('SELECT pg_total_relation_size($1::regclass)::text AS bytes', [fixture.table(name)]); commonBytes += BigInt(row.bytes);
    }
    for (const row of Object.values(report.physical)) { baselineBytes += BigInt(row.baseline_bytes); normalizedBytes += BigInt(row.normalized_bytes); }
    report.physicalTotals = { commonTableAndIndexBytes: String(commonBytes), baselineTableAndIndexBytes: String(commonBytes + baselineBytes),
      normalizedTableAndIndexBytes: String(commonBytes + normalizedBytes), includes: 'all canonical product tables with TOAST and indexes; same shared source/evidence/profile/creative components counted in both alternatives' };
    const cold = async () => { const reader = create(fixtureConfig); readers.push(reader); bind(reader, fixturePhysical, false); await reader.languageMemory.readRevision(); return reader; };
    const readUnit = async reader => reader.languageMemory.listLanguageUnits({ profileIds: [negative.profileId], limit: 4096, maxTotalJsonBytes: 64 * 1024 * 1024 });
    report.currentStage = 'cold-reader-negative-controls';
    for (const [name, sql, params] of [
      ['missing-holder', `DELETE FROM ${fixture.table('language_patterns')} WHERE id=$1`, [negative.holderId]],
      ['changed-holder-digest', `UPDATE ${fixture.table('language_patterns')} SET pattern_json=jsonb_set(pattern_json,'{inheritedMetadata,digest}','"tampered"') WHERE id=$1`, [negative.holderId]],
      ['changed-compilation-metadata-digest', `UPDATE ${fixture.table('language_patterns')} SET pattern_json=jsonb_set(pattern_json,'{compilation,options,artifactMetadataDigest}','"tampered"') WHERE id=$1`, [negative.holderId]],
      ['changed-holder-value', `UPDATE ${fixture.table('language_patterns')} SET pattern_json=jsonb_set(pattern_json,'{inheritedMetadata,value}',COALESCE(pattern_json#>'{inheritedMetadata,value}','{}') || '{"injected":true}') WHERE id=$1`, [negative.holderId]],
      ['foreign-holder-profile', `UPDATE ${fixture.table('language_patterns')} SET profile_id='verification.foreign.profile' WHERE id=$1`, [negative.holderId]],
      ['inaccessible-holder', `UPDATE ${fixture.table('language_patterns')} SET information_label=jsonb_set(information_label,'{compartments}','["verification.inaccessible.compartment"]') WHERE id=$1`, [negative.holderId]]
    ]) {
      await fixtureQuery('SAVEPOINT metadata_negative');
      try { await fixture.query(sql, params); const reader = await cold(); let refused = false;
        try { const returned = await readUnit(reader); refused = returned.length === 0; } catch (error) { if (error?.message !== 'canonical source artifact metadata is missing, inaccessible or changed') throw error; refused = true; }
        check(name + '-cannot-return-partial-metadata', () => assert.equal(refused, true));
      } finally { await fixtureQuery('ROLLBACK TO SAVEPOINT metadata_negative'); await fixtureQuery('RELEASE SAVEPOINT metadata_negative'); }
    }
    report.currentStage = 'decoded-byte-budgets';
    const reader = await cold(), full = await readUnit(reader), tiny = await reader.languageMemory.listLanguageUnits({ profileIds: [negative.profileId], limit: 4096, maxTotalJsonBytes: 1 });
    check('unit-budget-preserves-only-existing-first-oversized-exception', () => { assert.ok(full.length > 1); assert.equal(tiny.length, 1); assert.deepEqual(tiny[0], full[0]); });
    const firstCost = durableJoinProgramJsonByteLengths(full[0].metadata).decodedJsonbBytes + Buffer.byteLength(full[0].text);
    const secondCost = durableJoinProgramJsonByteLengths(full[1].metadata).decodedJsonbBytes + Buffer.byteLength(full[1].text);
    const bounded = await reader.languageMemory.listLanguageUnits({ profileIds: [negative.profileId], limit: 4096, maxTotalJsonBytes: firstCost + secondCost - 1 });
    check('unit-prefix-budget-charges-full-restored-metadata', () => { assert.equal(bounded.length, 1); assert.deepEqual(bounded[0], full[0]); });
    const body = await reader.languageMemory.listLanguagePatterns({ patternIds: [negative.pattern.id], profileIds: [negative.profileId], limit: 1, maxTotalJsonBytes: 1, requireComplete: true });
    check('complete-pattern-budget-charges-reconstructed-metadata', () => assert.deepEqual(body, []));
    report.currentStage = 'rollback-verification';
    await fixtureQuery('ROLLBACK'); fixtureOpen = false;
    const restored = await snapshot();
    check('fixture-rows-revision-and-active-state-restored', () => assert.deepEqual(restored, initial)); report.fixtureRolledBack = true;
    await sourceQuery('ROLLBACK'); sourceOpen = false;
    report.passed = true; report.currentStage = 'complete';
  } catch (error) { report.error = { stage: report.currentStage, name: error?.name ?? 'Error', code: typeof error?.code === 'string' ? error.code : null,
    ...(error?.code === 'ERR_ASSERTION' && error.generatedMessage === false ? { assertion: String(error.message).slice(0, 240) } : {}),
    frames: typeof error?.stack === 'string' ? error.stack.split('\n').filter(line => /^\s*at /u.test(line)).slice(0, 4).map(line => line.trim()) : [] }; }
  finally {
    if (fixtureOpen) await fixturePhysical?.query('ROLLBACK'); if (sourceOpen) await sourcePhysical?.query('ROLLBACK');
    for (const original of originals.reverse()) { original.adapter.pool.query = original.query; original.adapter.pool.connect = original.connect; }
    sourcePhysical?.release(); fixturePhysical?.release();
    await Promise.allSettled([source.close(), fixture.close(), ...readers.map(reader => reader.close())]);
  }
  if (options.outputPath) await writeFile(options.outputPath, JSON.stringify(report, null, 2));
  return report;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { const report = await verifySourceArtifactMetadata({ ...parseSourceArtifactMetadataArgs(process.argv.slice(2)), onProgress: value => process.stderr.write(JSON.stringify(value) + '\n') }); console.log(JSON.stringify(report)); if (!report.passed) process.exitCode = 1; }
  catch (error) { console.log(JSON.stringify({ schema: 'scce.native_source_artifact_metadata_verification.v1', capabilityEvaluation: false, passed: false, error: { name: error?.name ?? 'Error', code: typeof error?.code === 'string' ? error.code : null } })); process.exitCode = 1; }
}
