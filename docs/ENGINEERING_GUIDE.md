# SCCE Engineering Guide

Status: current implementation contract; production calibration remains provisional

## Runtime Principle

The runtime chain must preserve this rule:

```text
meaning first, surface last
```

Text should be the final product of graph state, answer planning, LanguageMemory, and Walsh surface energy. Text should not be the controlling intermediate representation for cognition.

Proof is also not a speech gate. Proof is a certification layer. The Mouth can produce creative, inferred, prior-bound, or source-bound speech, but certification must remain explicit.

Insufficient support is a control transition, not a prose template. The kernel gets one bounded opportunity to learn from eligible local state or perform configured search/fetch, pass any result through canonical typed ingestion, update the active graph/frontier, and replan. The planner must then select the strongest honest source-bound, qualified, or non-certified creative answer available; the Mouth realizes that selection. Mouth may return an empty internal surface to request continuation, but an empty surface or canned refusal must not be emitted as the final answer.

## Main Call Stack

The intended call stack is:

```text
source records
-> hydration contract
-> cognitive graph compiler
-> alpha field activation
-> directed PPR / PowerWalk representation and ranking
-> semantic proof adapter and proof engine
-> relevance gate
-> question slot planner
-> AnswerPlan
-> LanguageMemory realization
-> Walsh surface energy
-> Mouth output
-> inspect/replay trace
```

No layer should convert raw traces, IDs, snippets, n-grams, or telemetry into final spoken text by itself.

The exported `createSourceOnlyScceRuntime` is a bounded, in-memory source-only runtime
for fixture and diagnostic work; `createScceRuntime` currently aliases it. It is marked
as simulation/non-hydrated and does not replace the PostgreSQL-backed production lane.
Both it and `kernel.turn` project request authority through the shared
`projectRequestAuthority` function after deriving the source-neutral requirement field.

## Mathematical Spine

For the full serious-version optimization and calibration contract, see `docs/SERIOUS_VERSION_MATH_APPENDIX.md`.

### Cognitive Graph Compiler

The compiler turns source observations and learned priors into typed graph facts.

A candidate cognitive edge is scored approximately as:

```text
C(c | r, q)
  = semanticQuality
  * entityCoherence
  * relationAffordance
  * questionFit
  * supportMass
  * salvageConfidence
  * (1 - contradictionPenalty)
```

This is a conceptual decomposition, not the exact implemented formula and not a
calibrated probability model. The emitted score traces are authoritative about which
features and calibration status participated in a particular run.

Where:

- `semanticQuality` measures whether the edge carries useful meaning rather than raw textual debris.
- `entityCoherence` measures whether subject and object belong together.
- `relationAffordance` measures whether the relation can answer the current kind of question.
- `questionFit` measures whether the edge belongs in the requested answer.
- `supportMass` measures source/prior support.
- `salvageConfidence` allows useful recovered edges to survive when source formatting is imperfect.
- `contradictionPenalty` suppresses unstable or conflicting material.

This layer should reject noise before Mouth ever sees it.

### Alpha Fabric Reasoning

The alpha layer activates a graph neighborhood around the current request. When
thresholds are not configured, `alpha.ts` derives them with deterministic Hyndman-Fan
Type-7 quantiles over the current active edge-strength sample. That is slice-relative
normalization, not outcome calibration and not a confidence probability. Empty and
degenerate samples have explicit diagnostic modes.

A useful path score has the shape:

```text
PathScore(path)
  = sum(nodeActivation)
  + sum(edgeWeight)
  + roleFit
  + slotFit
  + bridgeValue
  - backgroundPenalty
  - contradictionPressure
```

The goal is not merely to find nearby facts. The goal is to find facts that play the right role in the answer.

### Directed Personalized PageRank / Perron-Frobenius

`ppf.ts` ranks activation mass through the graph while preserving personalization
from the request. Relations must declare `directed`, `reversible`, or
`learned_inverse` transition policy. The implementation does not manufacture reverse
edges. Sparse iteration reports convergence and residual evidence, and focused tests
compare it with a dense linear oracle.

It is used to:

- Keep the active topic central.
- Promote strongly connected support.
- Avoid letting unrelated high-degree nodes dominate.
- Keep background context below answer-core material.

PPR mass is graph-routing mass, not factual confidence.

### Requirement-Projected Authority

`request-authority.ts` projects the 16-dimensional requirement field to factual,
reasoned, creative, translation, program, or action authority. Its values are bounded
routing energies, not probabilities. An explicit structured authority remains a traced
override. Shared dialogue and graph-support helpers feed the same cognitive-operator
activation contract in the kernel and source-only runtime; request surface words are
not used as an authority router.

### PowerWalk PPMI

PowerWalk supplies deterministic second-order graph contexts. Sparse PPMI fitting uses
pair-disjoint training and validation partitions whose policy and actual membership
are bound into snapshot identity. Zero-context nodes receive no invented hash-vector
representation. The production path consumes the learned representation by expanding
query anchors into bounded field seeds using cosine similarity.

Graph statistics initialize `p`, `q`, and temporal-decay `lambda`; that initializer is
explicitly unfitted. A separate bounded coordinate-descent fitter consumes supplied
typed transition choices, keeps source records disjoint between fit and holdout, and
optimizes multinomial NLL in log space. It exposes initialized parameters, the fitted
candidate, and active parameters separately. The candidate becomes active only when
fit mean NLL improves and untouched holdout mean NLL clears the configured improvement
threshold; otherwise initialization remains active.

That gate is evidence only for the supplied source-disjoint observations. It is not
probability calibration and does not establish representativeness. Current expansion
thresholds and scale are provisional engineering parameters. Durable incremental-state
loading and representative outcome review remain open.

### VAR Forecast Diagnostics

`spectral-forecast.ts` fits candidate VAR orders on a common estimation window and
selects conditional multivariate-Gaussian AIC with regression and free covariance
parameters included in the count. Adaptive-jitter Cholesky computes covariance log
determinants. Insufficient observations or residual degrees of freedom produce a
reason-labeled random-walk-with-drift cold start instead of a fitted finite-AIC model.
Stability uses the full block companion matrix and shifted real QR with
1x1/2x2 Schur blocks; non-convergence is explicitly degraded to an infinity-norm upper
bound. Horizon `h` covariance is the unscaled Wold sum through `Psi_(h-1)`. Its reported
Gaussian intervals are labeled uncalibrated and do not establish empirical coverage.

### Relation Potential V2

Relation potential projects source-neutral typed edge signals and fits coefficients,
a Platt calibrator, and final evaluation on three ID-disjoint datasets. Frozen models
are content-addressed and strictly validated. The field consumes a configured model;
without one, it records an explicit identity-unconfigured mode. The repository does
not yet ship a representative production-trained model, so no uplift claim follows from
the implemented fitting contract.

### alpha Rhetorical Centrality

For answer planning, path relevance is converted into rhetorical centrality:

```text
ARC(path, role | question)
  = PathScore(path)
  * RoleScore(role)
  * BridgeValue(path)
  * SubjectCentrality(path)
  * ForceMeaning(path)
  * (1 - BackgroundPenalty(path))
  * (1 - ContradictionPressure(path))
```

This is the point where math must move before Mouth. Mouth should not decide that a Babbage edge is more important than an Ada contribution edge. The graph planner should decide that before text exists.

### Question Slot Planner

The slot planner converts a request into an answer contract.

It produces:

- `requiredSlots`
- `filledCoreSlots`
- `filledSecondarySlots`
- `missingSlots`
- `selectedAnswerCore`
- `selectedContext`
- `partialSupport`

For example:

- "Who was Albert Einstein?" should prioritize role, field, known-for, and major contribution.
- "Who was Ada Lovelace and what was her contribution?" should prioritize identity, contribution, Analytical Engine, notes/algorithm, and computing significance.
- "Who are the main characters in Star Trek?" should prioritize character/cast relations.
- "What is relativity?" should choose a sense before mixing physics and unrelated senses.

### Answer Plan Energy

Before sentence generation, the runtime should minimize an answer-plan energy:

```text
E_answer
  = missingSlotCost
  + weakPathCost
  + backgroundOverweightCost
  + senseMixingCost
  + fragmentationCost
  + unsupportedCertificationCost
  - contributionCoverage
  - bridgeCoverage
  - subjectContinuity
  - supportCoverage
```

This keeps answer completeness from being a cosmetic afterthought.

### Meaning-To-Language Mouth

LanguageMemory should turn an already selected semantic plan into discourse. Mouth input consists of semantic values, relations, answer force, and evidence bindings; role IDs, proof keys, receipts, and trace state remain structured controls.

It should use:

- n-gram and phrase priors.
- observed symbol counts.
- semantic frames.
- relation ordering.
- register and detail profiles.
- correction memory.
- discourse boundaries.

It should not treat atomic graph triples as finished sentences unless the learned language machinery actually realizes them that way.

Direct source wording is reserved for an explicit source-answer construct with bound evidence. Program, action, and creative constructs must be realized as ordinary language or artifacts rather than exposed as workflow notation.

`learned_structural_composition` inserts exact request-owned spans into source-owned learned sentence structure. It preserves code-point and UTF-8 byte coordinates, source-activation IDs, and nonempty `sourcePieceIds`; these bindings grant no evidence authority.

### Walsh Surface Energy

Walsh surface energy selects among candidate surfaces.

The implemented energy components include:

- semantic loss
- proof violation
- force mismatch
- contradiction leak
- repetition cost
- fragment cost
- caveat loss
- correction violation
- style vector distance
- detail profile distance
- boundary instability
- language prior support
- actionability
- compression fit

The scoring rule is:

```text
E_surface
  = weightedLoss
  - weightedSupport
  + hardSurfacePenalty
```

Proof contributes to energy and trace. Proof is not a universal hard rejection. Hard rejection is reserved for things that should never be selected as final speech, such as canned answer speech, phrase salad, direct quote mutation, or a learned prior cited as direct evidence.

## Current Important Files

Key kernel files:

- `packages/kernel/src/kernel.ts`
- `packages/kernel/src/alpha.ts`
- `packages/kernel/src/ppf.ts`
- `packages/kernel/src/powerwalk.ts`
- `packages/kernel/src/powerwalk-ppmi.ts`
- `packages/kernel/src/relation-potential.ts`
- `packages/kernel/src/field.ts`
- `packages/kernel/src/question-slot-planner.ts`
- `packages/kernel/src/mouth.ts`
- `packages/kernel/src/language-memory-runtime.ts`
- `packages/kernel/src/walsh-surface-energy.ts`
- `packages/kernel/src/semantic-proof-engine.ts`
- `packages/kernel/src/semantic-proof-adapter.ts`
- `packages/kernel/src/program.ts`
- `packages/kernel/src/program-planner.ts`
- `packages/kernel/src/program-runtime.ts`
- `packages/kernel/src/calibration-evaluation.ts`
- `packages/kernel/src/patch-transaction.ts`
- `packages/kernel/src/workspace-kernel-context.ts`

Key adapter/runtime files:

- `packages/adapters-node/src/postgres.ts`
- `packages/adapters-node/src/workspace-patch-transaction.ts`
- `packages/adapters-node/src/structured-patch-validation.ts`
- `packages/adapters-node/src/docker-sandbox-patch-validation.ts`
- `packages/adapters-node/src/workspace-runtime.ts`
- `packages/cli/src/index.ts`
- `packages/server/src/index.ts`
- `packages/vscode/src/extension.ts`

PostgreSQL schema version 12 is current. Its brain lifecycle contract permits
`CREATED`, `IMPORTING`, `VALIDATING`, `READY`, `ACTIVE`, `STOPPED`, `FAILED`,
`QUARANTINED`, and `INCOMPATIBLE`; activation is READY-only and transactional, and a
partial unique index enforces at most one ACTIVE lifecycle row.

## Force Classes

Every imported or generated memory item should preserve force.

Common force classes:

- `direct_evidence`
- `profile_excerpt_evidence`
- `learned_language_prior`
- `learned_concept_prior`
- `learned_program_prior`
- `unknown_prior`

Direct evidence can certify when source version and evidence span are present. Learned priors can guide graph activation, language, and inference. They should not be mislabeled as direct evidence.

## Proof And Speech Contract

The runtime must separate these two questions:

```text
Can SCCE say this?
Can SCCE certify this?
```

The answer to the first can be yes for conversation, invention, inference, or prior-bound explanation.

The answer to the second is yes only when proof succeeds.

Engineering implication:

- Do not emit `unsupported_prior_only` or `insufficient_evidence` as silence or a generic refusal; route them through the bounded recovery transition.
- Do not mark unsupported speech as certified.
- Do keep proof verdicts in traces.
- Do let the planner select useful prior-bound, reasoned, or creative meaning when the corresponding authority permits it; Mouth realizes that selection.
- Do require contradiction or temporal proof before correcting a false factual premise with a negative claim.

## Question Slot Planner Integration

The planner is wired into the semantic-answer construct state.

It ranks cognitive edges by:

- request fit
- slot fit
- alpha rhetorical centrality
- subject centrality
- force meaning
- support
- graph quality
- background penalty
- contradiction pressure

The selected core facts become the answer core. Secondary facts become context. Raw language/profile/snippet material is excluded from answer core.

## Workspace Runtime Integration

The workspace runtime promotes source-backed records into:

- graph context
- proof context
- learning context
- ProgramGraph context
- Mouth input

The recent call-stack fix ensures that a workspace answer draft is not rejected as an echo of itself when the entailment claim is the draft. It also ensures that a certified proof with source text gives Mouth source material rather than isolated required terms.

## Surface Selection Rules

Walsh surface energy should:

- Preserve meaning.
- Prefer answer-complete surfaces.
- Penalize unsupported certification.
- Penalize contradiction leaks.
- Penalize clipped fragments.
- Reward language-prior support.
- Keep proof verdicts in trace.

It should not:

- Silence every non-certified candidate.
- Select phrase salad.
- Select canned answer prose.
- Let trace keys become speech.
- Let raw n-grams become facts.

## Testing Expectations

Core checks:

```powershell
pnpm validate
pnpm audit --audit-level high
pnpm repo:deps
pnpm rehearsal:postgres
pnpm rehearsal:adapter
pnpm scce hygiene language-control
```

Focused checks for this area:

```powershell
pnpm vitest run packages/kernel/src/__tests__/question-slot-planner.test.ts
pnpm vitest run packages/kernel/src/__tests__/walsh-surface-energy.test.ts
pnpm vitest run packages/kernel/src/__tests__/end-to-end-working-machine.test.ts
pnpm vitest run packages/adapters-node/src/__tests__/workspace-kernel-context.test.ts
```

Useful live questions after hydration:

```powershell
pnpm scce turn "Who was Ada Lovelace and what was her contribution to computer science?"
pnpm scce turn "Who was Albert Einstein?"
pnpm scce turn "Who are the main characters in Star Trek?"
pnpm scce turn "What is relativity?"
```

Operational diagnosis should inspect both answer text and trace.

## Known Limitations

Current source code is not the same as full deployed proof.

Remaining engineering work includes:

- Hydrating large real corpora without memory pressure.
- Importing every useful SCCE2/V2 brain section.
- Strengthening multilingual language realization from trained profiles.
- Running a broad live question battery after hydration.
- Removing remaining source paths where answer prose can bypass learned language generation.
- Improving answer-plan extent for long explanatory answers.
- Proving server/API parity with CLI and replay.
- Fitting representative relation-potential, PowerWalk, truth, contradiction, and
  selector calibration on immutable disjoint splits. The implemented PowerWalk
  source-record-disjoint NLL acceptance gate does not establish representativeness.
- Persisting and validating durable incremental PowerWalk state across real imports.
- Extending the coding-request bridge beyond its two tested TypeScript repair paths.
  Current support is limited to source-proven unused type-only import removal and one
  official TypeScript LanguageService action rooted at an existing requested file. A
  structured positive integer diagnostic code (`diagnosticCodes` over HTTP or
  `--diagnostic-code=<integer>` in the CLI) must resolve to one candidate; request prose
  never selects the action. The compiler sees
  durable snapshot files plus the TypeScript standard library and requires an exact
  project config resolved from the source-observed direct `tsc` invocation. The
  requested file must belong to that parsed project. Source-observed build/test
  commands are required, and the returned plan is unauthorized and unexecuted.
  The selected action may close over up to 32 files and 128 exact text changes,
  including bounded TypeScript/JavaScript creation under existing snapshot directories.
  Command-bearing actions, out-of-workspace targets, stale replacement bases, invalid
  creations, and overlapping changes remain unsupported. Arbitrary feature synthesis
  is outside this path. `regressionProtection` remains `0` until execution evidence
  exists.
- Reviewing the optional Docker validator's daemon, operator, image-supply-chain, and
  host-kernel trust boundary for each deployment. Trusted-host staging is not an OS
  sandbox, and the passing local Docker smoke test is not attestation.
- Testing packaged VS Code visual behavior, restart recovery, approval, and a live
  patch receipt; the current host smoke covers installation, activation, command
  registration, and readiness only.

## Engineering Rule Of Thumb

When a behavior is weak, do not immediately patch Mouth prose.

Inspect in this order:

1. Was the right data hydrated?
2. Did graph compilation keep the right facts?
3. Did alpha/PPF activate the right neighborhood?
4. Did semantic proof preserve the right force?
5. Did the question slot planner select the right answer core?
6. Did LanguageMemory realize enough discourse?
7. Did Walsh surface energy select or reject the right surface?

Fix the first broken layer. Do not hide it with canned output.
