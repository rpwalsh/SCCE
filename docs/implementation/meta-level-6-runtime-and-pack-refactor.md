# SCCE META level 6 runtime and storage refactor

Updated November 10, 2026.

## Outcome

Decompose the existing production turn into cohesive typed components and reduce ingestion amplification without replacing SCCE's cognitive architecture. The existing multilingual ingestion, semantic graph, construction induction, translation, Mouth realization and PostgreSQL durability remain authoritative.

This document records target boundaries and verified implementation status. It does not assert production reachability for unchecked items.

## Constraints

- Keep the Node heap ceiling at exactly 7 GiB (`--max-old-space-size=7168`).
- Treat earlier 10x and 5x figures as capacity context, not deletion gates.
- Preserve PostgreSQL as the durable store. SQL joins are unrelated to the removed language JOIN subsystem.
- Retain qualified learned state, ownership, labels, temporal identity and exact evidence behavior.
- Store exact source bytes once only after bounded reconstruction, authorization, cold-restoration and recovery parity are proved.
- Do not introduce a parallel realizer, translation bridge, language learner, LLM backend or unused activation model.
- Preserve public turn contracts, event order, trace stages and failure behavior after each extraction.

## Existing runtime loop

```text
request
  -> synchronize existing brain/language revision
  -> seed request language, discourse, requirements and authority
  -> bounded retrieval and evidence admission
  -> proof/contradiction and candidate selection
  -> typed construction or exact computation
  -> existing Mouth realization
  -> certification and answer-ready emission
  -> atomic settlement and bounded maintenance
```

`production-turn-runtime.ts` remains the orchestrator. Extracted modules are direct delegates from that production path, not a second runtime.

## Storage rule

Classify each persisted field by both information origin and persistence role before changing it:

- canonical source, source-derived materialization, fitted state, correction or operational state;
- canonical truth, required selector, reusable cache, audit/recovery state or unqualified state.

The kernel needs the bounded records required by a specific operation. It does not require every expanded source-derived view to be fetched or rewritten for every operation. Reconstruction is acceptable only when the canonical owner, dependency identity, authorization, decoded-work bound and cold behavior are explicit.

## Existing language and translation behavior

Language competence continues to come from SCCE's existing n-gram, unit, pattern, semantic-frame and learned-construction records. Translation continues through the existing source-language interpretation, typed meaning and target-language construction/realization paths. Multilingual Wikipedia or other configured corpora feed those paths through the existing ingestors.

Independently distributable language, code or SDK artifacts remain a future packaging task. They must serialize the existing learned structures and prove cold parity before production use. No standalone pack schema or activation record is retained by this tranche.

## Checklist

### Runtime decomposition

- [x] Extract realization-contract helpers behind the existing façade.
- [x] Extract dialogue preselection/adjustment helpers behind the existing façade.
- [x] Extract pure construct assembly.
- [x] Extract the exact-computation terminal branch with event/result characterization.
- [ ] Extract retrieval, proof, candidate adjudication, realization and settlement in behavior-preserving tranches.
- [ ] Pin durable event equality, replay, progress-frame and one-replan invariants across every moved stage.
- [ ] Reduce the final orchestrator to typed phase transitions after the effectful boundaries are characterized.

### Ingestor and durable storage

- [x] Add the signal/dependency ledger before choosing more layouts.
- [x] Replace growing graph-evidence array rewrites for new schema-36 writes with transactional indexed associations.
- [x] Add bounded direct membership and bidirectional page APIs with explicit coverage.
- [x] Enforce evidence existence and information-label joins before new graph parent/association publication.
- [x] Backfill legacy graph memberships and parent labels transactionally, require the migration generation at startup, and migrate executable lookup consumers to association-backed reads.
- [ ] Remove legacy graph-array columns and indexes only after the mixed-version maintenance window and exact export/recovery behavior are qualified.
- [x] Add the bounded `prediction_scoring` storage/hydration view.
- [ ] Route a measured production prediction/scoring consumer through that view before claiming runtime savings.
- [x] Extract bounded deterministic source-derived unit/frame reconstruction helpers and receipts.
- [ ] Persist the factoring contract and prove full public-record/cold-read parity before deleting materialized fields.
- [x] Publish source-observed creative speech grammar from ordinary evidence-owned training input.
- [ ] Publish and qualify creative compatibility state and end-to-end request/reply behavior.
- [x] Keep canonical Wikipedia evidence while excluding gallery filenames/syntax from prose induction through a coordinate-preserving role projection.
- [ ] Extend role qualification to tables, reference apparatus and malformed markup without deleting legitimate evidence.
- [x] Define bounded verified evidence references and manifest resolution as a prerequisite contract.
- [ ] Integrate those references into PostgreSQL and a real cold resolver before removing duplicated evidence text or blobs.

### Measurement and release

- [x] Reproduce the graph association write-amplification benchmark with exact membership and cleanup checks.
- [ ] Run a fresh integrated schema-36 ingestion with source hashes, schema baseline, relation/index/TOAST allocation, WAL, temporary/peak disk, heap/RSS and latency.
- [ ] Prove cold restart, interruption/resume, revocation, authorization and injected transaction rollback.
- [ ] Report the measured whole-product amplification as an outcome; do not sum isolated savings.
- [ ] Run the full build, unit shards, sealed evaluation, structural checks and reachability gate before release.

### Independent artifact packaging

- [ ] Identify the exact existing learned records required for a detached natural-language runtime.
- [ ] Package those records without a second language/translation model or copied corpus bodies.
- [ ] Prove unchanged multilingual interpretation, target-language realization and cold restoration.
- [ ] Repeat from existing code-learning and exact SDK/API structures only after their production consumers are characterized.

## Completion definition

This work is complete only when production paths use the extracted components and operation-specific views, avoid the qualified redundant writes/materializations, retain all required cognitive and security behavior after cold restart, and have an integrated storage/write/read/memory receipt. A design document, unused interface, isolated benchmark or arbitrary ratio is not completion.
