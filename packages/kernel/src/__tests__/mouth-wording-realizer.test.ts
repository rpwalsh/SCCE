import { describe, expect, it } from "vitest";
import { createCorrectionMemory } from "../correction-memory.js";
import { createIdFactory } from "../ids.js";
import { createLanguageAcquisitionEngine } from "../language.js";
import { createLanguageMemoryRuntime } from "../language-memory-runtime.js";
import { createMouth, type SpokenOutput } from "../mouth.js";
import { createClock, createHasher, featureSet } from "../primitives.js";
import { createSemanticEntailmentEngine } from "../entailment.js";
import type { ConstructGraph, EvidenceSpan, FieldState, SourceVersion } from "../types.js";
import type { WordingRealizerPort } from "../storage.js";

const clock = createClock({ fixedTime: 81_000, stepMs: 1 });
const hasher = createHasher();
const ids = createIdFactory({ clock, hasher, deterministicReplay: true, namespace: "mouth-wording-realizer" });
const languageMemoryRuntime = createLanguageMemoryRuntime({ idFactory: ids, hasher });
const languageAcquisition = createLanguageAcquisitionEngine({ idFactory: ids });

const SENTENCE = "Aster powers pump.";
const QUESTION = "What powers the pump?";

/**
 * The port shipped in 1dc41b7 with no test at all, which is exactly why
 * 3fea03c could delete the mouth half of it and leave the interface, the
 * kernel dep, and the production-turn-runtime threading in place -- a port a
 * caller could supply, that was threaded all the way to the mouth, and that
 * silently did nothing. These tests fail if that happens again.
 */
describe("Mouth wording-realizer candidate", () => {
  it("puts a realizer surface into the candidate pool", async () => {
    const spoken = await speakFixture({ surfaces: ["Aster powers the pump directly."] });
    const candidates = realizerCandidates(spoken);
    expect(candidates).toHaveLength(1);
    expect(candidates[0]?.style).toBe("surface.path.generated.wording_realizer");
    expect(JSON.stringify(candidates[0]?.audit)).toContain("scce.mouth.wording_realizer.v1");
  });

  it("carries only evidence ids the facts were already licensed by", async () => {
    const { spoken, evidence } = await speakFixtureWithEvidence({ surfaces: ["Aster powers the pump directly."] });
    expect(JSON.stringify(realizerCandidates(spoken)[0]?.audit)).toContain(String(evidence.id));
  });

  it("rejects a structurally incomplete surface", async () => {
    // No terminal punctuation: the same bar the direct-evidence join meets.
    const spoken = await speakFixture({ surfaces: ["Aster powers the pump directly"] });
    expect(realizerCandidates(spoken)).toHaveLength(0);
  });

  it("rejects a surface that drops a fact argument", async () => {
    // Neither "Aster" nor "pump" survives: wording-only authority means the
    // realizer may rephrase, never quietly restate something else.
    const spoken = await speakFixture({ surfaces: ["Some machine drives another device."] });
    expect(realizerCandidates(spoken)).toHaveLength(0);
  });

  it("admits the intact surface and drops the defective ones from the same batch", async () => {
    const spoken = await speakFixture({
      surfaces: ["Aster powers the pump directly.", "Aster powers the pump", "Some machine drives another device."]
    });
    expect(realizerCandidates(spoken)).toHaveLength(1);
  });

  it("survives a realizer that throws, without failing the turn", async () => {
    // A realizer failure must cost the turn nothing: speak resolves, and the
    // result is indistinguishable from having supplied no realizer at all.
    const baseline = await speakFixture({});
    const spoken = await speakFixture({ throws: true });
    expect(realizerCandidates(spoken)).toHaveLength(0);
    expect(spoken.text).toBe(baseline.text);
    expect(spoken.realizationTrace.candidates).toHaveLength(baseline.realizationTrace.candidates.length);
  });

  it("adds nothing when no realizer is supplied", async () => {
    const spoken = await speakFixture({});
    expect(realizerCandidates(spoken)).toHaveLength(0);
  });

  it("receives facts that already carry evidence ids", async () => {
    const seen: Array<{ evidenceIds: readonly string[] }> = [];
    await speakFixture({
      surfaces: ["Aster powers the pump directly."],
      observe: request => { for (const fact of request.facts) seen.push({ evidenceIds: fact.evidenceIds }); }
    });
    expect(seen.length).toBeGreaterThan(0);
    for (const fact of seen) expect(fact.evidenceIds.length).toBeGreaterThan(0);
  });
});

function realizerCandidates(spoken: SpokenOutput) {
  return spoken.realizationTrace.candidates.filter(candidate => candidate.id.startsWith("candidate:generated:realizer:"));
}

interface FixtureInput {
  surfaces?: readonly string[];
  throws?: boolean;
  observe?: (request: { facts: ReadonlyArray<{ evidenceIds: readonly string[] }> }) => void;
}

async function speakFixture(input: FixtureInput): Promise<SpokenOutput> {
  return (await speakFixtureWithEvidence(input)).spoken;
}

async function speakFixtureWithEvidence(input: FixtureInput): Promise<{ spoken: SpokenOutput; evidence: EvidenceSpan }> {
  const source = sourceVersion(SENTENCE);
  const evidence = evidenceSpan(source, SENTENCE);
  const field = emptyField(QUESTION);
  const entailment = createSemanticEntailmentEngine({ idFactory: ids, hasher }).check({
    text: QUESTION,
    evidence: [evidence],
    nodes: [],
    field,
    createdAt: clock.now()
  });
  const profile = languageAcquisition.acquire({
    sourceVersionId: source.sourceVersionId,
    text: SENTENCE,
    createdAt: clock.now()
  });
  const mouth = createMouth({
    languageMemory: languageMemoryRuntime,
    correctionMemory: createCorrectionMemory({ idFactory: ids, hasher }),
    hashText: text => hasher.digestHex(text),
    hasher
  });
  const wordingRealizer: WordingRealizerPort | undefined = input.surfaces || input.throws
    ? {
      id: "fixture.realizer",
      realize: request => {
        input.observe?.(request);
        if (input.throws) throw new Error("realizer exploded");
        return input.surfaces ?? [];
      }
    }
    : undefined;
  const spoken = await mouth.speak({
    requestText: QUESTION,
    ...(wordingRealizer ? { wordingRealizer } : {}),
    construct: semanticAnswerConstruct(evidence, source),
    field,
    languageProfile: profile,
    evidence: [evidence],
    entailment,
    languageMemory: languageMemoryRuntime.hydrateFromImportedBrain({
      importRunId: `memory.${hasher.digestHex(SENTENCE).slice(0, 12)}`,
      models: [],
      observations: [],
      units: [],
      patterns: [],
      semanticFrames: [],
      constructionEvidence: []
    }),
    targetLanguage: profile.id,
    requestedAuthority: "factual"
  });
  return { spoken, evidence };
}

function semanticAnswerConstruct(evidence: EvidenceSpan, source: SourceVersion): ConstructGraph {
  const relationId = `relation.${hasher.digestHex("powers").slice(0, 12)}`;
  const fact = {
    subject: "Aster",
    predicate: "powers",
    object: "pump",
    sourceNodeId: `node.${hasher.digestHex("Aster").slice(0, 12)}`,
    targetNodeId: `node.${hasher.digestHex("pump").slice(0, 12)}`,
    relationId,
    forceClass: "direct_evidence",
    score: 0.96,
    activation: 0.94,
    overlap: 0.91,
    support: 0.95,
    sourceVersionId: String(source.sourceVersionId),
    evidenceIds: [String(evidence.id)],
    certificationPower: 1,
    semanticQuality: 0.95,
    answerGrade: true,
    finalQuestionFit: 0.91,
    questionSlotScore: 0.9
  };
  return {
    id: ids.constructId({ fixture: "wording-realizer", evidenceId: evidence.id }),
    episodeId: ids.episodeId(),
    forceVector: { factual: 1 },
    nodes: [{
      id: "construct:semantic-answer:wording-realizer",
      kind: "construct:semantic_answer",
      label: "Aster",
      metadata: {
        schema: "scce.semantic_answer_construct.v1",
        questionShapeId: "question.shape.wording-realizer",
        selectedSubject: "Aster",
        selectedFacts: [fact],
        answerSlots: [{
          id: `slot.${hasher.digestHex(relationId).slice(0, 12)}`,
          relationIds: [relationId],
          factKeys: [`${fact.subject}|${fact.predicate}|${fact.object}`],
          support: fact.support,
          activation: fact.activation
        }],
        selectedRelations: [relationId],
        activatedNeighborhood: [fact],
        rejectedCandidates: [],
        supportIds: [String(evidence.id)],
        forceId: "output.force.source_bound_answer",
        boundaryId: "output.force.source_bound",
        activeBrainVersion: "brain.fixture",
        activeImportRunIds: [],
        certificationBoundary: {
          directEvidenceCount: 1,
          evidenceSpanIds: [String(evidence.id)],
          sourceVersionIds: [String(evidence.sourceVersionId)],
          externalFactCertification: true
        }
      }
    }],
    edges: [],
    artifacts: []
  } as unknown as ConstructGraph;
}

function sourceVersion(text: string): SourceVersion {
  const bytes = new TextEncoder().encode(text);
  const uri = `fixture://mouth-realizer/${hasher.digestHex(bytes).slice(0, 20)}`;
  return {
    sourceId: ids.sourceId("fixture", uri),
    sourceVersionId: ids.sourceVersionId(bytes),
    namespace: "fixture",
    canonicalUri: uri,
    contentHash: ids.contentHash(bytes),
    mediaType: "text/plain",
    observedAt: clock.now(),
    byteLength: bytes.byteLength,
    sourceTrust: { identity: 0.98, integrity: 0.98, parserReliability: 0.98, directness: 0.98, authority: 0.98, freshness: 0.98, independenceGroup: "fixture:mouth-realizer", accessScope: "fixture", licenseStatus: "fixture" },
    metadata: {}
  };
}

function evidenceSpan(source: SourceVersion, text: string): EvidenceSpan {
  const bytes = new TextEncoder().encode(text);
  const contentHash = ids.contentHash(bytes);
  return {
    id: ids.evidenceId({ sourceVersionId: source.sourceVersionId, byteStart: 0, byteEnd: bytes.byteLength, spanHash: contentHash }),
    sourceId: source.sourceId,
    sourceVersionId: source.sourceVersionId,
    chunkId: ids.chunkId({ sourceVersionId: source.sourceVersionId, byteStart: 0, byteEnd: bytes.byteLength, chunkHash: contentHash }),
    contentHash,
    mediaType: source.mediaType,
    byteStart: 0,
    byteEnd: bytes.byteLength,
    charStart: 0,
    charEnd: [...text].length,
    text,
    textPreview: text,
    languageHints: {},
    scriptHints: {},
    trustVector: { sourceTrust: source.sourceTrust, forceClass: "direct_evidence" },
    provenance: { sourceSystem: "fixture", sourceVersionId: source.sourceVersionId },
    features: featureSet(text, 128),
    status: "promoted",
    alpha: 0.96,
    observedAt: clock.now()
  };
}

function emptyField(question: string): FieldState {
  const matrix = { nodes: [], values: [] };
  return {
    requestFeatures: featureSet(question, 64),
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
  } as unknown as FieldState;
}
