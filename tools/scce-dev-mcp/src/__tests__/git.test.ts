// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
import { describe, expect, it, afterEach, beforeEach } from 'vitest';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { handleGitChanged, handleGitDiffSummary, handleGitLog } from '../tools/git.js';

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

describe('handleGitLog', () => {
  it('returns commits capped at maxCount with a truncated flag', async () => {
    const out = JSON.parse(await handleGitLog({ maxCount: 3 }));
    expect(Array.isArray(out.commits)).toBe(true);
    expect(out.commits.length).toBeLessThanOrEqual(3);
    if (out.commits.length > 0) {
      const commit = out.commits[0];
      expect(typeof commit.hash).toBe('string');
      expect(typeof commit.date).toBe('string');
      expect(typeof commit.author).toBe('string');
      expect(typeof commit.subject).toBe('string');
    }
    expect(typeof out.truncated).toBe('boolean');
  }, 15000);
});
