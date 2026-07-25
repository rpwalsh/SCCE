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

function readScceConfig(): ScceConfigFile | undefined {
  const explicitPath = process.env.SCCE_CONFIG?.trim();
  const { root } = resolveRepositoryRootDiagnostic();
  const candidatePath = explicitPath && explicitPath.length > 0 ? explicitPath : join(root, 'scce.config.json');
  try {
    return JSON.parse(readFileSync(candidatePath, 'utf8')) as ScceConfigFile;
  } catch {
    return undefined;
  }
}

/**
 * Resolve how to reach PostgreSQL for read-only inspection, following the
 * same override order the SCCE runtime itself documents: an explicit
 * SCCE_DATABASE_URL always wins, then the checked-in scce.config.json (or an
 * SCCE_CONFIG override path), then legacy DATABASE_URL/PG_URL/PG* env vars.
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
