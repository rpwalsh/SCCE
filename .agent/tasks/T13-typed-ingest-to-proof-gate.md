# T13-typed-ingest-to-proof-gate

status: open
claimed_by:

Audit 2026-09-15 (relation-role / value-type lane): the typed proof engine's role and value typing
(`semantic-proof-engine.ts` `evaluateAtomTyping`, `evaluateQuantity`: `role_id_mismatch`, `value_kind_mismatch`,
`unit_missing`, `unit_conflict`) has ZERO typed producers on the production turn.

- Producers exist at ingest: `ingestion-lanes.ts:638` (MeasurementObservation.unit, tabular lane only) and
  `relation-promotion.ts:295` (hyperedge participant ports with roleId/valueKind), lifted by
  `semantic-proof-adapter.ts` (`typedObservationToProofRecords`, `typedRelationsToProofRecords`).
- The only consumer is `entailment.ts` `structuredProofGate`, which needs `proofClaims`/`construct` plus
  `typedObservations`/`typedRelations`. Both production calls (`production-turn-runtime.ts:2392` and `:4532`) pass
  none of them, and always pass `sourceExcerpts`, so the gate returns `undefined` (not even the exact-text fallback).
  Only `scce-runtime.ts` (fixture simulation, no production importer) passes `typedRelations`.
- Live trace `2026-09-13T20-00-39-376Z-trace_mu08o1xs_zi757u.jsonl`: 361 `proof.entailment` stages, 0 occurrences of
  any typed engine reason, 0 `typedRelations`, 0 `unitId`/`roleId`/`valueKind`. The stage records counts only.
- The production turn holds `graph.hyperedges` (`production-turn-runtime.ts:1842`, `:2141`) and never hands them to
  the proof gate: a producer whose output is dropped.

Second finding: under a hydrated closed class (`relationRequired`), `answerCoversRequest` decides candidates by
string relation units, so `8,848` vs `8848` vs `8,848.86` decide answerhood before any typing; with a realistic
closed class neither the typed nor the unitless sentence covered and the proposer returned `undefined` (probe v10).
That gate is where value typing is absent on the hydrated path; it needs T12 first because the compiled value is
currently wrong for thousands-separated numbers.

Do: pass `typedRelations: graph.hyperedges` and construct-derived claims into the production `entailment.check`
calls; trace the typed obligations (not just counts); then let coverage compare compiled quantities where the request
carries one. Regression: a production-shaped turn whose evidence carries a hyperedge with typed ports must produce a
typed obligation in the proof trace.

Offline only. Do NOT start or restart the server. Read-only SQL only. DDL on evidence_spans blocks the server.
