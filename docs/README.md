# SCCE Documentation

This directory contains the maintained operating, architecture, and engineering
documentation for SCCE. Start with the user guide, then open only the contract or
reference needed for the task.

## Start here

- [User guide](USER_GUIDE.md) — setup, ingestion, operation, inspection, and
  limitations.
- [Architecture](ARCHITECTURE.md) — the one-lane runtime, package boundaries, and
  durable-store boundary.
- [Repository status](REPO_COMPLETION_MAP.md) — implemented surfaces, verification
  boundaries, and remaining work.
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

## Understand the engine

- [Brain-to-Mouth pipeline](BRAIN_TO_MOUTH_PIPELINE.md) — evidence, graph
  activation, selection, proof, semantic planning, realization, and trace.
- [Serious-version math contract](SERIOUS_VERSION_MATH_APPENDIX.md) — required
  optimization, calibration, and acceptance contract for serious-version work.
- [Scoring and calibration](SCORING_AND_CALIBRATION.md) — meanings and limitations
  of runtime scores, fitted models, and fallbacks.
- [Multilingual contract](MULTILINGUAL_CONTRACT.md) — language-neutral cognition and
  source-derived language behavior.

## Build and debug

- [Engineering guide](ENGINEERING_GUIDE.md) — mathematical spine, runtime
  boundaries, important files, and diagnosis order.
- [Source map](SCCE_MAP.md) — compact package and source-file map.
- [Debugging guide](SCCE_DEBUGGING.md) — focused commands, traces, and coding-agent
  workflow.
- [Developer MCP](SCCE_DEV_MCP.md) — installation and bounded repository, database,
  test, and trace tools.

## Safety and review contracts

- [Patch transaction contract](PATCH_TRANSACTION_CONTRACT.md) — exact-byte plans,
  authorization, validation, mutation, rollback, and receipts.
- [Public review contract](PUBLIC_REVIEW_CONTRACT.md) — evidence required before a
  reproducible public-review claim.
- [Fluent-engine roadmap](FLUENT_COGNITIVE_ENGINE_PLAN.md) — unachieved behavioral
  targets and qualification criteria; it is a roadmap, not a status record.

## Document authority

When documentation and implementation differ, source code, package manifests, route
manifests, schemas, and fresh command output for the exact revision take precedence.
The serious-version math, multilingual, patch-transaction, spreadsheet, and public
review documents are normative contracts; a source change that intentionally alters
one of those boundaries must update its contract in the same change.

Status and roadmap documents never establish benchmark, production, security, or
calibration claims. Such claims require the dated, revision-bound evidence named in
the public review contract. Historical audits, agent work logs, generated source maps,
and superseded delivery checklists belong in git history rather than this directory.
