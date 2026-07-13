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
non-mutating. No successful production coding family is currently demonstrated. A
generic existing-module request fails closed with `422` because the generated
ProgramGraph lacks verified repair lineage.

The exported kernel primitive can structurally convert a trusted internal hydrated
full-file ProgramGraph only when it includes exact-base repair lineage, current live
absence observations, and a linked candidate test. It cannot authenticate
caller-supplied lineage or evidence metadata, establish semantic correctness, or
claim that the candidate test ran. `regressionProtection` remains `0` until execution
evidence is attached. The HTTP route does not close those production provenance and
execution gaps.

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
content-addressed filesystem transactions. The exported ProgramGraph converter is a
structural primitive for trusted internal inputs, not a completed production coding
path. The HTTP coding-request route has not demonstrated successful repair planning
for a generic existing module, and neither boundary proves semantic correctness.

Large files are bounded by configured byte limits. The runtime is designed for normal local repositories and document folders on consumer hardware; internet-scale streams still belong to the dedicated SCCE2/wiki ingestion paths.
