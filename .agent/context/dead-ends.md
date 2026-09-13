# Dead ends, already paid for

Measured on this corpus and rejected. **Do not re-derive these.** If you think one deserves another look, say why
in your findings before spending tokens on it. Add to this file whenever you kill an approach with numbers.

## Morphology: are two surfaces forms of one lemma
Required: discover/discovery YES, capital/capitals YES. Refused: capita/capital, born/borna, majorian/bajoran.

| approach | why it failed |
| --- | --- |
| Otsu on vocabulary extension counts | accepts only `s`, reproducing the English rule. Power law, no bimodality. |
| Otsu in log space | accepts 350+ endings including `box`, `way`, `man`. |
| Baayen productivity (hapax-conditioned) | still accepts `man`/`box`/`way`, still rejects `y`. |
| PPMI cosine over 15.8M bigrams | discover/discovery 0.0092, BELOW austria/australia 0.0837. Backwards. |
| per-pair context overlap | discover/discovery 0.112 < capita/capital 0.146. Backwards. |
| alternation productivity vs frequency-matched control | only `s` again, across all 2,249 one-letter pairs. |
| Otsu on the boundness residual | residual is unimodal; calls "discover" bound. |
| persisted all-length continuationCounts | dilutes capita to "free". Must be order 1. |

**What works:** order-1 Kneser-Ney continuation diversity — how many DISTINCT words precede a surface. A free form
follows many; a fixed-phrase fragment follows one ("capita" = 119 tokens behind 2 words, 95% "per"). The cut is
fitted from the corpus's own type/token relation and bounded by Mills' inequality, not chosen. See
`packages/kernel/src/free-form-lexicon.ts`.

**Still open:** find/found. Not a prefix pair. The distributional ranking is wrong across the family — real
grind/ground scores BELOW false mind/mound — so no bar separates them. Do not claim it is solved.

## Summarization: separating a work from its apparatus
- "Front matter wins because it is self-similar" was WRONG. The real cause is hard-wrapped lines read as sentence
  ends. Moby Dick interior lines close a sentence 4.9% of the time, paragraph-final lines 96.1%.
- Cosine similarity makes a two-word speaker cue a unit vector scoring ~1.0 against everything. Use shared
  inverse-sentence-frequency mass damped by both lengths.
- Rejected with numbers: partner-position spread (direction reverses between books), centroid distance
  (AUROC 0.29-0.39), MDL two-class block selection (chose two classes even on sources with no apparatus),
  adjacent cohesion, hapax share.
- Still open: an editorial preface that quotes the work is not separable by anything measured.

## Turn latency
- The "5.2 second pre-kernel gap" DID NOT EXIST. Those turns ran a 5000ms window from an older build; elapsed plus
  remaining summed to exactly 5000 while the server reported 10000. Real pre-kernel cost is p50 51ms.
- Corpus spread cannot decide relation-vs-scaffolding: it drops "capital", and the Peru question then answers with
  the country's landscape.

## Calibration
- 38 of the 56 ids are scalar weights in a linear score, not probabilities with outcomes. No volume of
  `calibration_observations` will ever fit them.
- `candidate.mass` has 3,321 observations and still loses to a constant on 4/5 splits. Its negatives are all
  `outcome.unknown`, so the learning loop has no real negative signal. Fix the labelling before refitting.
