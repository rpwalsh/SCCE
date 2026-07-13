# SCCE Debugging Guide

## Commands

```bash
pnpm build
pnpm test
pnpm validate
pnpm rehearsal:postgres
pnpm rehearsal:adapter
pnpm calibration:evaluate --input <observations.json|jsonl> --dataset-id <immutable-id>
pnpm load:gate --prompts <prompts.json|jsonl> --workload-id <immutable-id>
pnpm vscode:test:host
pnpm scce
pnpm server
pnpm mcp:build
pnpm mcp:start
```

## VS Code

The repository contains both debugger launch configurations and the separate `packages/vscode` SCCE extension. The extension is a loopback client for the existing server; it is not a second runtime.

The workspace debugger files define:

- `SCCE Server` - builds, then launches `packages/server/dist/index.js` with tracing.
- `SCCE CLI` - builds, then launches `packages/cli/dist/index.js turn <prompt>` with tracing.
- `SCCE Tests` - runs `pnpm test` with tracing.
- `MCP Server` - builds, then launches `tools/scce-dev-mcp/dist/index.js`.
- `Attach to Node process` - attaches to port `9229`.

Tracing is enabled only in these debug configs through:

```text
SCCE_TRACE=1
SCCE_TRACE_DIR=${workspaceFolder}/.scce/traces
```

## Trace Files

Trace files are JSONL under `.scce/traces` unless `SCCE_TRACE_DIR` overrides the path.

Useful MCP tools:

- `scce_trace_list` - list recent trace files.
- `scce_trace_read` - read compact filtered trace events.
- `scce_answer_trace` - summarize observed and missing stages.

Core stages:

- `trace.open` - trace file creation.
- `server.start` - server startup.
- `api.request` - incoming HTTP request.
- `api.response` - HTTP response sent.
- `runtime.error` - unhandled server request error.
- `cli.command.start` - CLI command dispatch.
- `cli.command.end` - CLI command completion.
- `turn.input` - bounded turn prompt preview and counts.
- `turn.runtime.start` - runtime turn call started.
- `turn.runtime.end` - runtime turn call completed.
- `runtime.start` - kernel turn execution started.
- `graph.resolve` - graph, evidence, retrieval, and field activation counts.
- `contradiction.check` - entailment, semantic proof, and contradiction summary.
- `proof.attach` - proof/evidence IDs attached to the turn.
- `candidate.score` - bounded candidate score summary.
- `planner.select` - selected candidate and bounded rejection reasons.
- `mouth.generate` - mouth realization completed.
- `turn.output` - bounded answer preview and counts.
- `turn.error` - turn failed before output.

## Coding-agent workflow

1. Run `pnpm repo:shape`, `pnpm repo:search`, and `pnpm repo:deps` before edits.
2. Use `repo_symbol`, `repo_callsites`, `repo_search`, `test_failures`, and `scce_trace_read` before opening large files.
3. Patch the smallest failing surface.
4. Run targeted verification, then `pnpm build` and `pnpm test`.

`pnpm test` is the complete local test gate: Vitest, sealed-kit tests, hidden-model scan, and inventory generation. `pnpm validate` additionally rebuilds all six packages and verifies kit structures/schemas. Live PostgreSQL rehearsals remain separate commands because they require configured PostgreSQL.

For patch failures, distinguish the boundaries:

- plan/hash/path/CAS failures: kernel patch contract or workspace transaction adapter;
- staged command failure: selected trusted-host or Docker validation provider;
- approval/policy failure: server route and approval session;
- IDE parsing/receipt mismatch: VS Code patch protocol.

Filesystem staging is not an OS sandbox. Do not run the trusted-host validator on code
that is untrusted with the server's host authority; the server keeps patch mutation
disabled unless `config.policy.allowMutation` is explicitly enabled. The optional
Docker provider is server-selected and ran a passing local networkless smoke test, but
the Docker daemon, operator, image supply chain, and host kernel remain trusted. Its
execution record is not attestation or independent review evidence.

Do not use broad source scans as cognition. Prefer focused repo tools, traces, and tests.
