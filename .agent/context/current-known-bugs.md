# Open, with evidence

Ranked by threat to the claim that bounded cognition replaces a model.

1. **The cognitive math is not shown to contribute.** The repo's own ablation says removing graph, PowerWalk,
   query diffusion, relation potential and language memory does not hurt the benchmark, and some removals improve
   it. Closing this needs tasks that REQUIRE each component, not a re-run of the same suite.
2. **9 of 40 declined when answerable** in the measured head-to-head. The ceiling is 38, not 29. Worth more than
   any latency work, and now the single largest recoverable block: the anchor-search "waste" that looked bigger
   was a counter defect, retracted in dead-ends.md.
3. **The coding lane emits no algorithm.** It builds and runs real JavaScript with a working repair loop, but the
   requested function arrives as a checked contract, not an implementation.
4. **1 of 56 calibration ids is genuinely fitted**, and the learning loop has no negative signal.
5. **find/found** unsolved; see dead-ends.md.
6. **Multilingual is thin.** Non-Latin identities and titles now exist and the naming path works in 10 of 13
   writing systems, but no graded non-English question yet answers from a non-English source.
7. **Sealed set at 142/168** against a 165 baseline. The 36 new book and code items have never been run live.
8. Two pre-existing red tests whose premises are now false: a fixture whose "real answer" was a verbatim echo of
   its own request (the echo gate correctly refuses it), and one whose `listNgramModels` returns `[]` so nothing
   caches. Both need fixture work, not production changes.
