import { describe, expect, it } from "vitest";
import {
  boundaryProfileFor,
  CREATIVE_EVENT_ARGUMENT_FRAME_SCHEMA,
  createClock,
  createCorrectionMemory,
  createHasher,
  createIdFactory,
  createInventionConstruct,
  createLanguageMemoryRuntime,
  createMouth,
  createSemanticEntailmentEngine,
  detailPolicyForProfile,
  ENGLISH_CREATIVE_EVENT_COMPILER_ID,
  featureSet,
  inventionConstructNode,
  scoreSurfaceEnergy,
  toJsonValue,
  type CandidateSurface,
  type CognitiveProposal,
  type ConstructGraph,
  type EvidenceId,
  type EvidenceSpan,
  type FieldState,
  type JsonValue,
  type DurableLanguageConstructionBundle,
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

  it("does not realize a creative candidate without a selected production structural plan", async () => {
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
    const structuralTrace = record(record(first.realizationTrace.languageMemory).structuralCreative);

    expect(first.force).toBe("creative");
    expect(first.text).toBe("");
    expect(first.text).toBe(second.text);
    expect(first.realizationTrace.candidates).toEqual([]);
    expect(structuralTrace).toMatchObject({
      selectionBound: false,
      preflightAdmitted: false,
      realizationAdmitted: false,
      failClosed: true,
      unavailableReasonId: "surface.boundary.structural_realization_unavailable"
    });
  });

  it("fails closed when an admitted structural creative plan cannot be realized", async () => {
    const clock = createClock({ fixedTime: 88_000, stepMs: 1 });
    const hasher = createHasher();
    const ids = createIdFactory({ clock, hasher, deterministicReplay: true });
    const languageRuntime = createLanguageMemoryRuntime({ idFactory: ids, hasher });
    const source = sourceVersion(ids, clock.now());
    const premise = evidenceSpan(ids, source, "The graph uses bounded-degree adjacency lists.", 0, clock.now());
    const profile = languageProfile(source, clock.now());
    const fixture = structuralCreativeFixture({
      construct: creativeConstruct(premise.id, ids),
      candidate: creativeCandidate(creativeConstruct(premise.id, ids), premise.id, premise.id),
      profile,
      premise
    });
    const field = emptyField("", 0.68);
    const entailment = createSemanticEntailmentEngine({ idFactory: ids, hasher }).check({
      text: "",
      evidence: [premise],
      nodes: [],
      field,
      createdAt: clock.now()
    });
    const unscopedLanguageMemory = languageRuntime.hydrateFromImportedBrain({
      importRunId: "creative-mouth-structural-boundary",
      models: [],
      observations: [],
      units: [],
      patterns: [],
      semanticFrames: []
    });
    const mouth = createMouth({
      languageMemory: languageRuntime,
      correctionMemory: createCorrectionMemory({ idFactory: ids, hasher }),
      hashText: text => hasher.digestHex(text)
    });

    const spoken = await mouth.speak({
      construct: fixture.construct,
      field,
      selectedProposal: fixture.proposal,
      languageProfile: profile,
      evidence: [premise],
      entailment: { ...entailment, force: "invented", evidenceIds: [premise.id] },
      languageMemory: {
        ...unscopedLanguageMemory,
        importedConstructionBundles: [fixture.bundle],
        scope: {
          mode: "cluster",
          clusterId: "cluster:creative-mouth-structural",
          profileIds: [profile.id],
          sourceVersionIds: [String(source.sourceVersionId)],
          purityProven: true,
          degraded: false
        }
      },
      selectedCandidate: fixture.candidate,
      requestedAuthority: "creative"
    });

    const languageMemoryTrace = record(record(spoken.realizationTrace.languageMemory).structuralCreative);
    const performanceTrace = record(record(spoken.realizationTrace.languageMemory).mouthPerformance);
    const phaseMs = record(performanceTrace.phaseMs);

    expect(spoken.text).toBe("");
    expect(spoken.realizationTrace.candidates).toEqual([]);
    expect(spoken.realizationTrace.selected).toMatchObject({
      id: "surface.boundary.structural_realization_unavailable",
      path: "generated"
    });
    expect(languageMemoryTrace).toMatchObject({
      selectionBound: true,
      preflightAdmitted: false,
      realizationAdmitted: false,
      failClosed: true,
      unavailableReasonId: "surface.boundary.structural_realization_unavailable"
    });
    expect(phaseMs).toHaveProperty("structural_admission");
    expect(phaseMs).not.toHaveProperty("structural_fallback_plan");
  });
});

function structuralCreativeFixture(input: {
  construct: ConstructGraph;
  candidate: CandidateSurface;
  profile: LanguageProfile;
  premise: EvidenceSpan;
}): {
  construct: ConstructGraph;
  candidate: CandidateSurface;
  proposal: CognitiveProposal;
  bundle: DurableLanguageConstructionBundle;
} {
  const bundleId = "bundle:creative-mouth-structural";
  const routeId = "route:creative-mouth-structural";
  const semanticPlanId = "semantic-plan:creative-mouth-structural";
  const inventionNodeId = "invention:bounded-index";
  const requestFit = 0.8;
  const graphFit = 0.7;
  const routeFit = 1 - (1 - requestFit) * (1 - graphFit);
  const eventIds = Array.from({ length: 4 }, (_, index) => `event:creative-mouth:${index}`);
  const selectors = eventIds.map((eventId, index) => ({
    outputIndex: index,
    bundleId,
    eventId,
    profileId: input.profile.id,
    constructionId: `construction:creative-mouth:${index}`,
    relationId: `relation:creative-mouth:${index}`,
    roleIds: ["scce.role.agent"],
    discourseRelationId: index === 0 ? "scce.relation.concurrent" : "scce.relation.subsequent",
    discourseBridgeBasisId: index === 0
      ? "scce.discourse.bridge.invented_macro"
      : "scce.discourse.bridge.source_adjacency",
    discourseBeatId: "beat:creative-mouth:0",
    requestRoleBindings: [],
    requestFit,
    graphFit,
    routeFit,
    routeId,
    routeAnchorEventId: eventIds[0],
    sourceOrdinal: index,
    sourceVersionId: String(input.premise.sourceVersionId),
    evidenceId: String(input.premise.id)
  }));
  const bundle: DurableLanguageConstructionBundle = {
    id: bundleId,
    schema: "scce.language_construction_pattern.v1",
    bindingId: "binding:creative-mouth-structural",
    sourceProfileId: input.profile.id,
    targetProfileId: input.profile.id,
    sourceVersionIds: [String(input.premise.sourceVersionId)],
    evidenceIds: [String(input.premise.id)],
    evidenceContentHashes: [String(input.premise.contentHash)],
    sourceExamples: [],
    constructions: [],
    formClasses: [],
    creativeEvents: selectors.map((selector, index) => ({
      id: selector.eventId,
      compilerId: ENGLISH_CREATIVE_EVENT_COMPILER_ID,
      constructionId: selector.constructionId,
      profileId: selector.profileId,
      sourceVersionId: selector.sourceVersionId,
      evidenceId: selector.evidenceId,
      evidenceContentHash: String(input.premise.contentHash),
      evidenceCharStart: input.premise.charStart,
      evidenceCharEnd: input.premise.charEnd,
      labelStartCodePoint: 0,
      labelEndCodePoint: 1,
      sourceOrdinal: index,
      relationId: selector.relationId,
      sourceLabel: "",
      sourceLabelDigest: "digest:empty",
      tenseId: "scce.tense.past",
      valencyId: "scce.valency.agent",
      roleIds: ["scce.role.agent"],
      argumentFrame: {
        id: `argument-frame:creative-mouth:${index}`,
        schema: CREATIVE_EVENT_ARGUMENT_FRAME_SCHEMA,
        compilerId: ENGLISH_CREATIVE_EVENT_COMPILER_ID,
        sourceSentenceStartCodePoint: 0,
        sourceSentenceEndCodePoint: 1,
        roleIds: ["scce.role.agent"],
        bindings: []
      },
      forms: { infinitive: "", past: "", present: "", gerund: "", participle: "" }
    })),
    contentDigest: "digest:creative-mouth-structural"
  };
  const construct = {
    ...input.construct,
    nodes: input.construct.nodes.map(node => {
      if (String(node.id) !== inventionNodeId) return node;
      const metadata = record(node.metadata);
      return {
        ...node,
        metadata: toJsonValue({
          ...metadata,
          trace: {
            ...record(metadata.trace),
            proposalRealization: {
              path: "mouth_realization_deferred",
              semanticPlanId,
              structuralBundleIds: [bundleId],
              structuralEventPlan: selectors
            },
            structuralSemanticPlan: {
              id: semanticPlanId,
              schema: "scce.structural_semantic_plan.v2",
              selectionAuthority: "candidate_engine_and_judge",
              surfaceRealizationCompetitive: false,
              sourceBundleIds: [bundleId],
              events: selectors
            }
          }
        })
      };
    })
  };
  const proposal = {
    id: "proposal:creative-mouth-structural",
    constructIds: [inventionNodeId]
  } as unknown as CognitiveProposal;
  return {
    construct,
    proposal,
    bundle,
    candidate: {
      ...input.candidate,
      proposalId: proposal.id,
      constructIds: [inventionNodeId],
      claimBases: ["invented"]
    }
  };
}

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
    sourceTrust: { identity: 0.9, integrity: 0.9, parserReliability: 0.9, directness: 0.9, authority: 0.9, freshness: 0.9, independenceGroup: "fixture:creative-mouth", accessScope: "fixture", licenseStatus: "fixture" },
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
    trustVector: { sourceTrust: source.sourceTrust, forceClass: "direct_evidence" },
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
