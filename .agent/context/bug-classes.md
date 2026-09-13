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

`SUBJECT_COMMUNITY_EPSILON = 1e-4` is an absolute residual threshold for a local-push PPR. When relation
potential rescaled edge weights 50-500x, the residual crossed it sooner and the subject community silently shrank.
Nothing was declared, nothing errored, retrieval just got narrower.

**362 instances of a bare decimal threshold exist.** In the answering path alone:

    retrieval.ts:233      item.alpha > 0.4          decides graph seeding
    retrieval.ts:428      graphScore > 0.2, alphaScore > 0.55, vectorScore > 0.45
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
