# Running the SCCE collective

Ten workers in worktrees did produce real work: a corpus-derived morphology oracle, an extractive summarizer, a
calibration audit, and two falsifications of the coordinator's own premises. They cost **142k-333k tokens each**,
because each was told to re-establish reality from scratch. The next generation is not more agents. It is fewer
tokens per worker, shared memory of what was already paid for, and deterministic integration.

## Default shape

```
3 investigators  ->  1 synthesizer  ->  1 implementer  ->  1 skeptic  ->  integration gate
```

Six jobs, not nine personalities, and all of them temporary. Investigators run only when the root cause is
genuinely unknown; when it is known, go straight to implementer and skeptic. Spawn a specialist only when
uncertainty justifies its cost.

Independent investigators are for contested root causes: give each the same question, forbid them from seeing each
other's hypotheses, and let the synthesizer rank them on evidence alone. That is what stops five agents
reinforcing the first plausible idea.

## Read this before spending anything

`.agent/context/` is what previous swarms already paid to learn. It is ~11 KB and replaces tens of thousands of
tokens of rediscovery.

| file | what it saves |
| --- | --- |
| `invariants.md` | the rules that fail a task regardless of its merits |
| `dead-ends.md` | approaches already measured and rejected, with the numbers |
| `operations.md` | CLI flags, credentials, builds, shell traps that have already cost tokens |
| `runtime-map.md` | which file owns what, and how to verify |
| `current-known-bugs.md` | what is open, ranked by threat to the claim |

Every worker that kills an approach with numbers appends it to `dead-ends.md`. That is the whole point.

## The packet

```
TASK         one sentence.
KNOWN FACTS  what is already measured. Paste it. Do not make them rediscover it.
KNOWN DEAD ENDS  point at .agent/context/dead-ends.md and name the relevant section.
READ         exact files. Not "the repository".
DO NOT       re-audit unrelated code, rebuild the architecture map, rerun unrelated suites.
DELIVER      root cause, mechanism, measurement, patch if justified, tests, unresolved cases.
BUDGET       see below. On hitting it, return what you know rather than spending more.
```

| job | budget |
| --- | ---: |
| lookup | 2k |
| code trace | 5k |
| investigation | 8k |
| implementation | 12k |
| architecture review | 16k |

## The skeptic clause, verbatim, in every worker prompt

> Do not accept comments, documentation, tests, or another agent's report as proof. Prefer production call paths,
> executable reproductions, observable state, independently run tests, counterexamples. If a capability exists but
> cannot be reached from the real runtime, report it unreachable. If a benchmark does not establish the claimed
> conclusion, say what it does establish. A precise negative result outranks a claimed success.

It has already falsified the coordinator twice: a "5.2 second pre-kernel gap" that was a misread deadline window,
and a "front matter is self-similar" theory that was really hard-wrapped lines read as sentence ends.

## Collection is deterministic, not a model's job

```sh
node tools/collect-result.mjs --dry     # mergeability, changes nothing
node tools/collect-result.mjs           # merge, build, typecheck, structured verdict
node tools/collect-result.mjs --gate    # the above plus the live gate
```

Merging, building, typechecking and reading test output need no judgement. A model is needed only when this
fails. The foreman should never be hand-checking merges or troubleshooting CLI syntax.

## Return this, not a transcript

```json
{"task":"T42","status":"fixed","cause":"...","changed":["path"],"tests":{"passed":37,"failed":0},
 "commit":"abc123","confidence":0.94,"deadEnds":["..."],"followups":[]}
```

## Kill a worker when

its hypothesis is disproven; another worker already produced the finding; it spent its budget without new
evidence; or its task left the critical path.

## Parallelism ceiling

One server, one database, and RAM is the binding constraint rather than the database: ~16 GB total, the server
holds 3-4 GB, so two live servers is the ceiling. Workers are offline by construction — read-only SQL, no server,
no writes. Only the integration gate runs live.
