# Arbitrary modeling constants written inline

Weights and thresholds in the unit interval that decide behaviour and were chosen by hand.
Slice bounds, limits, counts, indices and tolerances are excluded: 275 were skipped as cost bounds.

| file | count | reads registry | example |
| --- | ---: | :---: | --- |
| packages/kernel/src/language-memory-runtime.ts | 99 | NO | `const total = clamp01(0.46 * score.activation + 0.34 * requestFit + 0.2 * (candidate.fit ?? score.fi` |
| packages/kernel/src/learned-graph-prior-runtime.ts | 79 | NO | `const contradictionPressure = kernelClamp01(input.field.alphaTrace.surfaces.contradiction * 0.58 + i` |
| packages/kernel/src/question-slot-planner.ts | 60 | NO | `contributionScore(fact) > 0.54 &&` |
| packages/kernel/src/mouth.ts | 55 | NO | `const sourcePreservationRequested = (input.requirementField?.semanticPreservation ?? 0) >= 0.6` |
| packages/kernel/src/walsh-surface-energy.ts | 54 | NO | `repetition: -0.24,` |
| packages/kernel/src/tool-cognition.ts | 47 | NO | `const riskSurface = surfaces ? clamp01(0.35 * surfaces.risk + 0.25 * surfaces.contradiction + 0.2 * ` |
| packages/kernel/src/graph-edge-quality.ts | 44 | NO | `const entityCentralitySupport = clamp01(0.55 * endpointCentrality(subject) + 0.45 * endpointCentrali` |
| packages/kernel/src/semantic-obligations.ts | 42 | NO | `const stability = clamp01(1 - input.field.alphaTrace.surfaces.drift * 0.55 - input.field.alphaTrace.` |
| packages/kernel/src/judge.ts | 37 | NO | `repetition: clamp01(0.16 + 0.18 * requirement.noveltyDemand),` |
| packages/kernel/src/semantic-proof-system.ts | 35 | NO | `const faithfulnessLcb = clamp01(support - Math.sqrt(supportVariance + 0.02) - contradiction * 0.35 -` |
| packages/kernel/src/benchmarks.ts | 33 | NO | `const residualRisk = clamp01(1 - score + contradictionRisk(turn.entailment) * 0.3 + validationRisk(t` |
| packages/kernel/src/dialogue-pragmatics.ts | 31 | NO | `add(DIALOGUE_ACTION_IDS.answer, 0.5 + (enoughInformation ? 0.28 : -0.18) + weight(profile, INTERACTI` |
| packages/kernel/src/invention-planner.ts | 31 | NO | `"authority.feature.request.creative": -0.72,` |
| packages/kernel/src/candidate.ts | 30 | NO | `mass: clamp01(base * 0.68 + (operator?.boltzmannProbability ?? base) * 0.32),` |
| packages/kernel/src/proof-calculus.ts | 30 | NO | `const supportCandidates = witnesses.filter(item => item.support > 0.08);` |
| packages/kernel/src/functional-cognition.ts | 29 | NO | `const fc = cmpsAvailable && dci.available && fcsPrime >= 0.65 && fsi >= 0.6 && dci.dci >= 0.6 && gov` |
| packages/kernel/src/learning-loop.ts | 24 | NO | `coverageGap: clamp01(1 - need.priority * 0.5),` |
| packages/kernel/src/local-evidence-runtime.ts | 22 | yes | `const alphaBoost = lexical >= 0.025 // semanticFrameBoundAligned // priorityAligned // anchorAligned` |
| packages/kernel/src/semantic-memory-index.ts | 22 | NO | `residentSafetyBoundBytes: Math.floor(input.residentSafetyBoundBytes * 0.28),` |
| packages/kernel/src/answer-emitter.ts | 19 | NO | `score: clamp01(0.45 * sentence.lcb + 0.35 * weightedJaccard(claimFeatures, features) + 0.2 * (senten` |
| packages/kernel/src/translation.ts | 18 | NO | `const preservation = clamp01(0.26 * semantic + 0.22 * topology + 0.19 * scriptFit + 0.11 * evidenceM` |
| packages/kernel/src/code-learning.ts | 17 | NO | `const risk = clamp01(0.72 - 0.42 * input.graph.confidence + 0.22 * input.entailment.contradiction + ` |
| packages/kernel/src/program-planner.ts | 17 | NO | `const support = clamp01(0.6 * entailment.support + 0.25 * entailment.faithfulnessLcb + 0.15 * (1 - e` |
| packages/kernel/src/question-cognitive-edge.ts | 17 | NO | `if (item.fit.finalQuestionFit < 0.76) continue;` |
| packages/kernel/src/runtime-coherence.ts | 16 | NO | `if (evidenceCluster.pressure > 0.34) {` |

**83 files never read the registry.**
Arbitrary constants inline: 1341. Declared calibrations: 35.

DECLARED_COVERAGE 2.5%
