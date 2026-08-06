# SCCE Documentation

This directory contains the maintained operating, architecture, and engineering
documentation for SCCE. Start with the user guide, then open only the contract or
reference needed for the task.

This is the public subset of the project's documentation. Narrow internal
subsystem contracts, implementation-status tracking, and planning notes are
kept locally (see `.gitignore`) rather than published here -- they're
working notes for active development, not reference material for an
outside reader.

## Start here

- [User guide](USER_GUIDE.md) — setup, ingestion, operation, inspection, and
  validation.
- [Architecture](ARCHITECTURE.md) — the one-lane runtime, package boundaries, and
  durable-store boundary.
- [Security policy](../SECURITY.md) — vulnerability reporting and supported security
  boundary.

## Operate SCCE

- [API surface](API_SURFACE.md) — root commands, package APIs, server routes, CLI,
  workbench, VS Code, and developer tooling.
- [Corpus training](CORPUS_TRAINING.md) — corpus layout, compilation commands,
  hydration, and activation.
- [Workspace runtime](WORKSPACE_RUNTIME.md) — workspace ingestion, questions,
  reports, planning, and reviewed patch application.
- [Spreadsheet ingestion](SPREADSHEET_INGESTION_CONTRACT.md) — supported workbook
  formats, limits, formula handling, provenance, and failure behavior.

## Build and debug

- [Engineering guide](ENGINEERING_GUIDE.md) — mathematical spine, runtime
  boundaries, important files, and diagnosis order.
- [Source map](SCCE_MAP.md) — compact package and source-file map.

## Safety and review contracts

- [Patch transaction contract](PATCH_TRANSACTION_CONTRACT.md) — exact-byte plans,
  authorization, validation, mutation, rollback, and receipts.
- [Public review contract](PUBLIC_REVIEW_CONTRACT.md) — evidence required before a
  reproducible public-review claim.

## Document authority

When documentation and implementation differ, source code, package manifests, route
manifests, schemas, and fresh command output for the exact revision take precedence.
The patch-transaction and public review documents are normative contracts; a source
change that intentionally alters one of those boundaries must update its contract in
the same change.

Status and roadmap documents never establish benchmark, production, security, or
calibration claims. Such claims require the dated, revision-bound evidence named in
the public review contract.
