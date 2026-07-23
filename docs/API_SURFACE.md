# API Surface

Current package and command boundary. Package manifests, `package.json`, and the exported source remain authoritative if this document drifts.

## Root verification and runtime scripts

- `pnpm build` builds kernel, Node adapters, UI, server, CLI, and VS Code packages.
- `pnpm test` runs the repository's configured test and source-integrity checks.
- `pnpm validate` runs the configured build and repository validation gate.
- `pnpm rehearsal:postgres` runs a disposable-schema lifecycle/migration rehearsal against configured PostgreSQL.
- `pnpm rehearsal:adapter` runs the adapter against a synthetic disposable PostgreSQL corpus and verifies the ingestion, citation, and trace path.
- `pnpm runtime:authority-matrix` runs the six-authority hydrated runtime matrix against a disposable PostgreSQL schema and writes its bounded report under `.tmp`.
- `pnpm cognition:gate` runs the focused cognition checks and the hydrated authority matrix; a missing PostgreSQL prerequisite is reported separately from an internal check failure.
- `pnpm vscode:package` creates the local VSIX artifact; `pnpm vscode:test:host` installs that VSIX into an isolated profile and runs the bounded extension-host smoke test.
- `pnpm scce`, `pnpm server`, and `pnpm scce:server` start the built CLI or server surfaces. Normal server startup binds before background warmup; `GET /api/ready` reports database readiness. `SCCE_STARTUP_WARMUP_STRICT=1` restores a pre-listen warmup gate.
- `pnpm mcp:build` and `pnpm mcp:start` build or run the bounded developer MCP server.
- `pnpm repo:shape`, `repo:search`, `repo:deps`, `repo:cruise`, `repo:dead`, `repo:exports`, and `repo:docs` are developer inspection commands.

## Package APIs

The kernel, adapters, UI, server, and CLI are ESM packages with built output under `dist`. The VS Code extension is a CommonJS extension-host package.

### `@scce/kernel`

The source-neutral cognitive runtime includes evidence, graph/hyperedge types, alpha normalization, directed PPR/PowerWalk, support and relation-potential contracts, the learned turn-requirement field, 17 cognitive operators, proposal/claim-basis planning, candidate/judge/proof/Mouth boundaries, one bounded low-support recovery transition, answer revision, brain lifecycle types, exact-byte workspace snapshots, and content-addressed patch plans. Low-support recovery can learn from eligible local state or use configured search/fetch, but returned material must pass canonical typed ingestion before replanning. Different-title evidence can pass source anchoring only when a request-matched semantic frame explicitly carries that evidence ID; a body-text mention alone is not an anchor.

After one exhausted acquisition attempt, the current user policy licenses a terminal creative continuation for an under-supported factual or reasoned turn only through an admitted `learned_continuation` or `learned_structural_composition` realization with nonempty `sourcePieceIds`, bounded repetition, novel non-request material, and passing non-echo, risk, and unsupported-fact gates. Structural composition records exact request-owned code-point and UTF-8 byte spans plus source-activation IDs; those spans are constraints, not evidence. The selected claims carry `invented` claim basis, have zero evidence references, carry `generated_not_evidence` provenance, and cannot receive factual certification. Empty connector, graph, and language state is not eligible for invention; the planner instead selects a non-assertive answer limited to source-derived material. Mouth realizes the selected semantic values from learned language memory and permitted source-bound surfaces and keeps proof/control identifiers out of answer prose.

`projectRequestAuthority` is the shared requirement-field projection used by the kernel and source-only runtime; its six authority scores are explicitly uncalibrated routing energies, and an explicit structured authority remains a traced override. `createSourceOnlyScceRuntime` is the named in-memory source-only factory; `createScceRuntime` currently aliases it. Its exported ProgramGraph conversion primitive structurally accepts a trusted internal hydrated full-file graph only with exact-base repair lineage, current live absence observations, and a linked candidate test. It does not authenticate caller metadata, establish semantic correctness, or execute the candidate test; `regressionProtection` remains `0` until execution evidence exists. It has no external runtime dependency.

### `@scce/adapters-node`

- Dependencies: `@scce/kernel`, `pg`, `mammoth`, `typescript`, and the locally vendored SheetJS CE 0.20.3 archive.
- Storage: `PostgresStorageAdapter` with schema v12 lifecycle enforcement.
- Runtime: `NodeScceRuntime` and hydration/import/corpus adapters. A non-empty `SCCE_DATABASE_URL` overrides `database.url` while configuration is loaded, allowing the PostgreSQL secret to stay outside `scce.config.json`. The server does not run schema migration automatically; run `pnpm scce db migrate` before startup for the exact checkout.
- Workspace: `WorkspaceRuntime`, filesystem inspection, exact-byte durable-revision verification, content-addressed patch-plan generation and execution, source-proven unused type-only import repair, and official TypeScript LanguageService code fixes. Compiler fixes use only durable snapshot files plus the TypeScript standard library. The source-observed direct `tsc` invocation must resolve an exact snapshot project config and include the sole requested diagnostic file. Structured positive integer `diagnosticCodes` (`--diagnostic-code=<integer>` in the CLI) must scope the compiler candidates to one action; request prose is never a selector. That compiler-owned action may include up to 32 affected files and 128 exact text changes as one transaction, including `.ts`, `.tsx`, `.mts`, `.cts`, `.js`, `.jsx`, `.mjs`, or `.cjs` creation under an existing snapshot directory. Command-bearing actions, implicit or ambiguous selection, paths outside the workspace, stale or absent replacement bases, and creation outside an existing directory are rejected. Validation uses the default trusted-host provider or the optional server-selected digest-pinned Docker provider.
- Connectors: `ConfiguredConnectorAdapter` under configured policy.
- Spreadsheet extraction accepts `.xlsx`, `.xlsm`, and `.xls` through the bounded child-process ingestion lane. Formula results are stored workbook values marked unverified; formulas are not evaluated, and macros/external links/embedded objects are not executed or resolved. See [Spreadsheet Ingestion Contract](SPREADSHEET_INGESTION_CONTRACT.md).

### `@scce/server`

Depends on kernel, Node adapters, and UI. It exposes the route manifest and the HTTP runtime. `POST /api/workspace/patch/plan` is non-mutating: it accepts only the strict `yopp.workspace-patch-plan-request.v1` body, verifies the latest durable workspace against exact current bytes, and returns an unauthorized, unexecuted review plan. The `yopp.*` schema prefix is retained as a wire-compatibility identifier for SCCE. `POST /api/workspace/patch/plan/request` is also strict and non-mutating. It supports the proven unused type-only import removal and official TypeScript LanguageService fixes when structured positive integer `diagnosticCodes` resolve to one action rooted at the sole requested existing target; request prose never selects a compiler candidate. The complete selected action may replace multiple exact snapshot files or create bounded TypeScript/JavaScript source files under existing directories, subject to the 32-file and 128-text-change limits. The LanguageService is bound to exact durable snapshot bytes and an exact project config resolved from the source-observed direct `tsc` invocation. Missing or unbound configs and requested files outside the parsed project are rejected. The route requires source-observed build/test commands; command-bearing actions and unsupported feature synthesis are rejected. Plans require compiler, typecheck, and test validation and do not authorize or execute it. `POST /api/workspace/patch` is the separate, disabled-by-default application boundary requiring mutation policy and capability approval. Project/report GET handlers persist records and are declared mutating in the manifest.

### `@scce/cli`

Depends on kernel and Node adapters. It exposes runtime, corpus, workspace, project, report, inspection, and hygiene commands through `dist/index.js`.

### `@scce/ui`

Workbench rendering/model code used by the local server.

### SCCE for VS Code (`yopp-vscode` compatibility package ID)

Local loopback client for the existing server lane. It provides readiness, workspace ingestion/questions/status, project summaries, persisted task state, SecretStorage authentication, and reviewed patch application. The packaged VSIX has been installed in an isolated VS Code 1.96.4 profile; that host activated it, observed its commands, and called `GET /api/ready`. The smoke test does not cover visual layout, restart recovery, or a live patch transaction. The extension does not invoke a model or provide an OS sandbox.

### `tools/scce-dev-mcp`

Bounded read/diagnostic tools for repository shape/search/symbols/callsites/routes/dependencies, git summaries, targeted tests, PostgreSQL schema/explain, and trace inspection. It does not expose arbitrary shell execution.
