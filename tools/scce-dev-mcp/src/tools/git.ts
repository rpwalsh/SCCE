import { run, truncate } from '../lib/run.js';

export async function handleGitChanged(): Promise<string> {
  const root = process.cwd();
  try {
    const { stdout } = await run('git', ['status', '--porcelain'], root);
    const lines = (stdout || '').split(/\r?\n/).filter(Boolean);
    const out = lines.map((line) => {
      const status = line.slice(0, 2);
      const path = line.slice(3);
      return { status, path };
    });
    return JSON.stringify({ changed: out });
  } catch {
    return JSON.stringify({ error: 'git not available' });
  }
}

export async function handleGitDiffSummary(args: { path?: string; maxLines?: number }): Promise<string> {
  const root = process.cwd();
  const max = args.maxLines ?? 200;
  try {
    const pathArgs = args.path ? [args.path] : [];
    const { stdout } = await run('git', ['diff', '--stat', '--', ...pathArgs], root);
    const lines = (stdout || '').split(/\r?\n/).filter(Boolean);
    const out = lines.map((l) => {
      const parts = l.split('|');
      const files = parts[0]?.trim() ?? '';
      const changes = parts[1]?.trim() ?? '';
      return { files, changes };
    });
    return JSON.stringify({ diff: out });
  } catch {
    return JSON.stringify({ error: 'git diff failed' });
  }
}