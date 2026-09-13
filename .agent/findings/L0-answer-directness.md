# Half of SCCE's correct answers are paragraphs that contain the answer

Found while investigating five factual rows that went CORRECT -> DECLINED under the answerhood tightening. The
regression is real, but the baseline it is measured against is softer than its number suggests, and both facts
need stating together.

## The measurement

Over the frozen baseline's graded rows with gold strings, for answers the grader scored `correct`:

    system      correct   mean length   paragraph-length   gold token in first 60 ch   buried deeper
    SCCE            149        239 ch          112              68                      77  (51.7%)
    reference        96        164 ch           39              64                      28  (29.2%)

The grader scores by substring containment, symmetrically for both systems, which is a defensible design. But
"correct" therefore means *the answer contains the gold token somewhere*, not *the answer responds*. On that
looser reading SCCE leads 149 to 96. Counting only answers that put the gold token in their first 60
characters -- a crude proxy for actually answering -- the lead is **68 to 64**.

## What it looked like in the rows that regressed

    reference:alp-country   "The Australian Labor Party is a political party in which country?"
      baseline, scored CORRECT:
        "Australian Labor Party the retrieval political party in which country. The political parties in
         the Turkish go..."

That is malformed text that scored correct because the gold string `australia` occurs inside "Australian", in a
sentence echoing the question back. `ainu-country` scored correct on a passage opening with the wikitext residue
`(Sapporo Pirka Kotan)]]`. `ashoka-dynasty` scored correct on "Information about Ashoka comes from his
inscriptions..." with "Maurya" somewhere further in.

So when the answerhood gate refuses these, it is refusing things that were never answers. The scoreboard records
that as a loss because `declined_when_answerable` and `correct` are different verdicts, and it is right to: going
quiet is not an improvement on accidentally containing the answer. But the fix that scores is not to loosen the
gate again -- it is to SPEAK the answer, which is what the summary-fallback ordering and the anchor work are for.

## One row is a gold defect, not an SCCE failure

    reference:alfredgreat-kingdom   "Alfred the Great was king of which Anglo-Saxon kingdom?"
      now answers: "'Alfred the Great' (- 26 October 899) was King of the West Saxons from 871 to 886..."
      graded: wrong

"King of the West Saxons" is the corpus's own phrasing of Wessex, and it answers the question. The gold accepts
only the modern name. Left alone rather than corrected: unlike the Adelaide row, this is a naming judgement
rather than a claim the corpus contradicts, and widening gold to fit an answer is how a benchmark stops meaning
anything. Recorded so the row is not read as a retrieval failure.

## What this changes about how we report

The headline stays SCCE ahead, because it is, on the same grader on the same rows. But any claim about answer
QUALITY has to carry the directness number beside it, and the results page must show it rather than only the
count. A system that answers in a paragraph containing the answer is not doing the same thing as one that answers.
