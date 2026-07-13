import { describe, expect, it } from "vitest";
import {
  createClock,
  createCorrectionMemory,
  createHasher,
  createIdFactory,
  createLanguageMemoryRuntime,
  createMouth,
  createSemanticEntailmentEngine,
  featureSet,
  legacyDetailProfileIdFromSignal
} from "../index.js";
import type { ConstructGraph, EvidenceSpan, FieldState, JsonValue, LanguageProfile, SemanticEntailmentResult, SourceVersion } from "../types.js";
import type { LanguagePatternRecord, LanguageUnitRecord, NgramModelRecord, NgramObservation, SemanticFrameRecord } from "../storage.js";
import { genericChatQualityFixture as fixture } from "./fixtures/generic-chat-quality-fixture.js";

describe("Mouth generic chat quality gate", () => {
  const clock = createClock({ fixedTime: 7000, stepMs: 1 });
  const hasher = createHasher();
  const ids = createIdFactory({ clock, hasher, deterministicReplay: true });
  const languageRuntime = createLanguageMemoryRuntime({ idFactory: ids, hasher });

  it("handles normal chat shapes without evidence copying, telemetry output, or boundary stitching", async () => {
    const source = sourceVersion();
    const evidence = directEvidence(source);
    const field = emptyField();
    const entailment = semanticEntailment(evidence, field);
    const languageMemory = importedMemory(source, evidence, "quality-import");
    const mouth = createMouth({ languageMemory: languageRuntime, correctionMemory: createCorrectionMemory({ idFactory: ids, hasher }), hashText: text => hasher.digestHex(text) });

    const conversational = await mouth.speak(baseInput({ source, evidence, field, entailment, languageMemory, construct: constructGraph(false) }));
    const conciseProfileId = legacyDetailProfileIdFromSignal("brief");
    const detailedProfileId = legacyDetailProfileIdFromSignal("detailed");
    if (!conciseProfileId || !detailedProfileId) throw new Error("legacy detail boundary fixture failed");
    const concise = await mouth.speak({ ...baseInput({ source, evidence, field, entailment, languageMemory, construct: constructGraph(false) }), detailProfileId: conciseProfileId, style: { density: 0.24 } });
    const detailed = await mouth.speak({ ...baseInput({ source, evidence, field, entailment, languageMemory, construct: constructGraph(false) }), detailProfileId: detailedProfileId, style: { density: 0.88 } });

    assertQuality(conversational, evidence, { importedPriorIds: true });
    assertQuality(concise, evidence, { importedPriorIds: true });
    assertQuality(detailed, evidence, { importedPriorIds: true });
    expect(unitCount(concise.realizationTrace.discoursePlan)).toBeLessThanOrEqual(unitCount(detailed.realizationTrace.discoursePlan));
    expect(sentenceCount(concise.text)).toBeLessThanOrEqual(sentenceCount(detailed.text));
  });

  it("keeps caveats, creative artifacts, correction influence, and imported priors inspectable", async () => {
    const source = sourceVersion();
    const evidence = directEvidence(source);
    const field = emptyField(0.42);
    const entailment = semanticEntailment(evidence, field);
    const languageMemory = importedMemory(source, evidence, "quality-import-rich");
    const correctionMemory = createCorrectionMemory({ idFactory: ids, hasher });
    const correction = correctionMemory.record({
      episodeId: ids.episodeId(),
      ownerFeedbackEventId: ids.eventId(),
      now: clock.now(),
      correction: {
        kind: "preferred_surface",
        observedSurface: fixture.correction.observedSurface,
        preferredSurface: fixture.correction.preferredSurface,
        languageId: "quality-language",
        weight: 0.96
      }
    });
    const mouth = createMouth({ languageMemory: languageRuntime, correctionMemory, hashText: text => hasher.digestHex(text) });
    const caveated = await mouth.speak(baseInput({ source, evidence, field, entailment: caveatedEntailment(entailment), languageMemory, construct: constructGraph(false) }));
    const creative = await mouth.speak(baseInput({ source, evidence, field, entailment: { ...entailment, force: "invented", support: 0.2, evidenceIds: [] }, languageMemory, construct: constructGraph(true) }));
    const corrected = await mouth.speak({
      ...baseInput({ source, evidence, field, entailment, languageMemory, construct: constructGraph(false) }),
      correctionRules: [correction]
    });

    assertQuality(caveated, evidence, { importedPriorIds: true, caveat: true });
    expect(caveated.uncertainty.length).toBeGreaterThan(0);
    expect(caveated.text).toContain(fixture.caveatText);

    assertQuality(creative, evidence, { importedPriorIds: true, creative: true });
    expect(creative.force).toBe("creative");
    expect(creative.text).toContain(fixture.creativeArtifact.path);

    assertQuality(corrected, evidence, { importedPriorIds: true, correctionId: correction.id });
    expect(corrected.text).toContain(fixture.correction.preferredSurface);
    expect(corrected.text).not.toContain(fixture.correction.observedSurface);
    expect(JSON.stringify(corrected.realizationTrace.corrections)).toContain(correction.id);
  });

  function baseInput(input: {
    source: SourceVersion;
    evidence: EvidenceSpan;
    field: FieldState;
    entailment: SemanticEntailmentResult;
    languageMemory: ReturnType<typeof languageRuntime.hydrateFromImportedBrain>;
    construct: ConstructGraph;
  }) {
    return {
      construct: input.construct,
      field: input.field,
      languageProfile: languageProfile(input.source),
      evidence: [input.evidence],
      entailment: input.entailment,
      languageMemory: input.languageMemory,
      targetLanguage: "quality-language",
      brainMarker: { activeBrainVersion: "quality-brain", activeImportRunIds: ["quality-import"], importedLanguagePriorCount: input.languageMemory.importedLanguagePriorCount }
    };
  }

  function assertQuality(spoken: Awaited<ReturnType<ReturnType<typeof createMouth>["speak"]>>, evidence: EvidenceSpan, options: { importedPriorIds?: boolean; caveat?: boolean; creative?: boolean; correctionId?: string } = {}) {
    expect(spoken.realizationTrace.selected.path).toBe("generated");
    expect(spoken.text).not.toBe(fixture.evidenceText);
    expect(spoken.text).toContain("40%");
    expect(spoken.text).toContain("9:00");
    expect(spoken.evidenceRefs.map(String)).toContain(String(evidence.id));
    expect(spoken.evidenceRefs.map(String)).not.toContain("unit:quality");
    expect(maxInlineBoundaryRun(spoken.text, fixture.discourseBoundary)).toBeLessThanOrEqual(1);
    expect(sentenceCount(spoken.text)).toBeGreaterThanOrEqual(1);
    expect(JSON.stringify(spoken.realizationTrace.discoursePlan)).toContain("unitCount");
    expect(JSON.stringify(spoken.realizationTrace.languageMemory)).toContain("generatedSentences");
    expect(JSON.stringify(spoken.realizationTrace.preservation)).toContain("mouth.semantic-preservation");
    expect(JSON.stringify(spoken.realizationTrace.surfaceRepair)).toContain("mouth.surface-repair");
    expect(outputLooksLikeTelemetry(spoken.text)).toBe(false);
    expect(outputContainsCannedBoilerplate(spoken.text)).toBe(false);
    expect(outputContainsForbiddenTerminology(spoken.text)).toBe(false);
    if (options.importedPriorIds) {
      const trace = JSON.stringify(spoken.realizationTrace.brainInfluence);
      expect(trace).toContain("unit:quality");
      expect(trace).toContain("pattern:quality");
    }
    if (options.caveat) expect(spoken.text).toContain(fixture.caveatText);
    if (options.creative) expect(spoken.text).toContain(fixture.creativeArtifact.path);
    if (options.correctionId) expect(JSON.stringify(spoken.realizationTrace.corrections)).toContain(options.correctionId);
  }

  function sourceVersion(): SourceVersion {
    const bytes = Buffer.from(fixture.evidenceText);
    const uri = "fixture://library/lighting-policy";
    return {
      sourceId: ids.sourceId("fixture", uri),
      sourceVersionId: ids.sourceVersionId(bytes),
      namespace: "fixture",
      canonicalUri: uri,
      contentHash: ids.contentHash(bytes),
      mediaType: "text/plain",
      observedAt: clock.now(),
      byteLength: bytes.length,
      trust: 0.94,
      metadata: {}
    };
  }

  function directEvidence(source: SourceVersion): EvidenceSpan {
    const bytes = Buffer.from(fixture.evidenceText);
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
      charEnd: fixture.evidenceText.length,
      text: fixture.evidenceText,
      textPreview: fixture.evidenceText,
      languageHints: {},
      scriptHints: {},
      trustVector: { sourceTrust: source.trust, forceClass: "direct_evidence" },
      provenance: { sourceSystem: "fixture", provenanceClass: "direct_evidence", uri: source.canonicalUri, sourceVersionId: source.sourceVersionId, byteRange: [0, bytes.length], charRange: [0, fixture.evidenceText.length] },
      features: featureSet(fixture.evidenceText, 128),
      status: "promoted",
      alpha: 0.9,
      observedAt: clock.now()
    };
  }

  function semanticEntailment(evidence: EvidenceSpan, field: FieldState): SemanticEntailmentResult {
    return createSemanticEntailmentEngine({ idFactory: ids, hasher }).check({
      text: fixture.claim,
      evidence: [evidence],
      nodes: [],
      field,
      createdAt: clock.now()
    });
  }

  function caveatedEntailment(base: SemanticEntailmentResult): SemanticEntailmentResult {
    return {
      ...base,
      verdict: "underdetermined",
      semanticVerdict: "underdetermined",
      force: "conjectured",
      support: 0.46,
      missing: [{
        id: "missing:quality",
        obligationId: "obligation:quality",
        reason: fixture.caveatText,
        claimText: fixture.claim,
        required: true,
        kind: "temporal",
        evidenceIds: [],
        sourceVersionIds: [],
        audit: {}
      }]
    };
  }

  function constructGraph(withArtifact: boolean): ConstructGraph {
    const artifactContent = fixture.creativeArtifact.content;
    const artifact = {
      artifactId: ids.artifactId({ path: fixture.creativeArtifact.path, artifactContent }),
      path: fixture.creativeArtifact.path,
      mediaType: fixture.creativeArtifact.mediaType,
      content: artifactContent,
      contentHash: ids.contentHash(artifactContent),
      role: "doc" as const
    };
    return {
      id: ids.constructId({ fixture: "quality", withArtifact }),
      episodeId: ids.episodeId(),
      forceVector: { fixture: true },
      nodes: [
        { id: "family:answer", kind: "construct:answer", label: "fixture.answer", metadata: {} },
        ...(withArtifact ? [{ id: "family:creative", kind: "construct:creative", label: "fixture.creative", metadata: {} }] : [])
      ],
      edges: [],
      artifacts: withArtifact ? [artifact] : []
    };
  }

  function languageProfile(source: SourceVersion): LanguageProfile {
    return {
      id: "quality-language",
      sourceVersionId: source.sourceVersionId,
      scripts: [{ script: "quality-script", mass: 1 }],
      symbolShapes: [],
      charNgrams: [],
      direction: "unknown",
      entropy: 0.2,
      createdAt: clock.now()
    };
  }

  function importedMemory(source: SourceVersion, evidence: EvidenceSpan, importRunId: string) {
    return languageRuntime.hydrateFromImportedBrain({
      importRunId,
      models: [ngramModel()],
      observations: [ngramObservation(source)],
      units: [languageUnit(source)],
      patterns: [languagePattern()],
      semanticFrames: [semanticFrame(evidence)]
    });
  }

  function ngramModel(): NgramModelRecord {
    return {
      id: "model:quality",
      streamId: "stream:quality",
      languageHint: "learned:quality",
      maxOrder: 1,
      discount: 0.75,
      modelJson: {
        sourceSystem: "scce2",
        model: {
          order: 1,
          discount: 0.75,
          symbolCount: 10,
          vocabularySize: 4,
          counts: { "quiet-hours": 4, lighting: 3, cue: 2, glare: 1 },
          contextCounts: {},
          continuationCounts: {},
          contextContinuationTypes: {},
          totalContinuationTypes: 0,
          unigramCounts: { "quiet-hours": 4, lighting: 3, cue: 2, glare: 1 },
          totalUnigramCount: 10,
          vocabulary: ["quiet-hours", "lighting", "cue", "glare"]
        }
      },
      updatedAt: clock.now()
    };
  }

  function ngramObservation(source: SourceVersion): NgramObservation {
    return {
      id: "obs:quality",
      streamId: "stream:quality",
      languageHint: "learned:quality",
      order: 1,
      history: [],
      symbol: "quiet-hours",
      count: 4,
      fieldWeight: 1,
      sourceVersionId: source.sourceVersionId,
      observedAt: clock.now(),
      metadata: { sourceSystem: "scce2", provenanceClass: "learned_language_prior" }
    };
  }

  function languageUnit(source: SourceVersion): LanguageUnitRecord {
    return {
      id: "unit:quality",
      profileId: "profile:quality",
      sourceVersionId: source.sourceVersionId,
      script: "quality-script",
      unitKind: "phrase",
      text: fixture.importedPhrase,
      features: featureSet(fixture.importedPhrase, 64),
      competenceVector: [1],
      alpha: 0.94,
      evidenceIds: [],
      metadata: { sourceSystem: "scce2", provenanceClass: "learned_language_prior" }
    };
  }

  function languagePattern(): LanguagePatternRecord {
    return {
      id: "pattern:quality",
      profileId: "profile:quality",
      patternKind: "syntax",
      support: 0.82,
      entropy: 0.1,
      patternJson: { sourceSystem: "scce2", provenanceClass: "learned_language_prior", counts: { [fixture.importedPhrase]: 2 }, discourse: { boundary: fixture.discourseBoundary } },
      evidenceIds: [],
      updatedAt: clock.now()
    };
  }

  function semanticFrame(evidence: EvidenceSpan): SemanticFrameRecord {
    return {
      id: "frame:quality",
      frameJson: { sourceSystem: "scce2", provenanceClass: "learned_language_prior", surface: fixture.importedSemanticFrame },
      embedding: [],
      evidenceIds: [evidence.id],
      alpha: 0.96,
      createdAt: clock.now()
    };
  }

  function emptyField(drift = 0): FieldState {
    const matrix = { nodes: [], values: [] };
    return {
      requestFeatures: featureSet(fixture.claim, 64),
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
        surfaces: { pressure: 0.2, drift, contradiction: 0, bond: 0, risk: 0, actionability: 0.4 },
        contradictionMass: 0,
        bondedLeakage: 0
      },
      causalMass: []
    };
  }

  function maxInlineBoundaryRun(text: string, boundary: string): number {
    let current = 0;
    let max = 0;
    for (let index = 0; index < text.length; index++) {
      const char = text[index] ?? "";
      if (char === boundary) {
        const left = text[index - 1] ?? "";
        const right = text[index + 1] ?? "";
        if (isDigit(left) && isDigit(right)) continue;
        current++;
        max = Math.max(max, current);
        continue;
      }
      if (char === "." || char === "!" || char === "?") current = 0;
    }
    return max;
  }

  function isDigit(char: string): boolean {
    const code = char.charCodeAt(0);
    return code >= 48 && code <= 57;
  }

  function unitCount(value: JsonValue): number {
    const record = value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, JsonValue> : {};
    return typeof record.unitCount === "number" ? record.unitCount : 0;
  }

  function sentenceCount(text: string): number {
    let count = 0;
    for (const char of text) if (char === "." || char === "!" || char === "?") count++;
    return Math.max(1, count);
  }

  function outputLooksLikeTelemetry(text: string): boolean {
    const surfaces = ["{", "}", "\"", "proofGraph", "validatorVersion", "evidenceIds", "language-memory-runtime", "semantic-proof"];
    return surfaces.some(surface => text.includes(surface));
  }

  function outputContainsCannedBoilerplate(text: string): boolean {
    const lower = text.toLocaleLowerCase();
    return ["as an ai", "i cannot browse", "i am unable", "i do not have access"].some(surface => lower.includes(surface));
  }

  function outputContainsForbiddenTerminology(text: string): boolean {
    const terms = [
      ["n", "e", "u", "r", "a", "l"],
      ["n", "e", "u", "r", "a", "l", " ", "w", "e", "i", "g", "h", "t", "s"],
      ["t", "r", "a", "n", "s", "f", "o", "r", "m", "e", "r", " ", "w", "e", "i", "g", "h", "t", "s"],
      ["m", "o", "d", "e", "l", " ", "w", "e", "i", "g", "h", "t", "s"]
    ].map(chars => chars.join(""));
    const lower = text.toLocaleLowerCase();
    return terms.some(term => lower.includes(term));
  }
});
