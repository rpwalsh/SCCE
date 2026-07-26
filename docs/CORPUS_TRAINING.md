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

- PostgreSQL schema v22 enforces at most one ACTIVE lifecycle row, retains the lifecycle repair, and adds durable segmentation-population models.
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
the same relation/signature/source identity collapse before fitting. Source IDs are
split into fit and holdout sets. The null code uses the fit corpus's smoothed
participant/qualifier-signature distribution; the promoted code uses a
relation-conditioned distribution and pays an explicit two-part model cost.
Positive held-out codelength gain and improved held-out relation recovery are both
required. A shuffled relation assignment, a duplicate-only one-source corpus and a
deterministic random-repetition corpus must all fail the same promotion boundary.
The frozen model ID and gain are written back to candidate incidence metadata.

Typed ingest now constructs structured semantic candidates before weak prose inference.
The versioned candidate contract covers links, redirects, headings, table cells,
numbers, dates, citations, repeated references, formulas, code/repository graphs,
logs, and interaction outcomes. Every candidate retains source/version/evidence
identity, qualifiers, an opaque relation seed, and typed participant ports. It enters
the graph marked unpromoted; corpus structure proposes semantics but does not certify
or promote them.
