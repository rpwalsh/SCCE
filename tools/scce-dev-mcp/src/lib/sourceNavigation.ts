// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
import { readFileSync, realpathSync, statSync } from 'node:fs';
import { isAbsolute, join, relative } from 'node:path';
import { runProcess } from './run.js';
import { resolveRepositoryRoot } from './repoRoot.js';
import { sourceSymbolMatches, type SourceSymbolMatch } from './sourceSymbols.js';

export async function handleSourceNavigation(args: { symbol: string; maxResults?: number }, callsOnly = false): Promise<string> {
  const root = realpathSync(resolveRepositoryRoot());
  const max = args.maxResults ?? (callsOnly ? 50 : 25);
  const status = await runProcess({ commandId: callsOnly ? 'rg.callsites' : 'rg.symbol', command: 'rg',
    args: ['--files-with-matches', '--fixed-strings', '-g', '*.ts', '-g', '*.tsx', '-g', '*.mts', '-g', '*.cts',
      '-g', '*.js', '-g', '*.jsx', '-g', '*.mjs', '-g', '*.cjs', '--', args.symbol], cwd: root, timeoutMs: 30_000 });
  if (status.spawnError || (status.exitCode !== 0 && status.exitCode !== 1)) {
    return JSON.stringify({ error: 'source_navigation_failed', exitCode: status.exitCode, message: status.spawnError, timedOut: status.timedOut });
  }
  const paths = status.stdout.split(/\r?\n/u).filter(Boolean).sort();
  const matches: SourceSymbolMatch[] = [];
  const skipped: Array<{ path: string; reason: string }> = [];
  let scannedBytes = 0;
  let scannedFiles = 0;
  let scanTruncated = status.stdoutTruncated;
  for (const path of paths) {
    if (scannedFiles >= 256 || scannedBytes >= 8 * 1024 * 1024) { scanTruncated = true; break; }
    try {
      const file = realpathSync(join(root, path));
      const ownedPath = relative(root, file);
      if (isAbsolute(ownedPath) || ownedPath === '..' || ownedPath.startsWith('../') || ownedPath.startsWith('..\\')) {
        skipped.push({ path, reason: 'outside_repository' }); continue;
      }
      const size = statSync(file).size;
      if (size > 512 * 1024) { skipped.push({ path, reason: 'source_size_budget' }); continue; }
      scannedBytes += size;
      scannedFiles++;
      matches.push(...sourceSymbolMatches({ path: path.replaceAll('\\', '/'), text: readFileSync(file, 'utf8'), symbol: args.symbol, callsOnly }));
    } catch { skipped.push({ path, reason: 'source_unavailable' }); }
  }
  const rank = (match: SourceSymbolMatch) => match.kind === 'reference' ? 2
    : ['ImportSpecifier', 'ImportClause', 'NamespaceImport'].includes(match.syntax) ? 1 : 0;
  matches.sort((a, b) => rank(a) - rank(b) || a.path.localeCompare(b.path) || a.range.start - b.range.start);
  return JSON.stringify({ symbol: args.symbol, method: 'typescript-syntax-ast', semanticResolution: false,
    matches: matches.slice(0, max).map(match => ({ ...match, read: { path: match.path, startLine: match.enclosingRange.startLine,
      endLine: Math.min(match.enclosingRange.endLine, match.enclosingRange.startLine + 79) } })),
    truncated: scanTruncated || matches.length > max || skipped.length > 0, scannedFiles, scannedBytes,
    skipped: skipped.slice(0, 10), skippedCount: skipped.length });
}
