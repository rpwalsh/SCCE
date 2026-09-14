# Corpus language population reaches request scaffolding

Director: Astra. Implementer: Sol. Independent skeptic: Luna.
Worktree: isolated `codex/mvp-language`; primary worktree remains integration-owned.

The production turn derives function symbols and request scaffolding from the
few n-gram models hydrated for the turn. Prior live traces show missing `does`
and `which` blocking sentences already present in the evidence pool. This task
must expose the existing corpus-language continuation statistic without loading
the full corpus model state into each turn.

Measure compact profile continuation summaries before treating them as sufficient:
their stored top-128 projection loses information. The existing language identity
closed class measures majority-document presence and is a different statistic.

Candidate source ownership: `closed-class-words.ts`, `turn-signals.ts`,
`surface-language-runtime.ts`, `language-memory-runtime.ts`, `storage.ts`,
`production-turn-runtime.ts`, and the narrow Postgres statistics projection.
Root approved population-field propagation at existing closed-class derivation
calls in `answer-emitter.ts`, `mouth.ts`, and `runtime-graph-retrieval.ts`.
No `local-evidence-runtime.ts` edits or unrelated mouth behavior changes.

Required counterexamples: subject words remain anchored, real relations remain
required, unrelated languages and inaccessible sources cannot teach the active
population, warm requests do not repeat expensive aggregate work, and sparse or
absent measurements cannot masquerade as learned function material.

Removing `which` does not discharge the distinct `country` obligation in a
sentence naming Japan. Any live score improvement must be measured separately.

No server, database writes, dependency changes, commits, or pushes by workers.
Read-only diagnostics are allowed. Root owns integration and live evaluation.

Read-only measurements: exact identity-scoped continuation aggregation took
8.32 seconds cold using the existing model-profile expression index. Raw ranks
were `which` 66 and `born` about 340. A separate compact profile-summary
population ranked `which` 41 and `born` 80; those populations differ, so neither
projection loss nor population difference alone has been established as the cause.
`does` ranked about 337 in the exact population and remains outside top 96.
This patch cannot promise to recover the Dorothy question, whose `does` is
already the second request word. Existing request-local adaptation stays intact.
