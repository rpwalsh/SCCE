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
import { TRANSCRIPT_CORPUS, bracketBoilerplateTrainingSet, transcriptEvidence } from "./dialogue-transcript-corpus-fixture.js";
import type { ConstructGraph, EvidenceSpan, FieldState, LanguageProfile } from "../types.js";

const clock = createClock({ fixedTime: 5000, stepMs: 1 });
const hasher = createHasher();
const ids = createIdFactory({ clock, hasher, deterministicReplay: true });
const languageRuntime = createLanguageMemoryRuntime({ idFactory: ids, hasher });
const TRAINED = trainKneserNey(DIALOGUE_POPULATION, { order: 3 });

type TraceRow = { stage: string; counts?: Record<string, number>; support?: Record<string, unknown> };

/**
 * The population the live turn actually saw: the lane's own act-keyed bundles, and alongside them a
 * relation-keyed bundle from the same profile whose frame is bracket punctuation with three one-unit fields.
 */
function population(include: { act: boolean }): { bundles: DurableLanguageConstructionBundle[]; actBundleIds: Set<string>; actId: string; profileId: string } {
  const { documents, evidence } = transcriptEvidence(TRANSCRIPT_CORPUS, hasher);
  const compiled = induceConversationalActConstructionTrainingSets({ documents, hasher }).sets.flatMap(set => {
    const result = compileLanguageConstructionPattern({
      bindingId: set.bindingId, profileId: set.profileId, observations: set.observations, evidence, hasher, updatedAt: 1
    });
    return result.status === "compiled" ? [{ bundle: result.bundle, actId: String(set.actId), profileId: set.profileId }] : [];
  });
  const first = compiled[0]!;
  const boilerplate = bracketBoilerplateTrainingSet(hasher);
  const relation = compileLanguageConstructionPattern({
    // A relation-keyed binding: the key the factual lane derives from a predicate, never from an act.
    bindingId: `language.source_relation.${hasher.digestHex("boilerplate").slice(0, 32)}`,
    profileId: first.profileId,
    observations: boilerplate.observations,
    evidence: [...evidence, ...boilerplate.evidence] as EvidenceSpan[],
    hasher,
    updatedAt: 1
  });
  if (relation.status !== "compiled") throw new Error(`boilerplate bundle did not compile: ${JSON.stringify(relation.issues)}`);
  // The live population: single-family bundles of the same key alongside, so the invariance Otsu has a split.
  const singles = [0, 1, 2, 3].map(index => ({
    ...(include.act ? first.bundle : relation.bundle),
    id: `bundle.single.${index}`,
    sourceVersionIds: [`source_version.single.${index}`],
    constructions: [],
    formClasses: []
  } as DurableLanguageConstructionBundle));
  return {
    bundles: [...(include.act ? compiled.map(row => row.bundle) : []), relation.bundle, ...singles],
    actBundleIds: new Set(compiled.map(row => row.bundle.id)),
    actId: first.actId,
    profileId: first.profileId
  };
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
    id: ids.constructId({ fixture: "conversational-frame-provenance" }),
    episodeId: ids.episodeId(),
    forceVector: { fixture: true },
    nodes: [{ id: "family:answer", kind: "construct:answer", label: "fixture.answer", metadata: {} }],
    edges: [],
    artifacts: []
  } as unknown as ConstructGraph;
}

/** The live shape: several earlier turns in the conversation, so a multi-slot frame has spans to draw on. */
async function speak(include: { act: boolean }, earlier: readonly string[], requestText: string): Promise<{ text: string; row: TraceRow | undefined }> {
  const loaded = population(include);
  const dir = mkdtempSync(join(tmpdir(), "scce-frame-provenance-"));
  const traceFile = join(dir, "trace.jsonl");
  const globals = globalThis as { __sccTrace?: unknown };
  const previous = globals.__sccTrace;
  globals.__sccTrace = { traceId: "conversational-frame-provenance", file: traceFile };
  try {
    const field = emptyField(requestText);
    const turns = [...earlier, requestText].map((surface, index) => ({ turnId: `turn.${index}`, turnIndex: index, surface }));
    const entailment = createSemanticEntailmentEngine({ idFactory: ids, hasher })
      .check({ text: requestText, evidence: [], nodes: [], field, createdAt: clock.now() });
    const classification: RequestCommunicativeActClassification = {
      schema: "scce.request_communicative_act_classification.v1",
      status: "active",
      actId: loaded.actId,
      matchedPatternIds: ["feature.01"],
      logOddsOverNeutral: 1.4,
      classIds: [loaded.actId, DIALOGUE_ACT_IDS.neutral]
    };
    const state = languageRuntime.hydrateFromImportedBrain({
      importRunId: "conversational-frame-provenance", models: [], observations: [], units: [], patterns: [], semanticFrames: []
    });
    const spoken = await createMouth({
      languageMemory: languageRuntime,
      correctionMemory: createCorrectionMemory({ idFactory: ids, hasher }),
      hashText: text => hasher.digestHex(text),
      hasher
    }).speak({
      construct: constructGraph(),
      field,
      languageProfile: languageProfile(loaded.profileId),
      evidence: [],
      entailment,
      requestText,
      conversationTurns: turns,
      requestCommunicativeAct: classification,
      languageMemory: { ...state, models: [TRAINED], importedConstructionBundles: loaded.bundles }
    });
    const trace = readFileSync(traceFile, "utf8").split("\n").filter(Boolean).map(line => JSON.parse(line) as TraceRow);
    return { text: spoken.text, row: [...trace].reverse().find(item => item.stage === "mouth.conversational_act_binding.candidate") };
  } finally {
    globals.__sccTrace = previous;
    rmSync(dir, { recursive: true, force: true });
  }
}

const EARLIER = ["the valve was replaced last week", "the log shows a spike", "nobody signed the report"];
const REQUEST = "the pump feed reads high";

describe("the conversation-bound lane speaks from a frame its own act induced", () => {
  it("says nothing when the only frames in scope are relation-keyed, rather than speaking their punctuation", async () => {
    const produced = await speak({ act: false }, EARLIER, REQUEST);
    // The live turn's shape: no act-keyed bundle hydrated, and a bracket boilerplate frame free for the taking.
    expect({ rows: produced.row?.counts?.rows, surface: produced.row?.support?.surface })
      .toEqual({ rows: 0, surface: null });
  }, 180_000);

  it("never borrows a relation-keyed frame when one of its own is in scope", async () => {
    const produced = await speak({ act: true }, EARLIER, REQUEST);
    const bundleId = produced.row?.support?.bundleId as string | null | undefined;
    const loaded = population({ act: true });
    expect(produced.row?.counts?.rows).toBeGreaterThan(0);
    // Every frame this lane may speak is one the act induced; a predicate-keyed bundle is the factual lane's.
    expect({ bundleId, spokeFromItsOwnAct: loaded.actBundleIds.has(String(bundleId)) })
      .toMatchObject({ spokeFromItsOwnAct: true });
  }, 180_000);

  it("fills its slots from what the request's own turn made meaningful, not from that turn's form", async () => {
    const produced = await speak({ act: true }, EARLIER, REQUEST);
    const surface = produced.row?.support?.surface as string | null | undefined;
    const requested = candidateCommitmentInventory({
      text: REQUEST,
      evidenceTexts: [],
      conversationTurns: [{ turnId: "turn.3", turnIndex: 3, surface: REQUEST }],
      claimBases: [],
      models: [TRAINED]
    });
    const meaningful = requested.units.filter(unit => unit.externallyMeaningful).map(unit => unit.surface);
    expect(meaningful.length).toBeGreaterThan(0);
    const spoken = new Set(surfaceWords(String(surface)).map(word => word.toLocaleLowerCase()));
    expect({ surface, meaningful, carried: meaningful.filter(word => spoken.has(word.toLocaleLowerCase())) })
      .toMatchObject({ carried: expect.arrayContaining([expect.any(String)]) });
  }, 180_000);
});
