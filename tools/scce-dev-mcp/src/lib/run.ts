import { existsSync } from 'node:fs';
import { delimiter, join } from 'node:path';
import { spawn, execFile } from 'node:child_process';

export interface RunStatus {
  commandId: string;
  command: string;
  args: string[];
  cwd: string;
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  durationMs: number;
  stdout: string;
  stderr: string;
  stdoutTruncated: boolean;
  stderrTruncated: boolean;
  timedOut: boolean;
  spawnError?: string;
}

export class ProcessCheckError extends Error {
  constructor(public readonly status: RunStatus, reason: string) {
    super(reason);
    this.name = 'ProcessCheckError';
  }
}

const DEFAULT_TIMEOUT_MS = 30_000;
const MAX_OUTPUT_BYTES = 512 * 1024;

function truncateBytes(text: string, maxBytes: number): { text: string; truncated: boolean } {
  const buf = Buffer.from(text, 'utf8');
  if (buf.length <= maxBytes) return { text, truncated: false };
  return { text: buf.slice(0, maxBytes).toString('utf8') + '\n... truncated', truncated: true };
}

export function truncate(text: string, maxLines = 200): string {
  const lines = text.split(/\r?\n/);
  if (lines.length <= maxLines) return text;
  return lines.slice(0, maxLines).join('\n') + '\n... truncated';
}

/**
 * Terminate a child process and every descendant it spawned. SIGTERM/kill()
 * alone only signals the direct child; a tool that shells out further (e.g. a
 * package manager invoking a test runner) can leave orphans behind on timeout
 * without this.
 */
async function killProcessTree(pid: number): Promise<void> {
  if (process.platform === 'win32') {
    await new Promise<void>((resolve) => {
      execFile('taskkill', ['/pid', String(pid), '/T', '/F'], () => resolve());
    });
    return;
  }
  try {
    process.kill(-pid, 'SIGTERM');
  } catch {
    try { process.kill(pid, 'SIGTERM'); } catch { /* already gone */ }
  }
  await new Promise((resolve) => setTimeout(resolve, 200));
  try {
    process.kill(-pid, 'SIGKILL');
  } catch {
    try { process.kill(pid, 'SIGKILL'); } catch { /* already gone */ }
  }
}

/**
 * Full bounded process status. Never throws — spawn failures, nonzero exit,
 * and timeouts are all reported in the returned status rather than as
 * exceptions, so a caller cannot mistake "the promise resolved" for success.
 */
export async function runProcess(input: {
  commandId: string;
  command: string;
  args: string[];
  cwd: string;
  timeoutMs?: number;
}): Promise<RunStatus> {
  const timeoutMs = input.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const start = Date.now();
  const resolved = resolveExecutable(input.command, input.args);

  let child: ReturnType<typeof spawn>;
  try {
    child = spawn(resolved.command, resolved.args, {
      cwd: input.cwd,
      stdio: ['ignore', 'pipe', 'pipe'],
      shell: false,
      detached: process.platform !== 'win32'
    });
  } catch (error) {
    return {
      commandId: input.commandId,
      command: input.command,
      args: input.args,
      cwd: input.cwd,
      exitCode: null,
      signal: null,
      durationMs: Date.now() - start,
      stdout: '',
      stderr: '',
      stdoutTruncated: false,
      stderrTruncated: false,
      timedOut: false,
      spawnError: error instanceof Error ? error.message : String(error)
    };
  }

  const stdoutChunks: Buffer[] = [];
  const stderrChunks: Buffer[] = [];
  let totalStdoutBytes = 0;
  let totalStderrBytes = 0;
  let timedOut = false;
  let spawnError: string | undefined;

  child.stdout?.on('data', (data: Buffer) => {
    if (totalStdoutBytes < MAX_OUTPUT_BYTES) {
      stdoutChunks.push(data);
      totalStdoutBytes += data.length;
    }
  });
  child.stderr?.on('data', (data: Buffer) => {
    if (totalStderrBytes < MAX_OUTPUT_BYTES) {
      stderrChunks.push(data);
      totalStderrBytes += data.length;
    }
  });

  let finished = false;
  let signal: NodeJS.Signals | null = null;
  await new Promise<void>((resolve) => {
    const timer = setTimeout(() => {
      if (finished) return;
      timedOut = true;
      if (typeof child.pid === 'number') {
        void killProcessTree(child.pid).finally(() => {
          if (!finished) {
            finished = true;
            resolve();
          }
        });
      } else {
        try { child.kill('SIGKILL'); } catch { /* ignore */ }
        finished = true;
        resolve();
      }
    }, timeoutMs);
    child.on('close', (code, sig) => {
      if (finished) return;
      finished = true;
      signal = sig;
      clearTimeout(timer);
      resolve();
    });
    child.on('error', (error) => {
      if (finished) return;
      spawnError = error instanceof Error ? error.message : String(error);
      finished = true;
      clearTimeout(timer);
      resolve();
    });
  });

  const exitCode = child.exitCode ?? null;
  const durationMs = Date.now() - start;
  const stdoutResult = truncateBytes(Buffer.concat(stdoutChunks).toString('utf8'), MAX_OUTPUT_BYTES);
  const stderrResult = truncateBytes(Buffer.concat(stderrChunks).toString('utf8'), MAX_OUTPUT_BYTES);
  return {
    commandId: input.commandId,
    command: input.command,
    args: input.args,
    cwd: input.cwd,
    exitCode,
    signal,
    durationMs,
    stdout: stdoutResult.text,
    stderr: stderrResult.text,
    stdoutTruncated: stdoutResult.truncated,
    stderrTruncated: stderrResult.truncated,
    timedOut,
    spawnError
  };
}

/**
 * Same execution as runProcess, but rejects on spawn failure, timeout, or a
 * nonzero exit code instead of returning a status the caller might forget to
 * check. Handlers that need "did this actually succeed" should use this.
 */
export async function runChecked(input: {
  commandId: string;
  command: string;
  args: string[];
  cwd: string;
  timeoutMs?: number;
}): Promise<RunStatus> {
  const status = await runProcess(input);
  if (status.spawnError) throw new ProcessCheckError(status, `spawn failed: ${status.spawnError}`);
  if (status.timedOut) throw new ProcessCheckError(status, `timed out after ${input.timeoutMs ?? DEFAULT_TIMEOUT_MS}ms`);
  if (status.exitCode !== 0) throw new ProcessCheckError(status, `nonzero exit code: ${String(status.exitCode)}`);
  return status;
}

/** @deprecated legacy shape kept only for any not-yet-migrated caller during this rewrite. */
export interface RunResult extends RunStatus {}

/** @deprecated use runProcess/runChecked. Retained temporarily for callers not yet migrated in this pass. */
export async function run(cmd: string, args: string[], cwd = process.cwd(), timeoutMs = DEFAULT_TIMEOUT_MS): Promise<RunResult> {
  return runProcess({ commandId: cmd, command: cmd, args, cwd, timeoutMs });
}

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
      join(dir, 'node_modules', 'pnpm', 'bin', 'pnpm.cjs')
    ]) {
      if (existsSync(candidate)) return candidate;
    }
  }
  return undefined;
}
