import { describe, expect, it } from "vitest";
import {
  boundaryProfileFor,
  createClock,
  createCorrectionMemory,
  createHasher,
  createIdFactory,
  createLanguageMemoryRuntime,
  createMouth,
  createSemanticEntailmentEngine,
  SURFACE_QUALITY_REJECTION_IDS,
  detailPolicyForProfile,
  featureSet,
  toJsonValue,
  type ConstructGraph,
  type EvidenceId,
  type EvidenceSpan,
  type FieldState,
  type JsonValue,
  type LanguageProfile,
  type SourceVersion
} from "../index.js";
import type { DiscoursePlan, OutputForce, SurfacePlan } from "../mouth.js";
import type { LanguagePatternRecord, LanguageUnitRecord, NgramModelRecord, NgramObservation, SemanticFrameRecord } from "../storage.js";
import {
  rankBySurfaceEnergy,
  scoreSurfaceEnergy,
  type SurfaceEnergyCandidate,
  type SurfaceEnergyContext,
  type SurfaceEnergyResult,
  type SurfaceProofVerdict
} from "../walsh-surface-energy.js";
import { genericChatMouthFixture as mouthFixture } from "./fixtures/generic-chat-mouth-fixture.js";

describe("Walsh surface energy", () => {
  it("penalizes unsupported factual candidates without silencing them", () => {
    const result = scoreSurfaceEnergy(candidate("c:unsupported", "pump pressure is 42"), context({
      proofVerdict: "unsupported_prior_only",
      expectedForce: "observed",
      requiredNumbers: ["42"],
      requiredCaveats: ["surface.boundary.unsupported_prior_only"],
      proposition: "pump pressure is 42"
    }));

    expect(result.valid).toBe(true);
    expect(result.proofVerdictUsed).toBe("unsupported_prior_only");
    expect(componentRaw(result, "surface.energy.proof_violation")).toBeGreaterThan(0);
  });

  it("penalizes source-bound candidates stated as external truth without hard rejection", () => {
    const result = scoreSurfaceEnergy(candidate("c:source-bound", "profile excerpt says pump pressure is 42", { force: "observed" }), context({
      proofVerdict: "source_bound_only",
      expectedForce: "observed",
      requiredNumbers: ["42"],
      requiredCaveats: ["surface.boundary.source_bound_only"],
      proposition: "profile excerpt says pump pressure is 42"
    }));

    expect(result.valid).toBe(true);
    expect(result.proofVerdictUsed).toBe("source_bound_only");
    expect(componentRaw(result, "surface.energy.proof_violation")).toBeGreaterThan(0);
  });

  it("keeps contradicted assertions speakable while assigning contradiction energy", () => {
    const result = scoreSurfaceEnergy(candidate("c:contradicted", "pump pressure is 42", { force: "observed" }), context({
      proofVerdict: "contradicted",
      expectedForce: "observed",
      requiredNumbers: ["42"],
      proposition: "pump pressure is 42"
    }));

    expect(result.valid).toBe(true);
    expect(result.proofVerdictUsed).toBe("contradicted");
    expect(componentRaw(result, "surface.energy.contradiction_leak")).toBeGreaterThan(0);
  });

  it("rejects candidates that drop required numbers", () => {
    const result = scoreSurfaceEnergy(candidate("c:no-number", "pump pressure stabilized"), context({
      proofVerdict: "certified",
      requiredNumbers: ["42"],
      proposition: "pump pressure is 42"
    }));

    expect(result.valid).toBe(false);
    expect(rejectionIds(result)).toContain("surface.reject.required_number_dropped");
  });

  it("penalizes candidates that drop required caveats", () => {
    const result = scoreSurfaceEnergy(candidate("c:no-caveat", "pump pressure is 42", { force: "underdetermined" }), context({
      proofVerdict: "insufficient_evidence",
      expectedForce: "underdetermined",
      requiredNumbers: ["42"],
      requiredCaveats: ["surface.boundary.sensor_calibration"],
      proposition: "pump pressure is 42"
    }));

    expect(result.valid).toBe(true);
    expect(componentRaw(result, "surface.energy.caveat_loss")).toBeGreaterThan(0);
  });

  it("rejects candidates that cite learned priors as evidence", () => {
    const result = scoreSurfaceEnergy(candidate("c:prior-evidence", "pump pressure is 42", { evidenceIds: ["prior:1"], force: "observed" }), context({
      proofVerdict: "certified",
      expectedForce: "observed",
      learnedPriorEvidenceIds: ["prior:1"],
      requiredNumbers: ["42"],
      proposition: "pump pressure is 42"
    }));

    expect(result.valid).toBe(false);
    expect(rejectionIds(result)).toContain("surface.reject.learned_prior_cited_as_evidence");
  });

  it("rejects canned hydrated-answer speech before final selection", () => {
    const result = scoreSurfaceEnergy(candidate("c:canned", "The hydrated brain has 1 active import run. I cannot certify external factual claims from this shard.", { force: "underdetermined", evidenceIds: [] }), context({
      proofVerdict: "unsupported_prior_only",
      expectedForce: "underdetermined",
      proposition: "brain import summary"
    }));

    expect(result.valid).toBe(false);
    expect(rejectionIds(result)).toContain(SURFACE_QUALITY_REJECTION_IDS.blockedSurface);
  });

  it("ranks phrase-salad below a coherent candidate or rejects it", () => {
    const rows = rankBySurfaceEnergy([
      candidate("c:salad", "x x x : : :"),
      candidate("c:clean", "pump pressure 42 stable")
    ], context({
      proofVerdict: "certified",
      requiredEntities: ["pump"],
      requiredNumbers: ["42"],
      proposition: "pump pressure is 42"
    }));

    const salad = required(rows.find(row => row.candidate.id === "c:salad"));
    const clean = required(rows.find(row => row.candidate.id === "c:clean"));
    expect(rows[0]?.candidate.id).toBe("c:clean");
    expect(salad.result.valid === false || salad.result.energy > clean.result.energy).toBe(true);
  });

  it("assigns higher energy to repeated boundary decisions", () => {
    const baseContext = context({
      proofVerdict: "certified",
      requiredEntities: ["pump"],
      requiredNumbers: ["42"],
      proposition: "pump pressure is 42"
    });
    const clean = scoreSurfaceEnergy(candidate("c:boundary-clean", "pump pressure 42 stable"), baseContext);
    const repeated = scoreSurfaceEnergy(candidate("c:boundary-repeat", "pump pressure 42 stable", {
      boundaryDecisions: [
        { text: ":", repeatedBoundaryPenalty: 0.7 },
        { text: ":", repeatedBoundaryPenalty: 0.6 }
      ]
    }), baseContext);

    expect(componentRaw(repeated, "surface.energy.boundary_instability")).toBeGreaterThan(componentRaw(clean, "surface.energy.boundary_instability"));
    expect(repeated.energy).toBeGreaterThan(clean.energy);
  });

  it("assigns higher energy to correction-violating candidates", () => {
    const baseContext = context({
      proofVerdict: "certified",
      requiredNumbers: ["42"],
      termRewrites: [{ pattern: "oldterm", replacement: "newterm" }],
      proposition: "newterm pressure is 42"
    });
    const violating = scoreSurfaceEnergy(candidate("c:rewrite-miss", "oldterm pressure 42"), baseContext);
    const aligned = scoreSurfaceEnergy(candidate("c:rewrite-hit", "newterm pressure 42"), baseContext);

    expect(componentRaw(violating, "surface.energy.correction_violation")).toBeGreaterThan(componentRaw(aligned, "surface.energy.correction_violation"));
    expect(violating.energy).toBeGreaterThan(aligned.energy);
  });

  it("selects compressed low-energy candidates for the concise detail profile", () => {
    const rows = rankBySurfaceEnergy([
      candidate("c:long", "pump pressure 42 stable with calibration notes sensor history operator timing and maintenance context"),
      candidate("c:short", "pump pressure 42 stable")
    ], context({
      proofVerdict: "certified",
      detailProfileId: "surface.detail.profile.0",
      requiredEntities: ["pump"],
      requiredNumbers: ["42"],
      proposition: "pump pressure is 42"
    }));

    expect(rows[0]?.candidate.id).toBe("c:short");
  });

  it("selects support-rich low-energy candidates for the detailed profile", () => {
    const rows = rankBySurfaceEnergy([
      candidate("c:short", "pump pressure 42 stable"),
      candidate("c:detailed", "pump pressure 42 stable calibration sample source span component reading operator note timing relation and trace context")
    ], context({
      proofVerdict: "certified",
      detailProfileId: "surface.detail.profile.2",
      requiredEntities: ["pump"],
      requiredNumbers: ["42"],
      proposition: "pump pressure is 42"
    }));

    expect(rows[0]?.candidate.id).toBe("c:detailed");
  });

  it("uses high language prior support unless a hard surface violation blocks it", () => {
    const certified = context({
      proofVerdict: "certified",
      requiredEntities: ["pump"],
      requiredNumbers: ["42"],
      proposition: "pump pressure is 42"
    });
    const high = scoreSurfaceEnergy(candidate("c:language-high", "pump pressure 42 stable", { languageActivation: 0.97, languageFit: 0.94, importedPieceIds: ["unit:1", "pattern:1"] }), certified);
    const low = scoreSurfaceEnergy(candidate("c:language-low", "pump pressure 42 stable", { languageActivation: 0.04, languageFit: 0.04 }), certified);
    expect(componentRaw(high, "surface.energy.language_prior_support")).toBeGreaterThan(componentRaw(low, "surface.energy.language_prior_support"));
    expect(high.energy).toBeLessThan(low.energy);

    const blocked = scoreSurfaceEnergy(candidate("c:language-blocked", "pump pressure 42 stable", { languageActivation: 0.99, languageFit: 0.99, importedPieceIds: ["unit:1"] }), context({
      proofVerdict: "unsupported_prior_only",
      expectedForce: "observed",
      requiredEntities: ["pump"],
      requiredNumbers: ["42"],
      requiredCaveats: ["surface.boundary.unsupported_prior_only"],
      proposition: "pump pressure is 42"
    }));
    expect(blocked.valid).toBe(true);
    expect(blocked.proofVerdictUsed).toBe("unsupported_prior_only");
    expect(componentRaw(blocked, "surface.energy.language_prior_support")).toBeGreaterThan(0);
    expect(componentRaw(blocked, "surface.energy.proof_violation")).toBeGreaterThan(0);
  });

  it("ranks proof-spam below clean proof-compatible candidates", () => {
    const rows = rankBySurfaceEnergy([
      candidate("c:spam", "pump 42 proof proof proof proof proof proof proof proof proof proof proof"),
      candidate("c:clean", "pump 42 stable source span")
    ], context({
      proofVerdict: "certified",
      requiredEntities: ["pump"],
      requiredNumbers: ["42"],
      proposition: "pump pressure is 42"
    }));

    const spam = required(rows.find(row => row.candidate.id === "c:spam"));
    const clean = required(rows.find(row => row.candidate.id === "c:clean"));
    expect(componentRaw(spam.result, "surface.energy.repetition_cost")).toBeGreaterThan(componentRaw(clean.result, "surface.energy.repetition_cost"));
    expect(rows[0]?.candidate.id).toBe("c:clean");
  });

  it("Mouth selects the lowest-energy valid generated candidate", async () => {
    const clock = createClock({ fixedTime: 62000, stepMs: 1 });
    const hasher = createHasher();
    const ids = createIdFactory({ clock, hasher, deterministicReplay: true });
    const languageRuntime = createLanguageMemoryRuntime({ idFactory: ids, hasher });
    const source = sourceVersion(ids, clock.now());
    const evidence = directEvidence(ids, source, clock.now());
    const field = emptyField();
    const entailment = createSemanticEntailmentEngine({ idFactory: ids, hasher }).check({
      text: mouthFixture.claim,
      evidence: [evidence],
      nodes: [],
      field,
      createdAt: clock.now()
    });
    const mouth = createMouth({ languageMemory: languageRuntime, correctionMemory: createCorrectionMemory({ idFactory: ids, hasher }), hashText: text => hasher.digestHex(text) });
    const spoken = await mouth.speak({
      construct: constructGraph(ids),
      field,
      languageProfile: languageProfile(source, clock.now()),
      evidence: [evidence],
      entailment,
      languageMemory: importedMemory({ languageRuntime, source, evidence, importRunId: "surface-energy", now: clock.now() }),
      targetLanguage: "fixture-language",
      brainMarker: { activeBrainVersion: "fixture-brain", activeImportRunIds: ["surface-energy"] }
    });

    const trace = jsonRecord(spoken.realizationTrace.walshSurfaceEnergy);
    const selected = jsonRecord(trace.selected);
    const ranked = jsonArray(trace.ranked).map(jsonRecord);
    const energies = ranked.map(row => numberValue(row.energy));
    expect(ranked.length).toBeGreaterThan(0);
    expect(selected.valid).toBe(true);
    expect(selected.candidateId).toBe(ranked[0]?.candidateId);
    expect(numberValue(selected.energy)).toBe(Math.min(...energies));
    expect(spoken.realizationTrace.selected.id).toBe(selected.candidateId);
    expect(JSON.stringify(selected.components)).toContain("surface.energy.semantic_loss");
  });
});

function candidate(id: string, text: string, options: Partial<SurfaceEnergyCandidate> = {}): SurfaceEnergyCandidate {
  return {
    id,
    text,
    force: options.force ?? "observed",
    evidenceIds: options.evidenceIds ?? ["evidence:direct"],
    importedPieceIds: options.importedPieceIds ?? [],
    languageActivation: options.languageActivation ?? 0.18,
    languageFit: options.languageFit ?? 0.18,
    semanticPreservation: options.semanticPreservation ?? 0.88,
    correctionAppliedCount: options.correctionAppliedCount ?? 0,
    forbiddenSurfaceHits: options.forbiddenSurfaceHits ?? [],
    boundaryDecisions: options.boundaryDecisions ?? []
  };
}

function context(options: {
  proofVerdict: SurfaceProofVerdict;
  expectedForce?: OutputForce;
  detailProfileId?: string;
  requiredEntities?: string[];
  requiredNumbers?: string[];
  requiredCaveats?: string[];
  learnedPriorEvidenceIds?: string[];
  termRewrites?: Array<{ pattern: string; replacement: string }>;
  proposition?: string;
}): SurfaceEnergyContext {
  const detailProfileId = options.detailProfileId ?? "surface.detail.profile.1";
  const policy = detailPolicyForProfile(detailProfileId, undefined);
  const plan = surfacePlan({
    detailProfileId,
    proposition: options.proposition ?? "pump pressure is 42",
    force: options.expectedForce ?? "observed",
    requiredEntities: options.requiredEntities ?? [],
    requiredNumbers: options.requiredNumbers ?? [],
    requiredCaveats: options.requiredCaveats ?? []
  });
  return {
    surfacePlan: plan,
    discoursePlan: discoursePlan(plan),
    proofVerdict: options.proofVerdict,
    expectedForce: options.expectedForce ?? "observed",
    forceClass: options.proofVerdict,
    fieldSummary: { alphaPressure: 0.42, ppfMass: 0.58, contradictionPressure: options.proofVerdict === "contradicted" ? 0.75 : 0.02, actionability: 0.44 },
    languagePrior: { activation: 0.2, fit: 0.2, support: 0.2, importedPieceIds: ["prior:language"], surfaces: ["pump pressure"] },
    correction: { termRewrites: options.termRewrites ?? [], styleVector: [0.34, 0.22, 0.14], registerVector: [0.4, 0.2, 0.2] },
    styleVector: [0.34, 0.22, 0.14],
    registerVector: [0.4, 0.2, 0.2],
    detailProfile: policy,
    boundaryProfile: plan.boundaryProfile,
    requiredEntities: options.requiredEntities ?? [],
    requiredNumbers: options.requiredNumbers ?? [],
    requiredCaveats: options.requiredCaveats ?? [],
    learnedPriorEvidenceIds: options.learnedPriorEvidenceIds ?? [],
    directEvidenceIds: ["evidence:direct"]
  };
}

function surfacePlan(input: {
  detailProfileId: string;
  proposition: string;
  force: OutputForce;
  requiredEntities: string[];
  requiredNumbers: string[];
  requiredCaveats: string[];
}): SurfacePlan {
  const policy = detailPolicyForProfile(input.detailProfileId, undefined);
  const boundary = boundaryProfileFor({ scriptId: "fixture-script" });
  const pointId = "surface:point:0";
  const evidenceId = "evidence:direct" as EvidenceId;
  const requiredTerms = [
    ...input.requiredEntities.map((text, index) => ({ id: `term:entity:${index}`, text, source: "construct" as const, weight: 0.92 })),
    ...input.requiredNumbers.map((text, index) => ({ id: `term:number:${index}`, text, source: "construct" as const, weight: 0.96 })),
    ...input.requiredCaveats.map((text, index) => ({ id: `term:caveat:${index}`, text, source: "construct" as const, weight: 0.94 }))
  ];
  const caveatBindings = input.requiredCaveats.map((reason, index) => ({ pointId, reason, severity: index === 0 ? "medium" as const : "low" as const }));
  return {
    thesis: "construct:fixture",
    orderedPoints: [{
      id: pointId,
      constructNodeId: "construct:fixture",
      proposition: input.proposition,
      force: input.force,
      evidenceIds: [evidenceId],
      caveat: input.requiredCaveats[0],
      role: "answer",
      support: 0.86,
      contradiction: 0.02,
      realizationConstraints: {}
    }],
    realizationFrames: [{
      id: "frame:surface:0",
      pointId,
      role: "answer",
      force: input.force,
      constructForce: "FactualConstruct",
      propositionAtoms: [],
      requiredTerms,
      forbiddenSurfaceIds: [],
      caveat: caveatBindings[0],
      evidenceBinding: { pointId, evidenceId, sourceVersionId: "source-version:fixture", support: 0.86 },
      targetLanguage: "fixture-language",
      targetScript: "fixture-script",
      styleProfileId: "style:fixture",
      registerVector: [0.4, 0.2, 0.2],
      detailProfileId: input.detailProfileId,
      semanticFrameIds: [],
      ordering: { index: 0, relation: "linear", weight: 1 },
      realizationConstraints: {}
    }],
    requiredTerms,
    forbiddenSurfaces: [],
    evidenceBindings: [{ pointId, evidenceId, sourceVersionId: "source-version:fixture", support: 0.86 }],
    forceBindings: [{ pointId, force: input.force, constructForce: "FactualConstruct", support: 0.86, contradiction: 0.02 }],
    caveatBindings,
    constructForces: [{ id: "FactualConstruct", weight: 0.86, source: "fixture" }],
    targetLanguage: "fixture-language",
    targetScript: "fixture-script",
    styleProfileId: "style:fixture",
    style: { name: "fixture-style", density: policy.density, formality: 0.44, creativity: 0.08, exposeProofTerms: false },
    registerId: "register:fixture",
    registerVector: [0.4, 0.2, 0.2],
    detailProfileId: input.detailProfileId,
    boundaryProfile: boundary,
    audit: toJsonValue({ detailPolicy: policy })
  };
}

function discoursePlan(plan: SurfacePlan): DiscoursePlan {
  return {
    id: "discourse:fixture",
    units: [{
      id: "unit:answer:0",
      role: "answer",
      frameIds: ["frame:surface:0"],
      groupId: "group:answer",
      sentenceIndex: 0,
      boundaryBefore: "none",
      generationExtent: 24,
      targetDetailProfileId: plan.detailProfileId,
      targetStyleProfileId: plan.styleProfileId,
      registerVector: plan.registerVector
    }],
    maxSentenceCount: 2,
    targetDetailProfileId: plan.detailProfileId,
    targetStyleProfileId: plan.styleProfileId,
    boundaryProfile: plan.boundaryProfile,
    registerVector: plan.registerVector,
    audit: {}
  };
}

function rejectionIds(result: SurfaceEnergyResult): string[] {
  return result.hardViolations.map(item => item.id);
}

function componentRaw(result: SurfaceEnergyResult, id: string): number {
  return required(result.components.find(component => component.id === id)).raw;
}

function required<T>(value: T | undefined): T {
  if (value === undefined) throw new Error("fixture value missing");
  return value;
}

function jsonRecord(value: JsonValue | undefined): Record<string, JsonValue> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, JsonValue> : {};
}

function jsonArray(value: JsonValue | undefined): JsonValue[] {
  return Array.isArray(value) ? value : [];
}

function numberValue(value: JsonValue | undefined): number {
  return typeof value === "number" ? value : Number.NaN;
}

function sourceVersion(ids: ReturnType<typeof createIdFactory>, now: number): SourceVersion {
  const bytes = Buffer.from(mouthFixture.evidenceText);
  const uri = "fixture://surface-energy/evidence";
  return {
    sourceId: ids.sourceId("fixture", uri),
    sourceVersionId: ids.sourceVersionId(bytes),
    namespace: "fixture",
    canonicalUri: uri,
    contentHash: ids.contentHash(bytes),
    mediaType: "text/plain",
    observedAt: now,
    byteLength: bytes.length,
    trust: 0.94,
    metadata: {}
  };
}

function directEvidence(ids: ReturnType<typeof createIdFactory>, source: SourceVersion, now: number): EvidenceSpan {
  const bytes = Buffer.from(mouthFixture.evidenceText);
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
    charEnd: mouthFixture.evidenceText.length,
    text: mouthFixture.evidenceText,
    textPreview: mouthFixture.evidenceText,
    languageHints: {},
    scriptHints: {},
    trustVector: { sourceTrust: source.trust, forceClass: "direct_evidence" },
    provenance: { sourceSystem: "fixture", provenanceClass: "direct_evidence", uri: source.canonicalUri, sourceVersionId: source.sourceVersionId, byteRange: [0, bytes.length], charRange: [0, mouthFixture.evidenceText.length] },
    features: featureSet(mouthFixture.evidenceText, 128),
    status: "promoted",
    alpha: 0.9,
    observedAt: now
  };
}

function constructGraph(ids: ReturnType<typeof createIdFactory>): ConstructGraph {
  return {
    id: ids.constructId({ fixture: "walsh-surface-energy" }),
    episodeId: ids.episodeId(),
    forceVector: { fixture: true },
    nodes: [{ id: "family:answer", kind: "construct:answer", label: "fixture.answer", metadata: {} }],
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
    entropy: 0.2,
    createdAt: now
  };
}

function importedMemory(input: {
  languageRuntime: ReturnType<typeof createLanguageMemoryRuntime>;
  source: SourceVersion;
  evidence: EvidenceSpan;
  importRunId: string;
  now: number;
}) {
  return input.languageRuntime.hydrateFromImportedBrain({
    importRunId: input.importRunId,
    models: [ngramModel(input.now)],
    observations: [ngramObservation(input.source, input.now)],
    units: [languageUnit(input.source)],
    patterns: [languagePattern(input.now)],
    semanticFrames: [semanticFrame(input.evidence, input.now)]
  });
}

function ngramModel(now: number): NgramModelRecord {
  return {
    id: "model:surface-energy",
    streamId: "stream:surface-energy",
    languageHint: "learned:fixture",
    maxOrder: 1,
    discount: 0.75,
    modelJson: {
      sourceSystem: "scce2",
      model: {
        order: 1,
        discount: 0.75,
        symbolCount: 8,
        vocabularySize: 3,
        counts: { "humid-morning": 4, vent: 2, rule: 2 },
        contextCounts: {},
        continuationCounts: {},
        contextContinuationTypes: {},
        totalContinuationTypes: 0,
        unigramCounts: { "humid-morning": 4, vent: 2, rule: 2 },
        totalUnigramCount: 8,
        vocabulary: ["humid-morning", "vent", "rule"]
      }
    },
    updatedAt: now
  };
}

function ngramObservation(source: SourceVersion, now: number): NgramObservation {
  return {
    id: "obs:surface-energy",
    streamId: "stream:surface-energy",
    languageHint: "learned:fixture",
    order: 1,
    history: [],
    symbol: "humid-morning",
    count: 4,
    fieldWeight: 1,
    sourceVersionId: source.sourceVersionId,
    observedAt: now,
    metadata: { sourceSystem: "scce2", provenanceClass: "learned_language_prior" }
  };
}

function languageUnit(source: SourceVersion): LanguageUnitRecord {
  return {
    id: "unit:surface-energy",
    profileId: "profile:surface-energy",
    sourceVersionId: source.sourceVersionId,
    script: "fixture-script",
    unitKind: "phrase",
    text: mouthFixture.importedPhrase,
    features: featureSet(mouthFixture.importedPhrase, 64),
    competenceVector: [1],
    alpha: 0.94,
    evidenceIds: [],
    metadata: { sourceSystem: "scce2", provenanceClass: "learned_language_prior" }
  };
}

function languagePattern(now: number): LanguagePatternRecord {
  return {
    id: "pattern:surface-energy",
    profileId: "profile:surface-energy",
    patternKind: "syntax",
    support: 0.82,
    entropy: 0.1,
    patternJson: { sourceSystem: "scce2", provenanceClass: "learned_language_prior", counts: { [mouthFixture.importedPhrase]: 2 }, discourse: { boundary: mouthFixture.discourseBoundary } },
    evidenceIds: [],
    updatedAt: now
  };
}

function semanticFrame(evidence: EvidenceSpan, now: number): SemanticFrameRecord {
  return {
    id: "frame:surface-energy",
    frameJson: { sourceSystem: "scce2", provenanceClass: "learned_language_prior", surface: mouthFixture.importedSemanticFrame },
    embedding: [],
    evidenceIds: [evidence.id],
    alpha: 0.96,
    createdAt: now
  };
}

function emptyField(): FieldState {
  const matrix = { nodes: [], values: [] };
  return {
    requestFeatures: featureSet(mouthFixture.claim, 64),
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
      surfaces: { pressure: 0.2, drift: 0, contradiction: 0, bond: 0, risk: 0, actionability: 0.4 },
      contradictionMass: 0,
      bondedLeakage: 0
    },
    causalMass: []
  };
}
