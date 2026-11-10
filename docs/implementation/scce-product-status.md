# SCCE implementation checkpoint

Updated November 10, 2026.

## Current direction

Restore the complete engine at the fully passing `b612ee3b` baseline, then implement the requested GraphQL/Relay application boundary additively. Preserve existing cognitive, learning, storage, language and program modules while tracing their consumers. The newer private-assistant brief keeps native PostgreSQL eligible and rules out adding a Rust storage daemon without qualification; that is the baseline for this retry.

The prior construction/JOIN replacement is preserved at local tag `archive/20261110-before-graphql-relay` (`1f3bf822`). It passed a full TypeScript build,54focused Mouth/creative tests, and26native publication checks, but its full unit sweep exposed additional regressions. It is not the working release baseline. The source and tests removed by that attempt are restored by this rollback, including `join-program.ts`.

## Active work

1. Rebuild the restored source and verify the affected integration paths.
2. Complete the source/API/durable-domain map and preserve the evidence from the repository audit.
3. Add typed GraphQL application services over the existing runtime, with ownership, bounded reads and task/event/cancellation semantics.
4. Add the React/Relay workbench and generated schema/operation types against those services.
5. Verify ordinary user flows, restart recovery and existing engine behavior before switching application entry points.

No hosting or deployment is authorized.10× storage amplification remains an optimization goal, not a pass/fail gate. No LLM backend is permitted.

## Local artifacts

The interrupted whole-suite run and the source inventory/dependency/Knip reports are under `.scce/verification/`. Their source revision is `1f3bf822`; inventory and parsing do not represent completed manual semantic review. That inventory read1,831tracked code files, including911non-test source files and920test files, with no JS/TS parse errors. The dependency scan found7cycles requiring review; Knip findings are investigation candidates and are not a deletion list.

The previous ingestion remains stopped. `scce_brain_20261109_r005` is a new schema fixture with no retained source/learned state; it has not begun the declared402-input build. The stopped diagnostic database is `scce_brain_20261109_r003`. No completed live comparison or Claude/Qwen superiority result exists.
