# Graph-Surface Alignment: Real Current Guarantees

Plan item 120. This documents what the graph-surface alignment pipeline
(`sparse-alignment-candidates.ts`, `sparse-fused-transport.ts`,
`typed-null-alignment.ts`, `population-ordering.ts`,
`cross-document-alignment.ts`) actually does, as observed from a real batch
run (`tools/graph-surface-alignment-batch-manifest.mjs`,
`npm run rehearsal:graph-surface-alignment-batch`), not aspirational
behavior. See `docs/SPARSE_ALIGNMENT_CANDIDATES.md` and
`docs/TYPED_NULL_ALIGNMENT.md` for the candidate-generation and null-mass
contracts this builds on.

## Pipeline

1. `compileSparseAlignmentTargetIndex` lifts hyperedges into a typed
   incidence graph and bounded postings (item 16).
2. `generateSparseAlignmentCandidates` materializes only
   `O(|S|K_Pi)` candidates per document (item 17; see the scaling proof in
   `sparse-alignment-candidates.test.ts`, "candidate memory does not scale
   with graph size").
3. `solveSparseFusedUnbalancedTransport` runs bounded-iteration Sinkhorn
   scaling plus local structural/ordering corrections and a bounded
   conditional-gradient pass, never a dense or globally-optimal solve
   (`globalOptimalityClaimed` is always `false`).
4. `solveSparseFusedUnbalancedTransportWithResourceBudget` wraps the solver
   with real per-batch resource usage (elapsed wall-clock time, iteration
   count, working-set byte estimate) without perturbing the deterministic
   plan itself (item 115).

## What a real batch run shows

Running the batch manifest tool against four synthetic documents (the
original sentence, a paraphrase of the same fact, an unrelated fact sharing
no vocabulary, and a document with no graph-relevant content at all) against
a two-relation graph produces genuinely different candidate counts and
objective components per document — nothing is templated or forced to a
fixed shape. All four batches reach `status: "converged"` within the
iteration budget in the recorded manifest, which is itself only a bounded
local optimum: `globalOptimalityClaimed` is `false` on every plan, and
`localStructuralApproximation: true` in the audit records that structural
and ordering costs are computed against a neighbor window
(`maxStructuralNeighbors`), not the full row/column.

One real, currently-unaddressed limitation the batch run surfaces: a
document with zero real lexical or evidentiary relation to the graph
(`"It rained heavily yesterday afternoon."`) still receives a nonzero
candidate count through the `surface_context` support kind (shared
left/right context sketches, e.g. common short tokens or punctuation). The
transport correctly assigns most of that document's mass to the
`surfaceNullMass`/`graphImplicitMass` dustbins (high
`graphMarginalResidual` in the manifest) rather than fabricating confident
alignments, but the candidate set itself is not yet as tight as it could be
for unrelated documents. This is a real property of the current
`surface_context` heuristic, not a bug fixed by this item — tightening it
is future work, not claimed here.

## Guarantees actually held

- Memory: candidate count is bounded by `|S|*K_Pi`, proven independent of
  graph size (`|G|`) up to ~2000x graph growth in the scaling test.
- Determinism: `solveSparseFusedUnbalancedTransport` is byte-identical
  across repeated calls with the same input and hasher (asserted in
  `sparse-fused-transport.test.ts`); resource-usage instrumentation is
  intentionally excluded from the plan itself so wall-clock variance never
  breaks this.
- Mass conservation: null/implicit dustbins absorb unmatched surface and
  graph mass explicitly (`typed-null-alignment.ts`); nothing is silently
  dropped or force-matched.
- No global-optimality claim: every plan is explicit that its Sinkhorn +
  local-correction solve is a bounded local approximation, not an exact
  transport solution.

## Guarantees not yet held

- `surface_context`-only candidates are not yet filtered by a stronger
  relevance threshold for documents with no real graph relation (see
  above).
- Cross-document alignment reinforcement (item 113) and independent
  held-out promotion for alignments (item 117) are implemented as separate
  modules (`cross-document-alignment.ts`, `alignment-heldout-evaluation.ts`)
  but this batch manifest exercises them only through the transport's
  `crossDocumentCost` term, not as a full multi-document reinforcement
  pass — the batch above ran per-document, not across the corpus as a
  reinforced unit.
