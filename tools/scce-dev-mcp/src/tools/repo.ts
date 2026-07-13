import { run } from '../lib/run.js';
import { limitLength } from '../lib/limit.js';
import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const EXCLUDED_WALK_DIRS = new Set(['node_modules', 'dist', 'coverage', '.git', '.scce', '.tmp']);
const MAX_REPO_SHAPE_FILES = 20_000;

export async function handleRepoShape(): Promise<string> {
  const root = process.cwd();
  const result: Record<string, unknown> = {
    packages: [],
    packagesPath: '',
    directories: [],
    scripts: {},
    fileCounts: {},
    fileCountLimit: MAX_REPO_SHAPE_FILES,
    fileCountTruncated: false,
  };

  try {
    const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as Record<string, unknown>;
    result.scripts = (pkg.scripts as Record<string, string>) ?? {};
  } catch {}

  try {
    result.packagesPath = join(root, 'pnpm-workspace.yaml');
    const text = readFileSync(result.packagesPath as string, 'utf8');
    result.packages = text.split(/\r?\n/).flatMap((line) => {
      const m = line.match(/^-\s+(.+)$/);
      return m && m[1] ? [m[1].trim().replace(/\/package\.json$/, '')] : [];
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
  const root = process.cwd();
  const max = args.maxResults ?? 100;
  const cmdArgs: string[] = ['--files'];
  if (args.glob) cmdArgs.push('-g', args.glob);
  const { stdout } = await run('rg', cmdArgs, root);
  const lines = stdout.split(/\r?\n/).filter(Boolean);
  const matches = lines.slice(0, max).filter((l) => !args.contains || l.includes(args.contains));
  return JSON.stringify({ matches });
}

export async function handleRepoSearch(args: { query: string; glob?: string; maxResults?: number }): Promise<string> {
  const root = process.cwd();
  const max = args.maxResults ?? 50;
  const cmdArgs = ['--line-number', '--no-heading', '--max-columns', '200', '-m', String(max), args.query];
  if (args.glob) cmdArgs.push('-g', args.glob);
  const { stdout } = await run('rg', cmdArgs, root);
  const lines = stdout.split(/\r?\n/).filter(Boolean).slice(0, max);
  const out = lines.map((line) => {
    const idx = line.indexOf(':');
    const path = line.slice(0, idx);
    const rest = line.slice(idx + 1);
    const lnIdx = rest.indexOf(':');
    const ln = lnIdx > -1 ? Number(rest.slice(0, lnIdx)) : undefined;
    const text = lnIdx > -1 ? rest.slice(lnIdx + 1) : rest;
    return { path, line: ln, text };
  });
  return JSON.stringify({ query: args.query, matches: out });
}

export async function handleRepoSymbol(args: { symbol: string; maxResults?: number }): Promise<string> {
  const root = process.cwd();
  const max = args.maxResults ?? 25;
  const cmdArgs = ['--line-number', '--no-heading', '--max-columns', '300', '-m', String(max * 2), args.symbol, '--type', 'ts'];
  const { stdout } = await run('rg', cmdArgs, root);
  const lines = stdout.split(/\r?\n/).filter(Boolean).slice(0, max);
  const out = lines.map((line) => {
    const sep = line.indexOf(':');
    const path = line.slice(0, sep);
    const rest = line.slice(sep + 1);
    const lnSep = rest.indexOf(':');
    const ln = lnSep > -1 ? Number(rest.slice(0, lnSep)) : undefined;
    const text = lnSep > -1 ? rest.slice(lnSep + 1) : rest;
    const kind = /^\s*(export\s+)?(default\s+)?(async\s+)?(function|class|interface|type|enum|const|let)\b/.test(text) ? 'definition' : 'reference';
    return { path, line: ln, kind, text: limitLength(text.trim(), 140) };
  });
  return JSON.stringify({ symbol: args.symbol, matches: out });
}

export async function handleRepoCallSites(args: { symbol: string; maxResults?: number }): Promise<string> {
  const root = process.cwd();
  const max = args.maxResults ?? 50;
  const cmdArgs = ['--line-number', '--no-heading', '--max-columns', '300', '-m', String(max * 2), args.symbol, '--type', 'ts'];
  const { stdout } = await run('rg', cmdArgs, root);
  const lines = stdout.split(/\r?\n/).filter(Boolean).slice(0, max);
  const out = lines.map((line) => {
    const idx = line.indexOf(':');
    const path = line.slice(0, idx);
    const rest = line.slice(idx + 1);
    const lnIdx = rest.indexOf(':');
    const ln = lnIdx > -1 ? Number(rest.slice(0, lnIdx)) : undefined;
    const text = lnIdx > -1 ? rest.slice(lnIdx + 1) : rest;
    return { path, line: ln, text: limitLength(text.trim(), 160) };
  });
  return JSON.stringify({ symbol: args.symbol, matches: out });
}

export async function handleRepoRoutes(): Promise<string> {
  const root = process.cwd();
  const cmdArgs = ['--line-number', '--no-heading', '--max-columns', '240', '--type', 'ts', '(get|post|put|delete|patch|use)\\(|router\\.|app\\.|express|fastify|hono'];
  const { stdout } = await run('rg', cmdArgs, root);
  const lines = stdout.split(/\r?\n/).filter(Boolean).slice(0, 120);
  const out = lines.map((line) => {
    const idx = line.indexOf(':');
    const path = line.slice(0, idx);
    const rest = line.slice(idx + 1);
    const lnIdx = rest.indexOf(':');
    const ln = lnIdx > -1 ? Number(rest.slice(0, lnIdx)) : undefined;
    const text = lnIdx > -1 ? rest.slice(lnIdx + 1) : rest;
    return { path, line: ln, text };
  });
  return JSON.stringify({ matches: out });
}

export async function handleRepoDeps(): Promise<string> {
  const root = process.cwd();
  const result: Record<string, unknown> = { ok: false };
  try {
    const { stdout } = await run('pnpm', ['repo:deps'], root);
    const lines = stdout.split(/\r?\n/).filter(Boolean).slice(0, 80);
    result.ok = true;
    result.summary = lines.join('\n');
  } catch {
    result.notConfigured = true;
  }
  return JSON.stringify(result);
}

export async function handleRepoDeadCode(): Promise<string> {
  const root = process.cwd();
  const result: Record<string, unknown> = { ok: false };
  try {
    const { stdout } = await run('pnpm', ['repo:dead'], root);
    const lines = stdout.split(/\r?\n/).filter(Boolean).slice(0, 80);
    result.ok = true;
    result.summary = lines.join('\n');
  } catch {
    result.notConfigured = true;
  }
  return JSON.stringify(result);
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

function extname(file: string): string {
  const idx = file.lastIndexOf('.');
  return idx > -1 ? file.slice(idx + 1).toLowerCase() : '';
}
