// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseSourceBrainPublicationArgs } from './verify-source-brain-publication.mjs';
test('requires explicit fresh database config without service or model flags', () => {
  assert.deepEqual(parseSourceBrainPublicationArgs(['--config', 'fresh.local.json']), { configPath: 'fresh.local.json', outputPath: undefined });
  assert.deepEqual(parseSourceBrainPublicationArgs(['--output', 'receipt.json', '--config', 'fresh.local.json']), { configPath: 'fresh.local.json', outputPath: 'receipt.json' });
  for (const args of [[], ['--config'], ['--output', 'receipt.json'], ['--config', '--output'], ['--config', 'a', '--config', 'b'], ['--config', 'a', '--model', 'anything'], ['--config', 'a', '--activate'], ['--config', 'same.json', '--output', 'same.json']])
    assert.throws(() => parseSourceBrainPublicationArgs(args));
});
