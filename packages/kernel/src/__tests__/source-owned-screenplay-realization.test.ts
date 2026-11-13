// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
import { readFileSync } from "node:fs";
import { beforeAll, expect, it } from "vitest";
import { createClock, createHasher } from "../primitives.js";
import { createIdFactory } from "../ids.js";
import { createLanguageAcquisitionEngine } from "../language.js";
import { createLanguageMemoryRuntime, scopeLanguageMemoryStateToLanguage } from "../language-memory-runtime.js";
import { compileLanguageTrainingBatch } from "../language-training-batch.js";
import { compileCreativeRequestFrameFromCompatibilityModels } from "../creative-event-compatibility.js";
import { creativeSourceUtterances, realizeCreativeSourceUtterance } from "../creative-source-utterance.js";
import { createAlphaFieldEngine } from "../field.js";
import { planInventions } from "../invention-planner.js";
import { updateDialogueState } from "../dialogue-pragmatics.js";
import { createSemanticEntailmentEngine } from "../entailment.js";
import { createCandidateEngine } from "../candidate.js";
import { createCcrEngine } from "../ccr.js";
import { createMouth } from "../mouth.js";
import { createCorrectionMemory } from "../correction-memory.js";
import { inventionConstructNode } from "../prediction.js";
import { jsonRecord } from "../kernel-answer-primitives.js";
import type { ConstructGraph, EvidenceSpan } from "../types.js";
import type { TranscriptTurn } from "../dialogue-communicative-act-learning.js";
import type { LanguagePatternRecord } from "../storage.js";

const human = JSON.parse(readFileSync(new URL("./fixtures/dolly-human-scene-pair.json", import.meta.url), "utf8")) as { text: string; turns: TranscriptTurn[] };
const hasher = createHasher(), clock = createClock({ fixedTime: 1, stepMs: 1 });
const ids = createIdFactory({ hasher, clock, deterministicReplay: true, namespace: "source-screenplay" });
const sourceVersionId = ids.sourceVersionId(human.text), contentHash = ids.contentHash(human.text);
const source = { id: ids.evidenceId({ sourceVersionId, byteStart: 0, byteEnd: Buffer.byteLength(human.text), spanHash: contentHash }),
  sourceId: ids.sourceId("dialogue", "fixture://pinned-dolly/84"), sourceVersionId,
  chunkId: ids.chunkId({ sourceVersionId, byteStart: 0, byteEnd: Buffer.byteLength(human.text), chunkHash: contentHash }), contentHash,
  mediaType: "text/plain", byteStart: 0, byteEnd: Buffer.byteLength(human.text), charStart: 0, charEnd: [...human.text].length,
  text: human.text, textPreview: human.text, languageHints: {}, scriptHints: {}, trustVector: {}, provenance: {}, features: [], status: "promoted", alpha: 1, observedAt: 1 } as EvidenceSpan;
const profile = createLanguageAcquisitionEngine({ idFactory: ids }).acquire({ sourceVersionId, text: human.text, createdAt: 1 });
let patterns: LanguagePatternRecord[];
beforeAll(() => {
  patterns = compileLanguageTrainingBatch({ runtime: createLanguageMemoryRuntime({ hasher, idFactory: ids }), hasher,
    batch: { streamId: "fixture://pinned-dolly/84", sourceSystem: "dialogue", profile, sourceVersionId, text: human.text,
      evidence: [source], transcriptTurns: human.turns, createdAt: 1, retainNgramObservations: false } }).patterns;
});
function cold(evidence = [source]) {
  const runtime = createLanguageMemoryRuntime({ hasher, idFactory: ids });
  return { runtime, state: runtime.hydrate({ models: [], patterns: JSON.parse(JSON.stringify(patterns)), constructionEvidence: evidence }) };
}
it.each(["Inception", "κάλυ月", "🪐한국"])("cold-realizes the source-owned scene with all observed speaker turns and title %s", async title => {
  const requestText = human.turns[0]!.surface.replace("Inception", title), { runtime, state } = cold();
  const frame = compileCreativeRequestFrameFromCompatibilityModels({ requestText, models: state.creativeEventCompatibilityModels, hasher });
  expect(frame).toBeDefined();
  const utterances = state.creativeEventCompatibilityModels.flatMap(model => creativeSourceUtterances(model, profile.id, hasher));
  const direct = utterances.flatMap(utterance => {
    const result = realizeCreativeSourceUtterance({ utterance, bundles: state.importedConstructionBundles, frame: frame!, requestText,
      ownerTurnId: "owner.current", turns: [{ turnId: "owner.current", turnIndex: 0, surface: requestText }], semanticPlanId: "plan.current", hasher });
    return result ? [result] : [];
  });
  expect(direct).toHaveLength(1);
  const expected = human.turns[1]!.surface.replaceAll("Inception", title);
  expect(direct[0]!.realization.text).toBe(expected);
  const scoped = scopeLanguageMemoryStateToLanguage(state, "language.observed", { profile: () => "language.observed", corpus: () => "language.observed" });
  const field = createAlphaFieldEngine().activate({ text: requestText, nodes: [], edges: [], hyperedges: [] });
  const base: ConstructGraph = { id: "construct.scene" as ConstructGraph["id"], episodeId: "episode.scene" as ConstructGraph["episodeId"], forceVector: {}, nodes: [], edges: [], artifacts: [] };
  const planned = planInventions({ requestText, requestedAuthority: "creative", samplingDisabled: true, creativeRequestFrame: frame,
    languageMemory: runtime, languageMemoryState: scoped, evidence: [], dialogueState: updateDialogueState({ requestText }), field,
    graph: { nodes: [], edges: [], hyperedges: [], bounded: true, query: {} }, construct: base });
  const entailment = createSemanticEntailmentEngine({ idFactory: ids, hasher }).check({ text: requestText, evidence: [], nodes: [], field, createdAt: 1 });
  const candidates = createCandidateEngine().generate({ requestText, requestedAuthority: "creative", field, entailment, evidence: [], inventionCandidates: planned,
    proofAnswer: "", learningNeeds: [], ccr: createCcrEngine().run({ text: requestText, evidence: [], nodes: [], edges: [], field, entailment }) });
  const selected = candidates.candidates.find(candidate => candidate.kind === "creative-candidate")!;
  const invention = planned.find(construct => construct.id === jsonRecord(selected.audit).constructId)!;
  const spoken = await createMouth({ languageMemory: runtime, correctionMemory: createCorrectionMemory({ idFactory: ids, hasher }), hashText: text => hasher.digestHex(text) })
    .speak({ requestText, requestedAuthority: "creative", creativeRequestFrame: frame, field, entailment, evidence: [], languageMemory: scoped,
      languageProfile: profile, construct: { ...base, nodes: [inventionConstructNode(invention)] }, selectedCandidate: selected });
  expect(spoken.realizationAvailability.status).toBe("realized");
  expect(spoken.text.replace(/\s+/gu, " ")).toBe(expected.replace(/\s+/gu, " "));
  expect(spoken.evidenceRefs).toEqual([]);
  if (title !== "Inception") expect(spoken.text).not.toContain("Inception");
});
it("withholds when the observed source or exact instruction frame is unavailable", () => {
  for (const evidence of [[], [{ ...source, status: "quarantined" as const }]]) {
    expect(cold(evidence).state.creativeEventCompatibilityModels).toEqual([]);
  }
  const { state } = cold();
  expect(compileCreativeRequestFrameFromCompatibilityModels({ requestText: "Ω≤7\n" + human.turns[0]!.surface, models: state.creativeEventCompatibilityModels, hasher })).toBeUndefined();
});
