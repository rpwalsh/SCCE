import { describe, expect, it, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resolvePgConnection } from '../lib/pgConfig.js';

function makeRootWithConfig(config: unknown): string {
  const root = mkdtempSync(join(tmpdir(), 'scce-mcp-pgcfg-'));
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

describe('resolvePgConnection', () => {
  it('reports config_missing when nothing is configured', () => {
    const root = makeRootWithConfig({});
    created.push(root);
    clearPgEnv();
    process.env.SCCE_REPO_ROOT = root;
    const result = resolvePgConnection();
    expect(result.ok).toBe(false);
  });

  it('prefers an explicit SCCE_DATABASE_URL', () => {
    const root = makeRootWithConfig({ database: { url: 'postgresql://config-only/db', schema: 'from_config' } });
    created.push(root);
    clearPgEnv();
    process.env.SCCE_REPO_ROOT = root;
    process.env.SCCE_DATABASE_URL = 'postgresql://from-env/db';
    const result = resolvePgConnection();
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.info.connectionArgs).toEqual(['-d', 'postgresql://from-env/db']);
  });

  it('defaults the inspection schema from scce.config.json rather than "public"', () => {
    const root = makeRootWithConfig({ database: { url: 'postgresql://cfg/db', schema: 'scce3_runtime' } });
    created.push(root);
    clearPgEnv();
    process.env.SCCE_REPO_ROOT = root;
    const result = resolvePgConnection();
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.info.defaultSchema).toBe('scce3_runtime');
      expect(result.info.schemaSource).toBe('scce-config');
    }
  });

  it('falls back to "public" only when no config schema is available', () => {
    const root = makeRootWithConfig({ database: { url: 'postgresql://cfg/db' } });
    created.push(root);
    clearPgEnv();
    process.env.SCCE_REPO_ROOT = root;
    const result = resolvePgConnection();
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.info.defaultSchema).toBe('public');
      expect(result.info.schemaSource).toBe('default');
    }
  });

  it('treats usable PG* env vars as sufficient without a URL', () => {
    const root = makeRootWithConfig({});
    created.push(root);
    clearPgEnv();
    process.env.SCCE_REPO_ROOT = root;
    process.env.PGDATABASE = 'scce';
    const result = resolvePgConnection();
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.info.connectionArgs).toEqual([]);
  });
});
