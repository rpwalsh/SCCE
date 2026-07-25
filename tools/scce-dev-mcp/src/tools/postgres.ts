import { runProcess } from '../lib/run.js';
import { truncate } from '../lib/run.js';
import { resolvePgConnection } from '../lib/pgConfig.js';
import { sqlIdentifier } from '../lib/validate.js';

const BLOCKED_SQL = /\b(INSERT|UPDATE|DELETE|MERGE|ALTER|DROP|TRUNCATE|COPY|CALL|DO|CREATE|VACUUM|ANALYZE|GRANT|REVOKE|SET|RESET|LOCK|REFRESH|REINDEX|CLUSTER)\b/i;
const EXPLAIN_ANALYZE = /^\s*EXPLAIN\s+(?:ANALYZE\b|\([^)]*\bANALYZE\b[^)]*\))/i;
const PSQL_TIMEOUT_MS = 20_000;

type PgErrorReason = 'config_missing' | 'psql_missing' | 'auth_failed' | 'connection_failed' | 'schema_missing' | 'sql_rejected' | 'query_failed';

function pgError(reason: PgErrorReason, message: string): string {
  return JSON.stringify({ error: reason, message });
}

async function runPsql(baseArgs: string[], sql: string): Promise<{ ok: true; stdout: string } | { ok: false; error: string }> {
  const status = await runProcess({
    commandId: 'psql',
    command: 'psql',
    args: [...baseArgs, '-v', 'ON_ERROR_STOP=1', '-Atc', sql],
    cwd: process.cwd(),
    timeoutMs: PSQL_TIMEOUT_MS
  });
  if (status.spawnError) return { ok: false, error: pgError('psql_missing', 'psql executable not found on PATH') };
  if (status.timedOut) return { ok: false, error: pgError('query_failed', 'query timed out') };
  if (status.exitCode !== 0) {
    const stderr = status.stderr.toLowerCase();
    if (stderr.includes('password authentication failed') || stderr.includes('role') && stderr.includes('does not exist')) {
      return { ok: false, error: pgError('auth_failed', truncate(status.stderr, 20)) };
    }
    if (stderr.includes('could not connect') || stderr.includes('connection refused') || stderr.includes('timeout expired')) {
      return { ok: false, error: pgError('connection_failed', truncate(status.stderr, 20)) };
    }
    return { ok: false, error: pgError('query_failed', truncate(status.stderr, 20)) };
  }
  return { ok: true, stdout: status.stdout };
}

export async function handlePgSchema(args: { schema?: string }): Promise<string> {
  const resolution = resolvePgConnection();
  if (!resolution.ok) return pgError('config_missing', resolution.message);
  const { connectionArgs, defaultSchema } = resolution.info;
  const requestedSchema = args.schema?.trim();
  const schemaCheck = requestedSchema ? sqlIdentifier.safeParse(requestedSchema) : undefined;
  if (requestedSchema && !schemaCheck?.success) return pgError('query_failed', 'invalid schema name');
  const schema = requestedSchema ?? defaultSchema;

  const existsResult = await runPsql(connectionArgs, `SELECT 1 FROM information_schema.schemata WHERE schema_name='${schema}'`);
  if (!existsResult.ok) return existsResult.error;
  if (!existsResult.stdout.trim()) return pgError('schema_missing', `schema not found: ${schema}`);

  const tablesResult = await runPsql(connectionArgs, `SELECT table_name FROM information_schema.tables WHERE table_schema='${schema}' ORDER BY table_name`);
  if (!tablesResult.ok) return tablesResult.error;
  const tables = tablesResult.stdout.split(/\r?\n/).filter(Boolean);
  const out: Record<string, unknown> = { schema, tables };

  const columnsResult = await runPsql(connectionArgs, `SELECT table_name,column_name,data_type FROM information_schema.columns WHERE table_schema='${schema}' ORDER BY table_name,ordinal_position`);
  if (columnsResult.ok) {
    out.columns = columnsResult.stdout.split(/\r?\n/).filter(Boolean).slice(0, 500).map((line) => {
      const [table, column, dataType] = line.split('|');
      return { table: table ?? '', column: column ?? '', dataType: dataType ?? '' };
    });
  }

  const indexResult = await runPsql(connectionArgs, `SELECT indexname FROM pg_indexes WHERE schemaname='${schema}' ORDER BY tablename,indexname`);
  if (indexResult.ok) out.indexes = indexResult.stdout.split(/\r?\n/).filter(Boolean).slice(0, 200);

  return JSON.stringify(out);
}

export async function handlePgExplain(args: { sql: string }): Promise<string> {
  const resolution = resolvePgConnection();
  if (!resolution.ok) return pgError('config_missing', resolution.message);
  const sql = args.sql.trim();
  if (!/^\s*SELECT\b/i.test(sql) && !/^\s*EXPLAIN\b/i.test(sql)) {
    return pgError('sql_rejected', 'only SELECT or EXPLAIN SELECT is allowed');
  }
  if (EXPLAIN_ANALYZE.test(sql)) return pgError('sql_rejected', 'EXPLAIN ANALYZE is not allowed (it executes the query)');
  if (BLOCKED_SQL.test(sql)) return pgError('sql_rejected', 'disallowed SQL keyword detected');
  if (/^\s*EXPLAIN\b/i.test(sql) && !/^\s*SELECT\b/i.test(explainSubject(sql))) {
    return pgError('sql_rejected', 'only EXPLAIN SELECT is allowed');
  }

  const explainSql = /^\s*EXPLAIN\b/i.test(sql) ? sql : `EXPLAIN (FORMAT JSON) ${sql}`;
  const result = await runPsql(resolution.info.connectionArgs, explainSql);
  if (!result.ok) return result.error;
  const cleaned = truncate(result.stdout, 200 * 1024);
  try {
    return JSON.stringify({ plan: JSON.parse(cleaned) });
  } catch {
    return JSON.stringify({ raw: cleaned });
  }
}

function explainSubject(sql: string): string {
  let rest = sql.replace(/^\s*EXPLAIN\b/i, '').trim();
  if (rest.startsWith('(')) {
    const end = rest.indexOf(')');
    rest = end >= 0 ? rest.slice(end + 1).trim() : '';
  }
  return rest;
}
