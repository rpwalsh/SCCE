# SCCE storage amplification diagnosis

> Historical measurement note. The language JOIN subsystem measured below was
> retired on 10 November 2026. Its compiler, storage codec and runtime consumers
> no longer exist. The byte figures remain useful evidence of the former writer's
> amplification; they are not current architecture or migration guidance.

Measured 2026-11-09. Diagnosis and proposed repair; no production migration applied.

SCCE has no external users yet. Older development encodings impose no permanent compatibility requirement. The target is one canonical representation and read/write path. Rebuild development data from pinned inputs after verifying decoded information and answer equivalence; temporary comparison readers are verification tools.

SCCE is persisting large, richly annotated language structures and repeating information across records. In the available checkpoint, most pattern-table space belongs to live JSON payload. The first repair should normalize those payloads and their shared provenance. Index maintenance cannot remove that live content.

This establishes a real representation problem. It does **not** establish that the entire reported 448 MiB Windows candidate has the same breakdown, or that the prototype below eliminates its roughly 400-fold expansion.

## What was actually inspected

- Available checkpoint: Dolly/dialogue, Alice, small documentation fixtures, and 36 acquired Wikipedia articles. Only two Wikipedia articles have committed learned structures.
- Local audited source checkout: `1ac82eac41b5f33b7f58fb1dc485c7a9fa83e2e7`. Stored data includes legacy records; this is not a claim that this commit originally produced every row.
- Current `dev` source reviewed: `b5c6bc09089703f1c7c7315e9f340b695695ad22`.
- Storage backend measured: PostgreSQL 18.6 through PGlite 0.5.15. Native PostgreSQL transport and the Windows installation were not tested here.
- The separate Windows report of 29 articles, approximately 1 MiB of input, 448 MiB allocated, 221 MiB of patterns and 101 MiB of graph nodes was supplied in the conversation. That database was not available for direct inspection.

Application tables were read in repeatable-read, read-only transactions. The normalization experiment wrote only disposable temporary tables, then rolled back. Application rows modified: **zero**. No training, schema migration, VACUUM, or index deletion was performed.

## Findings

### 1. Most pattern-table space is live payload

| Available checkpoint measurement | Bytes | Meaning |
| --- | ---: | --- |
| `language_patterns` total allocation | 2,515,099,648 | Heap, TOAST and indexes |
| Live stored `pattern_json` values | 2,079,088,165 | About 82.7% of total allocation |
| Pattern indexes | 86,499,328 | About 3.4% of total allocation |
| Rendered pattern JSON | 8,569,453,915 | Logical JSON text length; not disk usage |
| Pattern rows | 249,338 | All checkpoint corpora combined |

The database is already compressing the large JSON values. Rendered JSON lengths must not be added to relation sizes or presented as recoverable physical space. The table/total relation measurements already include TOAST; adding the reported TOAST allocation again double-counts it.

No trustworthy dead-space measurement was obtained. PGlite's tuple statistics were zero despite populated tables, so they were not used to claim either zero bloat or extensive bloat. Even perfect removal of all non-payload allocation would leave the approximately 2.08 GB of stored pattern JSON.

### 2. The committed Wikipedia patterns concentrate in three large families

This subset contains 1,137 patterns from the two learned articles. Its stored `pattern_json` total is 12,152,561 bytes.

| Pattern family | Rows | Stored JSON bytes | Rendered JSON bytes |
| --- | ---: | ---: | ---: |
| Creative events | 14 | 4,499,416 | 17,114,274 |
| Induced syntax | 5 | 2,732,121 | 26,133,694 |
| Induced semantics | 5 | 2,652,126 | 8,935,936 |
| Ordinary source-example constructions | 1,099 | 2,092,377 | 4,871,190 |
| All remaining families | 14 | 176,521 | 450,031 |

The first three families account for **81.3%** of this subset's stored JSON. They are better initial targets than the n-gram structures.

Field-size samples explain the shape of the payloads:

- One Wikipedia creative-event pattern renders to 1,224,825 bytes. Its `bundle.events` member alone renders to 1,221,173 bytes.
- A sampled syntax record renders to 5,838,718 bytes; `joinProgram` accounts for 5,690,477 bytes, about 97.5%.
- A sampled semantic record renders to 1,884,893 bytes. Its semantic frames, graph-bound constructions and relation-hypothesis statistics account for nearly all of it.

These samples identify storage targets; they do not prove that all the retained semantic or syntax statistics are redundant. Removing observations or changing induction thresholds would change behavior and is not a lossless storage repair.

### 3. A small lossless event-normalization experiment saves 21.7%

The experiment separated repeated occurrence-witness fields and lexical forms from individual event records. It retained every event ID and complete argument frame, wrote the proposed representation to temporary tables, read it back, reconstructed the original objects, and compared SCCE canonical SHA-256 digests.

| Wikipedia event experiment | Result |
| --- | ---: |
| Bundles / events | 14 / 10,106 |
| Unique shared witnesses / lexemes | 36 / 2,630 |
| Original temporary-table allocation | 4,751,360 bytes |
| Proposed tables combined allocation | 3,719,168 bytes |
| Measured allocation reduction | 21.7% |
| Decoded canonical SHA-256 mismatches | **0** |

Both allocation measurements include their temporary primary-key indexes and TOAST. They are not measurements of production migration savings, full production indexes, read latency, or the whole database. This proves a useful lossless improvement, **not a solution to the entire 400-fold ratio**.

### 4. Legacy request patterns have a separate, much larger duplication bug

In this restored checkpoint, 2,048 request patterns each contain the same `trainingSourceVersionIds` and `trainingSourceDigests` arrays. Together those repeated members render to 109,531,136 bytes; their single shared values render to 53,482 bytes.

A temporary-table experiment storing the shared arrays once reduced allocation from 119,422,976 to 1,859,584 bytes, with **zero decoded JSONB mismatches**.

**This is legacy data.** Both the available source writer and current `dev` already avoid these fields. Current source-owned request records use a different representation. This finding calls for a verified legacy migration; it must not be presented as an ongoing current-writer defect or as the explanation of the Windows Wikipedia candidate.

### 5. Shared metadata and graph projections add further overhead

The 74,800 dialogue units alone contain 144,179,188 stored metadata bytes. A 968-byte `sourceMetadata` object is copied into each of them, totaling 72,406,400 rendered bytes. Current `stampUnit`, `stampPattern`, `stampModel` and `stampFrame` spread shared training metadata into each record. This is a clear normalization opportunity for dialogue training. The checkpoint's Wikipedia units do not carry that `sourceMetadata` member, so that specific finding should not be used to explain the Windows Wikipedia ratio.

The available `graph_nodes` relation allocates 38,223,872 bytes, including 14,336,000 index bytes. Some observation representations repeat features and evidence IDs that also occupy dedicated columns. Large proposition representations contain substantial role and constraint objects. Canonical payloads with referenced projections are a plausible repair, but exact equivalence and query-plan effects still need measurement on the Windows candidate. Indexes are materially more significant for this checkpoint's graph than for its pattern table.

## Current code already handles some earlier problems

Do not reintroduce the retired subsystem or its codecs:

- The former `join-program-storage.ts` and durable adapter are deleted. Full-DAG
  segmentation, factor-unit identities and adjacency observations now persist as
  evidence-owned segmentation witnesses; realization uses typed construction
  algebra.
- Historical packed-mixture measurements below describe the removed format only.
  They must not justify a compatibility reader, fallback writer or parallel
  realization path.
- Ordinary source-example construction records already have a compact storage representation.
- Current request writers avoid the legacy repeated source lists.
- Graph upserts already guard against unchanged writes, and shared observation-store nodes already avoid accumulating every evidence ID.

The proposed repair uses ordinary PostgreSQL normalization and references. It does not require pgvector, another retrieval layer, an LLM, or an invented general-purpose compression algorithm.

## Proposed repair

1. **Measure the exact Windows cohort.** Run the accompanying read-only audit there. Rebuild the identical 29-article input in an isolated fresh schema and record source digests, consumed text bytes, baseline relation sizes, and per-batch growth. Compare marginal learned storage against the actual consumed text, keeping acquired-but-unlearned sources and unrelated fixtures out of the denominator. Separate live values, heap/TOAST allocation and indexes before attributing the full ratio.
2. **Normalize the largest active structures.** Store reusable event templates, lexical forms and occurrence witnesses once; keep occurrence IDs, coordinates and bindings in compact records. For semantic and syntax records, first measure exact repeated substructures across windows and projections, then store proven shared immutable structures once. Readers reconstruct the existing logical records. Unqualified single-source construction hypotheses stay outside active language memory; raw source/evidence plus a bounded deterministic receipt own recomputation.
3. **Hoist shared compilation metadata.** Use one immutable metadata record keyed by the existing source-compilation identity. Keep record-specific fields local. References must include the necessary source, compiler and information-label scope; do not accidentally merge different access scopes. Existing filters that match fields inside `pattern_json` need equivalent indexed joins or retained query fields before any writer changes.
4. **Normalize graph projections where equality is proved.** Reference canonical observations, roles and constraints instead of persisting independent rich copies. Preserve logical node/edge identities, evidence links, features, confidence and information labels. Retain query-critical indexes; use measured plans before changing them.
5. **Migrate legacy records separately.** Preserve or normalize the old request witnesses with exact reconstruction. Do not simply delete them because the new writer no longer emits them. Immutable event histories remain append-only.
6. **Reclaim physical space after validation.** A side-by-side rebuild or deliberate maintenance step may be needed after the logical migration. A smaller live payload does not by itself prove that the existing relation files immediately shrink.

Verify the canonical representation in isolated builds before replacing development data. Preserve comparison snapshots until hash, answer, restart and citation checks pass. Any in-place rewrite must be resumable, reject concurrent changes, and emit per-record decoded digests and a byte ledger.

Acceptance requires exact decoded canonical hashes; unchanged record identities, source ownership, labels, evidence coordinates, learned counts and timestamps; deterministic replay; restart and citation checks; and the same stored regression questions producing the same supported answers. Compare storage growth and query latency on identical inputs. A smaller corpus, dropped evidence, lower induction limits or reduced functionality is not the proposed fix.

## Reproduce the audit

With the matching SCCE build already available:

```sh
node tools/audit-storage-amplification.mjs --config=scce.config.json --out=storage-audit.json --scope="Windows 29-article candidate"
```

The tool uses one connection and a read-only repeatable-read snapshot. It does not invoke migrations or modify application data. Its output contains counts, byte totals, record identifiers and field-size summaries, rather than source text or connection settings. Exact scans can take several minutes.

The exported query function was executed against the available PGlite checkpoint. It reproduced the original pattern allocation, stored pattern bytes, unit metadata bytes and all 63 pattern-family groups. Native PostgreSQL CLI transport remains unverified in this environment.

Evidence:

- [Initial checkpoint audit](storage-amplification/checkpoint-audit.json)
- [Field-level details](storage-amplification/checkpoint-details.json)
- [Temporary normalization experiment](storage-amplification/normalization-proof.json)
- [Portable auditor execution](storage-amplification/portable-audit-receipt.json)
- [Read-only auditor](../tools/audit-storage-amplification.mjs)

## Native Windows follow-up

The supplied auditor ran on PostgreSQL 16.11 against `scce_candidate_20261108`. Its scope was 29 trained Wikipedia articles, 33 acquired Wikipedia articles, and one transcript containing 16 original human-authored Dolly records. This is a current-state audit, not an identical fresh-build comparison. The [native receipt](storage-amplification/windows-native-current-summary.json) records the exact cohort and the complete report's SHA-256.

After the separately verified lossless event-page rewrite, live pattern JSON occupied 160,636,924 bytes, or 86.6% of the pattern relation's 185,548,800 allocated bytes. Pattern indexes occupied 3,670,016 bytes, or 2.0%. The native measurement confirms the need to normalize live payloads.

The rewrite preserved all 201 Wikipedia event-page decoded hashes, ownership columns and decoded-size ledgers. Its native temporary-table comparison measured 96,046,934 versus 46,466,963 stored payload bytes. Physical compaction reduced the Wikipedia candidate from its original 469,835,776 bytes to 419,921,920 bytes before the Dolly transcript was added. These are a limited representation improvement; the canonical template, lexical-form, witness and occurrence repair remains required.

PostgreSQL size semantics: [size functions](https://www.postgresql.org/docs/18/functions-admin.html#FUNCTIONS-ADMIN-DBSIZE). Space reclamation: [routine vacuuming](https://www.postgresql.org/docs/18/routine-vacuuming.html).

## Fresh R004 Wikipedia build

The fresh `scce_brain_20261109_r004` build completed language learning for 29 Wikipedia articles at revision `b6cbbfaf279a884858af8ec1afbe6cceedc8aff7`. Its 29 promoted source owners contain 1,056,804 unique source bytes; all 29 have language profiles and compiled n-gram structures. This is the first acquired article block, not a complete Wikipedia build. No dialogue source was committed: the next stage failed while joining the public segmentation dependency with a private dialogue label.

The [read-only native audit](storage-amplification/windows-r004-wiki-audit.json) measures 17,150 pattern rows containing 275,512,625 stored JSONB bytes, including 201,072,470 bytes in 16,386 ordinary source-example patterns. The 5,784 units contain 47,370,889 stored metadata bytes. Event normalization and JOIN packing are already active; raw n-gram observations remain absent. These measurements identify a current writer problem independently of the older development checkpoint.

The [field-size ledger](storage-amplification/windows-r004-inherited-metadata.json) identifies inherited metadata copied into thousands of artifacts:

| Field | Pattern logical JSON bytes | Unit logical JSON bytes | Distinct values in each family |
| --- | ---: | ---: | ---: |
| `links` | 349,209,834 | 87,848,320 | 29 |
| `originalStructure` | 46,588,606 | 10,864,024 | 29 |
| `structure` | 30,813,011 | 7,103,128 | 29 |
| `normalization` | 10,812,921 | 3,184,544 | 29 |

These are rendered field sizes, not physical space savings. In contrast, the 86 packed `joinProgram` values are all distinct and occupy 349,544,063 rendered bytes; their size alone does not establish duplication. The repair target is the shared inherited metadata boundary in `stampPattern`, `stampUnit`, and `stampFrame`, with exact reconstruction and unchanged source ownership, labels, query headers, and learned payloads. A fresh corrected build must measure physical growth after complete-record parity passes. No reduction is claimed by this baseline audit.

## Verified metadata normalization

The canonical source-compilation receipt now owns shared inherited metadata. Units, patterns, frames, and n-gram records reference exact matching metadata values while retaining query fields inline. Normal full reads reconstruct complete records; projected request reads retain their existing contract. Compilation identities now bind the shared metadata digest, and ordinary training publishes the holder before its dependent artifacts in the same transaction.

The [native comparison](storage-amplification/windows-r004-metadata-normalization.json) reconstructed all 29 owners: 5,784 units, 17,150 patterns, 272 frames, and 29 n-gram records. Every complete-record canonical digest matched its logical input after the explicitly disclosed compilation-identity rebind. Thirteen native checks passed, including inaccessible/missing/changed holders, exact decoded byte budgets, and complete rollback of fixture rows, revision, and activation state. The source database remained read-only.

| Native paired fixture | Before | After |
| --- | ---: | ---: |
| Units, including indexes and TOAST | 61,104,128 B | 17,637,376 B |
| Patterns, including indexes and TOAST | 318,349,312 B | 142,581,760 B |
| Frames, including indexes and TOAST | 4,767,744 B | 1,966,080 B |
| N-gram records, including indexes and TOAST | 6,979,584 B | 6,782,976 B |
| All fixture tables and indexes, including identical common data | 454,344,704 B | 232,112,128 B |

The paired fixture saves **222,232,576 B (48.9%)**. Existing JOIN and creative-event packing remain identical in both alternatives. This is a storage-format comparison, not a measurement of ingestion throughput or a claim that the whole R004 database shrank: unrelated graph and consolidation data were not imported, and no production migration or compaction ran. The corrected product build starts in a fresh physical database from pinned raw inputs.

## Historical compact JOIN follow-up

The [archived compact JOIN repair receipt](storage-amplification/compact-join-repair.md) measures one complete source and its seven former syntax-component rows. Its local-adjacency result survives in the segmentation witness; the independent predictor and its storage do not. The native temporary-table comparison used 3,563,520 allocated bytes versus 24,018,944 for the corrected dense intermediate, with all fixture writes rolled back. This is historical syntax-cohort evidence, not a current storage format, whole-brain reduction or capability result.

## Current sufficient-state ingestion result

The current producer was remeasured on the identical four complete Dolly transcripts at the local 7 GiB heap setting. The fresh database admitted 369,050 unique learned UTF-8 bytes and grew by 29,319,168 bytes, or **79.4450x**. Full public records and request-seed projections passed canonical comparison; exact-ID segmentation archives were deliberately absent from the request seed. The identical historical build grew by 44,138,496 bytes (119.6003x), so the current physical reduction is 14,819,328 bytes (33.57%). The 10x goal remains unmet.

The old denormalized construction-row and segmentation-array producers are gone. The remaining dominant relation is `language_patterns` at 16,793,600 allocated bytes. Its 193 source witnesses retain every exact full-DAG arc energy and account for 10,121,834 stored JSONB datum bytes. Distinct per-window semantic, syntax and morphology memories account for 4,032,662 more; a uniqueness audit found that collapsing those windows would discard learned evidence. The qualified receipt and table/family audit are under `.scce/verification/native-dolly41-44-final-7g-20261110/`; see [the measurement procedure and comparison](storage-amplification/native-ingestion-measurement.md).

Those witnesses contain 670,779 arcs and 464,079 distinct learned energies. The exact compact DAG bytes alone are 6,321,329 bytes (17.13x the source denominator). Therefore the current 10x goal cannot be reached by moving the same graph into `BYTEA`, deleting audit metadata, or applying another outer compression layer; it requires a smaller exact factorization of the learned energy graph with cold-replay parity.
