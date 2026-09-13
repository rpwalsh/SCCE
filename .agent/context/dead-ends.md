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

## Morphology part 2: are two surfaces members of one lexical family (T10)
Required: find/found, bind/bound, grind/ground, wind/wound, discover/discovery, capital/capitals MATCH;
mind/mound, kind/kound, capita/capital, born/borna, majorian/bajoran REFUSE.

**The decisive measurement. Orthography is exhausted, provably.** The canonical both-ends edit script puts these
in ONE transformation `* i nd -> * ou nd`, 11 realized members of 120 eligible stems on the full corpus:
find/found, bind/bound, grind/ground, wind/wound, rewind/rewound, unwind/unwound (true) and
mind/mound, hind/hound, sind/sound, rind/round, pind/pound (false). Any family-level criterion accepts or rejects
all eleven together. Do not look for a string-level mechanism that splits them; there isn't one.

**The corpus, not the model, is the first blocker.** At the 48MB hydration budget a turn holds 20,598 types and
`grind`, `wound`, `kound`, `borna`, `majorian`, `bajoran` are ABSENT. Four diagnostic pairs are undecidable there
whatever the mechanism. The full corpus is 2,028 models / 317,571 types.

| approach | numbers |
| --- | --- |
| family population vs an order-3 character-model null (log Bayes factor, BIC-penalised) | accepts 1,771 of 33,926 induced transformations; `i>ou@nd` gets logBF **-1.60** at 3/12 members resident. Never separates inside a family. |
| MDL over the eligible population (transformation + membership bitmap at H2(p-hat) + rate) | `0>s@` +42,078 bits, `0>y@` +1,794 bits, `i>ou@nd` +7.3 bits. Family-level by construction, so it cannot decide a member. |
| pair-only MDL, the "NO FAMILY" ablation | every pair -11 to -23 bits. A one-member transformation never pays for itself. Correct, but no discrimination. |
| role-conditioned pooled context correspondence (per-lexeme-normalised, leave-one-out, background-Dirichlet) | **fails the shuffled-family ablation**: on the held-out `s>ed@` family the SHUFFLED pool scores higher than the true pool on 6 of 12 members (acts/acted 4.341 vs 5.583, films/filmed 7.085 vs 8.062). It is a pairwise classifier wearing a family wrapper. It also kills discover/discovery, role -0.325. |
| composing T6's free-form verdict as a hard precondition | kills bind/bound: `bind` is t=5 resident so its verdict is *unknown*. T6 belongs in the product as a likelihood factor, not as a gate. |

Result 6/11, and all five correct refusals are correct for the wrong reason: four absent surfaces and one T6
boundness. `mind/mound` refuses only because `mound` is t=2 resident; at full corpus t=79 and the accident goes.
Harness `tools/paradigm-induction-harness.mjs`, full write-up `.agent/findings/T10.md`.

## Morphology part 3: argument-role / predicate-frame correspondence (T11a)
Population: the full corpus — 2,028 models, 317,571 types, 8,283,125 bigram records — not the hydration slice.
Frame vocabulary induced by `deriveClosedClassWords`'s instrument (order-1 Kneser-Ney continuation count, top K);
profiles = left/right adjacency restricted to it; statistic `S = BC(right_u,right_v) - BC(left_u,left_v)`, scaled
against 460-510 frequency-matched random pairs. Harness `tools/argument-frame-harness.mjs`, write-up
`.agent/findings/T11a.md`.

| approach | verdict | numbers |
| --- | --- | --- |
| frame-restricted right-agreement minus left-agreement, as an inflection detector | **DEAD** | AUROC 0.733 on the eleven `i>ou@nd` members, never separating; stable at K=48/96/192/384 (0.800/0.733/0.733/0.733). `mind/mound` +0.252 outranks three required MATCHes (bind/bound +0.149, grind/ground -0.001, wind/wound -0.052). find/found +0.380 is only 0.65 background sd above mind/mound. |
| the same statistic as a general family relation | **DEAD** | its single highest score in the whole diagnostic set is a required REFUSE: `capita/capital` +0.555, z +2.76, because `capita` has 6 left frame tokens (95% behind one word). S re-reads T6's boundness sign-flipped, not argument role. `capital/capitals` -0.076. |
| selecting the frame vocabulary by residual against the T6 type/token fit instead of by rank | **DEAD** | returns 1 word of 3,000 candidates; every Bhattacharyya coefficient degenerates to 0 or 1. The established instrument is rank-by-continuation-count with a limit, not a significance test on the residual. |
| deciding this family on adjacency counts of any kind | **DEAD, and it is the corpus** | requiring >=50 frame tokens in every slot leaves 2 of 11 members (find/found, wind/wound), both true, so no AUROC is even defined. `rewind`/`unwind`/`pind` have 0 frame tokens on a side, `grind` 7, `mound` 42/50. Full corpus, not a budget artifact. |
| shuffled-family ablation on held-out `s>ed@` (128 members, picked by rank, uninspected) | **OPEN** | true pool beats a derangement on 7 of 11 members; P(X>=7 given n=11, p=0.5) = 0.274. Not significant either way — better than T10's 6-of-12 inversion, but 11 members cannot detect this. |
| two-sided (prev,next) joint frame cells, and `tri:a|b|c` trigram frames | **OPEN** | not measured; only bigram records were streamed. The obvious next probe. |

### Graph-preserving substitutability as the family criterion (T11a redirect, circularity check)
Proposed: `x ~ y iff substituting x for y preserves semantic graph identity modulo realization variables`, on the
grounds that the persisted relation graph is an independent channel. The mandatory circularity check kills it.

| approach | verdict | numbers |
| --- | --- | --- |
| validating morphology against the prose relation channel | **DEAD, circular** | `compileRelationHypothesisModel` (`relation-hypothesis.ts:63`) keys rows by `normalize(surface)` and its sufficient statistics are `leftContexts` / `rightContexts` / `contextPairs` / `leftShapes` / `rightShapes`. The prose graph channel IS bigram adjacency, surface-keyed. Not circular through spelling; circular through adjacency — it would re-measure the AUROC 0.733 statistic above. |
| relation-identifier equality for find vs found | **DEAD** | the live graph has **52 distinct `relation_id` over 4,001,404 edges**, the top one carrying 1,810,867 (45%). Identifiers are not per-predicate and cannot encode "find and found denote the same relation". |
| substitution / marginal comparison / quotient classes / partition-MDL over graph states | **DEAD for now — the layer does not exist** | 1,815,716 `graph_nodes`; kinds `(null)` 1,237,899, `cell` 217,527, `language` 121,163, `syntax.value` 49,694, `call.frame` 41,718, `declaration.form` 34,032, `document_structure` 31,980, `link` 29,474. No event/predicate node with participants. Nothing to substitute into, nothing to marginalise realization out of. |
| structural equivalence (same ports, same participant structure) as the fallback | **DEAD** | `relation_observations` is 17,904 rows, 16,385 of them `weak_free_surface`, whose signatures are arity-2 `observable.value`/`observable.entity` with `qualifierShape.observableStructure.predicateSurface: string`. Near-identical across rows, so it holds of `mind`/`mound` as much as `find`/`found`; the only discriminating field is the surface string. |

The six requested ablations (FULL / ORTHOGRAPHY ONLY / GRAPH ONLY / SHUFFLED GRAPH / SAME-SOURCE ONLY /
NO REALIZATION QUOTIENT) were **not run**: four of the six are undefined without a prose predicate layer and would
have produced numbers with no referent. Building that layer is an ingestion task, not a morphology task.
