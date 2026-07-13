# Corpus Training

SCCE training is corpus compilation. Source material becomes source versions, evidence spans, language profiles, n-gram observations and models, language units, language patterns, semantic frames, and traceable events in PostgreSQL.

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

## Eval

Run the regular blind eval:

```powershell
pnpm yopp:eval
```

Run corpus ablation output:

```powershell
pnpm yopp:eval --corpus-ablation
```

The legacy corpus-ablation report evaluates no-corpus, Wikipedia-only, Wikipedia plus Gutenberg, Wikipedia plus OSS, combined-corpus, and corrections-enabled conditions using local heuristic metrics. The sealed review kit separately defines production-boundary conditions. These local reports are diagnostic rather than representative quality evidence.

## Activation and evidence limits

- PostgreSQL schema v12 enforces at most one ACTIVE lifecycle row and repairs legacy duplicate-active state during migration.
- Generic lifecycle CAS cannot enter or leave ACTIVE; activation must use the locked READY-only path.
- Corpus promotion and language-memory eligibility do not certify facts. Exact evidence spans and graph/proof admissibility remain required for source-backed claims.

## Corpus compilation boundary

Corpus material is compiled into PostgreSQL-backed evidence and language memory. Factual answers still require admissible evidence and proof paths; language priors only shape realization. The production path has no external inference provider or prompt-construction fallback.
