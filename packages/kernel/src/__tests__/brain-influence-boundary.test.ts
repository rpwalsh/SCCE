import { describe, expect, it } from "vitest";
import {
  createAlphaFieldEngine,
  createClock,
  createCorrectionMemory,
  createHasher,
  createIdFactory,
  createLanguageMemoryRuntime,
  createMouth,
  createSemanticEntailmentEngine,
  evidenceProofBoundary,
  featureSet
} from "../index.js";
import type { EvidenceSpan, FieldState, GraphEdge, GraphNode, JsonValue, LanguageProfile, SourceVersion } from "../types.js";
import type { LanguagePatternRecord, LanguageUnitRecord, NgramModelRecord, NgramObservation } from "../storage.js";
import { scce2ImportedBrainFixture as fixture } from "./fixtures/scce2-imported-brain-fixture.js";

describe("imported brain influence and proof boundary", () => {
  const clock = createClock({ fixedTime: 2000, stepMs: 1 });
  const hasher = createHasher();
  const ids = createIdFactory({ clock, hasher, deterministicReplay: true });

  it("does not let learned priors certify factual proof obligations", () => {
    const source = sourceVersion("scce2", "scce2://language-prior", 0.9);
    const prior = span(source, fixture.priorOnly.text, "learned_language_prior");
    const direct = span(source, fixture.directEvidence.text, "direct_evidence");
    const engine = createSemanticEntailmentEngine({ idFactory: ids, hasher });

    const priorOnly = engine.check({ text: fixture.priorOnly.text, evidence: [prior], nodes: [], field: emptyField(), createdAt: clock.now() });
    expect(priorOnly.evidenceIds).toEqual([]);
    expect(priorOnly.boundaries.some(item => item.includes("prior-not-evidence"))).toBe(true);
    expect(JSON.stringify(priorOnly.proof.scores)).toContain("no-certifying-direct-evidence");

    const directOnly = engine.check({ text: fixture.directEvidence.text, evidence: [direct], nodes: [], field: emptyField(), createdAt: clock.now() });
    expect(directOnly.evidenceIds.map(String)).toContain(String(direct.id));
    expect(JSON.stringify(directOnly.proof.scores)).toContain("certifyingEvidence");
  });

  it("separates SCCE2 profile excerpt evidence from external direct evidence", () => {
    const source = sourceVersion("scce2", "scce2://profile-excerpt", 0.9);
    const profileExcerpt = span(source, fixture.profileExcerptEvidence.text, "profile_excerpt_evidence");
    const direct = span(source, fixture.directEvidence.text, "direct_evidence");
    const engine = createSemanticEntailmentEngine({ idFactory: ids, hasher });

    const profileBoundary = evidenceProofBoundary(profileExcerpt);
    expect(profileBoundary.certifiesFactualProof).toBe(false);
    expect(profileBoundary.reason).toBe("proof-boundary.profile-excerpt-not-external-evidence");

    const profileOnly = engine.check({ text: fixture.profileExcerptEvidence.text, evidence: [profileExcerpt], nodes: [], field: emptyField(), createdAt: clock.now() });
    expect(profileOnly.evidenceIds).toEqual([]);
    expect(JSON.stringify(profileOnly.proof.scores)).toContain("no-certifying-direct-evidence");

    const directBoundary = evidenceProofBoundary(direct);
    expect(directBoundary.exactSourceSemantics).toBe(true);
    expect(directBoundary.certifiesFactualProof).toBe(true);
    const directOnly = engine.check({ text: fixture.directEvidence.text, evidence: [direct], nodes: [], field: emptyField(), createdAt: clock.now() });
    expect(directOnly.evidenceIds.map(String)).toContain(String(direct.id));
  });

  it("reports imported language rows used by Mouth realization", async () => {
    const source = sourceVersion("scce2", "scce2://direct-evidence", 0.9);
    const direct = span(source, fixture.directEvidence.text, "direct_evidence");
    const entailment = createSemanticEntailmentEngine({ idFactory: ids, hasher }).check({
      text: fixture.directEvidence.text,
      evidence: [direct],
      nodes: [],
      field: emptyField(),
      createdAt: clock.now()
    });
    const languageRuntime = createLanguageMemoryRuntime({ idFactory: ids, hasher });
    const beforeImport = languageRuntime.hydrateFromImportedBrain({
      importRunId: "before-import",
      models: [],
      observations: [],
      units: [],
      patterns: []
    });
    expect(beforeImport.importedLanguagePriorCount).toBe(0);
    expect(JSON.stringify(languageRuntime.profile({ state: beforeImport }))).toContain("\"importedLanguagePriorCount\":0");
    const languageMemory = languageRuntime.hydrateFromImportedBrain({
      importRunId: fixture.importRunId,
      models: [ngramModel()],
      observations: [ngramObservation(source)],
      units: [languageUnit(source)],
      patterns: [languagePattern()],
    });
    expect(languageMemory.importedLanguagePriorCount).toBeGreaterThan(0);
    const mouth = createMouth({ languageMemory: languageRuntime, correctionMemory: createCorrectionMemory({ idFactory: ids, hasher }), hashText: text => hasher.digestHex(text) });
    const spoken = await mouth.speak({
      construct: {
        id: ids.constructId("fixture"),
        episodeId: ids.episodeId(),
        forceVector: {},
        nodes: [],
        edges: [],
        artifacts: []
      },
      field: emptyField(),
      languageProfile: languageProfile(source),
      evidence: [direct],
      entailment,
      languageMemory,
      answerDraft: fixture.directEvidence.text,
      targetLanguage: "fixture-language",
      brainMarker: {
        activeBrainVersion: fixture.activeBrainVersion,
        activeImportRunIds: [fixture.importRunId],
        importedLanguagePriorCount: languageMemory.importedLanguagePriorCount
      }
    });
    const trace = spoken.realizationTrace.brainInfluence as Record<string, JsonValue>;
    expect(trace.activeBrainVersion).toBe(fixture.activeBrainVersion);
    expect(trace.importedLanguageUnitIdsUsed).toContain(fixture.language.phrase.id);
    expect(trace.importedObservationIdsUsed).toContain(fixture.language.ngramObservation.id);
    expect(trace.importedPhrasePatternIdsUsed).toContain(fixture.language.pattern.id);
    expect(trace.importedNgramModelIdsUsed).toContain(fixture.language.ngramModel.id);
  });

  it("reports imported graph priors activated by alpha and PPF", () => {
    const now = clock.now();
    const sourceVersionId = ids.sourceVersionId("graph-prior");
    const imported: GraphNode = {
      id: ids.nodeId({ source: "scce2", conceptId: fixture.graph.concept }),
      typeId: ids.dimensionId("concept"),
      representation: { conceptId: fixture.graph.concept, name: "azurite operator" },
      alpha: fixture.graph.nodeAlpha,
      evidenceIds: [],
      features: [fixture.graph.concept, "operator", ...featureSet("azurite operator", 32)],
      createdAt: now,
      updatedAt: now,
      metadata: { sourceSystem: "scce2", sourceVersionId, provenanceClass: "learned_concept_prior" }
    };
    const neighbor: GraphNode = {
      id: ids.nodeId({ source: "fixture", conceptId: fixture.graph.neighbor }),
      typeId: ids.dimensionId("concept"),
      representation: { conceptId: "cyan", name: "cyan surface" },
      alpha: 0.72,
      evidenceIds: [],
      features: ["cyan", "surface"],
      createdAt: now,
      updatedAt: now,
      metadata: {}
    };
    const edge: GraphEdge = {
      id: ids.edgeId({ source: imported.id, target: neighbor.id, relationId: ids.relationId(fixture.graph.relation), provenanceHash: "fixture" }),
      source: imported.id,
      target: neighbor.id,
      relationId: ids.relationId(fixture.graph.relation),
      alpha: fixture.graph.edgeAlpha,
      weight: 0.77,
      temporalScope: { validFrom: now },
      evidenceIds: [],
      createdAt: now,
      updatedAt: now,
      metadata: { sourceSystem: "scce2", provenanceClass: "learned_concept_prior" }
    };
    const beforeField = createAlphaFieldEngine().activate({ text: "azurite operator", nodes: [neighbor], edges: [] });
    const beforeTrace = (beforeField.ppfDiagnostics as Record<string, JsonValue>).importedPriorTrace as Record<string, JsonValue> | undefined;
    expect(beforeTrace?.importedGraphNodeCountActivated ?? 0).toBe(0);

    const field = createAlphaFieldEngine().activate({ text: "azurite operator", nodes: [imported, neighbor], edges: [edge] });
    const trace = (field.ppfDiagnostics as Record<string, JsonValue>).importedPriorTrace as Record<string, JsonValue>;
    expect(trace.importedGraphNodeCountActivated).toBe(1);
    expect(trace.importedGraphEdgeCountActivated).toBe(1);
    expect(JSON.stringify(trace.topImportedPriorNodesByMass)).toContain(String(imported.id));
    expect(JSON.stringify(trace.topImportedPriorNodesByMass)).toContain("learned_concept_prior");
  });

  function sourceVersion(namespace: string, uri: string, trust: number): SourceVersion {
    const bytes = Buffer.from(uri);
    return {
      sourceId: ids.sourceId(namespace, uri),
      sourceVersionId: ids.sourceVersionId(bytes),
      namespace,
      canonicalUri: uri,
      contentHash: ids.contentHash(bytes),
      mediaType: "text/plain",
      observedAt: clock.now(),
      byteLength: bytes.length,
      sourceTrust: { identity: trust, integrity: trust, parserReliability: trust, directness: trust, authority: trust, freshness: trust, independenceGroup: `fixture:${namespace}`, accessScope: "fixture", licenseStatus: "fixture" },
      metadata: {}
    };
  }

  function span(source: SourceVersion, text: string, forceClass: string): EvidenceSpan {
    const bytes = Buffer.from(text);
    const contentHash = ids.contentHash(bytes);
    let provenance: JsonValue;
    if (forceClass === "direct_evidence") {
      provenance = {
        sourceSystem: "fixture",
        provenanceClass: forceClass,
        uri: fixture.directEvidence.sourceUri,
        sourceVersionId: fixture.directEvidence.sourceVersionId,
        byteRange: [...fixture.directEvidence.byteRange],
        charRange: [...fixture.directEvidence.charRange]
      };
    } else {
      provenance = {
        sourceSystem: "fixture",
        provenanceClass: forceClass,
        limitation: forceClass === "profile_excerpt_evidence" ? "profile excerpt only" : "learned prior only"
      };
    }
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
      trustVector: { sourceTrust: source.sourceTrust, forceClass },
      provenance,
      features: featureSet(text, 128),
      status: "promoted",
      alpha: 0.82,
      observedAt: clock.now()
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

  function ngramModel(): NgramModelRecord {
    return {
      id: fixture.language.ngramModel.id,
      streamId: fixture.language.streamId,
      languageHint: fixture.language.languageHint,
      maxOrder: 1,
      discount: 0.75,
      modelJson: {
        sourceSystem: "scce2",
        model: {
          order: 1,
          discount: 0.75,
          symbolCount: fixture.language.ngramModel.symbolCount,
          vocabularySize: fixture.language.ngramModel.vocabulary.length,
          counts: { azurite: fixture.language.phrase.count, operator: 2 },
          contextCounts: {},
          continuationCounts: {},
          contextContinuationTypes: {},
          totalContinuationTypes: 0,
          unigramCounts: { azurite: fixture.language.phrase.count, operator: 2 },
          totalUnigramCount: fixture.language.ngramModel.symbolCount,
          vocabulary: [...fixture.language.ngramModel.vocabulary]
        }
      },
      updatedAt: clock.now()
    };
  }

  function ngramObservation(source: SourceVersion): NgramObservation {
    return {
      id: fixture.language.ngramObservation.id,
      streamId: fixture.language.streamId,
      languageHint: fixture.language.languageHint,
      order: 1,
      history: [],
      symbol: fixture.language.ngramObservation.symbol,
      count: fixture.language.ngramObservation.count,
      fieldWeight: 1,
      sourceVersionId: source.sourceVersionId,
      observedAt: clock.now(),
      metadata: { sourceSystem: "scce2", provenanceClass: "learned_language_prior" }
    };
  }

  function languageUnit(source: SourceVersion): LanguageUnitRecord {
    return {
      id: fixture.language.phrase.id,
      profileId: fixture.language.profileId,
      sourceVersionId: source.sourceVersionId,
      script: fixture.language.script,
      unitKind: "phrase",
      text: fixture.language.phrase.text,
      features: [fixture.language.phrase.text],
      competenceVector: [1],
      alpha: fixture.language.phrase.alpha,
      evidenceIds: [],
      metadata: { sourceSystem: "scce2", provenanceClass: "learned_language_prior" }
    };
  }

  function languagePattern(): LanguagePatternRecord {
    return {
      id: fixture.language.pattern.id,
      profileId: fixture.language.profileId,
      patternKind: "syntax",
      support: fixture.language.pattern.support,
      entropy: 0.1,
      patternJson: { sourceSystem: "scce2", provenanceClass: "learned_language_prior", counts: { azurite: 2 } },
      evidenceIds: [],
      updatedAt: clock.now()
    };
  }

  function languageProfile(source: SourceVersion): LanguageProfile {
    return {
      id: "fixture-language",
      sourceVersionId: source.sourceVersionId,
      scripts: [{ script: fixture.language.script, mass: 1 }],
      symbolShapes: [],
      charNgrams: [],
      direction: "unknown",
      entropy: 0.2,
      createdAt: clock.now()
    };
  }
});
