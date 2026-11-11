# Compact JOIN repair

> Archived measurement of the former independent language JOIN predictor. The
> predictor, codec, durable storage and runtime consumers were deleted on
> 10 November 2026. Full-DAG adjacency learning survives in
> `source-segmentation-witness.ts`; language output is now realized by typed
> construction algebra. Nothing in this document authorizes restoring a
> compatibility runtime.

Native Windows measurements on 9 November 2026 (10 November UTC) used the same complete source: 94,787 UTF-16 units and 95,088 UTF-8 bytes, compiled into seven source-window models covering 50 windows. At candidate revision `0a331b81768d99db4b3fa2d78c539977f28e0fab`, seven syntax-component rows occupy **3,563,520 allocated PostgreSQL bytes**, versus **24,018,944 bytes** for the corrected dense intermediate: 20,455,424 bytes, or **85.2%**, less. The [sanitized receipt](compact-join-repair.json) records source and native-module identities, measurements and qualifications.

## Correctness and representation

The old learner derived local JOIN counts from a bounded list of complete segmentation paths. Individual retained-path probabilities could round to zero while exact local adjacency probability remained positive. That produced many zero-count choices and suppressed genuine learning. The repair uses full-DAG adjacency marginals for local evidence; retained global derivations carry their measured mass and preserve unresolved probability.

The dense corrected implementation then materialized hundreds of thousands of exact/class lookup rows and repeated source coordinates. The final writer stores the source, learned arc energies and necessary unit/context data once. Exact/class lookup uses the same adjacency law lazily. Forward/backward values and canonical class hashes are derived once in an owned runtime index. Genuine foreign class labels and source bounds inside grapheme clusters remain explicit.

Local-shape and fixed-construction rows retain their measured counts, probabilities and evidence IDs. Complete source-coordinate proofs are reconstructed only for a selected factor or an explicit public proof lookup. Scoring and serialization do not expand every proof. Regression fixtures check complete witness equality, source ownership, Unicode coordinates, cold restoration, deterministic identities and honest byte ledgers. No observations or positive witnesses are pruned.

## Same-source native compiler measurement

| Variant | Packed JOIN JSON bytes | Local observation mass | Elapsed ms | CPU ms | Peak Node RSS bytes |
| --- | ---: | ---: | ---: | ---: | ---: |
| Old bounded-path learner | 26,771,926 | 0.002158964837 | 45,324.03 | 57,485 | 881,852,416 |
| Corrected dense intermediate | 78,570,679 | 13,781.697480076398 | 54,064.76 | 69,468 | 1,257,820,160 |
| Corrected compact writer | 6,510,157 | 13,781.697480076398 | 28,402.86 | 30,938 | 675,786,752 |

These are one contended offline run per variant with Node `v24.18.0` and a 1,536 MiB heap declaration. RSS includes the native process high-water mark. They establish the recorded source/build measurements, not general ingestion-throughput guarantees. The final writer has 1,822 stored choices, no zero-count or zero-probability choices, and no materialized exact/class tables. Lazy lookup remains available. Native observation totals equal the dense control; focused fixtures establish lookup/proof parity rather than an exhaustive pair-by-pair audit of this entire source.

## Native PostgreSQL comparison

Each variant projected exactly seven canonical syntax rows through the existing language-memory projector and durable JOIN encoder. Profile/source/evidence identities, timestamps, fields and source-window insertion order were fixed. Temporary tables copied the actual `language_patterns` layout, constraints and indexes; each insert contained one row. All three variants ran under one outer transaction, which was rolled back. Source/model files and the native build were checked unchanged. No application rows or indexes were rewritten.

| Variant | Stored JSONB bytes | Heap + auxiliary/TOAST bytes | Main-table indexes | Total allocated bytes |
| --- | ---: | ---: | ---: | ---: |
| Old bounded-path learner | 3,445,175 | 3,629,056 | 98,304 | 3,727,360 |
| Corrected dense intermediate | 23,002,096 | 23,920,640 | 98,304 | 24,018,944 |
| Corrected compact writer | 3,282,932 | 3,465,216 | 98,304 | 3,563,520 |

Stored JSONB bytes are the sum of `pg_column_size(pattern_json)`. Allocation uses `pg_table_size` plus `pg_indexes_size`; TOAST data/index details and rendered JSONB sizes are separate fields in the receipt. Packed JOIN JSON in the compiler table excludes the surrounding syntax-component fields. The two tables therefore have different byte denominators.

The old learner is a defect control, not a semantically equivalent baseline: it stored 19,977 zero-count choices. The final allocation is also 4.4% below that control, but the corrected learning behavior is the reason to replace it. This comparison covers seven syntax rows from one full source. It establishes neither whole-brain savings, answer quality, reconstruction parity with the broken learner, nor build readiness. No migration or physical compaction ran.

## Checks and reproduction

The original focused commands named files that were intentionally deleted with
the retired architecture. Current qualification uses the segmentation-witness,
fresh-source construction-composition and exact generative-derivation tests:

```sh
pnpm exec vitest run packages/kernel/src/__tests__/source-segmentation-witness-real-source.test.ts packages/kernel/src/__tests__/fresh-source-construction-composition.test.ts packages/kernel/src/__tests__/generative-derivation-exact.test.ts packages/kernel/src/__tests__/generative-derivation-runtime.test.ts
node tools/no-hidden-model-check.mjs
```

The final cold/provenance run passed 42 tests, with one optional external-sample check skipped. The consumer run passed 56 tests across nine files; the final shared-coordinate extraction rerun passed 17 affected tests. These runs overlap and are not additive. Strict combined kernel/adapter source type checking passed. Authentic failing controls cover redundant class emission, eager proof generation, multiline normalization, inner-grapheme bounds and acceptance of mixed implicit/eager proof payloads. The static source-policy check passed across 1,789 source/package files, with no prohibited product dependencies/endpoints or imports of declared evaluation references; this does not attest runtime network isolation.

The measurement harness and exact source archives were supplied locally and are not included here. Reproduction requires the source SHA-256 and build identities in the receipt, plus the same 16,000-unit batch and 2,000-unit window limits. Native compilation calls `compileSourceInductionWindows`; syntax projection calls `languageMemoryPatternsFromInducedLanguageModel`; physical comparison calls `encodeDurableJoinPrograms`, inserts into temporary `LIKE language_patterns INCLUDING ALL` tables one row at a time, measures the PostgreSQL size functions above, then rolls back. Private paths, connection settings and source text are omitted from this report and receipt.
