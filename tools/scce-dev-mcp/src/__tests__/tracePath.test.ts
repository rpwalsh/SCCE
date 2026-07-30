import { describe, expect, it, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resolveTraceFile, TraceContainmentError } from '../lib/tracePath.js';

function makeRepoWithTraceDir(): { root: string; traceDir: string } {
  const root = mkdtempSync(join(tmpdir(), 'scce-mcp-trace-repo-'));
  writeFileSync(join(root, 'README.md'), '# marker');
  writeFileSync(join(root, 'pnpm-workspace.yaml'), 'packages:\n  - packages/*\n');
  mkdirSync(join(root, 'packages', 'kernel', 'src'), { recursive: true });
  writeFileSync(join(root, 'packages', 'kernel', 'src', 'kernel.ts'), '// marker');
  const traceDir = join(root, '.scce', 'traces');
  mkdirSync(traceDir, { recursive: true });
  return { root, traceDir };
}

const originalRepoRoot = process.env.SCCE_REPO_ROOT;
const originalTraceDir = process.env.SCCE_TRACE_DIR;
const created: string[] = [];

afterEach(() => {
  if (originalRepoRoot === undefined) delete process.env.SCCE_REPO_ROOT;
  else process.env.SCCE_REPO_ROOT = originalRepoRoot;
  if (originalTraceDir === undefined) delete process.env.SCCE_TRACE_DIR;
  else process.env.SCCE_TRACE_DIR = originalTraceDir;
  for (const dir of created.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('resolveTraceFile', () => {
  it('resolves a real trace file inside the trace directory', () => {
    const { root, traceDir } = makeRepoWithTraceDir();
    created.push(root);
    process.env.SCCE_REPO_ROOT = root;
    delete process.env.SCCE_TRACE_DIR;
    writeFileSync(join(traceDir, 'trace-1.jsonl'), '{"stage":"turn.input"}\n');
    expect(resolveTraceFile('trace-1.jsonl')).toBe(join(traceDir, 'trace-1.jsonl'));
  });

  it('rejects a path-traversal filename before ever touching the filesystem', () => {
    const { root } = makeRepoWithTraceDir();
    created.push(root);
    process.env.SCCE_REPO_ROOT = root;
    expect(() => resolveTraceFile('../../etc/passwd')).toThrow(TraceContainmentError);
    expect(() => resolveTraceFile('..%2f..%2fetc%2fpasswd.jsonl')).toThrow(TraceContainmentError);
  });

  it('rejects a non-.jsonl filename', () => {
    const { root } = makeRepoWithTraceDir();
    created.push(root);
    process.env.SCCE_REPO_ROOT = root;
    expect(() => resolveTraceFile('notes.txt')).toThrow(TraceContainmentError);
  });

  it('rejects a missing file explicitly', () => {
    const { root } = makeRepoWithTraceDir();
    created.push(root);
    process.env.SCCE_REPO_ROOT = root;
    expect(() => resolveTraceFile('does-not-exist.jsonl')).toThrow(TraceContainmentError);
  });

  it('rejects a symlink planted inside the trace directory pointing outside it', () => {
    const { root, traceDir } = makeRepoWithTraceDir();
    created.push(root);
    process.env.SCCE_REPO_ROOT = root;
    const secretDir = mkdtempSync(join(tmpdir(), 'scce-mcp-secret-'));
    created.push(secretDir);
    const secretFile = join(secretDir, 'secret.jsonl');
    writeFileSync(secretFile, '{"secret":true}\n');
    const linkPath = join(traceDir, 'escape.jsonl');
    try {
      symlinkSync(secretFile, linkPath);
    } catch {
      // symlink creation can require elevated privileges on Windows; skip if unavailable
      return;
    }
    expect(() => resolveTraceFile('escape.jsonl')).toThrow(TraceContainmentError);
  });
});
