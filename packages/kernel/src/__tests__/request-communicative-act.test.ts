// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  createClock,
  createHasher,
  createIdFactory,
  createInMemoryDialogueMemoryStore,
  createScceKernel,
  type BuildTestResult,
  type LanguagePatternRecord,
  type ScceKernel,
  type ScceStorage
} from "../index.js";
import { DIALOGUE_ACT_IDS } from "../dialogue-pragmatics.js";
import {
  REQUEST_COMMUNICATIVE_ACT_SOURCE_SYSTEM,
  classifyRequestCommunicativeAct,
  compileRequestCommunicativeActModel,
  requestCommunicativeActIdForSignature,
  requestCommunicativeActModelFromPatterns,
  requestCommunicativeActPatterns,
  type RequestCommunicativeActModel,
  type RequestCommunicativeActObservation
} from "../request-communicative-act.js";
import { requestFeatures } from "../request-requirement-learning.js";
import { storageFixtureForEvaluation } from "./evidence-promotion-evaluation-fixture.js";

// Invented tokens: the classifier must learn from outcomes, not from any language it already knows.
const OBSERVATIONS: RequestCommunicativeActObservation[] = [
  ...["vel oru nami", "vel oru tasko", "vel oru", "vel oru bren"].map(requestText => ({ requestText, responseEvidenceCount: 0, accepted: true })),
  ...["kapa dun serik", "kapa dun lomar", "kapa dun ivet", "pola dun serik"].map(requestText => ({ requestText, responseEvidenceCount: 2, accepted: true })),
  { requestText: "vel oru kapa", responseEvidenceCount: 3, rejected: true }
];
const EVIDENCE_FREE_ACT = requestCommunicativeActIdForSignature({ accepted: true, evidenceBearing: false });

describe("request-level communicative act", () => {
  it.each(["velora", "한국어", "مرحبا", "𐐀𐐁"])("does not promote an unobserved act from pseudocounts alone: %s", surface => {
    const unsupported = "actshape.a20db32b";
    // Exact measured r004 class/feature counts, with the public surface replaced by opaque/multilingual units.
    const counts = {
      start: { "actshape.cb0810e5": 19, "actshape.3d30dbe2": 1, "actshape.b651af12": 1 },
      end: { "actshape.3d30dbe2": 1, "actshape.cb0810e5": 1 },
      any: { "actshape.cb0810e5": 28, [DIALOGUE_ACT_IDS.neutral]: 2, "actshape.3d30dbe2": 1, "actshape.b651af12": 2 }
    };
    const model: RequestCommunicativeActModel = { schema: "scce.request_communicative_act_model.v1",
      classCounts: { [DIALOGUE_ACT_IDS.neutral]: 11788, "actshape.3d30dbe2": 567, "actshape.cb0810e5": 4992,
        "actshape.b651af12": 68, [unsupported]: 6 },
      features: new Map(requestFeatures(surface).map(feature => [feature.key, { surface: feature.surface, anchor: feature.anchor,
        counts: counts[feature.anchor as keyof typeof counts] }])) };
    const result = classifyRequestCommunicativeAct(surface, model);
    expect(result.status).toBe("active");
    expect(result.actId).not.toBe(unsupported);
    expect(result.matchedPatternIds.some(key => (model.features.get(key)?.counts[result.actId] ?? 0) > 0)).toBe(true);
    expect(result.logOddsOverNeutral).toBeGreaterThanOrEqual(0);
  });

  it("keeps a single positive matched witness sufficient and leaves an exact tie at the neutral baseline", () => {
    const supported = "actshape.single_witness", surface = "zulora";
    const features = requestFeatures(surface);
    const model: RequestCommunicativeActModel = { schema: "scce.request_communicative_act_model.v1",
      classCounts: { [DIALOGUE_ACT_IDS.neutral]: 1000, [supported]: 1 },
      features: new Map(features.map(feature => [feature.key, { surface: feature.surface, anchor: feature.anchor,
        counts: { [supported]: feature.key === features[0]!.key ? 1 : 0,
          [DIALOGUE_ACT_IDS.neutral]: feature.key === features[0]!.key ? 0 : 1 } }])) };
    expect(classifyRequestCommunicativeAct(surface, model).actId).toBe(supported);
    const tied: RequestCommunicativeActModel = { schema: model.schema,
      classCounts: { [DIALOGUE_ACT_IDS.neutral]: 1, [supported]: 1 },
      features: new Map(features.map(feature => [feature.key, { surface: feature.surface, anchor: feature.anchor,
        counts: { [DIALOGUE_ACT_IDS.neutral]: 1, [supported]: 1 } }])) };
    expect(classifyRequestCommunicativeAct(surface, tied)).toMatchObject({ status: "active", actId: DIALOGUE_ACT_IDS.neutral, logOddsOverNeutral: 0 });
    expect(classifyRequestCommunicativeAct("unobserved", tied)).toMatchObject({ status: "bypassed_not_applicable", actId: DIALOGUE_ACT_IDS.neutral });
  });

  it("induces act classes from accepted-outcome signatures and round-trips through persisted patterns", () => {
    const model = compileRequestCommunicativeActModel(OBSERVATIONS);
    expect(model.classCounts).toEqual({ [EVIDENCE_FREE_ACT]: 4, [DIALOGUE_ACT_IDS.neutral]: 4 });
    const patterns = requestCommunicativeActPatterns(model, { profileId: "profile.act", updatedAt: 5, makeId: value => `pattern.${JSON.stringify(value).length}.${String((value as { key: string }).key)}` });
    const hydrated = requestCommunicativeActModelFromPatterns(patterns);
    expect(hydrated?.classCounts).toEqual(model.classCounts);
    const direct = classifyRequestCommunicativeAct("vel oru frim", model);
    const persisted = classifyRequestCommunicativeAct("vel oru frim", hydrated);
    expect(persisted).toEqual(direct);
    expect(direct.status).toBe("active");
    expect(direct.actId).toBe(EVIDENCE_FREE_ACT);
    expect(direct.matchedPatternIds).toContain("start:vel oru");
    expect(classifyRequestCommunicativeAct("kapa dun frim", model).actId).toBe(DIALOGUE_ACT_IDS.neutral);
    expect(classifyRequestCommunicativeAct("zzz", model).status).toBe("bypassed_not_applicable");
    expect(classifyRequestCommunicativeAct("vel oru frim", undefined).status).toBe("inert_unconfigured");
    // One class is not a contrast; the artifact is not promoted.
    expect(requestCommunicativeActModelFromPatterns(requestCommunicativeActPatterns(
      compileRequestCommunicativeActModel(OBSERVATIONS.filter(row => row.responseEvidenceCount === 0)),
      { profileId: "profile.act", updatedAt: 5, makeId: value => JSON.stringify(value) }
    ))).toBeUndefined();
  });

  it("gives a new session's first turn the learned act and raises dialogue dependence only for a matching request", async () => {
    const patterns = requestCommunicativeActPatterns(compileRequestCommunicativeActModel(OBSERVATIONS), {
      profileId: "profile.act",
      updatedAt: 5,
      makeId: value => `pattern.${String((value as { key: string }).key)}`
    });
    const learned = bootKernel(patterns, 20_000);
    const unlearned = bootKernel([], 30_000);

    const dialogic = await actTrace(learned, "vel oru frim", "conversation.act.a");
    const dialogicBaseline = await actTrace(unlearned, "vel oru frim", "conversation.act.a0");
    expect(dialogic.status).toBe("active");
    expect(dialogic.actId).toBe(EVIDENCE_FREE_ACT);
    expect(dialogic.matchedPatternIds).toContain("start:vel oru");
    expect(dialogic.dialogueDependence).toBeGreaterThan(dialogicBaseline.dialogueDependence);

    const factual = await actTrace(learned, "kapa dun frim", "conversation.act.b");
    const factualBaseline = await actTrace(unlearned, "kapa dun frim", "conversation.act.b0");
    expect(factual.status).toBe("active");
    expect(factual.actId).toBe(DIALOGUE_ACT_IDS.neutral);
    expect(factual.requirementValues).toEqual(factualBaseline.requirementValues);

    expect(dialogicBaseline.status).toBe("inert_unconfigured");
    expect(dialogicBaseline.actId).toBe(DIALOGUE_ACT_IDS.neutral);
    expect(dialogicBaseline.matchedPatternIds).toEqual([]);
  }, 60_000);
});

type TraceRow = { stage: string; counts?: Record<string, number>; support?: Record<string, unknown> };

async function actTrace(kernel: ScceKernel, text: string, conversationId: string): Promise<{
  status: string;
  actId: string;
  matchedPatternIds: string[];
  dialogueDependence: number;
  requirementValues: unknown;
}> {
  const traceFile = join(mkdtempSync(join(tmpdir(), "scce-request-act-")), "trace.jsonl");
  const globals = globalThis as { __sccTrace?: unknown };
  const previousTrace = globals.__sccTrace;
  globals.__sccTrace = { traceId: "request-communicative-act-test", file: traceFile };
  try {
    await kernel.turn({ text, metadata: { dialogue: { conversationId } } });
  } finally {
    globals.__sccTrace = previousTrace;
  }
  const rows = readFileSync(traceFile, "utf8").split("\n").filter(Boolean).map(line => JSON.parse(line) as TraceRow);
  const event = rows.find(row => row.stage === "runtime.dialogue_act.classify");
  expect(event).toBeDefined();
  const support = event!.support!;
  return {
    status: support.status as string,
    actId: support.actId as string,
    matchedPatternIds: support.matchedPatternIds as string[],
    dialogueDependence: support.dialogueDependence as number,
    requirementValues: support.requirementValues
  };
}

function bootKernel(actPatterns: LanguagePatternRecord[], fixedTime: number): ScceKernel {
  const clock = createClock({ fixedTime, stepMs: 1 });
  const hasher = createHasher();
  const base = storageFixtureForEvaluation({ evidence: [], clockNow: () => 0 }).storage;
  const listLanguagePatterns = base.languageMemory.listLanguagePatterns.bind(base.languageMemory);
  const storage = {
    ...base,
    dialogueMemory: createInMemoryDialogueMemoryStore(),
    userModelClaims: { putClaim: async () => undefined, listClaims: async () => [] },
    taskResumption: { putSnapshot: async () => undefined, getLatestSnapshot: async () => null },
    documentGeneration: {
      putSession: async () => undefined,
      getSession: async () => null,
      compareAndPutSession: async () => ({ stored: true, currentUpdatedAt: null })
    },
    languageMemory: {
      ...base.languageMemory,
      listLanguagePatterns: async (query?: Parameters<typeof listLanguagePatterns>[0]) =>
        query?.sourceSystem === REQUEST_COMMUNICATIVE_ACT_SOURCE_SYSTEM ? actPatterns : listLanguagePatterns(query)
    }
  } as unknown as ScceStorage;
  return createScceKernel({
    storage,
    files: { streamPath: async function* () { /* unused */ } },
    buildTest: { executeProgram: async (): Promise<BuildTestResult> => ({ build: emptyCommandResult(), test: emptyCommandResult(), repairAttempted: false, repairApplied: false, passed: true, artifacts: [] }) },
    idFactory: createIdFactory({ clock, hasher, deterministicReplay: true }),
    clock,
    deterministicReplay: true
  });
}

function emptyCommandResult() {
  return { code: 0, stdout: "", stderr: "", durationMs: 0 };
}
