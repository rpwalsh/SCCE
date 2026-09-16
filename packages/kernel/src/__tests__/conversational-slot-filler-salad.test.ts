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
import { induceConversationalActConstructionTrainingSets } from "../conversational-construction-induction.js";
import { compileLanguageConstructionPattern, type DurableLanguageConstructionBundle } from "../language-construction-memory.js";
import type { RequestCommunicativeActClassification } from "../request-communicative-act.js";
import { DIALOGUE_ACT_IDS } from "../dialogue-pragmatics.js";
import { trainKneserNey } from "../kneser-ney.js";
import { candidateCommitmentInventory } from "../candidate-commitment-inventory.js";
import { surfaceWords } from "../surface-linguistics.js";
import { DIALOGUE_POPULATION } from "./conversational-session-fixture.js";
import { TRANSCRIPT_CORPUS, transcriptEvidence } from "./dialogue-transcript-corpus-fixture.js";
import type { ConstructGraph, FieldState, LanguageProfile } from "../types.js";

const clock = createClock({ fixedTime: 5000, stepMs: 1 });
const hasher = createHasher();
const ids = createIdFactory({ clock, hasher, deterministicReplay: true });
const languageRuntime = createLanguageMemoryRuntime({ idFactory: ids, hasher });
const TRAINED = trainKneserNey(DIALOGUE_POPULATION, { order: 3 });

type TraceRow = { stage: string; counts?: Record<string, number>; support?: Record<string, unknown> };

/** The lane's own induction over its own dialogue corpus: one-slot frames whose slot holds a single unit. */
function inducedBundles(): { bundles: DurableLanguageConstructionBundle[]; actId: string; profileId: string } {
  const { documents, evidence } = transcriptEvidence(TRANSCRIPT_CORPUS, hasher);
  const compiled = induceConversationalActConstructionTrainingSets({ documents, hasher }).sets.flatMap(set => {
    const result = compileLanguageConstructionPattern({
      bindingId: set.bindingId, profileId: set.profileId, observations: set.observations, evidence, hasher, updatedAt: 1
    });
    return result.status === "compiled" ? [{ bundle: result.bundle, actId: String(set.actId), profileId: set.profileId }] : [];
  });
  const first = compiled[0]!;
  // The live population: every other scoped bundle is single-family, so the induced one is the Otsu upper class.
  const singles = [0, 1, 2, 3].map(index => ({
    ...first.bundle,
    id: `bundle.single.${index}`,
    sourceVersionIds: [`source_version.single.${index}`],
    constructions: [],
    formClasses: []
  } as DurableLanguageConstructionBundle));
  return { bundles: [...compiled.map(row => row.bundle), ...singles], actId: first.actId, profileId: first.profileId };
}

function languageProfile(profileId: string): LanguageProfile {
  return {
    id: profileId,
    sourceVersionId: "source_version.dialogue.transcript",
    scripts: [{ script: "fixture-script", mass: 1 }],
    symbolShapes: [],
    charNgrams: [],
    direction: "unknown",
    entropy: 0.2,
    createdAt: clock.now()
  } as unknown as LanguageProfile;
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

function constructGraph(): ConstructGraph {
  return {
    id: ids.constructId({ fixture: "conversational-slot-filler" }),
    episodeId: ids.episodeId(),
    forceVector: { fixture: true },
    nodes: [{ id: "family:answer", kind: "construct:answer", label: "fixture.answer", metadata: {} }],
    edges: [],
    artifacts: []
  } as unknown as ConstructGraph;
}

async function speak(requestText: string): Promise<{ text: string; row: TraceRow | undefined }> {
  const induced = inducedBundles();
  const dir = mkdtempSync(join(tmpdir(), "scce-slot-filler-"));
  const traceFile = join(dir, "trace.jsonl");
  const globals = globalThis as { __sccTrace?: unknown };
  const previous = globals.__sccTrace;
  globals.__sccTrace = { traceId: "conversational-slot-filler", file: traceFile };
  try {
    const field = emptyField(requestText);
    const turns = [{ turnId: "turn.01", turnIndex: 0, surface: requestText }];
    const entailment = createSemanticEntailmentEngine({ idFactory: ids, hasher })
      .check({ text: requestText, evidence: [], nodes: [], field, createdAt: clock.now() });
    const classification: RequestCommunicativeActClassification = {
      schema: "scce.request_communicative_act_classification.v1",
      status: "active",
      actId: induced.actId,
      matchedPatternIds: ["feature.01"],
      logOddsOverNeutral: 1.4,
      classIds: [induced.actId, DIALOGUE_ACT_IDS.neutral]
    };
    const state = languageRuntime.hydrateFromImportedBrain({
      importRunId: "conversational-slot-filler", models: [], observations: [], units: [], patterns: [], semanticFrames: []
    });
    const spoken = await createMouth({
      languageMemory: languageRuntime,
      correctionMemory: createCorrectionMemory({ idFactory: ids, hasher }),
      hashText: text => hasher.digestHex(text),
      hasher
    }).speak({
      construct: constructGraph(),
      field,
      languageProfile: languageProfile(induced.profileId),
      evidence: [],
      entailment,
      requestText,
      conversationTurns: turns,
      requestCommunicativeAct: classification,
      languageMemory: { ...state, models: [TRAINED], importedConstructionBundles: induced.bundles }
    });
    const trace = readFileSync(traceFile, "utf8").split("\n").filter(Boolean).map(line => JSON.parse(line) as TraceRow);
    return { text: spoken.text, row: [...trace].reverse().find(item => item.stage === "mouth.conversational_act_binding.candidate") };
  } finally {
    globals.__sccTrace = previous;
    rmSync(dir, { recursive: true, force: true });
  }
}

describe("a one-slot conversational frame fills its slot with something its own turn made meaningful", () => {
  for (const requestText of ["the pump feed reads high", "what is the melting point of tungsten carbide alloy 7?"]) {
    it(`fills the slot from a unit the resident closed class does not call form: ${requestText}`, async () => {
      const produced = await speak(requestText);
      const surface = produced.row?.support?.surface as string | null | undefined;
      expect(produced.row?.counts?.rows).toBeGreaterThan(0);
      expect(typeof surface).toBe("string");
      // The turn's own measured inventory decides which of its units can name anything at all.
      const requested = candidateCommitmentInventory({
        text: requestText,
        evidenceTexts: [],
        conversationTurns: [{ turnId: "turn.01", turnIndex: 0, surface: requestText }],
        claimBases: [],
        models: [TRAINED]
      });
      const meaningful = requested.units.filter(unit => unit.externallyMeaningful).map(unit => unit.surface);
      const form = requested.units.filter(unit => !unit.externallyMeaningful).map(unit => unit.surface);
      expect(meaningful.length).toBeGreaterThan(0);
      // The filler the frame took must be one of them; a frame whose only borrowed unit is form says nothing.
      const spoken = new Set(surfaceWords(surface as string).map(word => word.toLocaleLowerCase()));
      expect(meaningful.filter(word => spoken.has(word.toLocaleLowerCase()))).not.toEqual([]);
      expect({ requestText, surface, form }).toBeTruthy();
    }, 180_000);
  }
});
