# SCCE Repository Readiness Map

This document summarizes source-visible implementation and remaining verification work. Fresh command output for the exact checkout takes precedence over this summary.

## Current status

| Area | Status | Scope and limit |
|---|---|---|
| Core turn path | Implemented, provisional quality | Requirement field, cognitive operators, proposals, claim bases, candidate selection, Mouth realization, and bounded revision use one kernel path; checked-in coefficients are bootstrap or provisional |
| Evidence and proof | Implemented | Source identity, byte ranges, proof state, contradiction state, and answer traces are present; representative answer-quality review remains incomplete |
| Brain lifecycle | Implemented; live rehearsal pending | PostgreSQL migration, activation, repair, and exactly-one-active constraints have dedicated tests and rehearsal commands; the current live rehearsals were not executed because no database password was configured |
| Spreadsheet ingestion | Implemented | Bounded `.xlsx`, `.xlsm`, and `.xls` parsing preserves formulas and cached values without recalculation or macro execution |
| Exact-byte patch planning | Implemented | The server verifies the latest durable workspace revision and returns an unauthorized, unexecuted plan from a strict full-file proposal |
| Coding-request production path | Incomplete | The strict non-mutating route exists, but a generic existing-module request fails closed with `422` because generated ProgramGraph data lacks verified repair lineage; no successful production coding family is demonstrated |
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
- Durable events for requirements, operators, proposals, selected candidates, Mouth state, and revision outcomes.
- Versioned evaluation conditions with isolated cache identity and trace verification.
- Source-neutral relation features and optional content-addressed calibration models with explicit unconfigured fallback.
- Workspace revision snapshots whose operation bytes and before/after identities are hashed into a deterministic plan.

## Verification commands

Run these against the exact checkout being reviewed:

```powershell
pnpm validate
pnpm rehearsal:postgres
pnpm rehearsal:adapter
git diff --check
```

The database rehearsals require a configured PostgreSQL password. They remain
unexecuted in the current release record because that credential was not configured.
`pnpm validate` does not execute the protected public-review procedure or select the
optional Docker provider.

## Remaining work

1. Fit and validate truth, contradiction, relation-potential, PowerWalk, selector, and surface parameters on representative disjoint datasets.
2. Complete a production coding bridge that derives verifiable repair lineage, live
   absence observations, and candidate-test linkage from trusted runtime state, then
   execute and evaluate it on independently controlled repositories.
3. Independently review Docker deployment, dependency materialization, image provenance, and the remaining daemon/operator/host-kernel trust boundary.
4. Exercise VS Code visual behavior, restart recovery, approval, and a live patch receipt in the packaged host.
5. Reproduce build, tests, PostgreSQL lifecycle, adapter operation, and editor behavior on a clean independent machine.
6. Supply representative calibration and load datasets, then run realistic long-duration, multilingual, code-repair, and broad answer-quality reviews.
7. Execute the procedure in [`PUBLIC_REVIEW_CONTRACT.md`](PUBLIC_REVIEW_CONTRACT.md) with independently controlled protected inputs.

## Claim boundary

Source inspection and local checks support only the specific contracts they exercise. They do not establish general runtime quality, production safety for untrusted code, clean-machine reproducibility, or completion of the public-review procedure.
