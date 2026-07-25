import { describe, expect, it, afterEach, beforeEach } from 'vitest';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { handleTestRun, handleTestFailures } from '../tools/tests.js';

const repoRoot = resolve(fileURLToPath(new URL('.', import.meta.url)), '..', '..', '..', '..');
const originalRepoRoot = process.env.SCCE_REPO_ROOT;

beforeEach(() => {
  process.env.SCCE_REPO_ROOT = repoRoot;
});

afterEach(() => {
  if (originalRepoRoot === undefined) delete process.env.SCCE_REPO_ROOT;
  else process.env.SCCE_REPO_ROOT = originalRepoRoot;
});

describe('handleTestRun', () => {
  it('runs a real, fast, non-mutating registered command end to end', async () => {
    const out = JSON.parse(await handleTestRun({ commandId: 'shape' }));
    expect(out.ok).toBe(true);
    expect(out.exitCode).toBe(0);
  }, 30000);

  it('rejects an unregistered commandId instead of running it', async () => {
    const out = JSON.parse(await handleTestRun({ commandId: 'rm -rf /' }));
    expect(out.error).toBe('unknown_command');
  });

  it('rejects a filter on a non-filterable command', async () => {
    const out = JSON.parse(await handleTestRun({ commandId: 'shape', filter: 'anything' }));
    expect(out.error).toBe('unsupported_filter');
  });

  it('rejects a filter containing shell metacharacters', async () => {
    const out = JSON.parse(await handleTestRun({ commandId: 'unit', filter: '$(whoami)' }));
    expect(out.error).toBe('invalid_filter');
  });
});

describe('handleTestFailures', () => {
  it('rejects an unregistered commandId instead of running it', async () => {
    const out = JSON.parse(await handleTestFailures({ commandId: 'anything-not-registered' }));
    expect(out.error).toBe('unknown_command');
  });
});
