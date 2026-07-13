# SCCE Source Map

Status: targeted current-source map; not a generated completeness or readiness claim

## Workspace

- Root package: `scce-v3`, pnpm 10.28.2, Node.js/TypeScript/PostgreSQL.
- `packages/kernel` (`@scce/kernel`): pure cognitive/runtime contracts.
- `packages/adapters-node` (`@scce/adapters-node`): PostgreSQL, filesystem,
  ingestion, hydration, validation, and workspace adapters.
- `packages/ui` (`@scce/ui`): workbench models and surfaces.
- `packages/server` (`@scce/server`): local HTTP API and workbench server.
- `packages/cli` (`@scce/cli`): local CLI.
- `packages/vscode` (`yopp-vscode`): local-loopback VS Code extension.

The root `build` script compiles all six packages. PostgreSQL's `pg` client and document
parsers belong to the adapter package rather than the root. The adapter package resolves
the vendored SheetJS CE 0.20.3 archive and runs `.xlsx`, `.xlsm`, and `.xls` extraction in
the bounded spreadsheet child process; formulas are preserved but never evaluated.

## One-Lane Runtime Spine

```text
packages/adapters-node/src/config.ts
-> packages/adapters-node/src/runtime.ts
-> packages/kernel/src/kernel.ts
-> evidence / typed ingest
-> graph and field
-> routing / proof / slot plan
-> packages/kernel/src/mouth.ts
-> answer and trace
```

PostgreSQL is the canonical durable store, but cognition is not implemented as broad
SQL text search. There is no second external-model, hosted-inference, or prompt-stuffing
answer lane.

## Kernel Map

### Runtime And Graph Math

- `kernel.ts`: `ScceKernel` ingest, train, turn, replay, inspect, benchmark, evaluation
  condition boundaries, and normal runtime orchestration.
- `alpha.ts`: configured or empirical Type-7 alpha thresholds with normalization
  diagnostics. Empirical values are current-slice relative, not calibrated confidence.
- `field.ts`: graph-field activation and optional relation-potential consumption.
- `ppf.ts`: directed personalized PageRank/Perron-Frobenius ranking with explicit
  relation policy and convergence traces.
- `powerwalk.ts`: deterministic second-order PowerWalk and production query-conditioned
  PPMI seed expansion.
- `powerwalk-ppmi.ts`: sparse PPMI representation and partition-bound incremental state.
- `relation-potential.ts`: source-neutral edge projection, three-way-disjoint fitting,
  Platt calibration, holdout metrics, and strict content-addressed model validation.
- `graph-analytics.ts`, `causal*.ts`, `ccr.ts`: additional graph and causal analysis.

PowerWalk thresholds/scale and broad runtime scoring remain provisional. Relation
potential is identity-unconfigured unless a valid frozen model is supplied; the repo
does not yet ship a representative production-trained model.

### Evidence, Proof, And Answer

- `evidence.ts`, `typed-ingest.ts`: source/version/span preservation and typed
  observations.
- `candidate.ts`, `judge.ts`, `question-slot-planner.ts`: candidate and answer-plan
  selection.
- `semantic-proof-engine.ts`, `semantic-proof-system.ts`, `proof-calculus.ts`,
  `proof-carrying-answer.ts`: support, contradiction, truth state, and certification.
- `mouth.ts`, `surface-realizer.ts`, `answer-emitter.ts`,
  `walsh-surface-energy.ts`: constrained surface realization and final admissibility.
- `evaluation-flags.ts`: the eleven isolated evaluation conditions.

The mouth realizes selected material. It must not manufacture facts, evidence spans,
citations, trace stages, or certainty.

### Language, Learning, And Code

- `language-memory-runtime.ts`, `kneser-ney.ts`, `ngram-prose.ts`: local learned
  language priors and realization support.
- `multilingual-translation.ts`, `localization*.ts`, `correction-memory.ts`: source-
  derived multilingual labels, translation plans, and corrections.
- `training-orchestrator.ts`, `learning*.ts`: promotion and local learning contracts.
- `developer-intelligence.ts`, `source-code-graph.ts`, `code-learning.ts`,
  `program*.ts`: repository evidence, code graph, planning, and program artifacts.
- `patch-transaction.ts`: immutable, content-addressed create/replace/delete plan and
  deterministic receipt contracts.

## Node Adapter Map

- `postgres.ts`: schema migration/verification and durable stores. Current schema
  version is 12. Brain activation is READY-only and transactional; a partial unique
  index enforces at most one ACTIVE lifecycle row.
- `runtime.ts`, `config.ts`, `secrets.ts`: runtime construction, strict configuration,
  and redaction.
- `document.ts`, `files.ts`, `wikipedia-v3-ingestor.ts`, `scce2/*`,
  `hydration-runtime.ts`: bounded source ingestion and brain import.
- `workspace-runtime.ts`, `repo-intelligence-folder.ts`, `code-graph.ts`: workspace
  inspection and source-backed project context.
- `workspace-patch-transaction.ts`: containment, symlink defense, CAS, staging,
  atomic-per-file commit, and verified rollback.
- `structured-patch-validation.ts`: trusted-host, shell-free, bounded validation contract.
- `docker-sandbox-patch-validation.ts`: optional server-selected, digest-pinned Docker
  validation with networkless source execution and recorded resource bounds.

The server's default `trusted-host-pnpm-validate.v1` policy is not an OS sandbox. It
runs repository validation with the server process's host authority and is unsuitable
for code that is untrusted with that authority. The optional Docker provider passed a
local pinned-image networkless smoke test. The Docker daemon, operator, image supply
chain, and host kernel remain trusted; the test is not attestation or independent
review evidence.

## Server, VS Code, And Tooling

- `packages/server/src/routes.ts`: API routes, including the strict but incomplete
  coding-request boundary, exact-byte planning, and separately authorized
  `POST /api/workspace/patch`. The generic existing-module coding request fails closed
  with `422` because its generated ProgramGraph lacks verified repair lineage.
- `packages/vscode/src/extension.ts`: readiness, ingest, question, project, status,
  task timeline, explicit approvals, reviewed patch application, and receipt checks.
- `tools/scce-dev-mcp`: bounded repository, test, and trace inspection helpers.
- `tools/sealed-eval`: sealed evaluation harness, trace/citation verification, and the
  normal-runtime production JSONL adapter.
- `tools/no-hidden-model-check.mjs`: static dependency/import/endpoint integrity scan.
- `tools/live-postgres-rehearsal.mjs`, `tools/live-adapter-rehearsal.mjs`: synthetic
  disposable-schema integration rehearsals.
- `tools/calibration-holdout.mjs`: caller-supplied source-group-disjoint calibration
  evaluation with a limited claim boundary.
- `tools/runtime-load-gate.mjs`: caller-supplied local-client workload measurement.

The packaged VSIX was installed in an isolated VS Code 1.96.4 profile. The host
activated it, observed its command registrations, and called `GET /api/ready`; visual
layout, restart recovery, and a live patch transaction remain unverified.

## Root Commands

```powershell
pnpm build
pnpm test
pnpm validate
pnpm repo:shape
pnpm repo:search
pnpm repo:deps
pnpm rehearsal:postgres
pnpm rehearsal:adapter
pnpm calibration:evaluate --input <observations.json|jsonl> --dataset-id <immutable-id>
pnpm load:gate --prompts <prompts.json|jsonl> --workload-id <immutable-id>
pnpm vscode:package
pnpm vscode:test:host
pnpm mcp:build
pnpm mcp:start
```

Run only scripts that remain present in `package.json`. `pnpm validate` is the complete
local gate; it does not execute the protected public-review procedure.

## Current Boundaries

- Public review status is `NOT_EXECUTED`.
- Calibration infrastructure is broader than deployed representative calibration.
- The PostgreSQL rehearsals remain unexecuted in the current release record because
  no database password was configured.
- Local smoke tests and synthetic rehearsals do not prove broad corpus behavior, production security,
  clean-machine reproducibility, or independent results.
- Trusted-host staging is not OS isolation; optional Docker isolation retains its
  documented daemon/operator/image/host-kernel trust boundary.
- This source map does not establish broad runtime quality or production readiness.
