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

## T12 — operator ROI instrumentation

| approach | verdict |
| --- | --- |
| keying operators on trace `stage` alone | **DEAD.** `graph.resolve` is five operators sharing one stage, separated only by `label`. Collapsed it reads as one 9,725 CPU-s monster; split it is a 3.4 s graph slice, a 47 ms semantic retrieval and a 5.4 ms PowerWalk, with opposite verdicts for each. Always key on `stage` + `label`. |
| "PowerWalk / diffusion are absent from the traces" | **DEAD — the claim was false for PowerWalk.** It is traced as `graph.resolve` with `label: kernel.turn.powerwalk`, 2,759 invocations, 5.4 ms each. `diffusion` and `relation_potential` really are absent: OPEN, needs a call-path audit to say whether they are unwired or merely untraced. |
| score entropy (`proof.support_assessment.weights`, `proof.path_semiring`) as the uncertainty measure | **NOT USEFUL HERE.** A truer posterior, but recorded at exactly one point in the turn, so it yields no before/after for any operator. Kept as a cross-check only. |
| unresolved proof obligations as the uncertainty measure | **NOT USEFUL HERE.** `proof.semantic.counts.obligations` is recorded before and never after. |
| `candidate.cognitive.plan` `proposals`→`activeOperators` as a before/after pair | **DEAD.** Different populations; produced -1.198 bits. Removed. A negative dH is the tell that a counter pair is wrong. |
| per-operator ROI as the headline metric | **SUPERSEDED** by lane ROI. 20 of 40 operators emit no `durationMs`, and they are disproportionately the ones that remove uncertainty, so per-operator ROI is undefined for exactly the operators that matter. |
| deriving per-turn bytes hydrated from traces | **DEAD.** `counts.bytes` exists only on `graph.resolve|kernel.hot_neighborhood`, which fires 38 times inside turn windows; most hydration happens during warmup, outside `turn.input`→`turn.output`. |
| the existing ablation as evidence that PowerWalk is useless | **DEAD.** PowerWalk is 0.05% of a turn. The benchmark cannot resolve a 5 ms operator; removing it neither hurts nor helps. The ablation was measuring nothing. |

Tool `tools/operator-roi.mjs`, full write-up `.agent/findings/T12.md`.
