# Ingestion recovery audit — 2026-09-20

## Verified incident

The original 6,409 source versions in `scce5_runtime` record the numbered
`enwiki-latest-pages-articles-multistream1.xml-p1p41242.bz2` file under
`OneDrive/Desktop/wtg-repos/scce/data/wiki`. The subsequent interrupted run
read the full `enwiki-latest-pages-articles-multistream.xml.bz2` under
`OneDrive/Documents/yopp/data/wiki`. It committed 118 additional versions
of existing article identities; all 118 compared revision IDs and content
hashes differ from the prior versions. This is not evidence of a hash
determinism failure.

The two filenames have different checkpoint roots. The initial diagnosis
that these runs shared a resume cursor was incorrect. The full dump's XML
header identifies `enwiki` and `https://en.wikipedia.org/wiki/Main_Page`.
File modification times alone do not establish dump publication dates.

The local Claude session `e91f0a37-4427-43b7-a5b8-2e73cb797366.jsonl`
under `.claude/projects/c--Users-react-fuggit` records:

| Lines | Executed action / evidence |
| --- | --- |
| 6629–6631 | Assistant sets the working config's dump and index to the numbered shard. |
| 19010 | User requests a clean ingestion into scce5; no shard is specified. |
| 19050, 19094 | Assistant copies that config, changes schema/port, then starts firehose with the inherited source. |
| 19386, 19427, 19485 | Process output shows ingestion alive; assistant subsequently issues an explicit stop. Earlier assistant claims that it had died were incorrect. |
| 20384 | Working configs are retired despite differences in source paths, page limits, memory bounds, and language training settings. |
| 20627–20631 | Base config's dump path fails with ENOENT; assistant uses the numbered shard explicitly for subsequent diagnostics. |
| 20805, 20895, 20902 | A 12-block diagnostic starts; the weekly limit is reached; the background job later finishes. No continuous restart follows. |

`.scce/sustained.log` independently records that last job: 855 pages, 12
blocks, 141 n-gram models, 10,251 language units, 3,884 patterns, 5,516
semantic frames, no owner/memory stop and no warnings. Token exhaustion
prevented the follow-up; it did not kill that job.

## Confirmed code defects repaired

- Firehose children omitted the parent's schema override. They now receive
  the resolved schema explicitly; status, stop, and lock paths are also
  separated by schema.
- Block checkpoints were persisted before buffered language training.
  Completed block checkpoints now remain pending until the language write
  and checkpoint release commit in one storage transaction.
- Resume fetched the latest 2,000 completed checkpoints before filtering
  for blocks. It now filters stored block checkpoints in PostgreSQL before
  ordering by offset and selecting the latest one.
- A capped generator return was treated as corpus EOF. The stream now
  reports actual EOF separately from page/block caps. Skipped language
  training prevents a full-training claim.
- Block decode failures could be skipped while later checkpoints advanced;
  index subprocess errors could masquerade as EOF. Both now fail visibly.
- Continuous firehose stopped at the default configured page cap. It now
  continues when no explicit page/block bound was requested, and rejects
  a restart with no durable block progress.
- The calibration fitting tool ignored the selected runtime config. It
  now supports its matching local overlay, explicit config/schema selection,
  and a credential-free preflight.
- The documented zero value for unlimited language training was rejected
  by config validation. Zero is now accepted; fractional and negative
  document limits are rejected.

## Stored-content audit

Read-only inspection of `scce5_runtime` found 6,409 article identities,
6,527 source versions and 41,224 promoted evidence spans. Of the source
versions, 6,409 name the numbered dump and 118 name the full yopp dump;
both identify `enwiki`.

- All 6,527 stored source blobs match their SHA-256 hashes and byte lengths.
- All 41,224 evidence spans match their source byte slices, evidence hashes,
  stored span blobs and source identities. Unicode code-point offsets also
  match for all spans. An initial JavaScript UTF-16 slicing check was the
  wrong interpretation of this contract; the corrected full check reports
  zero character-offset mismatches.
- Every version has evidence covering its stored byte length. This checks
  the normalized stored text, not preservation of all information in raw
  wikitext.
- Twenty-five sampled versions, spread through the stored corpus and both
  dump origins, match the recorded page IDs, titles, revisions and current
  normalized dump text. They were independently decompressed from the
  recorded block offsets. This is a sample, not a full dump comparison.
- Samples of 2,000 graph edges and 2,000 hyperedges have no missing node or
  evidence references. Structural integrity does not prove semantic
  correctness or answer quality.
- There are 1,048 compiled n-gram models. Their recorded article references
  cover 6,471 stored versions. The other 56 versions (31 numbered-dump,
  25 yopp-dump) also have no semantic frames or language units. Ingestion
  of evidence therefore demonstrably outpaced persisted training artifacts.
  The model reference-array cap was not exhaustively checked: its aggregate
  query exceeded the read-only 60-second statement timeout.

The cleaner is **not information-preserving**. The sampled Bonn article
contains `about {{cvt|24|km|0}} south-southeast of [[Cologne]]` in the dump,
but its stored text says `about south-southeast of Cologne`.
`wikiSurfaceLines` calls `removeTemplates`, which drops the numerical value.
The Albedo article begins with a leaked image caption and `]]`, caused by
handling of nested links. Marker scans find wiki-link delimiters in 4,246
versions, template delimiters in 252 and table delimiters in 2,042; some
literal syntax can be legitimate, so these counts are indicators, not
counts of proven defective articles. These parser defects remain unfixed.

The only source containing U+FFFD is the article *Character encodings in
HTML*, whose raw dump itself contains that character. It is not evidence
of a decoding failure. Outcome calibration has zero observation rows;
no held-out language or answer evaluation was executed in this audit.

Local reproducible audit scripts and JSON results are in
`.tmp/scce5-audit-integrity.cjs`, `.tmp/scce5-extract-samples.py`,
`.tmp/scce5-audit-samples.mjs`, and `.tmp/scce5-audit-followup.cjs`.
Every database audit transaction was read-only.

## Recorded performance

The existing sustained-run trace spans 140.21 minutes for 855 articles,
about 6.1 articles per minute. It records 81.70 minutes in language training
(including 75.12 minutes compiling) and 45.57 minutes in page transactions
(including 18.23 minutes persisting built graphs and 16.48 minutes
persisting evidence). Nested stage times must not be added together.

This identifies training computation and database persistence as measured
targets. It does not establish a speedup or justify promising full
Wikipedia in hours. No performance change or new ingestion was run for
this measurement.

## Recovery state and limits

`scce5_runtime` is retained for inspection. The local config now selects
`scce6_runtime`, the full yopp enwiki dump and its plain text index, with
`languageTrainingDocumentLimit: 0` (train all admitted documents). The base
config's article and memory safety limits still apply; they are not claims
that every byte of Wikipedia is admitted.

Source counts, profile signatures, and raw n-gram observation counts are
different measurements. Current Wikipedia training intentionally omits
raw n-gram observation persistence while storing compiled models. An empty
`calibration_observations` table establishes absence of those outcome
records; it does not establish the status of every alignment calibration
artifact. Fluency and accuracy require executed evaluations.

These repairs do not certify exactly-once accumulation across every
partial-block replay or prove language quality. Those require live replay
and held-out evaluation after the empty schema is prepared. No ingestion
is part of this audit/rebuild step.

## Validation performed

- Clean TypeScript rebuild and subsequent `pnpm build`: exit 0.
- Focused recovery/config/CLI tests and the four calibration-tool tests:
  passed. The last recovery/CLI run passed six tests; the zero-document-cap
  config file passed both tests.
- `scce6_runtime` migration and verification: schema version 26, 74/74
  tables, 159 contract checks passed. Source, evidence, model, profile,
  checkpoint and calibration-observation counts remain zero.
- A real PostgreSQL transaction proved that resume finds the completed
  block behind 2,100 newer page checkpoints. Audit fixtures were rolled
  back and the schema's empty state rechecked.
- `pnpm test` completed all 20 unit-test shards but exited 1: six failures
  in three files. Two migration tests hung because their offline fixture
  mocked `pool.connect` but not the direct `pool.query` preflight. The
  fixture is repaired; its seven tests pass and the complete affected
  shard now passes 29 files / 147 tests.
- Four full-suite failures remain: two SQL-shape expectations in
  `postgres-language-memory-ownership.test.ts` and two PDF OCR boundary
  expectations in `fetched-source.test.ts`. The former expect JSON profile
  lookups while the implementation uses `profile_id`; the latter expect
  `ocr_unavailable` while the implementation reports partial OCR at its
  pixel bound. Those paths were not changed to conceal these failures.
- `pnpm eval:validate`: 39 tests passed. The no-hidden-model check passed.
  The source-scannability gate found one raw NUL in an existing blob test;
  it is now the equivalent `\u0000` literal. Its three tests pass and the
  scan reports zero violations across 1,317 files. Test inventory passed.

Logs: `.tmp/scce6-clean-build.log`, `.tmp/scce6-build-final.log`,
`.tmp/scce6-full-tests.log`, `.tmp/scce6-shard18-retest.log`,
`.tmp/scce6-final-gates.log`, `.tmp/scce6-source-scan-final.log`, and
`.tmp/scce6-inventory-final.log`. The original full-suite invocation is
not represented as passing; later checks were run explicitly.

Code changes are limited to `packages/adapters-node/src/{config,postgres,
wikipedia,wikipedia-v3-ingestor}.ts`, `packages/kernel/src/storage.ts`,
`packages/cli/src/{index,wiki-process}.ts`, the calibration fitting tool,
and their named regression/fixture tests. The local config change is
machine-local and ignored by Git. The pre-existing untracked
`tools/shard-compile-scaling.mjs` was inspected but not changed or executed.

## Implementation checkpoint — 2026-09-20

This section supersedes the earlier work-in-progress and outstanding-test
statements above. It does not certify a trained or qualified brain.

- Captured Bonn/Albedo regressions now preserve source quantities and remove
  nested image apparatus correctly. Formatting apostrophes, comparisons,
  entity layers, raw/derivative coordinates, Unicode boundaries, truncated
  bzip2 and invalid UTF-8 have regression coverage. Index entries must match
  decoded page identities; malformed, unordered and empty indexes fail.
- Resume binds the dump/index content hashes, effective semantic settings,
  normalization identity and executed adapter/kernel code identity. Hashing
  streams with a stat-validated cache. Legacy or changed input identities
  cannot reuse a cursor. A committed block at byte zero is distinguished
  from a fresh run. Input changes prevent further durable progress.
- Wikipedia source-version identity includes source ownership, revision and
  coordinate role. Blob hashes still identify exact bytes. Identical pages
  do not share source ownership; unchanged plain text needs no derivative.
- Language shard overflow fails instead of silently completing partial
  training. Training parent IDs are retained in full. Canonical manifests
  bind real input/compiler identities and are persisted as blobs; verification
  errors fail the shard. This is hash/graph validation, not an executed replay.
- Translation compilation resolves learned identity IDs and profile bindings,
  including languages sharing a script. It reads compiled order-two counts
  with a bounded database result when raw observations were omitted. The CLI
  rebuilds identity assignments first. Manually seeded identity fixtures and
  real compiled model envelopes pass an isolated Postgres test; this is not a
  translation-quality evaluation of trained corpora.
- Import counts do not establish publication readiness. New Wikipedia
  candidates remain VALIDATING pending artifact, replay, speech, calibration
  and runtime qualification. Ingestion does not automatically activate them.
- `tools/wikipedia-source-contract.mts` exercised the actual page writer in
  a disposable schema. A graph-write failure rolled back source versions,
  blobs, evidence, graph, checkpoints and events; retry passed. Stored byte
  hashes, evidence byte/codepoint slices, source roles and duplicate-page
  ownership passed. Counts in the checked scce5_runtime tables were unchanged
  (108,589 combined rows); scce6_runtime remained empty. The temporary schema
  was removed. No production-corpus ingestion was performed.
- A parser-only audit read 300 admitted pages from the actual configured
  25,897,924,587-byte yopp dump and its 1,200,881,678-byte plain index, from
  Anarchism (12) through Acoustics (1198). Index/page identity checks passed;
  raw text totalled 20,753,252 bytes and evidence surfaces 8,652,093 bytes.
  No page was clipped and the repaired parser reports zero malformed constructs.
  Unsupported template coverage remains explicit in `.tmp/wiki-parser-audit-300.json`; passing this
  bounded transport/parser check does not certify all template semantics.
- The shared trainer now prepares language and segmentation before opening
  its write transaction, uses an opaque input-bound preparation token, checks
  the graph dependency again before commit, and atomically persists outputs.
  A changed input, failed graph lookup, changed graph slice or model-write
  failure is covered by regression tests. Wikipedia commits its learned
  shard and progress in the same outer transaction. Downstream relation and
  alignment compilation still runs within that transaction.

Remaining: durable canonical shard partitions/leases/contribution deduplication
and interrupted-versus-uninterrupted semantic replay; artifact authority and
publication registry; persisted alignment-series state beyond event tails;
runtime consumption and learned-English gates; multilingual/OSS/Gutenberg
training, independent calibration and the pinned qwen2.5:3b comparison.
Downstream relation/alignment computation still needs further separation. No hours-scale
full-build result or comparative-quality result has been measured.

## Graph refinement and source contract checkpoint — 2026-09-21

The selected source is the full yopp `enwiki-latest-pages-articles-multistream.xml.bz2`,
25,897,924,587 bytes, SHA-256
`27c85ea119806b0819b01e6619ba1d4bfeb94d177eb93ec3dcff7ef0a1ad631b`.
Its plain index is 1,200,881,678 bytes, SHA-256
`0e5de9f7ef1ccf89aa9b059333e7129b59aaf5ef166e55a99bf31993fa671404`.
Both hashes were streamed from the files and checked against stable before/after
file signatures; the source-content audit took 17.6 seconds. The WTG
`multistream1.xml-p1p41242.bz2` shard is not selected. The report
`.tmp/wiki-source-file-identities.json` identifies source content, not a trained artifact.

The final parser repair addresses literal bracket labels in Wikipedia links:
cleanup previously treated mismatched separators inside `[[...|{]]` as empty
syntax and broke a valid link. Links now render before separator cleanup, which
only removes matching empty pairs. The parser regressions passed 24 tests and
the real 300-page audit reports zero introduced malformed constructs.

The disposable PostgreSQL source-contract rehearsal now also exercises the shared
trainer: preparation writes nothing, an injected model-write failure rolls back
source/evidence and additive learned state, the same preparation can retry, and
a second commit of that preparation cannot contribute twice within the process.
All 31 checks passed (`.tmp/wikipedia-source-contract-final.log`). This does not
prove durable crash/replay deduplication. Checked scce5 counts were unchanged,
scce6 remained empty, and the owned temporary schema was removed.

Typed ingestion now attaches a factory-identified graph projection binding to
the existing candidate-specific relation node. It connects candidate, source,
version, exact evidence, producer-captured observation IDs, relation seed,
relation, participants and hyperedge, with admission and model provenance.
The normal Postgres node metadata path persists it. No new bookkeeping graph
nodes or separate database are introduced. Non-observation producers retain an
empty observation-ID list; a reverse surface/frame resolver and full promotion
decision registry remain unfinished.

The production runtime and source-only diagnostic runtime use one shared
`graph-refinement.ts` helper: first field activation, one constrained structural
requirement refinement, then one second activation of the same field engine.
The second pass consumes requirement-conditioned seed priors over the existing
bounded graph slice. Temporal validity, actual activation, joined participants,
causal/contradiction mass and independent source families supply applicability
signals. Incidence projections are not counted as additional relations.
Direct evidence remains available to evidence/proof operators even without graph
relations; refinement uses only evidence linked to activated graph objects.

Only temporal demand, causal demand, inferential depth and source dependence
may change. Explicit requirements, prohibitions, learned ranges, authority,
confidence and unrelated dimensions remain protected. The guard weights are
explicitly uncalibrated bootstrap values. Trace IDs use `IdFactory.artifactId`
over real inputs, guards and outcomes. The new evaluation condition
`no_graph_refinement` retains pass one and bypasses refinement/pass two;
the sealed verifier rejects refinement execution under that condition.

Focused helper, graph support, authority routing and evaluation checks passed
20 tests across four files (`.tmp/graph-sandwich-final-targeted.log`). These
include a real alpha-field test showing that changed requirements change the
second-pass field, deterministic factory IDs, one-refinement bounds, inactive
and unrelated evidence rejection, and preserved authority/proof routing.
`pnpm build` passed (`.tmp/graph-sandwich-final-build.log`). Full regression
validation is tracked separately in `.tmp/graph-sandwich-full-tests.log`.
At this review checkpoint that full run is still in progress. Shard 4 found a
PowerWalk assertion that assumed the final field was the first field. The test
now checks the recorded first-pass PowerWalk seed and its retained second-pass
node separately; that change and the new real-kernel two-pass/ablation test await
the final targeted rerun. The full command is not represented as passing.
This is implementation and regression evidence, not a paper-reproduction,
held-out quality improvement, learned-language qualification, or Qwen result.

### Review follow-up

The feature is named **structural refinement**. Its implementation is
`graph-refinement.ts`, entry point `runGraphRefinement`, trace payload
`graphRefinement`, evaluation component `graph-refinement`, and ablation
`no_graph_refinement`. Historical log filenames above retain their original
names. This review feature has not been released with a compatibility alias.

Contradiction no longer attenuates structural seed visibility. It can raise
source scrutiny while proof/admissibility continues to control assertion.
Weights, seed limits, logit-shift bounds and source-diversity scaling resolve
through the existing public/production calibration mechanism under
`graph_refinement.*`, with declared search ranges. Each turn snapshots and
traces its effective settings and installed override IDs. The trace remains
explicitly uncalibrated: installing numeric overrides alone does not establish
measured quality. The existing field engine's 48-seed capacity remains a hard
upper bound.

Duplicate observations that compile to the same canonical candidate now retain
the sorted union of their actual observation IDs; reversed input order produces
the same ancestry. Binding attachment keeps a direct reference to the relation
node instead of rescanning all accumulated nodes for every candidate.

The original full run completed all 20 shards and exited 1: 558 passed files,
10 skipped files, one failed file; 3,465 passed tests, 14 skipped tests, one failed
PowerWalk assertion. That assertion now checks first-pass PPMI provenance and a
real final-weight difference, allowing ordinary diffusion to reach a node in the
ablated run. The final production-kernel rerun passed all 58 tests. Combined with
the other nine unchanged targeted files, all 126 focused cases have passed.
The final build passed. Logs: `.tmp/graph-refinement-targeted.log`,
`.tmp/graph-refinement-kernel-local-rerun.log`, and
`.tmp/graph-refinement-build-final.log`.

The renamed feature's complete 20-shard run finished with one failure in the
same-size file-rewrite manifest fixture (`.tmp/graph-refinement-full-tests.log`).
An immediate rewrite can retain the same filesystem timestamps. The fixture now
explicitly advances mtime to exercise the stated stat-cache invalidation contract.
This does not make stat equality a proof of content equality: an edit preserving
all exposed metadata requires a fresh content hash to detect. The affected shard
19 rerun passed 28 files / 281 tests, with one skipped file/test
(`.tmp/graph-refinement-shard19.log`). All other shards had already passed.
The evaluation validation (40 tests), hidden-model check, source-text check and
test inventory then passed separately. The original `pnpm test` invocation still
exited 1; the corrected shard and downstream gates were rerun individually.

A synthetic in-process profile of the real field engine plus structural
refinement measured median full/ablated times of 11.77/6.02 ms (16 nodes),
39.42/19.64 ms (64 nodes), and 75.38/38.31 ms (128 nodes), over 20 trials per
condition after warmup. This measures the additional field pass on synthetic
chains, not end-to-end answering, database latency, ingestion throughput or
quality. Raw output: `.tmp/graph-refinement-profile.json`.

### Container deployment checkpoint

The full host unit inventory, replacing only the corrected shard, totals 559
passed files / 3,470 passed tests, with 10 files / 14 tests skipped. Downstream
validation gates passed separately as recorded above.

All four development image targets built successfully. Before the host-first
startup instruction, isolated PostgreSQL and adapter rehearsals passed, the
sealed evaluation kit verified, and the container served the frontend and API
with HTTP 200 responses. Eight Linux adapter test files passed 61 cases with one
skipped case, covering Wikipedia, OSS, multilingual translation, spreadsheets,
visual helpers and sensors. Vitest required a writable-config workaround in the
initial evaluation image; its source ownership is corrected in the Dockerfile.
The revised ownership and 16 GB machine resource limits received static checks
only; Docker was stopped before rebuilding or rerunning them.

Docker Desktop and all task containers are now stopped. Host ingestion, training
and calibration must finish before any Docker services start again. No production
ingestion or database transfer occurred; the seven audited `scce6_runtime` table
counts remain zero. The images are development builds, not qualified brains or
an executed host-to-container handoff. See `docs/CONTAINERS.md` for the required
ordering, memory budget, corpus mounts and remaining restoration checks.

### Durable Wikipedia batch recovery

Bounded stops now journal pending language samples instead of forcing a smaller
training batch. The factory-identified journal commits its cursor and cumulative
counts with learned artifacts. It records a block-local page ordinal, accepts an
incomplete block at its exact compressed offset, and keeps completed cursors
authoritative over older block checkpoints. Replayed prefixes retain their stored
page checkpoints. Explicit rewinds into an existing journal fail closed.

Overflow commits stop before the next page's sample and progress. EOF-only retries
can republish a failed cumulative manifest without learning twice. Operational
resume offsets and stop flags remain provenance rather than canonical content
identity. Historical owner stops do not prevent a successful resumed candidate
from reaching validation. Publication qualification remains pending.

Validation on the host, with Docker off:

- Focused recovery/lifecycle/input-identity checks: 30 passed; workspace build passed.
- Disposable PostgreSQL replay: 26 checks passed, including uninterrupted versus
  bounded/resumed learning and a committed transaction followed by an injected
  lost acknowledgement. Learned rows, additive totals and final manifest identities
  matched. Fresh ingestor instances share the test connection; this does not claim
  an operating-system kill/reconnect test. All three owned schemas were removed.
- Source preservation and transaction rehearsal: 31 checks passed. Audited schema5
  and schema6 counts remained unchanged; schema6 was still empty.
- Full `pnpm test`: exit 0, 559 files / 3,477 tests passed, 10 files / 14 tests
  skipped. The evaluation harness passed 40 tests; hidden-model, source-text and
  inventory checks passed. After the final two recovery regressions were added,
  affected shard 1 passed again: 28 files / 209 tests, with one file/test skipped.

Logs: `.tmp/wikipedia-recovery-full-suite.log`,
`.tmp/wikipedia-recovery-shard1-final.log`,
`.tmp/wikipedia-replay-rehearsal-lost-ack-identity.log`, and
`.tmp/wikipedia-source-contract-final.log`.

`tools/wikipedia-run-report.mjs` provides read-only corpus, training-progress,
source-byte and stage-timing inspection for the following measured ingestion.
Article throughput and learned speech still require that actual run; these
regressions do not establish full-corpus speed, calibration or a Qwen win.

The replay rehearsal subsequently passed 38 checks after adding populated-data
verification with the run report: two pages, four page source versions, two exact
evidence spans, matching journal totals, two committed training documents and
well-formed stage telemetry. Its owned databases were cleaned up before the
measured source run. The first production launcher rejected `--schema=...` before
ingestion; the corrected `--schema scce6_runtime` launch began the authorized
300-page host run. Core code is frozen at `f5fb909d` for this input identity.
