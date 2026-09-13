# One objective, not six

Owner doctrine, 2026-09-13. SCCE does not need a new linguistics architecture bolted on. Unicode segmentation,
boundary estimation, segmentation forests, segmentation populations, role/surface ordering and reversible
constructions already exist. What is missing is that each of them decides independently what is "real" and then
hands the result downstream. They must instead share one objective.

## The objective

    Theta = (S, L, M, R, C, A)

      S  segmentation
      L  induced lexical populations
      M  morphology / paradigms
      R  opaque roles
      C  reversible constructions
      A  surface <-> graph alignment

    J(Theta) = L(Theta) + L(X | Theta) + lambda * L(G | Theta) + mu * E_cycle

      X  observed Unicode surface corpus
      G  the persistent semantic graph

    E_cycle = d_G( G, Interpret(Realize(G)) ) + d_X( X, Realize(Interpret(X)) )

Promote a structure only when held-out dJ > 0 across disjoint source families.

> A linguistic structure is real when it compresses independently observed surface variation AND predictably
> preserves or transforms semantic graph structure.

The third and fourth terms are the whole point. Recurring textual scaffolding -- Gutenberg boilerplate, infobox
templates, citation conventions, navbox residue -- compresses beautifully under `L(Theta) + L(X | Theta)` alone.
It must not become grammar. It earns nothing under `L(G | Theta)`, so it loses.

## What this forbids

No linguistic category may be a runtime primitive unless it is language-universal and non-lexical.

Forbidden as primitives: subject, object, past tense, question, noun, verb, determiner, acknowledgment, topic
shift, setup, conflict, climax, resolution, revenge, fear, and every other English-named category. Human-readable
labels may appear in traces, tests and diagnostics. No production decision may depend on one.

Permitted as universal because structural, not linguistic: graph-state change, belief state, unresolved
dependency, temporal ordering, causality, speaker identity, turn boundary, provenance, recurrence, information
gain, contradiction, uncertainty, utility.

So a discourse state is `dialogue.population.7f32` with learned transitions, not `question | answer`. A narrative
motif is a distribution over (world-state delta, belief delta, relationship delta, unresolved-obligation delta),
not `setup -> conflict`. A style is `P(C_t | C_{t-1}, z_discourse, z_style)` over induced construction ids, not an
adjective.

## The concrete consequences, per subsystem

**Segmentation.** Keep boundary-estimator and the forests. Add semantic evidence to boundary selection:
`B_i = I(b_i ; C, G | X)`. A split earns its place when it makes recurring constructions and graph
correspondences more predictable, not merely when the substring recurs.

**Lexical identity.** Not string similarity. `E(u,v) = w_c*C + w_g*G + w_r*R + w_m*M` over contextual
substitutability, graph correspondence, construction/role correspondence, and learned morphological mapping.
Graph correspondence is independent evidence.

**Morphology -- this is how T10 gets repaired.** A morphological operation is a PAIR, not a rewrite:

    T = (dX, dG)      dX = edit(a,b)      dG = graph(b) - graph(a)

Cluster a transformation only when BOTH deltas recur. find->found and mind->mound have comparably plausible
surface edits. Only the first shows a recurring semantic delta (the same temporal feature change) across
independent source families. Promote iff held-out dJ(T) > 0. This is why more spelling statistics could never
settle it, and why the previous derived-morphology attempt failed: it had only dX.

**Roles.** `R* = argmax_R I(R;G) - beta*I(R;X_accidental)`. Induce roles that predict graph participation while
depending as little as possible on accidental spelling or absolute position.

**Constructions.** Promote on `L(C) + L(X|C) + lambda*L(G|C)`, never on surface compression alone.

**Alignment.** The existing sparse fused transport is the shared evidence channel through which graph semantics
constrains segmentation, morphology and grammar. Cost
`c_ij = a*occurrence + b*context + g*role + d*construction + e*provenance`.

**Function words.** Already derived, not listed. Derive them from structural information rather than frequency:
high `H(Graph|u)`, high `I(u;Construction)`.

**Language identity.** A mixture, not a switch. `P(z|x) ~ P(x|z)P(z)` with per-span z, so code-switching is
native.

**Realization.** `X* = argmin_X [ -log P(X|G,C) + lambda * d_G(Interpret(X), G) ]`. If SCCE reads its own output,
the meaning must survive. That is the non-LLM equivalent of fluency, and it cannot invent facts.

## The leak to close

`semantic-obligations.ts` still re-parses language: capitalization patterns for entities, regexes with month
names for dates. The proof layer must not re-parse surface text. It consumes canonical objects the
segmentation/construction/alignment stack already produced. Wrong: text -> proof -> regex finds "December".
Right: text -> segmentation/construction/alignment -> canonical temporal object -> graph -> proof consumes it.

## On tractability

We do not need P vs NP to beat a 3B model. Best graph slice, minimum proof set, optimal segmentation and best
construction grammar are all NP-hard in their global forms. The engineering move is:

    NP-hard global problem -> restricted instance -> good decomposition -> bounded exact/approximate solve

Use structural indexes to cut candidates from millions to hundreds, then solve exactly inside the bounded region.
The target theorem is fixed-parameter tractability: runtime `O(f(k) * poly(n))` where k is small and structural --
treewidth, proof width, active hypothesis count, hyperedge arity, structural neighbourhood size -- while n stays
polynomial or sublinear through indexing.

> The goal is not to make NP-hardness disappear. It is to arrange cognition so the hard part only ever sees a
> tiny, highly structured slice.
