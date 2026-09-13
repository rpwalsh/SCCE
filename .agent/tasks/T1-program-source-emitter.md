# T1 Program source emitter

status: open
claimed_by:

## Problem, already evidenced

A coding turn plans a program and now really dispatches a build (BuildExecuted/TestExecuted fire), but it never
compiles anything, because nothing emits source.

- `packages/kernel/src/program-planner.ts` `learnedLanguageEntrypoint` writes a comment header plus a JSON contract
  dump as the "source file". `BUILDING.md` calls this deliberate: "the emitted source target is intentionally open".
- `packages/kernel/src/code-learning.ts` `runtimeForBlueprint` sets build/test `command` to the literal string
  `"source-derived"`, which cannot spawn. Observed exit code null in 4-8 ms.
- The emitted entrypoint points at a file from SCCE's own ingested repo, not at anything written for the request.

## Done when

An offline harness turns a request like "implement a TypeScript function uniqueStrings(values: string[]): string[]
returning unique strings in first-seen order, with tests" into files that actually run: the build command and the
test command are real executables present on this machine, the test exits 0, and the harness fails if the emitter
regresses. Verify with node, which is already the runtime.

Do NOT start a server. Do NOT enable `allowMutation`; build/test already runs in an ephemeral workspace under
`.tmp/scce-runs`, which needs no repo write permission.
