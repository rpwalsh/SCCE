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
  featureSet
} from "../index.js";
import {
  COMMITMENT_AUTHORITY_IDS,
  candidateCommitmentInventory,
  candidateCommitmentsLicensed,
  candidateMayAssertAsKnown
} from "../candidate-commitment-inventory.js";
import { SURFACE_AUTHORITY_CLASS_IDS } from "../conversational-act-binding.js";
import { trainKneserNey } from "../kneser-ney.js";
import type { ConstructGraph, FieldState, LanguageProfile, SemanticEntailmentResult } from "../types.js";
import type { NgramModelRecord } from "../storage.js";
import { DIALOGUE_POPULATION } from "./conversational-session-fixture.js";

const clock = createClock({ fixedTime: 7000, stepMs: 1 });
const hasher = createHasher();
const ids = createIdFactory({ clock, hasher, deterministicReplay: true });
const languageRuntime = createLanguageMemoryRuntime({ idFactory: ids, hasher });
const TRAINED = trainKneserNey(DIALOGUE_POPULATION, { order: 3 });

// What the user actually supplied. The only external content any conversation-bound surface may carry.
const USER_TURN = "the pump feed reads high";
const CONVERSATION_TURNS = [{ turnId: "turn.user.1", turnIndex: 0, surface: USER_TURN }];

describe("a candidate is admitted by its own commitments, not by which producer made it", () => {
  it("licenses the user's own content by conversation span and refuses an unsupported world fact in the same surface", () => {
    const mixed = inventory("the pump feed reads high in Denmark");
    const byWord = new Map(mixed.units.map(unit => [unit.surface.toLocaleLowerCase(), unit]));
    expect(byWord.get("pump")?.authorityId).toBe(COMMITMENT_AUTHORITY_IDS.conversationSpan);
    expect(byWord.get("pump")?.licenceIds).toEqual(["turn.user.1"]);
    expect(byWord.get("feed")?.authorityId).toBe(COMMITMENT_AUTHORITY_IDS.conversationSpan);
    // The mixed candidate is judged unit by unit: holding a licence for "pump" blesses nothing else.
    expect(byWord.get("denmark")?.authorityId).toBe(COMMITMENT_AUTHORITY_IDS.none);
    expect(byWord.get("denmark")?.licenceIds).toEqual([]);
    expect(candidateCommitmentsLicensed(mixed)).toBe(false);
    expect(mixed.authorityClassId).toBe(SURFACE_AUTHORITY_CLASS_IDS.unsupportedFactual);
    expect(candidateMayAssertAsKnown(mixed)).toBe(false);
  });

  it("admits a wholly conversation-bound surface with zero documentary evidence, and never calls it known", () => {
    const bound = inventory("so the pump feed reads high");
    expect(candidateCommitmentsLicensed(bound)).toBe(true);
    expect(bound.authorityClassId).toBe(SURFACE_AUTHORITY_CLASS_IDS.conversationBound);
    // Conversation-bound speech is admissible; it is still never assertable as known.
    expect(candidateMayAssertAsKnown(bound)).toBe(false);
    // No evidence id was manufactured for a conversation span: the namespaces stay apart.
    for (const unit of bound.units) expect(unit.licenceIds.every(id => !id.startsWith("evidence"))).toBe(true);
    expect(bound.authorityIds).not.toContain(COMMITMENT_AUTHORITY_IDS.documentary);
  });

  it("refuses a value nobody supplied without any rule about numbers, tungsten, or question shape", () => {
    const fabricated = inventory("the boiling point of tungsten is 3422 degrees Celsius");
    const unlicensed = fabricated.unlicensedUnits.map(unit => unit.surface.toLocaleLowerCase());
    expect(unlicensed).toContain("tungsten");
    expect(unlicensed).toContain("3422");
    expect(candidateCommitmentsLicensed(fabricated)).toBe(false);
  });

  it("licenses a documentary unit as documentary even when the conversation also used the word", () => {
    const documented = candidateCommitmentInventory({
      text: "the pump feed reads high",
      evidenceTexts: [{ id: "evidence.manual.1", text: "the pump feed reads high during startup" }],
      conversationTurns: CONVERSATION_TURNS,
      claimBases: [],
      models: [TRAINED]
    });
    const pump = documented.units.find(unit => unit.surface.toLocaleLowerCase() === "pump");
    expect(pump?.authorityId).toBe(COMMITMENT_AUTHORITY_IDS.documentary);
    expect(pump?.licenceIds).toEqual(["evidence.manual.1"]);
    expect(documented.authorityClassId).toBe(SURFACE_AUTHORITY_CLASS_IDS.groundedFactual);
    expect(candidateMayAssertAsKnown(documented)).toBe(true);
  });
});

describe("adversarial leakage: probable dialogue continuations never acquire factual authority", () => {
  it("refuses every Denmark continuation the dialogue population makes probable, in a conversation about a pump", () => {
    // Every one of these is a high-probability continuation of this trained population. None is licensed.
    const leaks = [
      "the capital of Denmark is Copenhagen",
      "the currency of Denmark is the krone",
      "so the pump feed reads high and Copenhagen is the largest city"
    ];
    for (const leak of leaks) {
      const probed = inventory(leak);
      expect(candidateCommitmentsLicensed(probed)).toBe(false);
      expect(probed.authorityClassId).toBe(SURFACE_AUTHORITY_CLASS_IDS.unsupportedFactual);
    }
    // And the last one proves the point precisely: the licensed half did not license the unlicensed half.
    const mixed = inventory("so the pump feed reads high and Copenhagen is the largest city");
    const authorities = new Map(mixed.units.map(unit => [unit.surface.toLocaleLowerCase(), unit.authorityId]));
    expect(authorities.get("pump")).toBe(COMMITMENT_AUTHORITY_IDS.conversationSpan);
    expect(authorities.get("copenhagen")).toBe(COMMITMENT_AUTHORITY_IDS.none);
  });

  it("refuses the continuations this population really produced when the Mouth ran it", () => {
    // Measured, not invented: these are the surfaces conversationMemoryCandidate's own generate() call emitted
    // under this fixture -- "The whole idea was rather strange." answering a tungsten question. Fluent, probable,
    // and about nothing anyone supplied.
    const observedGenerations = [
      { requestText: "What is the boiling point of tungsten?", surface: "The whole idea was rather strange." }
    ];
    for (const observed of observedGenerations) {
      const probed = candidateCommitmentInventory({
        text: observed.surface,
        evidenceTexts: [],
        conversationTurns: [{ turnId: "turn.request", turnIndex: 0, surface: observed.requestText }],
        claimBases: [],
        models: [TRAINED]
      });
      expect(probed.unlicensedUnits.length).toBeGreaterThan(0);
      expect(candidateCommitmentsLicensed(probed)).toBe(false);
      expect(probed.authorityClassId).toBe(SURFACE_AUTHORITY_CLASS_IDS.unsupportedFactual);
    }
  });

  it("through the real Mouth: the conversation lane speaks nothing the conversation did not supply", async () => {
    const spoken = await speakWithoutEvidence({ requestText: USER_TURN, conversationTurns: CONVERSATION_TURNS });
    expect(spoken.evidenceRefs).toEqual([]);
    const emitted = spoken.text.toLocaleLowerCase();
    for (const leaked of ["denmark", "copenhagen", "krone"]) {
      expect(emitted).not.toContain(leaked);
    }
    // Whatever it said, every externally meaningful unit of it is licensed.
    expect(candidateCommitmentsLicensed(inventory(spoken.text))).toBe(true);
  });

  it("through the real Mouth: a request with no admitted knowledge emits no unsupported value", async () => {
    const spoken = await speakWithoutEvidence({
      requestText: "What is the boiling point of tungsten?",
      conversationTurns: []
    });
    expect(spoken.evidenceRefs).toEqual([]);
    // The safety floor: no value, and nothing the dialogue population merely made probable.
    expect(/\d/u.test(spoken.text)).toBe(false);
    const emitted = spoken.text.toLocaleLowerCase();
    for (const leaked of ["denmark", "copenhagen", "krone"]) expect(emitted).not.toContain(leaked);
    expect(candidateCommitmentsLicensed(inventory(spoken.text, { requestText: "What is the boiling point of tungsten?" }))).toBe(true);
  });
});

function inventory(text: string, options?: { requestText?: string }) {
  const turns = options?.requestText
    ? [{ turnId: "turn.request", turnIndex: 0, surface: options.requestText }]
    : CONVERSATION_TURNS;
  return candidateCommitmentInventory({
    text,
    evidenceTexts: [],
    conversationTurns: turns,
    claimBases: [],
    models: [TRAINED]
  });
}

async function speakWithoutEvidence(input: { requestText: string; conversationTurns: readonly { turnId: string; turnIndex: number; surface: string }[] }) {
  const field: FieldState = emptyField(input.requestText);
  const entailment: SemanticEntailmentResult = createSemanticEntailmentEngine({ idFactory: ids, hasher }).check({
    text: input.requestText,
    evidence: [],
    nodes: [],
    field,
    createdAt: clock.now()
  });
  const languageMemory = languageRuntime.hydrateFromImportedBrain({
    importRunId: "commitment-dialogue",
    models: [dialogueModelRecord()],
    observations: [],
    units: [],
    patterns: [],
    semanticFrames: []
  });
  const construct: ConstructGraph = {
    id: ids.constructId({ fixture: "commitment" }),
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
  const mouth = createMouth({
    languageMemory: languageRuntime,
    correctionMemory: createCorrectionMemory({ idFactory: ids, hasher }),
    hashText: text => hasher.digestHex(text)
  });
  return mouth.speak({
    requestText: input.requestText,
    construct,
    field,
    languageProfile: profile,
    evidence: [],
    entailment,
    languageMemory,
    conversationTurns: input.conversationTurns,
    targetLanguage: "language.dialogue"
  });
}


function dialogueProfile(): LanguageProfile {
  return {
    id: "language.dialogue",
    sourceVersionId: ids.sourceVersionId(Buffer.from(DIALOGUE_POPULATION)),
    scripts: [{ script: "Latn", mass: 1 }],
    symbolShapes: [],
    charNgrams: [],
    direction: "ltr",
    entropy: 0.2,
    createdAt: clock.now()
  };
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
