// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
import { describe, expect, it } from "vitest";
import {
  createClock,
  createCorrectionMemory,
  createHasher,
  createIdFactory,
  createLanguageMemoryRuntime,
  createDeterministicMouth,
  createMouth,
  createSemanticEntailmentEngine,
  featureSet
} from "../index.js";
import { jsonRecord } from "../kernel-answer-primitives.js";
import { SURFACE_CONTRACT_STAGE_IDS, SURFACE_REALIZATION_STRATEGY_IDS } from "../surface-contract.js";
import { trainKneserNey } from "../kneser-ney.js";
import type { ConstructGraph, FieldState, JsonValue, LanguageProfile, SemanticEntailmentResult } from "../types.js";
import type { CandidateSurface } from "../candidate-contract.js";
import type { SpeakInput, SpokenOutput } from "../mouth.js";
import type { NgramModelRecord } from "../storage.js";
import { DIALOGUE_POPULATION } from "./conversational-session-fixture.js";

const clock = createClock({ fixedTime: 7000, stepMs: 1 });
const hasher = createHasher();
const ids = createIdFactory({ clock, hasher, deterministicReplay: true });
const languageRuntime = createLanguageMemoryRuntime({ idFactory: ids, hasher });
const TRAINED = trainKneserNey(DIALOGUE_POPULATION, { order: 3 });

// Verbatim from .scce/traces/2026-09-13T11-19-57-208Z-trace_mtzq2fbs_bnnwxb.jsonl turn 0004: admitted=0,
// evRefs=0, 61 characters spoken by the terminal runtime-motion lane.
const TUNGSTEN_LEAK = "No grounded source in the ingested corpus for: boiling point.";
const TUNGSTEN_REQUEST = "What is the boiling point of tungsten?";

function contractAudit(spoken: SpokenOutput): Record<string, JsonValue> {
  return jsonRecord(spoken.realizationTrace.surfaceContract);
}

describe("one contract, one exit: every strategy that reaches a user carries the same stages", () => {
  it("withholds the recorded tungsten leak at the learned entry instead of handing the turn to a second terminal", async () => {
    const spoken = await speak({ requestText: TUNGSTEN_REQUEST, selectedCandidate: terminalRuntimeMotionCandidate(TUNGSTEN_LEAK) });
    expect(spoken.text).toBe("");
    expect(spoken.evidenceRefs).toEqual([]);
    const audit = contractAudit(spoken);
    const commitments = jsonRecord(audit.commitments);
    expect(commitments.decides).toBe(true);
    expect(commitments.licensed).toBe(false);
    const refused = (commitments.unlicensedUnits as string[]).map(unit => unit.toLocaleLowerCase());
    for (const unlicensed of ["grounded", "ingested", "corpus"]) expect(refused).toContain(unlicensed);
    expect(jsonRecord(audit.surface).withheld).toBe(true);
  });

  it("withholds the same surface on the deterministic strategy called directly, as the deadline path calls it", async () => {
    const spoken = await speakDeterministic({ requestText: TUNGSTEN_REQUEST, selectedCandidate: terminalRuntimeMotionCandidate(TUNGSTEN_LEAK) });
    expect(spoken.text).toBe("");
    const audit = contractAudit(spoken);
    expect(audit.strategyId).toBe(SURFACE_REALIZATION_STRATEGY_IDS.deterministic);
    expect(jsonRecord(audit.commitments).licensed).toBe(false);
  });

  it("carries the contract's stage list on both strategies, whether or not a surface was emitted", async () => {
    const learned = await speak({ requestText: TUNGSTEN_REQUEST });
    const deterministic = await speakDeterministic({ requestText: TUNGSTEN_REQUEST });
    const stages = Object.values(SURFACE_CONTRACT_STAGE_IDS);
    for (const spoken of [learned, deterministic]) {
      const audit = contractAudit(spoken);
      expect(audit.schema).toBe("scce.mouth.surface_contract.v1");
      expect(audit.stages).toEqual(stages);
      expect(jsonRecord(audit.authority).classId).toBeTruthy();
    }
    expect(contractAudit(learned).strategyId).toBe(SURFACE_REALIZATION_STRATEGY_IDS.learned);
  });

  it("says plainly that the deterministic strategy ran no round trip, rather than reporting a pass it never earned", async () => {
    const deterministic = await speakDeterministic({ requestText: TUNGSTEN_REQUEST, selectedCandidate: terminalRuntimeMotionCandidate(TUNGSTEN_LEAK) });
    const roundTrip = jsonRecord(contractAudit(deterministic).roundTrip);
    expect(roundTrip.applied).toBe(false);
    expect(roundTrip.reason).toBe("no-intended-semantics-for-this-strategy");
  });

  it("still speaks a motion surface every unit of which the turn itself holds", async () => {
    const requestText = "What controls Pump Alpha?";
    const spoken = await speakDeterministic({ requestText, selectedCandidate: terminalRuntimeMotionCandidate("Pump Alpha") });
    expect(spoken.text.toLocaleLowerCase()).toContain("pump alpha");
    const audit = contractAudit(spoken);
    expect(jsonRecord(audit.commitments).licensed).toBe(true);
    expect(jsonRecord(audit.surface).withheld).toBe(false);
  });
});

function speakInput(input: { requestText: string; selectedCandidate?: CandidateSurface }): SpeakInput {
  const field: FieldState = emptyField(input.requestText);
  const entailment: SemanticEntailmentResult = createSemanticEntailmentEngine({ idFactory: ids, hasher }).check({
    text: input.requestText,
    evidence: [],
    nodes: [],
    field,
    createdAt: clock.now()
  });
  const languageMemory = languageRuntime.hydrateFromImportedBrain({
    importRunId: "surface-contract-dialogue",
    models: [dialogueModelRecord()],
    observations: [],
    units: [],
    patterns: [],
    semanticFrames: []
  });
  const construct: ConstructGraph = {
    id: ids.constructId({ fixture: "surface-contract" }),
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
    requestText: input.requestText,
    construct,
    field,
    languageProfile: profile,
    evidence: [],
    entailment,
    languageMemory,
    conversationTurns: [],
    ...(input.selectedCandidate ? { selectedCandidate: input.selectedCandidate } : {}),
    targetLanguage: "language.dialogue"
  };
}

async function speak(input: { requestText: string; selectedCandidate?: CandidateSurface }): Promise<SpokenOutput> {
  return createMouth({
    languageMemory: languageRuntime,
    correctionMemory: createCorrectionMemory({ idFactory: ids, hasher }),
    hashText: text => hasher.digestHex(text)
  }).speak(speakInput(input));
}

async function speakDeterministic(input: { requestText: string; selectedCandidate?: CandidateSurface }): Promise<SpokenOutput> {
  return createDeterministicMouth({ hashText: text => hasher.digestHex(text) }).speak(speakInput(input));
}

/** The exact shape isTerminalNonAssertiveRuntimeMotionCandidate accepts, so the real shortcut is the path taken. */
function terminalRuntimeMotionCandidate(answer: string): CandidateSurface {
  return {
    id: "runtime-motion:runtime-motion:58166c0d169",
    kind: "dialogue-continuation",
    answer,
    force: "unknown",
    evidenceIds: [],
    scores: { support: 0, contradiction: 0, faithfulness: 1, alphaPressure: 0, actionability: 0.48, evidenceCoverage: 0, novelty: 0, realizability: 1 },
    boundaries: ["runtime-motion-non-assertive", "runtime-motion-acquisition-exhausted", "runtime-motion-no-fabricated-evidence"],
    audit: {
      schema: "scce.runtime_motion_candidate.v1",
      source: "kernel.runtime_decision_boundary",
      externalFactCertification: false,
      fakeEvidenceForbidden: true,
      semanticFrame: { frameId: "semantic.runtime.motion.clarification.v1" }
    }
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
