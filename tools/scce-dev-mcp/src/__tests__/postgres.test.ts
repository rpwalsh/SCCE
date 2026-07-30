import { describe, expect, it, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { handlePgSchema, handlePgExplain } from '../tools/postgres.js';

function makeRootWithConfig(config: unknown): string {
  const root = mkdtempSync(join(tmpdir(), 'scce-mcp-pgtool-'));
  writeFileSync(join(root, 'README.md'), '# marker');
  writeFileSync(join(root, 'pnpm-workspace.yaml'), 'packages:\n  - packages/*\n');
  mkdirSync(join(root, 'packages', 'kernel', 'src'), { recursive: true });
  writeFileSync(join(root, 'packages', 'kernel', 'src', 'kernel.ts'), '// marker');
  writeFileSync(join(root, 'scce.config.json'), JSON.stringify(config));
  return root;
}

const PG_KEYS = ['SCCE_DATABASE_URL', 'SCCE_CONFIG', 'DATABASE_URL', 'PG_URL', 'PGDATABASE', 'PGUSER', 'PGHOST', 'PGPORT', 'PGSERVICE', 'PGPASSFILE', 'SCCE_REPO_ROOT'] as const;
const originalEnv: Record<string, string | undefined> = {};
for (const key of PG_KEYS) originalEnv[key] = process.env[key];
const created: string[] = [];

afterEach(() => {
  for (const key of PG_KEYS) {
    if (originalEnv[key] === undefined) delete process.env[key];
    else process.env[key] = originalEnv[key];
  }
  for (const dir of created.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function clearPgEnv() {
  for (const key of PG_KEYS) delete process.env[key];
}

describe('handlePgSchema', () => {
  it('reports config_missing without attempting a connection', async () => {
    const root = makeRootWithConfig({});
    created.push(root);
    clearPgEnv();
    process.env.SCCE_REPO_ROOT = root;
    const out = JSON.parse(await handlePgSchema({}));
    expect(out.error).toBe('config_missing');
  });

  it('reports connection_failed for an unreachable but well-formed connection target', async () => {
    const root = makeRootWithConfig({ database: { url: 'postgresql://localhost:1/nonexistent', schema: 'scce3_runtime' } });
    created.push(root);
    clearPgEnv();
    process.env.SCCE_REPO_ROOT = root;
    const out = JSON.parse(await handlePgSchema({}));
    expect(['connection_failed', 'query_failed']).toContain(out.error);
  }, 30000);

  it('rejects an invalid schema identifier before connecting', async () => {
    const root = makeRootWithConfig({ database: { url: 'postgresql://localhost:1/nonexistent', schema: 'scce3_runtime' } });
    created.push(root);
    clearPgEnv();
    process.env.SCCE_REPO_ROOT = root;
    const out = JSON.parse(await handlePgSchema({ schema: "public'; DROP TABLE events; --" }));
    expect(out.error).toBeDefined();
  });
});

describe('handlePgExplain', () => {
  it('reports config_missing without attempting a connection', async () => {
    const root = makeRootWithConfig({});
    created.push(root);
    clearPgEnv();
    process.env.SCCE_REPO_ROOT = root;
    const out = JSON.parse(await handlePgExplain({ sql: 'SELECT 1' }));
    expect(out.error).toBe('config_missing');
  });

  it('rejects mutating SQL before connecting', async () => {
    const root = makeRootWithConfig({ database: { url: 'postgresql://localhost:1/nonexistent', schema: 's' } });
    created.push(root);
    clearPgEnv();
    process.env.SCCE_REPO_ROOT = root;
    const out = JSON.parse(await handlePgExplain({ sql: "DELETE FROM events WHERE 1=1" }));
    expect(out.error).toBe('sql_rejected');
  });

  it('rejects EXPLAIN ANALYZE before connecting', async () => {
    const root = makeRootWithConfig({ database: { url: 'postgresql://localhost:1/nonexistent', schema: 's' } });
    created.push(root);
    clearPgEnv();
    process.env.SCCE_REPO_ROOT = root;
    const out = JSON.parse(await handlePgExplain({ sql: 'EXPLAIN ANALYZE SELECT * FROM events' }));
    expect(out.error).toBe('sql_rejected');
  });

  it('rejects non-SELECT statements before connecting', async () => {
    const root = makeRootWithConfig({ database: { url: 'postgresql://localhost:1/nonexistent', schema: 's' } });
    created.push(root);
    clearPgEnv();
    process.env.SCCE_REPO_ROOT = root;
    const out = JSON.parse(await handlePgExplain({ sql: 'DROP TABLE events' }));
    expect(out.error).toBe('sql_rejected');
  });
});
