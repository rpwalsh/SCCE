# Undeclared constant candidates

Scanned 329 files under packages/kernel/src. 109 carry 3 or more.

A cost bound is legitimately inline. A modeling parameter is not. This ranks; a person decides.

| file | inline | reads registry | example |
| --- | ---: | :---: | --- |
| packages/kernel/src/learned-graph-prior-runtime.ts | 138 | NO | `const contradictionPressure = kernelClamp01(input.field.alphaTrace.surfaces.contradiction * 0.58` |
| packages/kernel/src/local-evidence-runtime.ts | 136 | yes | `const units = uniqueKernelStrings(anchors.flatMap(anchor => splitPriorUnits(normalizePriorKey(an` |
| packages/kernel/src/mouth.ts | 110 | NO | `const sourcePreservationRequested = (input.requirementField?.semanticPreservation ?? 0) >= 0.6` |
| packages/kernel/src/language-memory-runtime.ts | 94 | NO | `const continuationModel = input.state.models.find(model => model.order >= 3) ?? input.state.mode` |
| packages/kernel/src/question-slot-planner.ts | 88 | NO | `const collectionPartial = context.questionTypeId === QUESTION_TYPE_IDS.collectionMember && selec` |
| packages/kernel/src/walsh-surface-energy.ts | 85 | NO | `return { raw: declared, reasonIds: [declared >= 0.6 ? "surface.general.meaning.preserved" : "sur` |
| packages/kernel/src/graph-edge-quality.ts | 66 | NO | `if (predicate.symbols.length <= 1 && predicate.charCount <= 4) reasonIds.push(GRAPH_QUALITY_REAS` |
| packages/kernel/src/program-planner.ts | 66 | NO | `{ source: sourceEmission.id, target: entrypointFor(shape), relation: "entrypoint", weight: 0.95 ` |
| packages/kernel/src/typed-ingest.ts | 45 | NO | `.filter(cell => likelyNaturalLanguage(cell.value) > 0.58)` |
| packages/kernel/src/question-cognitive-edge.ts | 41 | NO | `if (input.unitCount <= 3 && input.hasQuestionBoundary) return "compact";` |
| packages/kernel/src/semantic-obligations.ts | 38 | NO | `const stability = clamp01(1 - input.field.alphaTrace.surfaces.drift * 0.55 - input.field.alphaTr` |
| packages/kernel/src/dialogue-pragmatics.ts | 37 | NO | `add(DIALOGUE_ACTION_IDS.answer, 0.5 + (enoughInformation ? 0.28 : -0.18) + weight(profile, INTER` |
| packages/kernel/src/candidate.ts | 34 | NO | `mass: clamp01(base * 0.68 + (operator?.boltzmannProbability ?? base) * 0.32),` |
| packages/kernel/src/runtime-graph-retrieval.ts | 32 | NO | `const evidence = (await deps.storage.evidence.searchEvidence({ features, limit: 40 })).map(item ` |
| packages/kernel/src/semantic-proof-system.ts | 32 | NO | `support: Math.max(0, best.constraints - openObligationCount(best) * 0.12),` |
| packages/kernel/src/tool-cognition.ts | 32 | NO | `if (pressure <= 0.08) return;` |
| packages/kernel/src/proof-calculus.ts | 30 | NO | `const supportCandidates = witnesses.filter(item => item.support > 0.08);` |
| packages/kernel/src/invention-planner.ts | 28 | NO | `return events.length >= 4` |
| packages/kernel/src/code-learning.ts | 27 | NO | `{ diagnostic: "syntax", recognizer: "parser location and nearest file operation", operation: "re` |
| packages/kernel/src/ingestion-lanes.ts | 25 | NO | `if (observation.textPreview && likelyNaturalLanguage(observation.textPreview) > 0.35) stores.add` |
| packages/kernel/src/engineering-corpus.ts | 24 | NO | `generatedFileCount: files.filter(file => file.generatedScore >= 0.7).length,` |
| packages/kernel/src/answer-emitter.ts | 21 | NO | `const redundant = selected.some(item => weightedJaccard(item.features, candidate.features) > 0.8` |
| packages/kernel/src/production-turn-runtime.ts | 21 | NO | `.listLanguagePatterns({ sourceSystem: "corrections", limit: 2048 })` |
| packages/kernel/src/learning-loop.ts | 20 | NO | `coverageGap: clamp01(1 - need.priority * 0.5),` |
| packages/kernel/src/runtime-coherence.ts | 20 | NO | `if (evidenceCluster.pressure > 0.34) {` |
| packages/kernel/src/functional-cognition.ts | 19 | NO | `const fc = cmpsAvailable && dci.available && fcsPrime >= 0.65 && fsi >= 0.6 && dci.dci >= 0.6 &&` |
| packages/kernel/src/discourse-state.ts | 16 | NO | `(namesOwnSubject ? sparseMass : Math.max(sparseMass, 0.78)) * 0.58 + recencyMass * 0.18 + eviden` |
| packages/kernel/src/engineering-corpus-runtime.ts | 16 | NO | `const languageScore = input.language && entry.language === input.language ? 0.32 : input.languag` |
| packages/kernel/src/semantic-graph.ts | 16 | NO | `? proofPaths.filter(path => path.support >= 0.2 && path.contradiction <= 0.35).length / claimGra` |
| packages/kernel/src/program.ts | 15 | NO | `{ id: "family:translation", kind: "construct:translation", label: validationMessageKey("construc` |

**107 files carry deciding constants and never read the registry at all.**
Total inline candidates: 1929. Declared calibrations: 35.

DECLARED_COVERAGE 1.8%

A number written inline cannot be audited, searched or fitted. Reading code to find them is the smell
this replaces: run this, and declare whatever turns out to be a modeling parameter rather than a cost bound.
