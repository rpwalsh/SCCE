import { describe, expect, it, beforeAll, afterAll } from 'vitest';
import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const packageDir = resolve(fileURLToPath(new URL('.', import.meta.url)), '..', '..');
const repoRoot = resolve(packageDir, '..', '..');
const distIndex = resolve(packageDir, 'dist', 'index.js');

let client: Client;
let transport: StdioClientTransport;

beforeAll(async () => {
  execFileSync(process.execPath, [resolve(packageDir, 'node_modules', 'typescript', 'bin', 'tsc'), '-p', resolve(packageDir, 'tsconfig.json')], {
    cwd: packageDir,
    stdio: 'pipe'
  });
  transport = new StdioClientTransport({
    command: process.execPath,
    args: [distIndex],
    cwd: repoRoot,
    env: { ...processEnvWithoutRepoRootOverride(), SCCE_REPO_ROOT: repoRoot }
  });
  client = new Client({ name: 'scce-dev-mcp-integration-test', version: '0.0.1' }, { capabilities: {} });
  await client.connect(transport);
}, 60000);

afterAll(async () => {
  await client?.close();
});

function processEnvWithoutRepoRootOverride(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined && key !== 'CLAUDE_PROJECT_DIR') env[key] = value;
  }
  return env;
}

function parseToolText(result: { content: Array<{ type: string; text?: string }>; isError?: boolean }): { data: any; isError: boolean } {
  const text = result.content.find((c) => c.type === 'text')?.text ?? '{}';
  return { data: JSON.parse(text), isError: Boolean(result.isError) };
}

describe('scce-dev-mcp stdio protocol', () => {
  it('lists a stable tool set on the resolved repository, not an empty or wrong-root result', async () => {
    const first = await client.listTools();
    const second = await client.listTools();
    expect(first.tools.map((t) => t.name).sort()).toEqual(second.tools.map((t) => t.name).sort());
    expect(first.tools.map((t) => t.name)).toEqual(expect.arrayContaining(['repo_shape', 'git_changed', 'repo_search', 'test_run', 'pg_explain', 'scce_trace_read']));
  });

  it('repo_shape identifies this SCCE checkout for real, not a stub', async () => {
    const result = await client.callTool({ name: 'repo_shape', arguments: {} });
    const { data, isError } = parseToolText(result as any);
    expect(isError).toBe(false);
    expect(data.packages).toEqual(expect.arrayContaining(['packages/*']));
    expect(data.scripts.build).toBeDefined();
  });

  it('git_changed reports the real working-tree status', async () => {
    const result = await client.callTool({ name: 'git_changed', arguments: {} });
    const { data, isError } = parseToolText(result as any);
    expect(isError).toBe(false);
    expect(Array.isArray(data.changed)).toBe(true);
  });

  it('repo_search finds a real symbol in this checkout', async () => {
    const result = await client.callTool({ name: 'repo_search', arguments: { query: 'createFunctionalCognitionEngine', maxResults: 5 } });
    const { data, isError } = parseToolText(result as any);
    expect(isError).toBe(false);
    expect(data.matches.length).toBeGreaterThan(0);
  });

  it('runs one real, fast, non-recursive allowlisted command successfully', async () => {
    const result = await client.callTool({ name: 'test_run', arguments: { commandId: 'shape' } });
    const { data, isError } = parseToolText(result as any);
    expect(isError).toBe(false);
    expect(data.ok).toBe(true);
    expect(data.exitCode).toBe(0);
  }, 30000);

  it('rejects invalid arguments instead of running the tool', async () => {
    const result = await client.callTool({ name: 'repo_search', arguments: { maxResults: 999999 } });
    const { data, isError } = parseToolText(result as any);
    expect(isError).toBe(true);
    expect(data.error).toBe('invalid_arguments');
  });

  it('rejects a trace path-traversal attempt at the argument-validation boundary', async () => {
    const result = await client.callTool({ name: 'scce_trace_read', arguments: { file: '../../etc/passwd' } });
    const { data, isError } = parseToolText(result as any);
    expect(isError).toBe(true);
    expect(data.error).toBe('invalid_arguments');
  });

  it('rejects mutating SQL before any database connection is attempted', async () => {
    const result = await client.callTool({ name: 'pg_explain', arguments: { sql: 'DELETE FROM events WHERE 1=1' } });
    const { data, isError } = parseToolText(result as any);
    expect(isError).toBe(false);
    expect(data.error).toBe('sql_rejected');
  });

  it('surfaces an unknown tool as an error rather than silently succeeding', async () => {
    const result = await client.callTool({ name: 'definitely_not_a_real_tool', arguments: {} });
    const { isError } = parseToolText(result as any);
    expect(isError).toBe(true);
  });
});
