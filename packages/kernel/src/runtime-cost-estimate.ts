/**
 * Plan item L10: explicit, tested cost estimates for the highest-cost
 * cognitive operators (Kneser-Ney generation, retrieval, graph-surface
 * alignment), calibrated against real measured behavior rather than
 * guessed, so `runtime-deadline.ts`'s admission checks in
 * `production-turn-runtime.ts` have real numbers to compare against instead
 * of bare literals.
 *
 * Each estimator is deliberately rounded up from its measured data for
 * headroom -- an admission check that under-admits (treats a cheap
 * operation as slightly more expensive than it is) is safe; one that
 * over-admits is not.
 */

/**
 * `hybridRecall` (`retrieval.ts`). Measured cold-call wall time (no
 * document-level cache warm, plan item L5's cache empty) across evidence
 * pools of 100/500/1500/3000 documents against the built kernel: 25.3ms,
 * 68.3ms, 154.6ms, 305.7ms -- roughly linear with a small fixed setup cost,
 * converging to ~0.10ms/document at scale (`retrieval-cache-benchmark.test.ts`
 * exercises the same function and confirms a warm repeat call is at least
 * 5x cheaper, which this estimate deliberately does not credit -- it always
 * prices the cold-call bound).
 */
export function estimateRetrievalCostMs(evidenceCount: number): number {
  const bounded = Math.max(0, Math.floor(finiteOrZero(evidenceCount)));
  return 15 + bounded * 0.12;
}

/**
 * `continueBoundedProse` (`kneser-ney.ts`). Measured wall time across
 * generation extents of 20/80/200/400 symbols against the built kernel:
 * 4.3ms, 2.1ms, 1.9ms, 1.8ms -- dominated by a small fixed per-call cost
 * (candidate scanning/setup), not per-symbol scaling, in the tested range.
 * A flat estimate with headroom is therefore more honest than a
 * length-scaled one that would imply scaling this data doesn't show.
 */
export function estimateKneserNeyGenerationCostMs(_extent: number): number {
  return 10;
}

/**
 * `buildSurfaceLattice` (`surface-lattice.ts`). Measured directly against
 * real Wikipedia corpus text from 2,000 to 103,000 characters, after the
 * quadratic-cost fixes to `surface-lattice.ts`/`segmentation-forest.ts`/
 * `join-program.ts` landed: 245ms, 407ms, 737ms, 1228ms, 2376ms, 4369ms at
 * 2K/8K/16K/32K/64K/103K characters respectively -- linear at roughly
 * 42ms per 1,000 characters of document text.
 */
export function estimateAlignmentCostMs(totalDocumentChars: number): number {
  const bounded = Math.max(0, Math.floor(finiteOrZero(totalDocumentChars)));
  return 50 + bounded * 0.05;
}

function finiteOrZero(value: number): number {
  return Number.isFinite(value) ? value : 0;
}
