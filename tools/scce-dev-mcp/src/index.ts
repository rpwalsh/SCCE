// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import { handleRepoShape } from './tools/repo.js';
import { handleRepoFiles } from './tools/repo.js';
import { handleRepoSearch } from './tools/repo.js';
import { handleRepoSymbol } from './tools/repo.js';
import { handleRepoCallSites } from './tools/repo.js';
import { handleRepoRoutes } from './tools/repo.js';
import { handleRepoDeps } from './tools/repo.js';
import { handleRepoDeadCode } from './tools/repo.js';
import { handleGitChanged } from './tools/git.js';
import { handleGitDiffSummary } from './tools/git.js';
import { handleGitLog } from './tools/git.js';
import { handleTestRun } from './tools/tests.js';
import { handleTestFailures } from './tools/tests.js';
import { handleListCommands } from './tools/tests.js';
import { handlePgSchema } from './tools/postgres.js';
import { handlePgQuery } from './tools/postgres.js';
import { handlePgExplain } from './tools/postgres.js';
import { handleTraceList, handleTraceRead, handleAnswerTrace } from './tools/scceTrace.js';
import { resolveRepositoryRoot, InvalidRepositoryRootError } from './lib/repoRoot.js';
import { validateToolArgs, ToolArgumentError, toolSchemas, type ToolName } from './lib/validate.js';
import { COMMAND_REGISTRY } from './lib/commands.js';

try {
  const root = resolveRepositoryRoot();
  console.error(`scce-dev-mcp: resolved repository root: ${root}`);
} catch (error) {
  if (error instanceof InvalidRepositoryRootError) {
    console.error(`scce-dev-mcp: fatal: ${error.message}`);
    console.error('scce-dev-mcp: set SCCE_REPO_ROOT (or CLAUDE_PROJECT_DIR, or launch with cwd at the repo root) to a valid SCCE checkout.');
    process.exit(1);
  }
  throw error;
}

const server = new Server(
  {
    name: 'scce-dev-mcp',
    version: '0.1.0',
  },
  {
    instructions: "Start with repo_shape and git_changed. Use repo_symbol, repo_callsites, repo_search, and git_diff_summary before opening source files. repo_symbol/repo_callsites are ripgrep-based text search, not compiler-level TypeScript resolution. test_run/test_failures accept a fixed commandId (see repo_shape's scripts, or the tool descriptions) against a closed command registry, not an arbitrary shell string. Keep every result bounded. PostgreSQL tools run every statement in a session-level read-only transaction with a restricted search_path and statement/lock timeouts, plus a keyword/function blocklist -- real defense-in-depth, not a parsed-AST security boundary; genuine safety additionally requires the configured database credential to be a real least-privileged role scoped to the SCCE schema with no write grants, which this tool cannot verify. Trace tools report only events that exist and are containment-checked against the configured trace directory. This server exposes no arbitrary shell execution and no repository write, git-write, or package-install operation.",
    capabilities: {
      tools: {},
    },
  }
);

const commandIds = Object.keys(COMMAND_REGISTRY).join(', ');

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: 'repo_shape',
      description: 'Summarize repo structure, packages, scripts, and file counts.',
      inputSchema: { type: 'object', properties: {} },
    },
    {
      name: 'repo_files',
      description: 'List files with optional glob/contains filter (contains is applied before truncation).',
      inputSchema: {
        type: 'object',
        properties: {
          glob: { type: 'string' },
          contains: { type: 'string' },
          maxResults: { type: 'number', default: 100 },
        },
      },
    },
    {
      name: 'repo_search',
      description: 'Run ripgrep and return bounded matches.',
      inputSchema: {
        type: 'object',
        properties: {
          query: { type: 'string' },
          glob: { type: 'string' },
          maxResults: { type: 'number', default: 50 },
        },
        required: ['query'],
      },
    },
    {
      name: 'repo_symbol',
      description: 'Ripgrep-based text search for likely symbol definitions/references. Not compiler-level: overloads, re-exports, and destructuring may be misclassified.',
      inputSchema: {
        type: 'object',
        properties: {
          symbol: { type: 'string' },
          maxResults: { type: 'number', default: 25 },
        },
        required: ['symbol'],
      },
    },
    {
      name: 'repo_callsites',
      description: 'Ripgrep-based text search for call sites of a symbol; same non-compiler-level caveats as repo_symbol.',
      inputSchema: {
        type: 'object',
        properties: {
          symbol: { type: 'string' },
          maxResults: { type: 'number', default: 50 },
        },
        required: ['symbol'],
      },
    },
    {
      name: 'repo_routes',
      description: "Discover API routes. Prefers this repo's declarative `export const ROUTES` table in packages/server/src/routes.ts; also returns a bounded text scan for other dispatch styles.",
      inputSchema: { type: 'object', properties: {} },
    },
    {
      name: 'repo_deps',
      description: 'Summarize dependency graph and circular deps via `pnpm repo:deps`; reports the real exit code.',
      inputSchema: { type: 'object', properties: {} },
    },
    {
      name: 'repo_deadcode',
      description: 'Summarize unused files/exports via `pnpm repo:dead`; reports the real exit code.',
      inputSchema: { type: 'object', properties: {} },
    },
    {
      name: 'git_changed',
      description: 'Summarize changed files against the working tree (git status --porcelain).',
      inputSchema: { type: 'object', properties: {} },
    },
    {
      name: 'git_diff_summary',
      description: 'Compact diff summary: git diff --stat plus bounded selected hunk text for an optional repo-relative path.',
      inputSchema: {
        type: 'object',
        properties: {
          path: { type: 'string' },
          maxLines: { type: 'number', default: 200 },
        },
      },
    },
    {
      name: 'git_log',
      description: 'Bounded recent commit history (hash, date, author, subject) for the repo or one path.',
      inputSchema: {
        type: 'object',
        properties: {
          path: { type: 'string' },
          maxCount: { type: 'number', default: 20 },
        },
      },
    },
    {
      name: 'test_run',
      description: `Run one command from a closed registry (commandId, not a shell string). Available: ${commandIds}. Do not call commandId "validate" from within this server's own test suite — it transitively runs mcp:verify and would recurse.`,
      inputSchema: {
        type: 'object',
        properties: {
          commandId: { type: 'string', default: 'unit' },
          filter: { type: 'string' },
          maxOutputLines: { type: 'number', default: 200 },
        },
      },
    },
    {
      name: 'test_failures',
      description: 'Run one registry commandId (same set as test_run) and extract only failing test names and errors.',
      inputSchema: {
        type: 'object',
        properties: {
          commandId: { type: 'string', default: 'unit' },
          maxFailures: { type: 'number', default: 10 },
        },
      },
    },
    {
      name: 'test_list_commands',
      description: 'List the closed registry of commandIds accepted by test_run/test_failures.',
      inputSchema: { type: 'object', properties: {} },
    },
    {
      name: 'pg_schema',
      description: 'Read-only Postgres schema inspection for the configured schema (SCCE_DATABASE_URL overrides the connection target).',
      inputSchema: {
        type: 'object',
        properties: {
          schema: { type: 'string' },
        },
      },
    },
    {
      name: 'pg_query',
      description: 'Bounded SELECT preview run in a session-level read-only transaction (restricted search_path, statement/lock timeouts): capped rows and per-cell length. Single SELECT only — no EXPLAIN, no comments, no CTEs, no multiple statements, no known-dangerous function calls; use pg_explain for query plans. This is defense-in-depth, not a parsed-SQL security boundary — real safety depends on the configured credential being a least-privileged, schema-scoped role.',
      inputSchema: {
        type: 'object',
        properties: {
          sql: { type: 'string' },
          maxRows: { type: 'number', default: 20 },
        },
        required: ['sql'],
      },
    },
    {
      name: 'pg_explain',
      description: 'Run EXPLAIN (FORMAT JSON) for a SELECT query only. Mutating statements and EXPLAIN ANALYZE are rejected before any connection is attempted.',
      inputSchema: {
        type: 'object',
        properties: {
          sql: { type: 'string' },
        },
        required: ['sql'],
      },
    },
    {
      name: 'scce_trace_list',
      description: 'List recent SCCE trace files from the configured trace directory.',
      inputSchema: {
        type: 'object',
        properties: {
          limit: { type: 'number', default: 20 },
        },
      },
    },
    {
      name: 'scce_trace_read',
      description: 'Stream JSONL trace events (bounded) and return compact filtered events. Trace files are containment-checked against the trace directory.',
      inputSchema: {
        type: 'object',
        properties: {
          traceId: { type: 'string' },
          file: { type: 'string' },
          stage: { type: 'string' },
          maxEvents: { type: 'number', default: 100 },
        },
      },
    },
    {
      name: 'scce_answer_trace',
      description: 'Summarize one trace by stage order, showing available and missing stages.',
      inputSchema: {
        type: 'object',
        properties: {
          traceId: { type: 'string' },
          file: { type: 'string' },
        },
      },
    },
  ],
}));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;
  try {
    if (!(name in toolSchemas)) {
      return { content: [{ type: 'text', text: JSON.stringify({ error: 'Unknown tool' }) }], isError: true };
    }
    const validated = validateToolArgs(name as ToolName, args ?? {});
    switch (name) {
      case 'repo_shape':
        return { content: [{ type: 'text', text: await handleRepoShape() }] };
      case 'repo_files':
        return { content: [{ type: 'text', text: await handleRepoFiles(validated as any) }] };
      case 'repo_search':
        return { content: [{ type: 'text', text: await handleRepoSearch(validated as any) }] };
      case 'repo_symbol':
        return { content: [{ type: 'text', text: await handleRepoSymbol(validated as any) }] };
      case 'repo_callsites':
        return { content: [{ type: 'text', text: await handleRepoCallSites(validated as any) }] };
      case 'repo_routes':
        return { content: [{ type: 'text', text: await handleRepoRoutes() }] };
      case 'repo_deps':
        return { content: [{ type: 'text', text: await handleRepoDeps() }] };
      case 'repo_deadcode':
        return { content: [{ type: 'text', text: await handleRepoDeadCode() }] };
      case 'git_changed':
        return { content: [{ type: 'text', text: await handleGitChanged() }] };
      case 'git_diff_summary':
        return { content: [{ type: 'text', text: await handleGitDiffSummary(validated as any) }] };
      case 'git_log':
        return { content: [{ type: 'text', text: await handleGitLog(validated as any) }] };
      case 'test_run':
        return { content: [{ type: 'text', text: await handleTestRun(validated as any) }] };
      case 'test_failures':
        return { content: [{ type: 'text', text: await handleTestFailures(validated as any) }] };
      case 'test_list_commands':
        return { content: [{ type: 'text', text: handleListCommands() }] };
      case 'pg_schema':
        return { content: [{ type: 'text', text: await handlePgSchema(validated as any) }] };
      case 'pg_query':
        return { content: [{ type: 'text', text: await handlePgQuery(validated as any) }] };
      case 'pg_explain':
        return { content: [{ type: 'text', text: await handlePgExplain(validated as any) }] };
      case 'scce_trace_list':
        return { content: [{ type: 'text', text: await handleTraceList(validated as any) }] };
      case 'scce_trace_read':
        return { content: [{ type: 'text', text: await handleTraceRead(validated as any) }] };
      case 'scce_answer_trace':
        return { content: [{ type: 'text', text: await handleAnswerTrace(validated as any) }] };
      default:
        return { content: [{ type: 'text', text: JSON.stringify({ error: 'Unknown tool' }) }], isError: true };
    }
  } catch (error) {
    if (error instanceof ToolArgumentError) {
      return { content: [{ type: 'text', text: JSON.stringify({ error: 'invalid_arguments', message: error.message }) }], isError: true };
    }
    const message = error instanceof Error ? error.message : String(error);
    return { content: [{ type: 'text', text: JSON.stringify({ error: message }) }], isError: true };
  }
});

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error('Fatal: ', message);
  process.exit(1);
});
