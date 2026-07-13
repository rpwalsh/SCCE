import { run, truncate } from '../lib/run.js';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const ALLOWED_COMMANDS = new Set([
  'pnpm build',
  'pnpm test',
  'pnpm scce',
  'pnpm server',
  'pnpm mcp:build',
  'pnpm mcp:start',
  'pnpm -s test',
  'pnpm -s typecheck',
  'pnpm -s lint',
  'pnpm -s build',
]);

const DANGEROUS_PATTERNS = /\b(rm|del|git push|git reset|git checkout|npm install|pnpm add|pnpm install)\b/i;
const SCRIPT_NAME_RE = /^[A-Za-z0-9:_-]+$/;

function isSafeCommand(raw: string): boolean {
  const trimmed = raw.trim();
  if (ALLOWED_COMMANDS.has(trimmed)) return true;
  const parts = trimmed.split(/\s+/);
  if (parts[0] !== 'pnpm') return false;

  const scriptName = parts[1] === '-s' ? parts[2] : parts[1];
  const expectedParts = parts[1] === '-s' ? 3 : 2;
  if (!scriptName || parts.length !== expectedParts || !SCRIPT_NAME_RE.test(scriptName)) return false;
  return Boolean(readPackageScripts()[scriptName]);
}

export async function handleTestRun(args: { command?: string; filter?: string; maxOutputLines?: number }): Promise<string> {
  const max = args.maxOutputLines ?? 200;
  const result: Record<string, unknown> = { command: 'pnpm -s test', args: [], ok: false, exitCode: null, durationMs: 0, output: '', output_truncated: false };
  try {
    const cmdStr = sanitizeCommand(args.command);
    if (!cmdStr) return JSON.stringify({ ...result, error: 'unsupported_command' });
    const filtered = applyFilter(cmdStr, args.filter);
    if (filtered.args.includes('__UNSUPPORTED_FILTER__')) {
      return JSON.stringify({ ...result, error: 'unsupported_filter', message: 'filter is only supported for test commands' });
    }
    const { command, args: cmdArgs, exitCode, durationMs, stdout, stderr, timedOut } = await run(filtered.command, filtered.args, process.cwd());
    const combined = [stdout, stderr].filter(Boolean).join('\n');
    result.command = command;
    result.args = cmdArgs;
    result.exitCode = exitCode;
    result.durationMs = durationMs;
    result.output = truncate(combined, max * 1024);
    result.output_truncated = timedOut || combined.length > max * 1024;
    result.ok = exitCode === 0;
    return JSON.stringify(result);
  } catch (error) {
    result.error = error instanceof Error ? error.message : String(error);
    return JSON.stringify(result);
  }
}

export async function handleTestFailures(args: { command?: string; maxFailures?: number }): Promise<string> {
  const maxFailures = args.maxFailures ?? 10;
  const result: Record<string, unknown> = { command: 'pnpm -s test', args: [], failures: [], ok: false, exitCode: null, durationMs: 0 };
  try {
    const cmdStr = sanitizeCommand(args.command);
    if (!cmdStr) return JSON.stringify({ ...result, error: 'unsupported_command' });
    const { command, args: cmdArgs, exitCode, durationMs, stdout, stderr } = await run(cmdStr.command, cmdStr.args, process.cwd());
    const combined = [stdout, stderr].join('\n');
    result.command = command;
    result.args = cmdArgs;
    result.exitCode = exitCode;
    result.durationMs = durationMs;
    result.ok = exitCode === 0;
    if (exitCode !== 0) {
      const lines = combined.split(/\r?\n/).filter(Boolean);
      result.failures = extractFailures(lines).slice(0, maxFailures);
    }
    return JSON.stringify(result);
  } catch (error) {
    result.error = error instanceof Error ? error.message : String(error);
    return JSON.stringify(result);
  }
}

function sanitizeCommand(input?: string): { command: string; args: string[] } | null {
  const raw = (input ?? 'pnpm -s test').trim();
  if (DANGEROUS_PATTERNS.test(raw)) return null;
  if (!isSafeCommand(raw)) return null;
  const [command, ...args] = raw.split(/\s+/);
  return { command: command ?? 'pnpm', args: args ?? [] };
}

function readPackageScripts(): Record<string, string> {
  try {
    const pkg = JSON.parse(readFileSync(join(process.cwd(), 'package.json'), 'utf8')) as { scripts?: Record<string, string> };
    return pkg.scripts ?? {};
  } catch {
    return {};
  }
}

function applyFilter(cmd: { command: string; args: string[] }, filter?: string): { command: string; args: string[] } {
  if (!filter) return cmd;
  const isTestCommand = cmd.command === 'pnpm' && (cmd.args[0] === 'test' || cmd.args.includes('test') || cmd.args.includes('-s') && cmd.args.includes('test'));
  if (isTestCommand) {
    return { command: 'pnpm', args: ['-s', 'test', '--', ...filter.split(/\s+/)] };
  }
  // For non-test commands (typecheck, lint, build), return error marker
  return { command: cmd.command, args: ['__UNSUPPORTED_FILTER__'] };
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
