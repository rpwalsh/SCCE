import { describe, expect, it } from "vitest";
import {
  createClock,
  createCorrectionMemory,
  createHasher,
  createIdFactory,
  createLanguageMemoryRuntime,
  createMouth,
  createSemanticEntailmentEngine,
  featureSet
} from "../index.js";
import type { ConstructGraph, EvidenceSpan, FieldState, LanguageProfile, SourceVersion } from "../types.js";
import type { SemanticFrameRecord } from "../storage.js";

describe("Mouth temporal counterexample realization", () => {
  const clock = createClock({ fixedTime: 10_000, stepMs: 1 });
  const hasher = createHasher();
  const ids = createIdFactory({ clock, hasher, deterministicReplay: true });
  const languageRuntime = createLanguageMemoryRuntime({ idFactory: ids, hasher });

  it("uses a learned negative bridge before source-grounded counterexample context", async () => {
    const question = "Did Martha Washington invent the idea of using flags to represent nation states?";
    const counterText = "* The national flag of France was designed in 1794. On 12 April 1606, a new union flag was specified. The flag of Denmark, the Dannebrog, is attested in 1478, and is the oldest national flag still in use.";
    const subjectText = "Martha Washington (1731–1802) was the wife of George Washington.";
    const counterSource = sourceVersion("fixture://national-flag", counterText);
    const subjectSource = sourceVersion("fixture://martha-washington", subjectText);
    const counter = evidence(counterSource, counterText);
    const subject = evidence(subjectSource, subjectText);
    const field = emptyField(question);
    const entailment = createSemanticEntailmentEngine({ idFactory: ids, hasher }).check({
      text: question,
      evidence: [counter, subject],
      nodes: [],
      field,
      createdAt: clock.now()
    });
    const languageMemory = languageRuntime.hydrateFromImportedBrain({
      importRunId: "negative-bridge-language",
      models: [],
      observations: [],
      units: [],
      patterns: [],
      semanticFrames: learnedNegativeFrames(counter)
    });
    const mouth = createMouth({
      languageMemory: languageRuntime,
      correctionMemory: createCorrectionMemory({ idFactory: ids, hasher }),
      hashText: text => hasher.digestHex(text)
    });

    const spoken = await mouth.speak({
      construct: temporalCounterexampleConstruct(counter, subject),
      field,
      languageProfile: languageProfile(counterSource),
      evidence: [counter, subject],
      entailment,
      languageMemory,
      requestedAuthority: "factual",
      targetLanguage: "fixture-language"
    });

    expect(spoken.text).toMatch(/^Martha Washington did not invent the idea of using flags to represent nation states\./u);
    expect(spoken.text).toContain("The flag of Denmark, the Dannebrog, is attested in 1478");
    expect(spoken.text).toContain("The national flag of France was designed in 1794");
    expect(spoken.text).toContain("On 12 April 1606");
    expect(spoken.text).not.toContain("On 12.");
    expect(spoken.text.indexOf("1478")).toBeLessThan(spoken.text.indexOf("1794"));
    expect(spoken.text).not.toContain("*");
    expect(spoken.text).not.toMatch(/[¬\[\]]|rel\.|semantic\./u);
    expect(spoken.evidenceRefs).toEqual(expect.arrayContaining([counter.id, subject.id]));
    expect(spoken.realizationTrace.selected.id).toBe("candidate:generated:semantic-temporal-counterexample");
    expect(JSON.stringify(spoken.realizationTrace.brainInfluence)).toContain("frame:negative-bridge:0");
  });

  it("falls back to the contextual counterexample instead of realizing the rejected premise as positive", async () => {
    const question = "Did Martha Washington invent the idea of using flags to represent nation states?";
    const counterText = "One of the earliest examples of a national flag is the flag of Genoa; the Union Flag dates from 1606.";
    const subjectText = "Martha Washington (1731–1802) was the wife of George Washington.";
    const counterSource = sourceVersion("fixture://national-flag-fallback", counterText);
    const subjectSource = sourceVersion("fixture://martha-washington-fallback", subjectText);
    const counter = evidence(counterSource, counterText);
    const subject = evidence(subjectSource, subjectText);
    const field = emptyField(question);
    const entailment = createSemanticEntailmentEngine({ idFactory: ids, hasher }).check({
      text: question,
      evidence: [counter, subject],
      nodes: [],
      field,
      createdAt: clock.now()
    });
    const mouth = createMouth({
      languageMemory: languageRuntime,
      correctionMemory: createCorrectionMemory({ idFactory: ids, hasher }),
      hashText: text => hasher.digestHex(text)
    });
    const spoken = await mouth.speak({
      construct: temporalCounterexampleConstruct(counter, subject),
      field,
      languageProfile: languageProfile(counterSource),
      evidence: [counter, subject],
      entailment,
      languageMemory: languageRuntime.hydrateFromImportedBrain({ importRunId: "empty-language", models: [], observations: [], units: [], patterns: [], semanticFrames: [] }),
      requestedAuthority: "factual",
      targetLanguage: "fixture-language"
    });

    expect(spoken.text).toBe(counterText);
    expect(spoken.text).not.toContain("Martha Washington invent");
    expect(spoken.text).not.toMatch(/[¬\[\]]|rel\.|semantic\./u);
    expect(spoken.evidenceRefs).toEqual(expect.arrayContaining([counter.id, subject.id]));
    expect(spoken.realizationTrace.selected.id).toBe("candidate:generated:semantic-temporal-counterexample");
  });

  function temporalCounterexampleConstruct(counter: EvidenceSpan, subject: EvidenceSpan): ConstructGraph {
    const evidenceIds = [counter.id, subject.id];
    const selectedFacts = [
      {
        subject: "Martha Washington",
        predicate: "¬",
        object: "invent the idea of using flags to represent nation states",
        sourceNodeId: "node:martha-washington",
        targetNodeId: "node:requested-predicate",
        relationId: "rel.8d64be21",
        forceClass: "direct_evidence",
        score: 0.96,
        activation: 0.94,
        overlap: 0.92,
        support: 0.95,
        evidenceIds
      },
      {
        subject: "National flag",
        predicate: "1478",
        object: counter.text,
        sourceNodeId: "node:national-flag",
        targetNodeId: "node:historical-counterexample",
        relationId: "rel.7f1c2a90",
        forceClass: "direct_evidence",
        score: 0.94,
        activation: 0.92,
        overlap: 0.9,
        support: 0.94,
        evidenceIds
      }
    ];
    return {
      id: ids.constructId({ fixture: "temporal-counterexample" }),
      episodeId: ids.episodeId(),
      forceVector: { factual: 1 },
      nodes: [{
        id: "construct:semantic-answer:temporal-counterexample",
        kind: "construct:semantic_answer",
        label: "Martha Washington",
        metadata: {
          schema: "scce.semantic_answer_construct.v1",
          questionShapeId: "qshape.temporal-counterexample",
          selectedSubject: "Martha Washington",
          selectedFacts,
          answerSlots: [],
          selectedRelations: ["rel.8d64be21", "rel.7f1c2a90"],
          activatedNeighborhood: selectedFacts,
          rejectedCandidates: [],
          supportIds: evidenceIds,
          forceId: "output.force.source_bound_answer",
          boundaryId: "output.force.source_bound",
          activeBrainVersion: "fixture-brain",
          activeImportRunIds: ["negative-bridge-language"],
          certificationBoundary: {
            directEvidenceCount: 2,
            evidenceSpanIds: evidenceIds,
            sourceVersionIds: [counter.sourceVersionId, subject.sourceVersionId],
            externalFactCertification: true
          }
        }
      }],
      edges: [],
      artifacts: []
    };
  }

  function learnedNegativeFrames(evidence: EvidenceSpan): SemanticFrameRecord[] {
    return [
      "The council did not adopt the proposal.",
      "The committee did not approve the measure.",
      "The court did not accept the argument.",
      "The delegation did not sign the agreement.",
      "The author did much to clarify the record."
    ].map((surface, index) => ({
      id: `frame:negative-bridge:${index}`,
      frameJson: { surface, sourceSystem: "fixture", provenanceClass: "learned_language_prior" },
      embedding: [],
      evidenceIds: [evidence.id],
      alpha: 0.9 - index * 0.01,
      createdAt: clock.now()
    }));
  }

  function sourceVersion(uri: string, text: string): SourceVersion {
    const bytes = Buffer.from(text);
    return {
      sourceId: ids.sourceId("fixture", uri),
      sourceVersionId: ids.sourceVersionId(bytes),
      namespace: "fixture",
      canonicalUri: uri,
      contentHash: ids.contentHash(bytes),
      mediaType: "text/plain",
      observedAt: clock.now(),
      byteLength: bytes.length,
      sourceTrust: { identity: 0.96, integrity: 0.96, parserReliability: 0.96, directness: 0.96, authority: 0.96, freshness: 0.96, independenceGroup: "fixture:mouth-temporal", accessScope: "fixture", licenseStatus: "fixture" },
      metadata: {}
    };
  }

  function evidence(source: SourceVersion, text: string): EvidenceSpan {
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
      trustVector: { sourceTrust: source.sourceTrust, forceClass: "direct_evidence" },
      provenance: { sourceSystem: "fixture", provenanceClass: "direct_evidence", uri: source.canonicalUri, sourceVersionId: source.sourceVersionId },
      features: featureSet(text, 128),
      status: "promoted",
      alpha: 0.94,
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
      entropy: 0.2,
      createdAt: clock.now()
    };
  }

  function emptyField(request: string): FieldState {
    const matrix = { nodes: [], values: [] };
    return {
      requestFeatures: featureSet(request, 64),
      seeds: [],
      active: [],
      ppf: [],
      ppfDiagnostics: {},
      alphaTrace: {
        alpha: 0.7,
        thresholds: { virtual: 0.49, visible: 0.7, bonded: 0.84, structural: 0.51 },
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
});
