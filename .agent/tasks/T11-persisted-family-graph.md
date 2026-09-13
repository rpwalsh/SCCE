# T11 Persisted latent lexical-family graph

status: open

## What T10 settled

Orthography is EXHAUSTED, proven not asserted. The transformation `* i nd -> * ou nd` has 11 realized members on
the full corpus, 6 true (find/found, bind/bound, grind/ground, wind/wound, rewind/rewound, unwind/unwound) and 5
false (mind/mound, hind/hound, sind/sound, rind/round, pind/pound). They sit inside ONE transformation, so
productivity, Bayes factor and MDL accept or reject all eleven together. No string-derived criterion can split them.

Contextual correspondence as formulated also FAILED its ablation: on a held-out family the shuffled pool scored
higher than the true pool on 6 of 12 members. It was a pairwise classifier in a family-shaped wrapper.

And the diagnostic set is partly UNDECIDABLE at runtime: `grind`, `wound`, `kound`, `borna`, `majorian`, `bajoran`
are absent from the 20,598 types a turn hydrates, against 317,571 in the full corpus.

## Hypothesis

A lexical-family relation needs an observation NOT derived from the same strings. Three coupled sources:
1. global orthographic transformation evidence,
2. syntactic / argument-role correspondence,
3. lexical-independence likelihood (T6, as a FACTOR, never a gate — as a gate it kills bind/bound because `bind`
   is sparse in the resident models).

The question is not whether find and found share neighbours. They do not. It is whether they occupy the same
latent predicate frame under different grammatical states, while mind and mound do not.

## Architecture correction

Induce over the FULL corpus offline, persist a compact family graph with its evidence, and load only relevant
memberships per turn. A turn must not need `grind` physically present in its hydration slice to know the
`i->ou/_nd` family has global evidence. This is the biggest structural change in the task.

## Objective

Prefer a generative or MDL objective over a hand-weighted score: accept a family hypothesis only when the joint
grammar compresses BOTH form and syntactic behaviour.
`L(M) + L(D_surface | M) + L(D_syntactic | M)`

## Required

MATCH: find/found, bind/bound, grind/ground, wind/wound, discover/discovery, capital/capitals
REFUSE: mind/mound, kind/kound, capita/capital, born/borna, majorian/bajoran

## Ablations, all four reported

1. no syntactic factor  2. shuffled family membership  3. no global persisted graph  4. T6 as factor vs as gate

## Do not ship

until held-out families improve over shuffled controls. The diagnostic set is a diagnostic, not a training target.
