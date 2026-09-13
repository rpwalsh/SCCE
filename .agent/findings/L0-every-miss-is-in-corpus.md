# Every non-cloze miss is on content the corpus already holds

Owner's challenge, 2026-09-13: it is not fair to score a sealed offline system on questions whose answers are not
in its corpus. Correct as a principle, and I had accepted it as an explanation for the factual gap. It is not one.

## Measured, over the frozen baseline

For every row SCCE did NOT get right, does the gold string occur anywhere in the corpus?

    workload                        misses   gold IS in corpus   gold absent
    factual                             23          23                0
    book + direct + conversational      26          26                0
    ---------------------------------------------------------------------
    total                               49          49                0

**Not one miss is a question about something the corpus does not contain.** The entire non-cloze gap is retrieval
and selection failing on content already present -- the same defect class the lanes repaired all night, not a
boundary of the closed-corpus design.

## What I had said, and why it was wrong

I reported "it loses on world knowledge -- anything outside the corpus the model wins and will keep winning", and
framed the factual gap as a structural property of a sealed system. That was an inference from the SHAPE of the
workload (general-knowledge questions, a language model doing well on them) rather than a measurement of the
corpus. The corpus holds Apollo 11 at 40 spans, Adelaide at 20, Alfred Hitchcock at 42, Star Trek: Deep Space
Nine at 16. It was never a knowledge gap.

## What is genuinely unfair, and it is mine

The `code` workload. 384 of 831 tracked TypeScript files were never ingested and 33 more are truncated, so of its
six questions two ask about symbols absent from the corpus (`bestEvidenceSentences`, `createProgramPlanner`) and
two about symbols cut off mid-file (`deriveClosedClassWords` at char 3,816 of a file ingested to 2,079;
`syncTaskResumptionSnapshotForTurn` missing by 367 characters). Only two are real retrieval failures. Scoring
0 of 6 as a capability result compares the engine against a corpus it was never given. Re-ingest first, or score
those four as unanswerable.

## And what the abstention workload actually is

The honest version of the owner's principle. It deliberately asks what the corpus lacks and scores REFUSAL as
correct -- eight of its twelve subjects are absent from the corpus entirely. That is the right test for a sealed
system, and it is now the strongest result relative to the reference: 51 declines against 29.

## The consequence for the ceiling

The remaining non-cloze gap is 49 fixable rows, not 49 questions beyond reach. That is a much higher ceiling than
I described, and it should be stated that way.
