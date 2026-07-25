import { describe, expect, it, afterEach, beforeEach } from 'vitest';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { handleGitChanged, handleGitDiffSummary } from '../tools/git.js';

const repoRoot = resolve(fileURLToPath(new URL('.', import.meta.url)), '..', '..', '..', '..');
const originalRepoRoot = process.env.SCCE_REPO_ROOT;

beforeEach(() => {
  process.env.SCCE_REPO_ROOT = repoRoot;
});

afterEach(() => {
  if (originalRepoRoot === undefined) delete process.env.SCCE_REPO_ROOT;
  else process.env.SCCE_REPO_ROOT = originalRepoRoot;
});

describe('handleGitChanged', () => {
  it('returns the working-tree status of the resolved repository root', async () => {
    const out = JSON.parse(await handleGitChanged());
    expect(Array.isArray(out.changed)).toBe(true);
  }, 15000);
});

describe('handleGitDiffSummary', () => {
  it('returns bounded stat rows and hunk text without throwing on a clean-ish repo', async () => {
    const out = JSON.parse(await handleGitDiffSummary({ maxLines: 50 }));
    expect(Array.isArray(out.diff)).toBe(true);
    expect(typeof out.hunks).toBe('string');
  }, 20000);
});
