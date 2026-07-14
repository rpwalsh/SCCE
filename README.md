# SCCE v3

SCCE is a TypeScript and Node.js implementation of the Self Contained Cognitive Engine: a local, graph-native runtime with PostgreSQL-backed durable state, evidence-aware answer construction, and developer tooling.

The repository is an active pre-release source tree. Implemented paths and passing local checks are evidence about specific engineering contracts; they are not production certification or a general-quality result. The source is available for inspection under a proprietary license; it is not an open-source distribution.

## Runtime path

```text
source bytes
-> typed observations and evidence spans
-> graph edges and role-bearing hyperedges
-> alpha-normalized field activation
-> route and contradiction assessment
-> requirement-conditioned proposals and candidates
-> proof-aware selection
-> one bounded support-recovery transition when needed
-> Mouth realization and bounded revision
-> answer plus inspectable trace
```

The kernel selects what may be said. The Mouth realizes selected semantic slots and relations through learned language memory; it does not choose facts or turn proof/control identifiers into prose. PostgreSQL is the canonical durable store, while graph activation and reasoning remain in the kernel rather than being delegated to text search.

## Current capabilities

- Typed ingestion with source identity, byte ranges, provenance, language, and temporal metadata.
- Directed graph activation through PPF and PowerWalk structures.
- Learned turn-requirement fields, cognitive-operator activation, bounded proposals, claim bases, candidate selection, and answer revision.
- A source-only in-memory runtime factory that shares the kernel's source-neutral requirement-to-authority projection and operator-activation helpers, with its own traced input semantics.
- Proof and contradiction records carried into answer traces.
- Local document and spreadsheet ingestion, including bounded `.xlsx`, `.xlsm`, and `.xls` parsing without macro execution or formula recalculation.
- Exact-byte workspace revision snapshots and content-addressed patch plans.
- A loopback-only VS Code client for reviewed, explicitly authorized patch application.

### Low-support turns

Insufficient support is a routing state, not a final refusal. The kernel can make one bounded recovery transition: learn from eligible local material or perform a configured search/fetch, admit any returned material through the canonical typed-ingest and provenance path, then replan. Recovery may not loop indefinitely or treat fetched text as evidence before source identity, spans, and temporal metadata are recorded.

The replanned answer keeps factual certification separate from useful speech. It may present a source-backed correction or negative answer, or a qualified inference. If one acquisition attempt is exhausted and a factual or reasoned turn is still under-supported, the current user policy licenses one bounded creative continuation only when active learned graph or language priors contribute material not copied from the request. The candidate must pass non-echo, risk, and unsupported-fact gates; carry an `invented` claim basis, no evidence references, and `generated_not_evidence` provenance; and receive no factual certification.

False-premise answers still require contradiction or temporal evidence for the correction; invention may not supply the negation. With empty connector, graph, and language state, SCCE cannot honestly synthesize useful knowledge without hardcoded or fabricated text, so the planner selects a non-assertive terminal answer limited to source-derived material that actually exists and the Mouth realizes that selection. An empty Mouth surface returns control to the kernel for terminal selection; it is never the final user response.

Important limits:

- Checked-in scoring coefficients are bootstrap or provisional unless a trace identifies a fitted calibrator.
- Patch validation defaults to an explicit trusted-host provider. An optional, digest-pinned Docker provider runs validation with networking disabled and bounded host/container resources; approval binds the exact server-owned validation lane. Docker daemon, host-kernel, and operator trust remain deployment boundaries.
- A packaged VSIX has been installed in an isolated VS Code 1.96.4 profile; the host
  activated it, observed its registered commands, and reached `GET /api/ready`. That
  smoke test does not cover visual layout, restart recovery, or a live patch round trip.
- `POST /api/workspace/patch/plan/request` has two tested TypeScript repair paths: a
  source-proven unused type-only import removal and official TypeScript LanguageService
  code fix rooted at one existing requested TypeScript file. The planner uses exact
  durable snapshot bytes and requires an explicit compiler diagnostic or exact action
  selector that resolves to one candidate; there is no unique-candidate fallback. A
  selected action may close as one compiler-owned repair transaction over as many as
  32 affected files and 128 exact text changes, including bounded TypeScript or
  JavaScript file creation in an existing workspace directory. It returns an
  unauthorized, unexecuted plan requiring compiler, typecheck, and test validation.
  Compiler context is limited to the durable snapshot plus the TypeScript standard
  library and must resolve an exact project config from the source-observed direct
  `tsc` invocation. Command-bearing actions, implicit or ambiguous action selection,
  paths outside the workspace, replacement targets outside the snapshot, and creation
  outside existing workspace directories are rejected. Arbitrary feature synthesis is
  not part of this compiler-action path, and source-observed build and test commands are
  required.
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

`pnpm validate` runs the repository's configured build and validation checks. Run it against the exact checkout under review; this README does not freeze test counts.

Database-dependent checks are separate:

```powershell
pnpm scce db verify
pnpm rehearsal:postgres
pnpm rehearsal:adapter
```

Common runtime commands:

```powershell
pnpm build
pnpm cognition:gate
pnpm runtime:authority-matrix
pnpm vscode:package
pnpm vscode:test:host
pnpm scce
pnpm server
pnpm mcp:build
pnpm mcp:start
```

Generated `dist/`, coverage, trace, and diagnostic-output directories are local build products, not committed source artifacts.

## Configuration

Runtime configuration is loaded from `scce.config.json`. A non-empty
`SCCE_DATABASE_URL` overrides `database.url` before validation, so PostgreSQL
credentials can remain outside committed configuration. Keep credentials out of
committed files.

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
- [`docs/SERIOUS_VERSION_MATH_APPENDIX.md`](docs/SERIOUS_VERSION_MATH_APPENDIX.md)
- [`SECURITY.md`](SECURITY.md)

Coding agents should read [`AGENTS.md`](AGENTS.md) before modifying the repository.

## License

SCCE is proprietary software. Publishing or sharing this source for inspection does not grant open-source rights. Workspace packages are marked `private` and `UNLICENSED`; see [`LICENSE`](LICENSE) and [`NOTICE`](NOTICE).
