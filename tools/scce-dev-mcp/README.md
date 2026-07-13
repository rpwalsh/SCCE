# SCCE Developer MCP

Local MCP server for bounded repository inspection, trace analysis, test execution,
and PostgreSQL diagnostics.

## Build

- `pnpm -C tools/scce-dev-mcp install`
- `pnpm -C tools/scce-dev-mcp build`

The build creates `tools/scce-dev-mcp/dist/` locally. That generated directory is not a committed or prebuilt release artifact.

## Start

- `pnpm --dir tools/scce-dev-mcp start`

## Client configuration

```toml
[mcp_servers.scce-dev]
command = "node"
args = ["tools/scce-dev-mcp/dist/index.js"]
```

Adapt the configuration shape to the MCP client in use.

## Tools

- repo_shape
- repo_files
- repo_search
- repo_symbol
- repo_callsites
- repo_routes
- repo_deps
- repo_deadcode
- git_changed
- git_diff_summary
- test_run
- test_failures
- pg_schema
- pg_explain
- scce_trace_list
- scce_trace_read
- scce_answer_trace

The tool set is bounded and does not expose arbitrary shell execution. Use it for
discovery and diagnosis, then verify changes with targeted tests and `pnpm validate`.
