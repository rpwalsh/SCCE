# Translation (Phase 10, items 121-130)

Real current state of the graph-semantic translation rebuild
(`packages/kernel/src/translation.ts` and its collaborators), including
what it genuinely does not do. Written per plan item 130; keep this
honest — update it when the code changes, and prefer `repo_callsites`
over this prose when they disagree.

## Pipeline (what a `plan()` call actually does)

`createTranslationEngine().plan()` — the one production entry point,
called live from `production-turn-runtime.ts` when a turn resolves a
`translationTarget`, and from `scce-runtime.ts`'s source-only harness:

1. **Target resolution** — `selectTargetLanguageProfileCluster` resolves
   the caller's target-language string against real learned
   `LanguageProfile` clusters plus admitted evidence
   (opaque-id / evidence-alias / source-alias bases, scored with a
   margin; `translation-target-evidence.test.ts`).
2. **Frame extraction** — source text and each admitted target-language
   evidence span become `TranslationSemanticFrame`s (`framesFromText`
   over `semanticWindows`): symbols, features, role shapes, embedding.
3. **Seed induction (per-request)** — the request's own source text +
   admitted target evidence run through `language-induction.ts`'s
   `induceTranslationSeeds` (bounded by `MAX_SEED_TARGET_DOCUMENTS`).
   Empty target evidence ⇒ empty seed set, never a fabricated guess.
4. **Durable seed merge (item 121)** — caller-supplied `durableSeeds`
   (from `TranslationSeedStore`, Postgres `translation_seeds`, keyed by
   target language + source symbol, raise-only upsert) merge with the
   fresh seeds; highest score per source symbol wins
   (`buildSeedLookup`, gated by `MIN_SEED_SUBSTITUTION_SCORE`).
5. **Frame alignment** — each source frame aligns against target frames
   (`alignFrame`): semantic (embedding cosine + feature Jaccard), role
   topology, script fit, evidence mass, prior-alignment boost, seed
   overlap (`seedOverlapScore` — a seed's mapped target must actually
   appear in *that* candidate frame), and construction overlap
   (item 127, below). Produces per-alignment `force`
   (`direct | approximate | gloss | unknown`) and an 8-dimension
   `TranslationLossVector`.
6. **Construction extraction + reuse (item 127)** —
   `extractTranslationConstructions` finds pairs of source symbols whose
   seed-mapped targets are both corroborated in the same resolved target
   frame (real phrasal correspondence, not two coincidences) and exposes
   them as `plan.inducedConstructions`; the live turn path persists them
   (`TranslationConstructionStore`, Postgres `translation_constructions`,
   canonical pair key, raise-only). On later requests,
   `durableConstructions` feed `constructionOverlapScore`, which only
   fires when *both* symbols of a known construction bind into the new
   source frame — a construction learned once genuinely raises alignment
   preservation on an unseen sentence binding the same symbols
   (proved in `translation-target-evidence.test.ts`).
7. **Rendering** — `renderUnit`/`renderEmission`. Gloss units substitute
   seed-mapped targets (`seedSubstitutedSurface`) — partial, real,
   bracket-annotated; never a fabricated fluent sentence. `unknown`
   force renders empty text (honest refusal), never invented output.
8. **Preservation gate (item 125)** — `validatePreservation` checks
   every source number, date, and code symbol survives into the output.
   Any `blockingMissing` term downgrades the whole plan to
   `force: "unknown"` with empty `emission.text` *and* empty
   `construct.translatedText` — the gate cannot be bypassed by reading
   the other field. The full validation record is still returned for
   inspection.
9. **Calibrated confidence (item 129)** — `emission.preservation` runs
   through `calibration-spine.ts`'s `calibrateRuntimeScore`
   (`translation.preservation` / `task.translation`), the same
   subsystem-agnostic framework used by proof/retrieval/dialogue.
   `calibrated: false` (raw passthrough) until a real fitted model
   exists. The live turn path records a `CalibrationObservationRecord`
   per translation with outcome = the deterministic item-125 gate
   verdict, feeding the standard `buildCalibrationModelsById` fit
   pipeline — so the model is fit from real outcomes, not user feedback
   that may never arrive.

## Round-trip gate (items 124-125's hallucination half)

`translation-round-trip-gate.ts`: real Realize (via `buildTranslationPlan`)
then real Interpret (same plan driven by mechanically-reversed lexical
alignments), gated by `semantic-round-trip.ts`'s `factualRoundTripGate`.
Distinct from the preservation gate: round-trip catches *added* content
(hallucination), preservation catches *dropped* content.

## Adversarial safety (item 128)

`translation-seed-adversarial.test.ts` + fixes in
`language-induction.ts`: shape-similarity is a weak supplementary signal
(a shared casing pattern is true of nearly every same-script word pair),
and a "frame" basis requires both symbols in the *same* frame candidate.
Two genuinely unrelated documents (same script or different script)
produce zero high-confidence seeds; a genuinely correlated pair (shared
numbers) still seeds. Held-out script-family coverage (item 123) lives in
`multilingual-translation.test.ts` (Chinese no-whitespace, Arabic/Hebrew
RTL, synthetic constructed language).

## Storage

| Store | Table | Key | Discipline |
|---|---|---|---|
| `TranslationSeedStore` | `translation_seeds` | (target_language, source_symbol) | upsert only if new score is higher |
| `TranslationConstructionStore` | `translation_constructions` | (target_language, symbol_a, symbol_b) canonical order | same |
| prior alignments | `translation_alignments` (via `LanguageMemoryStore`) | alignment id | append |
| calibration observations | `calibration_observations` (via `DialogueMemoryStore`) | observation id | append |

Both new stores are optional on `ScceStorage` (same pattern as
`policyEvolution`): fixture-built test storage needs no changes; absent
stores mean per-request-only behavior, never a fabricated fallback.

## What this does not do (honest scope boundary)

- **No fluent generative translation.** Output is evidence-anchored:
  aligned target-frame text, seed-substituted gloss, or an honest empty
  `unknown`. It cannot compose novel fluent target-language sentences
  for material with no aligned evidence — that is the documented gloss
  fallback, not a bug.
- **Constructions are symbol pairs**, not variable-bearing grammatical
  templates. The full construction-grammar machinery
  (`reversible-construction.ts`, Phase 8's 96-105 modules) is not yet
  integrated into this translation path.
- **Seed/construction stores are per-target-language**, keyed on the
  practical assumption that this corpus's request text is predominantly
  one source language; `source_language` is recorded per row for
  inspectability but is not part of the lookup key.
- **The calibration model starts unfitted.** Until enough real
  translation turns produce observations, `calibratedConfidence` honestly
  reports `calibrated: false` with the raw score.
