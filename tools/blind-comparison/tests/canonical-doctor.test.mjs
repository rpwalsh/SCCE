import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { discoverNativeTools } from '../campaign-discovery.mjs';
import { fileHash } from '../protocol.mjs';
test('doctor reuses canonical native capability discovery and hashes its actual outside-PATH executable without another path list/probe', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'scce-canonical-doctor-'));
  try {
    const commands = {}, calls = [];
    for (const language of ['python', 'rust', 'go']) { commands[language] = path.join(root, `${language}.exe`); await writeFile(commands[language], `fixture executable ${language}`); }
    const tools = await discoverNativeTools({ timeMs: 10000, outputBytes: 65536 }, { findVerifierCapability: async language => { calls.push(language); return { languageId: language, status: 'available', verifier: { command: commands[language], version: `${language}-canonical-version` } }; }, exec: async () => assert.fail('Do not replace canonical discovery with another version probe') });
    assert.deepEqual(calls, ['python', 'rust', 'go']);
    for (const language of calls) {
      assert.equal(tools[language].available, true);
      assert.equal(tools[language].path, commands[language]);
      assert.equal(tools[language].version, `${language}-canonical-version`);
      assert.equal(tools[language].sha256, await fileHash(commands[language]));
      assert.equal(tools[language].discovery, 'canonical_findCodeVerifierCapability');
    }
  } finally { await rm(root, { recursive: true, force: true }); }
});
