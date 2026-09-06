# Cognitive Architecture Acceptance Suite

The finish gate for SCCE, defined as behaviour rather than as a checklist of files. Each entry states what must be
proved, the pass condition, and — honestly — what covers it today. "Covered" means a test or tool that would fail if the
behaviour regressed. "Partial" means the mechanism is exercised but not end to end. "Not covered" means exactly that.

This document is the specification. Nothing here is claimed to pass because it is written down.

## Why not "beats BM25"

A retrieval baseline is a component-level comparison, not a finish gate. SCCE's sealed result is
166/168 against 158/168, and the honest reading of it is that the two systems tie at 158 on cloze recall while all eight
points of margin come from declining questions the corpus cannot answer. That is one property, measured. It says
nothing about whether the architecture functions as an architecture. These twenty do.

## The three gates

| Gate | Question it answers | Status |
|---|---|---|
| **Architecture Complete** | Is the cognitive spine coherently connected end to end — state, evidence, learning, planning, realization, tools? | In progress |
| **Engineering Complete** | Does it survive persistence, recovery, idempotency, resource bounds, migration and reproducible builds? | Not started as a gate |
| **Acquisition Ready** | Provenance, IP/SBOM, reproducible build, independent operation, ablation evidence, clean data room | Partially met |

Acquisition Ready is not downstream of the other two. An asset can transfer while parts of it are unfinished, provided
what is unfinished is stated. That is the posture this repository takes everywhere.

---

## Gate 1 — Architecture Complete

### 1. Cold-start cognition
Empty cognitive state, previously unseen but structurally simple task. Interpret, establish requirements, retrieve or
acquire, construct meaning, reason, answer, trace, persist.
**Pass:** one complete turn with no hidden model, no manual intervention, no special-case fixture.
**Today:** partial. `tools/live-adapter-rehearsal.mjs` runs ingest → promote → answer against a disposable schema and
passes every check except `adapter.answer`, where a two-document fixture reads as contradictory and the turn abstains
with a citation in hand. Whether that is correct behaviour or a miscalibrated contradiction threshold is unresolved.

### 2. Multi-turn accumulation
Teach A, teach B, ask about A+B, add C that changes the relationship, ask again.
**Pass:** the later answer depends on durable prior cognitive state, not on replaying the conversation.
**Today:** partial. Durable cross-turn state is real and tested per subsystem (`task-resumption-turn-request.test.ts`,
`user-model-turn-request.test.ts`, dialogue memory), but no test drives the five-step accumulation above as one story.

### 3. Contradiction handling
Source 1 says X, source 2 says not-X, across equal authority, differing authority, newer versus older, direct versus
inferred, and subtle incompatibility.
**Pass:** provenance and contradiction survive into the cognitive state and the answer; the contradiction is not
silently collapsed.
**Today:** partial. Contradiction mass, `exposeContradiction` and temporal supersession exist and are unit-tested; the
five-variant matrix is not.

### 4. Evidence-bound inference
A → B, B → C, does A imply C, and on what basis. Then remove B → C.
**Pass:** it derives the relation and names the premises; after removal it refuses to certify C.
**Today:** partial. `semantic-proof-engine.ts` certifies or refuses on exactly this shape and is unit-tested; the
remove-a-premise half is not driven through a live turn.

### 5. Unknown and abstention
Unknown entity, known entity with unknown property, plausible but unsupported inference, conflicting evidence,
malformed premise.
**Pass:** known → inferred → unsupported → contradicted → unknown remain distinguishable rather than collapsing into
fluent prose.
**Today:** covered for the abstention case (8/8 sealed probes, `prose-media-not-source-code.test.ts` for the
silence-with-evidence boundary). The five-way distinction is not tested as a matrix.

### 6. Learning survives restart
Unknown → ingest → known → restart → still known → related material → relationship answerable.
**Pass:** learning becomes durable cognitive state, not process state.
**Today:** partial. Durability is proven per store; the before/after/restart sequence is not one test.

### 7. Self-correction
Induce insufficient evidence, a failed candidate, a realization failure, a retrieval miss, contradictory evidence.
**Pass:** the failure category is diagnosed, the bounded repair path runs, it replans and either succeeds or fails for a
stated reason. Not "retry everything".
**Today:** partial, and improved 2026-09-05: a turn that admitted evidence and realized nothing is now a mouth-surface
failure that triggers the bounded replan, with abstention and creative turns exempt. The other four induced failures
are not driven as tests.

### 8. Tool-use closed loop
Need → capability selection → authorization → dispatch → result → interpretation → cognition → answer → durable
receipt. Then a tool failure. Then an unauthorized mutation.
**Pass:** the right tool is chosen, policy can deny it, denial enters cognition, results become state, outcomes are
traceable, no unauthorized side effect occurs.
**Today:** partial. Executive dispatch, durable receipts and rollback are tested (`postgres-executive-dispatcher-durability.test.ts`,
the Outlook and telephone dispatch tests); connector admission is now one gate over two models
(`connector-single-gate.test.ts`). The full loop as one story, including denial re-entering cognition, is not tested.

### 9. Planning
A task needing at least three dependent stages; then make stage two fail.
**Pass:** a dependency-aware plan, and a replan rather than blind continuation.
**Today:** partial. Decomposition, the precedence solver and replanning are wired and tested, and a passing build now
closes the nodes it proves. The induced mid-plan failure is not driven end to end.

### 10. Creative cognition
Constrained generation, continuation, analogy, invention, transformation, style constraints.
**Pass:** novel material with the invented/factual distinction preserved.
**Today:** partial. `creative-mouth.test.ts` and the invention construct path cover parts; the six modes are not a
matrix, and construction promotion from the live corpus has never succeeded (see the corpus gap below).

### 11. Coding cognition
Understand → locate → plan → generate patch → validate → report, then a deliberately failing patch.
**Pass:** it detects the failure and repairs within the supported families; the workspace mutation boundary cannot be
bypassed.
**Today:** partial. Patch transactions are content-addressed, authorization-gated and tested; the repair loop exists
(`bounded-autonomous-debugging.ts`); the bypass-attempt test is missing.

### 12. Determinism
The same turn from the same persisted state, repeatedly.
**Pass:** deterministic portions byte-for-byte stable; any stochastic boundary explicit and seed-reproducible.
**Today:** partial. Deterministic replay is a first-class mode and canonical serialization is enforced; brain identity
is now canonical and resume-stable (`brain-identity-determinism.test.ts`). Turn-level byte stability is not asserted.

### 13. Replay
Replay a completed trace after process restart, database reconnect, cache removal, connector unavailable.
**Pass:** terminal outcomes reproduce from durable state and recorded inputs.
**Today:** partial. The event ledger is hash-chained and verifiable (`fullyVerifyEventLedger`), and terminal tasks
replay after restart. The four degraded conditions are not tested.

### 14. Adversarial corpus
Contradictory, duplicated, irrelevant, malformed documents; misleading terminology; instructions embedded in sources;
fabricated citations; very long irrelevant passages; Unicode edge cases; syntactically valid nonsense.
**Pass:** source material cannot acquire authority merely by being present.
**Today:** partial. Control-corpus spans are excluded by construction, seed induction rejects unrelated pairs
(`translation-seed-adversarial.test.ts`), and one real OOM class was found and fixed. There is no fuzzing programme.

### 15. Provenance integrity
Try to make it say "according to X" when X does not support the claim: deleted, changed, conflicting, indirect,
inferred and invented evidence.
**Pass:** every claim presenting itself as evidenced has an auditable basis.
**Today:** partial and architecturally central. The proof boundary, citation verification against source bytes, and the
unsupported-content block are real and tested; a deliberate attack suite does not exist.

### 16. Long-horizon cognition
20 to 50 cognitive transitions, measuring state growth, correctness, provenance, planning coherence, retrieval,
latency and memory stability.
**Pass:** degradation is graceful rather than catastrophic.
**Today:** not covered.

### 17. State portability
Create state on A, export canonical durable state, restore on B, re-run the tests.
**Pass:** the substrate survives migration without rebuilding from the corpus.
**Today:** partial. Brain import/export, lifecycle and hydration are substantial and tested; ranker checkpoints now
export and import with identity preserved. A full A-to-B migration test does not exist.

### 18. Concurrent cognition
Independent turns against one brain: simultaneous reads, simultaneous learning, conflicting updates, tool execution,
one turn failing while another continues.
**Pass:** no cross-turn state corruption or provenance contamination.
**Today:** partial. Optimistic-concurrency writes are used and tested where they matter (document sessions, ranker
activation); a concurrency suite does not exist.

### 19. Corpus mutation
Run cognition, modify the corpus, run the same query.
**Pass:** the cognitive state reflects the changed evidence and stale evidence does not remain authoritative.
**Today:** this is the one with real scar tissue. Corpus mutation between 2026-09-04 and 2026-09-05 dropped the sealed
score from 168 to 153, and the cause was two defects this exact test would have caught. Quarantine and supersession
machinery exists; the test does not.

### 20. Full-system one shot
A genuinely novel task requiring understanding, retrieval, graph construction, evidence evaluation, reasoning,
learning, planning, tool use, interpretation, realization and persistence, with at least one induced failure, no
test-specific hooks and no human intervention.
**Pass:** it completes and produces the trace, state and provenance artifacts showing how.
**Today:** not covered.

---

## Gate 2 — Engineering Complete

State corruption detection and recovery; schema evolution across brain versions; transaction integrity under a kill at
every write boundary; idempotency of every acquisition, tool and learning operation; referential integrity under
deletion; compaction and lifecycle; memory pressure; resource exhaustion; cancellation at every stage; partial failure
of database, connector or source; version compatibility of old state with a new engine; reproducible build on a clean
machine; environment independence across supported OS, Node and PostgreSQL versions.

**Today:** individual mechanisms exist for most of these — hash-chained events, CAS writes, bounded ingest, deadline
enforcement, migration tooling — and none of them is verified as a gate. The honest summary is that this gate has not
been started as a gate.

## Gate 3 — Acquisition Ready

| Requirement | Status |
|---|---|
| Proprietary boundary stated and enforced | Met — `LICENSE`, `NOTICE`, `pnpm proprietary:check` over 967 tracked files |
| Dependency and IP manifest | Met — [`docs/SBOM.md`](SBOM.md), anchored to commit and lockfile, closure-wide license scan |
| Reproducible build from clean checkout | Partial — `pnpm validate` passes end to end here; never run on a clean machine by another person |
| Independent operation without the author | Not established |
| Architectural documentation | Substantial — [`docs/ARCHITECTURE.md`](ARCHITECTURE.md), [`docs/SCCE_MAP.md`](SCCE_MAP.md), normative contracts |
| Ablation evidence | In progress — conditions are preregistered and runnable; the first full ablation sweep is running |
| Acceptance suite | Specified here; largely unimplemented |
| Reachability accounted for | Met as measurement — [`docs/RUNTIME_REACHABILITY.json`](RUNTIME_REACHABILITY.json), 66 implemented-but-uncalled exports each to be wired or classified |

## The finish criterion

SCCE is finished when the suite above passes **and** every capability exposed as part of the cognitive architecture is
either reachable through the canonical cognitive spine, explicitly classified as a non-runtime artifact, or
intentionally excluded. That is a stronger statement than the reachability count, which measures whether something is
called, not whether being called is the right answer for it.

## The transferability test

Can a competent engineer reconstruct, build, initialize, operate, inspect, modify and extend this architecture from the
repository, its documentation, its tests and its schemas alone — answering what the cognitive state is, what the
invariants are, where learning happens, how evidence becomes licensed, how planning and tool selection work, how
realization works, how failures are represented, how parameters are calibrated, how to add a capability, how to migrate
state, and how to reproduce a result — without the author present?

Until someone has actually tried, the answer is unknown, and no amount of documentation written by the author settles
it. That is the single most valuable unrun test in this document.
