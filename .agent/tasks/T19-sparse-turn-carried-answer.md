# T19-sparse-turn-carried-answer

status: open
claimed_by:

A request naming no corpus subject binds to the discourse carrier's evidence (`discourse-state.ts`, kernel
`anaphoricFollowUp` / `graph.resolve.discourse_bound`), and the answer lanes then speak a carrier sentence that
carries none of the request's units. Offline at 0fef3cd with an Einstein carrier: "no thats wrong", "fuck off" and
"thanks" each returned the Einstein lead verbatim, `assistantForce: source_grounded_answer`.

The kernel comment promises the answerhood gate declines this. It cannot: `local_evidence.answerhood_order` reports
`coverageUnits: []` for "thanks" because `requestLeadingScaffoldingUnit` (local-evidence-runtime.ts) removes the first
whitespace word when it is at most 5 characters, a word-position rule with a hand-set length. The only content unit of
a one- or two-word chat turn is removed and the gate passes vacuously.

A redundant path feeds the same carry: `sourceSurfaceStrongEnough` in `server/src/routes.ts` decides session evidence
reuse from casing and length constants (8, 11, 4, cased run 2). Live values: "whats up" false, "who is albert
einstein" true, "no thats wrong" true, "fuck off" false, "thanks" false. Turns 4 and 5 of the probe were bound at
kernel init through it, but removing it does not change the outcome: offline without `sessionContextEvidence` the same
turns carry through `discourse_bound`. Replace both with a measured test (closed class, corpus identity) and keep the
2026-09-12 pronoun follow-ups ("where and when was he born?") answering.
