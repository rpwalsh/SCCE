import { runProcess, truncate } from '../lib/run.js';
import { resolveCommand, UnknownCommandError, UnsupportedFilterError, InvalidFilterError, listCommands } from '../lib/commands.js';
import { resolveRepositoryRoot } from '../lib/repoRoot.js';

export async function handleTestRun(args: { commandId?: string; filter?: string; maxOutputLines?: number }): Promise<string> {
  const maxOutputLines = args.maxOutputLines ?? 200;
  const commandId = args.commandId ?? 'unit';
  let resolved: { command: string; args: string[]; timeoutMs: number };
  try {
    resolved = resolveCommand(commandId, args.filter);
  } catch (error) {
    return commandResolutionError(error, commandId);
  }
  const status = await runProcess({
    commandId,
    command: resolved.command,
    args: resolved.args,
    cwd: resolveRepositoryRoot(),
    timeoutMs: resolved.timeoutMs
  });
  const combined = [status.stdout, status.stderr].filter(Boolean).join('\n');
  return JSON.stringify({
    commandId,
    command: status.command,
    args: status.args,
    ok: status.exitCode === 0 && !status.timedOut && !status.spawnError,
    exitCode: status.exitCode,
    timedOut: status.timedOut,
    spawnError: status.spawnError,
    durationMs: status.durationMs,
    output: truncate(combined, maxOutputLines),
    outputTruncated: status.stdoutTruncated || status.stderrTruncated || combined.split(/\r?\n/).length > maxOutputLines
  });
}

export async function handleTestFailures(args: { commandId?: string; maxFailures?: number }): Promise<string> {
  const maxFailures = args.maxFailures ?? 10;
  const commandId = args.commandId ?? 'unit';
  let resolved: { command: string; args: string[]; timeoutMs: number };
  try {
    resolved = resolveCommand(commandId);
  } catch (error) {
    return commandResolutionError(error, commandId);
  }
  const status = await runProcess({
    commandId,
    command: resolved.command,
    args: resolved.args,
    cwd: resolveRepositoryRoot(),
    timeoutMs: resolved.timeoutMs
  });
  const combined = [status.stdout, status.stderr].join('\n');
  const result: Record<string, unknown> = {
    commandId,
    command: status.command,
    args: status.args,
    ok: status.exitCode === 0 && !status.timedOut && !status.spawnError,
    exitCode: status.exitCode,
    timedOut: status.timedOut,
    spawnError: status.spawnError,
    durationMs: status.durationMs,
    failures: [] as Array<Record<string, unknown>>
  };
  if (status.exitCode !== 0 && !status.spawnError) {
    const lines = combined.split(/\r?\n/).filter(Boolean);
    result.failures = extractFailures(lines).slice(0, maxFailures);
  }
  return JSON.stringify(result);
}

export function handleListCommands(): string {
  return JSON.stringify({ commands: listCommands() });
}

function commandResolutionError(error: unknown, commandId: string): string {
  if (error instanceof UnknownCommandError) {
    return JSON.stringify({ error: 'unknown_command', commandId, availableCommands: listCommands().map((c) => c.commandId) });
  }
  if (error instanceof UnsupportedFilterError) {
    return JSON.stringify({ error: 'unsupported_filter', commandId, message: 'this commandId does not accept a filter' });
  }
  if (error instanceof InvalidFilterError) {
    return JSON.stringify({ error: 'invalid_filter', commandId });
  }
  return JSON.stringify({ error: 'command_resolution_failed', commandId, message: error instanceof Error ? error.message : String(error) });
}

function extractFailures(lines: string[]): Array<Record<string, unknown>> {
  const out: Array<Record<string, unknown>> = [];
  let current: Record<string, unknown> | null = null;
  for (const line of lines) {
    // vitest FAIL format: FAIL  path/to/test.test.ts > test name
    const testFail = line.match(/FAIL\s+([^|]+?)(?:\s+[>|]|\s+\S+\.test)/);
    if (testFail && testFail[1]) {
      if (current && current.testName) out.push(current);
      current = { testName: testFail[1].trim() };
      continue;
    }
    // tsc error format: src/file.ts(123,45): error TS2345: message
    const tscError = line.match(/([A-Za-z0-9_./\\-]+\.ts)\((\d+),(\d+)\):\s+(error\s+TS\d+:\s+.+)/i);
    if (tscError && tscError[1]) {
      if (current && current.testName) out.push(current);
      current = { testName: tscError[1], filePath: tscError[1], lineNumber: Number(tscError[2]), errorMessage: tscError[4] };
      continue;
    }
    // vitest numbered failure:  1) test name
    const xunitFail = line.match(/\s+\d+\)\s+(.*)/);
    if (xunitFail && xunitFail[1] && current) {
      current.errorMessage = xunitFail[1].trim();
      continue;
    }
    // source reference: at .../file.ts:123:45
    const srcRef = line.match(/at\s+.*?([A-Za-z0-9_./\\-]+\.ts:\d+:\d+)/);
    if (srcRef && srcRef[1] && current) {
      current.errorLocation = srcRef[1];
    }
  }
  if (current && current.testName) out.push(current);
  return out;
}
