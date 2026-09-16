// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
import { induceLearnedConstructions, type AlignedSurfaceExample } from "../language-construction.js";
import { candidateCommitmentInventory, candidateCommitmentsLicensed } from "../candidate-commitment-inventory.js";
import type { DurableLanguageConstructionBundle } from "../language-construction-memory.js";
import type { RequestCommunicativeActClassification } from "../request-communicative-act.js";
import { DIALOGUE_ACT_IDS } from "../dialogue-pragmatics.js";
import { trainKneserNey } from "../kneser-ney.js";
import { DIALOGUE_POPULATION } from "./conversational-session-fixture.js";
import type { ConstructGraph, EvidenceSpan, FieldState, LanguageProfile } from "../types.js";

const clock = createClock({ fixedTime: 5000, stepMs: 1 });
const hasher = createHasher();
const ids = createIdFactory({ clock, hasher, deterministicReplay: true });
const languageRuntime = createLanguageMemoryRuntime({ idFactory: ids, hasher });

const TRAINED = trainKneserNey(DIALOGUE_POPULATION, { order: 3 });

const PROFILE_ID = "language_profile.conversational.turn.fixture";
const ROLE = "role.conversational.frame";
const OCCURRENCE = "occurrence.conversational.frame";
// One real line of the trained dialogue population, aligned on a span of it. The frame is corpus form.
const DIALOGUE_LINE = "there was something else you wanted to ask";
const REQUEST = "the pump feed reads high";
const TURNS = [{ turnId: "turn.01", turnIndex: 0, surface: REQUEST }];

type TraceRow = { stage: string; counts?: Record<string, number>; support?: Record<string, unknown> };

function frameBundle(): DurableLanguageConstructionBundle {
  const start = DIALOGUE_LINE.indexOf("something else");
  const example: AlignedSurfaceExample = {
    id: "example.dialogue.frame.01",
    profileKey: PROFILE_ID,
    surface: DIALOGUE_LINE,
    evidenceIds: ["evidence.corpus.dialogue.pg844"],
    roleSpans: [{
      roleId: ROLE,
      occurrenceId: OCCURRENCE,
      start,
      end: start + "something else".length,
      surface: "something else",
      evidenceIds: ["evidence.corpus.dialogue.pg844.role"]
    }]
  };
  const learned = induceLearnedConstructions({ hasher, examples: [example] });
  return {
    id: "bundle.conversational.frame.01",
    contentDigest: hasher.digestHex("bundle.conversational.frame.01"),
    schema: "scce.language_construction_pattern.v1",
    bindingId: "language.source_relation.fixture",
    sourceProfileId: PROFILE_ID,
    targetProfileId: PROFILE_ID,
    sourceVersionIds: ["source_version.dialogue.pg844", "source_version.dialogue.pg1750", "source_version.dialogue.pg1008"],
    evidenceIds: ["evidence.corpus.dialogue.pg844"],
    evidenceContentHashes: [hasher.digestHex(DIALOGUE_LINE)],
    sourceExamples: [],
    constructions: [...learned.constructions],
    formClasses: [...learned.formClasses]
  } as DurableLanguageConstructionBundle;
}

/** The literal-invariance floor is an Otsu split of the observed source-family distribution, so it needs a population. */
function scopedBundles(): DurableLanguageConstructionBundle[] {
  const singleFamily = [0, 1, 2].map(index => ({
    ...frameBundle(),
    id: `bundle.conversational.single.${index}`,
    sourceVersionIds: [`source_version.dialogue.single.${index}`],
    constructions: [],
    formClasses: []
  } as DurableLanguageConstructionBundle));
  return [frameBundle(), ...singleFamily];
}

function classification(overrides: Partial<RequestCommunicativeActClassification> = {}): RequestCommunicativeActClassification {
  return {
    schema: "scce.request_communicative_act_classification.v1",
    status: "active",
    actId: "actshape.fixture.conversational",
    matchedPatternIds: ["feature.01"],
    logOddsOverNeutral: 1.4,
    classIds: ["actshape.fixture.conversational", DIALOGUE_ACT_IDS.neutral],
    ...overrides
  };
}

function languageProfile(): LanguageProfile {
  return {
    id: PROFILE_ID,
    sourceVersionId: "source_version.dialogue.pg844",
    scripts: [{ script: "fixture-script", mass: 1 }],
    symbolShapes: [],
    charNgrams: [],
    direction: "unknown",
    entropy: 0.2,
    createdAt: clock.now()
  } as unknown as LanguageProfile;
}

function emptyField(): FieldState {
  const matrix = { nodes: [], values: [] };
  return {
    requestFeatures: featureSet(REQUEST, 64),
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

function constructGraph(): ConstructGraph {
  return {
    id: ids.constructId({ fixture: "conversational-act-binding" }),
    episodeId: ids.episodeId(),
    forceVector: { fixture: true },
    nodes: [{ id: "family:answer", kind: "construct:answer", label: "fixture.answer", metadata: {} }],
    edges: [],
    artifacts: []
  } as unknown as ConstructGraph;
}

async function speakWith(act: RequestCommunicativeActClassification | undefined): Promise<{ text: string; trace: TraceRow[] }> {
  const dir = mkdtempSync(join(tmpdir(), "scce-act-binding-"));
  const traceFile = join(dir, "trace.jsonl");
  const globals = globalThis as { __sccTrace?: unknown };
  const previous = globals.__sccTrace;
  globals.__sccTrace = { traceId: "conversational-act-binding-turn", file: traceFile };
  try {
    const evidence: EvidenceSpan[] = [];
    const field = emptyField();
    const entailment = createSemanticEntailmentEngine({ idFactory: ids, hasher }).check({
      text: REQUEST,
      evidence,
      nodes: [],
      field,
      createdAt: clock.now()
    });
    const state = languageRuntime.hydrateFromImportedBrain({
      importRunId: "conversational-act-binding-turn",
      models: [],
      observations: [],
      units: [],
      patterns: [],
      semanticFrames: []
    });
    const spoken = await createMouth({
      languageMemory: languageRuntime,
      correctionMemory: createCorrectionMemory({ idFactory: ids, hasher }),
      hashText: text => hasher.digestHex(text),
      hasher
    }).speak({
      construct: constructGraph(),
      field,
      languageProfile: languageProfile(),
      evidence,
      entailment,
      requestText: REQUEST,
      conversationTurns: TURNS,
      ...(act ? { requestCommunicativeAct: act } : {}),
      languageMemory: { ...state, models: [TRAINED], importedConstructionBundles: scopedBundles() }
    });
    const trace = readFileSync(traceFile, "utf8").split("\n").filter(Boolean).map(line => JSON.parse(line) as TraceRow);
    return { text: spoken.text, trace };
  } finally {
    globals.__sccTrace = previous;
    rmSync(dir, { recursive: true, force: true });
  }
}

const bindingRow = (trace: readonly TraceRow[]): TraceRow | undefined =>
  [...trace].reverse().find(row => row.stage === "mouth.conversational_act_binding.candidate");

describe("the conversation-bound lane is reachable from a production speak", () => {
  it("produces a candidate whose form is corpus and whose every filler is a span of this conversation", async () => {
    const produced = await speakWith(classification());
    const row = bindingRow(produced.trace);
    expect(row).toBeDefined();
    const surface = row?.support?.surface as string | null | undefined;
    expect(typeof surface).toBe("string");
    expect(surface).toBeTruthy();
    // The slot takes a filler the size its own corpus occurrences hold -- two units here, not the whole turn.
    const slotSize = "something else".split(" ").length;
    const spanUnits = "pump feed reads high".split(" ");
    const windows = spanUnits.flatMap((_, start) => (start + slotSize <= spanUnits.length
      ? [spanUnits.slice(start, start + slotSize).join(" ")]
      : []));
    expect(windows.filter(window => (surface as string).includes(window))).toHaveLength(1);
    expect(surface).not.toContain(spanUnits.join(" "));
    // And the candidate wins the field it competes in: a lane that realizes but never speaks answers nobody.
    expect(produced.text).toBe(surface);
    // And nothing it says commits the system to a world fact it cannot license from this conversation.
    const inventory = candidateCommitmentInventory({
      text: surface as string,
      evidenceTexts: [],
      conversationTurns: TURNS,
      claimBases: [],
      models: [TRAINED]
    });
    expect(inventory.unlicensedUnits.map(unit => unit.surface)).toEqual([]);
    expect(candidateCommitmentsLicensed(inventory)).toBe(true);
    expect(inventory.authorityClassId).not.toBe("authority.grounded_factual");
  }, 120_000);

  it("produces nothing when the request's act was never classified, and nothing when it is the neutral lookup act", async () => {
    expect(bindingRow((await speakWith(undefined)).trace)).toBeUndefined();
    const neutral = await speakWith(classification({ actId: DIALOGUE_ACT_IDS.neutral }));
    expect(bindingRow(neutral.trace)).toBeUndefined();
  }, 120_000);
});
