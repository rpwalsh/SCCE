// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, realpath, mkdir, access, rm } from 'node:fs/promises';
import { dirname, join, basename } from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';
import { parseMeasurementArguments, measureIngestionStorage } from './measure-ingestion-storage.mjs';

test('measurement requires explicit connection, complete local inputs, and a new output destination', () => {
  for (const args of [[], ['--config=x'], ['--config=x', '--input=a.txt'], ['--input=a.txt', '--out=ignored/new']]) assert.throws(() => parseMeasurementArguments(args));
  const options = parseMeasurementArguments(['--config=x', '--input=a.txt', '--input=b.txt', '--out=ignored/new', '--transcript', '--readback', '--request-seed']);
  assert.deepEqual(options.input, ['a.txt', 'b.txt']);
  assert.equal(options.transcript, true); assert.equal(options.readback, true); assert.equal(options['request-seed'], true);
  assert.equal(options['skip-observations'], undefined); assert.equal(options['max-input-bytes'], undefined);
});

test('resource and ngram overrides reject invalid values instead of truncating or silently changing defaults', () => {
  const base = ['--config=x', '--input=a.txt', '--out=ignored/new'];
  for (const flag of ['ngram-max-order', 'ngram-max-counters', 'ngram-vocabulary-limit', 'max-evidence-chunk-bytes', 'max-input-bytes']) {
    for (const bad of ['0', '-1', 'NaN', '1.5', '9007199254740992']) assert.throws(() => parseMeasurementArguments([...base, `--${flag}=${bad}`]));
  }
  assert.equal(parseMeasurementArguments([...base, '--created-at=0'])['created-at'], '0');
  assert.throws(() => parseMeasurementArguments([...base, '--created-at=-1']));
  assert.throws(() => parseMeasurementArguments([...base, '--truncate=100']));
});

test('help is available without creating a database or loading built ingestion modules', () => {
  assert.equal(parseMeasurementArguments(['--help']).help, true);
});

test('unignored or existing output directories fail before reading config or contacting a database', async () => {
  const parent = await realpath(tmpdir()), root = await realpath(await mkdtemp(join(parent, 'scce-measure-guard-')));
  try {
    execFileSync('git', ['init', '--quiet', root], { stdio: 'ignore', windowsHide: true });
    const unignored = join(root, 'unignored-output');
    await assert.rejects(measureIngestionStorage({ config: 'must-not-read', input: ['must-not-read'], out: unignored }), /Git-ignored/);
    await assert.rejects(access(join(unignored, 'fixture.local.json')));
    const existing = join(root, 'existing-output'); await mkdir(existing);
    await assert.rejects(measureIngestionStorage({ config: 'must-not-read', input: ['must-not-read'], out: existing }), { code: 'EEXIST' });
  } finally {
    assert.equal(dirname(root), parent); assert.ok(basename(root).startsWith('scce-measure-guard-'));
    await rm(root, { recursive: true, force: true });
  }
});
