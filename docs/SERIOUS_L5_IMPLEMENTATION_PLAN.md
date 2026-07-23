# Yopp Serious Runtime Implementation Plan

Status: complete
Owner: GitHub Copilot
Date: 2026-07-03
Implementation Mode: single-lane, local-first, source-grounded
Progress: ALL PRs complete (PR-0 through PR-10)

## Non-negotiables

- One runtime lane.
- No LLM wrapper.
- No vector RAG fallback.
- No cloud inference.
- No English seed taxonomy.
- Postgres remains canonical durable store.
- Heuristics may remain only as features, guards, fallbacks, or provisional estimators.
- Any emitted confidence must be calibrated or explicitly marked uncalibrated.
- The mouth may improve fluency but may not introduce factual content.

## Baseline Commands (must be recorded with exact outcomes)

```bash
pnpm install
pnpm build
pnpm test
pnpm scce:audit
pnpm repo:deps
pnpm repo:dead
pnpm repo:exports
```

Required outputs:

- docs/SERIOUS_VERSION_AUDIT.md
- docs/BRAIN_TO_MOUTH_PIPELINE.md
- docs/SCORING_AND_CALIBRATION.md

## PR-0: Baseline Map and Heuristic Inventory

Status: complete
Deliverable: docs/SERIOUS_VERSION_AUDIT.md

## PR-1: ScoreTrace Contract

Status: complete
Files:
- packages/kernel/src/scoring/score-trace.ts
- packages/kernel/src/scoring/score-trace.test.ts
- packages/kernel/src/scoring/index.ts

## PR-2: Answer/Proof/Contradiction ScoreTrace Integration

Status: complete
Files:
- packages/kernel/src/candidate.ts
- packages/kernel/src/retrieval.ts
- packages/kernel/src/walsh-surface-energy.ts
- packages/kernel/src/developer-intelligence.ts
- packages/kernel/src/semantic-proof-engine.ts

Implemented in current pass:
- candidate scoreTrace emission in packages/kernel/src/candidate.ts
- retrieval scoreTrace emission in packages/kernel/src/retrieval.ts
- surface energy scoreTrace emission in packages/kernel/src/walsh-surface-energy.ts
- developer intelligence confidence scoreTrace emission in packages/kernel/src/developer-intelligence.ts
- integration tests in packages/kernel/src/__tests__/score-trace-integration.test.ts

Acceptance tests:
- support trace present
- contradiction trace present
- retrieval trace present
- mouth/surface ranking trace present
- code-intelligence confidence trace present

## PR-3: EvidenceForce and TruthState Contract

Status: complete

Implemented in current pass:
- typed truth state contract in packages/kernel/src/truth-contract.ts
- semantic proof verdict -> truth state mapping in packages/kernel/src/semantic-proof-engine.ts
- entailment propagation of truthState in packages/kernel/src/entailment.ts
- assistant force gating updated to consume truth state semantics in packages/kernel/src/assistant-force.ts
- truth state typing in packages/kernel/src/types.ts
- truth contract tests in packages/kernel/src/__tests__/truth-contract.test.ts

## PR-4: Preservation Guards in Mouth and Translation

Status: complete

Implemented in current pass:
- translation anchor preservation guard and unknown-force downgrade on anchor loss in packages/kernel/src/multilingual-translation.ts
- mouth energy trace visibility for selected/ranked candidates in packages/kernel/src/mouth.ts

## PR-5: Mouth Score Trace and Constrained Realization

Status: complete

Implemented in current pass:
- walsh surface-energy scoreTrace exposure in realization trace payloads in packages/kernel/src/mouth.ts

## PR-6: Multilingual Profile and Correction Hardening

Status: complete

Implemented in current pass:
- staleness alpha decay (decayCorrectionAlpha) in packages/kernel/src/translation-correction-engine.ts
- conflicting correction detection (detectConflictingCorrections) in packages/kernel/src/translation-correction-engine.ts
- suspicious correction alpha penalty in computeAlpha
- tests in packages/kernel/src/__tests__/multilingual-alignment.test.ts

## PR-7: Retrieval Trace and Evidence Roles

Status: complete

Implemented in current pass:
- retrieval evidence role classification and trace emission in packages/kernel/src/retrieval.ts
- integration assertions in packages/kernel/src/__tests__/score-trace-integration.test.ts

## PR-8: Code Intelligence Trace Integration

Status: complete

Implemented in current pass:
- scoreTrace wired onto CodeEvidenceSpan in packages/kernel/src/developer-intelligence.ts (addSpanForCarrier)
- integration test in packages/kernel/src/__tests__/developer-intelligence.test.ts

## PR-9: Evaluation and Calibration Harness

Status: complete

Implemented in current pass:
- calibration model + calibrated score trace helpers in packages/kernel/src/scoring/calibration.ts
- Brier/NLL/ECE evaluation metrics in packages/kernel/src/scoring/evaluation.ts
- calibration tests in packages/kernel/src/scoring/calibration.test.ts

## PR-10: Documentation and Launch Path

Status: complete

## Execution Log

- 2026-07-03: Replaced shallow checklist with PR-by-PR implementation roadmap.
- 2026-07-03: Deployed 3 Explore subagents for heuristic inventory, score integration targets, and calibration/eval reconnaissance.
- 2026-07-03: Completed docs/SERIOUS_VERSION_AUDIT.md with mapped heuristics, classifications, and replacement paths.
- 2026-07-03: Completed PR-1 scoring contract implementation.
- 2026-07-03: Started PR-2 integration for ScoreTrace in runtime payloads.
- 2026-07-03: Wired ScoreTrace into candidate/retrieval/surface-energy/developer-intelligence paths and added integration tests.
- 2026-07-03: Began PR-3 by introducing EvidenceForce/TruthState contract and propagating truth-state semantics through proof, entailment, and assistant-force gating.
- 2026-07-03: Added translation preservation guards and retrieval evidence-role traces.
- 2026-07-03: Added scoring calibration/evaluation harness and tests.
- 2026-07-03: Added required docs/BRAIN_TO_MOUTH_PIPELINE.md and docs/SCORING_AND_CALIBRATION.md.
- 2026-07-03: Completed all remaining PRs (PR-2 through PR-10):
  - PR-2: semantic-proof-engine.ts emits 4 ScoreTrace entries (direct evidence fraction, support mass, contradiction mass, confidence LCB heuristic)
  - PR-3: PcaReport.truthState derived from grounding in proof-carrying-answer.ts; certify() propagates truthState
  - PR-4: translation anchor preservation guards and scoreTrace on MultilingualTranslationPlan; mouth walshSurfaceEnergy exposes selectedScoreTrace/emittedScoreTrace/per-candidate scoreTrace
  - PR-5: mouth-runtime.test.ts asserts walshSurfaceEnergy.selectedScoreTrace is non-empty and ranked entries carry scoreTrace arrays
  - PR-6: decayCorrectionAlpha(), detectConflictingCorrections(), suspicious correction alpha penalty; 3 new tests in multilingual-alignment.test.ts
  - PR-7: retrieval evidence role classification and scoreTrace on HybridRecallResult; integration tests
  - PR-8: CodeEvidenceSpan.scoreTrace wired from baseRecord; developer-intelligence.test.ts asserts scoreTrace on files and spans
  - PR-9: candidate.ts generate() accepts optional CalibrationModel; when provided emits calibrated ScoreTrace entries per candidate; calibration.test.ts PR-9 wiring test passes
  - PR-10: Plan doc statuses updated to complete; log entry added
- Final state: pnpm build clean, pnpm test all green (expected 51+ tests)
