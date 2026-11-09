// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseSourceArtifactMetadataArgs } from './verify-source-artifact-metadata.mjs';

test('requires two explicit configs and never overwrites either with its receipt', () => {
  assert.deepEqual(parseSourceArtifactMetadataArgs(['--source-config', 'source.json', '--fixture-config', 'fresh.json']),
    { sourceConfigPath: 'source.json', fixtureConfigPath: 'fresh.json', sourceSystem: 'wikipedia', outputPath: undefined });
  for (const args of [[], ['--source-config', 'source.json'], ['--source-config', 'same.json', '--fixture-config', 'same.json'],
    ['--source-config', 's', '--fixture-config', 'f', '--output', 's'], ['--source-config', 's', '--fixture-config', 'f', '--model', 'x'],
    ['--source-config', 's', '--fixture-config', 'f', '--fixture-config', 'g']]) assert.throws(() => parseSourceArtifactMetadataArgs(args));
});
