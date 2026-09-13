# What has already been paid for

Every entry carries a verdict, because "we tried it and it failed" is not the same claim as "it is wrong".
Treating a locally rejected method as globally forbidden is its own failure mode.

| verdict | means |
| --- | --- |
| **DEAD** | mathematically or empirically falsified. Do not revisit without new evidence. |
| **NOT USEFUL HERE** | a valid technique reading the wrong signal for this task. Fine elsewhere. |
| **SUPERSEDED** | worked, but a better formulation replaced it. |
| **OPEN** | insufficient evidence either way. Fair game. |

Record the population and the measurement, not just the outcome: we tried X on population Y with measurement Z
and it failed because Q. Append whenever you kill an approach with numbers.
## Morphology: are two surfaces forms of one lemma
Required: discover/discovery YES, capital/capitals YES. Refused: capita/capital, born/borna, majorian/bajoran.

| approach | verdict | why |
| --- | --- | --- |
| Otsu on vocabulary extension counts | **NOT USEFUL HERE** | accepts only `s`, reproducing the English rule. Power law, no bimodality. (power law has no bimodality; Otsu assumes two classes) |
| Otsu in log space | **NOT USEFUL HERE** | accepts 350+ endings including `box`, `way`, `man`. (same reason, opposite failure: accepts 350+ endings) |
| Baayen productivity (hapax-conditioned) | **DEAD** | still accepts `man`/`box`/`way`, still rejects `y`. (accepts man/box/way, rejects y, on this vocabulary) |
| PPMI cosine over 15.8M bigrams | **DEAD** | discover/discovery 0.0092, BELOW austria/australia 0.0837. Backwards. (ranking inverted: related words occupy systematically different contexts) |
| per-pair context overlap | **DEAD** | discover/discovery 0.112 < capita/capital 0.146. Backwards. (ranking inverted, same structural reason) |
| alternation productivity vs frequency-matched control | **DEAD** | only `s` again, across all 2,249 one-letter pairs. (recovers only the plural, across all 2,249 pairs) |
| Otsu on the boundness residual | **NOT USEFUL HERE** | residual is unimodal; calls "discover" bound. (residual is unimodal) |
| persisted all-length continuationCounts | **SUPERSEDED** | dilutes capita to "free". Must be order 1. (order-1 counts carry the signal; all-length dilutes it) |

**What works:** order-1 Kneser-Ney continuation diversity — how many DISTINCT words precede a surface. A free form
follows many; a fixed-phrase fragment follows one ("capita" = 119 tokens behind 2 words, 95% "per"). The cut is
fitted from the corpus's own type/token relation and bounded by Mills' inequality, not chosen. See
`packages/kernel/src/free-form-lexicon.ts`.

**OPEN — find/found.** Not a prefix pair. The distributional ranking is wrong across the family — real
grind/ground scores BELOW false mind/mound — so no bar separates them. Do not claim it is solved.

## Summarization: separating a work from its apparatus
- **DEAD** — "front matter wins because it is self-similar". The real cause is hard-wrapped lines read as sentence
  ends. Moby Dick interior lines close a sentence 4.9% of the time, paragraph-final lines 96.1%.
- **NOT USEFUL HERE** — cosine similarity makes a two-word speaker cue a unit vector scoring ~1.0 against everything. Use shared
  inverse-sentence-frequency mass damped by both lengths.
- **DEAD**, all with numbers: partner-position spread (direction reverses between books), centroid distance
  (AUROC 0.29-0.39), MDL two-class block selection (chose two classes even on sources with no apparatus),
  adjacent cohesion, hapax share.
- **OPEN** — an editorial preface that quotes the work is not separable by anything measured.

## Turn latency
- **DEAD** — the "5.2 second pre-kernel gap" never existed. Those turns ran a 5000ms window from an older build; elapsed plus
  remaining summed to exactly 5000 while the server reported 10000. Real pre-kernel cost is p50 51ms.
- **DEAD** — corpus spread cannot decide relation-vs-scaffolding: it drops "capital", and the Peru question then answers with
  the country's landscape.

## Calibration
- **DEAD** — 38 of the 56 ids are scalar weights in a linear score, not probabilities with outcomes. No volume of
  `calibration_observations` will ever fit them.
- **OPEN** — `candidate.mass` has 3,321 observations and still loses to a constant on 4/5 splits. Its negatives are all
  `outcome.unknown`, so the learning loop has no real negative signal. Fix the labelling before refitting.
