# Selective cognitive field

The architectural hypothesis, stated so it can be falsified:

> General useful reasoning does not require globally active intelligence. A sufficiently structured persistent
> knowledge system can perform bounded general reasoning by maintaining cheap global sufficient statistics and
> spending expensive computation only on the request-conditioned uncertainty frontier.

The sentence on the wall: **never load knowledge because it exists; load it because the current proof says it is
worth buying.**

## Two brains, one addressable

COLD: the whole corpus, graph, constructions, statistics, provenance. Persistent, compiled at ingest, almost
untouched during a turn. Not "loaded" — *addressable*.
HOT: a bounded request-specific field. Hypotheses, a graph slice, proof obligations, candidate operations, budget.
Maybe tens of nodes. Cognition costs O(hot), not O(brain).

Stop asking which 48 MB of language model a turn should hydrate. Ask what compact global index is sufficient for
this turn to know which cold information deserves hydration.

## Three epistemic tiers, no reverse leakage

| tier | what | admissible as |
| --- | --- | --- |
| **hint** | cheap approximate sketch: cardinality, heavy hitters, min-hash neighbourhood | selection only, NEVER proof |
| **evidence** | exact persisted observation with provenance | support |
| **proof** | evidence plus admitted structure satisfying the claim's requirements | an answer |

Sketches decide where to look. Exact records decide what is true. **Lossy selection, lossless cognition.**

## The scheduler

Every subsystem bids for the right to run, and proves afterward that its computation was worth buying.

```
EPG(a) = expected proof-entropy reduction * relevance / cost
a* = argmax EPG(a)
stop when max EPG(a) < 1
```

Proof pressure on an unresolved hypothesis is relevance * uncertainty * downstream dependency. Uncertain but
irrelevant is ignored; relevant but resolved is ignored; both is where cognition belongs. Surprise is not
importance: weight it by mutual information with the active proof target.

## Why this rescues the ablation problem

The current ablation says removing the graph, PowerWalk, diffusion and relation potential does not hurt the
benchmark. The likely reason is not that they are useless but that they are run on tasks that need no search for
what to think about. A capital lookup does not need cognition.

So stop asking "does disabling PowerWalk lower aggregate accuracy" and start measuring, per component:

```
ROI(i) = proof uncertainty removed because of i / compute consumed by i
```

and benchmark on tasks retrieval cannot solve: many irrelevant facts, several locally plausible ones, competing
hypotheses, a misleading correlation, a contradiction, one small proof path.

New measures beside correct/incorrect: proof efficiency (obligations closed per unit compute), search efficiency
(relevant retrieved / inspected), and cognitive selectivity (1 - cold brain touched / available).

## Evidence ledgers, not booleans

A predicate like `sharesStem(a, b): boolean` collapses too early. Maintain a ledger and sum log-likelihood ratios,
with dependence corrections. This is why continuation-diversity must be a factor and not a gate: "sparse, unresolved"
is not "reject", and as a gate it killed bind/bound.
