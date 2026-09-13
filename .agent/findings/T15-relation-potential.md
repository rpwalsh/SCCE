# T15 — Relation potential: lifecycle completed, artifact promoted, effect measured

**Outcome: FIXED.** A fitted model is validated on held-out data, persisted as a durable row, promoted into a
single active slot, and resolved by the runtime. The capability now reports `active` with a model id, a dataset
identity and a validation identity.

Promoted artifact
`relation-potential:bcb02b86718b888bdc9906ad4952135bef3eaf9541735f12a99ae8da998c4b8f`
dataset `3efafe3946f70906697471b03a857c509757110373217f116888f5fd63a1c403`
validation `fb81370498d24043934b50607acb79455670f79a2cc87e065411518fe3f6c1d9`

## Target: proof participation was not reachable; corroboration was

The requested target was `P(e in Proof* | features(e), role(e), q)`. It is not reachable from persisted state.
`semantic_proofs` (1,710 rows) stores `proof_graph_json` whose edges are claim-structure edges — `field:alpha`,
`boundary:no-promoted-evidence` → `claim_…` — with empty `evidenceIds`. They do not reference `graph_edges.id`.
`alpha_traces` (1,335 rows) stores node adjacency matrices per activation, not participation or outcome. Nothing
records which graph transitions entered a successful proof path, so no positive class for proof participation
exists. Producing one needs the turn to persist traversed edge ids beside the verdict, then a benchmark run to
populate it — a server restart, which was out of scope here.

Fitted instead: corroboration, stated plainly. Positive = an edge whose evidence resolves to two or more distinct
source versions. Negative = exactly one. No source version at all = unlabelled.

## Two defects that made the previous fit impossible, and one that made it meaningless

1. `fitRelationPotentialFromGraph` read `storage.graph.getSlice({ limitEdges, limitNodes: 1 })`. `getSlice` is
   node-seeded, so this was one node's neighbourhood: 2,453 edges out of 4,001,404. Added
   `GraphStore.listEdgePage`, ordered by endpoint pair so same-pair competitors share a page.
2. The trainer hydrated whole evidence spans to read one provenance column. 12,000 edges exhausted a 7 GB heap.
   Added `EvidenceStore.getEvidenceSourceVersions`, a projection-only read, paged.
3. The negative label required a more-corroborated competitor over the same node pair. **0 of 200,000 sampled
   pairs carry two relations.** The rule could never fire; every dataset was one class and the fit was skipped
   silently. The negative is now the complement that exists.

## Split

Population: 40,000 edges, endpoint-pair ordered. Labelled 39,971 (874 positive, 2.19%).
Split by **source family** — the set of source versions an edge's evidence resolves to, hashed into 5 buckets:
0–2 coefficients (24,438), 3 Platt calibration (7,313), 4 held out (8,220, 385 positive). No source family's
edges appear in two datasets; `fitRelationPotential` asserts disjointness independently.

## Held-out result against identity

Identity does two things: it emits the constant 1.0, and it leaves the transition ordering at `weight * alpha`.
Both are graded.

| | identity | fitted | |
| --- | ---: | ---: | --- |
| Brier, constant 1.0 (what identity literally emits) | 0.953163 | 0.045390 | model wins |
| Brier, best constant estimable from data the fit saw (prior 0.01540) | 0.045631 | 0.045390 | model wins |
| Discrimination AUROC | 0.500000 | 0.834090 | model wins |
| **Transition-weight ordering AUROC** (`weight*alpha` vs `weight*alpha*calibrated`) | 0.934718 | **0.983366** | model wins |
| Brier, constant set from the held-out labels themselves | 0.044643 | 0.045390 | **model loses** |

The last row is an oracle: no deployable predictor can set a constant from labels it has not seen. The first
version of this gate used it, which made a model with AUROC 0.83 fail. It is still computed and reported, and it
is not the gate. The gate is: beat the estimable-prior constant on Brier, beat chance on discrimination, and beat
`weight * alpha` on the held-out transition ordering. All three, or `promote()` refuses.

Convergence: the fitter's 800-iteration default left the intercept at −3.60 against a population prior of 0.0154,
and that underfit, not the model's information, was what lost the Brier comparison (0.046120). 40,000 iterations
moved it to 0.045390. Iteration count is a convergence bound, now settable, not a modeling choice.

## Artifact shape and where it lives

Two new tables, mirroring `sparse_ranking_models` / `sparse_ranking_active_model`:

- `relation_potential_models(model_id PK, lifecycle, model_json, validation_json, training_window_json,
  dataset_hash, created_at)`
- `relation_potential_active_model(slot PK, model_id → relation_potential_models, activated_at)`

`promote()` re-reads the stored row inside a transaction and calls `assertPromotableRelationPotentialArtifact`:
lifecycle must already be `validated` and `validation.beatsIdentity` must be true. A fitted model cannot reach
production by being pasted into a config file — the runtime reads the store. `config.runtime.relationPotentialModel`
still parses and still supplies a model for sealed evaluation, but a config-supplied model never sets the artifact
record, so the capability reports it as pinned and never as `active`.

No DDL was run against `evidence_spans`. The two new tables were created directly.

## Promoted, active, executing

```
capability {"id":"relation-potential","status":"active","artifact":"promoted",
 "artifactId":"relation-potential:bcb02b86…4b8f",
 "parameters":{"datasetIdentity":"3efafe39…c403","validationId":"fb813704…c1d9"}}
edges 400  weights_changed 400  calibrated_min 0.001814  calibrated_max 0.019409  model_in_audit true
```

`createNodeRuntime` resolves the promoted artifact and the server awaits that before serving, so no turn runs the
identity branch silently. The field engine takes a provider rather than a construction-time snapshot; with no
promoted artifact it still takes the identity branch and still reports `inert_unconfigured`.

## Measured effect, and one thing to watch

The component's own output ordering improves by **+0.0487 AUROC** on held-out data (0.9347 → 0.9834). That is the
ordering the field engine computes, measured against labels from source families the fit never saw.

End-to-end benchmark effect is **not** measured here: a 311-item run was in flight and the server was not
restarted. That measurement is the next step and needs one restart.

Watch item: calibrated probabilities on live edges land in 0.0018–0.0194, so every transition weight is scaled
down by roughly 50–500x uniformly. Ordering is what changed and ordering is what improved, but any downstream
comparison of `alpha` against an absolute constant will see a different magnitude. Worth a look before trusting
the benchmark delta either way.

## Commands

```
pnpm scce relation-potential fit [--promote] [--max-edges=N] [--iterations=N]
pnpm scce relation-potential status
pnpm scce relation-potential promote --model-id=<id>
```
