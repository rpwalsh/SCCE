import { describe, expect, it } from "vitest";
import {
  createClock,
  createCorrectionMemory,
  createHasher,
  createIdFactory,
  createLanguageMemoryRuntime,
  createMouth,
  defaultSyntheticToolCapabilities,
  detectFieldGaps,
  planLearningSources,
  promoteValidatedRecords,
  quarantineAcquisition,
  runLearningLoop,
  runToolCapability,
  toJsonValue,
  validateLearningLoopHydrationContract,
  validateQuarantine,
  type AcquiredRecord,
  type AcquisitionResult,
  type ConstructGraph,
  type ContinueDecision,
  type EvidenceSpan,
  type FieldState,
  type LanguageProfile,
  type LearningPolicy,
  type SemanticEntailmentResult,
  type SourceVersion,
  type SyntheticSourceMaterial,
  type ToolCapability
} from "../index.js";
import { proveClaim, type ProofClaim, type ProofEvidenceRecord } from "../semantic-proof-engine.js";

describe("Phase 7 tool-driven learning loop", () => {
  const clock = createClock({ fixedTime: 70000, stepMs: 1 });
  const hasher = createHasher();
  const ids = createIdFactory({ clock, hasher, deterministicReplay: true });
  const claim = measurementClaim();
  const prior = measurementEvidence("prior.measurement", "learned_concept_prior", 42);
  const direct = measurementEvidence("direct.measurement", "direct_evidence", 42);
  const contradiction = measurementEvidence("direct.contradiction", "direct_evidence", 17);

  it("unsupported_prior_only proof creates missing direct evidence and prior-only gaps", () => {
    const proof = proveClaim({ claim, candidateEvidence: [prior] });
    const gaps = detectFieldGaps({ proofResults: [proof] });

    expect(proof.verdict).toBe("unsupported_prior_only");
    expect(gaps.map(gap => gap.gapKindId)).toEqual(expect.arrayContaining(["gap.missing_direct_evidence", "gap.prior_only_support"]));
  });

  it("contradicted proof creates contradiction gap", () => {
    const proof = proveClaim({ claim, candidateEvidence: [contradiction] });
    const gaps = detectFieldGaps({ proofResults: [proof] });

    expect(proof.verdict).toBe("contradicted");
    expect(gaps.map(gap => gap.gapKindId)).toContain("gap.contradiction_present");
  });

  it("source planning ranks high EVI and low risk first", () => {
    const proof = proveClaim({ claim, candidateEvidence: [prior] });
    const gaps = detectFieldGaps({ proofResults: [proof] });
    const plans = planLearningSources(gaps, defaultSyntheticToolCapabilities(), policy());

    expect(plans.length).toBeGreaterThan(1);
    expect(plans[0]?.evi).toBeGreaterThanOrEqual(plans[1]?.evi ?? 0);
    expect(plans[0]?.requiredToolCapabilityIds).toContain("tool.fixture.evidence_lookup");
  });

  it("unsafe capability is rejected", () => {
    const proof = proveClaim({ claim, candidateEvidence: [prior] });
    const gaps = detectFieldGaps({ proofResults: [proof] });
    const unsafe: ToolCapability = {
      ...required(defaultSyntheticToolCapabilities().find(item => item.id === "tool.fixture.evidence_lookup")),
      permissionClass: "permission.external_account",
      risk: 0.96,
      maxCost: 0.96
    };

    expect(planLearningSources(gaps, [unsafe], policy())).toEqual([]);
  });

  it("synthetic tool acquisition returns source version and evidence span", () => {
    const plan = required(planLearningSources(detectFieldGaps({ proofResults: [proveClaim({ claim, candidateEvidence: [prior] })] }), defaultSyntheticToolCapabilities(), policy())[0]);
    const capability = required(defaultSyntheticToolCapabilities().find(item => plan.requiredToolCapabilityIds.includes(item.id)));
    const acquisition = runToolCapability(plan, capability, { fixtures: { evidence: [directMaterial()] }, policy: policy(), now: clock.now() });

    expect(acquisition.errors).toEqual([]);
    expect(acquisition.sourceVersions).toHaveLength(1);
    expect(acquisition.evidenceSpans).toHaveLength(1);
    expect(acquisition.acquiredRecords[0]?.proofEvidence?.forceClass).toBe("direct_evidence");
  });

  it("quarantine validation rejects direct evidence missing source span", () => {
    const badRecord: AcquiredRecord = {
      id: "record.bad_direct",
      recordKindId: "record.direct_evidence",
      forceClass: "direct_evidence",
      metadata: {}
    };
    const acquisition = acquisitionFixture([badRecord]);
    const validation = validateQuarantine(quarantineAcquisition(acquisition, policy()), policy({ proofClaims: [claim] }));

    expect(validation.rejectedRecords.map(record => record.id)).toContain("record.bad_direct");
    expect(validation.rejectionReasons.map(item => item.reasonCode)).toContain("validation.reject.direct_evidence_missing_source_span");
  });

  it("learned prior promotes only as prior", () => {
    const plan = required(planLearningSources(detectFieldGaps({ proofResults: [proveClaim({ claim, candidateEvidence: [prior] })] }), defaultSyntheticToolCapabilities(), policy())[0]);
    const capability = required(defaultSyntheticToolCapabilities().find(item => plan.requiredToolCapabilityIds.includes(item.id)));
    const acquisition = runToolCapability(plan, capability, { fixtures: { evidence: [priorMaterial()] }, policy: policy(), now: clock.now() });
    const validation = validateQuarantine(quarantineAcquisition(acquisition, policy()), policy({ proofClaims: [claim] }));
    const promotion = promoteValidatedRecords(validation, policy());

    expect(promotion.safeToPromote).toBe(true);
    expect(promotion.updatePlan.languagePriorsToAdd.length).toBeGreaterThan(0);
    expect(promotion.updatePlan.evidenceRecordsToAdd).toEqual([]);
  });

  it("validation surfaces contradiction candidate", () => {
    const record = acquiredRecordFromMaterial(directMaterial(17));
    const validation = validateQuarantine(quarantineAcquisition(acquisitionFixture([record]), policy()), policy({ proofClaims: [claim] }));

    expect(validation.contradictionCandidates).toHaveLength(1);
    expect(validation.proofAdmissibilityChecks[0]?.verdict).toBe("contradicted");
  });

  it("promotion creates update plan without DB mutation", () => {
    const record = acquiredRecordFromMaterial(directMaterial());
    const validation = validateQuarantine(quarantineAcquisition(acquisitionFixture([record]), policy()), policy({ proofClaims: [claim] }));
    const promotion = promoteValidatedRecords(validation, policy());

    expect(promotion.safeToPromote).toBe(true);
    expect(promotion.updatePlan.evidenceRecordsToAdd.map(span => String(span.id))).toContain(required(record.evidenceSpanId));
    expect(promotion.updatePlan.sourceVersionsToAdd.map(source => String(source.sourceVersionId))).toContain(required(record.sourceVersionId));
    expect(promotion.updatePlan.eventsToAdd.length).toBeGreaterThan(0);
  });

  it("full loop converts prior-only unsupported claim into promoted direct-evidence update plan", () => {
    const priorProof = proveClaim({ claim, candidateEvidence: [prior] });
    const result = runLearningLoop({
      proofResults: [priorProof],
      proofClaims: [claim],
      proofEvidence: [prior],
      toolCapabilities: defaultSyntheticToolCapabilities(),
      fixtures: { evidence: [directMaterial()] },
      policy: policy({ proofClaims: [claim], proofEvidence: [prior] }),
      now: clock.now()
    });

    expect(result.gaps.map(gap => gap.gapKindId)).toContain("gap.missing_direct_evidence");
    expect(result.acquisitionResults[0]?.evidenceSpans.length).toBe(1);
    expect(result.promotionDecisions.some(decision => decision.safeToPromote)).toBe(true);
    expect(result.updatePlans.flatMap(plan => plan.evidenceRecordsToAdd).length).toBeGreaterThan(0);
    expect(result.continueDecision.safeToAssert).toBe(true);
    expect(result.continueDecision.proofAfterUpdate?.verdict).toBe("certified");
  });

  it("Mouth respects learning continue decision", async () => {
    const languageRuntime = createLanguageMemoryRuntime({ idFactory: ids, hasher });
    const mouth = createMouth({
      languageMemory: languageRuntime,
      correctionMemory: createCorrectionMemory({ idFactory: ids, hasher }),
      hashText: text => hasher.digestHex(text)
    });
    const source = sourceVersion("fixture://learning/mouth");
    const evidence = evidenceSpan(source, "pump pressure is 42 psi");
    const spoken = await mouth.speak({
      construct: construct(),
      field: emptyField(),
      languageProfile: languageProfile(source),
      evidence: [evidence],
      entailment: certifiedEntailment(evidence),
      languageMemory: languageRuntime.hydrateFromImportedBrain({ importRunId: "learning-loop", models: [], observations: [], units: [], patterns: [], semanticFrames: [] }),
      learningDecision: insufficientDecision(),
      targetLanguage: "fixture-language"
    });

    expect(spoken.force).toBe("underdetermined");
    expect(spoken.surfacePlan.forceBindings[0]?.force).toBe("underdetermined");
    expect(JSON.stringify(spoken.surfacePlan.orderedPoints[0]?.realizationConstraints)).toContain("continue.insufficient_evidence");
  });

  it("hydration contract validates learning-loop records", () => {
    const result = runLearningLoop({
      proofResults: [proveClaim({ claim, candidateEvidence: [prior] })],
      proofClaims: [claim],
      proofEvidence: [prior],
      toolCapabilities: defaultSyntheticToolCapabilities(),
      fixtures: { evidence: [directMaterial()] },
      policy: policy({ proofClaims: [claim], proofEvidence: [prior] }),
      now: clock.now()
    });
    const validation = validateLearningLoopHydrationContract(result.hydration);
    const recordTypes = result.hydration.records.map(record => record.recordTypeId);

    expect(validation).toEqual({ valid: true, diagnostics: [] });
    expect(recordTypes).toEqual(expect.arrayContaining([
      "learning.record.field_gap",
      "learning.record.learning_need",
      "learning.record.source_plan",
      "learning.record.tool_capability",
      "learning.record.acquisition_result",
      "learning.record.quarantine",
      "learning.record.validation",
      "learning.record.promotion",
      "learning.record.update_plan",
      "learning.record.continue_decision"
    ]));
    expect(result.hydration.dryRunPlan.length).toBe(result.hydration.records.length);
  });

  function measurementClaim(): ProofClaim {
    return {
      id: "claim.measurement.pressure",
      subject: { id: "sensor.alpha", kindId: "kind.measurement.subject" },
      relationId: "relation.measurement.quantity",
      object: { id: "pressure", kindId: "kind.measurement.object" },
      quantity: { value: 42, unitId: "unit.psi", tolerance: 0 },
      polarityId: "polarity.positive",
      modalityId: "modality.asserted",
      requiredSourceBinding: true
    };
  }

  function measurementEvidence(id: string, forceClass: ProofEvidenceRecord["forceClass"], value: number): ProofEvidenceRecord {
    return {
      id,
      forceClass,
      sourceVersionId: forceClass === "direct_evidence" ? "source_version_measurement" : undefined,
      evidenceSpanId: forceClass === "direct_evidence" ? id : undefined,
      subject: { id: "sensor.alpha", kindId: "kind.measurement.subject" },
      relationId: "relation.measurement.quantity",
      object: { id: "pressure", kindId: "kind.measurement.object" },
      quantity: { value, unitId: "unit.psi", tolerance: 0 },
      polarityId: "polarity.positive",
      modalityId: "modality.asserted"
    };
  }

  function directMaterial(value = 42): SyntheticSourceMaterial {
    return {
      id: `fixture.direct.${value}`,
      sourceKindId: "source.synthetic.fixture_evidence",
      uri: `fixture://evidence/pressure-${value}`,
      mediaType: "text/plain",
      text: `sensor alpha pressure ${value} psi`,
      forceClass: "direct_evidence",
      proofEvidence: measurementEvidence(`fixture.proof.${value}`, "direct_evidence", value)
    };
  }

  function priorMaterial(): SyntheticSourceMaterial {
    return {
      id: "fixture.prior.pressure",
      sourceKindId: "source.synthetic.fixture_evidence",
      uri: "fixture://evidence/pressure-prior",
      mediaType: "text/plain",
      text: "sensor alpha pressure tends to be 42 psi",
      forceClass: "learned_language_prior",
      proofEvidence: measurementEvidence("fixture.prior.proof", "learned_language_prior", 42),
      languagePrior: toJsonValue({ phrase: "sensor alpha pressure tends to be 42 psi" })
    };
  }

  function acquiredRecordFromMaterial(material: SyntheticSourceMaterial): AcquiredRecord {
    const plan = required(planLearningSources(detectFieldGaps({ proofResults: [proveClaim({ claim, candidateEvidence: [prior] })] }), defaultSyntheticToolCapabilities(), policy())[0]);
    const capability = required(defaultSyntheticToolCapabilities().find(item => plan.requiredToolCapabilityIds.includes(item.id)));
    return required(runToolCapability(plan, capability, { fixtures: { evidence: [material] }, policy: policy({ proofClaims: [claim] }), now: clock.now() }).acquiredRecords[0]);
  }

  function acquisitionFixture(records: AcquiredRecord[]): AcquisitionResult {
    return {
      id: `acquisition.fixture.${records.map(record => record.id).join(".")}`,
      sourcePlanId: "source_plan.fixture",
      toolCapabilityId: "tool.fixture.evidence_lookup",
      acquiredRecords: records,
      rawSourceRefs: records.map(record => record.sourceVersion?.canonicalUri ?? record.id),
      sourceVersions: records.flatMap(record => record.sourceVersion ? [record.sourceVersion] : []),
      evidenceSpans: records.flatMap(record => record.evidenceSpan ? [record.evidenceSpan] : []),
      warnings: [],
      errors: [],
      costObserved: 0.01,
      sideEffectsObserved: [],
      trace: {}
    };
  }

  function policy(extra: Partial<LearningPolicy> = {}): Partial<LearningPolicy> {
    return {
      maxRisk: 0.45,
      maxCost: 0.45,
      maxToolRuns: 2,
      allowedPermissionClasses: ["permission.synthetic_local", "permission.temp_fixture"],
      allowedSideEffectClasses: ["side_effect.none", "side_effect.temp_read"],
      requireDeterministicTools: true,
      quarantinePolicyId: "learning.quarantine.synthetic_required",
      validationPolicyId: "learning.validation.source_span_force_class",
      promotionPolicyId: "learning.promotion.update_plan_only",
      ...extra
    };
  }

  function sourceVersion(uri: string): SourceVersion {
    const contentHash = ids.contentHash(uri);
    return {
      sourceId: ids.sourceId("learning-loop", uri),
      sourceVersionId: ids.sourceVersionId(uri),
      namespace: "fixture",
      canonicalUri: uri,
      contentHash,
      mediaType: "text/plain",
      observedAt: clock.now(),
      byteLength: uri.length,
      trust: 1,
      metadata: {}
    };
  }

  function evidenceSpan(source: SourceVersion, text: string): EvidenceSpan {
    const contentHash = ids.contentHash(text);
    return {
      id: ids.evidenceId({ sourceVersionId: source.sourceVersionId, byteStart: 0, byteEnd: text.length, spanHash: contentHash }),
      sourceId: source.sourceId,
      sourceVersionId: source.sourceVersionId,
      chunkId: ids.chunkId({ sourceVersionId: source.sourceVersionId, byteStart: 0, byteEnd: text.length, chunkHash: contentHash }),
      contentHash,
      mediaType: "text/plain",
      byteStart: 0,
      byteEnd: text.length,
      charStart: 0,
      charEnd: text.length,
      text,
      textPreview: text,
      languageHints: {},
      scriptHints: {},
      trustVector: { trust: 1 },
      provenance: {},
      features: ["sym:pump", "sym:pressure", "sym:42"],
      status: "promoted",
      alpha: 1,
      observedAt: clock.now()
    };
  }

  function construct(): ConstructGraph {
    const episodeId = ids.episodeId();
    return {
      id: ids.constructId("learning-mouth"),
      episodeId,
      forceVector: {},
      nodes: [{ id: "construct.answer", kind: "construct:answer", label: "fixture", metadata: {} }],
      edges: [],
      artifacts: []
    };
  }

  function certifiedEntailment(evidence: EvidenceSpan): SemanticEntailmentResult {
    return {
      claim: { id: ids.claimId("pump pressure is 42 psi"), text: "pump pressure is 42 psi", normalized: "pump pressure is 42 psi", features: evidence.features, polarity: 1 },
      verdict: "entailed",
      semanticVerdict: "entailed",
      force: "proved",
      support: 0.92,
      contradiction: 0,
      faithfulnessLcb: 0.82,
      confidence: { verdict: "entailed", support: 0.92, contradiction: 0, faithfulnessLcb: 0.82, supportingEvidence: 1, sourceVersions: [String(evidence.sourceVersionId)], structuralCoverage: 1, roleCoverage: 1, relationCompatibility: 1, transformationSupport: 1, causalMass: 0.2, stability: 0.9, satisfiedObligations: 1, requiredObligations: 1 },
      scores: { structuralCoverage: 1, roleCoverage: 1, relationCompatibility: 1, transformationSupport: 1, causalMass: 0.2, faithfulnessLCB: 0.82, contradiction: 0, stability: 0.9 },
      obligations: [{ id: "obligation.fixture", kind: "entity", status: "satisfied", claimText: "pump pressure is 42 psi", evidenceIds: [evidence.id], sourceVersionIds: [evidence.sourceVersionId], support: 0.9, contradiction: 0, required: true, reason: "fixture", metadata: {} }],
      mappings: [],
      transforms: [],
      counterexamples: [],
      missing: [],
      evidenceIds: [evidence.id],
      boundaries: [],
      proof: {
        id: ids.proofId({ claimId: ids.claimId("pump pressure is 42 psi"), evidenceIds: [evidence.id], transforms: ["fixture"], validatorVersion: "fixture" }),
        claimId: ids.claimId("pump pressure is 42 psi"),
        verdict: "proved",
        confidence: {},
        proofGraph: { nodes: [], edges: [] },
        evidenceIds: [evidence.id],
        transformIds: [],
        scores: { semanticProofEngine: { verdict: "certified" } },
        validatorVersion: "fixture",
        createdAt: clock.now()
      }
    };
  }

  function insufficientDecision(): ContinueDecision {
    return {
      id: "continue.fixture.insufficient",
      decisionKindId: "continue.insufficient_evidence",
      continueAnswering: false,
      askClarification: false,
      answerWithCaveat: false,
      deferDueToInsufficientEvidence: true,
      reportContradiction: false,
      reportUnsupported: false,
      safeToAssert: false,
      reasonCodes: ["gap.missing_direct_evidence"],
      trace: {}
    };
  }

  function languageProfile(source: SourceVersion): LanguageProfile {
    return {
      id: "fixture-language",
      sourceVersionId: source.sourceVersionId,
      scripts: [{ script: "fixture-script", mass: 1 }],
      symbolShapes: [],
      charNgrams: [],
      direction: "unknown",
      entropy: 0.1,
      createdAt: clock.now()
    };
  }

  function emptyField(): FieldState {
    const matrix = { nodes: [], values: [] };
    return {
      requestFeatures: [],
      seeds: [],
      active: [],
      ppf: [],
      ppfDiagnostics: {},
      alphaTrace: {
        alpha: 0.7,
        thresholds: { virtual: 0.49, visible: 0.7, bonded: 0.8366600265340756, structural: 0.51 },
        relations: [],
        adjacency: matrix,
        laplacian: matrix,
        normalizedLaplacian: matrix,
        surfaces: { pressure: 0, drift: 0, contradiction: 0, bond: 0, risk: 0, actionability: 0 },
        contradictionMass: 0,
        bondedLeakage: 0
      },
      causalMass: []
    };
  }

  function required<T>(value: T | undefined): T {
    if (value === undefined) throw new Error("missing required fixture value");
    return value;
  }
});
