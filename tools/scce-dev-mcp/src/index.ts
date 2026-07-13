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
import { handleTestRun } from './tools/tests.js';
import { handleTestFailures } from './tools/tests.js';
import { handlePgSchema } from './tools/postgres.js';
import { handlePgExplain } from './tools/postgres.js';
import { handleTraceList, handleTraceRead, handleAnswerTrace } from './tools/scceTrace.js';

const server = new Server(
  {
    name: 'scce-dev-mcp',
    version: '0.1.0',
  },
  {
    capabilities: {
      tools: {},
    },
  }
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: 'repo_shape',
      description: 'Summarize repo structure, packages, scripts, and file counts.',
      inputSchema: { type: 'object', properties: {} },
    },
    {
      name: 'repo_files',
      description: 'List files with optional glob/contains filter.',
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
      description: 'Find TypeScript symbol definitions with lightweight parsing.',
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
      description: 'Find call sites/references for a symbol.',
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
      description: 'Discover API routes/server handlers.',
      inputSchema: { type: 'object', properties: {} },
    },
    {
      name: 'repo_deps',
      description: 'Summarize dependency graph and circular deps.',
      inputSchema: { type: 'object', properties: {} },
    },
    {
      name: 'repo_deadcode',
      description: 'Summarize unused files/exports using knip/ts-prune if available.',
      inputSchema: { type: 'object', properties: {} },
    },
    {
      name: 'git_changed',
      description: 'Summarize changed files against current base.',
      inputSchema: { type: 'object', properties: {} },
    },
    {
      name: 'git_diff_summary',
      description: 'Compact diff summary using git diff --stat and selected hunks.',
      inputSchema: {
        type: 'object',
        properties: {
          path: { type: 'string' },
          maxLines: { type: 'number', default: 200 },
        },
      },
    },
    {
      name: 'test_run',
      description: 'Run allowlisted test/build/typecheck/lint commands.',
      inputSchema: {
        type: 'object',
        properties: {
          command: { type: 'string' },
          filter: { type: 'string' },
          maxOutputLines: { type: 'number', default: 200 },
        },
      },
    },
    {
      name: 'test_failures',
      description: 'Run tests/typecheck and extract only failing test names and errors.',
      inputSchema: {
        type: 'object',
        properties: {
          command: { type: 'string' },
          maxFailures: { type: 'number', default: 10 },
        },
      },
    },
    {
      name: 'pg_schema',
      description: 'Read-only Postgres schema inspection via DATABASE_URL or PG* env vars.',
      inputSchema: {
        type: 'object',
        properties: {
          schema: { type: 'string' },
        },
      },
    },
    {
      name: 'pg_explain',
      description: 'Run EXPLAIN (FORMAT JSON) only for SELECT queries.',
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
      description: 'List recent SCCE trace files from trace directory.',
      inputSchema: {
        type: 'object',
        properties: {
          limit: { type: 'number', default: 20 },
        },
      },
    },
    {
      name: 'scce_trace_read',
      description: 'Read JSONL trace events and return compact filtered events.',
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
  const a = args ?? {};
  try {
    switch (name) {
      case 'repo_shape':
        return { content: [{ type: 'text', text: await handleRepoShape() }] };
      case 'repo_files':
        return { content: [{ type: 'text', text: await handleRepoFiles(a as any) }] };
      case 'repo_search':
        return { content: [{ type: 'text', text: await handleRepoSearch(a as any) }] };
      case 'repo_symbol':
        return { content: [{ type: 'text', text: await handleRepoSymbol(a as any) }] };
      case 'repo_callsites':
        return { content: [{ type: 'text', text: await handleRepoCallSites(a as any) }] };
      case 'repo_routes':
        return { content: [{ type: 'text', text: await handleRepoRoutes() }] };
      case 'repo_deps':
        return { content: [{ type: 'text', text: await handleRepoDeps() }] };
      case 'repo_deadcode':
        return { content: [{ type: 'text', text: await handleRepoDeadCode() }] };
      case 'git_changed':
        return { content: [{ type: 'text', text: await handleGitChanged() }] };
      case 'git_diff_summary':
        return { content: [{ type: 'text', text: await handleGitDiffSummary(a as any) }] };
      case 'test_run':
        return { content: [{ type: 'text', text: await handleTestRun(a as any) }] };
      case 'test_failures':
        return { content: [{ type: 'text', text: await handleTestFailures(a as any) }] };
      case 'pg_schema':
        return { content: [{ type: 'text', text: await handlePgSchema(a as any) }] };
      case 'pg_explain':
        return { content: [{ type: 'text', text: await handlePgExplain(a as any) }] };
      case 'scce_trace_list':
        return { content: [{ type: 'text', text: await handleTraceList(a as any) }] };
      case 'scce_trace_read':
        return { content: [{ type: 'text', text: await handleTraceRead(a as any) }] };
      case 'scce_answer_trace':
        return { content: [{ type: 'text', text: await handleAnswerTrace(a as any) }] };
      default:
        return { content: [{ type: 'text', text: JSON.stringify({ error: 'Unknown tool' }) }], isError: true };
    }
  } catch (error) {
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