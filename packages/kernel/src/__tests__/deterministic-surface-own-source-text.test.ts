// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  createClock,
  createDeterministicMouth,
  createHasher,
  createIdFactory,
  createLanguageMemoryRuntime,
  createSemanticEntailmentEngine,
  featureSet
} from "../index.js";
import { trainKneserNey } from "../kneser-ney.js";
import { answerCoversRequest } from "../local-evidence-runtime.js";
import { clearCorpusIdentitySignals, primeCorpusIdentitySignals } from "../corpus-identity.js";
import { resetCorpusIdentityMeasurements } from "../corpus-identity-runtime.js";
import type { CandidateSurface } from "../candidate-contract.js";
import type { SpeakInput } from "../mouth.js";
import type { NgramModelRecord } from "../storage.js";
import type { ConstructGraph, EvidenceSpan, FieldState, LanguageProfile } from "../types.js";
import { DIALOGUE_POPULATION } from "./conversational-session-fixture.js";

const clock = createClock({ fixedTime: 9000, stepMs: 1 });
const hasher = createHasher();
const ids = createIdFactory({ clock, hasher, deterministicReplay: true });
const languageRuntime = createLanguageMemoryRuntime({ idFactory: ids, hasher });
const TRAINED = trainKneserNey(DIALOGUE_POPULATION, { order: 3 });

const REQUEST = "What is the program planner?";

// The shape of evidence_span.8e0f0b10...e1ac20dd6cdc (docs/PRODUCTION_COMPLETION_PLAN_250.md), the span this
// repository's own corpus admitted for REQUEST, measured warm 2026-09-16T21:12:00Z: selected at 640 chars by
// mouth.deterministic.select and emitted as 0, because "planner.ts"/"runtime.ts" match CONTROL_ID_PATTERN and the
// re-check after selection was handed no evidence to tell a leaked id from a source line.
const OWN_SOURCE_TEXT = [
  "The program planner is not just an intermediate library layer: `code-learning.ts`'s `blueprint()`",
  "is already invoked live via `program-planner.ts`'s `emit()` and `program.ts`'s",
  "`createProgramGraphBuilder().build()`, the exact function `production-turn-runtime.ts` calls for every",
  "code-shaped turn."
].join(" ");

// The same shape, absent from every admitted span: still a leak, still refused.
const LEAKED_CONTROL_ID = "The program planner is decided by surface.boundary.decline and proof.status.non_certifying.v3 here.";

describe("a source's own text is speakable; a control id the corpus does not contain is not", () => {
  beforeEach(() => { clearCorpusIdentitySignals(); resetCorpusIdentityMeasurements(); });
  afterEach(() => { clearCorpusIdentitySignals(); resetCorpusIdentityMeasurements(); });
  it("speaks the admitted span's own text even though it carries a control-id shape", async () => {
    const spoken = await speakDeterministic(OWN_SOURCE_TEXT, OWN_SOURCE_TEXT);
    expect(spoken.text).toContain("program-planner.ts");
  });

  it("still refuses a control id no admitted span contains", async () => {
    const spoken = await speakDeterministic(LEAKED_CONTROL_ID, OWN_SOURCE_TEXT);
    expect(spoken.text).not.toContain("surface.boundary.decline");
    expect(spoken.text).not.toContain("proof.status.non_certifying");
  });

  it("keeps an exact source excerpt bound to its own span when another admitted span supplies relation words", async () => {
    const requestText = "What was Allan Dwan's blood type?";
    const dwan = promotedSpanWithSource("Allan Dwan", "Allan Dwan (born Joseph Aloysius Dwan; April 3, 1885 – December 28, 1981) was a pioneering Canadian and American motion picture director, producer, and screenwriter.");
    const unrelated = promotedSpanWithSource("Abraham Lincoln", "Abraham Lincoln discussed the blood of citizens during a political dispute.");
    primeCorpusIdentitySignals({ closedClass: new Set(["was"]), identities: new Set(["allan", "blood"]), spread: new Map([["allan", 1], ["blood", 1]]), concentration: 1 });
    const candidate: CandidateSurface = {
      ...sourceBoundProofAnswer(dwan.text, dwan),
      evidenceIds: [dwan.id, unrelated.id]
    };
    const spoken = await createDeterministicMouth({ hashText: text => hasher.digestHex(text) }).speak(speakInput(dwan.text, dwan.text, { requestText, evidence: [dwan, unrelated], candidate }));
    expect(answerCoversRequest([dwan.text], unrelated, ["allan", "dwan's", "blood", "type"], requestText, { relationRequired: true, languageClosedClassWords: new Set(["was"]) })).toBe(true);
    expect(spoken.text).not.toContain("pioneering Canadian and American motion picture director");
  });
});

async function speakDeterministic(answer: string, evidenceText: string) {
  return createDeterministicMouth({ hashText: text => hasher.digestHex(text) }).speak(speakInput(answer, evidenceText));
}

function speakInput(answer: string, evidenceText: string, options: { requestText?: string; evidence?: EvidenceSpan[]; candidate?: CandidateSurface } = {}): SpeakInput {
  const requestText = options.requestText ?? REQUEST;
  const evidence = options.evidence ?? [promotedSpan(evidenceText)];
  const field = emptyField(requestText);
  const entailment = createSemanticEntailmentEngine({ idFactory: ids, hasher }).check({
    text: requestText,
    evidence,
    nodes: [],
    field,
    createdAt: clock.now()
  });
  const construct: ConstructGraph = {
    id: ids.constructId({ fixture: "own-source-text" }),
    episodeId: ids.episodeId(),
    forceVector: {},
    nodes: [{ id: "family:answer", kind: "construct:answer", label: "fixture.answer", metadata: {} }],
    edges: [],
    artifacts: []
  };
  const profile: LanguageProfile = {
    id: "language.dialogue",
    sourceVersionId: ids.sourceVersionId(Buffer.from(DIALOGUE_POPULATION)),
    scripts: [{ script: "Latn", mass: 1 }],
    symbolShapes: [],
    charNgrams: [],
    direction: "ltr",
    entropy: 0.2,
    createdAt: clock.now()
  };
  return {
    requestText,
    construct,
    field,
    languageProfile: profile,
    evidence,
    entailment,
    languageMemory: languageRuntime.hydrateFromImportedBrain({
      importRunId: "own-source-text-dialogue",
      models: [dialogueModelRecord()],
      observations: [],
      units: [],
      patterns: [],
      semanticFrames: []
    }),
    conversationTurns: [],
    selectedCandidate: options.candidate ?? sourceBoundProofAnswer(answer, evidence[0]!),
    targetLanguage: "language.dialogue"
  };
}

function promotedSpanWithSource(title: string, text: string): EvidenceSpan {
  const span = promotedSpan(text);
  return { ...span, sourceIdentity: { title, identity: title, sourceKind: "wikipedia" }, provenance: { ...(span.provenance as Record<string, unknown>), title, identity: title, sourceKind: "wikipedia", forceClass: "direct_evidence" } } as unknown as EvidenceSpan;
}

function sourceBoundProofAnswer(answer: string, evidence: EvidenceSpan): CandidateSurface {
  return {
    id: "proof:own-source-text",
    kind: "proof-answer",
    answer,
    force: "inferred",
    evidenceIds: [evidence.id],
    scores: { support: 0.8, contradiction: 0, faithfulness: 1, alphaPressure: 0.5, actionability: 0.8, evidenceCoverage: 1, novelty: 0, realizability: 1 },
    boundaries: ["selected-evidence-bound"],
    audit: { schema: "scce.candidate.v1", source: "kernel.turn.source_exact" }
  };
}

function promotedSpan(text: string): EvidenceSpan {
  const bytes = Buffer.from(text);
  const contentHash = ids.contentHash(bytes);
  const sourceVersionId = ids.sourceVersionId(bytes);
  return {
    id: ids.evidenceId({ sourceVersionId, byteStart: 0, byteEnd: bytes.length, spanHash: contentHash }),
    sourceId: ids.sourceId("local-file", "docs/PRODUCTION_COMPLETION_PLAN_250.md"),
    sourceVersionId,
    chunkId: ids.chunkId({ sourceVersionId, byteStart: 0, byteEnd: bytes.length, chunkHash: contentHash }),
    contentHash,
    mediaType: "text/plain; charset=utf-8",
    byteStart: 0,
    byteEnd: bytes.length,
    charStart: 0,
    charEnd: text.length,
    text,
    textPreview: text,
    languageHints: {},
    scriptHints: {},
    trustVector: { forceClass: "direct_evidence" },
    provenance: { sourceSystem: "fixture", provenanceClass: "direct_evidence", sourceVersionId, byteRange: [0, bytes.length], charRange: [0, text.length] },
    features: featureSet(text, 128),
    status: "promoted",
    alpha: 0.9,
    observedAt: clock.now()
  } as unknown as EvidenceSpan;
}

function emptyField(requestText: string): FieldState {
  const matrix = { nodes: [], values: [] };
  return {
    requestFeatures: featureSet(requestText, 64),
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

function dialogueModelRecord(): NgramModelRecord {
  return {
    id: "model:dialogue",
    streamId: "stream:dialogue",
    languageHint: "language.dialogue",
    maxOrder: TRAINED.order,
    discount: TRAINED.discount,
    modelJson: { sourceSystem: "scce2", model: TRAINED as unknown as Record<string, unknown> } as unknown as NgramModelRecord["modelJson"],
    updatedAt: clock.now()
  };
}
