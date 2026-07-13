# API Surface

Current package and command boundary. Package manifests, `package.json`, and the exported source remain authoritative if this document drifts.

## Root verification and runtime scripts

- `pnpm build` builds kernel, Node adapters, UI, server, CLI, and VS Code packages.
- `pnpm test` runs the complete Vitest suite, the sealed-kit tests, the hidden-model scan, and test-inventory generation.
- `pnpm validate` runs the build, complete test command, and sealed-kit structure/schema verification.
- `pnpm rehearsal:postgres` runs a disposable-schema lifecycle/migration rehearsal against configured PostgreSQL.
- `pnpm rehearsal:adapter` runs the production JSONL adapter against a synthetic disposable PostgreSQL corpus and verifies exact citations and evaluation traces.
- `pnpm calibration:evaluate --input <observations.json|jsonl> --dataset-id <immutable-id>` fits and evaluates a source-group-disjoint calibration holdout from caller-supplied observations. It does not ship a representative dataset or result.
- `pnpm load:gate --prompts <prompts.json|jsonl> --workload-id <immutable-id>` measures a caller-supplied workload against a running server. Its report is explicitly `local_client_observation_not_independent_capacity_attestation`, not a capacity claim.
- `pnpm vscode:package` creates the local VSIX artifact; `pnpm vscode:test:host` installs that VSIX into an isolated profile and runs the bounded extension-host smoke test.
- `pnpm eval:*` exposes sealing, execution, blinding, citation, scoring, aggregation, and ablation commands. Their existence is not evidence that a protected public review ran.
- `pnpm scce`, `pnpm server`, and `pnpm scce:server` start the built CLI or server surfaces.
- `pnpm mcp:build` and `pnpm mcp:start` build or run the bounded developer MCP server.
- `pnpm repo:shape`, `repo:search`, `repo:deps`, `repo:cruise`, `repo:dead`, `repo:exports`, and `repo:docs` are developer inspection commands.

## Package APIs

The kernel, adapters, UI, server, and CLI are ESM packages with built output under `dist`. The VS Code extension is a CommonJS extension-host package.

### `@scce/kernel`

The source-neutral cognitive runtime: evidence, graph/hyperedge types, alpha normalization, directed PPR/PowerWalk, support and relation-potential contracts, the learned turn-requirement field, 17 cognitive operators, proposal/claim-basis planning, candidate/judge/proof/Mouth boundaries, bounded answer revision, evaluation conditions/traces, brain lifecycle types, exact-byte workspace snapshots, and content-addressed patch plans. Its exported ProgramGraph conversion primitive structurally accepts a trusted internal hydrated full-file graph only with exact-base repair lineage, current live absence observations, and a linked candidate test. It does not authenticate caller metadata, establish semantic correctness, or execute the candidate test; `regressionProtection` remains `0` until execution evidence exists. It has no external runtime dependency.

### `@scce/adapters-node`

- Dependencies: `@scce/kernel`, `pg`, `mammoth`, `typescript`, and the locally vendored SheetJS CE 0.20.3 archive.
- Storage: `PostgresStorageAdapter` with schema v12 lifecycle enforcement.
- Runtime: `NodeScceRuntime` and hydration/import/corpus adapters.
- Workspace: `WorkspaceRuntime`, filesystem inspection, exact-byte durable-revision verification, content-addressed patch-plan generation and execution, default trusted-host validation, and optional server-selected digest-pinned Docker validation.
- Connectors: `ConfiguredConnectorAdapter` under configured policy.
- Spreadsheet extraction accepts `.xlsx`, `.xlsm`, and `.xls` through the bounded child-process ingestion lane. Formula results are stored workbook values marked unverified; formulas are not evaluated, and macros/external links/embedded objects are not executed or resolved. See [Spreadsheet Ingestion Contract](SPREADSHEET_INGESTION_CONTRACT.md).

### `@scce/server`

Depends on kernel, Node adapters, and UI. It exposes the route manifest and the HTTP runtime. `POST /api/workspace/patch/plan` is non-mutating: it accepts only the strict `yopp.workspace-patch-plan-request.v1` body, verifies the latest durable workspace against exact current bytes, and returns an unauthorized, unexecuted review plan. `POST /api/workspace/patch/plan/request` is also strict and non-mutating, but no successful production coding family is demonstrated. A generic existing-module request fails closed with `422` because the generated ProgramGraph lacks verified repair lineage. `POST /api/workspace/patch` is the separate, disabled-by-default application boundary requiring mutation policy and capability approval. Project/report GET handlers persist records and are declared mutating in the manifest.

### `@scce/cli`

Depends on kernel and Node adapters. It exposes runtime, corpus, workspace, project, report, inspection, and hygiene commands through `dist/index.js`.

### `@scce/ui`

Workbench rendering/model code used by the local server.

### `yopp-vscode`

Local loopback client for the existing server lane. It provides readiness, workspace ingestion/questions/status, project summaries, persisted task state, SecretStorage authentication, and reviewed patch application. The packaged VSIX has been installed in an isolated VS Code 1.96.4 profile; that host activated it, observed its commands, and called `GET /api/ready`. The smoke test does not cover visual layout, restart recovery, or a live patch transaction. The extension does not invoke a model or provide an OS sandbox.

### `tools/scce-dev-mcp`

Bounded read/diagnostic tools for repository shape/search/symbols/callsites/routes/dependencies, git summaries, targeted tests, PostgreSQL schema/explain, and trace inspection. It does not expose arbitrary shell execution.
