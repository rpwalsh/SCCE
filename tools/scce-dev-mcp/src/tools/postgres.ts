// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
import { runProcess } from '../lib/run.js';
import { truncate } from '../lib/run.js';
import { resolvePgConnection } from '../lib/pgConfig.js';
import { sqlIdentifier } from '../lib/validate.js';

/**
 * HONEST SCOPE NOTE (this is not a hard security boundary): every check
 * below is a real, keyword/string-level heuristic, not a parsed-AST
 * policy -- Postgres's own `SELECT` grammar is large enough that no
 * regex-based blocklist can be complete (a determined caller with
 * unusual whitespace, encoding, or a function name this list doesn't
 * know about can still get past it). The properties that actually make
 * this safe to expose are enforced by Postgres itself, inside the same
 * psql session, before the caller's SQL ever runs:
 *   - `default_transaction_read_only = on` -- the query's own implicit
 *     transaction cannot write to a permanent table regardless of what
 *     the SQL text says.
 *   - `search_path` restricted to the configured SCCE schema plus
 *     `pg_catalog` -- an unqualified reference cannot silently resolve
 *     into a different schema.
 *   - `statement_timeout`/`lock_timeout` -- bounds a runaway or
 *     lock-holding query.
 * These three require the connecting role to actually be a real,
 * least-privileged database role scoped to the configured SCCE schema
 * with no write grants and no superuser/replication attributes --
 * that's a deployment/credential decision this tool cannot make or
 * verify from here, and is a REQUIRED assumption, not an optional
 * hardening step, for "read-only" to be true in practice.
 */
const BLOCKED_SQL = /\b(INSERT|UPDATE|DELETE|MERGE|ALTER|DROP|TRUNCATE|COPY|CALL|DO|CREATE|VACUUM|ANALYZE|GRANT|REVOKE|SET|RESET|LOCK|REFRESH|REINDEX|CLUSTER|INTO|EXECUTE|PREPARE|LISTEN|NOTIFY)\b/i;
/** Real names, not a claim of completeness: file/large-object I/O, session/backend control, replication, and locking functions that a read-only transaction does not, by itself, block. */
const BLOCKED_FUNCTIONS = /\b(pg_sleep(_for|_until)?|pg_read_file|pg_read_binary_file|pg_ls_dir|pg_stat_file|lo_import|lo_export|lo_creat|lo_create|lo_unlink|dblink(_exec)?|pg_advisory_(xact_)?lock(_shared)?|pg_try_advisory_(xact_)?lock(_shared)?|pg_advisory_unlock(_all|_shared)?|pg_terminate_backend|pg_cancel_backend|pg_reload_conf|pg_rotate_logfile|set_config|pg_backend_pid|pg_read_server_files|copy_from|copy_to)\s*\(/i;
const EXPLAIN_ANALYZE = /^\s*EXPLAIN\s+(?:ANALYZE\b|\([^)]*\bANALYZE\b[^)]*\))/i;
const PSQL_TIMEOUT_MS = 20_000;
const STATEMENT_TIMEOUT_MS = 8_000;
const LOCK_TIMEOUT_MS = 3_000;

/**
 * Rejects any SQL comment syntax outright. A legitimate bounded
 * inspection query never needs one, and comments are the standard tool
 * for splitting a blocked keyword across a token boundary to defeat a
 * keyword-based blocklist -- rejecting them closes that specific,
 * well-known bypass class rather than trying to out-pattern-match every
 * way to hide a keyword in one.
 */
function containsSqlComment(sql: string): boolean {
  return sql.includes('--') || sql.includes('/*');
}

/** The real session-level hardening every SQL execution path in this file runs under -- enforced by Postgres itself inside the same psql invocation, not by string inspection of the caller's SQL. */
function readOnlySessionSetup(schema: string): string[] {
  return [
    'SET default_transaction_read_only = on',
    `SET statement_timeout = ${STATEMENT_TIMEOUT_MS}`,
    `SET lock_timeout = ${LOCK_TIMEOUT_MS}`,
    `SET search_path = "${schema.replace(/"/g, '""')}", pg_catalog`
  ];
}

type PgErrorReason = 'config_missing' | 'psql_missing' | 'auth_failed' | 'connection_failed' | 'schema_missing' | 'sql_rejected' | 'query_failed';

function pgError(reason: PgErrorReason, message: string): string {
  return JSON.stringify({ error: reason, message });
}

async function runPsql(
  baseArgs: string[],
  sql: string,
  opts: { tuplesOnly?: boolean; fieldSep?: string; setupStatements?: string[] } = {}
): Promise<{ ok: true; stdout: string } | { ok: false; error: string }> {
  const tuplesOnly = opts.tuplesOnly ?? true;
  const fieldSep = opts.fieldSep ?? '|';
  const flags = ['-A', '-F', fieldSep, '-P', 'footer=off'];
  if (tuplesOnly) flags.push('-t');
  // Every setup statement is a separate -c in the SAME psql invocation, so
  // they share one session/connection with the real query -- a SET here
  // genuinely constrains the query -c that runs after it, it is not just
  // advisory text alongside it.
  const setupArgs = (opts.setupStatements ?? []).flatMap((statement) => ['-c', statement]);
  const status = await runProcess({
    commandId: 'psql',
    command: 'psql',
    args: [...baseArgs, ...flags, '-v', 'ON_ERROR_STOP=1', ...setupArgs, '-c', sql],
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
  const setupStatements = readOnlySessionSetup(schema);

  const existsResult = await runPsql(connectionArgs, `SELECT 1 FROM information_schema.schemata WHERE schema_name='${schema}'`, { setupStatements });
  if (!existsResult.ok) return existsResult.error;
  if (!existsResult.stdout.trim()) return pgError('schema_missing', `schema not found: ${schema}`);

  const tablesResult = await runPsql(connectionArgs, `SELECT table_name FROM information_schema.tables WHERE table_schema='${schema}' ORDER BY table_name`, { setupStatements });
  if (!tablesResult.ok) return tablesResult.error;
  const tables = tablesResult.stdout.split(/\r?\n/).filter(Boolean);
  const out: Record<string, unknown> = { schema, tables };

  const columnsResult = await runPsql(connectionArgs, `SELECT table_name,column_name,data_type FROM information_schema.columns WHERE table_schema='${schema}' ORDER BY table_name,ordinal_position`, { setupStatements });
  if (columnsResult.ok) {
    out.columns = columnsResult.stdout.split(/\r?\n/).filter(Boolean).slice(0, 500).map((line) => {
      const [table, column, dataType] = line.split('|');
      return { table: table ?? '', column: column ?? '', dataType: dataType ?? '' };
    });
  }

  const indexResult = await runPsql(connectionArgs, `SELECT indexname FROM pg_indexes WHERE schemaname='${schema}' ORDER BY tablename,indexname`, { setupStatements });
  if (indexResult.ok) out.indexes = indexResult.stdout.split(/\r?\n/).filter(Boolean).slice(0, 200);

  return JSON.stringify(out);
}

const PG_QUERY_ROW_CAP = 200;
const PG_QUERY_CELL_MAX_CHARS = 300;

function truncateCell(value: unknown): unknown {
  if (typeof value !== 'string' || value.length <= PG_QUERY_CELL_MAX_CHARS) return value;
  return value.slice(0, PG_QUERY_CELL_MAX_CHARS) + '…[truncated]';
}

function rejectUnsafeSql(sql: string, allowExplain: boolean): string | undefined {
  const startsSelect = /^\s*SELECT\b/i.test(sql);
  const startsExplain = allowExplain && /^\s*EXPLAIN\b/i.test(sql);
  if (!startsSelect && !startsExplain) {
    return allowExplain ? 'only SELECT or EXPLAIN SELECT is allowed' : 'only a single SELECT statement is allowed (use pg_explain for query plans)';
  }
  if (containsSqlComment(sql)) return 'SQL comments are not allowed';
  if (BLOCKED_SQL.test(sql)) return 'disallowed SQL keyword detected';
  if (BLOCKED_FUNCTIONS.test(sql)) return 'disallowed function call detected';
  const withoutTrailingSemicolon = sql.replace(/;\s*$/, '');
  if (withoutTrailingSemicolon.includes(';')) return 'multiple statements are not allowed';
  return undefined;
}

/**
 * CRITICAL fix: the previous implementation split psql's `-A`
 * (unaligned) output on `\r?\n` and on a literal field-separator
 * character -- either one appearing inside an actual cell value (a text
 * column containing a real newline, or the chosen separator byte) would
 * silently misalign every column after it or split one logical row into
 * two. Wrapping the caller's query in `row_to_json(...)::text` instead
 * makes each output line a single, self-contained JSON value: Postgres's
 * own JSON serialization escapes any real newline in the data as the
 * two characters `\`+`n`, so the line-based split below is genuinely
 * safe regardless of what the underlying data contains, and every value
 * keeps its real type (numbers, booleans, null) instead of being
 * flattened to text.
 */
export async function handlePgQuery(args: { sql: string; maxRows?: number }): Promise<string> {
  const resolution = resolvePgConnection();
  if (!resolution.ok) return pgError('config_missing', resolution.message);
  const sql = args.sql.trim();
  const rejection = rejectUnsafeSql(sql, false);
  if (rejection) return pgError('sql_rejected', rejection);
  const withoutTrailingSemicolon = sql.replace(/;\s*$/, '');

  const maxRows = Math.min(Math.max(1, Math.floor(args.maxRows ?? 20)), PG_QUERY_ROW_CAP);
  const wrapped = `SELECT row_to_json(_scce_pg_query_bounded)::text AS row_json FROM (${withoutTrailingSemicolon}) AS _scce_pg_query_bounded LIMIT ${maxRows + 1}`;
  const result = await runPsql(resolution.info.connectionArgs, wrapped, { setupStatements: readOnlySessionSetup(resolution.info.defaultSchema) });
  if (!result.ok) return result.error;

  const lines = result.stdout.split(/\r?\n/).filter((line) => line.length > 0);
  if (lines.length === 0) return JSON.stringify({ columns: [], rows: [], rowCount: 0, truncated: false, cellTruncated: false });

  const truncated = lines.length > maxRows;
  let cellTruncated = false;
  const parsedRows: Array<Record<string, unknown>> = [];
  for (const line of lines.slice(0, maxRows)) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      return pgError('query_failed', 'row result did not parse as JSON');
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return pgError('query_failed', 'row result was not a JSON object');
    }
    const row = parsed as Record<string, unknown>;
    const truncatedRow: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(row)) {
      const cell = truncateCell(value);
      if (cell !== value) cellTruncated = true;
      truncatedRow[key] = cell;
    }
    parsedRows.push(truncatedRow);
  }
  const columns = parsedRows[0] ? Object.keys(parsedRows[0]) : [];
  const rows = parsedRows.map((row) => columns.map((column) => row[column] ?? null));
  return JSON.stringify({ columns, rows, rowCount: rows.length, truncated, cellTruncated });
}

export async function handlePgExplain(args: { sql: string }): Promise<string> {
  const resolution = resolvePgConnection();
  if (!resolution.ok) return pgError('config_missing', resolution.message);
  const sql = args.sql.trim();
  const rejection = rejectUnsafeSql(sql, true);
  if (rejection) return pgError('sql_rejected', rejection);
  if (EXPLAIN_ANALYZE.test(sql)) return pgError('sql_rejected', 'EXPLAIN ANALYZE is not allowed (it executes the query)');
  if (/^\s*EXPLAIN\b/i.test(sql) && !/^\s*SELECT\b/i.test(explainSubject(sql))) {
    return pgError('sql_rejected', 'only EXPLAIN SELECT is allowed');
  }

  const explainSql = /^\s*EXPLAIN\b/i.test(sql) ? sql : `EXPLAIN (FORMAT JSON) ${sql}`;
  const result = await runPsql(resolution.info.connectionArgs, explainSql, { setupStatements: readOnlySessionSetup(resolution.info.defaultSchema) });
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
