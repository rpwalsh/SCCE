# Proof-addressed memory

The breakthrough is not another reasoning operator, more morphology, a better mouth, or a cognitive control layer.
It is retrieval itself becoming proof-directed:

> **Retrieve the smallest exact evidence subgraph capable of distinguishing the admissible answers.**

A language model compresses knowledge into parameters and reconstructs a plausible answer. This maintains an
enormous *addressable proof space* and locates the tiny exact subgraph that establishes one. Do not compete with a
3B transformer at fuzzy semantic completion; it is good at that. Attack what its architecture cannot give: an
arbitrarily large persistent world where every answer resolves from a small, exact, provenance-preserving slice.

## The change is in the middle, not a rewrite

```
request -> cheap structural anchors -> small provisional slice -> provisional competing claims
        -> CONTRASTIVE EXPANSION -> only evidence that distinguishes those claims
        -> existing planner, judge, proof, mouth UNCHANGED
```

The planner does not move upstream. All that is needed is cheap provisional alternatives, which typed relations,
semantic candidates and per-claim bases already produce: subject Einstein, relation born-in, values {Ulm, Germany}.

## Score discrimination, not resemblance

Do not ask how relevant a region is. Ask what inspecting it would settle:

```
D(v; H) = sum_k P(h_k) * KL[ P(E_v | h_k) || P(E_v) ]
```

Typed claim structures make this concrete and cheap. For evidence e with support vector
`s_e = [s(e,h_1) ... s(e,h_k)]`:

```
D(e) = Var_{h ~ P(H)} [ s(e,h) ]
```

Evidence that says "maybe" to every candidate scores low. Evidence that says "strongly yes, strongly no, strongly
no" scores high. That is what enters the hot brain.

**Run it over structural populations, not spans.** Relation populations, opaque roles, constructions, alignment
populations, quotient communities, walk neighbourhoods, source-family support, temporal structure and typed
incidence already exist. Asking which populations can discriminate is vastly cheaper than interrogating spans.

## Selection score

```
CPR(g, q, H) = A(g,q) * D(g,H) * Q(g)          G* = TopK_g CPR(g, q, H)
```

- **A, addressability**: how strongly the population connects to the query's activated structures. Anchor overlap,
  typed incidence, PPR, PowerWalk, construction activation. Not words.
  `A = l1*PPR + l2*PowerWalk + l3*Anchor + l4*Construction`
- **D, discrimination**: variance of support across competing claims.
- **Q, quality**: independent source families, relation quality, temporal validity, exactness, provenance,
  answer-grade versus weak. Junk is suppressed *before* hydration.

Hydrate exact evidence only from `G*`.

## Hyperedge activation is role-conditioned

For `h = (r, p_1:v_1, ..., p_m:v_m)`:

```
a_h = sigma( theta_r + sum_i theta_{p_i} a_{v_i} + theta_q' q + sum_i a_{v_i} * theta_{p_i q}' q )
```

The last term is the point: roles matter differently per question. "Who gave Bob the book" makes the agent port
decisive; "what did Alice give Bob" makes the theme port decisive. Same event, different flow. The typed incidence
graph exists to preserve ports rather than flatten them into a clique — use it.

## Real jobs for two components that have none

**PowerWalk** is the escape hatch when first-order routing misses. The question is not whether it improves average
trivia. It is: does it increase recall of the decisive proof population when first-order routing fails? Testable.

**Relation potential** should not be fitted to "good edges". Fit it to
`P(e in Proof* | x_e, role(e), q)` — the probability this transition participates in a successful proof path. That
is meaningful, and it fits the existing seam exactly.

## The ingestion centerpiece: a proof address index

Not an embedding database. For each promoted structure compile: population id, typed relation signature, role
signature, entity and semantic class signatures, temporal signature, source-family count, contradiction signature,
construction memberships, walk sketch, graph quotient, exact evidence handles.

```
I : structural signature -> cold proof regions
q -> sigma_q -> I(sigma_q) -> candidate regions, with no evidence scan
```

## Why this makes accuracy, efficiency and traceability the same mechanism

**Accuracy.** Similarity retrieval likes evidence resembling the question. Fifty passages may discuss X and Y while
only two establish the relation after Y. Contrastive retrieval scores those two highly because they separate the
candidate values. That attacks exactly where a transformer looks impressive by inferring from broad context.

**Efficiency.** Work depends on `|G*|`, not `|corpus|`. As the brain grows 10^5 to 10^8 the hot region stays
roughly constant.

**Traceability.** Every retrieval decision emits a receipt: population, query binding, candidate claims,
addressability, discrimination, quality, evidence ids, source families. That is a distinct provenance layer above
the ones that already exist — selection, then evidence, then proof, then answer. A model can generate an
explanation of why it answered; this retains the actual computational lineage.

## Stopping

No new proof-field machinery. Existing proof-carrying answers and contradiction handling give the event: stop when
some h* is entailed and every serious competitor is refuted or below support threshold.

## The benchmark that settles it

Hold one exact proof constant. Grow distractors 10^3, 10^4, 10^5, 10^6. Measure both systems on answer accuracy,
unsupported-claim rate, evidence exactness, wall time, CPU, bytes examined, evidence touched, complete provenance.

The result to look for is the SHAPE, not the numbers: SCCE accuracy roughly flat and evidence touched roughly
constant while the reference degrades as the useful information stops fitting in context. That demonstrates
something a context window cannot replicate by being smarter.

## The mission, stated once

> Implement a proof-addressed cold-brain selector using the existing promoted structural populations, typed
> incidence graph, PPR/PowerWalk and exact evidence handles. Select evidence by expected ability to discriminate
> competing claim structures. Feed the existing graph slice without changing downstream cognition. Emit a complete
> selection receipt. Demonstrate that proof recall stays high as corpus size and distractor density grow by orders
> of magnitude. Then run the same scale experiment against the frozen reference model. Fix defects until SCCE wins
> simultaneously on answer accuracy, unsupported-claim rate, traceability, and resource usage.
