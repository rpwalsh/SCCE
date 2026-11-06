// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
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
  detailProfileIdFromSignal
} from "../index.js";
import type { ConstructGraph, EvidenceSpan, FieldState, JsonValue, LanguageProfile, SemanticEntailmentResult, SourceVersion } from "../types.js";
import type { LanguagePatternRecord, LanguageUnitRecord, NgramModelRecord, NgramObservation, SemanticFrameRecord } from "../storage.js";
import { genericChatQualityFixture as fixture } from "./fixtures/generic-chat-quality-fixture.js";
import { sourceOwnedMouthTeaching } from "./fixtures/source-owned-mouth-teaching.js";
import { withSurfaceContract } from "../mouth.js";
import { SURFACE_REALIZATION_STRATEGY_IDS } from "../surface-contract.js";

describe("Mouth generic chat quality gate", () => {
  const clock = createClock({ fixedTime: 7000, stepMs: 1 });
  const hasher = createHasher();
  const ids = createIdFactory({ clock, hasher, deterministicReplay: true });
  const languageRuntime = createLanguageMemoryRuntime({ idFactory: ids, hasher });
  const teachingCache = new WeakMap<EvidenceSpan, ReturnType<typeof sourceOwnedMouthTeaching>>();
  function teaching(evidence: EvidenceSpan) {
    let value = teachingCache.get(evidence);
    if (!value) {
      value = sourceOwnedMouthTeaching({ ids, hasher, evidence, profileId: "quality-language", phrase: fixture.importedPhrase,
        subject: "The library lighting policy", predicate: "dims", object: "reading-room lights to 40% after 9:00 p.m. so late patrons have less screen glare" });
      teachingCache.set(evidence, value);
    }
    return value;
  }

  it("handles normal chat shapes without evidence copying, telemetry output, or boundary stitching", async () => {
    const source = sourceVersion();
    const evidence = directEvidence(source);
    const field = emptyField();
    const entailment = semanticEntailment(evidence, field);
    const languageMemory = importedMemory(source, evidence, "quality-import");
    const mouth = createMouth({ languageMemory: languageRuntime, correctionMemory: createCorrectionMemory({ idFactory: ids, hasher }), hashText: text => hasher.digestHex(text) });

    const conversational = await mouth.speak(baseInput({ source, evidence, field, entailment, languageMemory, construct: constructGraph(false) }));
    const conciseProfileId = detailProfileIdFromSignal("brief");
    const detailedProfileId = detailProfileIdFromSignal("detailed");
    if (!conciseProfileId || !detailedProfileId) throw new Error("detail signal fixture failed");
    const concise = await mouth.speak({ ...baseInput({ source, evidence, field, entailment, languageMemory, construct: constructGraph(false) }), detailProfileId: conciseProfileId, style: { density: 0.24 } });
    const detailed = await mouth.speak({ ...baseInput({ source, evidence, field, entailment, languageMemory, construct: constructGraph(false) }), detailProfileId: detailedProfileId, style: { density: 0.88 } });

    assertQuality(conversational, evidence, { importedPriorIds: true });
    assertQuality(concise, evidence, { importedPriorIds: true });
    assertQuality(detailed, evidence, { importedPriorIds: true });
    expect(unitCount(concise.realizationTrace.discoursePlan)).toBeLessThanOrEqual(unitCount(detailed.realizationTrace.discoursePlan));
    expect(sentenceCount(concise.text)).toBeLessThanOrEqual(sentenceCount(detailed.text));
  });

  it("reuses one bounded imported-surface scan without changing answer semantics", async () => {
    const source = sourceVersion();
    const evidence = directEvidence(source);
    const field = emptyField();
    const entailment = semanticEntailment(evidence, field);
    const languageMemory = importedMemory(source, evidence, "quality-import-scan");
    const sliceCalls: Array<{ collection: string; start?: number; end?: number }> = [];
    const tracked = <T>(collection: string, rows: T[]): T[] => new Proxy(rows, {
      get(target, property, receiver) {
        if (property !== "slice") return Reflect.get(target, property, receiver);
        return (start?: number, end?: number) => {
          sliceCalls.push({ collection, start, end });
          return target.slice(start, end);
        };
      }
    });
    const trackedMemory = {
      ...languageMemory,
      importedUnits: tracked("units", languageMemory.importedUnits),
      importedObservations: tracked("observations", languageMemory.importedObservations),
      importedPatterns: tracked("patterns", languageMemory.importedPatterns),
      importedSemanticFrames: tracked("semanticFrames", languageMemory.importedSemanticFrames)
    };
    const mouth = createMouth({ languageMemory: languageRuntime, correctionMemory: createCorrectionMemory({ idFactory: ids, hasher }), hashText: text => hasher.digestHex(text) });
    const baseline = await mouth.speak(baseInput({ source, evidence, field, entailment, languageMemory, construct: constructGraph(false) }));
    const observed = await mouth.speak(baseInput({ source, evidence, field, entailment, languageMemory: trackedMemory, construct: constructGraph(false) }));

    expect(observed.text).toBe(baseline.text);
    expect(observed.realizationTrace.selected).toEqual(baseline.realizationTrace.selected);
    expect(observed.evidenceRefs).toEqual(baseline.evidenceRefs);
    // phaseMs records real wall-clock durations per Mouth phase and will
    // never be identical across two independent speak() calls; compare
    // everything else in the trace verbatim.
    expect(withoutPhaseMs(observed.realizationTrace)).toEqual(withoutPhaseMs(baseline.realizationTrace));
    expect(sliceCalls.filter(call => call.collection === "observations" && call.start === 0 && call.end === 512)).toHaveLength(1);
    expect(sliceCalls.filter(call => call.collection === "semanticFrames" && call.start === 0 && call.end === 256)).toHaveLength(1);
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
    expect(caveated.text).not.toContain(fixture.caveatText);

    expect(creative.force).toBe("creative");
    expect(JSON.stringify(creative.surfacePlan)).toContain(fixture.creativeArtifact.content);
    expect(creative.text).not.toContain("scce.invention_construct");
    expect(creative.text).not.toContain("→");

    assertQuality(corrected, evidence, { importedPriorIds: true, correctionId: correction.id });
    expect(corrected.text).toContain(fixture.correction.preferredSurface);
    expect(corrected.text).not.toContain(fixture.correction.observedSurface);
    expect(JSON.stringify(corrected.realizationTrace.corrections)).toContain(correction.id);
  });

  it("does not let repeated hostile semantic-error reports suppress an evidence-grounded surface", async () => {
    const source = sourceVersion();
    const evidence = directEvidence(source);
    const field = emptyField();
    const entailment = semanticEntailment(evidence, field);
    const languageMemory = importedMemory(source, evidence, "quality-import-semantic-boundary");
    const correctionMemory = createCorrectionMemory({ idFactory: ids, hasher });
    const semanticErrors = Array.from({ length: 8 }, (_, index) => correctionMemory.record({
      episodeId: ids.episodeId(),
      ownerFeedbackEventId: ids.eventId(),
      now: clock.now(),
      correction: {
        // An adversary may attach a semantic-error label to the proposition
        // they want hidden. Repetition must not make that label factual evidence.
        kind: "semantic_error",
        observedSurface: fixture.claim,
        weight: 1,
        metadata: { ownerAssertion: "unsupported contrary assertion", attempt: index }
      }
    }));
    const mouth = createMouth({ languageMemory: languageRuntime, correctionMemory, hashText: text => hasher.digestHex(text) });
    const baseline = await mouth.speak(baseInput({ source, evidence, field, entailment, languageMemory, construct: constructGraph(false) }));
    const withOwnerDenial = await mouth.speak({
      ...baseInput({ source, evidence, field, entailment, languageMemory, construct: constructGraph(false) }),
      correctionRules: semanticErrors
    });

    expect(withOwnerDenial.text).toBe(baseline.text);
    const audit = withOwnerDenial.surfacePlan.audit as Record<string, unknown>;
    const forbidden = JSON.stringify(audit.forbiddenSurfaceForms ?? []);
    for (const semanticError of semanticErrors) expect(forbidden).not.toContain(semanticError.id);
  });

  it.each([
    ["changed quantity", fixture.importedSemanticFrame.replace("40%", "60%"), "60%"],
    ["negated relation", fixture.importedSemanticFrame.replace("dims", "never dims"), "never dims"],
    ["extra world clause", `${fixture.importedSemanticFrame} The library serves free dinners.`, "free dinners"],
    ["wrong owner", fixture.importedSemanticFrame.replace("library", "hospital"), "hospital"]
  ])("does not promote a learned frame's %s to documentary knowledge", async (_name, surface, forbidden) => {
    const source = sourceVersion();
    const evidence = directEvidence(source);
    const field = emptyField();
    const languageMemory = importedMemory(source, evidence, "quality-import-hostile");
    const original = languageMemory.importedSemanticFrames[0]!;
    languageMemory.importedSemanticFrames[0] = { ...original, frameJson: { ...original.frameJson as Record<string, JsonValue>, surface } };
    const spoken = await createMouth({ languageMemory: languageRuntime, correctionMemory: createCorrectionMemory({ idFactory: ids, hasher }), hashText: text => hasher.digestHex(text) }).speak(baseInput({ source, evidence, field, entailment: semanticEntailment(evidence, field), languageMemory, construct: constructGraph(false) }));
    expect(spoken.text).not.toContain(forbidden);
  });

  it.each([
    { subject: "The observatory", predicate: "dims", object: "aisle lights to 55% after 22:00", phrase: "quiet-hours lighting cue", sourceDerivedBinding: true,
      examples: [["Annex", "dims", "reading lights to 20%"], ["Atrium", "dims", "reading lights to 30%"]] as const,
      source: "The observatory dims aisle lights to 55% after 22:00.", render: (slots: readonly string[]) => `quiet-hours lighting cue: ${slots.join(" ")}.` },
    { subject: "中央図書館", predicate: "調光", object: "照明を４５％へ", phrase: "夜間照明",
      examples: [["東館", "調光", "照明を２０％へ"], ["西館", "調光", "照明を３０％へ"]] as const,
      source: "中央図書館調光照明を４５％へ。", render: (slots: readonly string[]) => `夜間照明：${slots.join("")}。` }
  ])("transfers the imported form to an unseen source-owned subject and value ($subject)", async test => {
    const source = sourceVersion(test.source);
    const evidence = directEvidence(source, test.source);
    const taught = sourceOwnedMouthTeaching({ ids, hasher, evidence, profileId: "quality-transfer", ...test });
    const memory = languageRuntime.hydrateFromImportedBrain({ importRunId: "quality-transfer", models: [], observations: [], units: [],
      patterns: [taught.pattern], semanticFrames: [], constructionEvidence: taught.lessons });
    const field = emptyField();
    const entailment = createSemanticEntailmentEngine({ idFactory: ids, hasher }).check({ text: test.source, evidence: [evidence], nodes: [], field, createdAt: clock.now() });
    const mouth = createMouth({ languageMemory: languageRuntime, correctionMemory: createCorrectionMemory({ idFactory: ids, hasher }), hashText: text => hasher.digestHex(text) });
    const base = constructGraph(false);
    const input = { construct: { ...base, nodes: [...base.nodes, taught.semanticNode] }, field, entailment, languageProfile: taught.profile,
      evidence: [evidence], languageMemory: memory, targetLanguage: taught.profile.id };
    const spoken = await mouth.speak(input);
    expect(spoken.text).toBe(test.render([test.subject, test.predicate, test.object]));
    expect(spoken.text).not.toBe(test.source);
    expect(spoken.evidenceRefs).toEqual([evidence.id]);
    expect(spoken.realizationTrace.selected.id).toMatch(/^candidate:generated:learned-construction:/u);
    expect(JSON.stringify(spoken.realizationTrace.selected.audit)).toContain(taught.pattern.id);
    for (const text of [
      spoken.text.replace(test.subject, "unrelated-owner"),
      spoken.text.replace(test.object, test.examples[0][2]),
      spoken.text.replace(test.predicate, `¬${test.predicate}`),
      `${spoken.text} unrelated-world-clause`
    ]) {
      const mutated = withSurfaceContract(input, { ...spoken, text }, SURFACE_REALIZATION_STRATEGY_IDS.learned);
      expect(mutated.text).toBe("");
      expect(JSON.stringify(mutated.realizationTrace.surfaceContract)).toContain("surface.reject.factual_surface_mutated_after_selection");
    }
    const ablated = await mouth.speak({ ...input, languageMemory: languageRuntime.hydrateFromImportedBrain({ importRunId: "quality-ablated", models: [], observations: [], units: [], patterns: [], semanticFrames: [] }) });
    expect(ablated.text).not.toContain(test.phrase);
    expect(ablated.realizationTrace.selected.id).not.toMatch(/^candidate:generated:learned-construction:/u);
    const onceTaught = sourceOwnedMouthTeaching({ ids, hasher, evidence, profileId: taught.profile.id, ...test, examples: test.examples.slice(0, 1) });
    const once = await mouth.speak({ ...input,
      entailment: { ...entailment, verdict: "underdetermined", semanticVerdict: "underdetermined", evidenceIds: [],
        proof: { ...entailment.proof, scores: {}, validatorVersion: "", evidenceIds: [], proofGraph: { nodes: [], edges: [] } } },
      languageMemory: languageRuntime.hydrateFromImportedBrain({ importRunId: "quality-observed-once", models: [], observations: [], units: [],
        patterns: [onceTaught.pattern], semanticFrames: [], constructionEvidence: onceTaught.lessons })
    });
    expect(once.text).toBe(spoken.text);
    expect(once.evidenceRefs).toEqual([evidence.id]);
    expect(once.uncertainty).toContainEqual(expect.objectContaining({ reason: "surface.uncertainty.source_observed_form" }));
    expect(JSON.stringify(once.realizationTrace.selected.audit)).toContain("observed_once");
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
      construct: input.construct.artifacts.length ? input.construct : { ...input.construct, nodes: [...input.construct.nodes, teaching(input.evidence).semanticNode] },
      field: input.field,
      languageProfile: teaching(input.evidence).profile,
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
    if (options.caveat) expect(spoken.uncertainty.length).toBeGreaterThan(0);
    if (options.creative) expect(JSON.stringify(spoken.surfacePlan)).toContain(fixture.creativeArtifact.content);
    if (options.correctionId) expect(JSON.stringify(spoken.realizationTrace.corrections)).toContain(options.correctionId);
  }

  function sourceVersion(text: string = fixture.evidenceText): SourceVersion {
    const bytes = Buffer.from(text);
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
      sourceTrust: { identity: 0.94, integrity: 0.94, parserReliability: 0.94, directness: 0.94, authority: 0.94, freshness: 0.94, independenceGroup: "fixture:mouth-generic", accessScope: "fixture", licenseStatus: "fixture" },
      metadata: {}
    };
  }

  function directEvidence(source: SourceVersion, text: string = fixture.evidenceText): EvidenceSpan {
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
      charEnd: [...text].length,
      text,
      textPreview: text,
      languageHints: {},
      scriptHints: {},
      trustVector: { sourceTrust: source.sourceTrust, forceClass: "direct_evidence" },
      provenance: { sourceSystem: "fixture", provenanceClass: "direct_evidence", uri: source.canonicalUri, sourceVersionId: source.sourceVersionId, byteRange: [0, bytes.length], charRange: [0, [...text].length] },
      features: featureSet(text, 128),
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
      patterns: [languagePattern(), teaching(evidence).pattern],
      semanticFrames: [semanticFrame(evidence)],
      constructionEvidence: teaching(evidence).lessons
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

  function withoutPhaseMs(value: unknown): unknown {
    if (Array.isArray(value)) return value.map(withoutPhaseMs);
    if (value && typeof value === "object") {
      return Object.fromEntries(
        Object.entries(value as Record<string, unknown>)
          // Real wall-clock durations (phaseMs, measuredMs, ...) never match
          // between two independent speak() calls; strip any such field.
          .filter(([key, inner]) => !(/Ms$/.test(key) && (typeof inner === "number" || (inner && typeof inner === "object"))))
          .map(([key, inner]) => [key, withoutPhaseMs(inner)])
      );
    }
    return value;
  }
});
