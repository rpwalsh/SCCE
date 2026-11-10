# Native ingestor representation measurements

Each row below is a new physical PostgreSQL database. Every build uses the same complete original Dolly transcript: 222 turns, 259,681 file bytes, **95,088 admitted normalized UTF-8 bytes**. No learned state was copied. The source file SHA-256 is `99902afd562b974293a0e6b5b66466235717a0e29762c2e9316c2c8c53f029e4`; admitted text SHA-256 is `31b4d891612618901482e6a9b59634096cec7a419c2d6eb1fb70da80bab7eda0`.

The numerator includes all application tables, TOAST storage and indexes, minus that database's empty-schema allocation. It is not the size of serialized JSON or a selected table.

| Build | Allocated bytes | Empty bytes | Growth bytes | Growth / admitted text |
|---|---:|---:|---:|---:|
| Original pipeline | 21,331,968 | 3,227,648 | 18,104,320 | 190.395x |
| r003: sufficient semantic tape and graph/unit representation | 18,972,672 | 3,227,648 | 15,745,024 | 165.584x |
| r004: bounded lexical pages | 17,678,336 | 3,260,416 | 14,417,920 | 151.627x |
| r005: shared construction decisions, 256 KiB pages | 17,129,472 | 3,276,800 | 13,852,672 | 145.683x |
| r006: indexed metadata references and 64 KiB construction writes | 16,506,880 | 3,276,800 | 13,230,080 | 139.135x |
| r007: frozen score factors and bounded 16 KiB construction writes | 15,319,040 | 3,276,800 | 12,042,240 | 126.643x |

r007 retains **33.484% less growth** than the original pipeline on this source. This does **not** resolve the whole-brain amplification problem. The separate stopped 165-owner diagnostic database occupies 2,490,163,200 bytes for 13,173,002 unique admitted/learned bytes (189.035x); it has not been rebuilt with these changes. The 10x objective remains a goal, not a hard gate.

## What changed

- JOIN implementations remain. Their full measured DAGs and original path decisions support calculating selected statistics without persisting expanded pair tables. Graph topology and Float64 energies remain exact; unit rows use a checked dictionary.
- Semantic persistence retains the actual measured predicate decisions, source ownership, lexical classes and reconstruction digest once. The shared reducer reconstructs the public frames, relation statistics and graph-bound constructions; it does not fit or learn during reads. The SQL entity seed projection remains readable.
- Lexical definitions share bounded pages instead of paying a PostgreSQL row and repeated JSON framing per form. Source-owned witnesses and occurrences still authorize access before pure definitions are read.
- Construction occurrences share exact coordinate decisions and owner definitions. References retain their existing query hints. Inputs whose necessary hints are absent remain intact. The writer uses 64 KiB pages while retaining the 256 KiB reader contract.
- Source metadata references identify selected fields by positions in the canonical owner dictionary. The verified compilation identity already binds the metadata digest. The per-record reconstruction digest and all ownership checks remain.
- Frozen boundary scorer inputs now replace calculated arc-energy caches in trained JOIN documents. Source-intrinsic features use the original shared evaluator, while fitted coefficients and learned feature decisions remain. All 50 genuine source-window graphs replay exactly, including original Float64 energies and order. Stored syntax JSONB falls from 2,575,328 to 1,213,485 bytes (52.9%). Capture is enabled only in ingestion; ordinary request/Mouth lattices retain their original path.
- Page fitting grows its search from the local page capacity instead of rebuilding the entire remaining batch for every page. The 16 KiB STORE fixture's write time falls from 15.509 s to 5.082 s, with identical page IDs, partitions and physical pattern rows. Increasing-cohort tests bound inspected work rather than relying on a timing threshold.
- Auxiliary and parent writes use the same transaction. Unaffected pure payloads perform no auxiliary queries or transactions.

## Correctness and operational checks

r004, r005 and r006 each pass complete public-adapter readback of **1,845 records**, including their full canonical content, plus all **17 request-seed families**. Their expanded logical public-record digest is `e3d042728096e2baaa39afb705628f53afff32393e7c966f003b0ebffc938867`; request-seed digest is `4f06845c1a9d8907495e2f59de216c9919e766b6669221a985d6320e24c37559`.

r007 also passes all 1,845 complete public records and all 17 seed families. Its new redundant score-recipe metadata changes the complete public-record digest to `e0996594e3a2bd81267a5cfa275004068342449efda3af820ff1c49201c1e2d6`; the seed digest stays identical. All 12 baseline learning-component comparisons pass after excluding only the added recipe metadata alongside the previously declared version/representation exclusions. The original graphs, identifiers, decisions and source observations remain compared.

Twelve comparisons against the original build also pass: expanded construction observations, morphology/syntax/semantic payloads, local factors, relation models, semantic frames, graph-bound constructions, remaining pattern families, n-gram models, language units and semantic-frame records. These comparisons explicitly exclude new representation metadata and versioned compilation/model identities. Independent JOIN tests qualify probabilities and proof paths. This is not a claim that different schema versions have identical complete records.

A separate fresh native database validates unchanged-input checkpoint replay: **3.4 ms**, same receipt, unchanged counts and content hashes across all **83 application tables**. Injected failures after an auxiliary insertion and after valid-owner parent insertions roll back every table and memory revision, preserve public records, and leave no new auxiliary pages. Its physical allocations are excluded from storage measurements because rolled-back writes can allocate pages.

## Read amplification remains under review

r005's 256 KiB pages caused a real regression. A component profile measured 13,895,204 bytes fetched for 837,717 bytes of distinct expanded pages across 56 small batches. Removing duplicate page validation reduced CPU work; smaller write pages reduce overfetch.

Serial, new-application-process readbacks ran after test workers exited, with PostgreSQL connections forced read-only. Every build restored the same 1,845 complete records. PostgreSQL and OS caches were warm; this is not a cold-disk benchmark.

| Build | Complete readback | Construction batches, total | 32-row batch median | One-record query median |
|---|---:|---:|---:|---:|
| r004, inline construction observations | 3,432 ms | 1,198 ms | 21.39 ms | 32.47 ms |
| r005, 256 KiB construction pages | 7,152 ms | 4,667 ms | 83.39 ms | 69.15 ms |
| r006, 64 KiB writes and reduced validation | 5,216 ms | 2,705 ms | 44.87 ms | 44.44 ms |

r006 reduces page amplification but retains a material read tradeoff. Its earlier ingestion and readback timings overlapped test suites and are excluded from this latency comparison. Storage reduction alone does not qualify the tradeoff. These are artifact readbacks, not whole-turn response times.

The final complete 20-shard run and complete corrected reruns of shards 11 and 14 pass **832 files and 5,681 tests**, with 10 files/19 environment-dependent tests explicitly skipped. Updated fixtures preserve the original whole-product oracle after excluding only redundant scorer metadata, and use a valid logical ledger for projected-budget checks. The full build, final TypeScript checks, proprietary-boundary check and four measurement-tool tests pass. No production code changed after this sweep.

Independent review also reproduced two integrity bugs and supplied regression tests. Evidence reads during an explicit event append now use that same transaction client and access predicate, including a one-client pool. Decoded-byte ledgers are verified after all layers restore the parent, including graph/JOIN/semantic-only payloads and JOIN-member charges; forged budget charges are rejected. Existing corpus, source ownership and logical-byte limits remain enforced.

Local detailed receipts and source publications are under `.scce/verification/native-dolly41-*`; native rollback results are in `.scce/verification/native-dolly41-checkpoint-atomicity-20261110/qualification-summary.json`. Config files containing connection settings stay ignored. No deployment, whole-Wikipedia build or assistant-superiority claim follows from these measurements.
