# SCCE Architecture Map

Status: unfinished local runtime with implemented paths; representative calibration and independent review remain incomplete
This document maps the current source tree. It does not certify production readiness or broad runtime quality.

## One-Lane Runtime

```text
scce.config.json
-> packages/adapters-node/src/config.ts
-> packages/adapters-node/src/runtime.ts
-> packages/kernel/src/kernel.ts
-> source evidence / typed observations
-> graph and hypergraph slice
-> alpha-normalized field
-> directed PPR and PowerWalk-assisted activation
-> learned turn-requirement field and cognitive operators
-> cognitive proposals with per-claim bases
-> requirement-aware candidate/judge selection, proof, contradiction, and slot planning
-> packages/kernel/src/mouth.ts
-> bounded answer revision
-> traceable answer and durable turn events
```

There is one cognitive runtime, one ingest/training path, one mouth path, and one
canonical durable-store contract. There is no external-model, hosted-inference,
prompt-stuffing, or SQL-text-search fallback lane. PostgreSQL is the canonical durable
store; graph reasoning occurs in the kernel rather than in broad text queries.

Configuration is read from `scce.config.json`. Runtime database configuration is not
silently discovered from process environment variables.

## Math Placement And Current Contract

- `packages/kernel/src/alpha.ts`: relation-strength normalization and alpha trace.
  Without configured thresholds it uses deterministic Hyndman-Fan Type-7 quantiles
  over the active slice. Those thresholds are slice-relative, not globally calibrated
  probabilities. Empty and degenerate samples are explicit trace modes.
- `packages/kernel/src/ppf.ts`: sparse directed personalized PageRank/Perron-Frobenius
  iteration. Every relation has an explicit `directed`, `reversible`, or
  `learned_inverse` policy; the runtime does not synthesize reverse edges. Convergence
  and bounded transition/restart contributions are traceable, and a dense linear
  oracle exists for tests.
- `packages/kernel/src/powerwalk.ts` and `powerwalk-ppmi.ts`: deterministic
  second-order walks, pair-disjoint training/validation partition identity, sparse PPMI
  representations, and query-anchor cosine expansion into production field seeds.
  Zero-context nodes receive no invented fallback representation. Current expansion
  thresholds and scale remain uncalibrated, and durable incremental-state loading is
  not yet established.
- `packages/kernel/src/relation-potential.ts`: source-neutral graph-edge features,
  coefficient fitting, Platt calibration, and evaluation metrics on three disjoint
  datasets: coefficient training, calibration fit, and evaluation holdout. The frozen,
  content-addressed model is consumed by the production field when configured. No
  representative production model has been fitted, so the default path is an explicit
  identity-unconfigured mode.
- `packages/kernel/src/proof-carrying-answer.ts`, `semantic-proof-engine.ts`, and
  `semantic-proof-system.ts`: proof, evidence, truth-state, and contradiction handling.
- `packages/kernel/src/turn-requirements.ts`: a 16-dimensional requirement field
  derived from learned frame, pattern, phrase-unit, dialogue-move, and construct
  activations plus optional structured requirements. It activates 17 stable cognitive
  operators without an English command-verb router. The bundled coefficient models
  are explicitly `uncalibrated_bootstrap`.
- `packages/kernel/src/cognitive-planner.ts`: bounded proposals containing typed
  claims, relations, steps, artifacts, evidence/prior identities, requirement
  coverage, operator support, and per-claim bases. Reasoning, invention, and MMR
  weights are provisional bootstrap estimators.
- `packages/kernel/src/candidate.ts` and `judge.ts`: proposal-aware candidate
  construction and requirement-conditioned selection. Unsupported attribution, test
  weakening, telemetry-as-answer, unreceipted action results, and failed executable
  validation are hard failures rather than score tradeoffs.
- `packages/kernel/src/mouth.ts` and `surface-realizer.ts`: realization of selected
  material. The mouth does not get authority to manufacture facts or citations.
- `packages/kernel/src/answer-revision.ts`: a typed critic/revision boundary capped at
  two rounds. A revision must improve measured quality by at least `0.025` and retain
  citation, action-receipt, test-preservation, and non-telemetry invariants.

`kernel.turn` records the requirement field, operator activations, proposals, selected
candidate/Mouth state, and revision result as separate inspectable runtime artifacts.
Ordinary answer prose does not need to expose that telemetry.

## SCCE2 Import And Brain Lifecycle

```text
packages/cli/src/index.ts
-> packages/adapters-node/src/scce2/*
-> packages/adapters-node/src/scce2/scce2-to-v3-importer.ts
-> PostgreSQL brain_import_lifecycle
```

The SCCE2 bridge inspects loose shard directories and `.brain` bundles, records
bounded hashes and checkpoints, distinguishes learned priors from direct evidence,
and writes through the v3 storage contract. Learned priors can affect activation and
language but cannot certify a factual answer.

PostgreSQL schema version 12 is current. Brain lifecycle states are `CREATED`,
`IMPORTING`, `VALIDATING`, `READY`, `ACTIVE`, `STOPPED`, `FAILED`, `QUARANTINED`, and
`INCOMPATIBLE`. Activation is transactional and READY-only. A partial unique index
enforces at most one ACTIVE lifecycle row, and the v12 migration deterministically
repairs older duplicate-ACTIVE state before installing that constraint.

## Workspace Mutation Boundary

The kernel defines exact-byte workspace revision snapshots and content-addressed
`create`, `replace`, and `delete` plans in `workspace-plan-generator.ts` and
`patch-transaction.ts`. `POST /api/workspace/patch/plan` verifies the latest durable
workspace identity and every ingested file against current filesystem bytes, then
returns a reviewable plan with authorization false and execution not run. The endpoint
does not accept a root, command, approval, authorization, or execution state.

`POST /api/workspace/patch/plan/request` is strict and non-mutating, but no successful
production coding family is demonstrated. A generic existing-module request fails
closed with `422` because its generated ProgramGraph lacks verified repair lineage.
The exported kernel primitive can structurally convert a trusted internal hydrated
full-file ProgramGraph only when it carries exact-base repair lineage, current live
absence observations, and a linked candidate test. It cannot authenticate
caller-supplied lineage or evidence metadata, prove semantic correctness, or claim
test execution. `regressionProtection` remains `0` until execution evidence exists.

`POST /api/workspace/patch` is the separate mutation boundary. The Node adapter
performs containment, symlink, compare-and-swap, staging, verification,
atomic-per-file mutation, and verified reverse-order rollback checks. Application
requires mutation policy plus the existing capability approval; a plan alone grants
nothing. The server and VS Code package expose the reviewed application flow.

The default `trusted-host-pnpm-validate.v1` policy is deliberately named: it runs
repository validation with the server process's host authority. Staging is not an OS
sandbox and is unsuitable for code that is untrusted with that authority. The optional
server-selected Docker provider binds a digest-pinned image and resource policy to
approval and runs source validation without networking. A local live smoke test passed
that path; the Docker daemon, operator, image supply chain, and host kernel remain
trusted, and the result is neither attestation nor independent review. Multi-file
visibility is not globally atomic; the receipt truthfully reports
`atomic-per-file-with-verified-transaction-rollback`. See
`docs/PATCH_TRANSACTION_CONTRACT.md`.

## Product Surfaces

- `packages/cli`: local CLI.
- `packages/server`: HTTP API and workbench server.
- `packages/ui`: workbench model and surface code.
- `packages/vscode`: local-loopback VS Code extension for readiness, ingest, questions,
  project/status workflows, reviewed patch application, and receipt verification.
- `tools/scce-dev-mcp`: bounded local repository and trace inspection tools.
- `tools/sealed-eval`: sealed evaluation harness and production JSONL adapter.

The packaged VSIX was installed in an isolated VS Code 1.96.4 profile. The host
activated it, observed its registered commands, and reached `GET /api/ready`. Visual
layout, restart recovery, and a live patch round trip remain unverified; the smoke test
is not an independent end-to-end review.

## Large-Input And Deployment Boundaries

Workbook files (`.xlsx`, `.xlsm`, and legacy `.xls`) enter the same bounded file-ingest
lane through a child process using the vendored SheetJS CE archive. The adapter emits
sheet, cell, formula, merge, and A1 provenance as typed observations. It treats cached
formula results as unverified stored values and does not recalculate formulas or
execute macros, external links, or embedded objects.

SCCE2 n-gram and compatible graph material stream within byte/count/heap budgets, with
checkpoint, stop, resume, and lifecycle state. The calibration evaluator and runtime
load gate require caller-supplied data; no representative calibration or load record
is included. This does not yet prove representative large-corpus performance,
clean-machine reproduction, production isolation, or independent public review.
