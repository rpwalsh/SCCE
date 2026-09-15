# T12-per-referent-candidates

status: open
claimed_by:

An owner's typed referent correction is hydrated (same process and after a restart) but cannot change the answer,
because the candidate field never offers one candidate per admissible referent.

Measured offline at 5829b1c by `packages/kernel/src/__tests__/dialogue-correction-restart.test.ts` (the `it.fails`
case pins it): two promoted spans, "Mercury (planet)" and "Mercury (element)", request "What is Mercury?".

- `dialogue.preselection` lists both referents (`node:evidence:mercury-element`, `node:evidence:mercury-planet`).
- The field holds exactly two candidates (`proof-answer`, `graph-inference`) and both carry
  `evidenceIds: [evidence:mercury-element, evidence:mercury-planet]`; the PCA cites only the element span.
- `applyDialogueInterpretationAdjustmentsV2` maps each candidate to two referents and takes its
  "ambiguous, leave neutral" branch, so `selectionAdjustment` and `audit.typedDialogueSelection` stay unset.
- The correction still reaches `resolveDiscourseStateV2`: the next state's bindings carry
  `interpretationAdjustmentIds: [<id>]`, the rejected referent drops below the confidence floor
  (`disc2.r.99f31a60`) and the state degrades to 0 admitted bindings instead of switching, because the projection
  keeps only PCA-cited evidence and the preferred referent never becomes a persisted referent (no `alternatives`).

Consequences to fix, in order:
1. Candidate generation must emit one proof-bearing candidate per admissible referent (each carrying only that
   referent's proof evidence) whenever preselection reports more than one referent for a mention.
2. The projection must persist the runner-up referent(s) so `binding.alternatives` is non-empty; otherwise the
   server's `validatedInterpretationCorrection` rejects the owner's correction with 422 and the path above is
   unreachable from `/api/turn/outcome`.
3. Server-derived corrections take `scopeIds` from the rejected referent's source version, so the preferred
   referent's support bonus never matches a candidate from another source; only the rejection penalty acts.

When 1 lands, flip the pinned case from `it.fails` to `it`; it asserts the answer contains the planet span and
`selectedCandidate.audit.typedDialogueSelection.adjustmentIds` equals the persisted adjustment id.

Offline only. Do NOT start or restart the server; one server and one database are shared.
