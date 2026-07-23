# SCCE Workspace Runtime

The local workspace runtime provides project and corpus work through the existing SCCE lane: local files are inspected, indexed as workspace records, ingested through `kernel.ingest`, and persisted through PostgreSQL evidence, graph, language, and workspace tables.

## Initialize

```bash
pnpm scce workspace init C:\path\to\project
```

This creates an active workspace record with a deterministic workspace id and corpus id.

## Ingest

```bash
pnpm scce ingest C:\path\to\project
pnpm scce workspace ingest
```

Workspace ingestion scans the folder, hashes files in bounded chunks, skips default generated/dependency directories, compares content hashes with prior workspace file records, sends changed files through `kernel.ingest`, marks unchanged files as skipped, and marks missing files safely.

Default ignored directories include `.git`, `node_modules`, `dist`, `build`, `.next`, `coverage`, `.turbo`, `.cache`, and `.pnpm-store`.

## Supported Files

The runtime handles Markdown, plain text, JSON, JSONL/NDJSON, CSV, TSV, TypeScript, JavaScript, Python, SQL, HTML, CSS, YAML, package manifests, package locks, logs, and source-like text files. PDF and DOCX extraction remain available through configured document tools. `.xlsx`, `.xlsm`, and legacy `.xls` workbooks use the same bounded, child-process file-ingest lane and project sheets, cells, formulas, and A1 provenance into typed observations. Stored formula values are unverified and no formula, macro, external link, or embedded object is executed. See [Spreadsheet Ingestion Contract](SPREADSHEET_INGESTION_CONTRACT.md).

## Ask Questions

```bash
pnpm scce turn "Where is WidgetService defined?"
pnpm scce workspace ask "What routes exist?"
```

Workspace answers cite file/span evidence when the local project runtime can answer directly. Other turns continue through the normal SCCE kernel path.

## Project Commands

```bash
pnpm scce project summary
pnpm scce project map
pnpm scce project symbols
pnpm scce project gaps
pnpm scce project contradictions
pnpm scce project tasks
```

The commands produce cited summaries, module maps, symbol indexes, missing-support findings, doc/code contradictions, and prioritized engineering tasks.

## Plan a Coding Change

Build the repository and initialize and ingest the workspace before planning. `plan-code` is the canonical command; `code` is a compatibility alias.

```bash
pnpm scce workspace plan-code \
  --path=src/types.ts \
  --checks=typecheck \
  "Remove unused type import ExampleType from src/types.ts."
```

The command prints an unauthorized, unexecuted `yopp.workspace-plan-generation.v1` result. The `yopp.*` prefix is retained as a versioned compatibility identifier; the product surface is SCCE. Planning does not edit workspace files, approve or apply the returned transaction, or execute compiler, typecheck, or test commands. Before planning it analyzes the selected workspace and persists the normal project/workspace report metadata. Exact-byte planning still uses the previously ingested durable source records; run `pnpm scce workspace ingest` after local edits or the stale-byte check rejects the request.

The request surface is bounded:

- The request schema accepts one through 256 unique `--path=` values. The current
  TypeScript repair families require exactly one existing target. Paths must be
  NFC-normalized, slash-separated, workspace-relative paths of at most 1,024
  characters.
- Request text is limited to 20,000 UTF-8 bytes. Use `--` before the text when the request itself contains tokens beginning with `--`.
- `--checks=` accepts a non-empty subset of `compiler,typecheck,tests`. The default is all three. These values describe the plan's required validation; they do not run validation during planning. The narrow unused type-only import repair may explicitly use `--checks=typecheck`.
- `--validator=` accepts `trusted-host-pnpm-validate.v1` or `docker-pnpm-validate.v1` and defaults to trusted-host. It labels the validation plan only; request data does not select or configure an execution provider.
- Optional `--request-id=` values are limited to 256 characters. Without one, the CLI derives a deterministic ID from the workspace revision and complete request.
- `--root=` selects an allowed local workspace root. Project-analysis overrides are also bounded: `--max-files=` is 1 through 100,000, `--max-file-bytes=` is 1,024 through 67,108,864, `--max-depth=` is 0 through 256, and `--max-document-bytes=` is 4,096 through 67,108,864. `--no-unsupported` is also accepted.

Two TypeScript repair paths are tested: removing one source-proven unused binding from
a type-only import, and applying one official TypeScript LanguageService code fix to
one existing requested diagnostic file. Every compiler-action request must include a
structured positive integer diagnostic code (`--diagnostic-code=<integer>` in the CLI,
`diagnosticCodes` in the HTTP request) whose scope resolves to one candidate. Request
prose never selects a code action. LanguageService input is limited to
exact durable snapshot files plus the TypeScript standard library. Its source-observed
direct `tsc` invocation must resolve either an explicit `-p`/`--project` target or an
exact upward `tsconfig.json` from the command working directory. The config must be in
the snapshot and include the requested file. Source-observed build and test commands
are required. The complete selected CodeFixAction is preserved as one transaction and
may contain up to 32 affected files and 128 exact text changes. It may replace exact
snapshot files and create bounded TypeScript or JavaScript source files whose parent
directories already exist in the snapshot.
Plans remain unauthorized and unexecuted and require compiler, typecheck, and tests
unless the narrow unused-import contract explicitly requires typecheck only. The
command does not synthesize arbitrary features. Command-bearing actions, implicit or
ambiguous selection, paths outside the workspace, replacements without exact snapshot
bases, and creation outside existing workspace directories are rejected.

## Reports

```bash
pnpm scce brief
pnpm scce patch-plan
pnpm scce handoff
pnpm scce review
```

Reports are generated from extracted workspace evidence and persisted as workspace report records.

The `patch-plan` report is explanatory Markdown. It is not a `yopp.patch-transaction-plan.v1` and cannot authorize filesystem changes.

## API

The server exposes:

```text
POST /api/workspace/init
POST /api/workspace/ingest
GET  /api/workspace/sources
POST /api/workspace/ask
POST /api/workspace/outcome
POST /api/workspace/patch/plan
POST /api/workspace/patch/plan/request
POST /api/workspace/patch
GET  /api/project/summary
GET  /api/project/map
GET  /api/project/symbols
GET  /api/project/gaps
GET  /api/project/contradictions
GET  /api/project/tasks
GET  /api/reports/brief
GET  /api/reports/patch-plan
GET  /api/reports/handoff
GET  /api/reports/review
```

The project/report GET handlers currently persist workspace/report records and are therefore declared `mutates: true` in the route manifest despite their legacy HTTP verbs.

### Exact-byte patch planning

`POST /api/workspace/patch/plan` is a non-mutating planning boundary. It accepts the
strict `yopp.workspace-patch-plan-request.v1` schema: latest workspace ID and
`expectedWorkspaceUpdatedAt`, UTF-8 full-file proposals or deletions with expected
content hashes, requested paths, a caller-supplied proposal assessment and evidence
IDs, and the registered validation plan. It does not accept a filesystem root,
command, argument vector, approval, authorization, or execution state. Exact-byte
verification does not itself prove that the proposed content or cited evidence is
correct.

The adapter loads the latest durable workspace record, requires every source record to
be fully committed, reads each regular non-symlink file within the configured byte
bound, and compares its exact current SHA-256 identity with the durable ingest record.
It then builds a complete content-addressed revision snapshot and a deterministic
`yopp.patch-transaction-plan.v1`. Creation requires absence; replacement and deletion
require the caller's exact durable content hash. Line endings and UTF-8 bytes are part
of the plan identity. Any stale revision, missing or changed file, unsafe path, or test
weakening fails planning.

The response is review material only: authorization is false and execution is
`not_executed`. Generating a plan never mutates the workspace and never supplies the
authorization required by the application endpoint.

### Coding-request boundary

`POST /api/workspace/patch/plan/request` accepts a strict coding-request schema and is
non-mutating. It supports source-proven unused type-only import removal and official
TypeScript LanguageService fixes rooted at one existing requested target. Fix derivation is
bound to exact durable snapshot bytes; compiler context includes only those snapshot
files and the TypeScript standard library. The source-observed direct `tsc` invocation
must resolve an exact snapshot project config whose parsed file set includes the
requested target. Structured `diagnosticCodes` must scope the compiler candidates to
one action; request prose is never used as a selector. The complete selected action may close over as many as 32
files and 128 non-overlapping exact text changes. Existing targets must match the
snapshot; new targets are restricted to TypeScript/JavaScript source files in existing
snapshot directories. Command-bearing actions, out-of-workspace paths, stale or
missing replacement bases, invalid new-file targets, and overlapping changes are
rejected.

The route requires source-observed build and test commands and emits an unauthorized,
unexecuted plan whose validation contract requires compiler, typecheck, and tests.
Planning does not establish semantic correctness or claim that validation ran.
Requests for arbitrary feature synthesis or repairs outside the supported families
are rejected; `regressionProtection` remains `0` until execution evidence is attached.

### Reviewed patch application

`POST /api/workspace/patch` accepts only the exact latest persisted workspace ID, a content-addressed full-file transaction plan, and the registered validation-policy ID. It rejects client-supplied roots, executable names, argument vectors, extra fields, and edited hashes. The server derives the root, checks `runtime.allowedRoots`, requires `config.policy.allowMutation=true`, and uses the existing separate approval session before applying the exact request. Approval is bound to a server-computed hash of the complete validation policy and selected provider configuration, including the Docker image digest and resource/materialization bounds when Docker is selected.

The default `trusted-host-pnpm-validate.v1` policy creates a bounded private filesystem stage and invokes a server-owned argv with `shell:false`; it remains trusted-host execution. A server operator may instead select the optional Docker provider described in [the patch transaction contract](PATCH_TRANSACTION_CONTRACT.md). That provider materializes frozen dependencies from an explicit manifest-only input set, overlays source only after materialization succeeds, and runs validation in a dedicated network-disabled container. Its host-side snapshot buffer is independently bounded. Request data cannot select the provider, image, executable, network, resource limits, or arguments.

The VS Code extension can load and independently hash-check a reviewed transaction JSON file, show operation paths and hashes, complete both approvals, retry the exact request, and verify the returned receipt. Its packaged-host smoke test covers installation, activation, command registration, and readiness only; visual layout, restart recovery, and a live patch round trip remain unverified.

## Persistence

Workspace metadata is stored in:

```text
workspaces
workspace_source_files
workspace_reports
```

Source truth remains in the existing SCCE tables:

```text
source_versions
evidence_spans
graph_nodes
graph_edges
language_profiles
ngram_observations
ngram_models
ingestion_checkpoints
events
```

## Known Limits

The contradiction finder is structural and source-bound. It can catch missing documented commands/routes, conflicting document values, missing script paths, undocumented exports, missing test support, and likely unused exports. It is not a compiler, package resolver, or full formal verifier yet.

Markdown reports, line-oriented repair patches, and `safeToApplyInTemp` markers are not
content-addressed filesystem transactions. The exported ProgramGraph converter remains
a structural primitive for trusted internal inputs. The HTTP coding-request route has
tested exact-byte planning for unused type-only import removal and official
TypeScript LanguageService actions with bounded compiler-owned multi-file closure; it
is not an arbitrary feature-synthesis path. Neither boundary proves semantic
correctness.

Large files are bounded by configured byte limits. The runtime is designed for normal local repositories and document folders on consumer hardware; internet-scale streams still belong to the dedicated SCCE2/wiki ingestion paths.
