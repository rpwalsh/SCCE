import { describe, expect, it } from "vitest";
import {
  constructToProofClaims,
  createClock,
  createCorrectionMemory,
  createHasher,
  createIdFactory,
  createLanguageMemoryRuntime,
  createMouth,
  createSemanticEntailmentEngine,
  featureSet,
  toJsonValue,
  typedObservationToProofRecords,
  type CodeObservation,
  type ConstructGraph,
  type EvidenceSpan,
  type FieldState,
  type JsonValue,
  type LanguageProfile,
  type LogEventObservation,
  type MeasurementObservation,
  type ObservationForceClass,
  type SourceVersion
} from "../index.js";
import { proveClaim, type ProofClaim, type SemanticProofResult } from "../semantic-proof-engine.js";

describe("semantic proof adapter", () => {
  const clock = createClock({ fixedTime: 61000, stepMs: 1 });
  const hasher = createHasher();
  const ids = createIdFactory({ clock, hasher, deterministicReplay: true, namespace: "semantic-proof-adapter" });

  it("certifies a typed measurement quantity through ConstructGraph claims and direct source spans", () => {
    const source = sourceVersion("fixture://proof-adapter/measurement");
    const span = evidenceSpan(source, "adapter measurement carrier");
    const claim = measurementClaim();
    const construct = constructWithClaim(claim);
    const [constructedClaim] = constructToProofClaims({ construct });
    const observation = measurementObservation(source, span, { value: 42, unit: "unit.ms" });
    const records = typedObservationToProofRecords({ observations: [observation], evidence: [span] });
    const result = proveClaim({ claim: required(constructedClaim), candidateEvidence: records });

    expect(records[0]).toMatchObject({ forceClass: "direct_evidence", sourceVersionId: String(source.sourceVersionId), evidenceSpanId: String(span.id) });
    expect(result.verdict).toBe("certified");
    expect(result.certifiedEvidenceIds).toEqual([records[0]?.id]);
  });

  it("contradicts a typed measurement claim when the quantity differs", () => {
    const source = sourceVersion("fixture://proof-adapter/wrong-measurement");
    const span = evidenceSpan(source, "adapter measurement conflict carrier");
    const records = typedObservationToProofRecords({ observations: [measurementObservation(source, span, { value: 41, unit: "unit.ms" })], evidence: [span] });
    const result = proveClaim({ claim: measurementClaim({ quantity: { value: 42, unitId: "unit.ms" } }), candidateEvidence: records });

    expect(result.verdict).toBe("contradicted");
    expect(result.contradictions).toContainEqual({ evidenceId: records[0]?.id, kind: "quantity", reason: "quantity_conflict" });
  });

  it("contradicts a log event claim when the timestamp differs", () => {
    const source = sourceVersion("fixture://proof-adapter/log");
    const span = evidenceSpan(source, "adapter log carrier");
    const records = typedObservationToProofRecords({ observations: [logObservation(source, span, { timestamp: "time.fixture.001" })], evidence: [span] });
    const result = proveClaim({ claim: logClaim({ dateTime: { value: "time.fixture.002" } }), candidateEvidence: records });

    expect(result.verdict).toBe("contradicted");
    expect(result.contradictions).toContainEqual({ evidenceId: records[0]?.id, kind: "date_time", reason: "date_time_conflict" });
  });

  it("does not certify a direct typed observation when the exact evidence span is missing", () => {
    const source = sourceVersion("fixture://proof-adapter/missing-span");
    const span = evidenceSpan(source, "adapter missing span carrier");
    const records = typedObservationToProofRecords({ observations: [measurementObservation(source, span, { value: 42, unit: "unit.ms" })] });
    const result = proveClaim({ claim: measurementClaim(), candidateEvidence: records });

    expect(result.verdict).toBe("insufficient_evidence");
    expect(result.rejectedEvidence).toContainEqual({ evidenceId: records[0]?.id, reason: "missing_source_binding" });
  });

  it("keeps a matching learned concept prior from certifying a structured claim", () => {
    const source = sourceVersion("fixture://proof-adapter/prior");
    const span = evidenceSpan(source, "adapter prior carrier");
    const records = typedObservationToProofRecords({ observations: [measurementObservation(source, span, { value: 42, unit: "unit.ms", forceClass: "learned_concept_prior" })], evidence: [span] });
    const result = proveClaim({ claim: measurementClaim(), candidateEvidence: records });

    expect(result.verdict).toBe("unsupported_prior_only");
    expect(result.certifiedEvidenceIds).toEqual([]);
    expect(result.rejectedEvidence[0]?.reason).toBe("learned_prior_not_evidence");
  });

  it("keeps a matching profile excerpt source-bound instead of external fact proof", () => {
    const source = sourceVersion("fixture://proof-adapter/profile-excerpt");
    const span = evidenceSpan(source, "adapter profile excerpt carrier");
    const records = typedObservationToProofRecords({ observations: [measurementObservation(source, span, { value: 42, unit: "unit.ms", forceClass: "profile_excerpt_evidence" })], evidence: [span] });
    const result = proveClaim({ claim: measurementClaim(), candidateEvidence: records });

    expect(result.verdict).toBe("source_bound_only");
    expect(result.certifiedEvidenceIds).toEqual([]);
    expect(result.rejectedEvidence[0]?.reason).toBe("profile_excerpt_external_claim");
  });

  it("certifies a source-bound code fact only with exact source and span bindings", () => {
    const source = sourceVersion("fixture://proof-adapter/code");
    const span = evidenceSpan(source, "adapter code carrier");
    const claim = codeClaim();
    const withSpan = typedObservationToProofRecords({ observations: [codeObservation(source, span)], evidence: [span] });
    const withoutSpan = typedObservationToProofRecords({ observations: [codeObservation(source, span)] });

    expect(proveClaim({ claim, candidateEvidence: withSpan }).verdict).toBe("certified");
    expect(proveClaim({ claim, candidateEvidence: withoutSpan }).verdict).toBe("insufficient_evidence");
  });

  it("keeps the exact text proof gate fallback working when no structured fields exist", () => {
    const source = sourceVersion("fixture://proof-adapter/exact-text");
    const claimText = "fixture exact text claim";
    const span = evidenceSpan(source, claimText);
    const result = createSemanticEntailmentEngine({ idFactory: ids, hasher }).check({
      text: claimText,
      evidence: [span],
      nodes: [],
      field: emptyField(),
      createdAt: clock.now()
    });

    expect(result.verdict).toBe("entailed");
    expect(proofGate(result.proof.scores)?.verdict).toBe("certified");
  });

  it("runs ordinary claim text through structured runtime objects before exact text and Mouth obeys the verdicts", async () => {
    const source = sourceVersion("fixture://proof-adapter/runtime-objects");
    const span = evidenceSpan(source, "structured measurement carrier; not equal to the owner assertion");
    const claim = measurementClaim();
    const ordinaryText = "system alpha duration equals 42 ms";
    const construct = constructWithClaim(claim);
    const engine = createSemanticEntailmentEngine({ idFactory: ids, hasher });
    const direct = engine.check({
      text: ordinaryText,
      evidence: [span],
      nodes: [],
      field: emptyField(),
      createdAt: clock.now(),
      construct,
      typedObservations: [measurementObservation(source, span, { value: 42, unit: "unit.ms" })]
    });
    const priorOnly = engine.check({
      text: ordinaryText,
      evidence: [span],
      nodes: [],
      field: emptyField(),
      createdAt: clock.now(),
      construct,
      typedObservations: [measurementObservation(source, span, { value: 42, unit: "unit.ms", forceClass: "learned_concept_prior" })]
    });
    const mouth = createMouth({
      languageMemory: createLanguageMemoryRuntime({ idFactory: ids, hasher }),
      correctionMemory: createCorrectionMemory({ idFactory: ids, hasher }),
      hashText: text => hasher.digestHex(text)
    });
    const shared = {
      construct,
      field: emptyField(),
      languageProfile: languageProfile(source),
      evidence: [span],
      languageMemory: createLanguageMemoryRuntime({ idFactory: ids, hasher }).hydrateFromImportedBrain({ importRunId: "semantic-proof-adapter", models: [], observations: [], units: [], patterns: [], semanticFrames: [] }),
      targetLanguage: "fixture-language"
    };
    const spokenDirect = await mouth.speak({ ...shared, entailment: direct });
    const spokenPrior = await mouth.speak({ ...shared, entailment: priorOnly });

    expect(span.text).not.toBe(ordinaryText);
    expect(proofGate(direct.proof.scores)?.verdict).toBe("certified");
    expect(proofGate(direct.proof.scores)?.trace.proofPath).toBe("structured_runtime");
    expect(proofGate(priorOnly.proof.scores)?.verdict).toBe("unsupported_prior_only");
    expect(proofGate(priorOnly.proof.scores)?.trace.proofPath).toBe("structured_runtime");
    expect(["entailed", "observed"]).toContain(spokenDirect.force);
    expect(spokenPrior.force).toBe("underdetermined");
    expect(spokenPrior.text).toBe("");
    expect(spokenPrior.realizationTrace.selected.path).toBe("generated");
    expect(spokenPrior.realizationTrace.selected.textHash).toBe(hasher.digestHex(""));
    expect(JSON.stringify(spokenPrior.realizationTrace.selected)).toContain("no_proof");
    expect(spokenPrior.inspectRefs.some(ref => ref.kind === "proof")).toBe(true);
    expect(JSON.stringify(spokenPrior.realizationTrace.walshSurfaceEnergy)).toContain("unsupported_prior_only");
    for (const forbidden of ["semanticProofEngine", "certifiedEvidenceIds", "evidenceSpanId", "sourceVersionId"]) {
      expect(spokenDirect.text).not.toContain(forbidden);
      expect(spokenPrior.text).not.toContain(forbidden);
    }
  });

  function measurementClaim(overrides: Partial<ProofClaim> = {}): ProofClaim {
    return {
      id: "claim.measurement.quantity",
      subject: { id: "subject.system.alpha", kindId: "kind.measurement.subject" },
      relationId: "relation.measurement.quantity",
      object: { id: "metric.duration", kindId: "kind.measurement.object" },
      quantity: { value: 42, unitId: "unit.ms" },
      requiredSourceBinding: true,
      ...overrides
    };
  }

  function logClaim(overrides: Partial<ProofClaim> = {}): ProofClaim {
    return {
      id: "claim.log.state",
      subject: { id: "component.worker", kindId: "kind.log.subject" },
      relationId: "relation.log.state",
      object: { id: "status.retry", kindId: "kind.log.object" },
      dateTime: { value: "time.fixture.001" },
      requiredSourceBinding: true,
      ...overrides
    };
  }

  function codeClaim(overrides: Partial<ProofClaim> = {}): ProofClaim {
    return {
      id: "claim.code.fact",
      subject: { id: "file.src.app", kindId: "kind.code.subject" },
      relationId: "relation.code.fact",
      object: { id: "symbol.boot", kindId: "kind.code.object" },
      requiredSourceBinding: true,
      ...overrides
    };
  }

  function measurementObservation(source: SourceVersion, span: EvidenceSpan, options: { value: number; unit: string; forceClass?: ObservationForceClass }): MeasurementObservation {
    return {
      ...baseObservation(source, span, options.forceClass),
      id: "obs.measurement.1",
      kind: "measurement",
      datasetId: "dataset.fixture",
      tableId: "table.fixture",
      measurementId: "metric.duration",
      sensor: "subject.system.alpha",
      value: options.value,
      unit: options.unit,
      tolerance: 0,
      metadata: toJsonValue({
        subjectId: "subject.system.alpha",
        subjectKindId: "kind.measurement.subject",
        relationId: "relation.measurement.quantity",
        objectId: "metric.duration",
        objectKindId: "kind.measurement.object"
      })
    };
  }

  function logObservation(source: SourceVersion, span: EvidenceSpan, options: { timestamp: string; forceClass?: ObservationForceClass }): LogEventObservation {
    return {
      ...baseObservation(source, span, options.forceClass),
      id: "obs.log.1",
      kind: "log_event",
      streamId: "stream.fixture",
      sequence: 1,
      timestamp: options.timestamp,
      severity: "status.retry",
      component: "component.worker",
      message: "event.fixture.retry",
      attributes: {},
      metadata: toJsonValue({
        subjectId: "component.worker",
        subjectKindId: "kind.log.subject",
        relationId: "relation.log.state",
        objectId: "status.retry",
        objectKindId: "kind.log.object"
      })
    };
  }

  function codeObservation(source: SourceVersion, span: EvidenceSpan, forceClass?: ObservationForceClass): CodeObservation {
    return {
      ...baseObservation(source, span, forceClass),
      id: "obs.code.1",
      kind: "code",
      repoId: "repo.fixture",
      filePath: "file.src.app",
      language: "language.fixture",
      symbolGraph: toJsonValue({ symbols: ["symbol.boot"] }),
      dependencyGraph: toJsonValue({ imports: [] }),
      programGraph: toJsonValue({ nodes: [] }),
      metadata: toJsonValue({
        subjectId: "file.src.app",
        subjectKindId: "kind.code.subject",
        relationId: "relation.code.fact",
        objectId: "symbol.boot",
        objectKindId: "kind.code.object"
      })
    };
  }

  function baseObservation(source: SourceVersion, span: EvidenceSpan, forceClass?: ObservationForceClass) {
    return {
      sourceId: source.sourceId,
      sourceVersionId: source.sourceVersionId,
      evidenceIds: [span.id],
      confidence: 0.91,
      provenance: toJsonValue({ sourceVersionId: source.sourceVersionId, evidenceIds: [span.id] }),
      metadata: {},
      forceClass: forceClass ?? "typed_source_observation"
    };
  }

  function constructWithClaim(claim: ProofClaim): ConstructGraph {
    return {
      id: ids.constructId("semantic-proof-adapter"),
      episodeId: ids.episodeId(),
      forceVector: {},
      nodes: [{ id: "construct.claim.1", kind: "construct:answer", label: "fixture.construct", metadata: toJsonValue({ semanticProof: { claims: [claim] } }) }],
      edges: [],
      artifacts: []
    };
  }

  function sourceVersion(uri: string): SourceVersion {
    const bytes = Buffer.from(uri);
    return {
      sourceId: ids.sourceId("semantic-proof-adapter", uri),
      sourceVersionId: ids.sourceVersionId(bytes),
      namespace: "fixture",
      canonicalUri: uri,
      contentHash: ids.contentHash(bytes),
      mediaType: "text/plain",
      observedAt: clock.now(),
      byteLength: bytes.length,
      sourceTrust: { identity: 0.92, integrity: 0.92, parserReliability: 0.92, directness: 0.92, authority: 0.92, freshness: 0.92, independenceGroup: "fixture:semantic-proof-adapter", accessScope: "fixture", licenseStatus: "fixture" },
      metadata: {}
    };
  }

  function evidenceSpan(source: SourceVersion, text: string, extraProvenance: JsonValue = {}): EvidenceSpan {
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
      provenance: toJsonValue({
        provenanceClass: "direct_evidence",
        uri: source.canonicalUri,
        sourceVersionId: source.sourceVersionId,
        byteRange: [0, bytes.length],
        charRange: [0, text.length],
        ...objectRecord(extraProvenance)
      }),
      features: featureSet(text, 128),
      status: "promoted",
      alpha: 0.9,
      observedAt: clock.now()
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

  function proofGate(scores: JsonValue): SemanticProofResult | undefined {
    const record = objectRecord(scores);
    const gate = objectRecord(record?.semanticProofEngine);
    return gate as unknown as SemanticProofResult | undefined;
  }

  function objectRecord(value: JsonValue | undefined): Record<string, JsonValue> | undefined {
    return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, JsonValue> : undefined;
  }

  function required<T>(value: T | undefined): T {
    if (value === undefined) throw new Error("missing required fixture value");
    return value;
  }
});
