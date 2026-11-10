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
node --max-old-space-size=4096 tools/measure-ingestion-storage.mjs --config=scce.local.json --input=examples/first.txt --input=examples/second.txt --out=.scce/verification/text-storage-run --readback --request-seed
```

Plain-text inputs use the registered `workspace` source system unless `--source-system` is supplied. Each input is one sequential prepare/commit batch. Invalid UTF-8 is rejected. The existing corpus text normalizer defines the admitted text; the tool records both the original file SHA-256 and normalized text SHA-256/UTF-8 byte length. It does not select a prefix, split a source into substitute files, or truncate content.

`--max-input-bytes=N` is an optional operator-chosen rejection bound. It rejects an oversized source in preflight rather than truncating it. There is no new default input-size cutoff.

## Declared transcripts

```powershell
node --max-old-space-size=4096 tools/measure-ingestion-storage.mjs --config=scce.local.json --input=path/to/declared-transcript.json --transcript --out=.scce/verification/transcript-storage-run --skip-observations --ngram-max-order=4 --ngram-max-counters=12000 --ngram-vocabulary-limit=24000 --max-evidence-chunk-bytes=65536 --created-at=1000 --readback --request-seed
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

The only credential artifact is `fixture.local.json`, written by the existing ignored-config helper. Receipts omit connection strings and raw driver error messages. A failure records its stage, error class and error code; the new database and its config remain available for inspection. Never point a continuation at that partially measured database: run a new invocation with a new output directory.

Compare runs using identical source hashes, input order, explicit options and build identities. A short text or transcript result is not a whole-Wikipedia throughput result. These measurements do not establish a whole-machine memory limit, predictive learning quality or production answer quality.

## Measured four-source qualification, 2026-11-10

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
