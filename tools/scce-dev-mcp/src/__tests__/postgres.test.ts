import { describe, expect, it, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { handlePgSchema, handlePgQuery, handlePgExplain } from '../tools/postgres.js';

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

describe('handlePgQuery', () => {
  it('reports config_missing without attempting a connection', async () => {
    const root = makeRootWithConfig({});
    created.push(root);
    clearPgEnv();
    process.env.SCCE_REPO_ROOT = root;
    const out = JSON.parse(await handlePgQuery({ sql: 'SELECT 1' }));
    expect(out.error).toBe('config_missing');
  });

  it('rejects non-SELECT statements before connecting', async () => {
    const root = makeRootWithConfig({ database: { url: 'postgresql://localhost:1/nonexistent', schema: 's' } });
    created.push(root);
    clearPgEnv();
    process.env.SCCE_REPO_ROOT = root;
    const out = JSON.parse(await handlePgQuery({ sql: 'DELETE FROM events WHERE 1=1' }));
    expect(out.error).toBe('sql_rejected');
  });

  it('rejects EXPLAIN before connecting (use pg_explain instead)', async () => {
    const root = makeRootWithConfig({ database: { url: 'postgresql://localhost:1/nonexistent', schema: 's' } });
    created.push(root);
    clearPgEnv();
    process.env.SCCE_REPO_ROOT = root;
    const out = JSON.parse(await handlePgQuery({ sql: 'EXPLAIN SELECT * FROM events' }));
    expect(out.error).toBe('sql_rejected');
  });

  it('rejects stacked statements before connecting', async () => {
    const root = makeRootWithConfig({ database: { url: 'postgresql://localhost:1/nonexistent', schema: 's' } });
    created.push(root);
    clearPgEnv();
    process.env.SCCE_REPO_ROOT = root;
    const out = JSON.parse(await handlePgQuery({ sql: 'SELECT 1; DROP TABLE events;' }));
    expect(out.error).toBe('sql_rejected');
  });

  it('CRITICAL fix: rejects SELECT INTO before connecting -- a nominally read-only SELECT that actually creates a table', async () => {
    const root = makeRootWithConfig({ database: { url: 'postgresql://localhost:1/nonexistent', schema: 's' } });
    created.push(root);
    clearPgEnv();
    process.env.SCCE_REPO_ROOT = root;
    const out = JSON.parse(await handlePgQuery({ sql: 'SELECT * INTO stolen_table FROM events' }));
    expect(out.error).toBe('sql_rejected');
  });

  it('CRITICAL fix: rejects SQL comments before connecting -- comments are the standard tool for splitting a blocked keyword across a token boundary', async () => {
    const root = makeRootWithConfig({ database: { url: 'postgresql://localhost:1/nonexistent', schema: 's' } });
    created.push(root);
    clearPgEnv();
    process.env.SCCE_REPO_ROOT = root;
    const lineComment = JSON.parse(await handlePgQuery({ sql: 'SELECT 1 -- sneaky\n' }));
    expect(lineComment.error).toBe('sql_rejected');
    const blockComment = JSON.parse(await handlePgQuery({ sql: 'SELECT 1 /* sneaky */' }));
    expect(blockComment.error).toBe('sql_rejected');
  });

  it('CRITICAL fix: rejects a known-dangerous function call before connecting', async () => {
    const root = makeRootWithConfig({ database: { url: 'postgresql://localhost:1/nonexistent', schema: 's' } });
    created.push(root);
    clearPgEnv();
    process.env.SCCE_REPO_ROOT = root;
    const sleep = JSON.parse(await handlePgQuery({ sql: 'SELECT pg_sleep(100)' }));
    expect(sleep.error).toBe('sql_rejected');
    const advisoryLock = JSON.parse(await handlePgQuery({ sql: 'SELECT pg_advisory_lock(1)' }));
    expect(advisoryLock.error).toBe('sql_rejected');
    const readFile = JSON.parse(await handlePgQuery({ sql: "SELECT pg_read_file('/etc/passwd')" }));
    expect(readFile.error).toBe('sql_rejected');
  });

  it('CRITICAL fix: rejects EXECUTE/PREPARE/LISTEN/NOTIFY before connecting', async () => {
    const root = makeRootWithConfig({ database: { url: 'postgresql://localhost:1/nonexistent', schema: 's' } });
    created.push(root);
    clearPgEnv();
    process.env.SCCE_REPO_ROOT = root;
    expect(JSON.parse(await handlePgQuery({ sql: 'EXECUTE some_plan' })).error).toBe('sql_rejected');
    expect(JSON.parse(await handlePgQuery({ sql: 'SELECT 1 FROM (PREPARE p AS SELECT 1) x' })).error).toBe('sql_rejected');
    expect(JSON.parse(await handlePgQuery({ sql: "SELECT 1, NOTIFY" })).error).toBe('sql_rejected');
  });

  it('still accepts a normal, valid inspection query -- the hardening does not reject legitimate SELECTs', async () => {
    const root = makeRootWithConfig({ database: { url: 'postgresql://localhost:1/nonexistent', schema: 's' } });
    created.push(root);
    clearPgEnv();
    process.env.SCCE_REPO_ROOT = root;
    const out = JSON.parse(await handlePgQuery({ sql: 'SELECT id, kind FROM graph_nodes WHERE alpha > 0.5 ORDER BY updated_at DESC' }));
    // Reaches the (unreachable) connection attempt rather than being
    // rejected at the SQL-validation stage.
    expect(['connection_failed', 'query_failed']).toContain(out.error);
  }, 30000);

  it('reports connection_failed for an unreachable but well-formed connection target', async () => {
    const root = makeRootWithConfig({ database: { url: 'postgresql://localhost:1/nonexistent', schema: 's' } });
    created.push(root);
    clearPgEnv();
    process.env.SCCE_REPO_ROOT = root;
    const out = JSON.parse(await handlePgQuery({ sql: 'SELECT * FROM events', maxRows: 5 }));
    expect(['connection_failed', 'query_failed']).toContain(out.error);
  }, 30000);
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

  it('CRITICAL fix: rejects SQL comments before connecting, same as handlePgQuery', async () => {
    const root = makeRootWithConfig({ database: { url: 'postgresql://localhost:1/nonexistent', schema: 's' } });
    created.push(root);
    clearPgEnv();
    process.env.SCCE_REPO_ROOT = root;
    const out = JSON.parse(await handlePgExplain({ sql: 'SELECT 1 -- sneaky' }));
    expect(out.error).toBe('sql_rejected');
  });

  it('CRITICAL fix: rejects a known-dangerous function call before connecting, same as handlePgQuery', async () => {
    const root = makeRootWithConfig({ database: { url: 'postgresql://localhost:1/nonexistent', schema: 's' } });
    created.push(root);
    clearPgEnv();
    process.env.SCCE_REPO_ROOT = root;
    const out = JSON.parse(await handlePgExplain({ sql: 'SELECT pg_sleep(100)' }));
    expect(out.error).toBe('sql_rejected');
  });
});
