# Runtime map

## The turn
request -> authority projection -> corpus identity -> anchors -> evidence admission -> proof -> candidates ->
planner -> mouth -> citation. Traced to `.scce/traces/*.jsonl`, one JSON event per line, `stage` + `support`.
A turn starts at `turn.input` (its `input` field is the request text) and ends at `turn.output`
(`support.timing` carries the phase breakdown and `resourceUsage`).

## Files that matter
| file | owns |
| --- | --- |
| `kernel/src/production-turn-runtime.ts` | the whole turn. Largest file; expect collisions. |
| `kernel/src/corpus-identity.ts` | what a request names. Pure. Identity + concentration, no orthography. |
| `kernel/src/corpus-identity-runtime.ts` | measures the above against the corpus, caches per process. |
| `kernel/src/local-evidence-runtime.ts` | admission, ranking, `answerCoversRequest`, stem matching. |
| `kernel/src/surface-language-runtime.ts` | language hydration and its cache. Single-flight lives here. |
| `kernel/src/mouth.ts` | realization and the coverage gate. |
| `kernel/src/source-summary.ts` | extractive summary of a source (centrality). |
| `server/src/routes.ts` | HTTP, the per-turn deadline (fitted, not declared). |
| `adapters-node/src/postgres.ts` | every SQL query the kernel makes. |

## Shared and serialized
ONE server on port 3873, ONE PostgreSQL. Read-only SQL is parallel-safe; everything else is not.
Workers must never start or restart the server. Live verification belongs to the integrator.
RAM is the real limit on parallelism: ~16 GB total, the server holds 3-4 GB. Two live servers is the ceiling.

## How to verify
| gate | command | bar |
| --- | --- | --- |
| typecheck | `pnpm --filter @scce/<pkg> exec tsc -p tsconfig.json --noEmit` | exit 0 |
| capitals | `node tools/capitals-probe.mjs` | 7/7 name the capital |
| conversation | `node tools/conversation-probe.mjs` | no turn regresses |
| coding spine | `node tools/coding-spine-acceptance.mjs` | chains A and B |
| everything | `node tools/integration-gate.mjs --label=<task>` | writes its verdict to the board |

Adapters compile against the kernel's emitted types, so build `@scce/kernel` before typechecking adapters.
A fresh worktree has no `node_modules`; `pnpm install` there before running tests.
