// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
import { readFileSync } from "node:fs";
import { expect, it } from "vitest";
import { createClock, createHasher, createIdFactory, createLanguageAcquisitionEngine, createLanguageMemoryRuntime,
  compileLanguageTrainingBatch, createScceKernel, createInMemoryDialogueMemoryStore, createConversationPlanMemory,
  CORPUS_SOURCE_SYSTEM_IDS, CORPUS_ROLE_IDS, toJsonValue,
  type EvidenceSpan, type ScceStorage, type TranscriptTurn } from "../index.js";
import { storageFixtureForEvaluation } from "./evidence-promotion-evaluation-fixture.js";

it("persists a genuine human source-owned nonassertive plan on an ordinary turn without documentary proof", async () => {
  const human = JSON.parse(readFileSync(new URL("./fixtures/oasst-human-russian-creative-pair.json", import.meta.url), "utf8")) as { text: string; turns: TranscriptTurn[] };
  const hasher = createHasher(), clock = createClock({ fixedTime: 1000, stepMs: 1 }), ids = createIdFactory({ clock, hasher, deterministicReplay: true });
  const sourceVersionId = ids.sourceVersionId(human.text), contentHash = ids.contentHash(human.text), sourceId = ids.sourceId("dialogue", "fixture://human-russian");
  const evidence = { id: ids.evidenceId({ sourceVersionId, byteStart: 0, byteEnd: Buffer.byteLength(human.text), spanHash: contentHash }), sourceId, sourceVersionId, contentHash, charStart: 0, charEnd: [...human.text].length,
    text: human.text, status: "promoted", features: [], alpha: 1, observedAt: 1 } as unknown as EvidenceSpan;
  const profile = createLanguageAcquisitionEngine({ idFactory: ids }).acquire({ sourceVersionId, text: human.text, createdAt: 1 });
  const compiled = compileLanguageTrainingBatch({ runtime: createLanguageMemoryRuntime({ hasher, idFactory: ids }), hasher,
    batch: { streamId: "fixture://human-russian", sourceSystem: "dialogue", canonicalSource: { sourceId, contentHash }, profile,
      sourceVersionId, text: human.text, evidence: [evidence], transcriptTurns: human.turns, createdAt: 1, retainNgramObservations: false } });
  const dialogueMemory = createInMemoryDialogueMemoryStore();
  const patterns = compiled.patterns.map(pattern => ({ ...pattern, patternJson: toJsonValue({ ...(pattern.patternJson as object), sourceSystem: "dialogue",
    sourceSystemId: CORPUS_SOURCE_SYSTEM_IDS.dialogue, corpusRole: CORPUS_ROLE_IDS.dialogue, provenanceClass: "learned_language_prior", forceClass: "learned_language_prior" }) }));
  const base = storageFixtureForEvaluation({ evidence: [evidence], clockNow: () => 1 }).storage;
  const storage = { ...base, dialogueMemory,
    userModelClaims: { putClaim: async () => undefined, listClaims: async () => [] },
    taskResumption: { putSnapshot: async () => undefined, getLatestSnapshot: async () => null },
    documentGeneration: { putSession: async () => undefined, getSession: async () => null, compareAndPutSession: async () => ({ stored: true, currentUpdatedAt: null }) },
    model: { ...base.model, listLanguageProfiles: async () => [profile],
      readModel: async () => ({ languageProfiles: [profile], latentConcepts: [], learnedProgramPatterns: [], learningGoals: [], trainingSteps: 0 }) },
    evidence: { ...base.evidence, getEvidence: async (id: string) => String(evidence.id) === id ? evidence : null,
      getEvidenceBatch: async (keys: readonly string[]) => keys.includes(String(evidence.id)) ? [evidence] : [], searchEvidence: async () => [] },
    languageMemory: { ...base.languageMemory,
      listNgramModels: async () => compiled.models, listLanguageUnits: async () => compiled.units, listSemanticFrames: async () => compiled.semanticFrames,
      listLanguagePatterns: async (query?: { patternIds?: readonly string[]; patternSchemas?: readonly string[]; sourceSystem?: string }) => patterns.filter(pattern => {
        const metadata = pattern.patternJson as Record<string, unknown>;
        return (!query?.patternIds || query.patternIds.includes(pattern.id)) && (!query?.patternSchemas || query.patternSchemas.includes(String(metadata.schema)))
          && (!query?.sourceSystem || metadata.sourceSystem === query.sourceSystem);
      }) }
  } as unknown as ScceStorage;
  let kernelIndex = 0;
  const coldKernel = () => createScceKernel({ storage, files: { streamPath: async function* () {} },
    buildTest: { executeProgram: async () => { throw new Error("a conversation plan cannot execute code"); } }, clock, deterministicReplay: true,
    idFactory: createIdFactory({ clock, hasher, deterministicReplay: true, namespace: `conversation.plan.${++kernelIndex}` }) });
  const conversationId = "conversation.human-source-plan";
  const metadata = (conversationId: string) => ({ dialogue: { conversationId }, session: { sessionId: conversationId, recentTurns: [] } });
  const out = await coldKernel().turn({ text: human.turns[0]!.surface, requestedAuthority: "creative", metadata: metadata(conversationId) });
  expect(out.answer.replace(/\s+/gu, " ")).toBe(human.turns[1]!.surface.replace(/\s+/gu, " "));
  expect(out.evidence.every(span => span.trustVector.forceClass === "session_owner_turn_evidence")).toBe(true);
  const memory = () => createConversationPlanMemory({ store: dialogueMemory, hasher });
  const saved = await memory().latest(conversationId);
  expect(saved).toBeDefined();
  expect(saved!.receipt.externallyFactual).toBe(false); expect(saved!.receipt.evidenceIds).toEqual([]);
  expect(saved!.receipt.realizationSteps.length).toBeGreaterThan(1);
  expect(saved!.receipt.roles.every(role => role.sourceTurnId === saved!.turnId)).toBe(true);
  expect(saved!.receipt.surfaceHash).toBe(hasher.digestHex(out.answer));
  expect(JSON.stringify(saved)).not.toContain(human.turns[1]!.surface);
  expect(JSON.stringify(saved)).not.toContain("Спанч");
  const freshRequest = human.turns[0]!.surface.replace("Спанч", "Квартун");
  const fresh = await coldKernel().turn({ text: freshRequest, requestedAuthority: "creative", metadata: metadata(conversationId) });
  expect(fresh.answer.replace(/\s+/gu, " ")).toBe(human.turns[1]!.surface.replaceAll("Спанч", "Квартун").replace(/\s+/gu, " "));
  expect(fresh.answer.split("Квартун")).toHaveLength(7);
  expect(fresh.answer).not.toContain("Спанч");
  const continued = await memory().latest(conversationId);
  expect(continued).toMatchObject({ turnIndex: 2, previousStateId: saved!.id,
    receipt: { continuationKey: saved!.receipt.continuationKey, constructionId: saved!.receipt.constructionId } });
  expect(continued!.receipt.roles.every(role => role.sourceTurnId === continued!.turnId)).toBe(true);
  expect(continued!.turnId).not.toBe(saved!.turnId);
  for (const role of continued!.receipt.roles) {
    const previous = saved!.receipt.roles.find(old => old.occurrenceId === role.occurrenceId)!;
    if ([...human.turns[0]!.surface].slice(previous.startCodePoint, previous.endCodePoint).join("") === "Спанч") {
      expect([...freshRequest].slice(role.startCodePoint, role.endCodePoint).join("")).toBe("Квартун");
    }
  }
  const priorTurns = [{ id: saved!.turnId, turnIndex: 0, roleId: "session.role.owner", text: human.turns[0]!.surface, evidenceIds: [], sourceVersionIds: [] },
    { id: continued!.turnId, turnIndex: 1, roleId: "session.role.owner", text: freshRequest, evidenceIds: [], sourceVersionIds: [] }];
  const constrained = await coldKernel().turn({ text: freshRequest + "\nΩ≤7", requestedAuthority: "creative",
    metadata: { dialogue: { conversationId }, session: { sessionId: conversationId, recentTurns: priorTurns } } });
  expect(constrained.answer).toBe("");
  expect((await memory().latest(conversationId))!.id).toBe(continued!.id);
  const factual = await coldKernel().turn({ text: "Who directs Квартун?", requestedAuthority: "factual", metadata: metadata(conversationId) });
  expect(factual.answer).toBe("");
  expect((await memory().latest(conversationId))!.id).toBe(continued!.id);
  const otherConversationId = "conversation.other-owner";
  const other = await coldKernel().turn({ text: human.turns[0]!.surface.replace("Спанч", "κάλυ月"), requestedAuthority: "creative", metadata: metadata(otherConversationId) });
  expect(other.answer.split("κάλυ月")).toHaveLength(7);
  expect(other.answer).not.toContain("Квартун");
  expect(await memory().latest(otherConversationId)).toMatchObject({ turnIndex: 1, previousStateId: null });
  expect((await memory().latest(conversationId))!.id).toBe(continued!.id);
  evidence.status = "quarantined";
  const revoked = await coldKernel().turn({ text: freshRequest, requestedAuthority: "creative", metadata: metadata(conversationId) });
  expect(revoked.answer).toBe("");
  expect((await memory().latest(conversationId))!.id).toBe(continued!.id);
}, 120_000);
