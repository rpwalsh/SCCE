# Bug classes, not bug instances

Owner doctrine, 2026-09-13: "if you see code that matches a bug you've already fixed, you should fix the entire
class of bugs across the board." The target is not BM25 and not a 3B model. Every fix below is scoped by that.

Four classes were each found the expensive way tonight -- by a measurement being wrong, not by reading. Each was
then found to have siblings. The siblings are the work.

## Class A -- silent truncation that decides reachability

A `.slice(0, N)` over text or candidates makes everything past N invisible, and downstream it reads as "the
corpus does not contain this". Found four times tonight:

    tools/head-to-head/run.mjs        stored 300 chars of an answer it graded whole -> 30 false verdict changes
    ANSWERHOOD_SCAN_CHARS = 60_000    hid the back half of 1,016 spans from the answerhood test
    near-duplicate slice 12_000/4_000 gates the single test cloze is won by; bites book-length spans
    repo ingestion                    stopped 1.7KB before the symbol the benchmark asks about

**1,242 instances of `.slice(0, N)` exist in kernel and adapters.** Most are display, audit or preview and are
fine. The rule that separates them: does anything downstream treat the truncated result as complete? If yes it is
a defect, whatever its motivation.

**Bound the work, do not truncate the input.** Where a bound is genuinely needed it is a declared calibration,
because a bound that changes which evidence is REACHABLE is a modelling parameter however it is motivated.

## Class B -- an absolute constant compared against a learned quantity

`SUBJECT_COMMUNITY_EPSILON = 1e-4` is an absolute residual threshold for a local-push PPR, and the push criterion
compares `residual / weighted-out-degree` against it. `residual` is scale-free but the degree is a sum of learned
edge weights, so the criterion moves when those weights are rescaled.

**CORRECTED 2026-09-13 22:5x, twice, by the lane that measured it.** My original claim here was wrong in two ways
and lanes acted on it: (1) I said relation potential reaches this walk. It does not --
`scoreGraphEdgesWithRelationPotential` returns new frozen edges inside `fieldEngine.activate`, which runs ~150
lines AFTER `evidenceInSubjectCommunity`, so the community walk has never seen a rescaled alpha. (2) I said
shrinking weights narrows the community. It widens it: smaller weights mean smaller degrees, so `residual/degree`
is LARGER and there are MORE pushes. Measured on one 400-node slice at fixed epsilon, x100 gives 19 pushes over
15 nodes and x0.002 gives 10,414 over 400. A 500x shrink is a 4x CPU cost, not a narrowing.

The CLASS is still real and the fix shipped: the push criterion now divides degree by the graph's own mean edge
weight, which on a uniform-weight graph is exactly the unweighted degree count Andersen-Chung-Lang define the
criterion on. Five assertions fail without it. But the instance I used to introduce the class was misdiagnosed,
and a doctrine written from an unmeasured example sends every lane that reads it in the wrong direction.

**362 instances of a bare decimal threshold exist.** In the answering path alone:

    field.ts:400          clean.length < 4          decides what the field treats as content -- MEASURED LIVE:
                                                    keeps with/from/this/only/what/which, drops who/ada/how.
                                                    A spelling-length coincidence standing in for a closed class.
    launch-contract.ts:294-296  contradiction > 0.4, support >= 0.78, faithfulnessLcb >= 0.65  decide truthState
    NOT retrieval.ts:233/:428   -- these decide NOTHING. `graphSeeds` has no consumer anywhere in the repo, and
                                   the whole `hybridRecall` call in a production turn is trace-only. The retrieval
                                   that decides is `semanticMemory.search`. I spent an hour on dead code.
    local-evidence:227    span.alpha * 0.18, lexical >= 0.025
    local-evidence:2141   candidate.quality >= 0.56
    local-evidence:3783   support >= 0.34 decides inferred vs conjectured
    production-turn:1328  authorityProjection.scoreMargin < 0.12
    production-turn:2224  proposalContradiction < 0.72
    mouth.ts:1880-1882    detail >= 0.58, >= 0.68, <= 0.32

These are the hand-tuned coefficients the owner has objected to for weeks. A threshold on a learned quantity must
be derived from that quantity's own observed distribution -- Otsu is the project standard -- or declared in
`packages/kernel/src/calibrations/` with what it is and where it is used. A constant that survives a rescale of
its input is not a threshold, it is a coincidence.

## Class C -- an absent measurement defaulted to zero

`evidence: result.evidence ?? 0` made an HTTP 422 decline indistinguishable from a retrieval miss. Three lanes
chased that difference; I called it the largest unexplained regression in the system. It was a default.

**1,332 instances of `?? 0` exist.** The rule: zero is a measurement, absent is not. If the field can legitimately
be unknown, the default is `null` and the consumer must handle it. `?? 0` is correct only where zero is the true
value of an absent thing -- a count of nothing is zero; a count that was never taken is not.

## Class D -- a memo without a validity guard

`sourceEvidenceAnchorsForRequest` memoized by request text for the life of the process with no
`corpusIdentityGeneration()` guard, and its first caller ran 43 lines BEFORE the corpus identity was primed. The
consequence: the corpus's own title had never reached the anchors on any request the system had ever served.

**10 candidate sites.** The rule: a memo keyed on an input must also be keyed on every piece of state that
changes the answer, or invalidated when that state changes.

## How to work this

Triage by blast radius, not by count. A slice in an audit preview is not a bug. A slice in the answering path
is. Order: what decides retrieval, then what decides admission, then what decides what is spoken, then the rest.

Every fix carries a regression check that fails without it. Nothing ships unmeasured. A fix that cannot be
measured against the 311-row suite is a fix nobody can defend.
