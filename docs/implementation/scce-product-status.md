# SCCE implementation checkpoint

Updated November 10, 2026.

## Current direction

Restore the complete engine at the fully passing `b612ee3b` baseline, then implement the requested GraphQL/Relay application boundary additively. Preserve existing cognitive, learning, storage, language and program modules while tracing their consumers. The newer private-assistant brief keeps native PostgreSQL eligible and rules out adding a Rust storage daemon without qualification; that is the baseline for this retry.

The prior construction/JOIN replacement is preserved at local tag `archive/20261110-before-graphql-relay` (`1f3bf822`). It passed a full TypeScript build, 54 focused Mouth/creative tests, and 26 native publication checks, but its full unit sweep exposed additional regressions. It is not the working release baseline. The source and tests removed by that attempt are restored by `13134a98`, including `join-program.ts`.

## Active work

1. Restored source builds. Original engine production sources remain at the passing baseline.
2. Added `TurnApplication`, registered GraphQL operations, scoped Node refetch, task-frame cursor pages, durable replay and explicit cancellation. HTTP and GraphQL call the same `executeApplicationTurn` boundary, preserving readiness, dialogue and approvals.
3. Added `packages/workbench`: React, Vite, Relay fragments, generated TypeScript and operation registration. Native mounts are `/workbench/` and `/scce/workbench/`; the original workbench remains at `/`.
4. Focused task/transport/registry/browser-network checks pass, including cancellation after a failed persistence write. Native PostgreSQL restart checks preserve task IDs/results and reject stale commands/cursors without duplicate execution. Playwright exercised connection, submission, the native empty-brain error, both mounts and mobile/desktop layouts.
5. The complete unit sweep passed all 20 shards (815 passing files, 5552 passing tests), with concurrency 2 and 2 GiB heaps. The root build, Relay compiler, operation registry, no-hidden-model and source-text checks also pass. This qualifies the additive interface change, not a trained brain or storage repair.
6. Extend typed domain services and UI views for the remaining native tools while preserving their current implementations. Whole-repository semantic review remains incomplete; inventory and AST parsing alone do not establish it.

No hosting or deployment is authorized. 10x storage amplification remains an optimization goal, not a pass/fail gate. No LLM backend is permitted. The 188x whole-brain amplification problem has not been resolved or qualified by a fresh identical-input build. Paired fixture savings do not establish that result, and the restored working baseline does not include the archived experimental representation changes.

## Local artifacts

The interrupted whole-suite run and the source inventory/dependency/Knip reports are under `.scce/verification/`. Their source revision is `1f3bf822`; inventory and parsing do not represent completed manual semantic review. That inventory read 1,831 tracked code files, including 911 non-test source files and 920 test files, with no JS/TS parse errors. The dependency scan found 7 cycles requiring review; Knip findings are investigation candidates and are not a deletion list. The rollback's obsolete compiler outputs are preserved under `archived-generated-1f3bf822`, rather than remaining in runtime output directories.

The previous ingestion remains stopped. `scce_brain_20261109_r005` is a schema-33 fixture from the archived implementation with no retained source/learned state; it must not be reused for the restored schema-32 engine. It has not begun the declared 402-input build. The stopped diagnostic database is `scce_brain_20261109_r003`. A separate fresh native fixture, `scce_graphql_20261110_r001`, validates transport and persistence only: no corpus was trained or learned state copied. No completed live comparison or Claude/Qwen superiority result exists.
