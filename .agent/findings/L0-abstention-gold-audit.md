# Is the abstention set actually unanswerable? Audited, and it mostly is

L1 found a row marked `unanswerable` that the corpus states. If one was wrong the rest needed checking, because a
mislabelled abstention row scores SCCE as fabricating when it answers correctly and rewards it for refusing a
fact it holds. Reproduce with `node tools/abstention-audit.mjs`.

    subject article                 spans   answer string present   verdict
    tungsten                            0   -                       correctly unanswerable
    mongolia                            0   -                       correctly unanswerable
    sulfuric acid                       0   -                       correctly unanswerable
    chernobyl disaster                  0   -                       correctly unanswerable
    one hundred years of solitude       0   -                       correctly unanswerable
    challenger deep                     0   -                       correctly unanswerable
    human skeleton                      0   -                       correctly unanswerable
    1998 fifa world cup                 0   -                       correctly unanswerable
    albert einstein                    45   no "shoe size"/"dentist" correctly unanswerable
    apollo 11                          40   no "cups of coffee"     correctly unanswerable
    fifa world cup                     14   "France" appears        correctly unanswerable, see below
    adelaide                           20   "Lomax-Smith"           **MISLABELLED**

Eight of the twelve subjects are not in the corpus at all. Two are present as articles that genuinely do not
carry the asked attribute -- which is precisely the shape L1's vacuity fix exists to refuse.

**The FIFA row is a false positive of my own probe, not a gold error.** "France" occurs in the `fifa world cup`
article three times -- as the team Argentina beat in 2022, among the four European teams Rimet persuaded to
travel in 1930, and as a disputed host choice. The corpus never states who won in 1998. A substring probe is not
an answerability test; I checked the surrounding text before concluding.

**`reference:adelaide-absent-mayor` is a real gold error.** The `adelaide` article states: "From 1919 onwards,
the city has had a Lord Mayor, the current being Lord Mayor 'The Right Honourable' Jane Lomax-Smith." The
question "Who is the current Lord Mayor of Adelaide?" is answerable and was marked unanswerable, so SCCE was
scored `fabricated` for answering it correctly and could never score above 58 of 59.

Corrected to an answerable row accepting "lomax-smith". This is a reclassification, not a point handed to SCCE:
SCCE must now produce the name to score, and a decline is counted `declined_when_answerable` against it.

## What this does not license

Changing gold to fit an answer is how a benchmark stops meaning anything. The test applied here was: does the
corpus contain a sentence that states the answer, verified by reading the surrounding text, not by matching a
token. Nine of the twelve probes survived that test unchanged and one of my own flags was withdrawn.
