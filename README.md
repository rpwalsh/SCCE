# SCCE v3

SCCE is a TypeScript and Node.js implementation of the Self Contained Cognitive Engine: a local, graph-native runtime with PostgreSQL-backed durable state, evidence-aware answer construction, and developer tooling.

The repository is an active pre-release source tree. Implemented paths and passing local checks are evidence about specific engineering contracts; they are not production certification or a general-quality result. Public review status is `NOT_EXECUTED`.

## Runtime path

```text
source bytes
-> typed observations and evidence spans
-> graph edges and role-bearing hyperedges
-> alpha-normalized field activation
-> route and contradiction assessment
-> requirement-conditioned proposals and candidates
-> proof-aware selection
-> Mouth realization and bounded revision
-> answer plus inspectable trace
```

The kernel selects what may be said. The Mouth realizes that selected meaning. PostgreSQL is the canonical durable store, while graph activation and reasoning remain in the kernel rather than being delegated to text search.

## Current capabilities

- Typed ingestion with source identity, byte ranges, provenance, language, and temporal metadata.
- Directed graph activation through PPF and PowerWalk structures.
- Learned turn-requirement fields, cognitive-operator activation, bounded proposals, claim bases, candidate selection, and answer revision.
- Proof and contradiction records carried into answer traces.
- Local document and spreadsheet ingestion, including bounded `.xlsx`, `.xlsm`, and `.xls` parsing without macro execution or formula recalculation.
- Exact-byte workspace revision snapshots and content-addressed patch plans.
- A loopback-only VS Code client for reviewed, explicitly authorized patch application.
- A sealed public-review harness for reproducible evidence collection, citation verification, trace verification, blinding, and ablation reporting.

Important limits:

- Checked-in scoring coefficients are bootstrap or provisional unless a trace identifies a fitted calibrator.
- Patch validation defaults to an explicit trusted-host provider. An optional, digest-pinned Docker provider runs validation with networking disabled and bounded host/container resources; approval binds the exact server-owned validation lane. Docker daemon, host-kernel, and operator trust remain deployment boundaries.
- A packaged VSIX has been installed in an isolated VS Code 1.96.4 profile; the host
  activated it, observed its registered commands, and reached `GET /api/ready`. That
  smoke test does not cover visual layout, restart recovery, or a live patch round trip.
- `POST /api/workspace/patch/plan/request` is strict and non-mutating, but no successful
  production coding family is demonstrated. A generic existing-module request fails
  closed with `422` because its generated ProgramGraph lacks verified repair lineage.
- Formula cells retain source formulas and cached values when present; SCCE does not calculate workbook formulas.

## Workspace

```text
packages/kernel         cognitive runtime, graph, proof, planning, and Mouth
packages/adapters-node  PostgreSQL, files, documents, spreadsheets, and ingestion
packages/server         HTTP API and workbench server
packages/cli            local command-line interface
packages/ui             workbench-facing models and surfaces
packages/vscode         loopback-only VS Code client
tools/scce-dev-mcp      bounded repository and trace inspection tools
tools/sealed-eval       public-review and ablation harness
docs                    architecture, contracts, guides, and status records
```

## Setup and verification

Requirements:

- Node.js 20 or newer
- pnpm 10
- PostgreSQL for durable runtime, ingestion, and rehearsal commands

```powershell
pnpm install
pnpm validate
```

`pnpm validate` builds the workspace, runs unit and integration checks, validates the sealed-review kit, performs the static external-model scan, and writes the local test inventory. Run it against the exact checkout under review; this README does not freeze test counts.

Database-dependent checks are separate:

```powershell
pnpm scce db verify
pnpm rehearsal:postgres
pnpm rehearsal:adapter
```

Common runtime commands:

```powershell
pnpm build
pnpm calibration:evaluate --input <observations.json|jsonl> --dataset-id <immutable-id>
pnpm load:gate --prompts <prompts.json|jsonl> --workload-id <immutable-id>
pnpm vscode:package
pnpm vscode:test:host
pnpm scce
pnpm server
pnpm mcp:build
pnpm mcp:start
```

Generated `dist/`, coverage, trace, and review-output directories are local build products, not committed source artifacts.

The calibration evaluator and load gate require caller-supplied observations or
prompts and emit bounded local reports. No representative calibration or load result
is included in this repository.

## Configuration

Runtime configuration is loaded from `scce.config.json`. Environment variables can override configured values for local operation. Keep credentials out of committed configuration.

Large imports and live answering require a configured PostgreSQL instance. Tracing is disabled by default; enable it only for bounded diagnosis:

```powershell
$env:SCCE_TRACE="1"
$env:SCCE_TRACE_DIR=".scce/traces"
```

## Documentation

Start with [`docs/README.md`](docs/README.md). Key references include:

- [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md)
- [`docs/API_SURFACE.md`](docs/API_SURFACE.md)
- [`docs/USER_GUIDE.md`](docs/USER_GUIDE.md)
- [`docs/REPO_COMPLETION_MAP.md`](docs/REPO_COMPLETION_MAP.md)
- [`docs/PUBLIC_REVIEW_CONTRACT.md`](docs/PUBLIC_REVIEW_CONTRACT.md)
- [`docs/SERIOUS_VERSION_MATH_APPENDIX.md`](docs/SERIOUS_VERSION_MATH_APPENDIX.md)
- [`SECURITY.md`](SECURITY.md)

Coding agents should read [`AGENTS.md`](AGENTS.md) before modifying the repository.

## License

This repository is marked `UNLICENSED` in `package.json`.
