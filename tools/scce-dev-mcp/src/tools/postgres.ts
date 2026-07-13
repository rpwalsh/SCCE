import { run, truncate } from '../lib/run.js';

const BLOCKED_SQL = /\b(INSERT|UPDATE|DELETE|MERGE|ALTER|DROP|TRUNCATE|COPY|CALL|DO|CREATE|VACUUM|ANALYZE|GRANT|REVOKE|SET|RESET|LOCK|REFRESH|REINDEX|CLUSTER)\b/i;
const EXPLAIN_ANALYZE = /^\s*EXPLAIN\s+(?:ANALYZE\b|\([^)]*\bANALYZE\b[^)]*\))/i;
const IDENT_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;
const USABLE_PG_ENV_KEYS = ['PGDATABASE', 'PGUSER', 'PGHOST', 'PGPORT', 'PGSERVICE', 'PGPASSFILE'];

function connectionArgs(): string[] | undefined {
  const url = firstNonEmpty(process.env.DATABASE_URL, process.env.PG_URL);
  if (url) return ['-d', url];
  if (USABLE_PG_ENV_KEYS.some((key) => Boolean(process.env[key]?.trim()))) return [];
  return undefined;
}

function firstNonEmpty(...values: Array<string | undefined>): string | undefined {
  return values.find((value) => value !== undefined && value.trim().length > 0);
}

function configMissing(): string {
  return JSON.stringify({ config_missing: true, message: 'No DATABASE_URL, PG_URL, or usable PG* env vars set' });
}

export async function handlePgSchema(args: { schema?: string }): Promise<string> {
  const baseArgs = connectionArgs();
  if (!baseArgs) return configMissing();
  const schema = args.schema?.trim() ?? 'public';
  if (!IDENT_RE.test(schema)) return JSON.stringify({ error: 'Invalid schema name' });
  try {
    const sql = `SELECT table_name FROM information_schema.tables WHERE table_schema='${schema}' ORDER BY table_name`;
    const { stdout } = await run('psql', [...baseArgs, '-Atc', sql], process.cwd());
    const tables = stdout.split(/\r?\n/).filter(Boolean);
    const out: Record<string, unknown> = { schema, tables };
    try {
      const colSql = `SELECT table_name,column_name,data_type FROM information_schema.columns WHERE table_schema='${schema}' ORDER BY table_name,ordinal_position`;
      const { stdout: colStdout } = await run('psql', [...baseArgs, '-Atc', colSql], process.cwd());
      const columns = colStdout.split(/\r?\n/).filter(Boolean).slice(0, 500).map((line) => {
        const [table, column, dataType] = line.split('|');
        return { table: table ?? '', column: column ?? '', dataType: dataType ?? '' };
      });
      out.columns = columns;
    } catch {}
    try {
      const idxSql = `SELECT schemaname,tablename,indexname FROM pg_indexes WHERE schemaname='${schema}' ORDER BY tablename,indexname`;
      const { stdout: idxStdout } = await run('psql', [...baseArgs, '-Atc', idxSql], process.cwd());
      out.indexes = idxStdout.split(/\r?\n/).filter(Boolean).slice(0, 200);
    } catch {}
    return JSON.stringify(out);
  } catch {
    return JSON.stringify({ error: 'psql query failed' });
  }
}

export async function handlePgExplain(args: { sql: string }): Promise<string> {
  const baseArgs = connectionArgs();
  if (!baseArgs) return configMissing();
  const sql = args.sql.trim();
  if (!/^\s*SELECT\b/i.test(sql) && !/^\s*EXPLAIN\b/i.test(sql)) {
    return JSON.stringify({ error: 'Only SELECT or EXPLAIN SELECT allowed' });
  }
  if (EXPLAIN_ANALYZE.test(sql)) {
    return JSON.stringify({ error: 'EXPLAIN ANALYZE is not allowed' });
  }
  if (BLOCKED_SQL.test(sql)) {
    return JSON.stringify({ error: 'Disallowed SQL pattern' });
  }
  if (/^\s*EXPLAIN\b/i.test(sql) && !/^\s*SELECT\b/i.test(explainSubject(sql))) {
    return JSON.stringify({ error: 'Only EXPLAIN SELECT allowed' });
  }
  const explainSql = /^\s*EXPLAIN\b/i.test(sql) ? sql : `EXPLAIN (FORMAT JSON) ${sql}`;
  try {
    const { stdout } = await run('psql', [...baseArgs, '-Atc', explainSql], process.cwd());
    const cleaned = truncate(stdout, 200 * 1024);
    try {
      const parsed = JSON.parse(cleaned);
      return JSON.stringify({ plan: parsed });
    } catch {
      return JSON.stringify({ raw: cleaned });
    }
  } catch {
    return JSON.stringify({ error: 'EXPLAIN failed' });
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
