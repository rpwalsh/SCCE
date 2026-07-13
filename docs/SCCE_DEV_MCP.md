# SCCE Developer MCP

Local developer MCP server for compatible coding tools.

Build

* `pnpm mcp:build`
* `pnpm -C tools/scce-dev-mcp install`

Start

* `pnpm mcp:start`
* `pnpm mcp:dev` for watch mode

Example client config

```toml
[mcp_servers.scce-dev]
command = "node"
args = ["tools/scce-dev-mcp/dist/index.js"]
```

Windows note

* The server uses the standard MCP stdio transport.

Tools

* repo_shape, repo_files, repo_search, repo_symbol, repo_callsites
* repo_routes, repo_deps, repo_deadcode
* git_changed, git_diff_summary
* test_run, test_failures
* pg_schema, pg_explain
* scce_trace_list, scce_trace_read, scce_answer_trace

Scope

* Results are bounded and structured for low-token diagnosis.
* The server is read/diagnostic oriented and does not expose arbitrary shell execution.
* MCP success does not substitute for `pnpm validate`, PostgreSQL rehearsals, or sealed evaluation evidence.
