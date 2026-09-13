# Calibration sites to declare


## packages/kernel/src/language-memory-runtime.ts  (17 vectors, 11 thresholds)
- VECTOR packages/kernel/src/language-memory-runtime.ts:667 [sums to 1]  [0.46, 0.34, 0.2]
    const total = clamp01(0.46 * score.activation + 0.34 * requestFit + 0.2 * (candidate.fit ?? score.fit));
- VECTOR packages/kernel/src/language-memory-runtime.ts:1017 [sums to 1]  [0.42, 0.28, 0.18, 0.12]
    const confidence = clamp01(0.42 * score.activation + 0.28 * input.state.competenceVector.generationReliability + 0.18 * Math.min(1, selected.length / 
- VECTOR packages/kernel/src/language-memory-runtime.ts:1242 [sums to 1]  [0.34, 0.24, 0.22, 0.2]
    const score = clamp01(0.34 * clamp01(support) + 0.24 * fit + 0.22 * ngram.probability + 0.2 * sourcePreference(source));
- VECTOR packages/kernel/src/language-memory-runtime.ts:1571 [sums to 1]  [0.3, 0.28, 0.18, 0.16, 0.08]
    const score = clamp01(0.3 * support + 0.28 * coverage + 0.18 * continuity + 0.16 * lengthFit + 0.08 * (1 - repetitionPenalty));
- VECTOR packages/kernel/src/language-memory-runtime.ts:2056 [sums to 1]  [0.55, 0.25, 0.2]
    score: clamp01(0.55 * continuity + 0.25 * right.score + 0.2 * left.score)
- VECTOR packages/kernel/src/language-memory-runtime.ts:2133 [sums to 1]  [0.26, 0.22, 0.18, 0.16, 0.12, 0.06]
    const score = clamp01(0.26 * claimCoverage + 0.22 * anchor + 0.18 * continuity + 0.16 * priorSupport + 0.12 * lengthFit + 0.06 * (1 - repetitionPenalt
- VECTOR packages/kernel/src/language-memory-runtime.ts:2326 [sums to 1]  [0.3, 0.24, 0.22, 0.14, 0.1]
    const discourseScore = clamp01(0.3 * anchorCoverage + 0.24 * cohesion + 0.22 * fluency.selectedBeamScore + 0.14 * fluency.ngramMeanActivation + 0.1 * 
- VECTOR packages/kernel/src/language-memory-runtime.ts:2466 [sums to 1]  [0.62, 0.38]
    const coverageGain = clamp01(0.62 * termGain + 0.38 * atomGain);
- VECTOR packages/kernel/src/language-memory-runtime.ts:2476  [0.23, 0.28, 0.15, 0.11, 0.07]
    const increment = 0.23 * coverageGain + 0.28 * priorSupport + 0.15 * transitionScore + 0.11 * ngramActivation + 0.07 * roleFit + boundaryBonus + prior
- VECTOR packages/kernel/src/language-memory-runtime.ts:2515  [0.4, 0.16, 0.14, 0.08, 0.06, 0.12]
    return clamp01(0.4 * move.support + 0.16 * ngramActivation + 0.14 * roleFit + 0.08 * compactness + 0.06 * sourceMass + 0.12 * planOrder + priorAnchor)
- VECTOR packages/kernel/src/language-memory-runtime.ts:2529  [0.32, 0.18, 0.12, 0.1, 0.12]
    return state.score + 0.32 * clamp01(requiredCoverage) + 0.18 * clamp01(atomCoverage) + 0.12 * moveBalance + 0.1 * transitionMean + 0.12 * clamp01(aver
- VECTOR packages/kernel/src/language-memory-runtime.ts:3023 [sums to 1]  [0.32, 0.24, 0.44]
    const relationUsefulness = clamp01(0.32 * material.support + 0.24 * material.relevance + 0.44 * questionShapeFit);
- VECTOR packages/kernel/src/language-memory-runtime.ts:3579 [sums to 1]  [0.42, 0.28, 0.18, 0.12]
    return clamp01(0.42 * input.support + 0.28 * input.score.activation + 0.18 * extentFit + 0.12 * probability);
- VECTOR packages/kernel/src/language-memory-runtime.ts:4306 [sums to 1]  [0.72, 0.28]
    const orderFit = clamp01(0.72 * fit + 0.28 * Math.min(1, model.observedSymbolCount / 10000));
- VECTOR packages/kernel/src/language-memory-runtime.ts:4737 [sums to 1]  [0.4, 0.36, 0.24]
    const generationReliability = clamp01(0.4 * lexicalCoverage + 0.36 * phraseFluency + 0.24 * modelCoverage);
- VECTOR packages/kernel/src/language-memory-runtime.ts:4742 [sums to 1]  [0.64, 0.36]
    const discourseReliability = clamp01(0.64 * generationReliability + 0.36 * discoursePatternCoverage);
- VECTOR packages/kernel/src/language-memory-runtime.ts:4745 [sums to 1]  [0.35, 0.65]
    segmentationQuality: clamp01(0.35 * modelCoverage + 0.65 * lexicalCoverage),
- THRESHOLD packages/kernel/src/language-memory-runtime.ts:2160  0.55
    if (candidate.claimCoverage < 0.55) issues.push("prose.claim_coverage.low");
- THRESHOLD packages/kernel/src/language-memory-runtime.ts:2161  0.42
    if (candidate.anchorCoverage < 0.42) issues.push("prose.anchor_coverage.low");
- THRESHOLD packages/kernel/src/language-memory-runtime.ts:2163  0.16
    if (candidate.lengthFit < 0.16) issues.push("prose.length_fit.low");
- THRESHOLD packages/kernel/src/language-memory-runtime.ts:2271  0.18
    const covered = required.filter(anchor => containsLoose(text, anchor) || weightedJaccard(featureSet(text, 128), featureSet(anchor, 128)) > 0.18).lengt
- THRESHOLD packages/kernel/src/language-memory-runtime.ts:2588  0.45
    return requiredTerms.filter(term => (term.weight ?? 0) >= 0.45 && tidyInline(term.text)).length;
- THRESHOLD packages/kernel/src/language-memory-runtime.ts:2753  0.92
    const near = [...seen.values()].find(existing => semanticMaterialOverlap(existing, row) > 0.92);
- THRESHOLD packages/kernel/src/language-memory-runtime.ts:3016  0.04
    const hasContribution = primaryRows.some(material => semanticRelationSurfaceMass(material) > 1 || semanticQuestionFit(material, contextText) > 0.04);
- THRESHOLD packages/kernel/src/language-memory-runtime.ts:3038  0.64
    const shouldSurface = !rejectedSlot && (!background || (!hasContribution && relationUsefulness > 0.64 && !material.upstreamRoleId && !secondarySlot));
- THRESHOLD packages/kernel/src/language-memory-runtime.ts:3595  0.72
    && discourse.repetitionPenalty < 0.72
- THRESHOLD packages/kernel/src/language-memory-runtime.ts:3643  0.5..0.24
    return shortFragmentRatio >= 0.5 && punctuationDensity >= 0.24;
- THRESHOLD packages/kernel/src/language-memory-runtime.ts:4073  0.35
    if (glyphs > 0 && punctuation / glyphs > 0.35) return false;

## packages/kernel/src/learned-graph-prior-runtime.ts  (3 vectors, 19 thresholds)
- VECTOR packages/kernel/src/learned-graph-prior-runtime.ts:670 [sums to 1]  [0.34, 0.24, 0.24, 0.18]
    explanationCompleteness: kernelClamp01(0.34 * (1 - missingRequired / requiredRoleIds.length) + 0.24 * bridgeCoverage + 0.24 * supportMass + 0.18 * Mat
- VECTOR packages/kernel/src/learned-graph-prior-runtime.ts:1539 [sums to 1]  [0.36, 0.22, 0.22, 0.2]
    const explanationCompleteness = kernelClamp01(0.36 * (1 - missingRequired / requiredRoleIds.length) + 0.22 * bridgeCoverage + 0.22 * supportMass + 0.2
- VECTOR packages/kernel/src/learned-graph-prior-runtime.ts:1653 [sums to 1]  [0.38, 0.34, 0.28]
    const pathActivation = kernelClamp01(0.38 * input.fact.activation + 0.34 * input.fact.ppfMass + 0.28 * Math.max(input.fact.sourceActivation, input.fac
- THRESHOLD packages/kernel/src/learned-graph-prior-runtime.ts:641  0.0001..0.18
    const assignments = assignmentCandidates.filter(assignment => assignment.arc > 0.0001 || assignment.pathScore > 0.18);
- THRESHOLD packages/kernel/src/learned-graph-prior-runtime.ts:771  0.08
    .filter(fact => factCompletenessScore(fact, anchors) > 0.08 || topicCompoundMembershipAnswerFact(fact))
- THRESHOLD packages/kernel/src/learned-graph-prior-runtime.ts:906  0.00001..0.18
    if (overlap <= 0 && activation <= 0.00001 && cognitive.fit.finalQuestionFit < 0.18) continue;
- THRESHOLD packages/kernel/src/learned-graph-prior-runtime.ts:973  0.44
    fact.questionEdgeFit.finalQuestionFit >= 0.44;
- THRESHOLD packages/kernel/src/learned-graph-prior-runtime.ts:1171  0.000001
    if (featureOverlap <= 0 && surfaceSpecificity <= 0 && surfaceOverlap <= 0 && anchorScore <= 0 && topologySupport <= 0.000001) continue;
- THRESHOLD packages/kernel/src/learned-graph-prior-runtime.ts:1182  0.018
    if (score < 0.018 && anchorScore <= 0) continue;
- THRESHOLD packages/kernel/src/learned-graph-prior-runtime.ts:1368  0.08..0.03
    const unrelatedPriorPenalty = learnedGraphPriorCount > 0 && maxSubjectAffinity < 0.08 && maxQuestionOverlap < 0.03 ? 0.6 : 0;
- THRESHOLD packages/kernel/src/learned-graph-prior-runtime.ts:1398  0.22
    if (directEvidenceCount > 0 && relevanceScore >= 0.22) decision = QUESTION_EDGE_DECISION_IDS.directEvidence;
- THRESHOLD packages/kernel/src/learned-graph-prior-runtime.ts:1401  0.22..0.2
    else if (input.cognitiveFabric.decision === QUESTION_EDGE_DECISION_IDS.requestedSupport && slotPlanAllowsAnswer && relevanceScore >= 0.22 && requested
- THRESHOLD packages/kernel/src/learned-graph-prior-runtime.ts:1402  0.18..0.14
    else if (input.cognitiveFabric.decision === QUESTION_EDGE_DECISION_IDS.partialSupport && slotPlanAllowsAnswer && relevanceScore >= 0.18 && requestedCo
- THRESHOLD packages/kernel/src/learned-graph-prior-runtime.ts:1406  0.025..0.18
    else if (candidateSubjectMatches.length > 1 && Math.abs((candidateSubjectMatches[0]?.affinity ?? 0) - (candidateSubjectMatches[1]?.affinity ?? 0)) < 0
- THRESHOLD packages/kernel/src/learned-graph-prior-runtime.ts:1415  0.00001
    activatedEdgeCount: input.ranked.filter(fact => fact.activation > 0.00001).length,
- THRESHOLD packages/kernel/src/learned-graph-prior-runtime.ts:1519  0.0001
    .filter(assignment => assignment.arc > 0.0001)
- THRESHOLD packages/kernel/src/learned-graph-prior-runtime.ts:1820  0.001
    if (affinity <= 0.001) continue;
- THRESHOLD packages/kernel/src/learned-graph-prior-runtime.ts:1879  0.03
    if (slot === EXPLANATORY_CONTRACT_SLOT_IDS.request) return facts.some(fact => fact.overlap > 0.03);
- THRESHOLD packages/kernel/src/learned-graph-prior-runtime.ts:1916  0.12
    if (punctuationMass > 0.12) return false;
- THRESHOLD packages/kernel/src/learned-graph-prior-runtime.ts:2164  0.62
    if (temporalOrQuantityCatalogSurface(fact.object) && fit < 0.62 && role !== RELATION_ROLE_IDS.graphRequestRelation) return true;
- THRESHOLD packages/kernel/src/learned-graph-prior-runtime.ts:2166  0.5..0.08
    if (quality.classId === GRAPH_QUALITY_CLASS_IDS.weakFragment && fit < 0.5 && fact.overlap < 0.08) return true;
- THRESHOLD packages/kernel/src/learned-graph-prior-runtime.ts:2167  0.62..0.64
    if (quality.fragmentScore >= 0.62 && fit < 0.64) return true;

## packages/kernel/src/graph-edge-quality.ts  (4 vectors, 17 thresholds)
- VECTOR packages/kernel/src/graph-edge-quality.ts:76 [sums to 1]  [0.55, 0.45]
    const entityCentralitySupport = clamp01(0.55 * endpointCentrality(subject) + 0.45 * endpointCentrality(object));
- VECTOR packages/kernel/src/graph-edge-quality.ts:169 [sums to 1]  [0.58, 0.42]
    const compact = clamp01(0.58 * symbolMass + 0.42 * charMass);
- VECTOR packages/kernel/src/graph-edge-quality.ts:170  [0.5, 0.35, 0.15, 0.42]
    return clamp01(0.5 * compact + 0.35 * profile.cleanliness + 0.15 * endpointCentrality(profile) - 0.42 * profile.fragmentScore);
- VECTOR packages/kernel/src/graph-edge-quality.ts:245 [sums to 1]  [0.6, 0.4]
    return clamp01(0.6 * middle + 0.4 * clean);
- THRESHOLD packages/kernel/src/graph-edge-quality.ts:96  0.42
    if (subjectSpecificity < 0.42) reasonIds.push(GRAPH_QUALITY_REASON_IDS.lowInformationSubject);
- THRESHOLD packages/kernel/src/graph-edge-quality.ts:97  0.32
    if (objectSpecificity < 0.32) reasonIds.push(GRAPH_QUALITY_REASON_IDS.lowInformationObject);
- THRESHOLD packages/kernel/src/graph-edge-quality.ts:98  0.72
    if (functionLikePredicateScore(predicate) >= 0.72) reasonIds.push(GRAPH_QUALITY_REASON_IDS.functionPredicate);
- THRESHOLD packages/kernel/src/graph-edge-quality.ts:99  0.48
    if (subject.fragmentScore >= 0.48) reasonIds.push(GRAPH_QUALITY_REASON_IDS.subjectFragment);
- THRESHOLD packages/kernel/src/graph-edge-quality.ts:102  0.16
    if (noisyMarkup >= 0.16) reasonIds.push(GRAPH_QUALITY_REASON_IDS.markupDense);
- THRESHOLD packages/kernel/src/graph-edge-quality.ts:103  0.55
    if (categoryNavigationScore >= 0.55) reasonIds.push(GRAPH_QUALITY_REASON_IDS.navigationShape);
- THRESHOLD packages/kernel/src/graph-edge-quality.ts:106  0.62..0.36
    if (relationUsefulness >= 0.62 && fragmentScore < 0.36) reasonIds.push(GRAPH_QUALITY_REASON_IDS.semanticShape);
- THRESHOLD packages/kernel/src/graph-edge-quality.ts:108  0.36
    if (noisyMarkup >= 0.16 || labelCleanliness < 0.36 || (fragmentScore >= 0.72 && predicateQuality < 0.12)) classId = GRAPH_QUALITY_CLASS_IDS.noisyMarku
- THRESHOLD packages/kernel/src/graph-edge-quality.ts:108  0.12
    if (noisyMarkup >= 0.16 || labelCleanliness < 0.36 || (fragmentScore >= 0.72 && predicateQuality < 0.12)) classId = GRAPH_QUALITY_CLASS_IDS.noisyMarku
- THRESHOLD packages/kernel/src/graph-edge-quality.ts:113  0.34..0.42
    else if (fragmentScore >= 0.34 || predicateQuality < 0.42) classId = GRAPH_QUALITY_CLASS_IDS.weakFragment;
- THRESHOLD packages/kernel/src/graph-edge-quality.ts:117  0.58
    const answerGrade = classId === GRAPH_QUALITY_CLASS_IDS.answerGrade && semanticQuality >= 0.58;
- THRESHOLD packages/kernel/src/graph-edge-quality.ts:140  0.33
    input.predicateQuality >= 0.33 &&
- THRESHOLD packages/kernel/src/graph-edge-quality.ts:141  0.74
    input.objectQuality >= 0.74 &&
- THRESHOLD packages/kernel/src/graph-edge-quality.ts:144  0.24
    input.fragmentScore < 0.24;
- THRESHOLD packages/kernel/src/graph-edge-quality.ts:187  0.34
    if (profile.fragmentScore >= 0.34) score -= 0.18;
- THRESHOLD packages/kernel/src/graph-edge-quality.ts:209  0.54
    const objectClassifierShape = object.symbols.length >= 3 && object.symbols.length <= 9 && endpointCentrality(object) >= 0.54 ? 0.24 : 0;
- THRESHOLD packages/kernel/src/graph-edge-quality.ts:237  0.18
    const vowelThinness = alphabeticVowelRatio(profile.normalized) < 0.18 && charCount <= 6 ? 0.18 : 0;

## packages/kernel/src/tool-cognition.ts  (9 vectors, 9 thresholds)
- VECTOR packages/kernel/src/tool-cognition.ts:225 [sums to 1]  [0.35, 0.25, 0.2, 0.2]
    const riskSurface = surfaces ? clamp01(0.35 * surfaces.risk + 0.25 * surfaces.contradiction + 0.2 * surfaces.drift + 0.2 * (1 - surfaces.bond)) : 0.35
- VECTOR packages/kernel/src/tool-cognition.ts:228  [0.45, 0.2, 0.1]
    const baseExpected = clamp01(0.25 + 0.45 * (1 - evidenceMass) + 0.2 * (1 - fieldMass) + 0.1 * riskSurface);
- VECTOR packages/kernel/src/tool-cognition.ts:345 [sums to 1]  [0.55, 0.45]
    const utility = clamp01((0.55 * fit + 0.45 * evi) * configuredPenalty * (1 - risk * 0.42));
- VECTOR packages/kernel/src/tool-cognition.ts:393 [sums to 1]  [0.62, 0.23, 0.15]
    return clamp01(0.62 * kindFit + 0.23 * phaseFit + 0.15 * metadataFit);
- VECTOR packages/kernel/src/tool-cognition.ts:409 [sums to 1]  [0.32, 0.24, 0.2, 0.14, 0.1]
    return clamp01(0.32 * capabilityRiskBase + 0.24 * mutation + 0.2 * privacy + 0.14 * network + 0.1 * spend + policyPenalty);
- VECTOR packages/kernel/src/tool-cognition.ts:421 [sums to 1]  [0.58, 0.42]
    return clamp01((0.58 * phaseValue + 0.42 * connectorValue) * (1 - risk * 0.3));
- VECTOR packages/kernel/src/tool-cognition.ts:644 [sums to 1]  [0.45, 0.35, 0.2]
    const produced = clamp01(0.45 * Math.min(1, outcome.evidenceProduced / 8) + 0.35 * Math.min(1, outcome.artifactsProduced / 4) + 0.2 * success);
- VECTOR packages/kernel/src/tool-cognition.ts:647  [0.18, 0.08]
    const utilityDelta = clamp01(produced - 0.18 * spendPenalty - 0.08 * durationPenalty);
- VECTOR packages/kernel/src/tool-cognition.ts:649 [sums to 1]  [0.55, 0.45]
    const connectorReliability = clamp01(0.55 * success + 0.45 * (1 - riskDelta));
- THRESHOLD packages/kernel/src/tool-cognition.ts:230  0.08
    if (pressure <= 0.08) return;
- THRESHOLD packages/kernel/src/tool-cognition.ts:339  0.04
    if (fit <= 0.04) continue;
- THRESHOLD packages/kernel/src/tool-cognition.ts:428  0.35..0.55
    const approvalNeeded = capability.requiresApproval || phase === "commit" || risk > 0.35 || objective.privacyPressure > 0.55 || objective.kind === "pur
- THRESHOLD packages/kernel/src/tool-cognition.ts:443  0.55
    if (objective.privacyPressure > 0.55) reasons.push("privacy pressure raises approval requirement");
- THRESHOLD packages/kernel/src/tool-cognition.ts:473  0.12
    if (score.utility < 0.12 && selected.length > 0) continue;
- THRESHOLD packages/kernel/src/tool-cognition.ts:525  0.35
    network: (objective?.networkPressure ?? 0) > 0.35,
- THRESHOLD packages/kernel/src/tool-cognition.ts:567  0.72
    const operatorGrantEligible = risk < 0.72 && plan.phase !== "commit";
- THRESHOLD packages/kernel/src/tool-cognition.ts:603  0.28
    if (chosen.some(score => score.utility >= 0.28)) return [];
- THRESHOLD packages/kernel/src/tool-cognition.ts:663  0.62..0.28
    retainAsPattern: connectorReliability > 0.62 && utilityDelta > 0.28,

## packages/kernel/src/semantic-obligations.ts  (4 vectors, 13 thresholds)
- VECTOR packages/kernel/src/semantic-obligations.ts:399 [sums to 1]  [0.34, 0.25, 0.21, 0.2]
    const support = clamp01(0.34 * lexical + 0.25 * context + 0.21 * vector + 0.2 * mass);
- VECTOR packages/kernel/src/semantic-obligations.ts:505 [sums to 1]  [0.45, 0.35, 0.2]
    const support = clamp01(0.45 * lexical + 0.35 * vector + 0.2 * span.alpha);
- VECTOR packages/kernel/src/semantic-obligations.ts:594 [sums to 1]  [0.45, 0.25, 0.3]
    return clamp01(0.45 * shape + 0.25 * lexical + 0.3 * vector);
- VECTOR packages/kernel/src/semantic-obligations.ts:875 [sums to 1]  [0.48, 0.32, 0.2]
    return clamp01(0.48 * explicit + 0.32 * field.alphaTrace.surfaces.contradiction + 0.2 * field.alphaTrace.contradictionMass);
- THRESHOLD packages/kernel/src/semantic-obligations.ts:408  0.28
    const nearContext = ranked.find(match => match.support >= 0.28 && match.candidate.normalized !== item.normalized);
- THRESHOLD packages/kernel/src/semantic-obligations.ts:426  0.46
    const nearContext = ranked.find(match => match.support >= 0.46 && match.candidate.normalized !== item.normalized);
- THRESHOLD packages/kernel/src/semantic-obligations.ts:526  0.34
    best.support >= 0.34 && preservation.blockingMissing.length === 0 ? "satisfied" :
- THRESHOLD packages/kernel/src/semantic-obligations.ts:527  0.16
    best.support >= 0.16 || preservation.preserved.length > 0 ? "underdetermined" :
- THRESHOLD packages/kernel/src/semantic-obligations.ts:560  0.48
    const status: SemanticObligationStatus = !best ? "missing" : best.fit >= 0.48 ? "satisfied" : best.fit >= 0.22 ? "underdetermined" : "missing";
- THRESHOLD packages/kernel/src/semantic-obligations.ts:560  0.22
    const status: SemanticObligationStatus = !best ? "missing" : best.fit >= 0.48 ? "satisfied" : best.fit >= 0.22 ? "underdetermined" : "missing";
- THRESHOLD packages/kernel/src/semantic-obligations.ts:683  0.42..0.42
    if (field.alphaTrace.surfaces.contradiction <= 0.42 && field.alphaTrace.contradictionMass <= 0.42) return explicit;
- THRESHOLD packages/kernel/src/semantic-obligations.ts:751  0.42..0.48
    if (input.contradiction >= 0.42 || input.required.some(item => item.status === "contradicted" && item.contradiction >= 0.48)) return "contradicted";
- THRESHOLD packages/kernel/src/semantic-obligations.ts:755  0.18
    if (!input.admission.admitted) return input.admission.supportCeiling >= 0.18 ? "underdetermined" : "unknown";
- THRESHOLD packages/kernel/src/semantic-obligations.ts:757  0.42
    const roleOk = input.roleCoverage >= 0.42 && input.required.filter(item => item.kind === "role").every(item => item.status !== "missing");
- THRESHOLD packages/kernel/src/semantic-obligations.ts:763  0.72
    input.structuralCoverage >= 0.72 &&
- THRESHOLD packages/kernel/src/semantic-obligations.ts:769  0.05
    if (input.structuralCoverage >= 0.25 || input.relationCompatibility >= 0.28 || input.causalMass >= 0.05) return "underdetermined";
- THRESHOLD packages/kernel/src/semantic-obligations.ts:795  0.12
    if (input.scores.faithfulnessLCB < 0.12) out.push("faithfulness-lcb-low");

## packages/kernel/src/semantic-proof-system.ts  (6 vectors, 9 thresholds)
- VECTOR packages/kernel/src/semantic-proof-system.ts:583 [sums to 1]  [0.5, 0.5]
    const alpha = clamp01(0.5 * right.alpha + 0.5 * cosineSimilarity(left.vector, right.vector));
- VECTOR packages/kernel/src/semantic-proof-system.ts:584 [sums to 1]  [0.34, 0.32, 0.16, 0.1, 0.08]
    const agreement = clamp01(0.34 * predicate + 0.32 * roleMatch.score + 0.16 * constraintMatch.score + 0.1 * polarity + 0.08 * transforms.supportBoost);
- VECTOR packages/kernel/src/semantic-proof-system.ts:639 [sums to 1]  [0.35, 0.25, 0.25, 0.15]
    return clamp01(0.35 * posterior + 0.25 * lexical + 0.25 * feature + 0.15 * vector);
- VECTOR packages/kernel/src/semantic-proof-system.ts:683  [0.48, 0.3]
    const score = clamp01(0.48 * lexical + 0.3 * features + typeBoost + nameBoost);
- VECTOR packages/kernel/src/semantic-proof-system.ts:756 [sums to 1]  [0.55, 0.45]
    return clamp01(0.55 * (overlap > 0 ? overlap / span : 0) + 0.45 * close);
- VECTOR packages/kernel/src/semantic-proof-system.ts:1072 [sums to 1]  [0.65, 0.35]
    return nodeMass > 0 ? { ...atom, alpha: clamp01(0.65 * atom.alpha + 0.35 * nodeMass) } : atom;
- THRESHOLD packages/kernel/src/semantic-proof-system.ts:542  0.45
    unification.roles >= 0.45 &&
- THRESHOLD packages/kernel/src/semantic-proof-system.ts:543  0.68
    unification.constraints >= 0.68 &&
- THRESHOLD packages/kernel/src/semantic-proof-system.ts:547  0.22
    unification.contradiction <= 0.22;
- THRESHOLD packages/kernel/src/semantic-proof-system.ts:690  0.18
    if (bestIndex >= 0 && bestScore >= 0.18) {
- THRESHOLD packages/kernel/src/semantic-proof-system.ts:1038  0.45..0.35
    if (unification.polarity === 0 && unification.predicate > 0.45 && unification.roles > 0.35) return PROOF_COUNTEREXAMPLE_REASON.POLARITY;
- THRESHOLD packages/kernel/src/semantic-proof-system.ts:1058  0.55
    if (contradiction >= 0.55 && contradiction > support * 0.9) return SEMANTIC_VERDICT.CONTRADICTED;
- THRESHOLD packages/kernel/src/semantic-proof-system.ts:1059  0.76
    if (admission.admitted && support >= 0.76 && coverage >= 0.72 && faithfulnessLcb >= 0.45) return SEMANTIC_VERDICT.ENTAILED;
- THRESHOLD packages/kernel/src/semantic-proof-system.ts:1059  0.72
    if (admission.admitted && support >= 0.76 && coverage >= 0.72 && faithfulnessLcb >= 0.45) return SEMANTIC_VERDICT.ENTAILED;
- THRESHOLD packages/kernel/src/semantic-proof-system.ts:1060  0.42..0.35
    if (support >= 0.42 && coverage >= 0.35) return SEMANTIC_VERDICT.PARTIAL;

## packages/kernel/src/mouth.ts  (0 vectors, 15 thresholds)
- THRESHOLD packages/kernel/src/mouth.ts:1859  0.58..0.68
    if (detail >= 0.58 && sequence >= 0.68) return DETAIL_PROFILE_IDS[3]!;
- THRESHOLD packages/kernel/src/mouth.ts:1860  0.68
    if (detail >= 0.68) return DETAIL_PROFILE_IDS[2]!;
- THRESHOLD packages/kernel/src/mouth.ts:1861  0.32
    if (detail <= 0.32) return DETAIL_PROFILE_IDS[0]!;
- THRESHOLD packages/kernel/src/mouth.ts:2313  0.42
    return candidate.fit >= 0.42;
- THRESHOLD packages/kernel/src/mouth.ts:3038  0.44
    if (!Number.isFinite(fact.finalQuestionFit) || (fact.finalQuestionFit ?? 0) < 0.44) return false;
- THRESHOLD packages/kernel/src/mouth.ts:3140  0.48..0.24
    return Boolean(ranked && ranked.score >= 0.48 && ranked.trigramCoverage >= 0.24);
- THRESHOLD packages/kernel/src/mouth.ts:3571  0.88
    || weightedJaccard(featuresFor(existing.surface), featuresFor(row.surface)) > 0.88
- THRESHOLD packages/kernel/src/mouth.ts:4402  0.45
    if (share < 0.45 && dominance < 1.6) return undefined;
- THRESHOLD packages/kernel/src/mouth.ts:4591  0.55
    if (containsSurface(summary, clean) || weightedJaccard(featureSet(clean, 256), featureSet(summary, 256)) > 0.55) return summary;
- THRESHOLD packages/kernel/src/mouth.ts:4930  0.82
    .filter(term => (!proofBoundarySurface && term.weight >= 0.82) || term.source === "language-memory" || term.source === "correction")
- THRESHOLD packages/kernel/src/mouth.ts:6851  0.92
    if (overlap >= 0.92 && preservesQuestionShape(text, question)) hits.push("surface.reject.echo.question_shape");
- THRESHOLD packages/kernel/src/mouth.ts:6852  0.86
    if (overlap >= 0.86 && normalizedText.length <= normalizedQuestion.length + 8) hits.push("surface.reject.echo.minor_cleanup");
- THRESHOLD packages/kernel/src/mouth.ts:6867  0.08
    else if (priorMass > 0 && coverage < 0.08 && input.evidence.length === 0) hits.push("surface.reject.language_prior_unanchored");
- THRESHOLD packages/kernel/src/mouth.ts:7215  0.78
    if (weightedJaccard(featureSet(left, 128), featureSet(right, 128)) > 0.78) return true;
- THRESHOLD packages/kernel/src/mouth.ts:7697  0.04
    return weightedJaccard(a, b) > 0.04 || invariantSymbols(text).some(symbol => claimText.includes(symbol.text));

## packages/kernel/src/question-slot-planner.ts  (0 vectors, 13 thresholds)
- THRESHOLD packages/kernel/src/question-slot-planner.ts:167  0.54
    contributionScore(fact) > 0.54 &&
- THRESHOLD packages/kernel/src/question-slot-planner.ts:173  0.56
    if (membership > 0.56 && !strongContribution) return QUESTION_TYPE_IDS.collectionMember;
- THRESHOLD packages/kernel/src/question-slot-planner.ts:174  0.62..0.58
    if (significance > 0.62 && contribution < 0.58) return QUESTION_TYPE_IDS.effectBridge;
- THRESHOLD packages/kernel/src/question-slot-planner.ts:217  0.48
    if (metadata > 0.48 && requestFit < 0.72 && member < 0.5 && contribution < 0.5 && roleField < 0.5) {
- THRESHOLD packages/kernel/src/question-slot-planner.ts:217  0.72
    if (metadata > 0.48 && requestFit < 0.72 && member < 0.5 && contribution < 0.5 && roleField < 0.5) {
- THRESHOLD packages/kernel/src/question-slot-planner.ts:222  0.24
    if (member > 0.5 && requestFit >= 0.24 && memberValue >= 0.46) return assignment(fact, ANSWER_SLOT_IDS.memberRelation, "core", baseScore + member * 0.
- THRESHOLD packages/kernel/src/question-slot-planner.ts:222  0.46
    if (member > 0.5 && requestFit >= 0.24 && memberValue >= 0.46) return assignment(fact, ANSWER_SLOT_IDS.memberRelation, "core", baseScore + member * 0.
- THRESHOLD packages/kernel/src/question-slot-planner.ts:224  0.36
    return assignment(fact, contextScore > 0.36 ? ANSWER_SLOT_IDS.collectionContext : ANSWER_SLOT_IDS.requestMismatch, contextScore > 0.36 ? "context" : "
- THRESHOLD packages/kernel/src/question-slot-planner.ts:227  0.42
    if (contribution > 0.42) return assignment(fact, ANSWER_SLOT_IDS.contribution, "core", baseScore + contribution * 0.28, [QUESTION_SLOT_REASON_IDS.cont
- THRESHOLD packages/kernel/src/question-slot-planner.ts:230  0.38
    if (contextScore > 0.38) return assignment(fact, ANSWER_SLOT_IDS.context, "secondary", baseScore + contextScore * 0.1, [QUESTION_SLOT_REASON_IDS.conte
- THRESHOLD packages/kernel/src/question-slot-planner.ts:245  0.32..0.34
    if (contextScore > 0.32 || significance > 0.34) return assignment(fact, ANSWER_SLOT_IDS.context, "secondary", baseScore * 0.72, [QUESTION_SLOT_REASON_
- THRESHOLD packages/kernel/src/question-slot-planner.ts:367  0.64
    if (!fact.relationRoleId && !fact.upstreamRoleId && !fact.requestedSlotId && clamp01(fact.finalQuestionFit ?? 0) < 0.64) return 0.42;
- THRESHOLD packages/kernel/src/question-slot-planner.ts:398  0.8..0.2
    if (subjectHit > 0.8 && objectHit <= 0.2) return 0.6;

## packages/kernel/src/judge.ts  (10 vectors, 1 thresholds)
- VECTOR packages/kernel/src/judge.ts:258  [0.54, 0.16]
    contradiction: clamp01(0.28 + 0.54 * requirement.externalTruthAuthority + 0.16 * requirement.inferentialDepth),
- VECTOR packages/kernel/src/judge.ts:259  [0.62, 0.22]
    unsupportedFactRate: clamp01(0.36 + 0.62 * requirement.externalTruthAuthority + 0.22 * requirement.sourceDependence),
- VECTOR packages/kernel/src/judge.ts:261  [0.35, 0.25]
    staleSourceRisk: clamp01(0.30 + 0.35 * requirement.sourceDependence + 0.25 * requirement.executableArtifactDemand),
- VECTOR packages/kernel/src/judge.ts:439 [sums to 1]  [0.35, 0.28, 0.22, 0.15]
    const proof = clamp01(0.35 * epistemic + 0.28 * s.support + 0.22 * s.faithfulness + 0.15 * s.evidenceCoverage);
- VECTOR packages/kernel/src/judge.ts:440 [sums to 1]  [0.38, 0.25, 0.2, 0.17]
    const field = clamp01(0.38 * s.alphaPressure + 0.25 * s.actionability + 0.2 * s.realizability + 0.17 * s.novelty);
- VECTOR packages/kernel/src/judge.ts:442 [sums to 1]  [0.6, 0.25, 0.15]
    const risk = clamp01(0.6 * s.contradiction + 0.25 * (candidate.boundaries.length ? 0.35 : 0) + 0.15 * Math.max(0, policy.alphaRiskCeiling < 0.5 ? 0.2 
- VECTOR packages/kernel/src/judge.ts:453  [0.32, 0.24, 0.2, 0.12, 0.12, 0.42]
    return clamp01(0.32 * proof + 0.24 * field + 0.2 * validationScore + 0.12 * s.realizability + 0.12 * mass - 0.42 * risk - telemetryPenalty);
- VECTOR packages/kernel/src/judge.ts:464  [0.12, 0.08, 0.08]
    return clamp01(0.12 * mass + 0.08 * s.actionability + 0.08 * s.realizability - telemetryPenalty);
- VECTOR packages/kernel/src/judge.ts:476  [0.28, 0.22, 0.20, 0.15, 0.15, 0.30, 0.20, 0.50]
    : 0.28 * constraintCoverage + 0.22 * coherence + 0.20 * novelty + 0.15 * language + 0.15 * usefulness - 0.30 * risk - 0.20 * repetition - 0.50 * fakeF
- VECTOR packages/kernel/src/judge.ts:486 [sums to 1]  [0.72, 0.16, 0.12]
    return clamp01(0.72 * normalizedSelection + 0.16 * mass + 0.12 * validationScore - telemetryPenalty);
- THRESHOLD packages/kernel/src/judge.ts:346  0.65
    requirement.executableArtifactDemand >= 0.65

## packages/kernel/src/dialogue-pragmatics.ts  (2 vectors, 8 thresholds)
- VECTOR packages/kernel/src/dialogue-pragmatics.ts:834 [sums to 1]  [0.75, 0.25]
    return clamp01(0.75 * covered + 0.25 * actionFit);
- VECTOR packages/kernel/src/dialogue-pragmatics.ts:862 [sums to 1]  [0.7, 0.3]
    return clamp01(0.7 * covered + 0.3 * lengthFit);
- THRESHOLD packages/kernel/src/dialogue-pragmatics.ts:481  0.65
    addPenalty(DIALOGUE_PENALTY_IDS.lengthDrift, weight(input.state.userStyleProfile, INTERACTION_FEATURE_IDS.compactness) > 0.65 && surfaceWordCount(text
- THRESHOLD packages/kernel/src/dialogue-pragmatics.ts:518  0.2..0.36
    valid: score >= 0.2 && !penalties.some(item => item.id === DIALOGUE_PENALTY_IDS.unsupported && item.weight >= 0.36),
- THRESHOLD packages/kernel/src/dialogue-pragmatics.ts:568  0.62..0.72
    if (compact > 0.62 || responseLead > 0.72) {
- THRESHOLD packages/kernel/src/dialogue-pragmatics.ts:795  0.72
    if (weight(state.userStyleProfile, INTERACTION_FEATURE_IDS.calculusNeed) > 0.72 || hasStrongSignal(state, INTERACTION_FEATURE_IDS.calculusNeed)) add(D
- THRESHOLD packages/kernel/src/dialogue-pragmatics.ts:802  0.58
    if (row.score >= 0.58) add(row.id);
- THRESHOLD packages/kernel/src/dialogue-pragmatics.ts:811  0.62
    return weight(state.userStyleProfile, INTERACTION_FEATURE_IDS.compactness) > 0.62 ? RHYTHM_IDS.compact : RHYTHM_IDS.general;
- THRESHOLD packages/kernel/src/dialogue-pragmatics.ts:839  0.68
    if (weight(state.userStyleProfile, INTERACTION_FEATURE_IDS.reviewPressure) > 0.68) return surfaceWordCount(candidate.text) < 70 ? 0.92 : 0.48;
- THRESHOLD packages/kernel/src/dialogue-pragmatics.ts:913  0.85
    return state.interactionSignals.some(signal => signal.featureId === featureId && signal.value >= 0.85);

## packages/kernel/src/proof-calculus.ts  (1 vectors, 9 thresholds)
- VECTOR packages/kernel/src/proof-calculus.ts:210  [0.22, 0.15, 0.18, 0.2, 0.15, 0.1, 0.4]
    const support = clamp01(0.22 * coverage + 0.15 * vector + 0.18 * field + 0.2 * faithfulness + 0.15 * provenance + 0.1 * transformScore - 0.4 * contrad
- THRESHOLD packages/kernel/src/proof-calculus.ts:64  0.08
    const supportCandidates = witnesses.filter(item => item.support > 0.08);
- THRESHOLD packages/kernel/src/proof-calculus.ts:65  0.12
    const contradictionCandidates = witnesses.filter(item => item.contradiction > 0.12);
- THRESHOLD packages/kernel/src/proof-calculus.ts:194  0.62
    if (input.flow.unmetFlowRatio > 0.62) reasons.push("proof.operator.flow_shortfall");
- THRESHOLD packages/kernel/src/proof-calculus.ts:195  0.72
    if (input.kirchhoff.totalImbalance > 0.72) reasons.push("proof.operator.conservation_pressure");
- THRESHOLD packages/kernel/src/proof-calculus.ts:196  0.32
    if (input.consistency.contradictionPressure > 0.32) reasons.push("proof.operator.consistency_pressure");
- THRESHOLD packages/kernel/src/proof-calculus.ts:410  0.45..0.72
    if (contradiction > 0.45 || leakage > 0.72) return "unknown";
- THRESHOLD packages/kernel/src/proof-calculus.ts:411  0.82..0.62
    if (support >= 0.82 && lcb >= 0.62 && independentGroupCount >= 2) return "proved";
- THRESHOLD packages/kernel/src/proof-calculus.ts:412  0.62..0.36
    if (support >= 0.62 && lcb >= 0.36) return "observed";
- THRESHOLD packages/kernel/src/proof-calculus.ts:413  0.34
    if (support >= 0.34) return "inferred";

## packages/kernel/src/translation.ts  (3 vectors, 7 thresholds)
- VECTOR packages/kernel/src/translation.ts:526 [sums to 1]  [0.26, 0.22, 0.19, 0.11, 0.06, 0.10, 0.06]
    const preservation = clamp01(0.26 * semantic + 0.22 * topology + 0.19 * scriptFit + 0.11 * evidenceMass + 0.06 * priorBoost + 0.10 * seedOverlap + 0.0
- VECTOR packages/kernel/src/translation.ts:744 [sums to 1]  [0.45, 0.55]
    return clamp01(0.45 * scriptMass + 0.55 * weightedJaccard(frame.features, profileFeatures));
- VECTOR packages/kernel/src/translation.ts:1072 [sums to 1]  [0.55, 0.45]
    semanticPreservationScore: clamp01(0.55 * input.emission.preservation + 0.45 * (1 - objective.energy))
- THRESHOLD packages/kernel/src/translation.ts:808  0.12
    if (margin < 0.12) return undefined;
- THRESHOLD packages/kernel/src/translation.ts:867  0.74
    if (preservation >= 0.74 && evidenceCount > 0) return "direct";
- THRESHOLD packages/kernel/src/translation.ts:868  0.48..0.5
    if (preservation >= 0.48 || priorBoost >= 0.5) return "approximate";
- THRESHOLD packages/kernel/src/translation.ts:869  0.16
    if (preservation >= 0.16) return "gloss";
- THRESHOLD packages/kernel/src/translation.ts:877  0.7..0.72
    if (direct >= 0.7 && preservation >= 0.72) return "direct";
- THRESHOLD packages/kernel/src/translation.ts:878  0.46
    if (preservation >= 0.46) return "approximate";
- THRESHOLD packages/kernel/src/translation.ts:1045  0.48
    .filter(alignment => alignment.force === "gloss" || alignment.force === "unknown" || alignment.preservation < 0.48)

## packages/kernel/src/functional-cognition.ts  (6 vectors, 3 thresholds)
- VECTOR packages/kernel/src/functional-cognition.ts:292 [sums to 1]  [0.55, 0.25, 0.2]
    const cmps = (safe ? 1 : 0) * groundingFidelity * (0.55 * predictedSuccess + 0.25 * clamp01(diversity) + 0.2 * groundingFidelity);
- VECTOR packages/kernel/src/functional-cognition.ts:392 [sums to 1]  [0.3, 0.25, 0.2, 0.15, 0.1]
    return clamp01(0.3 * selfAccuracy + 0.25 * input.dci + 0.2 * input.homeostaticControlQuality + 0.15 * goalOwnership + 0.1 * input.memoryContinuity);
- VECTOR packages/kernel/src/functional-cognition.ts:403 [sums to 1]  [0.18, 0.16, 0.14, 0.14, 0.13, 0.13, 0.08, 0.04]
    return clamp01(0.18 * sa + 0.16 * egc + 0.14 * cfl + 0.14 * dci + 0.13 * ssd + 0.13 * input.fsi + 0.08 * gov + 0.04 * policy);
- VECTOR packages/kernel/src/functional-cognition.ts:456 [sums to 1]  [0.4, 0.35, 0.25]
    return clamp01(0.4 * uncertainty + 0.35 * memoryPressure + 0.25 * failurePressure);
- VECTOR packages/kernel/src/functional-cognition.ts:460 [sums to 1]  [0.45, 0.25, 0.2, 0.1]
    return clamp01(0.45 * (1 - self.uncertainty) + 0.25 * self.fcs + 0.2 * self.dci + 0.1 * (1 - Math.min(1, self.recentFailures.length / 10)));
- VECTOR packages/kernel/src/functional-cognition.ts:465 [sums to 1]  [0.25, 0.25, 0.25, 0.25]
    return clamp01(0.25 * (m.nodes > 0 ? 1 : 0) + 0.25 * (m.edges > 0 ? 1 : 0) + 0.25 * (m.evidence > 0 ? 1 : 0) + 0.25 * (m.proofs > 0 ? 1 : 0));
- THRESHOLD packages/kernel/src/functional-cognition.ts:167  0.65
    const fc = cmpsAvailable && dci.available && fcsPrime >= 0.65 && fsi >= 0.6 && dci.dci >= 0.6 && gov;
- THRESHOLD packages/kernel/src/functional-cognition.ts:168  0.85
    const efc = fc && pareto.available && fcsPrime >= 0.85 && fsi >= 0.75 && dci.dci >= 0.75 && pareto.invariantKernel;
- THRESHOLD packages/kernel/src/functional-cognition.ts:293  0.62
    const decision = cmps >= 0.62 ? "promote" : cmps >= 0.4 ? "hold" : "quarantine";

## packages/kernel/src/invention-planner.ts  (4 vectors, 5 thresholds)
- VECTOR packages/kernel/src/invention-planner.ts:840  [0.5, 0.75]
    weight: clamp01(0.5 * span.alpha * (0.25 + 0.75 * best.fit)),
- VECTOR packages/kernel/src/invention-planner.ts:861 [sums to 1]  [0.52, 0.28, 0.2]
    rows.push({ id: unit.id, text, source: "language_unit", weight: clamp01(0.52 * unit.alpha + 0.28 * weightedJaccard(requestFeatures, featureSet(text, 1
- VECTOR packages/kernel/src/invention-planner.ts:866 [sums to 1]  [0.46, 0.34, 0.2]
    rows.push({ id: pattern.id, text, source: "language_pattern", weight: clamp01(0.46 * Math.min(1, pattern.support / 8) + 0.34 * weightedJaccard(request
- VECTOR packages/kernel/src/invention-planner.ts:871 [sums to 1]  [0.5, 0.3, 0.2]
    rows.push({ id: frame.id, text, source: "semantic_frame", weight: clamp01(0.5 * frame.alpha + 0.3 * weightedJaccard(requestFeatures, featureSet(text, 
- THRESHOLD packages/kernel/src/invention-planner.ts:814  0.04
    .filter(row => Boolean(row.text) && row.requestFit >= 0.04)
- THRESHOLD packages/kernel/src/invention-planner.ts:1224  0.34
    if (progress < 0.34) return "scce.relation.concurrent";
- THRESHOLD packages/kernel/src/invention-planner.ts:1225  0.68
    if (progress < 0.68) return "scce.relation.subsequent";
- THRESHOLD packages/kernel/src/invention-planner.ts:1226  0.88
    if (progress < 0.88) return "scce.relation.contrastive";
- THRESHOLD packages/kernel/src/invention-planner.ts:1748  0.22
    || weightedJaccard(proposalFeatures, featureSet(constraint.surface, 128)) >= 0.22

## packages/kernel/src/entailment.ts  (2 vectors, 6 thresholds)
- VECTOR packages/kernel/src/entailment.ts:196 [sums to 1]  [0.76, 0.16, 0.08]
    if (semanticVerdict === "underdetermined") return Math.min(0.54, 0.76 * obligationSupport + 0.16 * structuralSupport + 0.08 * calculusSupport);
- VECTOR packages/kernel/src/entailment.ts:197 [sums to 1]  [0.82, 0.12, 0.06]
    return Math.min(0.28, 0.82 * obligationSupport + 0.12 * structuralSupport + 0.06 * calculusSupport);
- THRESHOLD packages/kernel/src/entailment.ts:201  0.52
    if (semanticVerdict === "contradicted" || structuralVerdict === "contradicted" || contradiction > 0.52) return "unknown";
- THRESHOLD packages/kernel/src/entailment.ts:226  0.78
    if (semanticVerdict === "entailed" && structuralVerdict === "entailed" && support >= 0.78 && faithfulnessLcb >= 0.42 && stability >= 0.55) return "pro
- THRESHOLD packages/kernel/src/entailment.ts:226  0.42
    if (semanticVerdict === "entailed" && structuralVerdict === "entailed" && support >= 0.78 && faithfulnessLcb >= 0.42 && stability >= 0.55) return "pro
- THRESHOLD packages/kernel/src/entailment.ts:226  0.55
    if (semanticVerdict === "entailed" && structuralVerdict === "entailed" && support >= 0.78 && faithfulnessLcb >= 0.42 && stability >= 0.55) return "pro
- THRESHOLD packages/kernel/src/entailment.ts:227  0.56
    if (semanticVerdict === "entailed" && structurallyCorroborated && support >= 0.56) return "observed";
- THRESHOLD packages/kernel/src/entailment.ts:228  0.34
    if ((semanticVerdict === "underdetermined" || structuralVerdict === "underdetermined" || (semanticVerdict === "entailed" && !structurallyCorroborated)

## packages/kernel/src/answer-emitter.ts  (3 vectors, 4 thresholds)
- VECTOR packages/kernel/src/answer-emitter.ts:139 [sums to 1]  [0.45, 0.35, 0.2]
    score: clamp01(0.45 * sentence.lcb + 0.35 * weightedJaccard(claimFeatures, features) + 0.2 * (sentence.accepted ? 1 : 0)),
- VECTOR packages/kernel/src/answer-emitter.ts:157  [0.22, 0.2, 0.16, 0.14, 0.16, 0.22]
    const score = clamp01(0.22 * lexical + 0.2 * span.alpha + 0.16 * spanMass + 0.14 * trust + 0.16 * namedSurfaceMass(text) + 0.22 * collectionListSignal
- VECTOR packages/kernel/src/answer-emitter.ts:158 [sums to 1]  [0.55, 0.45]
    out.push({ evidenceId: String(span.id), source: "evidence", score, lcb: clamp01(0.55 * lexical + 0.45 * span.alpha), features, textHash: hashText(text
- THRESHOLD packages/kernel/src/answer-emitter.ts:168  0.82
    const redundant = selected.some(item => weightedJaccard(item.features, candidate.features) > 0.82 || item.textHash === candidate.textHash);
- THRESHOLD packages/kernel/src/answer-emitter.ts:169  0.08
    if (!redundant && candidate.score >= 0.08) selected.push(candidate);
- THRESHOLD packages/kernel/src/answer-emitter.ts:315  0.62
    const compactMemberList = sentences.find(row => row.compactMemberList >= 0.62);
- THRESHOLD packages/kernel/src/answer-emitter.ts:317  0.78
    const anchoredLead = sentences.find(row => row.anchorSignal >= 0.78 && cleanSentence(row.text).length >= 72);

## packages/kernel/src/cognitive-planner.ts  (3 vectors, 4 thresholds)
- VECTOR packages/kernel/src/cognitive-planner.ts:1479 [sums to 1]  [0.70, 0.30]
    const novelty = clamp01(0.70 * noveltyMemory + 0.30 * noveltySibling);
- VECTOR packages/kernel/src/cognitive-planner.ts:1595 [sums to 1]  [0.70, 0.30]
    novelty: "N=0.70*N_memory+0.30*N_sibling",
- VECTOR packages/kernel/src/cognitive-planner.ts:1597 [sums to 1]  [0.72, 0.28]
    mmr: "MMR(g)=0.72*quality(g)+0.28*diversity(g,S)"
- THRESHOLD packages/kernel/src/cognitive-planner.ts:639  0.08
    .filter(item => item.strength >= 0.08)
- THRESHOLD packages/kernel/src/cognitive-planner.ts:730  0.55
    if (input.requirements.inferentialDepth < 0.55) return [];
- THRESHOLD packages/kernel/src/cognitive-planner.ts:918  0.65
    if (input.requirements.uncertaintyTolerance < 0.65) return [];
- THRESHOLD packages/kernel/src/cognitive-planner.ts:1554  0.86
    const next = scored.find(item => item.similarity < 0.86) ?? (selected.length === 0 ? scored[0] : undefined);

## packages/kernel/src/semantic-graph.ts  (1 vectors, 6 thresholds)
- VECTOR packages/kernel/src/semantic-graph.ts:182  [0.34, 0.24, 0.18]
    const score = clamp01((roleCompatible ? 0.24 : 0.06) + 0.34 * lexical + 0.24 * vector + 0.18 * graphMass);
- THRESHOLD packages/kernel/src/semantic-graph.ts:88  0.2..0.35
    ? proofPaths.filter(path => path.support >= 0.2 && path.contradiction <= 0.35).length / claimGraph.edges.length
- THRESHOLD packages/kernel/src/semantic-graph.ts:288  0.55..0.35
    if (input.contradiction >= 0.55 && input.structuralCoverage >= 0.35) return "contradicted";
- THRESHOLD packages/kernel/src/semantic-graph.ts:289  0.08
    if (input.structuralCoverage >= 0.7 && input.causalMass >= 0.08 && input.faithfulnessLCB >= 0.2 && input.contradiction <= 0.35 && input.stability >= 0
- THRESHOLD packages/kernel/src/semantic-graph.ts:289  0.35
    if (input.structuralCoverage >= 0.7 && input.causalMass >= 0.08 && input.faithfulnessLCB >= 0.2 && input.contradiction <= 0.35 && input.stability >= 0
- THRESHOLD packages/kernel/src/semantic-graph.ts:289  0.45
    if (input.structuralCoverage >= 0.7 && input.causalMass >= 0.08 && input.faithfulnessLCB >= 0.2 && input.contradiction <= 0.35 && input.stability >= 0
- THRESHOLD packages/kernel/src/semantic-graph.ts:290  0.35..0.14
    if (input.structuralCoverage >= 0.35 || input.faithfulnessLCB >= 0.14) return "underdetermined";

## packages/kernel/src/question-cognitive-edge.ts  (0 vectors, 7 thresholds)
- THRESHOLD packages/kernel/src/question-cognitive-edge.ts:178  0.76
    if (item.fit.finalQuestionFit < 0.76) continue;
- THRESHOLD packages/kernel/src/question-cognitive-edge.ts:281  0.24
    if (subjectFit < 0.24) reasonIds.push("question_edge.reason.subject_mismatch");
- THRESHOLD packages/kernel/src/question-cognitive-edge.ts:323  0.14
    const requestAligned = relationRequestFit > 0.14 || objectRequestFit > 0.2 || predicateRequestFit > 0.2;
- THRESHOLD packages/kernel/src/question-cognitive-edge.ts:468  0.18
    return input.ordered.some(edge => edge.fit.finalQuestionFit >= 0.18) ? QUESTION_EDGE_DECISION_IDS.requestedSlotMissing : QUESTION_EDGE_DECISION_IDS.in
- THRESHOLD packages/kernel/src/question-cognitive-edge.ts:477  0.58
    if (input.demandUnmet && input.finalQuestionFit < 0.58) return QUESTION_EDGE_DECISION_IDS.requestedSlotMissing;
- THRESHOLD packages/kernel/src/question-cognitive-edge.ts:478  0.22..0.2
    if (input.slotFit < 0.22 || input.relationFit < 0.2) return QUESTION_EDGE_DECISION_IDS.requestedSlotMissing;
- THRESHOLD packages/kernel/src/question-cognitive-edge.ts:481  0.34
    if (input.finalQuestionFit >= 0.34) return QUESTION_EDGE_DECISION_IDS.partialSupport;

## packages/kernel/src/runtime-coherence.ts  (0 vectors, 7 thresholds)
- THRESHOLD packages/kernel/src/runtime-coherence.ts:70  0.34
    if (evidenceCluster.pressure > 0.34) {
- THRESHOLD packages/kernel/src/runtime-coherence.ts:76  0.42
    if (generic > 0.42) {
- THRESHOLD packages/kernel/src/runtime-coherence.ts:82  0.58
    if (proofPressure > 0.58) {
- THRESHOLD packages/kernel/src/runtime-coherence.ts:104  0.01
    if (mouthPressure > 0.01) {
- THRESHOLD packages/kernel/src/runtime-coherence.ts:129  0.82
    const emitAllowed = !failedDimensionIds.includes(RUNTIME_COHERENCE_DIMENSION_IDS.mouthSurface) && readinessPressure < 0.82;
- THRESHOLD packages/kernel/src/runtime-coherence.ts:227  0.08..0.08
    .filter(item => Math.abs(item.effect) > 0.08 && item.pathSupport < 0.08)
- THRESHOLD packages/kernel/src/runtime-coherence.ts:262  0.45
    const missingEvidence = confidence >= 0.45 && evidenceIds.length === 0 ? 0.8 : 0;

## packages/kernel/src/semantic-transform-registry.ts  (0 vectors, 7 thresholds)
- THRESHOLD packages/kernel/src/semantic-transform-registry.ts:145  0.28
    if (predicateRule && input.polarityScore > 0 && predicateFeatureOverlap > 0.28) {
- THRESHOLD packages/kernel/src/semantic-transform-registry.ts:151  0.32
    if (roleRule && roleFit.score > 0.32) {
- THRESHOLD packages/kernel/src/semantic-transform-registry.ts:168  0.44..0.34
    if (polarityRule && input.polarityScore === 0 && input.predicateScore > 0.44 && input.roleScore > 0.34) {
- THRESHOLD packages/kernel/src/semantic-transform-registry.ts:179  0.35..0.25
    if (projectionRule && input.constraintScore > 0.35 && roleFit.score > 0.25) {
- THRESHOLD packages/kernel/src/semantic-transform-registry.ts:228  0.18
    if (bestIndex >= 0 && bestScore > 0.18) {
- THRESHOLD packages/kernel/src/semantic-transform-registry.ts:250  0.45
    if (best.support < 0.45) obligations.push(`obl:q:${claim.subject}`);
- THRESHOLD packages/kernel/src/semantic-transform-registry.ts:267  0.35
    if (best.support < 0.35) obligations.push(`obl:t:${claim.subject}`);

## packages/kernel/src/walsh-surface-energy.ts  (0 vectors, 7 thresholds)
- THRESHOLD packages/kernel/src/walsh-surface-energy.ts:492  0.62
    return { raw, reasonIds: [raw >= 0.62 ? "surface.general.coherence.connected" : "surface.general.coherence.fragmented"], trace: toJsonValue({ relation
- THRESHOLD packages/kernel/src/walsh-surface-energy.ts:509  0.55
    return { raw, reasonIds: [raw >= 0.55 ? "surface.general.directness.fit" : "surface.general.directness.diffuse"], trace: toJsonValue({ compression, di
- THRESHOLD packages/kernel/src/walsh-surface-energy.ts:535  0.45
    return { raw, reasonIds: [raw >= 0.45 ? "surface.general.novel" : "surface.general.repetitive_prior"], trace: toJsonValue({ memorySurfaceCount: surfac
- THRESHOLD packages/kernel/src/walsh-surface-energy.ts:582  0.28
    return weightedJaccard(featureSet(normalizedText, 256), featureSet(surface, 256)) >= 0.28;
- THRESHOLD packages/kernel/src/walsh-surface-energy.ts:689  0.26
    return weightedJaccard(featureSet(candidate.text, 384), featureSet(claim.text, 256)) >= 0.26;
- THRESHOLD packages/kernel/src/walsh-surface-energy.ts:775  0.88
    if (fragment.raw > 0.88 && stats.surfaceUnitCount > 0) add("surface.reject.phrase_salad", fragment.trace);
- THRESHOLD packages/kernel/src/walsh-surface-energy.ts:1023  0.85
    if ("dimension" in feature) return feature.status === "explicit" && feature.confidence >= 0.85;

## packages/kernel/src/multilingual-acquisition.ts  (3 vectors, 3 thresholds)
- VECTOR packages/kernel/src/multilingual-acquisition.ts:133 [sums to 1]  [0.32, 0.26, 0.18, 0.24]
    const competence = clamp01(0.32 * scriptCoverage + 0.26 * ngramCoverage + 0.18 * continuationCoverage + 0.24 * evidenceGrounding);
- VECTOR packages/kernel/src/multilingual-acquisition.ts:134 [sums to 1]  [0.35, 0.25, 0.2, 0.2]
    const confidence = clamp01(0.35 * Math.min(1, profile.charNgrams.length / 96) + 0.25 * Math.min(1, profile.symbolShapes.length / 24) + 0.2 * Math.min(
- VECTOR packages/kernel/src/multilingual-acquisition.ts:158 [sums to 1]  [0.28, 0.22, 0.32, 0.18]
    const alignment = clamp01(0.28 * scriptOverlap + 0.22 * shapeOverlap + 0.32 * charNgramOverlap + 0.18 * continuationOverlap);
- THRESHOLD packages/kernel/src/multilingual-acquisition.ts:135  0.62..0.48
    const recommendedAction = competence >= 0.62 && confidence >= 0.48
- THRESHOLD packages/kernel/src/multilingual-acquisition.ts:137  0.38
    : competence >= 0.38
- THRESHOLD packages/kernel/src/multilingual-acquisition.ts:175  0.22
    }).filter(item => item.priority > 0.22).sort((a, b) => b.priority - a.priority);

## packages/kernel/src/program-planner.ts  (3 vectors, 3 thresholds)
- VECTOR packages/kernel/src/program-planner.ts:228 [sums to 1]  [0.6, 0.25, 0.15]
    const support = clamp01(0.6 * entailment.support + 0.25 * entailment.faithfulnessLcb + 0.15 * (1 - entailment.contradiction));
- VECTOR packages/kernel/src/program-planner.ts:247  [0.35, 0.2, 0.2]
    confidence: clamp01(0.25 + 0.35 * selected.score + 0.2 * support + 0.2 * coupling),
- VECTOR packages/kernel/src/program-planner.ts:1048 [sums to 1]  [0.3, 0.45, 0.25]
    const exampleSupport = clamp01(0.3 * input.support + 0.45 * input.coupling + 0.25 * Math.min(1, input.evidenceCount / 8));
- THRESHOLD packages/kernel/src/program-planner.ts:1100  0.48
    if (input.shape.energy.testGap > 0.48) risks.push({ id: "risk.validation_gap", severity: "warning", reason: "test command or validation evidence is in
- THRESHOLD packages/kernel/src/program-planner.ts:1101  0.64
    if (input.blueprint.unbackedSynthesisRisk > 0.64) risks.push({ id: "risk.unbacked_synthesis", severity: "error", reason: "blueprint source coupling is
- THRESHOLD packages/kernel/src/program-planner.ts:1346  0.82
    allowedToEmit: input.entailment.semanticVerdict !== "contradicted" && operation.risk < 0.82

## packages/kernel/src/program.ts  (3 vectors, 3 thresholds)
- VECTOR packages/kernel/src/program.ts:62 [sums to 1]  [0.55, 0.25, 0.2]
    const proofStrength = Math.min(1, 0.55 * input.entailment.support + 0.25 * input.entailment.faithfulnessLcb + 0.2 * (1 - input.entailment.contradictio
- VECTOR packages/kernel/src/program.ts:171 [sums to 1]  [0.5, 0.3, 0.2]
    const proofPressure = 0.5 * entailment.support + 0.3 * entailment.faithfulnessLcb + 0.2 * (1 - entailment.contradiction);
- VECTOR packages/kernel/src/program.ts:189 [sums to 1]  [0.55, 0.35, 0.1]
    0.55 * evidenceCoupling + 0.35 * proofPressure + 0.1 * Math.min(1, evidence.length / 4)
- THRESHOLD packages/kernel/src/program.ts:73  0.08
    .filter(family => family.activation > 0.08)
- THRESHOLD packages/kernel/src/program.ts:102  0.45
    status: input.entailment.contradiction > 0.45 ? "failed" : input.entailment.contradiction > 0.2 ? "warning" : "passed",
- THRESHOLD packages/kernel/src/program.ts:124  0.62
    status: total === 0 ? "warning" : unsupported > 0.62 ? "failed" : ratio < 0.5 ? "warning" : "passed",

## packages/kernel/src/request-authority.ts  (6 vectors, 0 thresholds)
- VECTOR packages/kernel/src/request-authority.ts:252  [0.34, 0.24]
    factual: clamp01(0.42 + 0.34 * requirements.externalTruthAuthority + 0.24 * requirements.sourceDependence),
- VECTOR packages/kernel/src/request-authority.ts:253  [0.62, 0.12, 0.08]
    reasoned: clamp01(0.18 + 0.62 * requirements.inferentialDepth + 0.12 * requirements.causalReasoningDemand + 0.08 * requirements.temporalReasoningDeman
- VECTOR packages/kernel/src/request-authority.ts:254  [0.72, 0.18]
    creative: clamp01(0.10 + 0.72 * requirements.noveltyDemand + 0.18 * requirements.counterfactualDemand),
- VECTOR packages/kernel/src/request-authority.ts:255  [0.47, 0.45]
    translation: clamp01(0.08 + 0.47 * requirements.semanticPreservation + 0.45 * requirements.surfaceTransformation),
- VECTOR packages/kernel/src/request-authority.ts:256  [0.72, 0.20]
    program: clamp01(0.08 + 0.72 * requirements.executableArtifactDemand + 0.20 * requirements.formatConstraintStrength),
- VECTOR packages/kernel/src/request-authority.ts:257  [0.78, 0.14]
    action: clamp01(0.08 + 0.78 * requirements.actionCommitment + 0.14 * requirements.executableArtifactDemand)

## packages/kernel/src/ccr.ts  (2 vectors, 3 thresholds)
- VECTOR packages/kernel/src/ccr.ts:67 [sums to 1]  [0.55, 0.3, 0.15]
    const score = clamp01(0.55 * lexical + 0.3 * alpha + 0.15 * recency);
- VECTOR packages/kernel/src/ccr.ts:103 [sums to 1]  [0.55, 0.3, 0.15]
    score: clamp01(0.55 * (l1.candidates.find(c => c.evidenceId === String(span.id))?.score ?? 0) + 0.3 * causalMass + 0.15 * (supportAssessment.accepted 
- THRESHOLD packages/kernel/src/ccr.ts:70  0.03
    .filter(item => item.score > 0.03)
- THRESHOLD packages/kernel/src/ccr.ts:108  0.05
    .filter(item => item.score > 0.05)
- THRESHOLD packages/kernel/src/ccr.ts:130  0.2..0.35
    return { text, evidenceIds: [String(span.id)], lcb, accepted: lcb >= 0.2 && input.entailment.contradiction < 0.35 };

## packages/kernel/src/self-distillation.ts  (3 vectors, 2 thresholds)
- VECTOR packages/kernel/src/self-distillation.ts:59 [sums to 1]  [0.3, 0.25, 0.2, 0.15, 0.1]
    const operationalReadiness = clamp01(0.3 * input.self.fcs + 0.25 * memoryIntegrity + 0.2 * permissionIntegrity + 0.15 * ssd + 0.1 * (1 - uncertainty))
- VECTOR packages/kernel/src/self-distillation.ts:60 [sums to 1]  [0.42, 0.22, 0.18, 0.18]
    const fcs = clamp01(0.42 * input.self.fcs + 0.22 * operationalReadiness + 0.18 * memoryIntegrity + 0.18 * ssd);
- VECTOR packages/kernel/src/self-distillation.ts:61 [sums to 1]  [0.5, 0.3, 0.2]
    const dci = clamp01(0.5 * input.self.dci + 0.3 * memoryIntegrity + 0.2 * ssd);
- THRESHOLD packages/kernel/src/self-distillation.ts:92  0.15
    if (input.residual > 0.15) out.push({ target: "feature-sketches", magnitude: clamp01(input.residual), reason: "feature-sketch projection diverges from
- THRESHOLD packages/kernel/src/self-distillation.ts:93  0.45
    if (input.featureSupportCoverage < 0.45 && input.graph.nodes.length > 20) {

## packages/kernel/src/surface-realizer.ts  (2 vectors, 3 thresholds)
- VECTOR packages/kernel/src/surface-realizer.ts:223 [sums to 1]  [0.55, 0.45]
    const fit = clamp01(0.55 * weightedJaccard(features, contextFeatures) + 0.45 * candidate.fit);
- VECTOR packages/kernel/src/surface-realizer.ts:227 [sums to 1]  [0.58, 0.32, 0.1]
    return { total: clamp01(0.58 * fit + 0.32 * ngramActivation + 0.1 * candidate.fit), fit, ngramActivation, information };
- THRESHOLD packages/kernel/src/surface-realizer.ts:89  0.12
    if (input.entailment.semanticVerdict === "unknown" || support < 0.12) return [
- THRESHOLD packages/kernel/src/surface-realizer.ts:186  0.78
    if (selected.some(item => weightedJaccard(features, featureSet(item.text, 128)) > 0.78)) continue;
- THRESHOLD packages/kernel/src/surface-realizer.ts:254  0.08
    return weightedJaccard(sentenceFeatures, requestFeatures) >= 0.08 && sentenceUnits.some(unit => requestUnits.includes(unit));

## packages/kernel/src/turn-requirements.ts  (2 vectors, 3 thresholds)
- VECTOR packages/kernel/src/turn-requirements.ts:908  [0.45, 0.25]
    return finiteOr(0.45 * continuity + 0.25 * unresolved, 0);
- VECTOR packages/kernel/src/turn-requirements.ts:1066 [sums to 1]  [0.5, 0.5]
    return clamp01(0.5 * clamp01(alpha) + 0.5 * mean(finite));
- THRESHOLD packages/kernel/src/turn-requirements.ts:468  0.04
    .filter(row => Math.abs(row.contribution) >= 0.04)
- THRESHOLD packages/kernel/src/turn-requirements.ts:796  0.68
    || value.posterior < 0.68
- THRESHOLD packages/kernel/src/turn-requirements.ts:797  0.34
    || value.margin < 0.34

## packages/kernel/src/control-plane-profiles.ts  (0 vectors, 5 thresholds)
- THRESHOLD packages/kernel/src/control-plane-profiles.ts:116  0.68
    if (sequence > 0.68) return DETAIL_PROFILE_IDS[3]!;
- THRESHOLD packages/kernel/src/control-plane-profiles.ts:117  0.42
    if (clamp01(input.styleDensity ?? 0.58) < 0.42) return DETAIL_PROFILE_IDS[0]!;
- THRESHOLD packages/kernel/src/control-plane-profiles.ts:118  0.78
    if (clamp01(input.styleDensity ?? 0.58) > 0.78 || registerMass > 3.5) return DETAIL_PROFILE_IDS[2]!;
- THRESHOLD packages/kernel/src/control-plane-profiles.ts:153  0.36
    if (density < 0.36) return DETAIL_PROFILE_IDS[0]!;
- THRESHOLD packages/kernel/src/control-plane-profiles.ts:154  0.74
    if (density > 0.74) return DETAIL_PROFILE_IDS[2]!;

## packages/kernel/src/ingestion-lanes.ts  (0 vectors, 5 thresholds)
- THRESHOLD packages/kernel/src/ingestion-lanes.ts:482  0.35
    if (observation.textPreview && likelyNaturalLanguage(observation.textPreview) > 0.35) stores.add("language_memory");
- THRESHOLD packages/kernel/src/ingestion-lanes.ts:669  0.55
    if (column.naturalLanguageLikelihood > 0.55) {
- THRESHOLD packages/kernel/src/ingestion-lanes.ts:868  0.92
    if (input.numeric / n > 0.92) return input.distinct === input.present && input.present > 12 ? "identifier" : "numeric";
- THRESHOLD packages/kernel/src/ingestion-lanes.ts:869  0.85
    if (input.datetimes / n > 0.85) return "datetime";
- THRESHOLD packages/kernel/src/ingestion-lanes.ts:873  0.25..0.25
    if (input.numeric / n > 0.25 || input.datetimes / n > 0.25) return "mixed";

## packages/kernel/src/local-evidence-runtime.ts  (0 vectors, 5 thresholds)
- THRESHOLD packages/kernel/src/local-evidence-runtime.ts:174  0.025
    const alphaBoost = lexical >= 0.025 || semanticFrameBoundAligned || priorityAligned || anchorAligned || initialismAligned ? span.alpha * 0.18 : 0;
- THRESHOLD packages/kernel/src/local-evidence-runtime.ts:175  0.045
    const sessionBoost = sessionSpan && (lexical >= 0.045 || priorityAligned) ? 0.08 : 0;
- THRESHOLD packages/kernel/src/local-evidence-runtime.ts:1336  0.28
    const listRichRows = rows.filter(row => row.names.length >= 4 && row.delimiterMass >= 0.28);
- THRESHOLD packages/kernel/src/local-evidence-runtime.ts:1913  0.56
    const structurallyAdmissible = candidates.filter(candidate => candidate.quality >= 0.56);
- THRESHOLD packages/kernel/src/local-evidence-runtime.ts:3510  0.34
    const force: EpistemicForce = support >= 0.34 ? "inferred" : "conjectured";

## packages/kernel/src/candidate.ts  (2 vectors, 2 thresholds)
- VECTOR packages/kernel/src/candidate.ts:1379  [0.14, 0.08, 0.10, 0.10]
    ? Math.max(0.08, Math.min(0.45, 0.24 + 0.14 * requirementField.noveltyDemand + 0.08 * requirementField.uncertaintyTolerance - 0.10 * requirementField.
- VECTOR packages/kernel/src/candidate.ts:1412  [0.08, 0.06, 0.2]
    score: -0.28 + 0.08 * candidate.scores.actionability + 0.06 * candidate.scores.realizability - 0.2 * candidate.scores.contradiction - telemetryPenalty
- THRESHOLD packages/kernel/src/candidate.ts:850  0.34
    if (!input.entailment.evidenceIds.length && input.entailment.support < 0.34) return undefined;
- THRESHOLD packages/kernel/src/candidate.ts:1255  0.66
    ...(metrics.risk > 0.66 ? ["creative-risk-material"] : [])

## packages/kernel/src/code-learning.ts  (3 vectors, 1 thresholds)
- VECTOR packages/kernel/src/code-learning.ts:184  [0.28, 0.22, 0.18, 0.1, 0.25]
    const confidence = clamp01(0.22 + 0.28 * input.entailment.support + 0.22 * sourceCoupling + 0.18 * mean(signals.map(signal => signal.confidence)) + 0.
- VECTOR packages/kernel/src/code-learning.ts:231  [0.42, 0.22]
    const risk = clamp01(0.72 - 0.42 * input.graph.confidence + 0.22 * input.entailment.contradiction + (input.graph.signals.length ? 0 : 0.35));
- VECTOR packages/kernel/src/code-learning.ts:786 [sums to 1]  [0.25, 0.45, 0.3]
    return clamp01(0.25 * lexical + 0.45 * mean(signals.map(signal => signal.confidence)) + 0.3 * Math.min(1, evidence.length / 16));
- THRESHOLD packages/kernel/src/code-learning.ts:597  0.45
    if (input.graph.repositoryShape.hasTests || input.risk > 0.45) {

## packages/kernel/src/engineering-corpus-runtime.ts  (4 vectors, 0 thresholds)
- VECTOR packages/kernel/src/engineering-corpus-runtime.ts:115 [sums to 1]  [0.42, 0.22, 0.14, 0.12, 0.1]
    const score = clamp01(0.42 * preferred + 0.22 * item.command.confidence + 0.14 * symbolScore + 0.12 * capabilityScore + managerScore + 0.1 * item.corp
- VECTOR packages/kernel/src/engineering-corpus-runtime.ts:141  [0.34, 0.16, 0.12, 0.14]
    const score = clamp01(0.34 * entry.score + languageScore + 0.16 * pathScore + 0.12 * capabilityScore + 0.14 * corpus.summary.plannerReadiness);
- VECTOR packages/kernel/src/engineering-corpus-runtime.ts:170 [sums to 1]  [0.26, 0.24, 0.2, 0.18, 0.12]
    const score = clamp01(0.26 * corpus.summary.plannerReadiness + 0.24 * scorePresence(entrypoints.length) + 0.2 * entryScore + 0.18 * capabilityScore + 
- VECTOR packages/kernel/src/engineering-corpus-runtime.ts:371 [sums to 1]  [0.7, 0.3]
    return clamp01(0.7 * symbolScore + 0.3 * signalScore);

## packages/kernel/src/engineering-corpus.ts  (3 vectors, 1 thresholds)
- VECTOR packages/kernel/src/engineering-corpus.ts:539  [0.16, 0.16, 0.16, 0.18]
    const confidence = clamp01(0.34 + 0.16 * scorePresence(commands.length) + 0.16 * scorePresence(dependencies.length) + 0.16 * scorePresence(managerEvid
- VECTOR packages/kernel/src/engineering-corpus.ts:566  [0.24, 0.2, 0.1, 0.1]
    const confidence = clamp01(0.36 + 0.24 * scorePresence(script.command) + 0.2 * mean(script.roleEvidence.map(role => role.confidence)) + 0.1 * scorePre
- VECTOR packages/kernel/src/engineering-corpus.ts:622  [0.32, 0.34, 0.08, 0.08]
    const support = clamp01(0.18 + 0.32 * Math.min(1, manifestSupport / 2) + 0.34 * Math.min(1, importSupport / 4) + 0.08 * Math.min(1, group.scopes.size 
- THRESHOLD packages/kernel/src/engineering-corpus.ts:794  0.2..0.85
    .filter(file => file.entrypointScore > 0.2 && file.generatedScore < 0.85)

## packages/kernel/src/language.ts  (3 vectors, 1 thresholds)
- VECTOR packages/kernel/src/language.ts:595 [sums to 1]  [0.48, 0.32, 0.2]
    lexical: clamp01(0.48 * characterDistribution + 0.32 * repertoire + 0.2 * trigram),
- VECTOR packages/kernel/src/language.ts:598 [sums to 1]  [0.3, 0.22, 0.2, 0.15, 0.08, 0.05]
    score: clamp01(0.3 * characterDistribution + 0.22 * repertoire + 0.2 * trigram + 0.15 * scripts + 0.08 * shapes + 0.05 * direction)
- VECTOR packages/kernel/src/language.ts:833 [sums to 1]  [0.34, 0.33, 0.33]
    const generationReliability = clamp01(0.34 * lexicalCoverage + 0.33 * phraseFluency + 0.33 * segmentationQuality);
- THRESHOLD packages/kernel/src/language.ts:719  0.08
    .filter(row => finitePositive(row.mass) >= 0.08)

## packages/kernel/src/learning-loop.ts  (2 vectors, 2 thresholds)
- VECTOR packages/kernel/src/learning-loop.ts:1257 [sums to 1]  [0.48, 0.34, 0.18]
    const uncertainty = clamp01(1 - 0.48 * evidenceCoverage - 0.34 * graphCoverage - 0.18 * languageCoverage);
- VECTOR packages/kernel/src/learning-loop.ts:1328 [sums to 1]  [0.45, 0.35, 0.2]
    const value = clamp01(0.45 * span.alpha + 0.35 * evidenceTrust + 0.2 * (span.status === "promoted" ? 1 : 0.4));
- THRESHOLD packages/kernel/src/learning-loop.ts:541  0.45
    if (entailment.verdict === "contradicted" || proofGate === "contradicted" || entailment.contradiction > 0.45) {
- THRESHOLD packages/kernel/src/learning-loop.ts:862  0.12
    riskClass: risk <= 0.12 ? "risk.low" : "risk.medium",

## packages/kernel/src/typed-ingest.ts  (1 vectors, 3 thresholds)
- VECTOR packages/kernel/src/typed-ingest.ts:1151 [sums to 1]  [0.5, 0.32, 0.18]
    const likelihood = clamp01(0.5 * evidenceSupport + 0.32 * routeSupport + 0.18 * (1 - ambiguity));
- THRESHOLD packages/kernel/src/typed-ingest.ts:396  0.58
    .filter(cell => likelyNaturalLanguage(cell.value) > 0.58)
- THRESHOLD packages/kernel/src/typed-ingest.ts:534  0.45
    .filter(text => likelyNaturalLanguage(text) > 0.45)
- THRESHOLD packages/kernel/src/typed-ingest.ts:1592  0.65
    .filter(column => column.score >= 0.65)

## packages/kernel/src/counterfactual-cognition.ts  (0 vectors, 4 thresholds)
- THRESHOLD packages/kernel/src/counterfactual-cognition.ts:365  0.02
    .filter(item => item.score > 0.02)
- THRESHOLD packages/kernel/src/counterfactual-cognition.ts:406  0.002
    if (Math.abs(product * alphaEstimate) < 0.002) continue;
- THRESHOLD packages/kernel/src/counterfactual-cognition.ts:441  0.08..0.08
    const unsupported = effect.filter(item => item.pathSupport < 0.08 && Math.abs(item.effect) > 0.08);
- THRESHOLD packages/kernel/src/counterfactual-cognition.ts:443  0.001
    const directEffects = effect.filter(item => interventionIds.has(String(item.nodeId)) && Math.abs(item.effect) > 0.001);

## packages/kernel/src/request-requirement-learning.ts  (2 vectors, 1 thresholds)
- VECTOR packages/kernel/src/request-requirement-learning.ts:214 [sums to 1]  [0.45, 0.35, 0.20]
    const reliability = clamp01(0.45 * posterior + 0.35 * margin + 0.20 * Math.min(1, winner.count / 8));
- VECTOR packages/kernel/src/request-requirement-learning.ts:252  [0.28, 0.14]
    support: clamp01(0.58 + 0.28 * reliability + 0.14 * Math.min(1, classCoverage * 4)),
- THRESHOLD packages/kernel/src/request-requirement-learning.ts:212  0.68..0.34
    if (posterior < 0.68 || margin < 0.34) return [];

## packages/kernel/src/retrieval.ts  (1 vectors, 2 thresholds)
- VECTOR packages/kernel/src/retrieval.ts:170 [sums to 1]  [0.38, 0.24, 0.22, 0.16]
    const rawScore = clamp01(0.38 * bm25Score + 0.24 * vectorScore + 0.22 * graphScore + 0.16 * alphaScore);
- THRESHOLD packages/kernel/src/retrieval.ts:428  0.55
    if (input.graphScore > 0.2 || input.alphaScore > 0.55 || input.vectorScore > 0.45) return "support";
- THRESHOLD packages/kernel/src/retrieval.ts:428  0.45
    if (input.graphScore > 0.2 || input.alphaScore > 0.55 || input.vectorScore > 0.45) return "support";

## packages/kernel/src/connector-governance.ts  (0 vectors, 3 thresholds)
- THRESHOLD packages/kernel/src/connector-governance.ts:295  0.45
    if (risk > 0.45) return true;
- THRESHOLD packages/kernel/src/connector-governance.ts:318  0.72
    operatorGrantEligible: input.config.approval.operatorGrantEligible && input.phase !== "commit" && input.risk < 0.72,
- THRESHOLD packages/kernel/src/connector-governance.ts:348  0.45..0.72
    const quarantine = evidenceTrust < 0.45 || reasons.length > 0 || sensitive > 0.72;

## packages/kernel/src/launch-contract.ts  (0 vectors, 3 thresholds)
- THRESHOLD packages/kernel/src/launch-contract.ts:124  0.05
    if (input.entailment.contradiction > 0.05 || symbolicState === "truth.contradicted") reasonIds.push(ANSWER_BASIS_REASON_IDS.contradiction);
- THRESHOLD packages/kernel/src/launch-contract.ts:285  0.55
    reliabilityBucket: rawScore >= 0.8 ? "high" : rawScore >= 0.55 ? "medium" : "low"
- THRESHOLD packages/kernel/src/launch-contract.ts:291  0.78..0.65
    if (entailment.support >= 0.78 && entailment.faithfulnessLcb >= 0.65 && entailment.evidenceIds.length > 0) return "truth.certified";

## packages/kernel/src/safety-rail-engine.ts  (0 vectors, 3 thresholds)
- THRESHOLD packages/kernel/src/safety-rail-engine.ts:132  0.78
    if (signals.some(signal => (signal.kind === "self_harm" || signal.kind === "harm_to_others" || signal.kind === "medical_crisis") && signal.score > 0.7
- THRESHOLD packages/kernel/src/safety-rail-engine.ts:134  0.52
    if (risk > 0.52) return "high_caution";
- THRESHOLD packages/kernel/src/safety-rail-engine.ts:135  0.22
    if (risk > 0.22) return "supportive";

## packages/kernel/src/alpha-field-persistence.ts  (2 vectors, 0 thresholds)
- VECTOR packages/kernel/src/alpha-field-persistence.ts:213 [sums to 1]  [0.48, 0.18, 0.22, 0.12]
    return Math.max(0, 0.48 * featureCoupling + 0.18 * evidenceCoupling + 0.22 * node.alpha + 0.12 * prior);
- VECTOR packages/kernel/src/alpha-field-persistence.ts:455 [sums to 1]  [0.65, 0.35]
    return clamp01(0.65 * selfLoops + 0.35 * denseRows);

## packages/kernel/src/graph-surface-alignment.ts  (1 vectors, 1 thresholds)
- VECTOR packages/kernel/src/graph-surface-alignment.ts:687 [sums to 1]  [0.42, 0.22, 0.08, 0.04, 0.24]
    const cost = clamp01(0.42 * featureCost + 0.22 * structuralCost + 0.08 * massPenalty + 0.04 * priorPenalty + 0.24 * boundaryFit - anchorBonus);
- THRESHOLD packages/kernel/src/graph-surface-alignment.ts:562  0.08
    if (!selected || selected.cell.posterior < 0.08) {

## packages/kernel/src/language-induction.ts  (1 vectors, 1 thresholds)
- VECTOR packages/kernel/src/language-induction.ts:1256  [0.24, 0.22]
    const score = clamp01(0.24 * contextScore + 0.22 * countScore + shapeScore + frameScore + numberScore + symbolScore);
- THRESHOLD packages/kernel/src/language-induction.ts:1257  0.42
    if (score < 0.42) continue;

## packages/kernel/src/multilingual-translation.ts  (1 vectors, 1 thresholds)
- VECTOR packages/kernel/src/multilingual-translation.ts:567 [sums to 1]  [0.5, 0.3, 0.2]
    value: clamp01(0.5 * plan.alignmentCoverage + 0.3 * anchorPreservation + 0.2 * (1 - plan.hallucinationRisk)),
- THRESHOLD packages/kernel/src/multilingual-translation.ts:512  0.35
    return score >= 0.35;

## packages/kernel/src/program-repair-kernel.ts  (1 vectors, 1 thresholds)
- VECTOR packages/kernel/src/program-repair-kernel.ts:1020 [sums to 1]  [0.55, 0.45]
    const confidence = clamp01(0.55 * diagnosticConfidence + 0.45 * operationConfidence);
- THRESHOLD packages/kernel/src/program-repair-kernel.ts:1029  0.45
    approvalRequired: estimatedRisk > 0.45 || operations.some(op => op.kind === "dependency" || op.kind === "config"),

## packages/kernel/src/proof-carrying-answer.ts  (1 vectors, 1 thresholds)
- VECTOR packages/kernel/src/proof-carrying-answer.ts:282 [sums to 1]  [0.55, 0.25, 0.2]
    .map(atom => ({ atom, score: 0.55 * jaccard(target, atom.symbols) + 0.25 * coverageOf(target, atom.symbols) + 0.2 * weightedJaccard([...target], atom.
- THRESHOLD packages/kernel/src/proof-carrying-answer.ts:181  0.25..0.25
    if (scoreA >= 0.25 && scoreB >= 0.25 && unionScore >= cfg.conjunctionJaccard && unsupported <= cfg.unsupportedSymbolCeiling) {

## packages/kernel/src/semantic-memory-index.ts  (2 vectors, 0 thresholds)
- VECTOR packages/kernel/src/semantic-memory-index.ts:452 [sums to 1]  [0.45, 0.28, 0.22, 0.05]
    scores.set(`vector:node:${String(node.id)}`, clamp01(0.45 * direct + 0.28 * evidence + 0.22 * feature + 0.05 * node.alpha));
- VECTOR packages/kernel/src/semantic-memory-index.ts:490  [0.32, 0.29, 0.2, 0.1, 0.09, 0.08]
    const rawScore = clamp01(0.32 * lexical + 0.29 * vector + 0.2 * graph + 0.1 * temporal + 0.09 * alpha + 0.08 * featureFit);

## packages/kernel/src/training-orchestrator.ts  (2 vectors, 0 thresholds)
- VECTOR packages/kernel/src/training-orchestrator.ts:235  [0.3, 0.26, 0.2, 0.18]
    const score = clamp01(0.3 * trust + 0.26 * span.alpha + 0.2 * novelty + 0.18 * coverage + proofUse);
- VECTOR packages/kernel/src/training-orchestrator.ts:359 [sums to 1]  [0.4, 0.35, 0.25]
    weight: clamp01(0.4 * entailment.support + 0.35 * entailment.faithfulnessLcb + 0.25 * (1 - entailment.contradiction)),

## packages/kernel/src/translation-correction-engine.ts  (1 vectors, 1 thresholds)
- VECTOR packages/kernel/src/translation-correction-engine.ts:306 [sums to 1]  [0.55, 0.25, 0.2]
    return clamp01(0.55 * overlapOnSource + 0.25 * jaccard + 0.2 * lenRatio);
- THRESHOLD packages/kernel/src/translation-correction-engine.ts:159  0.95
    const passed = totalLoss < 0.25 && entityPreservation > 0.9 && numberPreservation > 0.95;

## packages/kernel/src/assistant-force.ts  (0 vectors, 2 thresholds)
- THRESHOLD packages/kernel/src/assistant-force.ts:113  0.52
    const contradicted = contradiction >= 0.52 || truthState === "truth.contradicted" || proof === "scce.verdict.001";
- THRESHOLD packages/kernel/src/assistant-force.ts:177  0.34
    } else if (!learnedForce && (input.epistemicForce === "inferred" || support >= 0.34)) {

## packages/kernel/src/discourse-state.ts  (0 vectors, 2 thresholds)
- THRESHOLD packages/kernel/src/discourse-state.ts:89  0.72
    ...(surface.specificityMass < 0.72 ? [DISCOURSE_SIGNAL_IDS.currentSurfaceSparse] : [DISCOURSE_SIGNAL_IDS.currentSurfaceSpecific]),
- THRESHOLD packages/kernel/src/discourse-state.ts:97  0.45
    if (namesOwnSubject || bindingConfidence < 0.45) return undefined;

## packages/kernel/src/production-turn-runtime.ts  (0 vectors, 2 thresholds)
- THRESHOLD packages/kernel/src/production-turn-runtime.ts:1327  0.12
    sourceAnchoringRequired: requestedAuthority !== "creative" || authorityProjection.scoreMargin < 0.12,
- THRESHOLD packages/kernel/src/production-turn-runtime.ts:2221  0.72
    && proposalContradiction < 0.72

## packages/kernel/src/runtime-graph-retrieval.ts  (0 vectors, 2 thresholds)
- THRESHOLD packages/kernel/src/runtime-graph-retrieval.ts:1680  0.04
    if (!ranked.length || ranked[0]!.score < 0.04) return undefined;
- THRESHOLD packages/kernel/src/runtime-graph-retrieval.ts:2393  0.34
    return codeLines / lines.length >= 0.34;

## packages/kernel/src/runtime-motion.ts  (0 vectors, 2 thresholds)
- THRESHOLD packages/kernel/src/runtime-motion.ts:320  0.66
    if (kernelNumber(trace.unsupportedFactualAssertion) > 0 || kernelNumber(trace.risk) > 0.66) return false;
- THRESHOLD packages/kernel/src/runtime-motion.ts:366  0.18
    return !hasSemanticSurface || !hasEvidenceRoute && support < 0.18

## packages/kernel/src/surface-quality.ts  (0 vectors, 2 thresholds)
- THRESHOLD packages/kernel/src/surface-quality.ts:186  0.65
    || uniqueTokenRatio > 0.65
- THRESHOLD packages/kernel/src/surface-quality.ts:244  0.55
    && uniqueTokenRatio <= 0.55;

## packages/kernel/src/voice-profile.ts  (0 vectors, 2 thresholds)
- THRESHOLD packages/kernel/src/voice-profile.ts:67  0.55
    if (dominant / total < 0.55) return "mixed";
- THRESHOLD packages/kernel/src/voice-profile.ts:78  0.15
    if (questionRatio >= 0.15) habits.push("frequent_rhetorical_questions");

## packages/kernel/src/causal-estimation.ts  (1 vectors, 0 thresholds)
- VECTOR packages/kernel/src/causal-estimation.ts:159 [sums to 1]  [0.55, 0.25, 0.2]
    return clampSigned(0.55 * direct + 0.25 * mediatedPathScore + 0.2 * (outcomeAlpha - treatmentAlpha));

## packages/kernel/src/creative-event-compatibility.ts  (1 vectors, 0 thresholds)
- VECTOR packages/kernel/src/creative-event-compatibility.ts:380 [sums to 1]  [0.52, 0.34, 0.14]
    score: clamp01(0.52 * lexicalFit + 0.34 * posterior + 0.14 * supportFit)

## packages/kernel/src/population-collapse-guard.ts  (1 vectors, 0 thresholds)
- VECTOR packages/kernel/src/population-collapse-guard.ts:40 [sums to 1]  [0.5, 0.5]
    return clamp01(0.5 * klDivergenceBits(p, m) + 0.5 * klDivergenceBits(q, m));

## packages/kernel/src/powerwalk.ts  (1 vectors, 0 thresholds)
- VECTOR packages/kernel/src/powerwalk.ts:1570 [sums to 1]  [0.55, 0.45]
    return clamp(1 + 0.55 * m + 0.45 * spread, 1, 180);

## packages/kernel/src/prediction.ts  (1 vectors, 0 thresholds)
- VECTOR packages/kernel/src/prediction.ts:265 [sums to 1]  [0.55, 0.28, 0.17]
    return clamp01(0.55 * surfaceMass + 0.28 * (1 - evidenceMass) + 0.17 * priorMass);

## packages/kernel/src/evidence-gist.ts  (0 vectors, 1 thresholds)
- THRESHOLD packages/kernel/src/evidence-gist.ts:27  0.35
    return lower / words.length >= 0.35;

## packages/kernel/src/language-identity.ts  (0 vectors, 1 thresholds)
- THRESHOLD packages/kernel/src/language-identity.ts:101  0.08
    return [...signature.scripts].filter(row => row.mass >= 0.08).sort((a, b) => b.mass - a.mass)[0]?.script ?? "script:unknown";

## packages/kernel/src/paired-anti-unification.ts  (0 vectors, 1 thresholds)
- THRESHOLD packages/kernel/src/paired-anti-unification.ts:696  0.98
    && construction.support.cycleRecall >= 0.98

## packages/kernel/src/surface-language-runtime.ts  (0 vectors, 1 thresholds)
- THRESHOLD packages/kernel/src/surface-language-runtime.ts:541  0.12
    .filter(row => row.mass >= 0.12)

## packages/kernel/src/turn-request-control.ts  (0 vectors, 1 thresholds)
- THRESHOLD packages/kernel/src/turn-request-control.ts:41  0.6..0.6
    if (requirements.surfaceTransformation >= 0.6 && requirements.semanticPreservation >= 0.6) {

## packages/kernel/src/turn-requirement-calibration.ts  (0 vectors, 1 thresholds)
- THRESHOLD packages/kernel/src/turn-requirement-calibration.ts:90  0.02
    if (Math.abs(error) < 0.02) continue;

# Summary

weight vectors:        140  (103 sum to 1)
tuned thresholds:      274  (deduplicated per file, bands counted once, conventional excluded)
files carrying them:   73
TOTAL OBJECTS:         414

Top files:
   28  packages/kernel/src/language-memory-runtime.ts  (17v 11t)
   22  packages/kernel/src/learned-graph-prior-runtime.ts  (3v 19t)
   21  packages/kernel/src/graph-edge-quality.ts  (4v 17t)
   18  packages/kernel/src/tool-cognition.ts  (9v 9t)
   17  packages/kernel/src/semantic-obligations.ts  (4v 13t)
   15  packages/kernel/src/semantic-proof-system.ts  (6v 9t)
   15  packages/kernel/src/mouth.ts  (0v 15t)
   13  packages/kernel/src/question-slot-planner.ts  (0v 13t)
   11  packages/kernel/src/judge.ts  (10v 1t)
   10  packages/kernel/src/dialogue-pragmatics.ts  (2v 8t)
   10  packages/kernel/src/proof-calculus.ts  (1v 9t)
   10  packages/kernel/src/translation.ts  (3v 7t)
