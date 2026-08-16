# Proof-constrained decoding: real current state

Plan item 145. Documents Phase 11's real, current guarantees as of
2026-08-15 (items 131-144, all done). Not an architecture overview --
`docs/SCCE_MAP.md` covers that -- a precise account of what this
pipeline actually is, module by module, and what it does not yet do.

## The pipeline, in dependency order

1. **`proof-license-semiring.ts`** (items 133-135): the algebraic core.
   A proof-license carrier is a finite map from proof-license state to a
   base-semiring value. `multiply` (combining two subderivations) unions
   compatible states and drops incompatible pairs entirely -- never
   multiplies an incompatible pair down to zero, which would leave a
   phantom entry behind. `add` (alternative derivations of the same
   state) only combines identical state keys. Two distinct, separately
   labeled base semirings exist and must never be conflated: `viterbiLogSemiring`
   (`add`=max, `multiply`=`+`, for best-single-derivation search) and
   `totalProbabilityLogSemiring` (`add`=log-sum-exp, `multiply`=`+`, for
   total probability mass over every derivation). 20 property tests over
   bounded-exhaustive enumeration prove real semiring laws (closure,
   associativity, identity, distributivity) against the implemented
   carrier, not assumed.

2. **`derivation-chart.ts`** (items 131-132, 136, 139): a packed
   graph-derivation forest chart, one cell per distinct
   `(coverage, discourseState, population)` key. `combineCells` refuses a
   combination whose two operands' coverage sets overlap -- the same
   reason real chart parsing (CYK-style) requires combined constituents'
   spans to partition, not overlap: allowing it would let one fact enter
   an extracted derivation twice. Pruning of unsupported combinations
   happens *inside* `combineCells` itself (item 136) -- there is no
   intermediate "insert then filter" step. `extractDerivations` walks
   backpointers memoized per cell, so a cell shared by two different
   larger derivations is walked once and reused (item 132's "no
   duplicate identical work"), bounded by a real, finite `maxDerivations`
   cap.

3. **`tree-decomposition.ts`** (items 137-138 support): a real, bounded
   tree decomposition via greedy minimum-degree elimination -- the
   standard practical treewidth heuristic (exact treewidth is NP-hard).
   Verified against known-treewidth ground truth: trees and stars have
   width 1, cycles have width 2, `K_n` has width `n-1`. Deterministic
   (tie-broken by node id), and structurally validated (every original
   edge covered by some bag, every bag's parent chain reaches a root with
   no cycles).

4. **`bounded-chart-decoding.ts`** (items 137-139): the real decoder that
   ties the above together. Walks a tree decomposition bag by bag in
   real bottom-up post-order, each bag introducing only its own freshly
   eliminated atom and folding in each child bag's already-carried-up
   subtree result (standard treewidth-DP message passing) -- replacing
   the malformed `O(2^k)`-over-everything complexity form with the
   correct `O(m, d^{k+1}, poly(K))` bound: exponential only in the
   decomposition's own width `k`, never in the whole query graph's atom
   count `m`. When the real treewidth exceeds the caller's budget (item
   138), repeatedly removes the single highest-degree atom (the one most
   responsible for the width) as its own discourse-linked partition
   rather than failing outright; every excluded atom is still inserted
   into the chart and given a real chance to combine back in via any
   connecting edge -- `combineCells`'s own coverage-disjointness check
   still guards against double-counting a discourse-linked atom. Item
   139's "long-answer, graph-complete, nothing flattened" guarantee: a
   full 5-atom chain and a 5-node star both decode to one goal cell whose
   extracted derivation individually recovers every original leaf atom,
   not a subset and not a fabricated extra.

5. **`semantic-round-trip.ts`** (items 142-143): real
   `A -> Realize -> Interpret -> Ahat` round-trip validation, built on
   `semantic-proof-system.ts`'s `atomizeText` for both "Interpret" steps
   (this module never invents its own separate text understanding).
   Real bipartite atom matching (predicate + token-level role overlap via
   `weightedJaccard`, plus a same-claim-shape structural fallback for the
   case where every argument value changed at once) decomposes into all
   8 named dimensions: missing, added, reversed (a genuine role-value
   swap), quantity, time, polarity, modality, discourse-force (a real
   surface signal -- sentence-final punctuation -- not a fabricated
   classifier). The hard factual gate (`factualRoundTripGate`) rejects
   outright the instant any real `Added` atom appears -- a hallucinated
   claim never gets a soft penalty, it is refused -- and returns the full
   cycle trace (both atom sets, the complete distance decomposition) on
   every call, accepted or refused. Verified to work across scripts, not
   just English (a real Chinese quantity-mismatch case), matching this
   codebase's multilingual design elsewhere.

6. **`clarification-question.ts`** (item 144): real expected-information-
   gain clarification question selection over a set of weighted competing
   hypotheses, using the standard Shannon entropy-reduction formula
   (`H(hypotheses) - E[H(hypotheses | answer)]`) -- the same real quantity
   decision-tree question selection (ID3/C4.5) and optimal 20-questions
   search use. Among candidates tied on maximum expected information
   gain, prefers the smallest real graph separator (the smaller of the
   two yes/no-partitioned hypothesis groups) -- a minimal, surgical
   clarification over an equally-informative but broader one.

## What this pipeline does not yet do

- **Item 140-141's fix** (Kneser-Ney restricted to fluency-only ranking)
  lives in `language-memory-runtime.ts`, not this pipeline directly --
  documented in `docs/PRODUCTION_COMPLETION_PLAN_250.md`'s Phase 11
  section, not duplicated here.
- **No live call site yet.** Every module above is real and tested in
  isolation; none of them is yet wired into `production-turn-runtime.ts`
  or any other live turn path. This mirrors the same
  implementation-without-behavioral-integration pattern already
  documented for several other phases (13, 14, 17, 18) in
  `docs/IMPLEMENTATION_STATUS.md` -- wiring this into a real factual-
  answer turn path is separate, not-yet-attempted work, not a gap in the
  modules themselves.
- **`bounded-chart-decoding.ts`'s atom/edge inputs are caller-supplied.**
  Nothing in this pipeline yet derives real chart atoms and combination
  edges from a live semantic-proof search or graph query -- that
  derivation step (turning a real query graph `Gamma_q` into
  `BoundedDecodingAtom`/`BoundedDecodingEdge` inputs) does not exist yet.
- **`clarification-question.ts`'s hypothesis/fact inputs are also
  caller-supplied.** Nothing yet derives a real weighted hypothesis set
  and candidate distinguishing facts from an actual ambiguous turn.
- **Viterbi/log-sum-exp distinction (item 135) is implemented and tested
  at the semiring level** but no caller yet exercises both base semirings
  against the same real chart to compare best-derivation vs
  total-probability-mass results side by side on real data.
