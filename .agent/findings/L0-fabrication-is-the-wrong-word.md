# SCCE cannot fabricate. The grader's label says it does.

Owner's correction, 2026-09-13. Acting on it, and the measurement behind it.

## What the label actually means

`tools/head-to-head/grade.mjs` defines the verdict in one line:

    if (item.gold.unanswerable) return { verdict: declined ? "declined" : "fabricated", declined };

So `fabricated` means only: *the row is marked unanswerable and the system did not decline*. It says nothing
about where the text came from. One label is doing duty for two different failures, because one of the two
systems has a generator and the other does not.

## Measured

Over the 44 rows the grader called `fabricated` for SCCE on the frozen baseline:

    carried at least one admitted evidence span     44 of 44
    fragments traced verbatim to a corpus span      73 of 81
    rows where every fragment traced                35
    rows where some fragment traced                  5

The eight untraced fragments are artefacts of the probe, not of SCCE: the answer text is JSON-escaped, so
`['Infobox tungsten'] = 1` and its literal backslashes do not match the raw column, and the summary lane
concatenates non-contiguous sentences so a fixed-width probe can straddle two of them.

The reference model's 30 `fabricated` rows carry **no evidence field at all**. It has nowhere to put one.

## The distinction that matters

    SCCE       a real corpus sentence, with provenance, emitted when the corpus does not settle the question
    reference  text generated from weights, which may correspond to nothing

Both are errors and both are counted against the system that made them. They are not the same error. SCCE's is a
retrieval and gating failure: the right subject was found, the asked attribute was absent, and the turn spoke
anyway. It is diagnosable, because the emitted span can be pointed at. An invented sentence cannot be pointed at,
which is exactly what makes it unfixable rather than merely wrong.

This is the thesis, not a footnote. A system with no generator has a floor on how wrong it can be: it can be
wrong about *which* true sentence answers a question, never about whether the sentence exists.

## What changed

The results page now reads "Answered where the corpus holds no answer", with a second row showing 44 of 44
carrying a cited source span against 0 of 30, and a note stating the asymmetry plainly.

The verdict KEY stays `fabricated` in the data for now: ten tools consume it and a suite run was in flight. It
should be renamed to `unsupported` across the harness, and that is a follow-up, not a silent edit mid-measurement.
The counts do not change either way -- this is a naming correction, never a scoring one.
