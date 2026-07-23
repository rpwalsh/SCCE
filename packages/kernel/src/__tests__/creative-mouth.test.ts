import { describe, expect, it } from "vitest";
import {
  boundaryProfileFor,
  createClock,
  createCorrectionMemory,
  createHasher,
  createIdFactory,
  createInventionConstruct,
  createLanguageMemoryRuntime,
  createMouth,
  createSemanticEntailmentEngine,
  detailPolicyForProfile,
  featureSet,
  inventionConstructNode,
  scoreSurfaceEnergy,
  toJsonValue,
  type CandidateSurface,
  type ConstructGraph,
  type EvidenceId,
  type EvidenceSpan,
  type FieldState,
  type JsonValue,
  type LanguageProfile,
  type SourceVersion,
  type SurfaceEnergyComponent,
  type SurfaceEnergyContext,
  type SurfacePlan
} from "../index.js";

describe("creative Mouth production boundary", () => {
  it("implements the exact creative surface equation without treating invented content as a fake fact", () => {
    const plan = creativeSurfacePlan("Constraint-safe graph index with bounded updates");
    const construct = creativeConstruct("evidence:premise" as EvidenceId);
    const context: SurfaceEnergyContext = {
      construct,
      requestedAuthority: "creative",
      surfacePlan: plan,
      expectedForce: "creative",
      proofVerdict: "insufficient_evidence",
      fieldSummary: { contradictionPressure: 0.11, actionability: 0.72 },
      languagePrior: { surfaces: ["ordinary tree index"], activation: 0.74, fit: 0.81 },
      styleVector: [0.62, 0.45, 0.72],
      requiredEntities: [],
      requiredNumbers: [],
      requiredCaveats: []
    };

    const result = scoreSurfaceEnergy({
      id: "surface:creative:equation",
      text: "Constraint-safe graph index with bounded updates",
      force: "creative",
      evidenceIds: [],
      languageActivation: 0.74,
      languageFit: 0.81,
      semanticPreservation: 0.91,
      importedPieceIds: []
    }, context);

    const byId = new Map(result.components.map(component => [component.id, component]));
    const expected =
      0.30 * raw(byId, "surface.creative.meaning_preservation") +
      0.20 * raw(byId, "surface.creative.constraint_coverage") +
      0.16 * raw(byId, "surface.creative.kn_fluency") +
      0.14 * raw(byId, "surface.creative.style_fit") +
      0.12 * raw(byId, "surface.creative.surface_novelty") +
      0.08 * raw(byId, "surface.creative.actionability") -
      0.24 * raw(byId, "surface.creative.repetition") -
      0.30 * raw(byId, "surface.creative.contradiction_leak") -
      0.50 * raw(byId, "surface.creative.fake_factual_authority");

    expect(result.valid).toBe(true);
    expect(raw(byId, "surface.creative.fake_factual_authority")).toBe(0);
    expect(result.surfaceScore).toBeCloseTo(expected, 8);
    expect(result.energy).toBeCloseTo(-expected, 8);
    expect(JSON.stringify(result.trace)).toContain("surface.creative.bootstrap.v1");

    const externallyAssertive = scoreSurfaceEnergy({
      id: "surface:creative:fake-authority",
      text: "Constraint-safe graph index with bounded updates",
      force: "observed",
      evidenceIds: [],
      languageFit: 0.81,
      semanticPreservation: 0.91
    }, context);
    expect(raw(new Map(externallyAssertive.components.map(component => [component.id, component])), "surface.creative.fake_factual_authority")).toBe(1);
  });

  it("ranks bounded creative realizations, binds only premise evidence, and traces conjectural performance", async () => {
    const clock = createClock({ fixedTime: 87000, stepMs: 1 });
    const hasher = createHasher();
    const ids = createIdFactory({ clock, hasher, deterministicReplay: true });
    const languageRuntime = createLanguageMemoryRuntime({ idFactory: ids, hasher });
    const source = sourceVersion(ids, clock.now());
    const premise = evidenceSpan(ids, source, "The graph uses bounded-degree adjacency lists.", 0, clock.now());
    const unrelated = evidenceSpan(ids, source, "An unrelated benchmark reports a fixed latency.", 128, clock.now());
    const field = emptyField("Invent a bounded graph index", 0.68);
    const entailment = createSemanticEntailmentEngine({ idFactory: ids, hasher }).check({
      text: "Invent a bounded graph index",
      evidence: [premise, unrelated],
      nodes: [],
      field,
      createdAt: clock.now()
    });
    const construct = creativeConstruct(premise.id, ids);
    const selectedCandidate = creativeCandidate(construct, premise.id, unrelated.id);
    const mouth = createMouth({
      languageMemory: languageRuntime,
      correctionMemory: createCorrectionMemory({ idFactory: ids, hasher }),
      hashText: text => hasher.digestHex(text)
    });
    const languageMemory = languageRuntime.hydrateFromImportedBrain({
      importRunId: "creative-mouth",
      models: [],
      observations: [],
      units: [],
      patterns: [],
      semanticFrames: []
    });
    const input = {
      construct,
      field,
      languageProfile: languageProfile(source, clock.now()),
      evidence: [premise, unrelated],
      entailment: { ...entailment, force: "invented" as const, evidenceIds: [premise.id, unrelated.id] },
      languageMemory,
      selectedCandidate,
      requestedAuthority: "creative" as const,
      calibrationTaskClass: "task.creative_generation"
    };

    const first = await mouth.speak(input);
    const second = await mouth.speak(input);
    const walshTrace = record(first.realizationTrace.walshSurfaceEnergy);
    const ranked = Array.isArray(walshTrace.ranked) ? walshTrace.ranked : [];
    const creativeVariants = first.realizationTrace.candidates.filter(candidate => candidate.id.startsWith("candidate:generated:creative:"));

    expect(first.force).toBe("creative");
    expect(first.text).toBe("Constraint-safe graph index with bounded updates and a validation pass.");
    expect(first.evidenceRefs).toEqual([premise.id]);
    expect(first.evidenceRefs).not.toContain(unrelated.id);
    expect(first.text).toBe(second.text);
    expect(first.text.trim().startsWith("{")).toBe(false);
    expect(first.text).not.toContain("basisEvidenceIds");
    expect(first.text).not.toContain("scce.invention_construct.v1");
    expect(creativeVariants.length).toBeGreaterThanOrEqual(2);
    expect(creativeVariants.some(candidate => candidate.id === "candidate:generated:creative:learned-proposal")).toBe(true);
    expect(new Set(creativeVariants.map(candidate => candidate.textHash)).size).toBeGreaterThanOrEqual(2);
    expect(ranked.length).toBeGreaterThanOrEqual(creativeVariants.length);
    expect(JSON.stringify(walshTrace)).toContain("surface.creative.bootstrap.v1");
    expect(first.uncertainty.some(marker => marker.reason === "surface.uncertainty.untested_performance_claim")).toBe(true);
    expect(JSON.stringify(first.surfacePlan.forceBindings)).toContain("underdetermined");
  });
});

function creativeConstruct(basisEvidenceId: EvidenceId, ids?: ReturnType<typeof createIdFactory>): ConstructGraph {
  const invention = {
    ...createInventionConstruct({
      id: "invention:bounded-index",
      title: "Bounded graph index",
      proposalSurface: "Constraint-safe graph index with bounded updates and a validation pass.",
      artifactKindIds: ["artifact.algorithm"],
      basisEvidenceIds: [basisEvidenceId],
      basisPriorIds: ["prior:graph-pattern"],
      noveltyScore: 0.78,
      supportScore: 0.61,
      riskScore: 0.27
    }),
    trace: toJsonValue({
      source: "invention-planner",
      constraintCoverage: 1,
      graphCoherence: 0.74,
      novelty: 0.78,
      languageRealizability: 0.81,
      usefulness: 0.76,
      risk: 0.27,
      repetition: 0.04,
      unsupportedFactualAssertion: 0,
      proposalRealization: {
        path: "learned_structural_composition",
        sourcePieceIds: ["prior:graph-pattern"],
        structuralSourceIds: ["prior:graph-pattern"],
        structuralSentenceCount: 1
      },
      constraints: [
        { id: "constraint:bounded", surface: "bounded updates", weight: 1, satisfied: true },
        { id: "constraint:validation", surface: "validation pass", weight: 0.8, satisfied: true }
      ],
      claimBasis: [
        { id: "claim:premise", surface: "bounded-degree adjacency lists", force: "observed", evidenceIds: [basisEvidenceId], kind: "factual_premise" },
        { id: "claim:invention", surface: "constraint-safe graph index", force: "invented", evidenceIds: [], kind: "invention" },
        { id: "claim:performance", surface: "lower update cost in an untested workload", force: "conjectured", evidenceIds: [], kind: "performance_prediction" }
      ],
      untestedPerformanceClaim: true
    })
  };
  return {
    id: ids?.constructId({ fixture: "creative-mouth" }) ?? "construct:creative-mouth" as ConstructGraph["id"],
    episodeId: ids?.episodeId() ?? "episode:creative-mouth" as ConstructGraph["episodeId"],
    forceVector: {},
    nodes: [
      {
        id: "construct:insufficient",
        kind: "construct:insufficient_support",
        label: "prior boundary",
        metadata: toJsonValue({ schema: "scce.insufficient_support_construct.v1" })
      },
      inventionConstructNode(invention)
    ],
    edges: [],
    artifacts: []
  };
}

function creativeCandidate(construct: ConstructGraph, premise: EvidenceId, unrelated: EvidenceId): CandidateSurface {
  const proposal = record(construct.nodes.find(node => node.kind === "construct:invention")?.metadata).proposalSurface;
  return {
    id: "candidate:creative:selected",
    kind: "creative-candidate",
    answer: typeof proposal === "string" ? proposal : "Constraint-safe graph index with bounded updates.",
    force: "invented",
    evidenceIds: [premise, unrelated],
    scores: {
      support: 0.61,
      contradiction: 0.05,
      faithfulness: 0.86,
      alphaPressure: 0.62,
      actionability: 0.76,
      evidenceCoverage: 0.5,
      novelty: 0.78,
      realizability: 0.81,
      constraintCoverage: 1,
      graphCoherence: 0.74,
      languageRealizability: 0.81,
      usefulness: 0.76,
      risk: 0.27,
      repetition: 0.04,
      unsupportedFactualAssertion: 0,
      creativeSelectionScore: 0.69
    },
    boundaries: ["generated-not-evidence"],
    audit: {}
  };
}

function creativeSurfacePlan(proposition: string): SurfacePlan {
  const detailProfileId = "surface.detail.profile.1";
  const detail = detailPolicyForProfile(detailProfileId, undefined);
  const boundary = boundaryProfileFor({ scriptId: "fixture-script" });
  const pointId = "surface:creative:point";
  return {
    thesis: pointId,
    orderedPoints: [{
      id: pointId,
      constructNodeId: "invention:bounded-index",
      proposition,
      force: "creative",
      evidenceIds: [],
      role: "answer",
      support: 0.61,
      contradiction: 0.02,
      realizationConstraints: {}
    }],
    realizationFrames: [],
    requiredTerms: [],
    forbiddenSurfaces: [],
    evidenceBindings: [],
    forceBindings: [{ pointId, force: "creative", constructForce: "CreativeConstruct", support: 0.61, contradiction: 0.02 }],
    caveatBindings: [],
    constructForces: [{ id: "CreativeConstruct", weight: 1, source: "fixture" }],
    targetLanguage: "fixture-language",
    targetScript: "fixture-script",
    styleProfileId: "surface.style.fixture",
    style: { name: "fixture", density: detail.density, formality: 0.45, creativity: 0.72, exposeProofTerms: false },
    detailProfileId,
    boundaryProfile: boundary,
    audit: {}
  };
}

function sourceVersion(ids: ReturnType<typeof createIdFactory>, now: number): SourceVersion {
  const text = "The graph uses bounded-degree adjacency lists. An unrelated benchmark reports a fixed latency.";
  const bytes = Buffer.from(text);
  const uri = "fixture://creative-mouth/source";
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

function evidenceSpan(ids: ReturnType<typeof createIdFactory>, source: SourceVersion, text: string, byteStart: number, now: number): EvidenceSpan {
  const bytes = Buffer.from(text);
  const contentHash = ids.contentHash(bytes);
  return {
    id: ids.evidenceId({ sourceVersionId: source.sourceVersionId, byteStart, byteEnd: byteStart + bytes.length, spanHash: contentHash }),
    sourceId: source.sourceId,
    sourceVersionId: source.sourceVersionId,
    chunkId: ids.chunkId({ sourceVersionId: source.sourceVersionId, byteStart, byteEnd: byteStart + bytes.length, chunkHash: contentHash }),
    contentHash,
    mediaType: source.mediaType,
    byteStart,
    byteEnd: byteStart + bytes.length,
    charStart: byteStart,
    charEnd: byteStart + text.length,
    text,
    textPreview: text,
    languageHints: {},
    scriptHints: {},
    trustVector: { sourceTrust: source.trust, forceClass: "direct_evidence" },
    provenance: { sourceSystem: "fixture", provenanceClass: "direct_evidence", sourceVersionId: source.sourceVersionId },
    features: featureSet(text, 96),
    status: "promoted",
    alpha: 0.88,
    observedAt: now
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

function emptyField(request: string, actionability: number): FieldState {
  const matrix = { nodes: [], values: [] };
  return {
    requestFeatures: featureSet(request, 64),
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
      surfaces: { pressure: 0.2, drift: 0.38, contradiction: 0.04, bond: 0.1, risk: 0.12, actionability },
      contradictionMass: 0.04,
      bondedLeakage: 0
    },
    causalMass: []
  };
}

function raw(components: Map<string, SurfaceEnergyComponent>, id: string): number {
  const component = components.get(id);
  if (!component) throw new Error(`missing component ${id}`);
  return component.raw;
}

function record(value: JsonValue | undefined): Record<string, JsonValue> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, JsonValue> : {};
}
