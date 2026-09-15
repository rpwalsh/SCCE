// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  createClock,
  createDialogueCognitiveMemoryV2,
  createHasher,
  createIdFactory,
  createInMemoryDialogueMemoryStore,
  createScceKernel,
  featureSet,
  userCorrectionFromOutcome,
  type BuildTestResult,
  type ContentHash,
  type DialogueCognitiveStateV2,
  type DialogueMemoryStore,
  type DocumentGenerationSessionRecord,
  type EvidenceId,
  type EvidenceSpan,
  type InteractionStateRecord,
  type ScceKernel,
  type ScceStorage,
  type SourceId,
  type SourceVersionId,
  type TaskResumptionSnapshotRecord,
  type TurnResult,
  type UserCorrectionRecord,
  type UserModelClaimRecord
} from "../index.js";
import { storageFixtureForEvaluation } from "./evidence-promotion-evaluation-fixture.js";

const CONVERSATION_ID = "conversation.restart-correction";
const REQUEST = "What is Mercury?";
const REJECTED_REFERENT_ID = "node:evidence:mercury-element";
const PREFERRED_REFERENT_ID = "node:evidence:mercury-planet";

describe("dialogue correction across a process restart", () => {
  it("hydrates the owner's typed correction from persisted records after a restart and applies it with its adjustment id in the trace", async () => {
    const conversation = await correctedConversation(7_000);
    const { adjustmentId } = conversation;

    // Same process: the durable correction record reaches the turn and the resolver.
    const warm = await tracedTurn(conversation.kernel, REQUEST);
    expect(preselectionAdjustmentIds(warm.trace)).toEqual([adjustmentId]);
    const warmState = await latestState(conversation.dialogueMemory);
    expect(warmState?.turnIndex).toBe(2);
    expect(warmState?.bindings.map(binding => binding.interpretationAdjustmentIds)).toContainEqual([adjustmentId]);

    // Restart: a new kernel over a store rebuilt from the persisted records alone (JSON round trip, no live reference).
    const persisted = await persistedRecords(conversation.dialogueMemory);
    const restartedMemory = createInMemoryDialogueMemoryStore(persisted);
    const restarted = bootKernel(sharedStorage(ambiguousEvidence(), restartedMemory), 9_000);
    const cold = await tracedTurn(restarted, REQUEST);
    expect(preselectionAdjustmentIds(cold.trace)).toEqual([adjustmentId]);
    const coldState = await latestState(restartedMemory);
    expect(coldState?.turnIndex).toBe(3);
    expect(coldState?.bindings.map(binding => binding.interpretationAdjustmentIds)).toContainEqual([adjustmentId]);
    expect(coldState?.bindings.map(binding => [binding.referentId, binding.admitted, binding.confidence]))
      .toEqual(warmState?.bindings.map(binding => [binding.referentId, binding.admitted, binding.confidence]));

    // The correction record alone hydrates it: restart from the pre-correction head (whose state carries no
    // adjustment copy) plus the typed correction record.
    const preCorrectionHead = persisted.interactionStates.filter(record => (record.stateJson as { turnIndex?: number }).turnIndex === 1);
    expect(preCorrectionHead).toHaveLength(1);
    const recordOnlyMemory = createInMemoryDialogueMemoryStore({ interactionStates: preCorrectionHead, corrections: persisted.corrections });
    const recordOnly = bootKernel(sharedStorage(ambiguousEvidence(), recordOnlyMemory), 11_000);
    const fromRecord = await tracedTurn(recordOnly, REQUEST);
    expect(preselectionAdjustmentIds(fromRecord.trace)).toEqual([adjustmentId]);
    const recordOnlyState = await latestState(recordOnlyMemory);
    expect(recordOnlyState?.turnIndex).toBe(2);
    expect(recordOnlyState?.bindings.map(binding => binding.interpretationAdjustmentIds)).toContainEqual([adjustmentId]);

    // Control: the same restart without the correction record loads no adjustment.
    const controlMemory = createInMemoryDialogueMemoryStore({ interactionStates: preCorrectionHead });
    const control = bootKernel(sharedStorage(ambiguousEvidence(), controlMemory), 13_000);
    const uncorrected = await tracedTurn(control, REQUEST);
    expect(preselectionAdjustmentIds(uncorrected.trace)).toEqual([]);
    expect((await latestState(controlMemory))?.bindings.every(binding => !binding.interpretationAdjustmentIds?.length)).toBe(true);
  });

  // Known defect, pinned: every candidate in the field carries the union of both referents' proof evidence, so
  // applyDialogueInterpretationAdjustmentsV2 leaves each one neutral and the judge has no planet-only candidate.
  it.fails("selects the corrected referent for the same request form", async () => {
    const conversation = await correctedConversation(15_000);
    const corrected = await tracedTurn(conversation.kernel, REQUEST);
    const selected = corrected.result.selectedCandidate as { audit?: { typedDialogueSelection?: { adjustmentIds?: string[] } } };
    expect(selected.audit?.typedDialogueSelection?.adjustmentIds).toEqual([conversation.adjustmentId]);
    expect(corrected.result.answer).toContain("smallest planet");
  });
});

async function correctedConversation(fixedTime: number): Promise<{
  kernel: ScceKernel;
  dialogueMemory: DialogueMemoryStore;
  correction: UserCorrectionRecord;
  adjustmentId: string;
}> {
  const dialogueMemory = createInMemoryDialogueMemoryStore();
  const kernel = bootKernel(sharedStorage(ambiguousEvidence(), dialogueMemory), fixedTime);
  const first = await tracedTurn(kernel, REQUEST);
  // Both referents are admissible typed candidates for this request.
  expect(new Set(preselectionReferentIds(first.trace))).toEqual(new Set([REJECTED_REFERENT_ID, PREFERRED_REFERENT_ID]));
  expect(first.result.answer).toContain("chemical element");
  const state = await latestState(dialogueMemory);
  expect(state?.turnIndex).toBe(1);
  const rejected = state!.referents.find(referent => referent.id === REJECTED_REFERENT_ID);
  const binding = state!.bindings.find(row => row.referentId === REJECTED_REFERENT_ID && row.admitted);
  expect(rejected).toBeDefined();
  expect(binding).toBeDefined();
  // The typed correction the server derives from the persisted state for an owner "corrected" outcome.
  const correction = userCorrectionFromOutcome({
    outcome: {
      id: `conversation_outcome.${fixedTime}`,
      conversationId: CONVERSATION_ID,
      turnId: state!.turnId,
      promptHash: "prompt.restart",
      responseHash: "response.restart",
      corrected: true,
      requestedConstraintRefs: [],
      satisfiedConstraintRefs: [],
      failedConstraintRefs: [],
      scoreTraceRefs: [],
      createdAt: new Date(fixedTime + 100).toISOString()
    },
    correctionText: "I meant the planet.",
    interpretationCorrection: {
      semanticRoleIds: rejected!.semanticRoleIds,
      requestedSlotIds: binding!.inheritedSlotBindings.map(slot => slot.slotId),
      learnedFrameIds: rejected!.learnedFrameIds,
      scopeIds: rejected!.scopeIds,
      rejectedReferentIds: [rejected!.id],
      preferredReferentIds: [PREFERRED_REFERENT_ID],
      supportMass: 0.9,
      contradictionMass: binding!.confidence
    },
    now: fixedTime + 100
  });
  await dialogueMemory.putUserCorrection(correction);
  const adjustmentId = (correction.preferenceDeltaJson as { interpretationAdjustment: { id: string } }).interpretationAdjustment.id;
  return { kernel, dialogueMemory, correction, adjustmentId };
}

async function persistedRecords(store: DialogueMemoryStore): Promise<{ interactionStates: InteractionStateRecord[]; corrections: UserCorrectionRecord[] }> {
  return JSON.parse(JSON.stringify({
    interactionStates: await store.listInteractionStates({ conversationId: CONVERSATION_ID }),
    corrections: await store.listUserCorrections!({ conversationId: CONVERSATION_ID })
  }));
}

function latestState(store: DialogueMemoryStore): Promise<DialogueCognitiveStateV2 | undefined> {
  return createDialogueCognitiveMemoryV2({ store, hasher: createHasher() }).latest(CONVERSATION_ID);
}

function preselectionAdjustmentIds(trace: readonly TraceRow[]): string[] {
  return trace.filter(event => event.stage === "dialogue.preselection").flatMap(event => (event.support?.adjustmentIds as string[] | undefined) ?? []);
}

function preselectionReferentIds(trace: readonly TraceRow[]): string[] {
  return trace.filter(event => event.stage === "dialogue.preselection").flatMap(event => (event.support?.candidateReferentIds as string[] | undefined) ?? []);
}

function bootKernel(storage: ScceStorage, fixedTime: number): ScceKernel {
  const clock = createClock({ fixedTime, stepMs: 1 });
  const hasher = createHasher();
  return createScceKernel({
    storage,
    files: { streamPath: async function* () { /* unused */ } },
    buildTest: { executeProgram: async (): Promise<BuildTestResult> => ({ build: emptyCommandResult(), test: emptyCommandResult(), repairAttempted: false, repairApplied: false, passed: true, artifacts: [] }) },
    idFactory: createIdFactory({ clock, hasher, deterministicReplay: true }),
    clock,
    deterministicReplay: true
  });
}

function sharedStorage(evidence: EvidenceSpan[], dialogueMemory: DialogueMemoryStore): ScceStorage {
  const base = storageFixtureForEvaluation({ evidence, clockNow: () => 0 }).storage;
  const claims = new Map<string, UserModelClaimRecord>();
  const snapshots: TaskResumptionSnapshotRecord[] = [];
  const sessions = new Map<string, DocumentGenerationSessionRecord>();
  return {
    ...base,
    dialogueMemory,
    userModelClaims: {
      putClaim: async (claim: UserModelClaimRecord) => { claims.set(`${claim.conversationId} ${claim.id}`, claim); },
      listClaims: async (query: { conversationId: string; subject?: string; scope?: string; limit?: number }) => [...claims.values()]
        .filter(row => row.conversationId === query.conversationId && (!query.subject || row.subject === query.subject) && (!query.scope || row.scope === query.scope))
        .sort((left, right) => right.observedAt - left.observedAt)
        .slice(0, query.limit ?? 200)
    },
    taskResumption: {
      putSnapshot: async (record: TaskResumptionSnapshotRecord) => { snapshots.push(record); },
      getLatestSnapshot: async (goalId: string) => snapshots.filter(record => record.goalId === goalId).at(-1) ?? null
    },
    documentGeneration: {
      putSession: async (record: DocumentGenerationSessionRecord) => { sessions.set(`${record.conversationId} ${record.id}`, record); },
      getSession: async (id: string, conversationId: string) => sessions.get(`${conversationId} ${id}`) ?? null,
      compareAndPutSession: async (record: DocumentGenerationSessionRecord, expectedUpdatedAt: number | null) => {
        const current = sessions.get(`${record.conversationId} ${record.id}`) ?? null;
        if ((current?.updatedAt ?? null) !== expectedUpdatedAt) return { stored: false, currentUpdatedAt: current?.updatedAt ?? null };
        sessions.set(`${record.conversationId} ${record.id}`, record);
        return { stored: true, currentUpdatedAt: record.updatedAt };
      }
    }
  } as unknown as ScceStorage;
}

type TraceRow = { stage: string; counts?: Record<string, number>; support?: Record<string, unknown> };

async function tracedTurn(kernel: ScceKernel, text: string): Promise<{ result: TurnResult; trace: TraceRow[] }> {
  const traceFile = join(mkdtempSync(join(tmpdir(), "scce-restart-correction-")), "trace.jsonl");
  const globals = globalThis as { __sccTrace?: unknown };
  const previousTrace = globals.__sccTrace;
  globals.__sccTrace = { traceId: "dialogue-correction-restart-test", file: traceFile };
  let result: TurnResult;
  try {
    result = await kernel.turn({ text, metadata: { dialogue: { conversationId: CONVERSATION_ID } } });
  } finally {
    globals.__sccTrace = previousTrace;
  }
  const trace = readFileSync(traceFile, "utf8").split("\n").filter(Boolean).map(line => JSON.parse(line) as TraceRow);
  return { result, trace };
}

function ambiguousEvidence(): EvidenceSpan[] {
  return [
    evidenceSpan({
      id: "evidence:mercury-planet",
      sourceVersionId: "source:mercury-planet:v1" as SourceVersionId,
      title: "Mercury (planet)",
      uri: "fixture://wiki/Mercury_(planet)",
      text: "Mercury is the smallest planet in the Solar System and the closest to the Sun.",
      alpha: 0.9
    }),
    evidenceSpan({
      id: "evidence:mercury-element",
      sourceVersionId: "source:mercury-element:v1" as SourceVersionId,
      title: "Mercury (element)",
      uri: "fixture://wiki/Mercury_(element)",
      text: "Mercury is a chemical element with the symbol Hg and is liquid at room temperature.",
      alpha: 0.9
    })
  ];
}

function evidenceSpan(input: { id: string; sourceVersionId: SourceVersionId; title: string; uri: string; text: string; alpha: number }): EvidenceSpan {
  return {
    id: input.id as EvidenceId,
    sourceId: `source:${input.id}` as SourceId,
    sourceVersionId: input.sourceVersionId,
    chunkId: `chunk:${input.id}` as EvidenceSpan["chunkId"],
    contentHash: `hash:${input.id}` as ContentHash,
    mediaType: "text/plain",
    byteStart: 0,
    byteEnd: input.text.length,
    charStart: 0,
    charEnd: input.text.length,
    text: input.text,
    textPreview: input.text,
    languageHints: { language: "fixture" },
    scriptHints: { script: "Latn" },
    trustVector: { trust: 0.94, sourceTrust: 0.94, structuralConfidence: 0.94, forceClass: "direct_evidence" },
    provenance: { namespace: "local", source: "dialogue-correction-restart-test", title: input.title, uri: input.uri, canonicalUri: input.uri, sourceVersionId: input.sourceVersionId, byteRange: [0, input.text.length], charRange: [0, input.text.length] },
    features: featureSet(input.text, 256),
    status: "promoted",
    alpha: input.alpha,
    observedAt: 1000
  };
}

function emptyCommandResult() {
  return { code: 0, stdout: "", stderr: "", durationMs: 0 };
}
