import { describe, expect, it } from "vitest";
import {
  createClock,
  createCorrectionMemory,
  createHasher,
  createIdFactory,
  createLanguageMemoryRuntime,
  createMouth,
  featureSet,
  toJsonValue,
  type ConstructGraph,
  type EvidenceSpan,
  type FieldState,
  type LanguageProfile,
  type SemanticEntailmentResult,
  type SourceVersion
} from "../index.js";
import { proveClaim, type ProofClaim, type ProofEvidenceRecord, type ProofPolicy, type SemanticProofResult } from "../semantic-proof-engine.js";

describe("semantic proof engine vertical slice", () => {
  const basePolicy: ProofPolicy = {
    defaultModalityId: "modality.asserted",
    defaultPolarityId: "polarity.positive",
    modalityStrength: {
      "modality.asserted": 1,
      "modality.reported": 0.82,
      "modality.estimated": 0.72,
      "modality.planned": 0.52,
      "modality.possible": 0.34
    },
    polarityContradictions: [["polarity.positive", "polarity.negative"]],
    relationCompatibility: {
      "relation.test.has_status": ["relation.test.has_value"]
    }
  };

  it("certifies direct evidence with exact source and span bindings", () => {
    const result = proveClaim({ claim: claim(), candidateEvidence: [evidence()], policy: basePolicy });
    expect(result.verdict).toBe("certified");
    expect(result.truthState).toBe("truth.certified");
    expect(result.certifiedEvidenceIds).toEqual(["evidence:1"]);
    expect(result.obligations.every(item => item.passed)).toBe(true);
  });

  it("rejects matching learned priors as unsupported prior-only proof", () => {
    const result = proveClaim({ claim: claim(), candidateEvidence: [evidence({ forceClass: "learned_concept_prior" })], policy: basePolicy });
    expect(result.verdict).toBe("unsupported_prior_only");
    expect(result.truthState).toBe("truth.unsupported_prior_only");
    expect(result.certifiedEvidenceIds).toEqual([]);
    expect(result.rejectedEvidence[0]?.reason).toBe("learned_prior_not_evidence");
  });

  it("rejects direct evidence missing a span as insufficient evidence", () => {
    const result = proveClaim({ claim: claim(), candidateEvidence: [evidence({ evidenceSpanId: "" })], policy: basePolicy });
    expect(result.verdict).toBe("insufficient_evidence");
    expect(result.rejectedEvidence[0]).toEqual({ evidenceId: "evidence:1", reason: "missing_source_binding" });
  });

  it("keeps profile excerpts source-bound instead of external proof", () => {
    const result = proveClaim({ claim: claim(), candidateEvidence: [evidence({ forceClass: "profile_excerpt_evidence" })], policy: basePolicy });
    expect(result.verdict).toBe("source_bound_only");
    expect(result.certifiedEvidenceIds).toEqual([]);
    expect(result.rejectedEvidence[0]?.reason).toBe("profile_excerpt_external_claim");
  });

  it("does not let surface compatibility override wrong entity ids", () => {
    const result = proveClaim({
      claim: claim(),
      candidateEvidence: [evidence({ subject: { id: "entity:beta", surface: "alpha", kindId: "kind.test.system" } })],
      policy: basePolicy
    });
    expect(result.verdict).toBe("contradicted");
    expect(result.contradictions.some(item => item.kind === "entity_identity")).toBe(true);
  });

  it("treats wrong quantities as contradictions for admissible direct evidence", () => {
    const result = proveClaim({ claim: claim({ quantity: { value: 42, unitId: "unit.count" } }), candidateEvidence: [evidence({ quantity: { value: 43, unitId: "unit.count" } })], policy: basePolicy });
    expect(result.verdict).toBe("contradicted");
    expect(result.contradictions).toContainEqual({ evidenceId: "evidence:1", kind: "quantity", reason: "quantity_conflict" });
  });

  it("treats wrong date-time values as contradictions for admissible direct evidence", () => {
    const result = proveClaim({ claim: claim({ dateTime: { value: "2026-06-26", precisionId: "precision.day" } }), candidateEvidence: [evidence({ dateTime: { value: "2026-06-27", precisionId: "precision.day" } })], policy: basePolicy });
    expect(result.verdict).toBe("contradicted");
    expect(result.contradictions).toContainEqual({ evidenceId: "evidence:1", kind: "date_time", reason: "date_time_conflict" });
  });

  it("uses policy ids for polarity contradictions", () => {
    const result = proveClaim({ claim: claim({ polarityId: "polarity.positive" }), candidateEvidence: [evidence({ polarityId: "polarity.negative" })], policy: basePolicy });
    expect(result.verdict).toBe("contradicted");
    expect(result.contradictions).toContainEqual({ evidenceId: "evidence:1", kind: "polarity", reason: "polarity_policy_contradiction" });
  });

  it("does not let weak modality ids certify stronger modality ids", () => {
    const result = proveClaim({ claim: claim({ modalityId: "modality.asserted" }), candidateEvidence: [evidence({ modalityId: "modality.possible" })], policy: basePolicy });
    expect(result.verdict).toBe("insufficient_evidence");
    expect(result.obligations).toContainEqual({ kind: "modality", passed: false, reason: "modality_strength_insufficient" });
  });

  it("distinguishes absence of evidence from contradiction", () => {
    const result = proveClaim({ claim: claim(), candidateEvidence: [], policy: basePolicy });
    expect(result.verdict).toBe("insufficient_evidence");
    expect(result.contradictions).toEqual([]);
  });

  it("ignores display labels attached beside modality ids", () => {
    const labeledPolicy: ProofPolicy & { displayLabels: Record<string, string> } = {
      ...basePolicy,
      displayLabels: {
        "modality.asserted": "label-one",
        "modality.possible": "label-two"
      }
    };
    const plain = proveClaim({ claim: claim({ modalityId: "modality.asserted" }), candidateEvidence: [evidence({ modalityId: "modality.possible" })], policy: basePolicy });
    const labeled = proveClaim({ claim: claim({ modalityId: "modality.asserted" }), candidateEvidence: [evidence({ modalityId: "modality.possible" })], policy: labeledPolicy });
    expect(labeled.verdict).toBe(plain.verdict);
    expect(labeled.obligations.find(item => item.kind === "modality")).toEqual(plain.obligations.find(item => item.kind === "modality"));
  });

  it("emits scoreTrace with support mass, contradiction mass and heuristic traces", () => {
    const result = proveClaim({ claim: claim(), candidateEvidence: [evidence()], policy: basePolicy });
    expect(result.scoreTrace).toBeDefined();
    expect(result.scoreTrace.length).toBeGreaterThan(0);
    expect(result.scoreTrace.some(t => t.meaning.includes("support mass"))).toBe(true);
    expect(result.scoreTrace.some(t => t.meaning.includes("contradiction mass"))).toBe(true);
    expect(result.scoreTrace.some(t => t.kind === "provisional_heuristic")).toBe(true);
  });

  it("Mouth respects certified versus prior-only proof gate verdicts without proof telemetry in normal text", async () => {
    const clock = createClock({ fixedTime: 9000, stepMs: 1 });
    const hasher = createHasher();
    const ids = createIdFactory({ clock, hasher, deterministicReplay: true });
    const source = sourceVersion(ids, clock.now());
    const span = evidenceSpan(ids, source, "subject-alpha relation green", clock.now());
    const languageMemory = createLanguageMemoryRuntime({ idFactory: ids, hasher });
    const mouth = createMouth({ languageMemory, correctionMemory: createCorrectionMemory({ idFactory: ids, hasher }), hashText: text => hasher.digestHex(text) });
    const certifiedGate = proveClaim({ claim: claim(), candidateEvidence: [evidence()], policy: basePolicy });
    const priorGate = proveClaim({ claim: claim(), candidateEvidence: [evidence({ forceClass: "learned_language_prior" })], policy: basePolicy });
    const shared = {
      construct: constructGraph(ids),
      field: emptyField(),
      languageProfile: languageProfile(source, clock.now()),
      evidence: [span],
      languageMemory: languageMemory.hydrateFromImportedBrain({ importRunId: "proof-gate", models: [], observations: [], units: [], patterns: [], semanticFrames: [] }),
      targetLanguage: "fixture-language"
    };

    const certified = await mouth.speak({ ...shared, entailment: entailment(ids, clock.now(), span, certifiedGate, "proved") });
    const priorOnly = await mouth.speak({ ...shared, entailment: entailment(ids, clock.now(), span, priorGate, "unknown") });

    expect(certified.force).toBe("entailed");
    expect(priorOnly.force).toBe("underdetermined");
    expect(priorOnly.evidenceRefs).toEqual([]);
    expect(JSON.stringify(priorOnly.realizationTrace.walshSurfaceEnergy)).toContain("unsupported_prior_only");
    for (const forbidden of ["semanticProofEngine", "certifiedEvidenceIds", "unsupported_prior_only", "evidenceSpanId", "sourceVersionId"]) {
      expect(priorOnly.text).not.toContain(forbidden);
    }
    expect(JSON.stringify(priorOnly.realizationTrace.surfacePlan)).toContain("pointCount");
  });

  function claim(overrides: Partial<ProofClaim> = {}): ProofClaim {
    return {
      id: "claim:1",
      subject: { id: "entity:alpha", surface: "alpha", kindId: "kind.test.system" },
      relationId: "relation.test.has_status",
      object: { id: "status:green", surface: "green", kindId: "kind.test.status" },
      polarityId: "polarity.positive",
      modalityId: "modality.asserted",
      requiredSourceBinding: true,
      ...overrides
    };
  }

  function evidence(overrides: Partial<ProofEvidenceRecord> = {}): ProofEvidenceRecord {
    const record: ProofEvidenceRecord = {
      id: "evidence:1",
      forceClass: "direct_evidence",
      sourceVersionId: "source-version:1",
      evidenceSpanId: "span:1",
      subject: { id: "entity:alpha", surface: "alpha", kindId: "kind.test.system" },
      relationId: "relation.test.has_value",
      object: { id: "status:green", surface: "green", kindId: "kind.test.status" },
      polarityId: "polarity.positive",
      modalityId: "modality.asserted"
    };
    return { ...record, ...overrides };
  }

  function sourceVersion(ids: ReturnType<typeof createIdFactory>, now: number): SourceVersion {
    const uri = "fixture://semantic-proof-engine";
    const bytes = Buffer.from(uri);
    return {
      sourceId: ids.sourceId("fixture", uri),
      sourceVersionId: ids.sourceVersionId(bytes),
      namespace: "fixture",
      canonicalUri: uri,
      contentHash: ids.contentHash(bytes),
      mediaType: "text/plain",
      observedAt: now,
      byteLength: bytes.length,
      trust: 0.9,
      metadata: {}
    };
  }

  function evidenceSpan(ids: ReturnType<typeof createIdFactory>, source: SourceVersion, text: string, now: number): EvidenceSpan {
    const bytes = Buffer.from(text);
    const contentHash = ids.contentHash(bytes);
    return {
      id: ids.evidenceId({ sourceVersionId: source.sourceVersionId, byteStart: 0, byteEnd: bytes.length, spanHash: contentHash }),
      sourceId: source.sourceId,
      sourceVersionId: source.sourceVersionId,
      chunkId: ids.chunkId({ sourceVersionId: source.sourceVersionId, byteStart: 0, byteEnd: bytes.length, chunkHash: contentHash }),
      contentHash,
      mediaType: source.mediaType,
      byteStart: 0,
      byteEnd: bytes.length,
      charStart: 0,
      charEnd: text.length,
      text,
      textPreview: text,
      languageHints: {},
      scriptHints: {},
      trustVector: { forceClass: "direct_evidence" },
      provenance: { provenanceClass: "direct_evidence", uri: source.canonicalUri, sourceVersionId: source.sourceVersionId, byteRange: [0, bytes.length], charRange: [0, text.length] },
      features: featureSet(text, 128),
      status: "promoted",
      alpha: 0.9,
      observedAt: now
    };
  }

  function entailment(ids: ReturnType<typeof createIdFactory>, now: number, span: EvidenceSpan, gate: SemanticProofResult, force: SemanticEntailmentResult["force"]): SemanticEntailmentResult {
    const claimText = "subject-alpha relation green";
    const claimId = ids.claimId({ text: claimText });
    const verdict = gate.verdict === "certified" ? "entailed" : gate.verdict === "contradicted" ? "contradicted" : "underdetermined";
    return {
      claim: { id: claimId, text: claimText, normalized: claimText, features: featureSet(claimText, 128), polarity: 1 },
      verdict,
      semanticVerdict: verdict,
      force,
      support: gate.verdict === "certified" ? 0.9 : 0.22,
      contradiction: gate.verdict === "contradicted" ? 0.8 : 0,
      faithfulnessLcb: gate.verdict === "certified" ? 0.7 : 0.1,
      confidence: {
        verdict,
        support: gate.verdict === "certified" ? 0.9 : 0.22,
        contradiction: gate.verdict === "contradicted" ? 0.8 : 0,
        faithfulnessLcb: gate.verdict === "certified" ? 0.7 : 0.1,
        supportingEvidence: gate.certifiedEvidenceIds.length,
        sourceVersions: gate.verdict === "certified" ? [String(span.sourceVersionId)] : [],
        structuralCoverage: gate.verdict === "certified" ? 1 : 0,
        roleCoverage: gate.verdict === "certified" ? 1 : 0,
        relationCompatibility: gate.verdict === "certified" ? 1 : 0,
        transformationSupport: gate.verdict === "certified" ? 1 : 0,
        causalMass: 0,
        stability: 1,
        satisfiedObligations: gate.obligations.filter(item => item.passed).length,
        requiredObligations: gate.obligations.length
      },
      scores: {
        structuralCoverage: gate.verdict === "certified" ? 1 : 0,
        roleCoverage: gate.verdict === "certified" ? 1 : 0,
        relationCompatibility: gate.verdict === "certified" ? 1 : 0,
        transformationSupport: gate.verdict === "certified" ? 1 : 0,
        causalMass: 0,
        faithfulnessLCB: gate.verdict === "certified" ? 0.7 : 0.1,
        contradiction: gate.verdict === "contradicted" ? 0.8 : 0,
        stability: 1
      },
      obligations: gate.obligations.map((item, index) => ({
        id: `obligation:${index}`,
        kind: entailmentObligationKind(item.kind),
        status: item.passed ? "satisfied" : "underdetermined",
        claimText,
        evidenceIds: item.passed && gate.verdict === "certified" ? [span.id] : [],
        sourceVersionIds: item.passed && gate.verdict === "certified" ? [span.sourceVersionId] : [],
        support: item.passed ? 1 : 0,
        contradiction: 0,
        required: true,
        reason: item.reason ?? "proof_gate",
        metadata: {}
      })),
      mappings: [],
      transforms: [],
      counterexamples: gate.contradictions.map(item => ({
        id: `counterexample:${item.kind}`,
        kind: entailmentObligationKind(item.kind),
        claimText,
        evidenceIds: [span.id],
        sourceVersionIds: [span.sourceVersionId],
        contradiction: 0.8,
        reason: item.reason,
        audit: {}
      })),
      missing: [],
      proof: {
        id: ids.proofId({ claimId, evidenceIds: gate.verdict === "certified" ? [span.id] : [], transforms: ["semantic-proof-engine"], validatorVersion: "test" }),
        claimId,
        verdict: force,
        confidence: {},
        proofGraph: { nodes: [], edges: [] },
        evidenceIds: gate.verdict === "certified" ? [span.id] : [],
        transformIds: ["semantic-proof-engine"],
        scores: toJsonValue({ semanticProofEngine: gate }),
        validatorVersion: "test",
        createdAt: now
      },
      evidenceIds: gate.verdict === "certified" ? [span.id] : [],
      boundaries: [`semantic-proof-engine:${gate.verdict}`]
    };
  }

  function entailmentObligationKind(kind: string): SemanticEntailmentResult["obligations"][number]["kind"] {
    if (kind === "date_time") return "temporal";
    if (kind === "source_binding") return "source_version";
    if (kind === "entity_identity") return "entity";
    if (kind === "polarity") return "negation";
    if (kind === "modality") return "role";
    if (kind === "quantity" || kind === "unit") return "quantity";
    return "predicate";
  }

  function constructGraph(ids: ReturnType<typeof createIdFactory>): ConstructGraph {
    return {
      id: ids.constructId("proof-gate-mouth"),
      episodeId: ids.episodeId(),
      forceVector: {},
      nodes: [{ id: "construct:answer", kind: "construct:answer", label: "fixture.answer", metadata: {} }],
      edges: [],
      artifacts: []
    };
  }

  function languageProfile(source: SourceVersion, now: number): LanguageProfile {
    return {
      id: "fixture-language",
      sourceVersionId: source.sourceVersionId,
      scripts: [{ script: "fixture-script", mass: 1 }],
      symbolShapes: [],
      charNgrams: [],
      direction: "unknown",
      entropy: 0.1,
      createdAt: now
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
});
