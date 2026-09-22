# Brain footprint: what the writers persist

Measured 2026-09-22. All numbers are `pg_total_relation_size` on PostgreSQL 16 unless noted.

## The ratio

A 6,409-page wikipedia brain held **148 MB of wikitext** (the evidence spans are exactly that text, one copy)
against **16.5 GB** of brain excluding the n-gram observation rows nothing read: **111x the text**.

| store | MB | x text | per page | what it is |
|---|---|---|---|---|
| graph_nodes | 4,192 | 28 | 654 KB | 200 nodes/page; 70% proposition nodes whose 1.1 KB representation was mostly `featureSet(value)` output per role |
| language_patterns | 3,594 | 24 | 561 KB | construction bundles (constructions + form classes + example texts) |
| graph_edges | 2,669 | 18 | 416 KB | 300 edges/page; 45% is five indexes, two never scanned |
| ngram_models | 1,746 | 12 | 272 KB | per-shard Kneser-Ney models, 69% of each row derived from `counts` |
| evidence_spans | 1,570 | 10.6 | 245 KB | text 2.3 KB per span beside 14 KB of provenance and 707 features |
| evidence_anchor_index | 672 | 4.5 | 105 KB | the anchor subset of span features again, with its own GIN |
| language_units | 637 | 4.3 | 99 KB | 6-byte units carrying 7.4 KB of shard metadata each |
| relation_observations, events, semantic_frames, blobs, hyperedges, checkpoints | 1,417 | 9.6 | 221 KB | |

Compression was measured (zstd: bundles 21x, models 7.6x, audit events 63x against pglz's 1.5-4.3x) and rejected:
every read would pay to decode it. The writers are the problem.

## Five mechanisms

1. **Derivations persisted beside their inputs.** Role feature sets and normalized forms, Kneser-Ney context tables,
   successor indexes and back-off weights, `sourceVersionIds` lists derivable from evidence ids.
2. **One record written many times.** The page's link list on every span twice and on the source version; the
   shard's page list on every unit, pattern, frame and model; the training audit's alignment summaries under two
   keys; a candidate's provenance on its node's representation and again in its metadata; a link's evidence list
   in six places on its candidate node and four on its hyperedge.
3. **Imprecise evidence binding.** Every wikilink cited every span of its page.
4. **The row envelope.** 53-62 byte hash identifiers in every key and array column and an identical 144-byte
   information label on every row. On a 60-page brain: 86% of `graph_edges` row bytes, ~70% of `graph_hyperedges`,
   ~25% of `graph_nodes`, plus indexes that scale with key width (edges: index bytes = heap bytes).
5. **Index overhead.** `edges_source`/`edges_target` are covered by the `_rank` indexes on the same leading column
   and were never scanned on any served brain.

## What changed (2026-09-22) and what it measured

Same 60 pages of the same dump, four serialized runs into fresh schemas, MB:

| table | before | derivations + duplicates removed | + link binding | + candidate provenance once |
|---|---|---|---|---|
| graph_nodes | 153.0 | 149.1 | 127.8 | 127.5 |
| graph_hyperedges | 49.9 | 47.4 | 32.8 | 32.8 |
| language_patterns | 36.8 | 36.3 | 36.3 | 36.3 |
| graph_edges | 36.0 | 36.0 | 36.0 | 36.0 |
| evidence_spans | 35.0 | 23.0 | 23.5 | 23.0 |
| ngram_models | 24.5 | 7.4 | 7.4 | 7.4 |
| evidence_anchor_index | 19.2 | 18.2 | 21.2 | 20.1 |
| ingestion_checkpoints | 17.3 | 13.0 | 12.5 | 12.5 |
| language_units | 4.1 | 2.2 | 2.2 | 2.2 |
| events | 3.7 | 2.4 | 2.4 | 2.4 |
| semantic_frames | 2.8 | 1.9 | 1.9 | 1.9 |
| total (tables over 64 KB) | 397.4 | 352.2 | 319.3 | 317.2 |

The anchor index's movement is GIN state, not rows (546 rows in every run). The graph's cardinality was identical
in every run (3,816 promotion decisions, 4 promoted seeds, 8,526 shard hyperedges, 42,489 nodes): the changes
altered what each row carries, not which rows exist.

One measurement corrected a prediction. Removing the candidate provenance copy took 1,160 raw bytes off every
candidate node's metadata but only 40 stored bytes: TOAST's pglz had already folded the repeat, because the same
identifier strings sat beside it in the row. Duplicates inside one row are nearly free on disk; the bytes that
cost are the same list written on several rows and tables, which no per-value compressor can see.

- Kneser-Ney models persist their sufficient statistics (`counts`, `continuationCounts`, `unigramCounts`,
  vocabulary, totals); readers derive the context tables and compile the indexes, as hydration already did.
- Proposition roles persist their value; `features` and `normalized` are derived on read.
- Wikipedia spans carry the page's identity keys, not its link list or structure.
- Learned rows carry the shard's provenance without its page list; the learned event carries it once.
- A link candidate cites the spans whose text carries its label; the page-wide binding remains the fallback.
- A promoted candidate's provenance is stored once, on the node's representation.

Each change has a test that fails without it and reads records written in the older shape unchanged.

## Still writing too much, biggest first

1. **The envelope**: surrogate integer keys and a label dictionary (schema v2, new brains). Edges shrink roughly 5x,
   hyperedges 3x, nodes 1.4x, and every index over those keys with them.
2. **Hyperedge `provenance_refs`** equals `evidence_ids` on 100% of wikipedia rows; participant ports repeat the
   list again. Readers use per-port evidence, so this is a schema question, not a writer one.
3. **Construction bundle `sourceExamples`** repeat each example text ~11 times across a shard's bundles; the
   bundle digest covers them, so referencing evidence ids changes the digest scheme.
4. **`evidence_anchor_index`** duplicates the anchor subset of `evidence_spans.features` with a second GIN; the
   retrieval SQL's posting-cap probes read it.
5. **Plain `edges_source`/`edges_target`** indexes: drop from the schema contract.

## Operational limits found while measuring

- Two ingests against the same dump at once fail: the shared input-identity cache is rewritten
  ("Wikipedia input changed during language preparation") and a 64 MB single-statement batch insert hit
  `write ENOBUFS` on the loopback socket. Measurement runs must be serialized.
- The floor. With 200 nodes, 300 edges and 150 hyperedges per page, the brain stays far above the 4x-of-text that
  would fit all of English Wikipedia in 250 GB even after the envelope is fixed. Below that is a representation
  decision, not a storage one.
