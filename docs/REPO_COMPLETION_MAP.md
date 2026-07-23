# SCCE Repository Readiness Map

This document summarizes source-visible implementation and remaining verification work. Fresh command output for the exact checkout takes precedence over this summary.

## Current status

| Area | Status | Scope and limit |
|---|---|---|
| Core turn path | Implemented, provisional quality | Requirement field, cognitive operators, proposals, claim bases, candidate selection, Mouth realization, and bounded revision use one kernel path; checked-in coefficients are bootstrap or provisional |
| Conversational, creative, and multilingual quality | Unverified | The runtime exposes these mechanisms, but sparse or source-only cold-start output may be fragmentary until a compatible learned language profile is hydrated; no representative held-out review establishes fluent quality or equivalence to a general-purpose assistant |
| Action and tool autonomy | Not established as a general capability | Bounded planning, capability authorization, and reviewed patch contracts exist; general tool use and autonomous task completion remain unverified |
| Evidence and proof | Implemented | Source identity, byte ranges, proof state, contradiction state, and answer traces are present; representative answer-quality review remains incomplete |
| Low-support recovery | Implemented, bounded | An under-supported turn gets one learn/search/fetch, canonical-ingest, and replan transition. Search results do not become evidence before typed ingestion; an empty Mouth surface is an internal continuation signal rather than a final response |
| Brain lifecycle | Implemented; live rehearsal environment-dependent | PostgreSQL migration, activation, repair, and exactly-one-active constraints have dedicated tests and rehearsal commands; live results require a valid configured database URL |
| Spreadsheet ingestion | Implemented | Bounded `.xlsx`, `.xlsm`, and `.xls` parsing preserves formulas and cached values without recalculation or macro execution |
| Exact-byte patch planning | Implemented | The server verifies the latest durable workspace revision and returns an unauthorized, unexecuted plan from a strict full-file proposal |
| Coding-request production path | Implemented, narrow | The strict non-mutating route has tested source-proven unused type-only import removal and official TypeScript LanguageService actions from exact durable snapshot bytes. A structured positive integer diagnostic code (`diagnosticCodes` over HTTP or `--diagnostic-code=<integer>` in the CLI) must resolve to one action rooted at the sole requested existing TypeScript file; request prose never selects it. The complete action may close over up to 32 affected files and 128 exact text changes, including bounded TypeScript/JavaScript creation under existing workspace directories. The source-observed direct `tsc` invocation must resolve an exact snapshot project config containing the requested file. Plans are unauthorized and unexecuted and require source-observed compiler/typecheck/test validation. Command-bearing actions, paths outside the workspace, stale or absent replacement bases, creation outside existing directories, arbitrary feature synthesis, and compiler context beyond the snapshot plus TypeScript standard library remain unsupported |
| Patch application | Implemented with trust boundary | Content hashes, compare-and-swap checks, explicit authorization, validation, rollback, and receipts are present |
| Isolated validation | Implemented, local smoke only | Optional server-selected, digest-pinned Docker validation completed a local networkless live test; Docker daemon, operator, image supply chain, and host kernel remain trusted and no attestation or independent review follows |
| VS Code client | Implemented, partial verification | A packaged VSIX was installed in an isolated VS Code 1.96.4 profile, activated, registered its commands, and reached readiness; visual layout, restart recovery, and a live patch round trip remain unverified |
| Calibration holdout | Mechanism implemented | The evaluator requires caller-supplied source-identified observations and an immutable dataset ID; no representative calibration run is included |
| Runtime load gate | Mechanism implemented | The gate requires a caller-supplied prompt workload and immutable workload ID; no representative load or capacity result is included |
| Public review | `NOT_EXECUTED` | Harness and synthetic rehearsals exist, but the protected independently controlled procedure has not run |
| Product status | Pre-release | Clean-machine reproduction, representative calibration, load, durability, packaging, and security deployment work remains |

## Implemented runtime boundaries

- One production kernel path for ingestion, graph activation, proof-aware selection, realization, and trace emission.
- Unicode-safe byte and character evidence spans with exact citation verification.
- Separate support and contradiction records; the Mouth cannot create evidence after selection.
- Source-backed contradiction and temporal ordering can defeat a false premise; absence of positive support alone does not prove a negative.
- Creative authority permits invented proposals without promoting them to factual certification.
- Durable events for requirements, operators, proposals, selected candidates, Mouth state, and revision outcomes.
- Source-neutral relation features and optional content-addressed calibration models with explicit unconfigured fallback.
- Shared source-neutral requirement-field projection for factual, reasoned, creative, translation, program, and action authority; projection scores remain uncalibrated routing energies.
- Conditional-Gaussian VAR order selection on a common estimation window, companion-matrix stability diagnostics, and horizon-specific Wold covariance with explicitly uncalibrated Gaussian intervals.
- Distinct PowerWalk initializer, optimizer candidate, and active parameter sets; fitted parameters are published only after fit and source-record-disjoint holdout NLL improve on caller-supplied transition observations.
- Workspace revision snapshots whose operation bytes and before/after identities are hashed into a deterministic plan.

## Verification commands

Run these against the exact checkout being reviewed:

```powershell
pnpm validate
pnpm rehearsal:postgres
pnpm rehearsal:adapter
git diff --check
```

The database rehearsals require a valid PostgreSQL URL. `SCCE_DATABASE_URL` can supply
that URL without storing the credential in `scce.config.json`.
`pnpm validate` does not execute the protected public-review procedure or select the
optional Docker provider.

## Remaining work

1. Fit and validate truth, contradiction, relation-potential, PowerWalk, selector, and
   surface parameters on representative disjoint datasets. The implemented PowerWalk
   source-disjoint acceptance gate is not representative calibration by itself.
2. Extend the bounded coding bridge beyond its tested unused-import and selected
   TypeScript LanguageService action families, then execute and evaluate the supported paths
   on independently controlled repositories.
3. Independently review Docker deployment, dependency materialization, image provenance, and the remaining daemon/operator/host-kernel trust boundary.
4. Exercise VS Code visual behavior, restart recovery, approval, and a live patch receipt in the packaged host.
5. Reproduce build, tests, PostgreSQL lifecycle, adapter operation, and editor behavior on a clean independent machine.
6. Supply representative calibration and load datasets, then run realistic long-duration, multilingual, code-repair, and broad answer-quality reviews.

## Claim boundary

Source inspection and local checks support only the specific contracts they exercise. They do not establish general runtime quality, production safety for untrusted code, or clean-machine reproducibility.
