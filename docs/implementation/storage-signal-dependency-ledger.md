# SCCE storage signal and dependency ledger

Updated November 10, 2026. This ledger implements the two-axis inventory required by the storage-collapse brief. It is a routing document for code and qualification, not permission to delete a family.

## Evidence boundary

The checkout inspected for this ledger is commit `e00f7cb10140b3d874641d58df578cce3470dfd6` plus concurrent schema-36 refactor work. No integrated production ingestion was run for this candidate. The synthetic PostgreSQL association benchmark was independently executed; `tools/lib/source-graph-replay.mjs`, `tools/lib/language-consumption-probe.mjs`, and `packages/adapters-node/src/__tests__/postgres-unit-evidence-live.test.ts` remain absent.

Evidence labels used below:

- **C** — directly established from current checkout code/schema.
- **E** — independently executed in this checkout with a pinned receipt.
- **R** — checked-in receipt/checkpoint claim; not rerun while preparing this ledger.
- **S** — result supplied in the November 10 storage-collapse brief; not independently reproduced here.
- **P** — proposed or unqualified implementation/behavior.

These labels must remain attached when values are copied into later reports.

## Measurement register

| Label | Cohort / scope | Result | What it does not establish |
| --- | --- | --- | --- |
| R1 | Schema-35 four-source Dolly checkpoint in `docs/implementation/scce-product-status.md` | 369,050 admitted bytes; 13,320,192 B application growth; 36.093x growth; 16,564,224 B total allocation including 3,244,032 B empty schema. Growth: patterns ~6.980 MB, evidence ~1.720 MB, units ~1.606 MB, creative occurrences ~1.245 MB, blobs ~0.565 MB, n-grams ~0.467 MB, other ~0.737 MB. Graph rows were zero. | Wikipedia slope, graph cost, current dirty-tree behavior, or a full consumer installation. |
| S1 | One real Honey bee article through the production Wikipedia ingestor | 48,503 normalized bytes; 6,053,888 B growth over a 3,244,032 B empty schema (~124.81x). Graph nodes 1,376,256 B, patterns 950,272 B, edges 827,392 B, evidence 671,744 B, units 507,904 B, relation observations 368,640 B, creative occurrences 188,416 B, blobs 172,032 B, n-grams 163,840 B. | A marginal/full-corpus ratio. This was supplied, not rerun here. |
| S2 | Same Honey bee public language payload, operation-scoped consumption probe | Full input 20,932,193 decoded JSON bytes: n-grams 862,416; units 401,143; 29 full patterns 19,321,825; frames 50,386. Request-seed patterns were 862,946 B. A probe-specific 1,157,035 B view preserved the tested prediction/scoring/realization/generation behavior but changed coverage/audit. | Capability-wide equivalence or database savings. Family-removal results are scoped ablations only. |
| S3 | Three-source acquisition-only graph replay | 141,817 normalized bytes, 5,252 recipe bytes, 3,949,818 B expanded graph JSON; complete stored node/edge/hyperedge comparison matched in original contribution order. Reverse order changed eight nodes. | Production storage integration, all queries, learned overlays, or end-to-end language behavior. |
| S4 | Synthetic indexed shared-node evidence test, 256 contributors x 8 IDs | Array WAL 48,991,496 B versus association WAL 1,219,704 B; 263,168 cumulative array entries processed versus 2,048 association inserts; membership matched. | Final live-storage ratio or inference latency. WAL can include cluster activity. |
| E1 | Independently executed PostgreSQL 16 association benchmark, 256 contributors x 8 IDs | 263,168 array entries processed versus 2,048 association inserts; 43,503,480 versus 1,217,648 B WAL; 1,529.73 versus 75.52 ms; pre-maintenance allocation 23,486,464 versus 868,352 B; after `VACUUM FULL`, 573,440 versus 696,320 B. Membership matched and disposable schemas were removed. Receipt SHA-256: `9B79092CA5BA3F4A8FBE46E2CB2FFE7F75B31FF8AD6450D815B536C993B429CA`. | A compact live-size win, production inference latency, or an integrated ingestor ratio. The post-maintenance association layout was larger in this cohort. |

## Family ledger

### Canonical source revisions, blobs, and evidence text

- **Information origin:** canonical source plus deterministic normalization/segmentation; trust, access, admission, and provenance are operational/governance state.
- **Persistence role:** canonical truth for `blobs`/`source_versions`; selector/access projection plus exact evidence for `evidence_spans`.
- **Writers (C):** Wikipedia writes original and normalized blob/source versions at `packages/adapters-node/src/wikipedia-v3-ingestor.ts:1171-1177`, then admitted/quarantined spans at `:1245-1266`. General training repeats the original/normalized/archive writes at `packages/adapters-node/src/language-corpus-trainer.ts:1345-1356`. PostgreSQL span publication is `packages/adapters-node/src/postgres.ts:1931-2025`.
- **Durable shape (C):** `blobs.content` owns exact bytes, `source_versions` binds a content hash, and every `evidence_spans` row also stores `text_preview` and full `text_content` with ranges, hashes, provenance, features, status, alpha, and label (`packages/adapters-node/src/postgres-schema.ts:277-294`).
- **Consumers/views (C):** exact evidence APIs at `packages/adapters-node/src/postgres.ts:1479-1930`; graph/language hydration resolves evidence through `getEvidenceBatch`, including construction evidence at `packages/kernel/src/surface-language-runtime.ts:546-555` and `:1405-1410`.
- **Ownership/policy/dependencies:** source/version foreign identity, content hash, information label, trust/admission status, transform/normalization identity, and temporal source version. Authorization must precede text reconstruction/caching.
- **Bytes/evidence:** S1 found twelve spans containing all 48,503 normalized bytes inline and fourteen blobs consistent with original, normalized, and chunk bodies. S1 also reports 8,640 feature entries and a 409,600 B feature GIN. R1 attributes ~1.720 MB growth to evidence and ~0.565 MB to blobs in a graph-free cohort.
- **Duplicate owner:** canonical bytes already exist in `blobs`; full span text is a materialized range copy. Preview and generated narrow columns are selector projections, not separate truth.
- **Reconstruction/ablation:** S1 demonstrates the duplication, not integrated removal. The uncommitted `packages/kernel/src/evidence-ref.ts` defines compact refs plus one source manifest, but no production PostgreSQL writer/reader uses it yet (P).
- **Disposition:** **retain once + normalize.** Keep the chosen offline-capable canonical representations explicitly; migrate span bodies to verified ranges only after exact UTF-8/read/access/cold-restart parity. Keep bounded previews/selector fields only when measured query paths need them. Audit markup roles before training so filenames/gallery/table apparatus do not become prose priors.
- **Untested:** complete proof/Mouth consumers, revocation, visual evidence, original-wikitext policy, migration/recovery, physical savings, and fresh/warm reconstruction latency.

### Graph evidence membership

- **Information origin:** source-derived observation membership plus source-family/ownership policy; association itself is not a fitted graph body.
- **Persistence role:** required bidirectional selector/provenance projection and proof support.
- **Writers (C):** both Wikipedia graph producers publish through `upsertNodes/Edges/Hyperedges` at `packages/adapters-node/src/wikipedia-v3-ingestor.ts:1271-1310` and promoted graph at `:1541-1547`; general training also writes at `packages/adapters-node/src/language-corpus-trainer.ts:1368-1370`. Schema-36 PostgreSQL writes verify every referenced evidence row and source version, join both information labels into the parent, publish the parent with an empty legacy array, and insert ordered associations with `ON CONFLICT DO NOTHING` in the same transaction. Later evidence/source-version label tightening propagates to associated parents in the dependency transaction; unchanged labels and parents are not rewritten.
- **Readers (C):** evidence-bound graph selection uses the reverse association index. Public graph records merge legacy arrays with association rows in stable order. New direct-membership and bounded owner-to-evidence/evidence-to-owner pages expose explicit coverage and decoded-byte limits. Existing direct consumers of complete `evidenceIds` include coverage/replan, scoring, audit, planning/proof and local evidence matching.
- **Ownership/policy/dependencies:** graph object ID/kind; evidence ID and its source/version/family; joined information labels; contribution order; graph snapshot generation. A page must state `complete`, `partial`, or `scoped`, with continuation/count semantics. Partial data cannot prove absence.
- **Bytes/evidence:** S4 and E1 establish the quadratic cumulative rewrite mechanism and the association write/WAL improvement. E1 does not establish a smaller compacted live layout. S1 reports shared nodes with 12/13 IDs across two real articles and 1,376,256 B node plus 827,392 B edge growth.
- **Duplicate owner:** membership is final `O(kN)` information; rewriting the full accumulated array per contribution produces `kN(N+1)/2` cumulative entries and GIN/TOAST churn.
- **Reconstruction/ablation:** E1 checked exact membership at every cohort. Schema-36 adapter tests cover all three graph kinds, both page directions, direct membership, partial coverage, missing evidence and disallowed label joins. A disposable live PostgreSQL qualification exercises legacy array backfill, migration-marker rejection/upgrade, label tightening from both evidence and source versions, bounded reads, cold reopen and access hiding. Repo-wide review found no remaining executable direct graph-array lookup; non-executed planner/audit SQL metadata remains separately identifiable.
- **Disposition:** **partially normalized.** Keep schema-36 association publication, generation-v2 migration and bounded readers. Legacy array columns and indexes remain only for migrated-record compatibility until their mixed-version/export/recovery window is qualified.
- **Untested:** stable snapshot totals across pages, contradiction/corroboration completeness under partial coverage, mixed-version deployment, concurrent correction/revocation contention, cache invalidation, legacy-column removal, and integrated ingestion disk/WAL.

### Source-derived graph bodies and searchable projections

- **Information origin:** deterministic source-derived definitions/observations from `createTypedIngestProjector` and `createSourceGraphBuilder`; merge fields also include ordered aggregate and possible learned overlays.
- **Persistence role:** current canonical runtime graph rows plus required selector headers/adjacency indexes; candidate future role is recipe + searchable projection + learned overlay.
- **Writers (C):** producer and write paths are the same Wikipedia/general-training paths listed above. Current tables store full `representation_json`, metadata/qualifiers/modality/weight vectors, temporal fields, features, evidence, labels, and adjacency identities (`packages/adapters-node/src/postgres-schema.ts:297-304`).
- **Readers (C):** bounded slice/temporal/alpha methods at `packages/adapters-node/src/postgres.ts:2051-2180`; runtime caches and source-anchor selection at `packages/kernel/src/runtime-graph-retrieval.ts:180-749`; broad proof/planning consumers receive reconstructed `GraphNode/GraphEdge/Hyperedge` values.
- **Ownership/policy/dependencies:** stable external semantic ID is not a body hash; ordered source contributions, exact producer/compiler identity, source/profile/evidence dependencies, joined labels, temporal state, and overlay generation all matter.
- **Bytes/evidence:** S1 physical graph growth is above. S3 reports 5,252 recipe bytes versus 3,949,818 B expanded JSON and exact three-source stored-row parity only in original contribution order. The isolated searchable-header prototype saved ~49.5% (S).
- **Duplicate owner:** pure source fields may be replayable; merged/learned fields are not automatically derivable from the latest source. First-representation and maximum/union/metadata semantics make order material.
- **Reconstruction/ablation:** S3 is exact for tested graph rows, with a useful reverse-order failing control. The replay tool is absent here, and no production selector/runtime integration exists (P).
- **Disposition:** **retain current rows until parity, then reconstruct/cache.** Capture versioned recipes at the producer seam, retain bounded searchable headers/postings and ordered contribution log, and keep learned overlays. Select and authorize before body replay.
- **Untested:** ranking/ties/limits, temporal slices, alpha materialization, population iteration, authorization, no-op updates, new learned fields, snapshot concurrency, cold source I/O, and cache cost.

### Full-order n-gram models and observations

- **Information origin:** fitted sufficient statistics/decision from admitted language text; raw observations are recomputable inputs when retained.
- **Persistence role:** models are runtime language truth; observations are learning/recovery/global-update state depending on producer configuration.
- **Writers (C):** trainer publishes observations/models at `packages/adapters-node/src/language-corpus-trainer.ts:1402-1404`; batch codecs are `packages/adapters-node/src/postgres.ts:5561-5608`. Tables preserve `order_n`, histories, `max_order`, discount, and `model_json` (`packages/adapters-node/src/postgres-schema.ts:376-379`).
- **Readers/views (C):** `listNgramModels` and `surface-language-runtime.ts` implement the named `prediction_scoring` view with a 48 MiB n-gram budget inside a 64 MiB aggregate operation contract. Ordinary/request-seed reads and training/learned-code paths remain separate. `language-memory-runtime.ts` materializes Kneser-Ney runtime models.
- **Ownership/policy/dependencies:** exact language/profile/source owner, corpus/source system, label, model order, discount, vocabulary, compiler/runtime identity, and compatible population semantics. Per-source models cannot be independently summed as though they were one Kneser-Ney fit.
- **Bytes/evidence:** R1 ~0.467 MB physical growth; S1 163,840 B; S2 one public model was 862,416 decoded bytes and removing n-grams changed probe behavior (positive causal result).
- **Duplicate owner:** current hydration has historically retained serialized `modelJson` plus materialized runtime maps; this is a memory duplicate, not evidence that learned counts are disposable.
- **Reconstruction/ablation:** S2 establishes necessity for probed operations. Full-order parity is mandatory; bigram-only substitution is rejected. Concurrent uncommitted pack/runtime work is not yet an integrated storage qualification (P).
- **Disposition:** **retain exact sufficient state once.** Preserve 4/5/6-gram order where trained, shard/page it deterministically, hydrate a single materialized owner, and separate recomputable replay tapes from required counts. Measure heap/RSS per model family.
- **Untested:** all model orders/languages, population selection, cold paging, update/consolidation, exact prediction/generation parity, and integrated disk.

### Language units

- **Information origin:** mostly source/profile/evidence-derived materialization; alpha/competence/features may participate in runtime scoring.
- **Persistence role:** current selector and hydrated runtime input.
- **Writers (C):** `packages/adapters-node/src/language-corpus-trainer.ts:1416-1417`; PostgreSQL batch at `packages/adapters-node/src/postgres.ts:5609-5667`; table fields at `packages/adapters-node/src/postgres-schema.ts:386`.
- **Readers/views (C):** `listLanguageUnits` implements a minimal-field `prediction_scoring` projection with an 8 MiB decoded budget; `language-memory-runtime.ts` consumes the result for scoring/competence. Ordinary reads retain complete records.
- **Ownership/policy/dependencies:** profile/source version, evidence set, label, script/kind, compiler identity, source system, and selected snapshot.
- **Bytes/evidence:** R1 ~1.606 MB physical; S1 reports 200 rows, 920 B text, 168,000 B repeated evidence arrays, 507,904 B growth. The supplied shared-evidence experiment saved 81,920 B final allocation (~0.88%). S2 units were 401,143 decoded bytes.
- **Duplicate owner:** S1/S2 reconstructed the 200 core rows from source/profile/evidence/compiler state; per-row owner/evidence/metadata envelopes repeat shared information.
- **Reconstruction/ablation:** S2 reports exact core reconstruction and no tested behavior/audit change when unit features/vectors/metadata were omitted from that consumer input; removing units entirely changed behavior. The new bounded deterministic helper reproduces unit/frame compiler output and a digest-bound receipt, but it is not a durable PostgreSQL or cold-restoration path. This is operation-scoped, not global deletion authority.
- **Disposition:** **normalize owner envelopes + operation-specific view.** Keep minimal identity/text/statistics required for prediction/scoring; factor shared owner/evidence/label state once; reconstruct heavier source-derived fields only for consumers proven to need them.
- **Untested:** language scoping, proof, structured generation, translation, unknown metadata consumers, update/delete lifecycle, access, and physical integrated saving.

### Language patterns, including full DAG, semantic/syntax/morphology, and constructions

- **Information origin:** mixed: source-derived witnesses/recipes; fitted learned rules/energies/decisions; audit/compilation receipts; generated creative candidates.
- **Persistence role:** full generative/proof bodies, request selectors, audit/recovery, and currently some unqualified material share one table.
- **Writers (C):** metadata and learned patterns at `packages/adapters-node/src/language-corpus-trainer.ts:1399-1433`; generic publication at `packages/adapters-node/src/postgres.ts:5668-5726`. Current rows include full `pattern_json`, evidence arrays, label, and generated selection headers (`packages/adapters-node/src/postgres-schema.ts:387-392`).
- **Readers/views (C):** `listLanguagePatterns` supports the existing `request_seed` view and the new `prediction_scoring` view. Prediction/scoring excludes known heavy construction, creative, reversible, paired, compatibility and null schemas before body hydration and has a 4 MiB pattern budget. Full-ID reads still drive source construction/realization, contextual QA, source computation, code paths and creative decoding.
- **Ownership/policy/dependencies:** pattern family/schema, profile/source/evidence owners, labels, compiler/implementation and source-compilation digests, selected graph/model snapshot, learned versus replayable field classification.
- **Bytes/evidence:** R1 ~6.980 MB physical in four graph-free sources. S1 950,272 B. S2 full 29-row input was 19,321,825 decoded bytes versus 862,946 B request seed; creative bundles (12,285,468 B) plus induced semantic memory (6,392,009 B) were ~96.7% of full decoded pattern bytes. Checked-in older receipts about full-DAG witnesses are not added to S1/S2 as an integrated saving.
- **Duplicate owner:** arbitrary `pattern_json` repeats source compilation/version/ranges and may contain reconstructable sentences/symbol arrays; other energies, lexical classes, decisions, typed slots, constraints, and witness coordinates are genuine learned state.
- **Reconstruction/ablation:** S2 family removals preserved only the probed prediction/scoring/realization/generation outputs while changing coverage/audit. Request-seed projection is already a real capability-specific view. Supplied semantic source-coordinate replay reconstructed four tested projections exactly and saved 16.7% in an isolated layout (S).
- **Disposition:** **split typed headers from bodies; reconstruct/cache by capability.** Preserve full-order learned values, exact source coordinates/dependencies, and full/read-seed semantics. Never copy arbitrary pattern JSON into a new format or delete a family because one probe missed it. Unknown schema fails closed.
- **Untested:** typed semantic binding, proof/contradiction, invention, source-owned realization, full creative route, every pattern schema, semantic replay at scale, access/cold restore, and physical integrated saving.

### Semantic frames

- **Information origin:** source-derived summary/vector plus provenance; some schemas may carry learned request surfaces/coefficients.
- **Persistence role:** current hydrated coverage/scoring inventory, surface lookup/fallback, translation/planning input.
- **Writers (C):** `packages/adapters-node/src/language-corpus-trainer.ts:1432-1433`; PostgreSQL batch at `packages/adapters-node/src/postgres.ts:5727-5766`; durable fields at `packages/adapters-node/src/postgres-schema.ts:393-394`.
- **Readers/views (C):** `listSemanticFrames` implements a recognized surface/coefficient header projection for `prediction_scoring` with a 4 MiB frame budget. Request/full hydration, explicit surface/fallback queries and existing planning/translation consumers remain separate.
- **Ownership/policy/dependencies:** profile/source/evidence identity, label, frame schema, vector precision, compiler identity, and requested operation.
- **Bytes/evidence:** S2 twelve rows were 50,386 decoded bytes. Their non-vector core reconstructed from canonical inputs and vector values matched PostgreSQL float32 precision. Removing frames did not change the probed behavior but did change audit/coverage; count contributed ~0.370044 semantic-frame coverage.
- **Duplicate owner/schema issue:** sampled rows used preview/feature/role summaries; `semanticFrameSurfaces()` recognized no surfaces, while broader fallback traversal may still read preview. Count is not proof of executable semantics.
- **Reconstruction/ablation:** S2 minimal identity/owner headers preserved the tested raw outputs. The synthetic recognized-surface positive control changed behavior, proving schema content—not row count—matters.
- **Disposition:** **retain headers; repair schema routing; reconstruct/cache source-derived bodies.** Separate qualified surface/coefficient capability from count-derived coverage before deleting or compacting bodies.
- **Untested:** Mouth fallback, translation, planner, qualified semantic-surface publication, access/revocation, precision/cold replay, and physical saving.

### Creative constructions and occurrence pages

- **Information origin:** mixed learned templates/compatibility parameters, observed witness coordinates, and generated candidate combinations.
- **Persistence role:** generative body and witness/compatibility state; occurrence pages are reusable materializations when qualified.
- **Writers (C):** language pattern publication invokes the canonical creative codec at `packages/adapters-node/src/postgres.ts:5668-5726`; normalization/page records are in `packages/adapters-node/src/creative-event-normalization.ts:173-260` and `canonical-creative-event-store.ts:37-220`.
- **Readers/views (C):** codec decode paths at `packages/adapters-node/src/postgres.ts:1143-1205,5486`; hydration builds imported construction/creative bundles and compatibility state in `packages/kernel/src/language-memory-runtime.ts:604-623`.
- **Ownership/policy/dependencies:** source-observed utterance/evidence owner, template/lexeme/witness identity, compatibility model, request grammar, label, and compiler/snapshot generation.
- **Bytes/evidence:** R1 ~1.245 MB physical; S1 188,416 B. S2 creative pattern bodies were 12,285,468 decoded bytes. The repaired focused compiler regression publishes source speech for 423/423 declared transcript events as three patterns: 15,843 durable JSON bytes and 2,557,044 decoded hydrated bytes. It still publishes zero event pages and zero compatibility models for that cohort.
- **Duplicate owner:** expanded event/candidate combinations may be derivable from compact templates + learned parameters + observed witness coordinates; observed facts and generated candidates must remain distinct.
- **Reconstruction/ablation:** S2 removing creative bodies did not affect the basic probes, but the intended route was not qualified. Source-observed speech publication is now covered; request/reply compatibility and executable creative generation are not. Existing normalized storage is evidence of factoring work, not proof of end-to-end language capability.
- **Disposition:** **finish compatibility qualification before compaction claims; then materialize selected candidates only.** Retain compact genuine learned parameters and witnessed coordinates; do not treat event count as competence or delete dormant state without route coverage.
- **Untested:** compatibility gates, invention, source authority, access, cold reconstruction, candidate limits, and integrated storage/write savings.

### Relation observations and global promotion state

- **Information origin:** learned observations keyed by relation seed, channel, source family, signature, candidate/source, and time.
- **Persistence role:** corpus-wide null/background distribution, negative controls, family-disjoint fit/holdout partitioning, and promotion decisions.
- **Writers (C):** Wikipedia appends observations atomically before language/graph publication at `packages/adapters-node/src/wikipedia-v3-ingestor.ts:1532-1534`; generic ingestion does the same at `packages/kernel/src/ingestion-runtime.ts:692-694`; PostgreSQL `ON CONFLICT DO NOTHING` store is `packages/adapters-node/src/postgres.ts:2675-2686`.
- **Readers/views (C):** `priorRelationObservations()` first checks indexed per-seed family counts, then can call unbounded `store.list({})` because the fitter uses the global population (`packages/adapters-node/src/wikipedia-v3-ingestor.ts:1034-1055`). Store list is ordered but unbounded unless explicitly limited (`packages/adapters-node/src/postgres.ts:2687-2720`). `compileRelationPromotionModel` consumes this state at Wikipedia `:1473-1488`.
- **Ownership/policy/dependencies:** source-family identity (Wikipedia must not become one independent family per article), channel, complete qualified generation, partition algorithm/version, negative controls, input snapshot and ordering.
- **Bytes/evidence:** S1 reports 368,640 B growth. Current code comments record a prior live case where 172k observations were reread and throughput fell from 576 to 85 sources/hour before the seed-family precheck; this comment is diagnostic history, not a fresh measurement.
- **Duplicate owner:** raw observations may be replaceable only by exact versioned sufficient statistics that reproduce global background, per-seed state, family partitions, controls, and selection. A current-seed-only filter is semantically wrong.
- **Reconstruction/ablation:** no qualified sufficient-state replacement exists in this checkout.
- **Disposition:** **append observations now; design qualified immutable consolidation generations.** Requests/ingestion should read a published generation rather than refit/scan the corpus, but raw history cannot be dropped until varied-cohort equivalence including holdout membership is proved.
- **Untested:** incremental updates, source-family partition changes, corrections/removals, negative controls, concurrency/atomic publication, and disk/latency.

### Search indexes, generated headers, caches, and operational state

- **Information origin:** source-derived selector material or operational state, not independent knowledge.
- **Persistence role:** required bounded-latency projection, snapshot/checkpoint, or disposable cache.
- **Current examples (C):** evidence feature/title/kind generated projections and GIN (`postgres-schema.ts:294-296,546+`), language-pattern generated selection headers (`:389-392`), graph adjacency/evidence indexes, ingestion checkpoints, and bounded in-process graph cache (`packages/kernel/src/runtime-graph-retrieval.ts:180-400`).
- **Ownership/policy/dependencies:** canonical owner hash/version, implementation and index generation, information label/access scope, cache epoch, and current source/dependency revision.
- **Bytes/evidence:** every R1/S1 physical table value includes indexes for that relation; do not add TOAST/index figures again. S1 specifically attributes 409,600 B to the evidence feature GIN. No complete per-index current measurement was rerun here.
- **Duplicate owner:** selectors are derivable but can be necessary for bounded latency; cache bodies are disposable only when exact generation/access invalidation exists.
- **Disposition:** **retain measured selectors, version them, evict reconstructed caches.** Do not call a required posting “noise” merely because it is derivable. Include WAL, temp, peak disk, and rebuild cost in product accounting.
- **Untested:** complete index/query coverage after association migration, stable snapshot cursors, cache revocation/ownership changes, rebuild interruption, and full physical budget.

## Immediate implementation cuts

1. **Graph association cut (partial):** schema-36 new writes, reverse selection, bounded membership/page APIs, transactional legacy backfill/label tightening, startup generation verification and executable-consumer migration are implemented and live-qualified on a disposable schema. Legacy columns/indexes remain pending mixed-version/export/recovery qualification and integrated storage measurement.
2. **Canonical evidence cut (prerequisite only):** bounded manifest/range-ref validation and resolution are tested in the kernel. Integrate them with PostgreSQL and a real cold resolver; prove exact text/coordinate/access parity before removing `text_content` or chunk blobs.
3. **Prediction/scoring language view (implemented, not production-routed):** the named 64 MiB aggregate view separates required inventory from heavy bodies. Route a measured production consumer through it before claiming runtime or storage savings.
4. **Unit/frame owner factoring (prerequisite only):** bounded deterministic derivation and receipts are implemented. Durable owner factoring, public-record reconstruction and cold restoration remain.
5. **Pattern body paging:** close each eligible pattern schema and page typed learned state/source coordinates; unknown schemas stay on the current representation. Do not recursively “strip” arbitrary JSON.
6. **Creative repair before compaction claim (partial):** source-observed speech grammar publication is implemented. Compatibility models and actual request/reply generation remain unqualified.
7. **Relation consolidation generation:** derive and qualify the exact global sufficient state on varied family cohorts before changing `priorRelationObservations()` or deleting raw rows.
8. **Integrated measurement:** only after cuts 1-7, run fresh production ingestion with source hashes, checkpoints, complete before/after allocation, WAL/temp/peak disk, heap/RSS, request latency, cold restart, access/atomicity failures, and explicit skips. Report amplification as the result, not the selection rule.

## Non-conclusions

- The 5x capacity figure is not a signal definition or deletion gate.
- A field being source-derived, repeated, or unused by one probe does not make it dispensable.
- Request-seed parity is not full generation/proof parity.
- Graph replay parity is contribution-order and implementation dependent.
- Count-derived coverage is not qualified semantic or creative capability.
- Compression, VACUUM, index removal, or a larger heap does not repair an incorrect durable model.
