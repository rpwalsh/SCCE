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

For a global Codex registration, use an absolute path so startup does not depend on
the directory from which Codex was launched:

```powershell
codex mcp add scce-dev -- node <absolute-repository-path>\tools\scce-dev-mcp\dist\index.js
codex mcp list
```

Equivalent `config.toml`:

```toml
[mcp_servers.scce-dev]
command = "node"
args = ["<absolute-repository-path>/tools/scce-dev-mcp/dist/index.js"]
cwd = "<absolute-repository-path>"
```

Restart the Codex client after changing MCP configuration. The server treats its
configured working directory as the repository root.

## Tools

- repo_shape
- repo_files
- repo_search
- repo_read
- repo_edit
- repo_create
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

## Coding workflow

1. Locate code with `repo_symbol` or `repo_search`. Symbol and call navigation parse TypeScript/JavaScript syntax, return exact positions and suggested read ranges, and do not claim cross-file semantic resolution. Implementations sort before imports.
2. Read source and relevant tests with `repo_read`. Responses include the file's SHA-256 and a continuation cursor. Read pages are limited to 300 lines and 16 KiB; a changed file invalidates its cursor.
3. Apply `repo_edit` with that SHA-256 and exact, unique `before`/`after` replacements. Stale hashes, overlapping or ambiguous replacements leave the file unchanged. Use `repo_create` for a new file in an existing directory; an existing file is never overwritten.
4. Call `test_run` with an allowed `commandId` and a targeted `filter` when supported. A proposed edit or a statement that tests will run is not a test result. Inspect the real exit code, fix failures, and rerun the targeted check.

`repo_shape` returns the allowed build/test scripts and points to `package.json` for the full script list. Source tools preserve UTF-8 and line endings, cap files at 2 MiB, and reject credential paths, administrative directories, and symlink/junction traversal.
