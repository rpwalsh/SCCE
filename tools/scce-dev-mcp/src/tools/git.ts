// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
import { runProcess, truncate } from '../lib/run.js';
import { resolveRepositoryRoot } from '../lib/repoRoot.js';

export async function handleGitChanged(): Promise<string> {
  const root = resolveRepositoryRoot();
  const status = await runProcess({ commandId: 'git.status', command: 'git', args: ['status', '--porcelain'], cwd: root, timeoutMs: 15_000 });
  if (status.spawnError) return JSON.stringify({ error: 'git not available', message: status.spawnError });
  if (status.exitCode !== 0) return JSON.stringify({ error: 'git status failed', message: truncate(status.stderr, 20) });
  const lines = (status.stdout || '').split(/\r?\n/).filter(Boolean);
  const out = lines.map((line) => ({ status: line.slice(0, 2), path: line.slice(3) }));
  return JSON.stringify({ changed: out });
}

const GIT_LOG_SEP = '\x1f';

export async function handleGitLog(args: { path?: string; maxCount?: number }): Promise<string> {
  const root = resolveRepositoryRoot();
  const maxCount = args.maxCount ?? 20;
  const pathArgs = args.path ? ['--', args.path] : [];
  const format = `%h${GIT_LOG_SEP}%ad${GIT_LOG_SEP}%an${GIT_LOG_SEP}%s`;

  const status = await runProcess({
    commandId: 'git.log',
    command: 'git',
    args: ['log', `-n${maxCount + 1}`, '--date=short', `--format=${format}`, ...pathArgs],
    cwd: root,
    timeoutMs: 15_000
  });
  if (status.spawnError) return JSON.stringify({ error: 'git not available', message: status.spawnError });
  if (status.exitCode !== 0) return JSON.stringify({ error: 'git log failed', message: truncate(status.stderr, 20) });

  const lines = (status.stdout || '').split(/\r?\n/).filter(Boolean);
  const truncated = lines.length > maxCount;
  const commits = lines.slice(0, maxCount).map((line) => {
    const [hash, date, author, subject] = line.split(GIT_LOG_SEP);
    return { hash: hash ?? '', date: date ?? '', author: author ?? '', subject: subject ?? '' };
  });
  return JSON.stringify({ commits, truncated });
}

export async function handleGitDiffSummary(args: { path?: string; maxLines?: number }): Promise<string> {
  const root = resolveRepositoryRoot();
  const max = args.maxLines ?? 200;
  const pathArgs = args.path ? [args.path] : [];

  const statStatus = await runProcess({ commandId: 'git.diff.stat', command: 'git', args: ['diff', '--stat', '--', ...pathArgs], cwd: root, timeoutMs: 20_000 });
  if (statStatus.spawnError) return JSON.stringify({ error: 'git not available', message: statStatus.spawnError });
  if (statStatus.exitCode !== 0) return JSON.stringify({ error: 'git diff failed', message: truncate(statStatus.stderr, 20) });
  const statLines = (statStatus.stdout || '').split(/\r?\n/).filter(Boolean);
  const stat = statLines.map((l) => {
    const parts = l.split('|');
    return { files: parts[0]?.trim() ?? '', changes: parts[1]?.trim() ?? '' };
  });

  const hunkStatus = await runProcess({ commandId: 'git.diff.hunks', command: 'git', args: ['diff', '--', ...pathArgs], cwd: root, timeoutMs: 20_000 });
  const hunkLines = (hunkStatus.exitCode === 0 ? hunkStatus.stdout : '').split(/\r?\n/);
  const hunksTruncated = hunkLines.length > max;
  const hunks = hunkLines.slice(0, max).join('\n');

  return JSON.stringify({ diff: stat, hunks, hunksTruncated });
}
