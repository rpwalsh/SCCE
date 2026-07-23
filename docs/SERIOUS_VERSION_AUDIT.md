# Serious Version Audit

Date: 2026-07-03
Status: draft-complete

## Heuristic Inventory Table

| File | Function | Current score/formula | Current role | Problem | New classification | Replacement path |
| ---- | -------- | --------------------- | ------------ | ------- | ------------------ | ---------------- |
| packages/kernel/src/walsh-surface-energy.ts | scoreSurfaceEnergy | 14-lambda weighted energy vector | final mouth ranking | hard-coded lambdas without calibration evidence | provisional_heuristic | migrate to estimator+calibration with trace ids per component |
| packages/kernel/src/proof-calculus.ts | witness | 7-term linear weighted support with contradiction penalty | proof support estimator | weights and penalty asymmetric and uncalibrated | estimator | train/support fit calibrator and expose confidence status |
| packages/kernel/src/proof-calculus.ts | weightedSupport | 0.7 support + 0.18 alpha + 0.12 causal mass | proof aggregation | hard-coded blend and slice depth | provisional_heuristic | learned blend, plus calibration per task class |
| packages/kernel/src/proof-calculus.ts | weightedContradiction | evidence contradiction + 0.45 contradictionMass + 0.1 risk | contradiction aggregation | coefficients not validated by held-out outcomes | provisional_heuristic | contradiction estimator + reliability bins |
| packages/kernel/src/question-slot-planner.ts | factScore | 7-term weighted formula (0.24..0.05) | slot assignment scoring | no calibration source, brittle across intents | provisional_heuristic | slot utility estimator + calibration by question class |
| packages/kernel/src/question-slot-planner.ts | roleOrFieldScore / contributionScore | weighted blends with explicit thresholds | slot role decisions | threshold drift and hidden branch behavior | provisional_heuristic | branch trace + learned role classifier |
| packages/kernel/src/question-slot-planner.ts | membership/significance thresholds | 0.42–0.62 hard cutoffs | final slot selection gates | untracked false positive/negative tradeoff | guard | convert to explicit guard traces + tune by eval battery |
| packages/kernel/src/candidate.ts | candidateMass | 8-dimension weighted mass formula | final candidate ranking | hand weights treated as intelligence | provisional_heuristic | demote to feature blend + calibrated selector |
| packages/kernel/src/candidate.ts | baseScores | support/contradiction/faithfulness etc scalar bundle | candidate feature set | scalar confidence fields lack explicit calibration status | feature | emit ScoreTrace for each base dimension |
| packages/kernel/src/retrieval.ts | hybridRecall | 0.38 bm25 + 0.24 vector + 0.22 graph + 0.16 alpha | retrieval ranking | overlap-heavy blend no calibration id | provisional_heuristic | VOI-aligned retrieval estimator + role trace |
| packages/kernel/src/retrieval.ts | bm25 + cosine | raw similarity scores | retrieval feature inputs | treated as score not feature in downstream reporting | feature | keep as features with explicit semantics |
| packages/kernel/src/semantic-proof-system.ts | modality strengths | asserted/reported/estimated/planned/possible constants | epistemic force weighting | fixed values without empirical grounding | provisional_heuristic | fit modality reliability per corpus domain |
| packages/kernel/src/proof-carrying-answer.ts | derivation thresholds | paraphrase/specialization/transitivity cutoffs | proof certificate routing | hardcoded rule thresholds | guard | keep as guards but trace and tune with eval corpus |
| packages/kernel/src/training-orchestrator.ts | evidence promotion score | trust+alpha+novelty+coverage weighted blend | training data promotion | promotion gate no reliability calibration | provisional_heuristic | promotion estimator tied to downstream outcomes |
| packages/kernel/src/training-orchestrator.ts | minTrust default 0.45 | promotion threshold | training guard | fixed default with no confidence curves | guard | keep as guard with explicit risk/failure mode |
| packages/kernel/src/translation.ts | preservation blend | semantic/topology/script/evidence/prior weighted score | translation alignment quality | no language-pair calibration | provisional_heuristic | language-pair specific calibrated estimator |
| packages/kernel/src/developer-intelligence.ts | confidenceFor | source-hash/parser-id based confidence constants | code evidence confidence | heuristic confidence emitted as scalar | provisional_heuristic | evidence confidence estimator + calibration status |
| packages/kernel/src/source-code-graph.ts | configuration confidence defaults | role confidence constants | code graph confidence | constants lack training evidence | fallback | retain as fallback only, not final confidence |
| packages/kernel/src/kernel.ts | graph cache/hot neighborhood limits | fixed environment defaults | memory/latency guardrails | safe but undocumented tradeoffs | guard | keep as deterministic safety guard with telemetry |

## Summary

- Total major heuristic or threshold systems mapped: 19
- Final-decision heuristics to demote in next PRs: candidateMass, hybridRecall blend, question slot weighted blends, surface-energy lambdas
- Keep as guards: preservation thresholds, proof boundary hard constraints, cache/memory caps, source-bound restrictions
- Immediate implementation target: ScoreTrace integration across candidate, retrieval, mouth energy, and proof verdict payloads

## Required follow-up docs

- docs/BRAIN_TO_MOUTH_PIPELINE.md
- docs/SCORING_AND_CALIBRATION.md
