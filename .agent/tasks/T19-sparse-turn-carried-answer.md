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

## 2026-09-15 falsified: the leading-word rule is not the cause

The scaffolding lane removed `requestLeadingScaffoldingUnit` and re-ran the sparse-turn repro offline (kernel turn,
Einstein carrier, then "fuck off" / "thanks" / "no thats wrong"): the Einstein lead is re-served identically with
the rule present and with it removed. In that fixture the carry path never consults these units -- with no learned
closed class in the session, coverage units are `[]` by design (local-evidence-runtime:185). The stated cause was
wrong; the carry comes from elsewhere. Next: trace which stage re-serves the prior answer when the request has no
admitted evidence of its own, with a session that HAS a learned closed class.

## 2026-09-15 confirmed: the discourse binding suspends the turn's own admission

Traced with a kernel session that HAS a learned closed class (hydrated Kneser-Ney model, learned language identity,
interaction-corpus request frames). Stage by stage:

- `graph.resolve.discourse_bound` -- CARRIER. `discourseEvidenceBound` makes `sourceAnchorAudit`
  `{ required: false, evidence }`, so the whole carried pool is admitted unaudited. Falsified against itself: with the
  same session and no discourse metadata the pool is 0 and the turn withholds; with it, the carried span is spoken.
- session re-seeding (`runtimeEvidenceIds` / `sparseSessionFollowup`) -- not the carrier. Live the prior answer IS
  stored as a session span (`a36e1b4a546b`, 220 chars, `sessionAdmitted` 2/4/8) and admitted, but never reaches
  `candidate.selected_evidence`.
- `local_evidence.answerhood_order` -- not a gate at all. It reports `answering: 0` on every sparse turn and is
  documented as silent unless it discriminates. The comment promising it declines the carry is wrong; it only orders.
- candidate field / mouth -- not the carrier: one bound span in, `source_exact` out.
- `mouth.contradiction_fallback` -- the stage that spoke live. All five probe turns emit the identical 220 chars from
  the same span with `contradiction: 0.28` and `chosenChars: 0`. Already gated on main by
  `recitedEvidenceAdmissibility` (markup / apparatus / uncovered); needs live confirmation.

Fix: a discourse-bound turn keeps its own admission when the request's subject text carries content units (minus the
learned closed class) that no carried span carries. Measured negative result: request/evidence coverage cannot separate
a chat turn from an anaphoric follow-up -- `recitedEvidenceAdmissibility` returns `uncovered` for "what did he win" and
"when was he born" too, because a pronoun follow-up never names its subject.
