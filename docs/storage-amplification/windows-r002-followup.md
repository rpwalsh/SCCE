# R002 storage follow-up

Native PostgreSQL measurements on 9 November 2026. The database was read only; comparison writes used temporary tables in a separate fixture database and were rolled back.

## Current build

At 23:11:57 UTC, `scce_brain_20261109_r002` held 101 promoted source owners, 7,719,059 unique promoted source bytes and 1,509,703,680 allocated relation bytes: approximately 196 times the admitted source bytes. This is an interrupted, incomplete build at `428b9fd0`, not a completed language or capability evaluation.

| Relation | Allocated bytes, including indexes |
| --- | ---: |
| Language patterns | 1,130,594,304 |
| Creative event occurrences | 76,570,624 |
| Language units | 57,040,896 |
| N-gram structures | 52,174,848 |
| Evidence spans | 36,061,184 |
| Events | 30,326,784 |

The earlier R004 consolidation footprint does not explain this build. R002 uses the explicit initial source-training strategy and its consolidation store has zero rows. The per-run and collection query returned an empty result at 18:25:44 UTC. At that earlier snapshot, semantic-role and syntax records comprised 97.6% of stored pattern JSON. The timestamps and source cohorts differ; these are not one atomic snapshot.

## Same-cohort representation comparisons

All comparisons used the same 1,799 semantic-role records from one committed Dolly profile, including 1,792 construction patterns and seven semantic-memory records. Each temporary table copied the actual language-pattern column types, constraints and indexes. Rows were inserted in the same order. The baseline stored JSON total of 6,135,403 bytes matched the exported source cohort.

| Representation | Stored JSON bytes | Total allocated bytes |
| --- | ---: | ---: |
| Current writer | 6,135,403 | 9,330,688 |
| Shared inherited provenance scalars | 5,701,754 | 8,282,112 |
| Scalars plus role-coordinate tuples, prototype | 5,798,790 | 8,396,800 |
| Scalars plus semantic dictionaries, prototype | 5,600,491 | 8,167,424 |

The scalar repair saves 1,048,576 allocated bytes, or 11.24%, in this cohort. Full decoded-record reconstruction retained digest `f9f1ad510866fac5d38e9a55f2f855c5bc4a681fc1514deaa31b6f055e502f40`.

The role-coordinate prototype reduced wire JSON but increased stored JSON and allocation compared with scalar sharing alone. It is excluded from the implementation. The semantic dictionary prototype saves a further 114,688 allocated bytes, or 1.38%, over scalar sharing. It remains an offline prototype. Neither result establishes a whole-database reduction or resolves the approximately 196-fold amplification.

PostgreSQL already compresses repeated keys and strings inside each value. Wire length is therefore insufficient to choose a representation. Future changes must preserve complete decoded records and SQL-visible lookup fields, and demonstrate their benefit on native PostgreSQL before adoption. Cross-record sharing remains an investigation target; distinct learned observations must not be merged merely because their structures resemble each other.

## Reproduction

`tools/audit-storage-amplification.mjs` is the existing read-only auditor. It now includes live consolidation bytes grouped by run and collection. Those group totals exclude row/index overhead and cannot attribute free pages to a collection. Relation allocation and rendered JSON lengths must be reported separately.

The accompanying JSON receipt records the table snapshots and physical comparison results. No production data migration, deletion, index change or vacuum was performed for these measurements.
