# Scoring

Every reward is produced by a tool, not by a model's opinion. An agent cannot award itself any of these.

## Verifiable by a worker, in its own worktree (parallel-safe)

| signal | how it is produced |
| --- | --- |
| typecheck | `pnpm --filter @scce/kernel exec tsc -p tsconfig.json --noEmit`, same for adapters-node and server |
| offline harness | a script under `tools/` the worker writes, runnable with no server and no database writes |
| minimality | `git diff --stat` against the base commit |
| prediction | the worker states, BEFORE editing, which check currently fails and why; the check is then run |

## Verifiable only by the integrator (serialized, one server)

| signal | command | bar |
| --- | --- | --- |
| capitals | `node tools/capitals-probe.mjs` | 7/7 name the capital |
| conversation | `node tools/conversation-probe.mjs` | no turn regresses from its recorded state |
| coding spine | `node tools/coding-spine-acceptance.mjs` | chains A and B |

## Score

```
+100  the requested behavior works under a live gate
 +50  no live gate regresses
 +25  a new offline harness demonstrates the fix and fails without it
 +20  independent reviewer finds no architectural violation
 +15  root cause named and evidenced BEFORE the edit, and it held
 +10  smallest diff among competing patches

-100  a live gate regresses
 -75  a test or gate is weakened, deleted, or its bar lowered
 -50  unrelated code changed
 -40  success claimed without an attached tool output
 -25  an architectural invariant is violated
```

Reported per patch on three axes, so a careful investigator and a fast risk-taker are distinguishable:
`correctness` / `evidence` / `efficiency`.

## Invariants no score can override

- No LLM anywhere in SCCE. No new model dependency.
- No casing rules, English suffix lists, word-position rules, or hand-set magic numbers. Derive from corpus quantities.
- Never weaken a test or gate to make a change pass.
- Never `rm -rf`.
- PostgreSQL stays canonical. Deterministic replay is preserved.
- Credentials live only in untracked `scce.config.local.json`. Never printed, never committed.
- Every behavioral fix carries a regression check.
