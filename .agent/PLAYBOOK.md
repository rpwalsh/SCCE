# Running the SCCE collective

## Standing core, spawned per task rather than kept alive

| role | when it runs | budget |
| --- | --- | ---: |
| Foreman | always. Owns the board, decomposes, assigns, kills. Writes no production code. | — |
| Archaeologist | before any edit to unfamiliar code. Traces real call paths. | 5k |
| Reachability | when a capability is *claimed* to exist. Proves it is reachable from a real turn. | 8k |
| Implementer A | the smallest viable change. | 12k |
| Implementer B | only for contentious fixes. Proposes a competing fix without seeing A's. | 12k |
| Adversarial tester | after any fix. Tries to falsify it. | 8k |
| Reviewer | before merge. Invariants, coupling, scope. | 16k |
| Integrator | serialized. Rebases, runs live gates, writes the verdict. | — |
| Benchmark/claims | periodic audit, not per task. Keeps claims from outrunning code. | 16k |

Four to six run on a normal task. A simple bug is Archaeologist, Implementer, Tester, Reviewer.

## The packet, not the repository

Every worker gets: TASK, READ FIRST (exact files), KNOWN FACTS (what is already measured, so it is not
rediscovered), DO NOT, RETURN (root cause, files and lines, patch, tests executed, remaining uncertainty), BUDGET.
Point at `.agent/context/` first; open source only for evidence. Measured: workers told to verify everything from
scratch cost 142k-330k tokens each. The facts they rediscovered were already known.

## Return this, not a transcript

```json
{"task":"T42","status":"fixed","cause":"...","changed":["path"],"tests":{"passed":37,"failed":0},
 "commit":"abc123","confidence":0.94,"followups":[]}
```

## Kill a worker when

its hypothesis is disproven; another worker already produced the finding; it spent its budget without new
evidence; or its task left the critical path. Hitting the budget means return what you know, not spend more.

## The skeptic clause, in every worker prompt

> Do not accept comments, documentation, tests, or another agent's report as proof. Prefer production call paths,
> executable reproductions, observable state, independently run tests, counterexamples. If a capability exists but
> cannot be reached from the real runtime, report it unreachable. If a benchmark does not establish the claimed
> conclusion, say what it does establish. A precise negative result outranks a claimed success.

This is what pays. In one session skeptic-framed workers falsified the coordinator's own premise twice: a
"5.2 second pre-kernel gap" that was a misread deadline window, and a "front matter is self-similar" theory that
was really hard-wrapped lines being read as sentence ends.

## Parallelism ceiling

One server, one database, and RAM is the binding constraint, not the database. Workers are offline by
construction: read-only SQL, no server, no writes. Only the integrator runs live gates.
