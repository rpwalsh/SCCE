import { describe, expect, it, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resolveRepositoryRoot, resolveRepositoryRootDiagnostic, InvalidRepositoryRootError } from '../lib/repoRoot.js';

function makeValidRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'scce-mcp-root-'));
  writeFileSync(join(root, 'README.md'), '# marker');
  writeFileSync(join(root, 'pnpm-workspace.yaml'), 'packages:\n  - packages/*\n');
  mkdirSync(join(root, 'packages', 'kernel', 'src'), { recursive: true });
  writeFileSync(join(root, 'packages', 'kernel', 'src', 'kernel.ts'), '// marker');
  return root;
}

const originalEnv = { ...process.env };
const created: string[] = [];

afterEach(() => {
  process.env = { ...originalEnv };
  for (const dir of created.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('resolveRepositoryRoot', () => {
  it('uses an explicit SCCE_REPO_ROOT override', () => {
    const root = makeValidRoot();
    created.push(root);
    process.env.SCCE_REPO_ROOT = root;
    delete process.env.CLAUDE_PROJECT_DIR;
    expect(resolveRepositoryRoot()).toBe(root);
  });

  it('falls back to CLAUDE_PROJECT_DIR when SCCE_REPO_ROOT is unset', () => {
    const root = makeValidRoot();
    created.push(root);
    delete process.env.SCCE_REPO_ROOT;
    process.env.CLAUDE_PROJECT_DIR = root;
    expect(resolveRepositoryRoot()).toBe(root);
  });

  it('falls back to process.cwd() when neither env var is set', () => {
    delete process.env.SCCE_REPO_ROOT;
    delete process.env.CLAUDE_PROJECT_DIR;
    const diagnostic = resolveRepositoryRootDiagnostic();
    expect(diagnostic.source).toBe('cwd');
  });

  it('fails explicitly on a root missing SCCE marker files instead of silently proceeding', () => {
    const root = mkdtempSync(join(tmpdir(), 'scce-mcp-bad-root-'));
    created.push(root);
    process.env.SCCE_REPO_ROOT = root;
    expect(() => resolveRepositoryRoot()).toThrow(InvalidRepositoryRootError);
  });
});
