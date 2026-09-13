# Before the authoritative run

The final measurement is `sh tools/final-run.sh`: committed main only, one build, one corpus state, both systems,
all 311 rows. Everything a lane measured was measured against its own build; this is the run that decides.

## Blockers -- must be resolved or consciously accepted

- [ ] **`ANSWERHOOD_SCAN_CHARS = 60_000` (b15d8fd).** Undeclared in either calibration file, and it hides the
      back half of 1,016 spans (longest 131,072 bytes) from the answerhood test. L4 measured the feature at
      187 ms cold / 50 ms warm over a 24-span pool averaging 3,505 chars, against turns running 8-31 s -- so the
      cap buys little and costs evidence in exactly the long book spans the feature exists to search. Raised with
      L3. **If unresolved at the cutoff, remove the slice.**
- [ ] Every lane's fix committed to main. Nothing uncommitted under `packages/` -- `final-run.sh` refuses to run
      otherwise, deliberately.
- [ ] `pnpm -r build` green from PowerShell.
- [ ] Relation backfill finished and its final counts recorded.

## Order of operations

1. Lanes stop committing at the cutoff.
2. Re-ingest the repository code corpus -- `scce codebase ingest`. 384 of 831 tracked TypeScript files are
   absent and 33 more are truncated, which is why the code workload scores 0 of 6 while two of its six symbols
   are provably reachable. **This changes document frequency for every term, so it happens BEFORE the final run
   and AFTER every lane has stopped measuring**, or no two numbers in the suite are comparable.
3. `sh tools/final-run.sh`.
4. `node tools/results-page/build.mjs` and publish.

## What the final run is compared against

`artifacts/head-to-head/results-baseline-20260913.json`, frozen at 02:58 UTC. In correct-behaviour terms --
the right answer where one exists, a refusal where the corpus holds none -- that baseline is
**SCCE 164 of 311, reference 125 of 311**.

Use the runner's own verdicts. Do not regrade a results file written before 2026-09-13: the runner stored only
the first 300 characters of an answer while grading the full text.
