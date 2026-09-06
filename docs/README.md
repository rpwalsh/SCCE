# SCCE Documentation

The maintained operating, architecture, and engineering documentation for SCCE. Start with the user guide, then open
only the contract or reference the task needs.

This is the published subset. Detailed method specifications — alignment, transport, segmentation, language induction,
calibration, and the mathematical appendix — are proprietary and are not published in this repository. They are
available to licensees and to evaluators under a signed agreement; see [COMMERCIAL.md](../COMMERCIAL.md).

## Start here

- [User guide](USER_GUIDE.md) — setup, ingestion, operation, inspection, and validation.
- [Architecture](ARCHITECTURE.md) — the one-lane runtime, package boundaries, and durable-store boundary.
- [Security policy](../SECURITY.md) — vulnerability reporting and the supported security boundary.

## Operate SCCE

- [API surface](API_SURFACE.md) — root commands, package APIs, server routes, CLI, workbench, VS Code, and developer
  tooling.
- [Corpus training](CORPUS_TRAINING.md) — corpus layout, compilation commands, hydration, and activation.
- [Workspace runtime](WORKSPACE_RUNTIME.md) — workspace ingestion, questions, reports, planning, and reviewed patch
  application.
- [Spreadsheet ingestion](SPREADSHEET_INGESTION_CONTRACT.md) — supported workbook formats, limits, formula handling,
  provenance, and failure behavior.

## Evidence and evaluation

- [Acceptance suite](ACCEPTANCE_SUITE.md) — twenty behaviours the architecture must demonstrate, with the coverage
  each has today.
- [Ablation](ABLATION.md) — what each component is worth, measured by disabling it. Regenerated from the run's own
  records by `tools/ablation-delta.mjs`; no figure in it is hand-written.
- [Public review contract](PUBLIC_REVIEW_CONTRACT.md) — the evidence required before a reproducible public-review
  claim, and what a third party would need to run.
- [Runtime reachability](RUNTIME_REACHABILITY.json) — every exported symbol, whether a real entry point reaches it,
  and a written reason for each one that is deliberately not wired (`pnpm reachability`).
- [Software bill of materials](SBOM.md) — third-party components, versions, and licenses, anchored to commit and
  lockfile (`pnpm sbom`).

## Build and debug

- [Engineering guide](ENGINEERING_GUIDE.md) — the mathematical spine, runtime boundaries, important files, and the
  order to diagnose in.
- [Source map](SCCE_MAP.md) — package and source-file map.

## Safety and review contracts

- [Patch transaction contract](PATCH_TRANSACTION_CONTRACT.md) — exact-byte plans, authorization, validation,
  mutation, rollback, and receipts.

## Document authority

Where documentation and implementation differ, source code, package manifests, route manifests, schemas, and fresh
command output for the exact revision take precedence. The patch-transaction and public-review documents are normative
contracts: a source change that intentionally alters one of those boundaries updates its contract in the same change.

Status and roadmap documents never establish benchmark, production, security, or calibration claims. Such claims
require the dated, revision-bound evidence named in the public review contract.
