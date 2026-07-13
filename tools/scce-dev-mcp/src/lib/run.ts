import { existsSync } from 'node:fs';
import { delimiter, join } from 'node:path';

export interface RunResult {
  command: string;
  args: string[];
  cwd: string;
  exitCode: number | null;
  durationMs: number;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

const DEFAULT_TIMEOUT_MS = 30_000;
const MAX_OUTPUT_BYTES = 512 * 1024;

function truncateBytes(text: string, maxBytes = MAX_OUTPUT_BYTES): string {
  const buf = Buffer.from(text, 'utf8');
  if (buf.length <= maxBytes) return text;
  return buf.slice(0, maxBytes).toString('utf8') + '\n... truncated';
}

function truncate(text: string, maxLines = 200): string {
  const lines = text.split(/\r?\n/);
  if (lines.length <= maxLines) return text;
  return lines.slice(0, maxLines).join('\n') + '\n... truncated';
}

export async function run(cmd: string, args: string[], cwd = process.cwd(), timeoutMs = DEFAULT_TIMEOUT_MS): Promise<RunResult> {
  const { spawn } = await import('node:child_process');
  const start = Date.now();
  const stdoutChunks: Buffer[] = [];
  const stderrChunks: Buffer[] = [];
  let totalStdoutBytes = 0;
  let totalStderrBytes = 0;
  let timedOut = false;

  const resolved = resolveExecutable(cmd, args);
  const child = spawn(resolved.command, resolved.args, { cwd, stdio: ['ignore', 'pipe', 'pipe'], shell: false });

  child.stdout.on('data', (data: Buffer) => {
    if (totalStdoutBytes < MAX_OUTPUT_BYTES) {
      stdoutChunks.push(data);
      totalStdoutBytes += data.length;
    }
  });
  child.stderr.on('data', (data: Buffer) => {
    if (totalStderrBytes < MAX_OUTPUT_BYTES) {
      stderrChunks.push(data);
      totalStderrBytes += data.length;
    }
  });

  let finished = false;
  await new Promise<void>((resolve) => {
    const timer = setTimeout(() => {
      if (!finished) {
        finished = true;
        timedOut = true;
        try { child.kill('SIGTERM'); } catch {}
        resolve();
      }
    }, timeoutMs);
    child.on('close', (code) => {
      if (!finished) {
        finished = true;
        clearTimeout(timer);
        resolve();
      }
    });
    child.on('error', () => {
      if (!finished) {
        finished = true;
        clearTimeout(timer);
        resolve();
      }
    });
  });

  const exitCode = child.exitCode ?? null;
  const durationMs = Date.now() - start;
  let stdout = Buffer.concat(stdoutChunks).toString('utf8');
  let stderr = Buffer.concat(stderrChunks).toString('utf8');
  if (totalStdoutBytes >= MAX_OUTPUT_BYTES) {
    stdout = truncateBytes(stdout, MAX_OUTPUT_BYTES);
  }
  if (totalStderrBytes >= MAX_OUTPUT_BYTES) {
    stderr = truncateBytes(stderr, MAX_OUTPUT_BYTES);
  }
  return {
    command: cmd,
    args,
    cwd,
    exitCode,
    durationMs,
    stdout,
    stderr,
    timedOut,
  };
}

export { truncate };

function resolveExecutable(cmd: string, args: string[]): { command: string; args: string[] } {
  if (process.platform !== 'win32' || cmd !== 'pnpm') return { command: cmd, args };
  const pnpmEntry = findPnpmEntrypoint();
  if (!pnpmEntry) return { command: cmd, args };
  return { command: process.execPath, args: [pnpmEntry, ...args] };
}

function findPnpmEntrypoint(): string | undefined {
  const pathDirs = (process.env.PATH ?? '').split(delimiter).filter(Boolean);
  for (const dir of pathDirs) {
    for (const candidate of [
      join(dir, 'node_modules', 'corepack', 'dist', 'pnpm.js'),
      join(dir, 'node_modules', 'pnpm', 'bin', 'pnpm.cjs'),
    ]) {
      if (existsSync(candidate)) return candidate;
    }
  }
  return undefined;
}
