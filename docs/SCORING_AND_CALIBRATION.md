# Scoring And Calibration

Status: runtime tracing and calibration infrastructure implemented; representative
calibration incomplete

Scores in SCCE have different meanings. A similarity, route weight, guard threshold,
or slice-relative normalization value is not automatically a probability. A score may
be described as calibrated only when its trace identifies a fitted calibrator and the
held-out evaluation supporting that claim.

## ScoreTrace Contract

`packages/kernel/src/scoring/score-trace.ts` records score kind, value/range,
meaning, inputs, provenance, calibration status, optional calibration ID, and failure
modes. Candidate, retrieval, Walsh surface-energy, developer-intelligence, and proof
paths emit these traces. Provisional estimates remain explicitly provisional.

Calibration utilities live in:

- `packages/kernel/src/scoring/calibration.ts`
- `packages/kernel/src/scoring/evaluation.ts`

Implemented evaluation metrics are Brier score, negative log likelihood, and expected
calibration error. PostgreSQL schema v12 also includes durable calibration-observation
storage. Infrastructure and persistence do not, by themselves, establish calibration.

### Source-group-disjoint holdout evaluator

The repository exposes a bounded evaluator for caller-supplied calibration
observations:

```powershell
pnpm calibration:evaluate --input <observations.json|jsonl> --dataset-id <immutable-id>
```

Every observation must carry an explicit source-record identity. The evaluator splits
by that identity, fits only on the fit group, evaluates the untouched holdout, and
reports Brier score, negative log likelihood, and expected calibration error. Dataset,
split, fit, outcome, bin-count, and model identities are content-bound in the report.
The emitted claim boundary is `supplied_source_disjoint_holdout_only`.

The command contains no bundled example masquerading as evaluation data and does not
establish that its input is representative. No representative calibration dataset or
result has been executed for this release; the evaluator is a mechanism for producing
such a record when suitable observations are supplied.

## Alpha Normalization

Relation strength no longer uses an unnormalized product of six support factors and
does not reuse `edge.alpha` as query utility. For compatibility, source quality remains
the provenance factor and `edge.weight` remains relation compatibility. Missing utility
metadata is neutral. The current uncalibrated interaction is the equal-weight geometric
mean

```text
g = exp((1/6) * sum_i(log(f_i)))
s = g * (1 - contradictionPenalty)
```

for compatibility, provenance, temporal fit, modality agreement, recurrence, and
query-conditioned utility. A zero support factor produces zero strength. Equal weights
are an explicit bootstrap choice, not a learned importance model.

Unconfigured alpha thresholds are deterministic Hyndman-Fan Type-7 sample quantiles at
the configured four probability positions over current active-edge strengths.
Diagnostics identify `empirical_quantiles`, `configured`, `degenerate_sample`, or
`empty_sample` mode and record sample statistics.

This is rank normalization within a graph slice. It is not an outcome-fitted
calibrator, does not make values comparable across arbitrary corpora, and must not be
reported as confidence. Explicit configured thresholds are validated and traced but
remain uncalibrated until evaluation evidence says otherwise.

## Directed PPR

`packages/kernel/src/ppf.ts` computes sparse personalized PageRank over explicit
relation-direction policy. It reports convergence, residual, iteration count, relation
policy counts, and bounded transition/restart contributions. A dense linear oracle is
used for focused correctness tests. PPR mass is graph-routing mass, not factual
confidence.

## PowerWalk PPMI

PowerWalk uses deterministic second-order transitions and sparse PPMI representations.
Training snapshot identity binds seed, source identity, partition policy hash, and
actual train/validation split hash. Validation pairs are disjoint from fit pairs, and
zero-context nodes do not receive a hash-vector substitute. The learned representation
is consumed in production through query-conditioned cosine expansion into field seeds.

The current expansion threshold and scale are engineering parameters, not calibrated
probabilities. Representative outcome-based fitting, drift criteria, and durable
incremental state loading remain open.

## Spectral, Diffusion, And Flow Operators

Bounded symmetric Laplacian partitions use a Jacobi eigendecomposition. The output
reports the second-smallest eigenvalue as algebraic connectivity, the difference
`lambda_3 - lambda_2` as the two-way partition eigengap, the Fiedler vector, convergence,
and its residual. The previous invented transform of a single Rayleigh quotient is gone.

The generic transition-chain helper reports an absolute mixing gap only after checking
square finite row-stochastic input, irreducibility, aperiodicity, and reversibility. A
non-reversible chain gets `available: false` and a zero compatibility sentinel; it is
not silently symmetrized. PowerWalk retains its independent assumption-gated contract.

Heat and wave operators use their linear updates without coordinate-wise `[0,1]`
clipping. Explicit unstable step sizes are rejected; internal field tracing uses the
graph-derived stable default. Max-flow/min-cut returns raw flow and cut capacity, plus
separately named normalized and unmet flow ratios.

These changes make the quantities honest, but they do not establish that the operators
improve answer quality on representative tasks.

## Causal Output Boundary

Graph topology and activation mass do not identify a treatment effect. The graph-only
estimator therefore returns `numericalEffectStatus: "not_identified"`, a null numerical
effect, an explicitly unverified structural-adjustment hypothesis, and a separately
named `graphEffectHeuristic`. It does not emit Pearl ATE, PFACE ATE, or `doIdentified`.
Mediator/evidence-overlap pruning is named mediator-path redundancy pruning rather than
Reichenbach screening.

When sample support scores exist, the lower bound uses the sample mean and Hoeffding
term; spectral instability is a separate penalty. There is still no observational or
interventional sample contract for a numerical causal-effect estimator.

## Weighted Feature Sketch

`latent.ts` is an alpha-weighted frequent-feature sketch with a deterministic hash
projection. New code uses `WeightedFeatureSketch`, `supportShare`, and `projection`; it
does not describe the result as PCA, factorization, explained variance, or a fitted
latent-variable concept. Historical field aliases remain readable for persisted-record
compatibility and conservatively contribute zero support when the newer support share
cannot be recovered.

## Relation Potential V2

`packages/kernel/src/relation-potential.ts` requires three ID-disjoint datasets:

1. `coefficientTraining` fits coefficients;
2. `calibrationFit` fits the Platt transform; and
3. `evaluationHoldout` reports post-fit Brier score and ECE.

The published model is strictly validated, frozen, and content-addressed. Production
field activation consumes its calibrated score only when a model is configured and the
evaluation condition allows it. Otherwise the trace reports an identity mode rather
than reporting a fitted potential.

The repository does not currently contain a representative frozen model trained on
production outcomes. The mechanism is implemented; representative uplift and general
calibration are not proven.

## Requirement, Proposal, Judge, And Revision Scores

`turn-requirements.ts` projects learned language/dialogue/construct activations and
structured requirements into 16 bounded dimensions, then activates 17 cognitive
operators. The shipped requirement and operator coefficient models are versioned
`uncalibrated_bootstrap` values. Their sigmoid outputs are activation estimates, not
probabilities of task success and not evidence that an English lexical router was
replaced by a trained representative model.

`cognitive-planner.ts` scores reasoning and invention quality and performs bounded
MMR proposal selection. `candidate.ts` and `judge.ts` then combine requirement fit,
proposal quality, evidence/truth terms, force compatibility, and penalties. The judge
uses a temperature-bounded Boltzmann distribution and samples it outside deterministic
replay; deterministic replay selects the maximum. Hard-failed candidates have zero
selection probability. These coefficients remain provisional unless an emitted trace
identifies a fitted task-specific calibrator.

`answer-revision.ts` is a bounded optimization guard, not an open-ended generator. It
permits no more than two rounds and accepts a revision only with at least `0.025`
quality gain and no hard invariant failure. That threshold and the surface-quality
blend are engineering parameters; citation integrity, test preservation, action
receipt requirements, and telemetry exclusion are hard guards rather than confidence
scores.

## Other Provisional Selectors

Candidate mass, hybrid retrieval blends, question-slot weights, proof blends,
translation preservation scores, requirement/operator activation, proposal quality,
judge selection, revision quality, and Walsh surface-energy weights still include
guards or provisional estimators. Their traces and hard boundaries improve
auditability but do not turn fixed coefficients into empirical truth. This document
is the maintained inventory of their calibration status.

## Required Evidence Before A Calibration Claim

- Versioned, task-representative observations with immutable split identity.
- No overlap between estimator fitting, calibrator fitting, and final evaluation.
- Calibration ID and dataset/model hashes in emitted traces.
- Held-out Brier/NLL/ECE plus task utility and failure-rate reporting.
- Drift thresholds evaluated in CI or the sealed harness.
- Explicit fallback behavior for missing, stale, incompatible, or condition-disabled
  models.

Until these conditions hold for a subsystem, its documentation and UI must say
`provisional`, `uncalibrated`, `slice-relative`, or `identity-unconfigured`, as
appropriate.
