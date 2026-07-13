# Brain To Mouth Pipeline

Status: implemented single-lane boundary in an unfinished product; calibration remains provisional

## Contract

The SCCE runtime must follow one inspectable lane:

1. source evidence and typed observations
2. graph/hyperedge admission and alpha-normalized field/frontier activation
3. directed PPR and configured PowerWalk expansion
4. learned turn-requirement field
5. cognitive-operator activation
6. bounded proposals containing claims, relations, steps, and artifacts
7. per-claim basis classification
8. candidate generation and requirement-aware judge selection
9. entailment, truth state, certification, and slot planning
10. existing Mouth realization and final Walsh surface gate
11. typed critic and at most two revision rounds when needed
12. emitted answer plus durable basis-aware events and trace

The mouth is realization-only. It may not invent factual content.

## Runtime Boundaries

- Kernel orchestration: packages/kernel/src/kernel.ts
- Retrieval scoring: packages/kernel/src/retrieval.ts
- Candidate scoring: packages/kernel/src/candidate.ts
- Requirement field/operator activation: packages/kernel/src/turn-requirements.ts
- Cognitive proposal planning: packages/kernel/src/cognitive-planner.ts
- Requirement-aware judging: packages/kernel/src/judge.ts
- Certification checker: packages/kernel/src/semantic-proof-engine.ts
- Truth contract: packages/kernel/src/truth-contract.ts
- Entailment propagation: packages/kernel/src/entailment.ts
- Mouth planning/realization: packages/kernel/src/mouth.ts
- Surface energy ranking: packages/kernel/src/walsh-surface-energy.ts
- Bounded answer revision: packages/kernel/src/answer-revision.ts

## General-Cognition Boundary

The requirement field has 16 dimensions. Its evidence is learned frame, pattern,
phrase-unit, dialogue-move, and construct activation with character and UTF-8 byte
spans, plus explicit structured requirements when supplied. It does not classify a
turn from English command verbs. The field activates 17 cognitive operators, and only
operator-supported work becomes a cognitive proposal.

Each proposal preserves requirement coverage and typed claim bases:
`direct_evidence`, `source_synthesis`, `reasoned_inference`, `causal_inference`,
`temporal_inference`, `counterfactual`, `learned_prior`, `invented`, `conjectured`,
`translated`, `action_result`, or `unsupported`. Candidate and judge code may select
among those proposals; the Mouth may only realize the selected meaning and force.

The revision coordinator critiques the realized answer against the requirement field,
selected proposal, claim bases, citations, validation results, action receipts, and
surface invariants. It runs zero, one, or two rounds. A proposed revision is rejected
unless it improves quality by at least `0.025`; citation mismatch, test weakening,
action without a receipt, and telemetry leakage are hard failures.

## Evidence and Truth Gating

- SCCE can answer without proof. It cannot represent unsupported output as proved.
- Every emitted answer carries an answer basis: sourced, reasoned, prior-bound, creative, speculative, or unsupported.
- Certification verdicts are mapped to typed truth state when certification is attempted.
- Unsupported truth states are treated as under-supported in assistant-force gating.
- Source-bound and certified states can surface factual language; unsupported states cannot claim certification.

## Mouth Preservation

- Semantic preservation scoring is applied across generated candidates.
- Forbidden/drift/leak checks penalize or reject candidates.
- Runtime caveats are enforced before final emission.
- Surface energy rows include score traces for inspection.
- The final Walsh/surface gate is rerun after realization transforms; a failed final surface is not emitted.

## Trace Surfaces

The following runtime artifacts are emitted for inspection:

- retrieval score traces
- candidate score traces
- surface-energy score traces
- selected mouth candidate and preservation score
- answer basis and certification marker
- turn-requirement field and contributing activation spans
- cognitive-operator activation rows
- cognitive proposals, per-claim bases, and selected proposal
- typed revision defects, attempts, and disposition
- condition-specific evaluation events and cache identity when evaluation is enabled

## Current mathematical status

- Unconfigured α thresholds are deterministic Type-7 quantiles over the active relation-strength slice. They are relative normalization, not externally calibrated admissibility.
- Directed PPR has an independent dense linear oracle in tests. PowerWalk uses deterministic second-order transitions and content-addressed train/validation partition identity; learned PPMI representations expand production field seeds.
- Configured relation-potential scoring reaches the production field and uses disjoint coefficient-training, calibration-fit, and evaluation-holdout folds. No representative sealed model is configured, so the normal fallback is identity and no uplift is claimed.
- Requirement-field, operator, reasoning, invention, proposal-diversity, judge, and Mouth coefficient sets are versioned and traced, but the checked-in defaults are bootstrap/provisional rather than representative outcome-fitted models.
- Answer-level calibration remains explicitly `uncalibrated` where no task-specific calibration model is loaded.

## Launch Safety Notes

- No cloud inference required.
- No external retrieval-to-prompt fallback path.
- No second runtime lane.
- Postgres remains canonical durable store.
- The local engineering gate establishes only the checks it executes; public evidence requirements are defined in `docs/PUBLIC_REVIEW_CONTRACT.md`.
