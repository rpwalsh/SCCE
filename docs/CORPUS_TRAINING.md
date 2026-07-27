# Corpus Training

SCCE training is corpus compilation. Source material first becomes an exact `scce.surface_lattice.v3`, then source versions, evidence spans, language profiles, n-gram observations and models, language units, language patterns, semantic frames, and traceable events in PostgreSQL. The base lattice is not truncated by higher-hypothesis caps: every admitted UTF-8 byte remains recoverable through byte, UTF-16, code-point, and grapheme coordinates.

The current first-class language-memory source systems are:

- `scce2`: imported SCCE2 priors.
- `wikipedia`: encyclopedic source/evidence and language cadence from Wikimedia dumps.
- `gutenberg`: public-domain long-form prose from local `.txt` files.
- `oss_docs`: README/docs/explanatory files from local repositories.
- `oss_code`: code-adjacent comments and identifier surfaces from local repositories.
- `workspace`: local workspace corpora when persisted.
- `corrections`: learned interaction/correction memory when persisted.

These IDs are source-system IDs, not a semantic ontology. Corpus labels do not decide truth. The kernel/planner still selects facts from evidence and graph paths; the Mouth uses language memory only to realize an already selected plan.

## Data Layout

Downloaded or cloned corpora should live under gitignored paths:

```powershell
corpus/gutenberg
corpus/oss
data/wiki
```

Do not commit downloaded books, dumps, generated shards, cloned repositories, or other large corpus files.

## Optional Starter Downloads

Project Gutenberg starter set:

```powershell
powershell -ExecutionPolicy Bypass -File tools/download-gutenberg-starter.ps1
```

OSS starter repos:

```powershell
powershell -ExecutionPolicy Bypass -File tools/clone-oss-starter.ps1
```

Both scripts are optional. Tests use local fixtures and do not need network access.

## Training Commands

Build first so the CLI exists:

```powershell
pnpm build
```

Train Gutenberg:

```powershell
pnpm scce --config scce.corpus-dev.config.json corpus train gutenberg corpus/gutenberg
```

Train OSS docs/code:

```powershell
pnpm scce --config scce.corpus-dev.config.json corpus train oss corpus/oss
```

Useful bounds:

```powershell
pnpm scce --config scce.corpus-dev.config.json corpus train gutenberg corpus/gutenberg --max-files=16 --max-file-bytes=1000000
pnpm scce --config scce.corpus-dev.config.json corpus train oss corpus/oss --max-files=500 --docs-only
```

Wikipedia ingestion uses the same CLI surface, but activation now follows the durable lifecycle contract: importing, validating, READY, then transactional ACTIVE. Stopped or incomplete runs remain inactive and resumable.

```powershell
pnpm scce --config scce.corpus-dev.config.json ingest wiki data/wiki/enwiki-latest-pages-articles-multistream.xml.bz2 --index=data/wiki/enwiki-latest-pages-articles-multistream-index.txt.bz2
```

## Mouth Hydration

The kernel no longer hydrates only `scce2` and `wikipedia`. It builds a bounded hydration plan from the corpus registry and asks the language-memory store for each enabled language-eligible source system. Per-corpus limits keep laptop memory bounded, and the runtime language-memory compiler still caps usable models internally.

## Activation and evidence limits

- PostgreSQL schema v23 enforces at most one ACTIVE lifecycle row, retains the lifecycle repair, stores durable segmentation-population models, and persists arbitrary-arity hyperedge ports, qualifiers, modality and evidence.
- Generic lifecycle CAS cannot enter or leave ACTIVE; activation must use the locked READY-only path.
- Corpus promotion and language-memory eligibility do not certify facts. Exact evidence spans and graph/proof admissibility remain required for source-backed claims.

## Corpus compilation boundary

Corpus material is compiled into PostgreSQL-backed evidence and language memory. The n-gram compiler and primary language-induction engine consume the canonical surface lattice and record its identity in compilation audit data. Remaining production language consumers are being migrated; see `IMPLEMENTATION_STATUS.md`.

The primary induction engine performs a two-pass surface compile:

1. build exact neutral lattices and collect weighted endpoint/interior agreement;
2. reduce those observations into quantized integer sufficient statistics;
3. reserve a deterministic document-disjoint holdout and compare non-collapsed population counts using held-out data nats plus model/assignment nats;
4. refit the selected populations on admitted documents and rebuild each lattice with its posterior-weighted estimator mixture;
5. calculate the complete bounded segmentation-DAG partition and retain deterministic k-best exact covers.
6. compile one source-exact join program per selected population from every retained path, weighted by its segmentation posterior;
7. publish the population mixture with exact-context, Unicode-category-shape, and learned population-level join distributions.
8. compile mergeable relation-hypothesis statistics by independent source and retain normalized candidate posteriors for frame induction.

The full sufficient statistics and baseline estimator remain in the archived induced-language model for comparison. The selected mixture is also written to `segmentation_population_models` with profile/source ownership, component statistics, estimators, assignments, candidate objectives, and fit/holdout identities. Profile-overlap lookup loads those records into the cached surface-language bundle. Join programs are currently carried in the induced model's syntax projection and recovered by language-memory hydration; a dedicated indexed store is still required if broad-brain join state exceeds that projection boundary. Direct use by every interpretation lattice consumer, forest persistence, and affected-only overlay promotion still remain. ICU lexical segmentation still proposes some higher candidates and must be replaced by source-induced candidates before universal segmentation is complete.

Join observations are not word-separator guesses. For adjacent realized units \(u,v\) on retained path \(z\), the compiler records the exact source substring:

\[
j=x[\operatorname{end}(u):\operatorname{start}(v)]
\]

and contributes the path posterior \(P(z\mid x,c)\) to that observation. Thus null joins, ordinary or non-breaking spaces, line breaks, punctuation, and longer connector surfaces share one representation. At runtime an absent program is unresolved and inserts no material; the runtime does not substitute an English space or terminal period.

New n-gram state is emitted as `scce.kneser_ney.v2` with compiled successor arrays, overflow counts, base continuations, and precomputed backoff weights. Runtime hydration rejects model records without these compiled fields; turn-time inference does not rebuild an obsolete model by scanning all grams.

The same canonical path applies when a low-support turn acquires new material: source identity and typed observations must be admitted before replanning. Factual answers still require admissible evidence and graph paths; language priors shape realization but do not certify claims. The production path has no external inference provider or prompt-construction fallback.

Relation-hypothesis state is candidate memory, not promoted semantics. The compiler records occurrence, source independence, left/right substitution, context-pair diversity, Unicode-shape support, and evidence IDs. Frame observations are distributed by posterior mass.

Typed ingestion separately emits structured semantic candidates. Promotion is now
compiled per multi-source ingest batch or bounded Wikipedia shard. Occurrences with
the same relation/signature/source-dependency-family identity collapse before
fitting. Dependency families are split into fit and holdout sets. The null code uses
the fit corpus's smoothed
participant/qualifier-signature distribution; the promoted code uses a
relation-conditioned distribution and pays an explicit two-part model cost.
Positive held-out codelength gain and improved held-out relation recovery are both
required. A shuffled relation assignment, a duplicate-only one-source corpus and a
deterministic random-repetition corpus must all fail the same promotion boundary.
The frozen model ID and gain are written to admitted graph metadata. Unpromoted
candidates remain outside the ordinary graph. Promoted candidates materialize as
`scce.hyperedge.v2`. A relation may
have zero or more ports; an omitted participant remains an explicit port with a null
node reference. Qualifiers, temporal validity, modality and evidence have dedicated
fields. The `memberNodeIds` array is derived only from observed ports for bounded
retrieval and does not define role semantics.

Opaque roles are compiled only for promoted relation seeds. Each participant
occurrence contributes source-derived surface shape, value kind, co-participant
neighborhood, substitution mass, transformation family, qualifier/discourse context
and realization state. Source IDs are split before fitting. Deterministic k-medoids
proposes finite populations; a smoothed Bernoulli feature code plus explicit BIC model
code selects the population count on holdout data. The content-addressed `roleId`
comes from the learned feature distribution, never participant-array position or a
language grammar label. Unique `portId` still identifies each occurrence.

Semantic role and surface realization are compiled into different probability
fields. The semantic field estimates \(P(p\mid r,G)\) from the promoted relation and
position-free graph context. The realization field estimates
\(P(\operatorname{position}\mid p,r,c,d)\) from role, relation and discourse context.
It has explicit `unrealized` probability mass and a separately smoothed repetition
probability. Reordering participant occurrences can therefore alter the realization
model without changing the opaque role population or semantic-role distribution.
The content-addressed artifact is `scce.role_surface_order_model.v1`, and its ID is
recorded by ordinary ingest, Wikipedia shard compilation, engineering-corpus folding
and the source-only runtime.

Every canonical hyperedge has a deterministic lossless derived representation,
`scce.typed_incidence_graph.v1`. The derived graph contains one relation node per
hyperedge and one typed incidence per participant occurrence. Relation nodes retain
the exact hyperedge ID, relation ID, qualifiers, modality, temporal scope, evidence
and provenance. Omitted ports remain null incidences and zero-arity hyperedges remain
relation nodes; neither case creates a fabricated participant. Observed incidences are
projected as reversible alpha/PPF transitions. No participant clique or binary triple
is materialized.

Graph/surface alignment candidate generation now consumes that typed incidence
representation. `scce.sparse_alignment_target_index.v1` compiles bounded postings
for exact evidence, observable participant anchors and relation membership.
`scce.sparse_alignment_candidate_support.v1` materializes at most \(K_\Pi\)
candidates per surface unit from anchor, shared-evidence, incidence-structure and
surface-context support. Ordinary ingestion emits the compiled support identities;
Wikipedia shard compilation emits the same contract, and explicit training returns
the bounded artifacts in its batch result. Candidate
scores are proposal energies only and do not substitute for transport or calibrated
confidence.

Each compiled support is now consumed by
`scce.sparse_fused_unbalanced_transport.v1`. Sparse generalized Sinkhorn scaling
handles separate surface and graph unbalanced marginals; exact-anchor rows reserve
anchor mass; bounded local correction compares adjacent surface rows with typed
relation/incidence neighborhoods. Every plan records feature, structural, anchor,
generalized-KL and entropy terms, marginal and scaling residuals, iteration/work
budgets and estimated working bytes. The current objective is explicitly
`bootstrap` and uncalibrated, and the local non-convex solver never claims a global
optimum.

Transport provenance is then compiled by
`scce.transport_evidence_allocation.v1`. For each cell it normalizes exactly one
\(q(\epsilon\mid u,v)\) over shared, surface-only and graph-only exact evidence and
partitions the cell mass. Overlapping evidence records never each receive a full
copy of \(\Pi_{uv}\). Cell and total conservation residuals are recorded; positive
mass without evidence remains unresolved and cannot be treated as an admitted
alignment.

Candidate-free surface rows and typed-incidence targets are retained by item 19.
`scce.typed_null_alignment_cost_model.v1` estimates universal null/implicit costs
from exact-anchor, absent-support and omitted-port observations. Those costs
parameterize the sparse unbalanced updates. Every plan records typed surface-null,
graph-implicit and overflow mass; the learned source-exact estimates are not
reported as calibrated confidence.

Surface lattices also retain their normalized segmentation-population posterior.
`scce.population_relative_order_model.v2` learns signed reusable typed-port-pair
displacements from bounded exact-anchor neighborhoods. Explicit training fits one shared model
over the batch; ordinary and Wikipedia ingestion use the same compiler per active
support. The transport objective consumes the posterior-conditioned robust order
term without language or traditional role names.

Explicit training then performs a two-pass cross-document correction. First-pass
plans are projected into the shared typed graph-port index. Documents are collapsed
by declared dependency family before pairwise comparison, and
`scce.cross_document_alignment_consistency.v1` supplies per-port inconsistency
costs to the final sparse plans. Surface-form classes remain attached as provenance,
allowing paraphrases to reinforce the same graph region without identical text.

Every final plan then enters the item-22 retained-alternative compiler. The
compiler keeps the base plan and a bounded set of deterministic non-anchor branch
resolves, attaches conserved evidence-allocation identities and stores immutable
predecessor lineage. Its Gibbs weights normalize only across the retained set;
they are not represented as global posterior probability or calibrated confidence.
Ordinary ingestion, Wikipedia ingestion and explicit training persist the same
versioned artifact. Runtime ingestion hydrates earlier sets by stable source-family
and canonical graph-port series identity before writing the next revision.

Before either cross-document solve, item 23 routes each candidate support through
opaque structural quotient communities spanning equivalent relation/port states
while preserving every exact anchor. Typed-null and
ordering models, both transport passes, evidence allocation and alternative
extraction consume the routed support. The resulting
`scce.coarse_to_fine_alignment.v1` artifact binds routing, sparse Sinkhorn,
conditional-gradient correction and retained alternatives into one persisted work
trace.

Item 24 automatically evaluates retained plans against dependency-independent
source families. `scce.alignment_heldout_evaluation.v1` measures candidate recall
before transport, final graph recovery, exact-anchor preservation and unsupported
additions, while content-addressably binding the plan, evidence allocation, target
index and source-family artifacts. Those rows plus any separately admitted labels
feed source-family-disjoint fit and holdout partitions. The calibrator reports log
loss, Brier and ECE only when both partitions and outcomes are sufficient;
otherwise it remains explicitly `insufficient_data`.

Item 25 keeps promotion separate from both selection and calibration.
`scce.alignment_heldout_promotion.v1` requires an induction family and at least two
dependency-independent held-out families. Copies within one family collapse to a
single conservative observation. The non-weakenable gate requires complete
graph-target recovery, worst-family cycle recall of at least `0.98`, preservation
of every exact anchor, and zero unsupported additions. Ordinary, Wikipedia and
explicit training all generate observations from their actual source-family
cross-fit. A batch lacking two independent held-out families remains unpromoted.

Item 26 compiles every constructible promoted plan into
`scce.reversible_construction.v1`. The artifact binds typed relation/incidence
ports to source-exact surface occurrences, discourse conditions, population
posterior, conserved evidence allocation, calibration metadata and a creation
snapshot. Interpretation and realization execute from the same record, and an
exact graph→surface→graph cycle must recover both sides. Compiled artifacts are
stored as language-memory patterns, restored during hydration and exposed to
Mouth only when active participant nodes and promoted direct evidence match.
Item 27 then groups those promoted exact artifacts only across independent source
families with the same reusable relation/port/role/value/realization structure.
`scce.paired_anti_unified_construction.v1` retains common literals and replaces a
slot with a variable only when its surface and bound graph target both vary.
Surface-only variation and adjacent variables without an observed boundary are
rejected. The bidirectional artifact is persisted once per observed profile and
hydrated as one deduplicated construction. Mouth supplies unseen bindings only
from unique typed semantic-role matches and uses the current fact's promoted
evidence.

Item 28 prevents structural co-variation from becoming runtime grammar by
inspection alone. For each proposed variable it forms pairwise same/different
surface and graph deltas across dependency families, measures conditional mutual
information, and evaluates predictive gain while removing every training pair
touching the held-out families. Deterministic graph-label permutations define the
null distribution. Only a content-addressed passing admission can be projected to
language memory; raw paired anti-unifications remain non-runtime hypotheses.

Item 29 learns optional and null realization without treating missing meaning as
implicit meaning. Exact reversible constructions retain supported omitted graph
ports with no surface slots. The shared training compiler generates
content-addressed observations for absent, realized and unrealized states,
collapses copies by dependency family, excludes conflicting family cells and
cross-fits \(P(z_c=1\mid G,D,C)\). Ordinary, Wikipedia and explicit training
persist the same model wrapper. Hydration merges observation shards and Mouth
permits an already-typed omitted graph variable only when its profile, relation,
component, construction context and active discourse states meet the learned
non-weakenable omission gate.

Typed ingest now constructs structured semantic candidates before weak prose inference.
The versioned candidate contract covers links, redirects, headings, table cells,
numbers, dates, citations, repeated references, formulas, code/repository graphs,
logs, and interaction outcomes. Every candidate retains source/version/evidence
identity, qualifiers, an opaque relation seed, and typed participant ports. It remains
in a candidate channel until promotion; corpus structure proposes semantics but does
not certify or insert it into the ordinary graph.
