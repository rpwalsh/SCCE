# SCCE Architecture Map

Status: unfinished local runtime with implemented paths; representative calibration and independent review remain incomplete
This document maps the current source tree. It does not certify production readiness or broad runtime quality.

## One-Lane Runtime

```text
scce.config.json
-> packages/adapters-node/src/config.ts
-> packages/adapters-node/src/runtime.ts
-> packages/kernel/src/kernel.ts
-> source evidence / typed observations
-> graph and hypergraph slice
-> alpha-normalized field
-> directed PPR and PowerWalk-assisted activation
-> learned turn-requirement field and cognitive operators
-> cognitive proposals with per-claim bases
-> requirement-aware candidate/judge selection, proof, contradiction, and slot planning
-> one bounded learn/search/fetch, canonical-ingest, and replan transition when needed
-> packages/kernel/src/mouth.ts
-> bounded answer revision
-> traceable answer and durable turn events
```

There is one cognitive runtime, one ingest/training path, one mouth path, and one
canonical durable-store contract. There is no external-model, hosted-inference,
prompt-stuffing, or SQL-text-search fallback lane. PostgreSQL is the canonical durable
store; graph reasoning occurs in the kernel rather than in broad text queries.

Configuration is read from `scce.config.json`. Runtime database configuration is not
silently inferred from generic process state: a non-empty, explicit
`SCCE_DATABASE_URL` is the sole database URL override and is applied before config
validation so credentials need not be committed.

## Math Placement And Current Contract

- `packages/kernel/src/alpha.ts`: relation-strength normalization and alpha trace.
  Without configured thresholds it uses deterministic Hyndman-Fan Type-7 quantiles
  over the active slice. Those thresholds are slice-relative, not globally calibrated
  probabilities. Empty and degenerate samples are explicit trace modes.
- `packages/kernel/src/ppf.ts`: sparse directed personalized PageRank/Perron-Frobenius
  iteration. Every relation has an explicit `directed`, `reversible`, or
  `learned_inverse` policy; the runtime does not synthesize reverse edges. Convergence
  and bounded transition/restart contributions are traceable, and a dense linear
  oracle exists for tests.
- `packages/kernel/src/powerwalk.ts` and `powerwalk-ppmi.ts`: deterministic
  second-order walks, pair-disjoint training/validation partition identity, sparse PPMI
  representations, and query-anchor cosine expansion into production field seeds.
  Zero-context nodes receive no invented fallback representation. Graph statistics
  provide explicitly unfitted initialization. A separate bounded fitter consumes
  caller-supplied typed transition choices, splits by source-record identity, optimizes
  `p`, `q`, and temporal decay by multinomial NLL, and activates the fitted candidate
  only when both fit and untouched holdout NLL improve. This is not representative
  calibration. Current expansion thresholds and scale remain uncalibrated, and durable
  incremental-state loading is not yet established.
- `packages/kernel/src/spectral-forecast.ts`: conditional-Gaussian VAR order selection
  by AIC on a common estimation window, adaptive-jitter Cholesky log determinants, full
  companion-matrix stability diagnostics, and exact horizon-specific Wold covariance.
  Insufficient data or residual degrees of freedom produces a reason-labeled
  random-walk-with-drift cold start rather than a fitted finite-AIC claim. QR
  non-convergence degrades to a labeled infinity-norm upper bound. Gaussian forecast
  intervals are explicitly uncalibrated.
- `packages/kernel/src/relation-potential.ts`: source-neutral graph-edge features,
  coefficient fitting, Platt calibration, and evaluation metrics on three disjoint
  datasets: coefficient training, calibration fit, and evaluation holdout. The frozen,
  content-addressed model is consumed by the production field when configured. No
  representative production model has been fitted, so the default path is an explicit
  identity-unconfigured mode.
- `packages/kernel/src/structured-semantic-candidate.ts` and
  `relation-promotion.ts`: evidence-bearing structured relation candidates and the
  separate source-family-disjoint description-length compiler that decides whether
  their incidence may be marked reusable. Proposed candidates remain outside the
  ordinary graph. This path uses explicit data/model codes and negative controls; it
  is distinct from turn-time relation-potential scoring.
- `scce.hyperedge.v2` in `types.ts` and typed-ingest materialization: canonical
  zero-or-more-arity relations with observed/omitted ports, qualifiers, modality,
  temporal scope and evidence. PostgreSQL v23 persists these fields directly;
  `memberNodeIds` is a derived retrieval index only.
- `opaque-role-induction.ts`: source-disjoint held-out-MDL selection of opaque role
  populations from surface, neighborhood, substitution, transformation and discourse
  evidence. Learned `roleId` is separate from per-occurrence `portId`.
- `role-surface-order.ts`: separately compiled \(P(p\mid r,G)\) semantic-role and
  \(P(\operatorname{position}\mid p,r,c,d)\) realization fields. Position never
  defines a role; omission and repeated realization are explicit learned states.
- `typed-incidence-graph.ts`: lossless arbitrary-arity hyperedge lift into relation
  nodes and typed participant incidences. The field engine uses reversible incidence
  transitions without participant cliques; omitted ports remain null incidences.
- `sparse-alignment-candidates.ts`: content-addressed typed-incidence target indexes
  and hard-degree-bounded anchor/evidence/structure/context candidate support. The
  production ingestion and explicit-training paths materialize
  \(O(|S|K_\Pi)\) candidates rather than a dense surface×graph matrix.
- `sparse-fused-transport.ts`: sparse generalized Sinkhorn scaling, exact-anchor
  row-mass reservation and bounded local fused structural correction with explicit
  objective, residual, work and memory traces. The non-convex solver makes no global
  optimum claim.
- `transport-evidence-allocation.ts`: normalized per-cell evidence conditionals that
  partition transport mass exactly. Positive mass without evidence remains
  explicitly unresolved instead of receiving invented provenance.
- `typed-null-alignment.ts`: source-exact Beta-Bernoulli cost induction for universal
  surface-null and graph-implicit states. Sparse transport retains candidate-free
  rows and targets and records typed deficit and excess mass explicitly.
- `population-ordering.ts`: bounded source-exact relative-position induction keyed
  by segmentation population and reusable typed relation/port/opaque-role keys,
  plus explicit global structural-pair backoff. The sparse solver evaluates its
  robust ordering term only on active candidate neighborhoods.
- `cross-document-alignment.ts`: canonical typed graph-port projections, dependency
  family collapse, independent-family consistency distances, and second-pass sparse
  correction costs.
- `alignment-alternatives.ts`: bounded non-anchor branch extraction, immutable
  alternative-plan revisions, evidence-allocation references and restricted-set
  Gibbs weights without a global-posterior claim.
- `coarse-to-fine-alignment.ts`: reusable structural quotient-community routing,
  exact-anchor preservation, selected/omitted upper bounds and the unified
  routing/Sinkhorn/local-correction/k-best trace.
- `alignment-heldout-evaluation.ts`: automatic source-family cross-fitting,
  pre-transport candidate recall, graph recovery and content-addressed calibration
  and promotion observations.
- `alignment-calibration.ts`: source-family-disjoint labeled calibration over
  transport/cycle features with untouched holdout log loss, Brier and ECE.
- `alignment-promotion.ts`: conservative source-family collapse and independent
  held-out reuse admission requiring complete recovery, semantic-cycle fidelity,
  exact-anchor preservation and zero unsupported additions.
- `reversible-construction.ts`: the first executable
  \((H_r,\partial H_r)\Longleftrightarrow(P_r,\partial P_r)\) schema, exact
  interpretation/realization cycle, durable language-memory projection and
  creation-snapshot identity.
- `normalization-contract.ts`, `canonical-identity.ts`, `canonical-temporal.ts`:
  vendored Unicode-17 simple folding, ICU/Unicode runtime pins, explicit
  identity-field allowlists and independent source/observation/event/validity
  coordinates.
- `graph-temporal.ts`: explicit known, unknown and atemporal graph scopes. Unknown
  validity is uncertainty and never an unbounded historical interval.
- `surface-lattice.ts`: exact-occurrence quotient over detector proposals, separate
  occurrence/form/surface-form-class identity, lossless base-partition conservation, and
  independent-anchor/packed-marginal boundary supervision.
- `boundary-estimator.ts`, `segmentation-forest.ts`: mergeable anchored/latent
  statistics, source-disjoint held-out Platt calibration, globally normalized traced
  path energy, complete-DAG forward/backward marginals, non-renormalized top-k mass,
  bounded resumable materialization, and learned-only final coefficients.
- `segmentation-population.ts`: source-disjoint MDL population selection, exact
  prior-times-document-likelihood posteriors for stored and unseen documents,
  source-family-disjoint fit/selection/guard/evaluation partitions, content-derived
  population identities, and per-child merge guards without language-specific routing.
- `join-program.ts`: derivation- and task-population-conditioned opaque exact-source
  join distributions; source-family-disjoint fit, threshold selection and final
  evaluation; exact coordinate provenance; factored backoff; explicit unknown
  population mass; and typed uncertainty outcomes with no global join or
  silent-concatenation fallback.
- `structured-semantic-candidate.ts`, `typed-ingest.ts`: four explicit semantic
  candidate channels, mandatory provenance decomposition, opaque induced relation
  identity, proposal isolation, and exact-evidence-gated source-declared zero-arity
  state/event hyperedges.
- `relation-promotion.ts`: source-family-disjoint promotion evaluation with
  channel-local background distributions so structured extraction cannot score weak
  induction.
- `canonical-replay.ts`: byte-stable snapshot manifests binding corpus, code,
  configuration, seed and sorted derived component identities, with nested unordered
  field canonicalization, duplicate-ID rejection and graph-reference integrity.
- `packages/kernel/src/proof-carrying-answer.ts`, `semantic-proof-engine.ts`, and
  `semantic-proof-system.ts`: proof, evidence, truth-state, and contradiction handling.
- `packages/kernel/src/turn-requirements.ts`: a 16-dimensional requirement field
  derived from learned frame, pattern, phrase-unit, dialogue-move, and construct
  activations plus optional structured requirements. It activates 17 stable cognitive
  operators without an English command-verb router. The bundled coefficient models
  are explicitly `uncalibrated_bootstrap`.
- `packages/kernel/src/request-authority.ts`: the shared source-neutral projection from
  the requirement field to six request authorities, plus shared operator-support
  contributions. Scores are bounded routing energies rather than probabilities, and
  explicit structured authority remains a traced override.
- `packages/kernel/src/cognitive-planner.ts`: bounded proposals containing typed
  claims, relations, steps, artifacts, evidence/prior identities, requirement
  coverage, operator support, and per-claim bases. Reasoning, invention, and MMR
  weights are provisional bootstrap estimators.
- `packages/kernel/src/candidate.ts` and `judge.ts`: proposal-aware candidate
  construction and requirement-conditioned selection. Unsupported attribution, test
  weakening, telemetry-as-answer, unreceipted action results, and failed executable
  validation are hard failures rather than score tradeoffs.
- `packages/kernel/src/mouth.ts` and `surface-realizer.ts`: realization of selected
  semantic slots and relations through learned language memory and permitted source-bound
  surfaces. The Mouth does not get
  authority to select facts, manufacture citations, or expose semantic/control IDs as
  user-facing text.
- `packages/kernel/src/answer-revision.ts`: a typed critic/revision boundary capped at
  two rounds. A revision must improve measured quality by at least `0.025` and retain
  citation, action-receipt, test-preservation, and non-telemetry invariants.

`kernel.turn` records the requirement field, operator activations, proposals, selected
candidate/Mouth state, and revision result as separate inspectable runtime artifacts.
Ordinary answer prose does not need to expose that telemetry.

When a request-matched semantic frame selects evidence whose source title differs from
the request anchor, the selected evidence IDs travel with the runtime graph slice into
source-anchor admissibility. This is an explicit routed binding, not a general body-text
match: an unbound content mention cannot bypass source anchoring.

`createSourceOnlyScceRuntime` exposes the in-memory source-only runtime for bounded
fixture and diagnostic use; `createScceRuntime` currently aliases that factory. Its turn
path derives requirements, projects authority through the shared function, activates
operators, selects an authority-compatible candidate, and then calls Mouth. It is
marked simulation/non-hydrated and does not replace the PostgreSQL-backed production
runtime.

## Low-Support Transition

An under-supported candidate does not terminate the turn with a canned refusal. The kernel may make one bounded transition through eligible local learning or configured search/fetch, canonical typed ingestion, graph/frontier update, and replanning. Fetched material must retain source identity, evidence spans, language, and temporal metadata before it can contribute factual support. The transition is bounded to one recovery pass so missing support cannot create an unbounded retrieval loop.

Replanning preserves authority boundaries. Factual correction and negation require supporting contradiction or temporal proof. Reasoned and prior-bound answers remain qualified. After the single acquisition attempt is exhausted, the current user policy also licenses a bounded creative continuation for an under-supported factual or reasoned turn. That continuation is admissible only through a `learned_continuation` or `learned_structural_composition` realization with nonempty `sourcePieceIds`, bounded repetition, novel non-request material, and passing non-echo, risk, and unsupported-fact gates. Structural composition binds exact request-owned code-point and UTF-8 byte spans to source-owned learned structure and records their source-activation IDs; request spans remain constraints rather than evidence. Its claims carry `invented` basis, its evidence set is empty, its provenance is `generated_not_evidence`, and it receives no factual certification.

The terminal creative policy is not a fabrication fallback. Empty connector, graph, and language state provides no honest material from which to synthesize useful knowledge; in that case the planner selects a non-assertive answer limited to source-derived content that actually exists, and the Mouth realizes it. If the Mouth cannot produce an admissible learned realization, an empty surface returns control to the kernel for terminal selection and is not emitted as the user's answer.

## SCCE2 Import And Brain Lifecycle

```text
packages/cli/src/index.ts
-> packages/adapters-node/src/scce2/*
-> packages/adapters-node/src/scce2/scce2-to-v3-importer.ts
-> PostgreSQL brain_import_lifecycle
```

The SCCE2 bridge inspects loose shard directories and `.brain` bundles, records
bounded hashes and checkpoints, distinguishes learned priors from direct evidence,
and writes through the v3 storage contract. Learned priors can affect activation and
language but cannot certify a factual answer.

PostgreSQL schema version 12 is current. Brain lifecycle states are `CREATED`,
`IMPORTING`, `VALIDATING`, `READY`, `ACTIVE`, `STOPPED`, `FAILED`, `QUARANTINED`, and
`INCOMPATIBLE`. Activation is transactional and READY-only. A partial unique index
enforces at most one ACTIVE lifecycle row, and the v12 migration deterministically
repairs older duplicate-ACTIVE state before installing that constraint.

Turn-local retrieval uses one shared compiled memory slice after the durable graph
retriever has opened an admissible neighborhood. Term and sparse-feature postings,
direct record maps, precomputed vectors, and bounded alpha-prior candidates prevent
the semantic and role retrieval passes from rebuilding and rescoring that entire
neighborhood independently. This is not yet the final nation-scale storage design:
the durable quotient router and memory-mapped detail shard compiler remain specified
in `BRAIN_COMPILER_AND_STORAGE.md`.

## Long-running turn transport

The interactive deadline governs first visible output, not completion. A streamed turn
receives a stable task ID immediately and continues independently of its original HTTP
subscriber. Accepted, phase-change, terminal, and cancellation frames are appended to
the event ledger under that task episode; heartbeat frames are ephemeral. Clients can
query task status, reconnect from a sequence number, or explicitly cancel. A socket
close only unsubscribes.

Terminal tasks remain replayable after a process restart. A nonterminal durable receipt
is reported as interrupted after restart because SCCE does not yet checkpoint and resume
the complete in-flight cognitive stack. This boundary is explicit: reconnectable
transport is implemented; crash-resumable execution is not.

## Workspace Mutation Boundary

The kernel defines exact-byte workspace revision snapshots and content-addressed
`create`, `replace`, and `delete` plans in `workspace-plan-generator.ts` and
`patch-transaction.ts`. `POST /api/workspace/patch/plan` verifies the latest durable
workspace identity and every ingested file against current filesystem bytes, then
returns a reviewable plan with authorization false and execution not run. The endpoint
does not accept a root, command, approval, authorization, or execution state.

`POST /api/workspace/patch/plan/request` is strict and non-mutating. Its tested coding
families remove a source-proven unused binding from a type-only import or apply one
official TypeScript LanguageService code fix rooted at one existing requested file. The
adapter builds the LanguageService from exact durable snapshot bytes and the
TypeScript standard library; it does not read unrecorded workspace or dependency
source. The source-observed direct `tsc` invocation resolves either its explicit
`-p`/`--project` target or an exact upward `tsconfig.json`; the config and content hash
must be present in the durable snapshot, and the requested file must belong to its
parsed file set. Every compiler request must include a structured positive integer
diagnostic code (`diagnosticCodes` over HTTP or `--diagnostic-code=<integer>` in the
CLI) that resolves to one candidate; request prose never selects the action. The
resulting plan remains
unauthorized and unexecuted and requires source-observed compiler/typecheck/test
validation before application.

The selected compiler action is preserved as an atomic closure of up to 32 affected
files and 128 exact text changes. It may replace exact snapshot files or create bounded
TypeScript/JavaScript sources in existing snapshot directories. Command-bearing
actions, out-of-workspace targets, stale or absent replacement bases, invalid new-file
targets, implicit or ambiguous selection, and overlapping changes are rejected. This
path does not synthesize arbitrary features. Other internal ProgramGraph conversion
still requires exact-base repair lineage, current live absence observations where
relevant, and linked validation evidence; caller-supplied metadata cannot establish
semantic correctness or executed tests. `regressionProtection` remains `0` until
execution evidence exists.

`POST /api/workspace/patch` is the separate mutation boundary. The Node adapter
performs containment, symlink, compare-and-swap, staging, verification,
atomic-per-file mutation, and verified reverse-order rollback checks. Application
requires mutation policy plus the existing capability approval; a plan alone grants
nothing. The server and VS Code package expose the reviewed application flow.

The default `trusted-host-pnpm-validate.v1` policy is deliberately named: it runs
repository validation with the server process's host authority. Staging is not an OS
sandbox and is unsuitable for code that is untrusted with that authority. The optional
server-selected Docker provider binds a digest-pinned image and resource policy to
approval and runs source validation without networking. A local live smoke test passed
that path; the Docker daemon, operator, image supply chain, and host kernel remain
trusted, and the result is neither attestation nor independent review. Multi-file
visibility is not globally atomic; the receipt truthfully reports
`atomic-per-file-with-verified-transaction-rollback`. See
`docs/PATCH_TRANSACTION_CONTRACT.md`.

## Product Surfaces

- `packages/cli`: local CLI.
- `packages/server`: HTTP API and workbench server.
- `packages/ui`: workbench model and surface code.
- `packages/vscode`: local-loopback VS Code extension for readiness, ingest, questions,
  project/status workflows, reviewed patch application, and receipt verification.
- `tools/scce-dev-mcp`: bounded local repository and trace inspection tools.

The packaged VSIX was installed in an isolated VS Code 1.96.4 profile. The host
activated it, observed its registered commands, and reached `GET /api/ready`. Visual
layout, restart recovery, and a live patch round trip remain unverified; the smoke test
is not an independent end-to-end review.

## Large-Input And Deployment Boundaries

Workbook files (`.xlsx`, `.xlsm`, and legacy `.xls`) enter the same bounded file-ingest
lane through a child process using the vendored SheetJS CE archive. The adapter emits
sheet, cell, formula, merge, and A1 provenance as typed observations. It treats cached
formula results as unverified stored values and does not recalculate formulas or
execute macros, external links, or embedded objects.

SCCE2 n-gram and compatible graph material stream within byte/count/heap budgets, with
checkpoint, stop, resume, and lifecycle state. Representative large-corpus behavior,
clean-machine reproduction, and production isolation remain deployment-specific work.
