import { describe, expect, it } from "vitest";
import { createCorrectionMemory } from "../correction-memory.js";
import { createIdFactory } from "../ids.js";
import { createLanguageAcquisitionEngine } from "../language.js";
import { createLanguageMemoryRuntime } from "../language-memory-runtime.js";
import { compileLanguageConstructionPattern } from "../language-construction-memory.js";
import { createMouth, type SpokenOutput } from "../mouth.js";
import { createClock, createHasher, featureSet } from "../primitives.js";
import { createSemanticEntailmentEngine } from "../entailment.js";
import { deriveTurnRequirementField } from "../turn-requirements.js";
import type { ConstructGraph, EvidenceSpan, FieldState, LanguageProfile, SourceVersion } from "../types.js";
import type { LanguagePatternRecord } from "../storage.js";

const clock = createClock({ fixedTime: 81_000, stepMs: 1 });
const hasher = createHasher();
const ids = createIdFactory({ clock, hasher, deterministicReplay: true, namespace: "mouth-learned-construction" });
const languageMemoryRuntime = createLanguageMemoryRuntime({ idFactory: ids, hasher });
const languageAcquisition = createLanguageAcquisitionEngine({ idFactory: ids });

describe("Mouth learned-construction candidate", () => {
  it("preserves a fully role-bound word-spaced evidence sentence exactly", async () => {
    const result = await speakFixture({
      sentence: "Aster  powers pump!",
      subject: "Aster",
      predicate: "powers",
      object: "pump",
      question: "What powers the pump?"
    });

    expect(result.spoken.text).toBe("Aster  powers pump!");
    expect(result.spoken.evidenceRefs).toEqual([result.evidence.id]);
    expect(result.spoken.realizationTrace.selected.id).toMatch(/^candidate:generated:learned-construction:/u);
    const candidate = learnedCandidate(result.spoken);
    expect(JSON.stringify(candidate?.audit)).toContain("scce.mouth.learned_construction_candidate.v2");
    expect(JSON.stringify(candidate?.audit)).toContain("provenance");
    expect(JSON.stringify(candidate?.audit)).toContain("trace");
  });

  it("preserves a no-space script's learned order and punctuation", async () => {
    const result = await speakFixture({
      sentence: "東京在日本。",
      subject: "東京",
      predicate: "在",
      object: "日本",
      question: "東京在哪国？"
    });

    expect(result.spoken.text).toBe("東京在日本。");
    expect(result.spoken.text).not.toContain(" ");
    expect(result.spoken.realizationTrace.selected.id).toMatch(/^candidate:generated:learned-construction:/u);
  });

  it("preserves RTL logical order from the aligned evidence surface", async () => {
    const result = await speakFixture({
      sentence: "ירושלים נמצאת בישראל.",
      subject: "ירושלים",
      predicate: "נמצאת",
      object: "בישראל",
      question: "היכן נמצאת ירושלים?"
    });

    expect(result.profile.direction).toBe("rtl");
    expect(result.spoken.text).toBe("ירושלים נמצאת בישראל.");
    const slotSurfaces = candidateTrace(result.spoken)
      .filter(part => part.kind === "slot")
      .map(part => part.surface);
    expect(slotSurfaces).toEqual(["ירושלים", "נמצאת", "בישראל"]);
  });

  it("rejects subject/object co-occurrence when the selected relation is not aligned", async () => {
    const result = await speakFixture({
      sentence: "Aster observes pump.",
      subject: "Aster",
      predicate: "powers",
      object: "pump",
      question: "What powers the pump?"
    });

    expect(result.spoken.realizationTrace.candidates.some(candidate => (
      candidate.id.startsWith("candidate:generated:learned-construction:")
    ))).toBe(false);
  });

  it("does not induce a construction from the proof sentence being emitted", async () => {
    const result = await speakFixture({
      sentence: "Aster powers pump.",
      subject: "Aster",
      predicate: "powers",
      object: "pump",
      question: "What powers the pump?",
      persistConstruction: false
    });

    expect(learnedCandidate(result.spoken)).toBeUndefined();
    expect(JSON.stringify(result.spoken.realizationTrace)).not.toContain("scce.mouth.learned_construction_candidate.v2");
  });

  it("rejects unbound negation and extra clause content", async () => {
    const negative = await speakFixture({
      sentence: "Aster does not power pump.",
      subject: "Aster",
      predicate: "power",
      object: "pump",
      question: "What powers the pump?"
    });
    const extraClause = await speakFixture({
      sentence: "Aster powers pump, valve fails.",
      subject: "Aster",
      predicate: "powers",
      object: "pump",
      question: "What powers the pump?"
    });

    expect(learnedCandidate(negative.spoken)).toBeUndefined();
    expect(learnedCandidate(extraClause.spoken)).toBeUndefined();
  });

  it("rejects incomplete answer-slot coverage and non-admissible route signals", async () => {
    const incomplete = await speakFixture({
      sentence: "Aster powers pump.",
      subject: "Aster",
      predicate: "powers",
      object: "pump",
      question: "What powers the pump?",
      completeCoverage: false
    });
    const weakRoute = await speakFixture({
      sentence: "Aster powers pump.",
      subject: "Aster",
      predicate: "powers",
      object: "pump",
      question: "What powers the pump?",
      answerGrade: false,
      finalQuestionFit: 0.2
    });

    expect(learnedCandidate(incomplete.spoken)).toBeUndefined();
    expect(learnedCandidate(weakRoute.spoken)).toBeUndefined();
  });

  it("requires exact profile source ownership and target-profile agreement", async () => {
    const wrongOwner = await speakFixture({
      sentence: "Aster powers pump.",
      subject: "Aster",
      predicate: "powers",
      object: "pump",
      question: "What powers the pump?",
      profileCorpus: "Beryl guides turbine."
    });
    const wrongTarget = await speakFixture({
      sentence: "Aster powers pump.",
      subject: "Aster",
      predicate: "powers",
      object: "pump",
      question: "What powers the pump?",
      targetLanguage: "profile.target.mismatch"
    });

    expect(learnedCandidate(wrongOwner.spoken)).toBeUndefined();
    expect(learnedCandidate(wrongTarget.spoken)).toBeUndefined();
  });

  it("honors length, caveat, and proof-format constraints by declining exact output", async () => {
    const tooLong = await speakFixture({
      sentence: "Aster powers pump.",
      subject: "Aster",
      predicate: "powers",
      object: "pump",
      question: "What powers the pump?",
      maxLength: 8
    });
    const caveatRequired = await speakFixture({
      sentence: "Aster powers pump.",
      subject: "Aster",
      predicate: "powers",
      object: "pump",
      question: "What powers the pump?",
      learningCaveat: true
    });
    const proofFormat = await speakFixture({
      sentence: "Aster powers pump.",
      subject: "Aster",
      predicate: "powers",
      object: "pump",
      question: "What powers the pump?",
      exposeProofTerms: true
    });
    const structuredFormat = await speakFixture({
      sentence: "Aster powers pump.",
      subject: "Aster",
      predicate: "powers",
      object: "pump",
      question: "What powers the pump?",
      requirementField: true
    });

    expect(learnedCandidate(tooLong.spoken)).toBeUndefined();
    expect(learnedCandidate(caveatRequired.spoken)).toBeUndefined();
    expect(learnedCandidate(proofFormat.spoken)).toBeUndefined();
    expect(learnedCandidate(structuredFormat.spoken)).toBeUndefined();
  });

  it("keeps closing quotation punctuation and reports code-point evidence offsets", async () => {
    const sentence = "“Aster powers pump.”";
    const result = await speakFixture({
      sentence,
      evidenceText: `🧪\n${sentence}`,
      evidenceCharStart: 11,
      subject: "Aster",
      predicate: "powers",
      object: "pump",
      question: "What powers the pump?"
    });

    expect(result.spoken.text).toBe(sentence);
    const alignment = candidateAlignment(result.spoken);
    expect(alignment?.coordinateSystemId).toBe("unicode.code_point.v1");
    expect(alignment?.sentenceStart).toBe(13);
    expect(alignment?.sentenceEnd).toBe(13 + [...sentence].length);
  });

  it("does not label an evidence sentence with an incompatible active language profile", async () => {
    const result = await speakFixture({
      sentence: "東京在日本。",
      subject: "東京",
      predicate: "在",
      object: "日本",
      question: "東京在哪国？",
      profileCorpus: "აბგდევზთიკლმნოპჟრსტუფქღყშჩცძწჭხჯჰ"
    });

    expect(result.spoken.realizationTrace.candidates.some(candidate => (
      candidate.id.startsWith("candidate:generated:learned-construction:")
    ))).toBe(false);
  });
});

async function speakFixture(input: {
  sentence: string;
  evidenceText?: string;
  evidenceCharStart?: number;
  subject: string;
  predicate: string;
  object: string;
  question: string;
  profileCorpus?: string;
  completeCoverage?: boolean;
  answerGrade?: boolean;
  finalQuestionFit?: number;
  targetLanguage?: string;
  maxLength?: number;
  learningCaveat?: boolean;
  exposeProofTerms?: boolean;
  requirementField?: boolean;
  persistConstruction?: boolean;
}): Promise<{ spoken: SpokenOutput; evidence: EvidenceSpan; profile: LanguageProfile }> {
  const evidenceText = input.evidenceText ?? input.sentence;
  const source = sourceVersion(evidenceText);
  const evidence = evidenceSpan(source, evidenceText, input.evidenceCharStart ?? 0);
  const field = emptyField(input.question);
  const entailment = createSemanticEntailmentEngine({ idFactory: ids, hasher }).check({
    text: input.question,
    evidence: [evidence],
    nodes: [],
    field,
    createdAt: clock.now()
  });
  const profileSource = input.profileCorpus ? sourceVersion(input.profileCorpus) : source;
  const profile = languageAcquisition.acquire({
    sourceVersionId: profileSource.sourceVersionId,
    text: input.profileCorpus ?? evidenceText,
    createdAt: clock.now()
  });
  const mouth = createMouth({
    languageMemory: languageMemoryRuntime,
    correctionMemory: createCorrectionMemory({ idFactory: ids, hasher }),
    hashText: text => hasher.digestHex(text),
    hasher
  });
  const relationId = `relation.${hasher.digestHex(input.predicate).slice(0, 12)}`;
  const fact = {
    subject: input.subject,
    predicate: input.predicate,
    object: input.object,
    sourceNodeId: `node.${hasher.digestHex(input.subject).slice(0, 12)}`,
    targetNodeId: `node.${hasher.digestHex(input.object).slice(0, 12)}`,
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
    answerGrade: input.answerGrade ?? true,
    finalQuestionFit: input.finalQuestionFit ?? 0.91,
    questionSlotScore: 0.9
  };
  const constructionPattern = input.persistConstruction === false
    ? undefined
    : persistedConstructionPattern({
      evidence,
      surface: input.sentence,
      profileId: profile.id,
      relationId,
      subject: input.subject,
      predicate: input.predicate,
      object: input.object
    });
  const spoken = await mouth.speak({
    construct: semanticAnswerConstruct(fact, evidence, input.completeCoverage ?? true),
    field,
    languageProfile: profile,
    evidence: [evidence],
    entailment,
    languageMemory: languageMemoryRuntime.hydrateFromImportedBrain({
      importRunId: `memory.${hasher.digestHex(input.sentence).slice(0, 12)}`,
      models: [],
      observations: [],
      units: [],
      patterns: constructionPattern ? [constructionPattern] : [],
      semanticFrames: [],
      constructionEvidence: constructionPattern ? [evidence] : []
    }),
    targetLanguage: input.targetLanguage ?? profile.id,
    requestedAuthority: "factual",
    maxLength: input.maxLength,
    style: input.exposeProofTerms ? { exposeProofTerms: true } : undefined,
    requirementField: input.requirementField ? deriveTurnRequirementField({ requestText: input.question }) : undefined,
    learningDecision: input.learningCaveat ? {
      id: "continue:learned-construction:caveat",
      decisionKindId: "continue.answer_with_caveat",
      continueAnswering: false,
      askClarification: false,
      answerWithCaveat: true,
      deferDueToInsufficientEvidence: false,
      reportContradiction: false,
      reportUnsupported: false,
      safeToAssert: false,
      reasonCodes: ["surface.fixture.caveat"],
      trace: { fixture: true }
    } : undefined
  });
  return { spoken, evidence, profile };
}

function persistedConstructionPattern(input: {
  evidence: EvidenceSpan;
  surface: string;
  profileId: string;
  relationId: string;
  subject: string;
  predicate: string;
  object: string;
}): LanguagePatternRecord | undefined {
  const evidencePoints = [...input.evidence.text];
  const surfacePoints = [...input.surface];
  const surfaceStart = exactOccurrence(evidencePoints, surfacePoints);
  if (surfaceStart === undefined) return undefined;
  const roles = [input.subject, input.predicate, input.object].map((value, slotIndex) => {
    const start = exactOccurrence(surfacePoints, [...value]);
    return start === undefined ? undefined : {
      slotIndex,
      startCodePoint: start,
      endCodePoint: start + [...value].length
    };
  });
  if (roles.some(role => !role)) return undefined;
  const compiled = compileLanguageConstructionPattern({
    bindingId: input.relationId,
    profileId: input.profileId,
    observations: [{
      sourceVersionId: String(input.evidence.sourceVersionId),
      evidenceId: String(input.evidence.id),
      surfaceStartCodePoint: surfaceStart,
      surfaceEndCodePoint: surfaceStart + surfacePoints.length,
      roles: roles.filter((role): role is NonNullable<typeof role> => Boolean(role))
    }],
    evidence: [input.evidence],
    hasher,
    updatedAt: clock.now()
  });
  return compiled.status === "compiled" ? compiled.pattern : undefined;
}

function exactOccurrence(source: readonly string[], wanted: readonly string[]): number | undefined {
  const starts: number[] = [];
  for (let index = 0; index <= source.length - wanted.length; index += 1) {
    if (wanted.every((point, offset) => source[index + offset] === point)) starts.push(index);
  }
  return starts.length === 1 ? starts[0] : undefined;
}

function semanticAnswerConstruct(
  fact: Record<string, string | number | boolean | string[]>,
  evidence: EvidenceSpan,
  completeCoverage: boolean
): ConstructGraph {
  return {
    id: ids.constructId({ fixture: "learned-construction", evidenceId: evidence.id }),
    episodeId: ids.episodeId(),
    forceVector: { factual: 1 },
    nodes: [{
      id: "construct:semantic-answer:learned-construction",
      kind: "construct:semantic_answer",
      label: String(fact.subject),
      metadata: {
        schema: "scce.semantic_answer_construct.v1",
        questionShapeId: "question.shape.learned-construction",
        selectedSubject: String(fact.subject),
        selectedFacts: [fact],
        answerSlots: completeCoverage ? [{
          id: `slot.${hasher.digestHex(String(fact.relationId)).slice(0, 12)}`,
          relationIds: [String(fact.relationId)],
          factKeys: [semanticFactKey(fact)],
          support: Number(fact.support),
          activation: Number(fact.activation)
        }] : [],
        selectedRelations: [String(fact.relationId)],
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
  };
}

function semanticFactKey(fact: Record<string, string | number | boolean | string[]>): string {
  return [fact.subject, fact.predicate, fact.object, fact.relationId]
    .map(value => String(value).normalize("NFKC").toLocaleLowerCase().replace(/\s+/gu, " ").trim())
    .join("\u0001");
}

function sourceVersion(text: string): SourceVersion {
  const bytes = new TextEncoder().encode(text);
  const uri = `fixture://mouth-learned/${hasher.digestHex(bytes).slice(0, 20)}`;
  return {
    sourceId: ids.sourceId("fixture", uri),
    sourceVersionId: ids.sourceVersionId(bytes),
    namespace: "fixture",
    canonicalUri: uri,
    contentHash: ids.contentHash(bytes),
    mediaType: "text/plain",
    observedAt: clock.now(),
    byteLength: bytes.byteLength,
    sourceTrust: { identity: 0.98, integrity: 0.98, parserReliability: 0.98, directness: 0.98, authority: 0.98, freshness: 0.98, independenceGroup: "fixture:mouth-construction", accessScope: "fixture", licenseStatus: "fixture" },
    metadata: {}
  };
}

function evidenceSpan(source: SourceVersion, text: string, charStart: number): EvidenceSpan {
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
    charStart,
    charEnd: charStart + [...text].length,
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
  };
}

function learnedCandidate(spoken: SpokenOutput) {
  return spoken.realizationTrace.candidates.find(candidate => (
    candidate.id.startsWith("candidate:generated:learned-construction:")
  ));
}

function candidateTrace(spoken: SpokenOutput): Array<{ kind?: string; surface?: string }> {
  const audit = learnedCandidate(spoken)?.audit;
  if (!audit || typeof audit !== "object" || Array.isArray(audit)) return [];
  const realization = audit.realization;
  if (!realization || typeof realization !== "object" || Array.isArray(realization)) return [];
  return Array.isArray(realization.trace)
    ? realization.trace.filter((row): row is { kind?: string; surface?: string } => Boolean(row && typeof row === "object" && !Array.isArray(row)))
    : [];
}

function candidateAlignment(spoken: SpokenOutput): { coordinateSystemId?: string; sentenceStart?: number; sentenceEnd?: number } | undefined {
  const audit = learnedCandidate(spoken)?.audit;
  if (!audit || typeof audit !== "object" || Array.isArray(audit)) return undefined;
  const bundle = audit.bundle;
  if (!bundle || typeof bundle !== "object" || Array.isArray(bundle) || !Array.isArray(bundle.sourceExamples)) return undefined;
  const example = bundle.sourceExamples[0];
  if (!example || typeof example !== "object" || Array.isArray(example)) return undefined;
  const evidenceCharStart = Number(example.evidenceCharStart);
  const surfaceStart = Number(example.surfaceStartCodePoint);
  const surfaceEnd = Number(example.surfaceEndCodePoint);
  return {
    coordinateSystemId: typeof example.coordinateSystemId === "string" ? example.coordinateSystemId : undefined,
    sentenceStart: evidenceCharStart + surfaceStart,
    sentenceEnd: evidenceCharStart + surfaceEnd
  };
}
