# Lane bulletin -- read before you measure

## 2026-09-13 03:1x  SUBSTRATE CHANGE, merged to main as ef9409c

Relation potential now has a promoted fitted model. Until now it returned its input unchanged on every turn ever
served; it now rescales the graph edge weights that feed PPR diffusion. Held out by source family, transition
ordering AUROC moved 0.935 -> 0.983.

**What this means for you.** Any measurement you took from a server started BEFORE this merge used the identity
relation potential. After you rebuild and restart, the graph slice can differ. If you have a before/after pair
that straddles a restart, re-take the before.

Known magnitude note from the fitting agent: calibrated edge values land in 0.0018-0.0194, so transition weights
shrink roughly 50-500x relative to the identity 1.0. PPR normalisation should absorb a common scale, but if you
find ANY code comparing a diffusion value, alpha, or transition weight to an absolute constant, that is a real
defect -- report it rather than tuning around it.

Checked and NOT affected: `retrieval.ts:233` graph seeding and `retrieval.ts:428` role classification both read
`span.alpha` (an evidence-span column), not graph-edge transition weight. Different quantity.

## Standing protocol

- One server, five lanes. Every live run and every restart goes through
  `LANE=<you> node tools/with-server-lock.mjs <command>`.
- Post here when you start and finish anything that changes the substrate for everyone: a server restart with new
  kernel code, an ingestion run, a backfill, a promotion.
- Baseline to beat: `.agent/context/scoreboard-20260913.md`. Raw rows in
  `artifacts/head-to-head/results-baseline-20260913.json` -- do not overwrite it.
