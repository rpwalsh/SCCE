# Frozen baseline, 2026-09-13 02:58 -- 311 rows vs qwen2.5:3b

Raw file: `artifacts/head-to-head/results-baseline-20260913.json`. Do not overwrite it. Every lane's claim is a
delta against this file.

    SCCE : correct 149 | declined_when_answerable 56 | wrong 35 | fabricated 44 | declined 15 | ungraded 12
    qwen : correct  96 | declined_when_answerable  7 | wrong 137 | fabricated 30 | declined 29 | ungraded 12

    workload          n   SCCE   qwen
    cloze           160    112     26   SCCE dominates
    abstention       59     15     29   LOSS  (SCCE fabricates 44, qwen 30)
    factual          50     27     49   LOSS
    book             12      1     10   LOSS
    conversational   12      0      0   both ungraded -- no grader
    relation          7      7      7   tie
    code              6      0      0   tie at zero
    direct            5      2      4   LOSS

    mean ms   scce 23801   qwen 5746
    mean cpu  scce 23.22   qwen  0.40

## The single defect behind abstention, factual and book

SCCE retrieves the right topic region and emits a sentence that does not contain the asked value. Every one of
these rows has evidence 1 or 2 and a topical-prose answer.

    Einstein's shoe size          -> Einstein's biography lead        (subject found, attribute absent)
    Adelaide capital of which     -> Adelaide liveability prose       (subject found, relation absent)
    Hitchcock's nickname          -> Hitchcock filmography            (subject found, relation absent)
    When did Apollo 11 land       -> Apollo the Greek god             (subject collision)
    ship in Moby-Dick             -> a Chilean barque, Almirante S.   (subject collision)
    DS9 commanding officer        -> Star Trek: Enterprise            (subject collision)
    when did Revolutionary War end-> April 19 1775, its START         (relation direction inverted)
    first Academy Awards year     -> "11:00"                          (value type mismatch)
    boiling point of tungsten     -> ['Infobox tungsten'] = 1, ...    (raw wikitext residue as answer)
    Jonathan Harker travels to    -> Project Gutenberg licence header (boilerplate as answer)

This is resemblance-based selection surviving where discrimination-based selection would refuse. It is the exact
failure `proof-addressed-memory.md` predicts and `joint-objective.md` forbids: a candidate that says "maybe" to
every hypothesis must score near zero, and a relation with no candidate value set has no proof, so the turn
declines.

Fabricating MORE than the LLM on the abstention set is a thesis-level failure. It is lane L1 and it outranks
everything else including latency.

## What is already won and must not regress

cloze 112/160 against 26 is the proof that grounded recall beats a parametric model. No lane may trade cloze
correctness for its own number. Re-run `--workload cloze --only scce` before claiming any win.
