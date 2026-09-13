# Lane B-THRESHOLDS -- an absolute constant compared against a learned quantity

Scope: `retrieval.ts`, `field.ts`, `sparse-ranking.ts`, `ppr-local-push.ts`, `alpha.ts`,
`semantic-memory-index.ts`. Everything below is measured; where I disproved something I say so before saying
what I changed.

## Headline

**One constant of this class in my scope decides anything, and it is not one of the four I was given.** The four
starting points are all in paths whose output nothing reads. The real one is the push criterion in
`ppr-local-push.ts`, the algorithm underneath `SUBJECT_COMMUNITY_EPSILON` -- and its mechanism runs in the
opposite direction to the one the bug-class note describes.

    FIXED     ppr-local-push.ts  the push criterion is now invariant to a uniform rescale of edge weight  (c5e4862)
    HANDED    field.ts:400       a four-character minimum decides what the field treats as content
    DISPROVED retrieval.ts:233   graphSeeds is consumed by nothing, anywhere in the repo
    DISPROVED retrieval.ts:428   the role it decides reaches a trace label and no decision
    DISPROVED semantic-memory-index.ts:636  explanationFor builds display strings

## 1. FIXED -- `ppr-local-push.ts`, the criterion the subject-community walk stops on

### The defect, with the line

`mostPushableNode` (`packages/kernel/src/ppr-local-push.ts:98` before the fix):

    const score = degree > 0 ? mass / degree : mass;
    if (score > bestScore) { ... }          // bestScore starts at epsilon

`degree` is the **weighted** out-degree -- a sum of the caller's edge weights. `mass` is scale-free (mass is
conserved at 1 by the algorithm's own invariant), so the whole scale sensitivity sits in the denominator.
Multiply every edge weight by `c` and every degree scales by `c`, so `mass/degree` scales by `1/c` and the
comparison against a fixed epsilon moves.

The production caller is `evidenceInSubjectCommunity` (`production-turn-runtime.ts:5449`), which builds the push
edges as `weight: Number(edge.alpha)` from `graph_edges.alpha` -- a learned column -- and passes
`SUBJECT_COMMUNITY_EPSILON = 1e-4`.

### Three things I disproved on the way

**(a) The direction in `bug-classes.md` is inverted.** "The residual crossed that epsilon sooner, the subject
community silently shrank" -- the opposite. Smaller weights mean smaller degrees, so `mass/degree` is LARGER,
so MORE nodes clear epsilon. Measured, one 400-node slice, one epsilon of `1e-4`, nothing changed but a uniform
multiplier on every weight:

    scale   nodes reaching nonzero mass   pushes   community size (max 64)
      100                            15       19                       15
       10                           120      190                       64
        1                           400    2617                       64
      0.1                           400     5500                       64
     0.002                          400   10414                       64

Smaller weights grow the community AND the cost; larger weights collapse it. A 500x shrink is a 4x CPU increase
on a turn with a 10 s ceiling, not a narrowing.

**(b) `ef9409c` does not reach this epsilon.** `scoreGraphEdgesWithRelationPotential`
(`relation-potential.ts:321`) returns `Object.freeze({ ...edge, alpha: scoredAlpha })` -- new objects, the input
array unmutated -- and it runs inside `fieldEngine.activate` (`field.ts:85`), which the turn calls at
`production-turn-runtime.ts:~1730`. `evidenceInSubjectCommunity` runs at `:1576`, 150 lines earlier, on the
un-rescaled graph. So the community walk has never seen a relation-potential-scored alpha. The mechanism is
real; the attribution to the relation-potential merge is not.

**(c) At the corpus's current slice size the epsilon decides nothing.** From the authoritative run's own trace
(`.scce/traces/2026-09-13T20-00-39-376Z-...jsonl`, `graph.resolve | kernel.turn.graph_slice`, 290 turns): the
slice is **at most 16 nodes and 32 edges**, and is empty on most turns. At that size the walk reaches every
reachable node and converges at every scale I tested -- identical membership, only the push count moves
(277 -> 508 across a 50x rescale). The community admission that IS firing -- 64 turns, 521 spans dropped, e.g.
`abraham lincoln` 24 -> 3 -- is decided by which nodes are in the 16-node slice and what evidence ids they carry,
not by epsilon. So this defect is **latent today and grows with the slice**; do not credit any current benchmark
row to it.

### The fix

Degree is a SUM of weights, so its natural unit is the mean weight. `mostPushableNode` now divides the weighted
out-degree by the graph's own mean edge weight before comparing against epsilon. Two properties, both asserted:

- A uniform rescale of every weight cannot move the criterion. `mass` was already scale-free; now the
  denominator is too.
- On a graph whose edges all carry the same weight, `weightedDegree / meanWeight` is exactly the **count** of
  out-edges -- which is the unweighted degree Andersen-Chung-Lang define the criterion on. The module's own
  docstring cites that paper; this makes it true rather than approximately true.

Dangling nodes are unchanged: their whole residual is compared directly, and residual is already scale-free.

### The regression check

`packages/kernel/src/__tests__/ppr-local-push.test.ts`, a new describe block, five assertions. With the
normalization removed, **all five fail**:

    a five-node cycle                                      expected 100 pushes to be 57
    unequal weights with a dangling node                   expected 220 pushes to be 72
    weights drawn like the learned graph_edges.alpha       expected 644 pushes to be 302
    a uniform-weight graph reduces to the degree count     expected 61 pushes to be 57
    the community a rescaled slice admits (400 nodes)      two different 64-node sets

The third and fifth cases draw weights across the live `graph_edges.alpha` range (min 0.066, max 1.0, mean 0.509,
measured over 200,000 rows) and mirror every edge, which is what the production call site does. The fifth is at
400 nodes deliberately: at the live 16-node slice it cannot discriminate, and the test says so in its docstring
rather than pretending otherwise.

No existing assertion was changed or weakened. `ppr-local-push.test.ts` and
`admissible-community-expansion.test.ts` are 20 of 20 green; `npx tsc --noEmit -p packages/kernel` is clean. The
only existing fixture with unequal weights (`DANGLING_GRAPH`, weights 3/1/1/1) asserts residual and error
*upper* bounds, and the normalization makes both smaller.

I did not emit into `packages/*/dist`, so no lane's running server changed under it.

## 2. HANDED OVER -- `field.ts:398` decides what is content with a character count

Not my class strictly -- the quantity it compares against is spelling length, which is not learned at all -- but
it is the largest deciding magic number in my six files and it has a learned instrument sitting unused.

    function isInformationBearingUnit(unit: string): boolean {
      const clean = unit.normalize("NFKC")...;
      if (clean.length < 4) return false;      // field.ts:400
      ...
      return alphaNumeric >= 4;                // field.ts:403
    }

Call chain, all live: `isFieldActivationFeature` -> `fieldRequestFeatures` / `fieldNodeFeatures` ->
`seeds` (`field.ts:69-82`) -> the whole query diffusion, `ppf`, `active`, and from there
`composeEvidenceGroundedAnswer` at `production-turn-runtime.ts:2643`.

Measured over the 311 benchmark prompts (`artifacts/head-to-head/results-baseline-20260913.json`), it drops
31-51% of request units per workload. What it keeps and drops is the whole finding:

    kept as "information-bearing"   with:197  from:184  this:168  only:165  what:77  which:44  that:16  were:16
    dropped as not                  the:733   of:212    in:142    and:123   who:35   ada:19    did:15  how:9

`what`, `which`, `with`, `from`, `this`, `only` survive because they are four characters or more. `ada` -- the
given name of a benchmark subject -- is dropped because it is three. This is an English spelling-length
coincidence standing in for a closed class, and it is wrong in both directions.

The instrument that replaces it already exists and is already trusted elsewhere:
`deriveClosedClassWords` (`closed-class-words.ts:63`), order-1 Kneser-Ney continuation diversity. Its own
comment makes exactly this argument: *"'a' and 'i' continue thousands and stay closed-class at one character,
and a single-character Hani content word continues almost none."*

**Why I did not do it.** The fix needs the hydrated closed class to reach `field.ts`, and the only production
construction of `createAlphaFieldEngine` is `production-turn-runtime.ts:49` -- a file this lane was told not to
touch, with two lanes' live work in it. Shipping the `field.ts` half alone would be a parameter with no
production caller, which `feedback_unused_is_unimplemented` calls unimplemented.

**The shape, for whoever owns that call site.** `production-turn-runtime` already computes `closedClassWords` for
`evidenceForRequest`, so the value is in hand: pass it into `activate`'s input, thread it to
`isInformationBearingUnit`, return `!closedClass.has(unit)` when the class is hydrated, and keep today's length
rule as the explicitly-declared bootstrap default for a cold turn. I will make that change if the region is
handed over; I am not reaching into it.

Caveat worth stating: `current-known-bugs.md` #1 records that ablating query diffusion does not move the
benchmark. If that holds, this is a correctness defect in a component with no measured contribution -- worth
fixing for what it says about the seeds, not worth predicting a row gain from.

## 3. DISPROVED -- three of the four starting points decide nothing

**`retrieval.ts:233` `item.alpha > 0.4` and `.slice(0, 32)`.** These build `graphSeeds`. Repo-wide, `graphSeeds`
appears in exactly five places: its type declaration, this line, the returned plan, the audit blob, and a `[]`
in the evaluation bypass stub. **No consumer exists** in kernel, server, ui, adapters, cli or tools. The
threshold and the cap decide the contents of an audit field.

**`retrieval.ts:428` `graphScore > 0.2 || alphaScore > 0.55 || vectorScore > 0.45`.** This is the fallback arm of
`classifyEvidenceRole` and only chooses between `"support"` and `"source_context"`. That role reaches
`retrievalRoleTracesFromHybridRecall` -> `launchContractForTurn` -> the `retrievalRoles` contract field and one
`featureScore` whose value is `roleConfidence(role)`. `calibrationStatusFor` counts *whether* traces are
calibrated, not their values, and `runtimeCalibrationSummary`'s `rawScore` is computed from entailment alone.
Nothing branches on the role but `kernel-local-evidence-anchor.test.ts:212`.

More generally: **the whole `hybridRecall` call in a production turn is trace-only.** `production-turn-runtime.ts:1677`
takes `roleRetrieval` and uses it for `retrievalRoles`, a trace count, and an event payload. The retrieval that
actually decides is `semanticMemory.search`, whose `candidates` feed `queryConditionedSemanticSeedAnchors`. So
`retrieval.ts`'s BM25 parameters, its `0.38/0.24/0.22/0.16` recall blend and its role confidences are all
inert with respect to an answer. `compileCorpusIndex` from the same file IS live (it backs
`slice.corpusIndex`, used for length normalization in `lexicalSearch`).

**Correction to the bulletin's 03:1x and 10:32 notes.** Both say `retrieval.ts:428` is unaffected by the
relation-potential rescale because it "reads `span.alpha`, an evidence-span column, not graph-edge transition
weight". That is true of `alphaScore` and **false of `graphScore`**: `graphScore` is `graphSignal.mass`, and
`graphEvidenceSignals` (`retrieval.ts:305`) sets an edge's mass to `edge.alpha * edge.weight` -- precisely the
transition weight. `graphScore > 0.2` *is* an absolute constant compared against a rescalable transition weight.
It happens not to matter, for the separate reason above. The general lesson: a variable's name is not a
reachability check.

**`semantic-memory-index.ts:632-637`.** `explanationFor` builds the `explanation: string[]` on a candidate.
`explanation` is read in exactly one place -- `diagnostics.top` in the same file. Display.

## 4. Inventory -- everything else in the six files, and why I left it

Deciding and left alone deliberately, because these are weight vectors rather than thresholds and changing a
ranking while the authoritative run is in flight invalidates every lane's before/after:

| where | what | note |
| --- | --- | --- |
| `semantic-memory-index.ts:490` | `0.32 lex + 0.29 vec + 0.2 graph + 0.1 temporal + 0.09 alpha + 0.08 fit` | LIVE, decides candidate order. **Sums to 1.08**, so `clamp01` is reachable and a near-perfect candidate saturates and ties. One calibration object, the shape the judge-weight fitter already handles. |
| `semantic-memory-index.ts:452` | `0.45 direct + 0.28 evidence + 0.22 feature + 0.05 alpha` | LIVE graph prior, sums to 1.00. |
| `semantic-memory-index.ts:416/432` | `(0.6 + 0.4*alpha)`, `(0.55 + 0.45*alpha)` | LIVE alpha modulation of lexical and vector scores. |
| `semantic-memory-index.ts:450` | `evidence ? 0.8 : 0` | LIVE indicator weight. |
| `semantic-memory-index.ts:624` | `temporalFit` returns `0.5` when absent | Class C sibling. Cancels when no temporal query is set; asymmetric between node and evidence candidates when one is. Low reach -- `query.since/until` is effectively never set. |
| `retrieval.ts:309` | hyperedge weight defaults to `0.25` when absent | Class C sibling, in the trace-only path. |
| `field.ts:119/154` | `restartProbability: 0.15` | Teleport probability. A probability, scale-free. Undeclared but not this class. |

Correct as they stand, and worth naming so nobody "fixes" them:

- **`alpha.ts` is already the pattern.** `empiricalNormalization` takes the observed strength sample and cuts it
  at its own type-7 quantiles; `EMPIRICAL_QUANTILE_PROBABILITIES = [0.2,0.4,0.6,0.8]` are quantile
  *probabilities*, invariant to any rescale of the values. `EMPTY_SAMPLE_THRESHOLDS` applies only when there is
  no sample at all, which is the one case where nothing can be derived.
- **`field.ts:121` `tolerance: 1e-10`** is compared inside `ppf.ts:162` against `l1Distance` of a vector that
  `normalizeVector` re-normalizes every iteration, so it is already scale-free. The global solver got this
  right; the local solver in `ppr-local-push.ts` was the one that did not. That contrast is the clearest
  statement of this bug class I found.
- **`sparse-ranking.ts`** holds BM25's `k1 = 1.2` / `b = 0.75` and FTRL's `alpha`/`l1` learning hyperparameters.
  Standard algorithm parameters, not thresholds on learned values. They should be declared; they are not
  defects. Same for the `+0.5` IDF smoothing in three places.
- **`semantic-memory-index.ts:309-349`** shard fractions of `residentSafetyBoundBytes` are memory cost bounds
  and say so.

## 5. What I did not measure

No live run. The lock was held by the 311-row authoritative run until ~23:40 UTC and my one change is measured
identical at the live slice size (16 nodes), so a lock slot would buy nothing I can attribute. If anyone runs
`factual` on a build carrying `c5e4862`, the prediction on record is **no row changes**; a row that does change
falsifies the slice-size argument above and should be reported.

## 6. Handoffs

- **`field.ts` closed class** -> whoever owns `production-turn-runtime.ts`. Section 2 has the call chain, the
  measurement and the patch shape.
- **`SUBJECT_COMMUNITY_EPSILON = 1e-4`** (`production-turn-runtime.ts:5440`) still wants declaring in
  `calibrations/`. Post-fix it is scale-free, so it now means one thing -- "residual per typical edge" -- and is
  a legitimate declared modelling parameter rather than a coincidence. Same for `SUBJECT_COMMUNITY_ALPHA` and
  `SUBJECT_COMMUNITY_MAX_NODES = 64`; the last one is the binding constraint on community size at any slice
  large enough to matter.
- **`launch-contract.ts:294-296`**, outside my scope and unowned as far as I can tell:
  `entailment.contradiction > 0.4`, `support >= 0.78`, `faithfulnessLcb >= 0.65` decide `truthState`
  (`truth.contradicted` / `truth.certified` / `truth.source_bound_only`). Three absolute constants on three
  learned quantities, and unlike everything in section 3 this one *is* consumed. It is the biggest unclaimed
  instance of this class I saw.
