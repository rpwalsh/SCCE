// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { createBrainDatabase, parseArguments, validateDatabaseName, verifyOutputPath } from './create-brain-database.mjs';

async function fixture(run) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'scce-new-brain-'));
  execFileSync('git', ['init', '--quiet', root]);
  await writeFile(path.join(root, '.gitignore'), '*.local.json\n');
  try { await run(root); } finally { await rm(root, { recursive: true, force: true }); }
}
const config = { database: { url: 'postgres://operator:fixture-only-password@localhost/original', schema: 'brain', ssl: false },
  security: { informationAccess: { tenantId: 'fixture', principalId: 'owner' } },
  runtime: { workspaceRoot: '/already/resolved/workspace', retained: { setting: true }, corpusSegmentation: { old: 'snapshot' } } };
function api(options = {}) {
  const calls = [];
  let adapters = 0;
  return { calls, readScceRuntimeConfig: async () => structuredClone(config), validateConfig: next => assert.equal(next.runtime.corpusSegmentation, undefined),
    createPostgresStorageAdapter: input => {
      const fresh = adapters++ > 0;
      return { table: name => `"brain"."${name}"`, migrate: async () => { calls.push(['migrate']); },
        verify: async () => ({ ok: true, tables: [] }), close: async () => { calls.push(['close']); },
        query: async (sql, params) => {
          calls.push([sql, params]);
          if (!fresh && sql.startsWith('SELECT 1')) return options.existing ? [{ present: 1 }] : [];
          if (!fresh && sql.startsWith('CREATE DATABASE')) { if (options.createError) throw Error('password=do-not-print'); return []; }
          if (fresh) return [{ count: options.nonempty ? '1' : '0' }];
          throw Error('Unexpected fixture query');
        }, input };
    } };
}

test('requires explicit new config and strict noninjectable database identity', () => {
  assert.deepEqual(parseArguments(['--config', 'old.json', '--output-config', 'new.local.json', '--database-name', 'new_brain']),
    { config: 'old.json', outputConfig: 'new.local.json', databaseName: 'new_brain' });
  for (const name of ['', 'Old', '1brain', 'a-b', 'a";DROP DATABASE x;', 'a'.repeat(64)]) assert.throws(() => validateDatabaseName(name));
  assert.equal(validateDatabaseName('a'.repeat(63)).length, 63);
  for (const args of [[], ['--config', 'a'], ['--config', 'a', '--output-config'], ['--config', 'a', '--config', 'b'], ['--unknown', 'x']]) assert.throws(() => parseArguments(args));
});

test('requires an ignored untracked new output and refuses existing files, overlays and missing parents', async () => fixture(async root => {
  const output = path.join(root, 'new.local.json');
  assert.equal(await verifyOutputPath(output), output);
  await assert.rejects(verifyOutputPath(path.join(root, 'public.json')), /not Git-ignored/u);
  await writeFile(output, 'preserve');
  await assert.rejects(verifyOutputPath(output), /already exists/u);
  assert.equal(await readFile(output, 'utf8'), 'preserve');
  await writeFile(path.join(root, 'overlay.local.local.json'), '{}');
  await assert.rejects(verifyOutputPath(path.join(root, 'overlay.local.json')), /existing local overlay/u);
  await assert.rejects(verifyOutputPath(path.join(root, 'absent', 'new.local.json')));
  const tracked = path.join(root, 'tracked.local.json'); await writeFile(tracked, '{}');
  execFileSync('git', ['-C', root, 'add', '-f', '--', 'tracked.local.json']); await rm(tracked);
  await assert.rejects(verifyOutputPath(tracked), /not Git-ignored/u);
}));

test('creates only template0 UTF8, preserves effective config, removes old global declaration and reports zero sources/learned rows', async () => fixture(async root => {
  const backend = api(), output = path.join(root, 'fresh.local.json');
  const report = await createBrainDatabase({ config: 'synthetic', outputConfig: output, databaseName: 'fresh_brain' }, { api: backend, environment: {} });
  const written = JSON.parse(await readFile(output, 'utf8'));
  const expected = structuredClone(config); delete expected.runtime.corpusSegmentation; expected.database.url = config.database.url.replace('/original', '/fresh_brain');
  assert.deepEqual(written, expected);
  assert.equal(report.passed, true); assert.equal(report.learnedDataCopied, false); assert.equal(report.capabilityEvaluation, false);
  assert.ok(Object.keys(report.counts).length > 10); assert.ok(Object.values(report.counts).every(value => value === 0));
  assert.equal(backend.calls.find(([sql]) => sql.startsWith('CREATE DATABASE'))[0], 'CREATE DATABASE "fresh_brain" TEMPLATE template0 ENCODING \'UTF8\'');
  assert.ok(!backend.calls.some(([sql]) => /DROP|COPY|pg_dump|pg_restore/u.test(sql)));
  assert.ok(!JSON.stringify(report).includes('fixture-only-password'));
}));

test('refuses database reuse, remote hosts, overriding environment and existing output before creation', async () => fixture(async root => {
  const output = path.join(root, 'fresh.local.json'), existing = api({ existing: true });
  await assert.rejects(createBrainDatabase({ config: 'synthetic', outputConfig: output, databaseName: 'occupied' }, { api: existing, environment: {} }), /already exists/u);
  assert.ok(!existing.calls.some(([sql]) => sql.startsWith('CREATE')));
  await assert.rejects(readFile(output));
  const remote = api(); remote.readScceRuntimeConfig = async () => ({ ...config, database: { ...config.database, url: 'postgres://operator:secret@example.com/original' } });
  await assert.rejects(createBrainDatabase({ config: 'synthetic', outputConfig: output }, { api: remote, environment: {} }), /local PostgreSQL/u);
  await assert.rejects(createBrainDatabase({ config: 'synthetic', outputConfig: output }, { api: api(), environment: { SCCE_DATABASE_URL: 'postgres://secret' } }), /Unset SCCE_DATABASE_URL/u);
  const same = api();
  await assert.rejects(createBrainDatabase({ config: 'synthetic', outputConfig: output, databaseName: 'original' }, { api: same, environment: {} }), /equals/u);
  assert.equal(same.calls.length, 0);
}));

test('failed CREATE leaves no output; nonempty migration retains only its ignored new config and never drops database', async () => fixture(async root => {
  const output = path.join(root, 'fresh.local.json'), failed = api({ createError: true });
  await assert.rejects(createBrainDatabase({ config: 'synthetic', outputConfig: output, databaseName: 'new_brain' }, { api: failed, environment: {} }), error => {
    assert.ok(!error.message.includes('do-not-print')); assert.equal(error.receipt.createdDatabase, false); return true;
  });
  await assert.rejects(readFile(output));
  const nonempty = api({ nonempty: true });
  await assert.rejects(createBrainDatabase({ config: 'synthetic', outputConfig: output, databaseName: 'new_brain' }, { api: nonempty, environment: {} }), error => {
    assert.equal(error.receipt.createdDatabase, true); assert.equal(error.receipt.configWritten, true); assert.equal(error.receipt.passed, false); return true;
  });
  assert.ok((await readFile(output, 'utf8')).includes('/new_brain'));
  assert.ok(!nonempty.calls.some(([sql]) => /DROP/u.test(sql)));
}));

test('an output created concurrently is preserved and prevents database creation', async () => fixture(async root => {
  const output = path.join(root, 'race.local.json'), backend = api();
  backend.readScceRuntimeConfig = async () => { await writeFile(output, 'concurrent owner'); return structuredClone(config); };
  await assert.rejects(createBrainDatabase({ config: 'synthetic', outputConfig: output, databaseName: 'new_brain' }, { api: backend, environment: {} }));
  assert.equal(await readFile(output, 'utf8'), 'concurrent owner');
  assert.ok(!backend.calls.some(([sql]) => sql.startsWith('CREATE')));
}));
