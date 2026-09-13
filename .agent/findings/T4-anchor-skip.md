# T4 — The cheapest precondition for skipping anchor evidence search

**There is none. The premise this task was given is a measurement artifact, and the operator it accuses is the
operator that supplies the answer's evidence in 94.6% of the invocations where an answer had evidence at all.**

Reproduce: `node --max-old-space-size=4096 tools/operator-roi.mjs --traces=<dir> --anchor-skip`
(new `--anchor-skip` mode on the existing tool; read-only, no production code touched, server never called).

## 1. The premise is measuring the wrong sub-step

T12 scored `graph.anchor_evidence_search` with the counter pair `support.gathered` → `support.afterProseFilter`.
Those two counters bracket **only the code-span prose filter** that runs *after* the search
(`packages/kernel/src/runtime-graph-retrieval.ts:715`, the `gatheredResults.filter(... spanIsSourceCode ...)` line).
They do not bracket the search.

Measured: `gathered === afterProseFilter` in **2,248 of 2,252** invocations. So the true reading of T12's headline
is *"the code-span filter removed nothing on this traffic"* — a statement about a filter costing microseconds —
**not** "the 3.7 s search changed nothing". The 23.3% of CPU and the 100% no-change are two different things that
happen to share one trace event. T12's own caveat list predicted exactly this failure mode.

## 2. What the search actually does, per invocation

2,252 invocations inside turn windows, 9,569.8 CPU-s, **23.9% of attributable CPU**, mean 4,052.8 ms.
Claim basis = the evidence ids `candidate.score` recorded for the turn (the tool's existing definition).

| outcome (2,248 invocations with a paired `anchor_admissibility`) | n |
| --- | ---: |
| admitted evidence that **reached the final claim basis** | **1,408** |
| admitted > 0, basis untouched (761 invocations had **no claim basis at all**) | 627 |
| admitted = 0 (search produced nothing admissible) | 213 |

Restricted to the 1,488 invocations with both a paired admissibility event and a non-empty claim basis:
**useful 1,408 / 1,488 = 94.6%** (5,516.9 CPU-s); **not useful 80 = 5.4%** (280.9 CPU-s = **0.7% of attributable
CPU**). Of those 80: 22 admitted nothing, 22 carried `sourceIdentityBoundEvidenceAbsent`, 0 gathered nothing.

This is a **lower bound on usefulness**: the trace truncates `support.admitted` to 8 ids, so overlap is tested
against at most 8 of up to 24 admitted spans. The real figure can only be higher.

## 3. Confusion matrix over real invocations (scope = 1,488)

Outcome under test: "this invocation could not have improved the proof" = nothing it admitted reached the claim
basis. Every precondition below is computable *before* the search, from request text and anchor groups alone.

| precondition | predicted skip | true skip | **FALSE SKIP** | CPU-s saved | % sys CPU | precision |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| A `groups == 0` | 4 | 0 | **4** | 6.3 | 0.0 | 0.0% |
| B no symbol-bearing anchor group | 242 | 14 | **228** | 321.7 | 0.8 | 5.8% |
| C A or B | 242 | 14 | **228** | 321.7 | 0.8 | 5.8% |
| D request text already asked earlier | 1317 | 77 | **1240** | 4654.9 | 11.6 | 5.8% |
| E `gathered == 0` | 0 | 0 | 0 | 0.0 | 0.0 | - |
| F `afterProseFilter == 0` | 0 | 0 | 0 | 0.0 | 0.0 | - |
| G `features <= 1` | 220 | 11 | **209** | 233.1 | 0.6 | 5.0% |
| H `droppedScaffoldingGroups > 0` | 426 | 22 | **404** | 1051.2 | 2.6 | 5.2% |

**No precondition has a false-skip rate below 94%.** Each is merely re-sampling the 94.6% base rate: these features
carry no signal about the outcome. Nothing here is recommended; nothing here is close.

Candidate directions from the task brief that could not be tested as preconditions, and why:
`graph.resolve|kernel.turn.semantic_retrieval` (the 37.85 bits/s operator) runs at
`production-turn-runtime.ts:1688`, **downstream** of the graph slice — it consumes `admissibleEvidence`, which this
search produced. "Direct semantic retrieval already produced an exact source-backed candidate" is therefore not
knowable before the search; it is an effect of it. The same holds for "the claim basis is already complete" and
"admitted evidence already binds the subject": both are states that only exist after admission. The two
genuinely-prior states — the logical slice-cache hit and the resident hot-neighborhood path — **already** short-circuit
the search (`runtime-graph-retrieval.ts:344` and `:357`), so the 2,252 invocations measured here are exactly those
that both of those preconditions already failed to catch.

**The oracle ceiling.** Skipping every invocation whose admitted evidence never reached a claim basis — which needs
the turn's outcome before the turn runs — is 845/2,253 invocations and **10.1% of attributable CPU**; 761 of those
845 are turns that produced no claim basis at all for reasons downstream of this operator (570 of them had admitted
evidence in hand). A *perfect* skip oracle recovers 10%; the knowable part of it, on turns that do produce a basis,
is **0.7%**.

## 4. The two readings, separated

The task asked whether this is (a) dead weight or (b) an uncounted guard. **Neither: it is load-bearing, and the
metric that condemned it was pointed at a different line of code.** (a) is refused by 1,408 invocations whose
admitted evidence is in the answer's own claim basis. (b) does not arise — no guard interpretation is needed to
explain the numbers.

## 5. Where the CPU actually goes, and the only honest lever

Cost scales with per-group fan-out, not with anything skippable:

| anchor groups | 0 | 1 | 2 | 3 | 4 | 5 | 6+ |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| mean ms | 527 | 1431 | 1225 | 2255 | 5068 | 3403 | **6361** |
| invocations | 7 | 217 | 251 | 420 | 137 | 297 | **924** |

924 invocations (41%) issue 6+ concurrent Postgres anchor-posting searches and average 6.4 s. The lever is **how
many groups are searched**, not **whether the operator runs**. That is a recall/cost trade-off — a modeling
parameter, so it belongs in the calibration registry with a fitted bound, never as an inline skip rule.

The memoization lever is weaker than it looks. 1,971 invocations repeat an earlier request text (19.6% of
attributable CPU), but only **52 of 252** repeated texts returned identical `gathered`+`admitted` on every repeat —
the corpus grows between runs ("who is ada lovelace": gathered 12 → 16 → 29, admitted stable at 8). Even
*same-process* identical repeats (270 invocations, 3.2% of CPU) matched the first result in only **147/270** cases.
A memo is not free: it needs a validity key over corpus state, which is exactly what the existing `logicalCacheKey`
deliberately omits (`runtime-graph-retrieval.ts:330`). Note `admitted` is far more stable than `gathered` — the
admission stage absorbs most corpus churn — which is where a cache-validity study should start.

## 6. Risk, stated as asked

No skip is recommended, so no turn loses a guard. For the record: had precondition D (the largest saving) shipped,
1,240 invocations would have lost the evidence their answer was scored on — 83% of all answered turns on this
traffic losing their claim basis. That is precisely the failure the "changed the answer" metric would not have
counted, and it is why this report recommends nothing.

## 7. What an implementer must collect before touching this operator

1. **Fix the counters first — one line.** Give `graph.resolve.anchor_evidence_search` a before/after pair that
   brackets the *search*, and give the code-span filter its own event. Until then no ROI statement about this
   operator is admissible, this report's cost attribution included.
2. **Per-group `durationMs`.** `perGroupCounts` already exists behind `SCCE_TRACE_GROUPS` and carries no timing.
   Group-level cost is the only evidence that can justify a group bound.
3. **For any group bound**: replay and show claim-basis identity per turn (set equality of
   `candidate.score.evidenceIds`), not answer-text equality, plus unchanged `proof.entailment.certifiedEvidence`,
   unchanged `contradiction.check` outcome, unchanged source qualification and unchanged admissibility tier.
4. **For any memo**: demonstrate the validity key. Two runs at the same corpus content hash must return equal
   admitted-id sets for the same request, and each of the 123 same-process mismatches above must be explained by a
   state change the key covers — otherwise the key is wrong.

## Honest limits

- Claim basis is `candidate.score.evidenceIds`; 761 invocations sit on turns that logged none, and this analysis can
  only say the operator was not decisive there, not that it was harmful.
- Id overlap uses the truncated `support.admitted` (8) and `support.gatheredHeads` (6) arrays, biasing measured
  usefulness **down**. The conclusion is robust in the direction that matters.
- 2,252 invocations here vs T12's 2,126: this mode counts every invocation inside a `turn.input`→`turn.output`
  window across the same 290 files; the ROI table keys the same events through the operator spec table.
- Same traffic caveat as T12: 282 distinct request texts, benchmark-shaped, not a controlled task distribution. A
  0.7%-recoverable reading here means "on this traffic", not "in principle".
