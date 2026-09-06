// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { resolveRepositoryRootDiagnostic } from './repoRoot.js';

export interface PgConnectionInfo {
  /** psql connection args, e.g. ['-d', 'postgresql://...'] or [] when PG* env vars are relied on. */
  connectionArgs: string[];
  /** Default schema to inspect when a tool call does not specify one. */
  defaultSchema: string;
  schemaSource: 'scce-config' | 'default';
}

export type PgConfigResolution =
  | { ok: true; info: PgConnectionInfo }
  | { ok: false; reason: 'config_missing'; message: string };

interface ScceConfigFile {
  database?: { url?: string; schema?: string };
}

const USABLE_PG_ENV_KEYS = ['PGDATABASE', 'PGUSER', 'PGHOST', 'PGPORT', 'PGSERVICE', 'PGPASSFILE'];

function firstNonEmpty(...values: Array<string | undefined>): string | undefined {
  return values.find((value) => value !== undefined && value.trim().length > 0);
}

function readJsonFile(path: string): ScceConfigFile | undefined {
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as ScceConfigFile;
  } catch {
    return undefined;
  }
}

/**
 * The checked-in configuration with the untracked local overlay applied, which is the order the runtime loads them
 * in.
 *
 * The overlay is where the database credential lives -- deliberately, so no secret reaches the repository -- and
 * reading only the tracked file meant every Postgres tool here connected without one and hung until its statement
 * timeout. That presents as a stale connection rather than a configuration gap, which is what it cost to find. An
 * explicit SCCE_CONFIG path is taken as given and gets no overlay, since the caller named the file they meant.
 */
function readScceConfig(): ScceConfigFile | undefined {
  const explicitPath = process.env.SCCE_CONFIG?.trim();
  if (explicitPath && explicitPath.length > 0) return readJsonFile(explicitPath);
  const { root } = resolveRepositoryRootDiagnostic();
  const base = readJsonFile(join(root, 'scce.config.json'));
  const overlay = readJsonFile(join(root, 'scce.config.local.json'));
  if (!base) return overlay;
  if (!overlay) return base;
  return { ...base, ...overlay, database: { ...base.database, ...overlay.database } };
}

/**
 * Resolve how to reach PostgreSQL for read-only inspection, following the
 * same override order the SCCE runtime itself documents: an explicit
 * SCCE_DATABASE_URL always wins, then scce.config.json with the untracked
 * scce.config.local.json overlay applied (or an SCCE_CONFIG override path),
 * then legacy DATABASE_URL/PG_URL/PG* env vars.
 * Never returns credentials in a form a caller could echo back verbatim
 * without them having supplied it themselves.
 */
export function resolvePgConnection(): PgConfigResolution {
  const config = readScceConfig();
  const configSchema = config?.database?.schema?.trim();

  const explicitUrl = firstNonEmpty(process.env.SCCE_DATABASE_URL, config?.database?.url, process.env.DATABASE_URL, process.env.PG_URL);
  if (explicitUrl) {
    return {
      ok: true,
      info: {
        connectionArgs: ['-d', explicitUrl],
        defaultSchema: configSchema && configSchema.length > 0 ? configSchema : 'public',
        schemaSource: configSchema && configSchema.length > 0 ? 'scce-config' : 'default'
      }
    };
  }

  if (USABLE_PG_ENV_KEYS.some((key) => Boolean(process.env[key]?.trim()))) {
    return {
      ok: true,
      info: {
        connectionArgs: [],
        defaultSchema: configSchema && configSchema.length > 0 ? configSchema : 'public',
        schemaSource: configSchema && configSchema.length > 0 ? 'scce-config' : 'default'
      }
    };
  }

  return {
    ok: false,
    reason: 'config_missing',
    message: 'No SCCE_DATABASE_URL, scce.config.json database.url, DATABASE_URL/PG_URL, or usable PG* env vars set'
  };
}
