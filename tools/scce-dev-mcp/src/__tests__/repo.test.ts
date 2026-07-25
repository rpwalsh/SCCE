import { describe, expect, it, afterEach, beforeEach } from 'vitest';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { handleRepoShape, handleRepoFiles, handleRepoSearch, handleRepoRoutes, handleRepoSymbol } from '../tools/repo.js';

const repoRoot = resolve(fileURLToPath(new URL('.', import.meta.url)), '..', '..', '..', '..');
const originalRepoRoot = process.env.SCCE_REPO_ROOT;

beforeEach(() => {
  process.env.SCCE_REPO_ROOT = repoRoot;
});

afterEach(() => {
  if (originalRepoRoot === undefined) delete process.env.SCCE_REPO_ROOT;
  else process.env.SCCE_REPO_ROOT = originalRepoRoot;
});

describe('handleRepoShape', () => {
  it('reports real workspace packages and scripts from this checkout', async () => {
    const out = JSON.parse(await handleRepoShape());
    expect(out.packages).toEqual(expect.arrayContaining(['packages/*']));
    expect(out.scripts.build).toBeDefined();
  }, 15000);
});

describe('handleRepoFiles', () => {
  it('applies the contains filter before truncating, not after', async () => {
    const out = JSON.parse(await handleRepoFiles({ glob: 'packages/kernel/src/*.ts', contains: 'functional-cognition', maxResults: 5 }));
    expect(out.matches.length).toBeGreaterThan(0);
    expect(out.matches.every((m: string) => m.includes('functional-cognition'))).toBe(true);
  }, 20000);
});

describe('handleRepoSearch', () => {
  it('finds a known real symbol in the kernel', async () => {
    const out = JSON.parse(await handleRepoSearch({ query: 'createFunctionalCognitionEngine', maxResults: 10 }));
    expect(out.matches.length).toBeGreaterThan(0);
  }, 20000);
});

describe('handleRepoRoutes', () => {
  it('parses the declarative ROUTES table from packages/server/src/routes.ts', async () => {
    const out = JSON.parse(await handleRepoRoutes());
    expect(Array.isArray(out.declarativeRoutes)).toBe(true);
    expect(out.declarativeRoutes.some((r: { method: string; path: string }) => r.method === 'GET' && r.path === '/api/ready')).toBe(true);
  }, 20000);
});

describe('handleRepoSymbol', () => {
  it('labels itself as text-based search, not compiler-level resolution', async () => {
    const out = JSON.parse(await handleRepoSymbol({ symbol: 'DEFAULT_POLICY' }));
    expect(out.method).toBe('ripgrep-text-search');
  }, 20000);
});
