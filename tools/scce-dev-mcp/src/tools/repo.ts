import { runProcess } from '../lib/run.js';
import { limitLength } from '../lib/limit.js';
import { resolveRepositoryRoot } from '../lib/repoRoot.js';
import { readFileSync, existsSync, readdirSync, statSync } from 'node:fs';
import { extname, join } from 'node:path';

const EXCLUDED_WALK_DIRS = new Set(['node_modules', 'dist', 'coverage', '.git', '.scce', '.tmp', '.vscode-test']);
const MAX_REPO_SHAPE_FILES = 20_000;
const RG_TIMEOUT_MS = 30_000;

export async function handleRepoShape(): Promise<string> {
  const root = resolveRepositoryRoot();
  const result: Record<string, unknown> = {
    packages: [],
    packagesPath: '',
    directories: [],
    scripts: {},
    fileCounts: {},
    fileCountLimit: MAX_REPO_SHAPE_FILES,
    fileCountTruncated: false
  };

  try {
    const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as Record<string, unknown>;
    result.scripts = (pkg.scripts as Record<string, string>) ?? {};
  } catch {}

  try {
    result.packagesPath = join(root, 'pnpm-workspace.yaml');
    const text = readFileSync(result.packagesPath as string, 'utf8');
    result.packages = text.split(/\r?\n/).flatMap((line) => {
      const m = line.match(/^\s*-\s+(.+?)\s*$/);
      if (!m?.[1]) return [];
      const value = m[1].trim().replace(/^(['"])(.*)\1$/u, '$2');
      return value ? [value.replace(/\/package\.json$/, '')] : [];
    });
  } catch {}

  result.directories = ['packages', 'tools', 'docs', 'examples'];

  try {
    const { files, truncated } = allFiles(root, MAX_REPO_SHAPE_FILES);
    result.fileCountTruncated = truncated;
    result.fileCounts = files.reduce<Record<string, number>>((acc, f) => {
      const ext = extname(f) || '(none)';
      acc[ext] = (acc[ext] ?? 0) + 1;
      return acc;
    }, {});
  } catch {}

  return JSON.stringify(result);
}

export async function handleRepoFiles(args: { glob?: string; contains?: string; maxResults?: number }): Promise<string> {
  const root = resolveRepositoryRoot();
  const max = args.maxResults ?? 100;
  const cmdArgs: string[] = ['--files'];
  if (args.glob) cmdArgs.push('-g', args.glob);
  const { stdout, exitCode, spawnError } = await runProcess({ commandId: 'rg.files', command: 'rg', args: cmdArgs, cwd: root, timeoutMs: RG_TIMEOUT_MS });
  if (spawnError) return JSON.stringify({ error: 'ripgrep not available', message: spawnError });
  if (exitCode !== 0 && exitCode !== 1) return JSON.stringify({ error: 'repo_files failed', exitCode });
  const allMatches = stdout.split(/\r?\n/).filter(Boolean).filter((l) => !args.contains || l.includes(args.contains));
  return JSON.stringify({ matches: allMatches.slice(0, max), truncated: allMatches.length > max });
}

export async function handleRepoSearch(args: { query: string; glob?: string; maxResults?: number }): Promise<string> {
  const root = resolveRepositoryRoot();
  const max = args.maxResults ?? 50;
  const cmdArgs = ['--line-number', '--no-heading', '--max-columns', '200', '-m', String(max), args.query];
  if (args.glob) cmdArgs.push('-g', args.glob);
  const { stdout, exitCode, spawnError } = await runProcess({ commandId: 'rg.search', command: 'rg', args: cmdArgs, cwd: root, timeoutMs: RG_TIMEOUT_MS });
  if (spawnError) return JSON.stringify({ error: 'ripgrep not available', message: spawnError });
  if (exitCode !== 0 && exitCode !== 1) return JSON.stringify({ error: 'repo_search failed', exitCode });
  const lines = stdout.split(/\r?\n/).filter(Boolean).slice(0, max);
  const out = lines.map(parseRgLine);
  return JSON.stringify({ query: args.query, matches: out, truncated: stdout.split(/\r?\n/).filter(Boolean).length > max });
}

/**
 * Ripgrep-based text search over TypeScript source. This is not a
 * TypeScript-aware symbol resolver — it heuristically flags a line as a
 * "definition" when it starts with a declaration keyword, and otherwise
 * calls it a "reference". Overloads, re-exports, and destructured bindings
 * can be misclassified.
 */
export async function handleRepoSymbol(args: { symbol: string; maxResults?: number }): Promise<string> {
  const root = resolveRepositoryRoot();
  const max = args.maxResults ?? 25;
  const cmdArgs = ['--line-number', '--no-heading', '--max-columns', '300', '-m', String(max * 2), args.symbol, '--type', 'ts'];
  const { stdout, exitCode, spawnError } = await runProcess({ commandId: 'rg.symbol', command: 'rg', args: cmdArgs, cwd: root, timeoutMs: RG_TIMEOUT_MS });
  if (spawnError) return JSON.stringify({ error: 'ripgrep not available', message: spawnError });
  if (exitCode !== 0 && exitCode !== 1) return JSON.stringify({ error: 'repo_symbol failed', exitCode });
  const allLines = stdout.split(/\r?\n/).filter(Boolean);
  const out = allLines.slice(0, max).map((line) => {
    const parsed = parseRgLine(line);
    const kind = /^\s*(export\s+)?(default\s+)?(async\s+)?(function|class|interface|type|enum|const|let)\b/.test(parsed.text) ? 'definition' : 'reference';
    return { path: parsed.path, line: parsed.line, kind, text: limitLength(parsed.text.trim(), 140) };
  });
  return JSON.stringify({ symbol: args.symbol, matches: out, truncated: allLines.length > max, method: 'ripgrep-text-search' });
}

export async function handleRepoCallSites(args: { symbol: string; maxResults?: number }): Promise<string> {
  const root = resolveRepositoryRoot();
  const max = args.maxResults ?? 50;
  const cmdArgs = ['--line-number', '--no-heading', '--max-columns', '300', '-m', String(max * 2), args.symbol, '--type', 'ts'];
  const { stdout, exitCode, spawnError } = await runProcess({ commandId: 'rg.callsites', command: 'rg', args: cmdArgs, cwd: root, timeoutMs: RG_TIMEOUT_MS });
  if (spawnError) return JSON.stringify({ error: 'ripgrep not available', message: spawnError });
  if (exitCode !== 0 && exitCode !== 1) return JSON.stringify({ error: 'repo_callsites failed', exitCode });
  const allLines = stdout.split(/\r?\n/).filter(Boolean);
  const out = allLines.slice(0, max).map((line) => {
    const parsed = parseRgLine(line);
    return { path: parsed.path, line: parsed.line, text: limitLength(parsed.text.trim(), 160) };
  });
  return JSON.stringify({ symbol: args.symbol, matches: out, truncated: allLines.length > max, method: 'ripgrep-text-search' });
}

/**
 * Prefers SCCE's declarative `export const ROUTES = [{ method, path, ... }]`
 * table in packages/server/src/routes.ts (the actual source of truth for
 * this repo's manual, non-framework HTTP dispatch), falling back to a text
 * scan for other dispatch styles (Express/Fastify/Hono-shaped or
 * `req.method === ... && url.pathname === ...`) so this tool stays useful
 * against files that don't use the ROUTES convention.
 */
export async function handleRepoRoutes(): Promise<string> {
  const root = resolveRepositoryRoot();
  const declarative = declarativeRoutesTable(root);
  const cmdArgs = ['--line-number', '--no-heading', '--max-columns', '240', '--type', 'ts', '(get|post|put|delete|patch|use)\\(|router\\.|app\\.|express|fastify|hono|req\\.method\\s*===|url\\.pathname'];
  const { stdout, exitCode, spawnError } = await runProcess({ commandId: 'rg.routes', command: 'rg', args: cmdArgs, cwd: root, timeoutMs: RG_TIMEOUT_MS });
  if (spawnError) return JSON.stringify({ error: 'ripgrep not available', message: spawnError });
  const dispatchLines = exitCode === 0 || exitCode === 1
    ? stdout.split(/\r?\n/).filter(Boolean).slice(0, 200).map(parseRgLine)
    : [];
  return JSON.stringify({ declarativeRoutes: declarative, dispatchMatches: dispatchLines });
}

function declarativeRoutesTable(root: string): Array<{ method: string; path: string; label?: string; mutates?: boolean; requiresDb?: boolean }> | undefined {
  const candidate = join(root, 'packages', 'server', 'src', 'routes.ts');
  if (!existsSync(candidate)) return undefined;
  try {
    const text = readFileSync(candidate, 'utf8');
    const match = text.match(/export const ROUTES\s*=\s*\[([\s\S]*?)\n\];/);
    if (!match?.[1]) return undefined;
    const rows: Array<{ method: string; path: string; label?: string; mutates?: boolean; requiresDb?: boolean }> = [];
    const rowRe = /\{\s*method:\s*"([A-Z]+)",\s*path:\s*"([^"]+)"(?:,\s*label:\s*"([^"]*)")?(?:,\s*mutates:\s*(true|false))?(?:,\s*requiresDb:\s*(true|false))?/g;
    let rowMatch: RegExpExecArray | null;
    while ((rowMatch = rowRe.exec(match[1])) !== null) {
      rows.push({
        method: rowMatch[1] ?? '',
        path: rowMatch[2] ?? '',
        label: rowMatch[3],
        mutates: rowMatch[4] === 'true',
        requiresDb: rowMatch[5] === 'true'
      });
    }
    return rows.length ? rows : undefined;
  } catch {
    return undefined;
  }
}

export async function handleRepoDeps(): Promise<string> {
  const root = resolveRepositoryRoot();
  const status = await runProcess({ commandId: 'pnpm.repo:deps', command: 'pnpm', args: ['repo:deps'], cwd: root, timeoutMs: 120_000 });
  if (status.spawnError) return JSON.stringify({ ok: false, error: 'not_available', message: status.spawnError });
  const lines = [status.stdout, status.stderr].join('\n').split(/\r?\n/).filter(Boolean).slice(0, 80);
  return JSON.stringify({ ok: status.exitCode === 0, exitCode: status.exitCode, summary: lines.join('\n') });
}

export async function handleRepoDeadCode(): Promise<string> {
  const root = resolveRepositoryRoot();
  const status = await runProcess({ commandId: 'pnpm.repo:dead', command: 'pnpm', args: ['repo:dead'], cwd: root, timeoutMs: 120_000 });
  if (status.spawnError) return JSON.stringify({ ok: false, error: 'not_available', message: status.spawnError });
  const lines = [status.stdout, status.stderr].join('\n').split(/\r?\n/).filter(Boolean).slice(0, 80);
  return JSON.stringify({ ok: status.exitCode === 0, exitCode: status.exitCode, summary: lines.join('\n') });
}

function parseRgLine(line: string): { path: string; line: number | undefined; text: string } {
  const idx = line.indexOf(':');
  const path = line.slice(0, idx);
  const rest = line.slice(idx + 1);
  const lnIdx = rest.indexOf(':');
  const ln = lnIdx > -1 ? Number(rest.slice(0, lnIdx)) : undefined;
  const text = lnIdx > -1 ? rest.slice(lnIdx + 1) : rest;
  return { path, line: ln, text };
}

function allFiles(dir: string, maxFiles: number): { files: string[]; truncated: boolean } {
  if (!existsSync(dir)) return { files: [], truncated: false };
  const out: string[] = [];
  const stack = [dir];
  let truncated = false;
  while (stack.length) {
    const current = stack.pop() ?? '';
    let entries: readonly any[];
    try { entries = readdirSync(current, { withFileTypes: true }); } catch { continue; }
    for (const entry of entries) {
      const full = join(current, entry.name);
      if (entry.isDirectory()) {
        if (!EXCLUDED_WALK_DIRS.has(entry.name)) stack.push(full);
        continue;
      }
      if (entry.isSymbolicLink()) continue;
      out.push(full);
      if (out.length >= maxFiles) {
        truncated = true;
        stack.length = 0;
        break;
      }
    }
  }
  return { files: out, truncated };
}
