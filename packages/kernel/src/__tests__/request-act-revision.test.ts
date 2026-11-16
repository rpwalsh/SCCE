// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { createClock, createHasher, createIdFactory, createInMemoryDialogueMemoryStore, createScceKernel,
  type BuildTestResult, type LanguagePatternRecord, type ScceStorage } from "../index.js";
import { DIALOGUE_ACT_IDS } from "../dialogue-pragmatics.js";
import { REQUEST_COMMUNICATIVE_ACT_SOURCE_SYSTEM, compileRequestCommunicativeActModel, requestCommunicativeActPatterns, requestCommunicativeActModelFromPatterns, classifyRequestCommunicativeAct } from "../request-communicative-act.js";
import { storageFixtureForEvaluation } from "./evidence-promotion-evaluation-fixture.js";

it("invalidates an active request-act model on current-source replacement or revocation without restarting the runtime", async () => {
  const hasher = createHasher(), clock = createClock({ fixedTime: 5_000, stepMs: 1 });
  const rows = (id: string, requestText: string, factual: boolean, returned = false) => requestCommunicativeActPatterns(
    compileRequestCommunicativeActModel([{ requestText, accepted: true, responseEvidenceCount: 0, responseExternallyFactual: factual,
      continuation: { floorReturned: returned, replyDrawsOnTurn: true } }]), { profileId: `profile.${id}`, updatedAt: 1,
      sourceOwner: { sourceId: `source.${id}`, sourceVersionId: `version.${id}`, sourceSystem: REQUEST_COMMUNICATIVE_ACT_SOURCE_SYSTEM, evidenceIds: [`evidence.${id}`] },
      makeId: value => hasher.digestHex(JSON.stringify(value)) });
  const neutral = rows("neutral", "kapa dun", true), conversation = rows("conversation", "vel oru", false);
  let current: LanguagePatternRecord[] = [...neutral, ...conversation], revision = "1", reads = 0;
  let releaseInitial!: () => void;const initialRead = new Promise<void>(resolve => { releaseInitial = resolve; });
  const base = storageFixtureForEvaluation({ evidence: [], clockNow: () => 0 }).storage;
  const storage = { ...base, dialogueMemory: createInMemoryDialogueMemoryStore(),
    userModelClaims: { putClaim: async () => undefined, listClaims: async () => [] },
    taskResumption: { putSnapshot: async () => undefined, getLatestSnapshot: async () => null },
    documentGeneration: { putSession: async () => undefined, getSession: async () => null, compareAndPutSession: async () => ({ stored: true, currentUpdatedAt: null }) },
    languageMemory: { ...base.languageMemory, readRevision: async () => revision,
      listLanguagePatterns: async (query: Parameters<typeof base.languageMemory.listLanguagePatterns>[0]) => {
        if (query?.sourceSystem === REQUEST_COMMUNICATIVE_ACT_SOURCE_SYSTEM) { reads++; if (reads === 1) await initialRead; return current; }
        return base.languageMemory.listLanguagePatterns(query);
      } }
  } as ScceStorage;
  const runtime = createScceKernel({ storage, files: { streamPath: async function* () {} },
    buildTest: { executeProgram: async (): Promise<BuildTestResult> => ({ build: { code: 0, stdout: "", stderr: "", durationMs: 0 },
      test: { code: 0, stdout: "", stderr: "", durationMs: 0 }, repairAttempted: false, repairApplied: false, passed: true, artifacts: [] }) },
    idFactory: createIdFactory({ clock, hasher, deterministicReplay: true }), clock, deterministicReplay: true });
  const root = mkdtempSync(join(tmpdir(), "scce-act-revision-")), globals = globalThis as { __sccTrace?: unknown }, prior = globals.__sccTrace;
  const trace = async (id: string) => {
    const file = join(root, `${id}.jsonl`); globals.__sccTrace = { traceId: id, file };
    await runtime.turn({ text: "vel oru", metadata: { dialogue: { conversationId: id } } });
    return readFileSync(file, "utf8").split("\n").filter(Boolean).map(line => JSON.parse(line))
      .find(row => row.stage === "runtime.dialogue_act.classify").support;
  };
  try {
    const warmupInput={ language: false, requestLanguage: true, graph: false, brain: false, profile: false, corrections: false };
    const coldPreparation=runtime.warmup(warmupInput), concurrentPreparation=runtime.warmup(warmupInput);
    await new Promise(resolve=>setImmediate(resolve));expect(reads).toBe(1);releaseInitial();
    const [preparation, concurrent]=await Promise.all([coldPreparation,concurrentPreparation]);
    expect(preparation.failures).toEqual([]);expect(concurrent.failures).toEqual([]);expect(preparation.requestClassifier).toMatchObject({loaded:true,disabled:false});expect(reads).toBe(1);
    await runtime.warmup(warmupInput);expect(reads).toBe(1);
    const first = await trace("first"); expect(first.status).toBe("active"); expect(first.actId).not.toBe(DIALOGUE_ACT_IDS.neutral);
    expect((await trace("unchanged")).actId).toBe(first.actId); expect(reads).toBe(1);
    current = neutral; revision = "2";
    const revoked=await trace("revoked"), canonical=classifyRequestCommunicativeAct("vel oru",requestCommunicativeActModelFromPatterns(neutral));
    expect(revoked.status).toBe(canonical.status);expect(revoked.actId).toBe(DIALOGUE_ACT_IDS.neutral);expect(reads).toBe(2);
    current = [...neutral, ...rows("updated", "vel oru", false, true)]; revision = "3";
    const updated = await trace("updated"); expect(updated.status).toBe("active"); expect(updated.actId).not.toBe(first.actId); expect(reads).toBe(3);
  } finally { globals.__sccTrace = prior; rmSync(root, { recursive: true, force: true }); }
}, 60_000);

it("keeps the language-memory ablation explicit during classifier preparation",async()=>{
  const base=storageFixtureForEvaluation({evidence:[],clockNow:()=>0}).storage;let reads=0;
  const storage={...base,languageMemory:{...base.languageMemory,listLanguagePatterns:async(query:Parameters<typeof base.languageMemory.listLanguagePatterns>[0])=>{
    if(query?.sourceSystem===REQUEST_COMMUNICATIVE_ACT_SOURCE_SYSTEM){reads++;throw Error("disabled classifier cannot read");}return base.languageMemory.listLanguagePatterns(query);
  }}}as ScceStorage;
  const {createEvaluationCondition}=await import("../evaluation-flags.js");
  const kernel=createScceKernel({storage,evaluationCondition:createEvaluationCondition({conditionId:"no_language_memory",seed:"prep",clockIso:"2026-11-16T00:00:00Z"}),
    files:{streamPath:async function*(){}},buildTest:{executeProgram:async()=>{throw Error("preparation cannot execute programs");}}});
  const result=await kernel.warmup({language:false,requestLanguage:true,graph:false,brain:false,profile:false,corrections:false});
  expect(result.requestClassifier).toMatchObject({loaded:false,features:0,disabled:true});expect(result.failures).toEqual([]);expect(reads).toBe(0);
});
