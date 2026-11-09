// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseSourceArtifactMetadataArgs, readInternalSourceCompilationPatterns, publishNativeArtifactSourceProjection, describeNativeArtifactPatternRead } from './verify-source-artifact-metadata.mjs';

test('requires two explicit configs and never overwrites either with its receipt', () => {
  assert.deepEqual(parseSourceArtifactMetadataArgs(['--source-config', 'source.json', '--fixture-config', 'fresh.json']),
    { sourceConfigPath: 'source.json', fixtureConfigPath: 'fresh.json', sourceSystem: 'wikipedia', outputPath: undefined });
  for (const args of [[], ['--source-config', 'source.json'], ['--source-config', 'same.json', '--fixture-config', 'same.json'],
    ['--source-config', 's', '--fixture-config', 'f', '--output', 's'], ['--source-config', 's', '--fixture-config', 'f', '--model', 'x'],
    ['--source-config', 's', '--fixture-config', 'f', '--fixture-config', 'g']]) assert.throws(() => parseSourceArtifactMetadataArgs(args));
});

function internalFixture(override = {}) {
  const calls = [];
  const row = { id: 'coverage.internal', profile_id: 'profile.owned', pattern_kind: 'source_compilation', support: '0.5', entropy: '0',
    pattern_json: { schema: 'coverage.fixture', unknown: { retained: ['語', '\0', null] } }, evidence_ids: ['evidence.owned'],
    updated_at: new Date(1700000000000), information_label: { tenantId: 'owner' }, ...override };
  const storage = { table: name => `fixture.${name}`, informationAccessPredicate: (alias, position) => ({ sql: `${alias}.information_label=$${position}`, params: ['access.owner'] }),
    async query(sql, params) { calls.push({ sql, params }); return calls.length === 1 ? [row] : []; } };
  const methods = { profileSourceOwnershipSql(_storage, params, alias) { params.push('source.owner'); return `${alias}.source_version_id=$${params.length}`; },
    normalizeInformationLabel: value => value, decodeMany: async values => values.map(row => row.value),
    jsonByteLengths: value => ({ decodedJsonbBytes: Buffer.byteLength(JSON.stringify(value)) }) };
  return { row, calls, storage, methods };
}

test('preserves complete internal receipts through explicit ACL and canonical profile ownership without the serving port', async () => {
  const fixture = internalFixture();
  const values = await readInternalSourceCompilationPatterns(fixture.storage, 'profile.owned', fixture.methods);
  assert.deepEqual(values, [{ id: fixture.row.id, profileId: 'profile.owned', patternKind: 'source_compilation', support: 0.5, entropy: 0,
    patternJson: fixture.row.pattern_json, evidenceIds: fixture.row.evidence_ids, updatedAt: 1700000000000, informationLabel: fixture.row.information_label }]);
  assert.equal(fixture.calls.length, 2);
  const { sql, params } = fixture.calls[0];
  for (const required of ["pattern.pattern_kind='source_compilation'", 'pattern.information_label=$3', 'profile.information_label=$4', 'profile.source_version_id=$5', 'LIMIT 64']) assert.ok(sql.includes(required));
  assert.deepEqual(params, ['profile.owned', '', 'access.owner', 'access.owner', 'source.owner']);
  assert.equal(fixture.calls[1].params[1], fixture.row.id);
});

test('internal receipt reads reject foreign identity, a failed decoder, or decoded byte overflow', async () => {
  for (const change of [{ profile_id: 'profile.foreign' }, { pattern_kind: 'semantic_role' }]) {
    const fixture = internalFixture(change);
    await assert.rejects(readInternalSourceCompilationPatterns(fixture.storage, 'profile.owned', fixture.methods));
  }
  const oversized = internalFixture(); oversized.methods.jsonByteLengths = () => ({ decodedJsonbBytes: 64 * 1024 * 1024 + 1 });
  await assert.rejects(readInternalSourceCompilationPatterns(oversized.storage, 'profile.owned', oversized.methods), /decoded byte budget/);
  const broken = internalFixture(); const error = Error('changed owner-bound reference'); broken.methods.decodeMany = async () => { throw error; };
  await assert.rejects(readInternalSourceCompilationPatterns(broken.storage, 'profile.owned', broken.methods), failure => failure === error);
});

function publicationFixture(change) {
  const calls = [], published = [], owner = { sourceId: 'source.actual', sourceVersionId: 'version.actual', contentHash: 'hash.actual' },
    profile = { id: 'profile.actual', informationLabel: { tenantId: 'owner' } }, scopes = [{ patternSchema: 'construction', componentRecipe: 'compiler.actual' }, { patternSchema: 'compatibility', componentRecipe: 'compiler.compatibility' }];
  const patterns = [{ id: 'pattern.actual', patternJson: { schema: 'construction' } }, { id: 'receipt.internal', patternJson: { schema: 'source.compilation' } }];
  const source = { languageMemory: { async getLanguagePatternProjection(query) { calls.push(query);
    const value = { ...query, patternIds: query.patternSchema === 'construction' ? ['pattern.actual'] : [] };
    return change ? change(value) : value; } } };
  return { calls, published, input: { source, fixture: { languageMemory: {} }, owner, profile, sourceSystem: 'wikipedia',
    originalPatterns: patterns, patterns, priorCompilationId: 'prior.compilation', scopes }, publisher: async input => { published.push(input); } };
}

test('native fixture uses the normal publisher with exact real owner and validated source active scopes, including empty scopes', async () => {
  const fixture = publicationFixture();
  assert.deepEqual(await publishNativeArtifactSourceProjection(fixture.input, fixture.publisher), fixture.input.scopes);
  assert.equal(fixture.published.length, 1);
  assert.deepEqual(fixture.published[0].owner, fixture.input.owner);
  assert.deepEqual(fixture.published[0].patterns, fixture.input.patterns);
  assert.deepEqual(fixture.published[0].projections, fixture.input.scopes);
  for (const query of fixture.calls) { assert.equal(query.sourceCompilationId, 'prior.compilation'); assert.equal(query.sourceId, 'source.actual'); assert.equal(query.profileId, 'profile.actual'); }
});

test('missing, stale-member, or foreign-owner source projections cannot publish a fixture', async () => {
  for (const change of [() => undefined, value => ({ ...value, patternIds: [] }), value => ({ ...value, sourceId: 'source.foreign' })]) {
    const fixture = publicationFixture(change);
    await assert.rejects(publishNativeArtifactSourceProjection(fixture.input, fixture.publisher));
    assert.equal(fixture.published.length, 0);
  }
});

test('servable read diagnostics retain exact missing identities and schemas instead of weakening the expected set', () => {
  const expected = [{ id: 'kept', patternJson: { schema: 'syntax' } }, { id: 'missing', patternJson: { schema: 'construction' } }];
  assert.deepEqual(describeNativeArtifactPatternRead(expected, [expected[0], { id: 'foreign' }]),
    { expectedCount: 2, actualCount: 2, missing: [{ id: 'missing', schema: 'construction' }], extraIds: ['foreign'] });
});
