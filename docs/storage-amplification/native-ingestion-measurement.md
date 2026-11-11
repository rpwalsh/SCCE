# Measure ingestion storage on a fresh PostgreSQL database

`tools/measure-ingestion-storage.mjs` measures the ordinary SCCE trainer on complete local inputs. Each invocation creates a new physical PostgreSQL database from `template0`, initializes the current schema through `createBrainDatabase`, and calls `prepareLanguageCorpusTraining` followed by `commitLanguageCorpusTraining`. It never copies learned state from an older brain or reuses an output directory.

## Prerequisites

- Run from a checkout with dependencies installed and current compiled kernel/adapter output: `pnpm exec tsc -b packages/kernel packages/adapters-node`.
- Use an existing local runtime config with working PostgreSQL credentials and permission to create a database. The configured database is used only for connection settings and database creation; its application tables are unchanged.
- Unset `SCCE_DATABASE_URL`: the existing database-creation helper rejects an environment override that could redirect the new config.
- Choose a **new Git-ignored directory**, such as `.scce/verification/my-storage-run`. The tool refuses an existing directory. Keep the compiled implementation unchanged while measuring.

The tool uses local deterministic training and PostgreSQL. It does not call an LLM or provision hosting.

## Complete local UTF-8 text

```powershell
node --max-old-space-size=7168 tools/measure-ingestion-storage.mjs --config=scce.local.json --input=examples/first.txt --input=examples/second.txt --out=.scce/verification/text-storage-run --readback --request-seed
```

Plain-text inputs use the registered `workspace` source system unless `--source-system` is supplied. Each input is one sequential prepare/commit batch. Invalid UTF-8 is rejected. The existing corpus text normalizer defines the admitted text; the tool records both the original file SHA-256 and normalized text SHA-256/UTF-8 byte length. It does not select a prefix, split a source into substitute files, or truncate content.

`--max-input-bytes=N` is an optional operator-chosen rejection bound. It rejects an oversized source in preflight rather than truncating it. There is no new default input-size cutoff.

## Declared transcripts

```powershell
node --max-old-space-size=7168 tools/measure-ingestion-storage.mjs --config=scce.local.json --input=path/to/declared-transcript.json --transcript --out=.scce/verification/transcript-storage-run --skip-observations --ngram-max-order=4 --ngram-max-counters=12000 --ngram-vocabulary-limit=24000 --max-evidence-chunk-bytes=65536 --created-at=1000 --readback --request-seed
```

`--transcript` explicitly treats every supplied input as a declared human-authored transcript. It calls the existing transcript validator and trains the complete declared text with all declared turns. Its default source system is `dialogue`. Without this flag a JSON file is ordinary text, not silently interpreted as a transcript.

The command above spells out one reproducible option set. Defaults otherwise remain those of the canonical trainer and the chosen corpus registry. In particular, raw n-gram observations are retained by default; `--skip-observations` explicitly selects the existing model-retaining optimization used by corpus producers. `--created-at` supplies a fixed training clock for comparisons; omitting it uses the normal clock. The report records the effective registry n-gram defaults and every explicit override.

The fresh database has no previously consolidated segmentation population, so training uses the existing `local_bootstrap` mode. A config's old `runtime.corpusSegmentation` declaration is deliberately removed by the fresh-database helper. This tool does not reproduce an earlier brain's global segmentation snapshot.

## Read the result

`--out/receipt.json` records:

- The new database identity, compiled implementation hashes, source hashes, source sizes and training options.
- Empty-schema allocation and allocation after every complete input batch, including **every application table, TOAST storage and index**.
- Separate preparation and commit wall times.
- Unique content hashes and normalized UTF-8 bytes that have both **promoted evidence and a learned language profile**.
- `growthBytes = current allocation − empty-schema allocation` and its ratio to those unique admitted/learned source bytes. The full allocated ratio is recorded separately. A zero denominator produces `null`, not a fabricated ratio.
- Optional verification results and per-family canonical hashes.

TOAST is already included in `pg_table_size` and `pg_total_relation_size`; do not add it again. Allocation includes page slack and dead row versions. Input file sizes and acquired-but-unlearned sources are not the expansion denominator. Duplicate learned content hashes count once even when supplied through several files.

`--readback` fetches every pattern published by the current batch through the public adapter, with exact IDs, explicit kind/schema filters, complete 32-row pages and a 64 MiB decoded budget per request. It compares complete canonical records with the compiler's publication. `--request-seed` checks the public request-seed projection against `requestSeedLanguagePattern` for the same records, including explicit receipt-family queries. Missing rows, an exceeded readback bound, or a canonical mismatch fail the run; verification does not silently accept a partial result. These checks qualify pattern persistence and projections, not every served answer or every storage family.

The only credential artifact is `fixture.local.json`, written by the existing ignored-config helper. Receipts omit connection strings and raw driver error messages. A failure records its stage, error class and error code; verification failures additionally record a bounded reason, family, row counts and canonical hashes. A committed batch is checkpointed before optional readback so a verifier failure cannot erase its physical measurement. The new database and its config remain available for inspection. Never point a continuation at that partially measured database: run a new invocation with a new output directory.

Compare runs using identical source hashes, input order, explicit options and build identities. A short text or transcript result is not a whole-Wikipedia throughput result. These measurements do not establish a whole-machine memory limit, predictive learning quality or production answer quality.

## Sufficient-state producer measurement, 2026-11-10

After removing unqualified construction rows, large event diagnostics, and denormalized segmentation arrays from the ingestion producer, the same four complete Dolly transcripts were measured again at the machine's 7 GiB Node heap setting. The language JOIN subsystem was absent. Source segmentation archives retained exact source ownership/evidence, population evidence, and every full-DAG arc energy, while retained paths, boundary-marginal arrays, grapheme-offset arrays, surface-arc indexes, and resume bodies were no longer persisted as duplicate producer output.

```powershell
node --max-old-space-size=7168 tools/measure-ingestion-storage.mjs --config=scce.brain-20261109-r003.local.json --input=.scce/corpus-bootstrap/dolly15k-v1/transcripts/dialogue-00041.json --input=.scce/corpus-bootstrap/dolly15k-v1/transcripts/dialogue-00042.json --input=.scce/corpus-bootstrap/dolly15k-v1/transcripts/dialogue-00043.json --input=.scce/corpus-bootstrap/dolly15k-v1/transcripts/dialogue-00044.json --out=.scce/verification/native-dolly41-44-final-7g-20261110 --transcript --skip-observations --ngram-max-order=4 --ngram-max-counters=12000 --ngram-vocabulary-limit=24000 --max-evidence-chunk-bytes=65536 --created-at=1000 --readback --request-seed
```

The final run completed in fresh database `scce_brain_3e470d908c25026348453fe9`. Empty-schema allocation was 3,276,800 bytes. Final growth was **29,319,168 bytes for 369,050 admitted bytes, or 79.4450 times**. This is 14,819,328 bytes (33.57%) less physical growth than the identical 119.6003-times baseline below. The 10-times storage objective is a goal rather than a hard admission gate, but it is **not met** by this result.

| Complete input | Cumulative admitted bytes | Growth added by input | Cumulative growth bytes | Cumulative ratio | Full rows verified | Seed rows verified | Audit archives excluded from seed |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| `00041` | 95,088 | 8,364,032 | 8,364,032 | 87.9610 | 121 | 64 | 57 |
| `00042` | 189,631 | 7,094,272 | 15,458,304 | 81.5178 | 125 | 68 | 57 |
| `00043` | 278,380 | 7,036,928 | 22,495,232 | 80.8076 | 122 | 70 | 52 |
| `00044` | 369,050 | 6,823,936 | 29,319,168 | 79.4450 | 122 | 69 | 53 |

Every full-record and request-seed comparison passed. The seed verifier explicitly proved that 219 exact-ID segmentation archive rows were absent from request hydration; it did not count their deliberate absence as missing data.

The final read-only storage audit identifies the remaining amplification rather than hiding it:

- `language_patterns`: 16,793,600 allocated bytes. The 193 exact full-DAG source witnesses account for 10,121,834 stored JSONB datum bytes.
- `ngram_models`: 2,727,936 allocated bytes.
- `creative_event_occurrences`: 2,195,456 allocated bytes.
- `evidence_spans`: 2,170,880 allocated bytes, including 1,581,056 bytes of indexes.
- `language_units`: 2,015,232 allocated bytes.
- Distinct per-window induced semantic, syntax and morphology memories account for another 4,032,662 stored JSONB datum bytes. A uniqueness audit found their learned rules, templates, boundary signals and graph constructions are effectively all distinct, so collapsing them as profile duplicates would discard cognitive evidence rather than fix duplication.

The 193 witnesses contain 670,779 exact DAG arcs and 464,079 distinct learned Float64 energies. Their compact SCDG payload is 6,321,329 bytes, already **17.13 times the admitted source before any PostgreSQL row, index, evidence, n-gram or semantic-memory cost**. Externalizing the same bytes to `BYTEA` could remove at most 2,107,371 gross base64 bytes before adding blob rows, keys and references, yielding an estimated roughly 74-times whole-run ratio. That is not a path to the 10-times goal. Further material reduction requires a new exact energy factorization with parity proof, not generic compression or deletion of the required full DAG.

The qualified compiled identities were kernel `fc4bd6b0473a1137c768128c446e0f90e5da703f943d690dee4e749974b45658` and adapters `7a66886d903d1c113ae8bab4d0f9263012896723ab88ed8e25207c9868259f8b`. The receipt and read-only table/family audit are preserved in `.scce/verification/native-dolly41-44-final-7g-20261110/`.

## Historical four-source baseline, 2026-11-10

The checked-in CLI completed four genuine, complete Dolly transcript files, `dialogue-00041.json` through `dialogue-00044.json`, sequentially in one fresh physical database. The original JSON files total 1,040,576 bytes and contain 970 declared turns. The expansion denominator is their **369,050 unique admitted and learned normalized UTF-8 bytes**, with four distinct content hashes and no conflicting lengths. No old learned state was copied.

The measured command used the options below. Substitute a working local connection config and a new ignored output directory when reproducing it; obtain the complete original inputs with the file hashes recorded below.

```powershell
node --max-old-space-size=3072 tools/measure-ingestion-storage.mjs --config=scce.brain-20261109-r003.local.json --input=.scce/corpus-bootstrap/dolly15k-v1/transcripts/dialogue-00041.json --input=.scce/corpus-bootstrap/dolly15k-v1/transcripts/dialogue-00042.json --input=.scce/corpus-bootstrap/dolly15k-v1/transcripts/dialogue-00043.json --input=.scce/corpus-bootstrap/dolly15k-v1/transcripts/dialogue-00044.json --out=.scce/verification/native-dolly41-44-cli-scaling-final-20261110 --transcript --skip-observations --ngram-max-order=4 --ngram-max-counters=12000 --ngram-vocabulary-limit=24000 --max-evidence-chunk-bytes=65536 --created-at=1000 --readback --request-seed
```

All byte figures below are actual PostgreSQL allocation. The 83 application tables include their TOAST and indexes exactly once. Empty-schema allocation was 3,276,800 bytes; final allocation was 47,415,296 bytes, giving **44,138,496 bytes of growth, or 119.6003 times the admitted source bytes**.

| Complete input | Admitted UTF-8 bytes | Cumulative admitted bytes | Growth added by input | Cumulative growth bytes | Cumulative ratio | Full records and seeds verified, each |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| `00041` | 95,088 | 95,088 | 12,156,928 | 12,156,928 | 127.8492 | 1,845 |
| `00042` | 94,543 | 189,631 | 10,878,976 | 23,035,904 | 121.4775 | 1,906 |
| `00043` | 88,749 | 278,380 | 10,649,600 | 33,685,504 | 121.0055 | 1,768 |
| `00044` | 90,670 | 369,050 | 10,452,992 | 44,138,496 | 119.6003 | 1,839 |

Every batch passed exact canonical comparisons of its complete current publication and its public request seeds across all 17 families: 7,358 full records and 7,358 seed records in total. The receipt retains each family's expected and actual SHA-256, the original and normalized source hashes, and all per-table allocations. This qualifies persistence and seed projection for these four inputs; it does not establish answer quality or predict storage for a larger corpus. The CLI's source metadata differs from the earlier private single-Dolly harness, so these figures are not an identical-layout storage comparison with that harness.

An external Windows sampler, at one-second intervals, observed a child-process peak working set of 2,285,834,240 bytes (2,179.94 MiB) under the 3,072 MiB V8 old-space limit. Its sampled peak private allocation was 2,206,609,408 bytes. These figures exclude PostgreSQL and other processes, and are not a whole-machine memory bound. Full unit tests ran concurrently; the recorded preparation and commit wall times must not be used for latency comparisons.

Original file SHA-256 identities:

```text
00041  99902afd562b974293a0e6b5b66466235717a0e29762c2e9316c2c8c53f029e4
00042  fa441717e308197475240e951c74e95b29599659097abd2737cd6f4f8e3eb32c
00043  760afe46fd7d245f9b95a9b17cae0e82979a6f607d431919b8b2fb683bdc21fb
00044  fab10dea31c5f28a20670748c7ef34651e73ceb61c96699183dcfa11ed7eed31
```

Compiled JavaScript identities were checked before and after the run and remained unchanged:

```text
kernel    6c85ff0a2611d82c40fa6fc59f5ea2bc681ce2363d6c85703c2091179e51dcaf
adapters  de34d8fc4463c6562b93545098b5b1a8aaa46eaed1500242efbbc1ac1ce6b39b
```

Local ignored artifacts are preserved in `.scce/verification/native-dolly41-44-cli-scaling-final-20261110/`: `receipt.json`, `scaling-summary.json` and `external-process-memory.json`. The fresh database, `scce_brain_b55b5323a2d11b50d5e1857f`, remains available for review. The sampler did not retain a child exit code; successful completion is established by the CLI's `status: complete`, its final `complete: true` output and all verified batch receipts.
