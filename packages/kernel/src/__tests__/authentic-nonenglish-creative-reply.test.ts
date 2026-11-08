// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { createAlphaFieldEngine } from "../field.js";
import { createCandidateEngine } from "../candidate.js";
import { createCcrEngine } from "../ccr.js";
import { createCorrectionMemory } from "../correction-memory.js";
import { compileCreativeRequestFrameFromCompatibilityModels } from "../creative-event-compatibility.js";
import { updateDialogueState } from "../dialogue-pragmatics.js";
import type { TranscriptTurn } from "../dialogue-communicative-act-learning.js";
import { createSemanticEntailmentEngine } from "../entailment.js";
import { createIdFactory } from "../ids.js";
import { planInventions } from "../invention-planner.js";
import { jsonRecord } from "../kernel-answer-primitives.js";
import { createLanguageAcquisitionEngine } from "../language.js";
import { createLanguageMemoryRuntime, scopeLanguageMemoryStateToLanguage } from "../language-memory-runtime.js";
import { compileLanguageTrainingBatch } from "../language-training-batch.js";
import { createMouth } from "../mouth.js";
import { inventionConstructNode } from "../prediction.js";
import { createClock, createHasher } from "../primitives.js";
import type { ConstructGraph, EvidenceSpan } from "../types.js";
import { creativeReferenceTestAnnotation, replyWithReviewedProperty } from "./fixtures/creative-reference-test-annotations.js";

const human = JSON.parse(readFileSync(new URL("./fixtures/oasst-human-russian-creative-pair.json", import.meta.url), "utf8")) as {
  text: string; turns: TranscriptTurn[]; sourceMetadata: { messages: Array<{ message_id: string; parent_id?: string;
    lang: string; synthetic: boolean; model_name: string | null; review_result: boolean }> };
};

describe("authentic whole Russian creative reply acquisition", () => {
  it.each([false, true])("cold-restores a whole Russian human reply and substitutes complete source-owned properties (%s)", async annotated => {
    expect(human.sourceMetadata.messages.every(message => message.lang === "ru" && message.synthetic === false
      && message.model_name === null && message.review_result)).toBe(true);
    expect(human.sourceMetadata.messages[1]!.parent_id).toBe(human.sourceMetadata.messages[0]!.message_id);
    expect(/\p{Script=Latin}/u.test(human.text)).toBe(false);
    const hasher = createHasher(), clock = createClock({ fixedTime: 1 });
    const ids = createIdFactory({ hasher, clock, deterministicReplay: true, namespace: "human-russian-reply" });
    const sourceVersionId = ids.sourceVersionId(human.text), contentHash = ids.contentHash(human.text);
    const sourceId = ids.sourceId("dialogue", `fixture://oasst1/${human.sourceMetadata.messages[0]!.message_id}`);
    const evidence: EvidenceSpan = { id: ids.evidenceId({ sourceVersionId, byteStart: 0, byteEnd: Buffer.byteLength(human.text), spanHash: contentHash }),
      sourceId, sourceVersionId, chunkId: ids.chunkId({ sourceVersionId, byteStart: 0, byteEnd: Buffer.byteLength(human.text), chunkHash: contentHash }), contentHash,
      mediaType: "text/plain", byteStart: 0, byteEnd: Buffer.byteLength(human.text), charStart: 0, charEnd: [...human.text].length,
      text: human.text, textPreview: human.text, languageHints: {}, scriptHints: {}, trustVector: {}, provenance: {}, features: [], status: "promoted", alpha: 1, observedAt: 1 };
    const profile = createLanguageAcquisitionEngine({ idFactory: ids }).acquire({ sourceVersionId, text: human.text, createdAt: 1 });
    const references = creativeReferenceTestAnnotation("oasst-human-russian-creative-pair.json", human.text, hasher);
    const acquired = compileLanguageTrainingBatch({ runtime: createLanguageMemoryRuntime({ hasher, idFactory: ids }), hasher,
      batch: { streamId: "fixture://oasst1-human-russian", sourceSystem: "dialogue", canonicalSource: { sourceId, contentHash },
        profile, sourceVersionId, text: human.text, evidence: [evidence], transcriptTurns: human.turns,
        ...(annotated ? { sourceReferenceBindings: references } : {}), createdAt: 1, retainNgramObservations: false } });
    const patterns = JSON.parse(JSON.stringify(acquired.patterns)) as typeof acquired.patterns;
    const sourceState = createLanguageMemoryRuntime({ hasher }).hydrate({ models: [], patterns, constructionEvidence: [evidence] });
    const request = human.turns[0]!.surface;
    const original = compileCreativeRequestFrameFromCompatibilityModels({ requestText: request, models: sourceState.creativeEventCompatibilityModels, hasher })!;
    expect(original).toBeDefined();
    const name = original.arguments.find(role => role.span.text === "Спанч")!;
    expect(name).toBeDefined();
    const points = [...request];
    points.splice(name.span.charStart, name.span.charEnd - name.span.charStart, "Кварц");
    const heldout = points.join("");
    expect(human.text).not.toContain("Кварц");
    for (const text of [request, heldout]) {
      const runtime = createLanguageMemoryRuntime({ hasher, idFactory: ids });
      const state = scopeLanguageMemoryStateToLanguage(runtime.hydrate({ models: [], patterns: JSON.parse(JSON.stringify(patterns)), constructionEvidence: [evidence] }),
        "language.source.russian", { profile: () => "language.source.russian", corpus: () => "language.source.russian" });
      const frame = compileCreativeRequestFrameFromCompatibilityModels({ requestText: text, models: state.creativeEventCompatibilityModels, hasher })!;
      const field = createAlphaFieldEngine().activate({ text, nodes: [], edges: [], hyperedges: [] });
      const base: ConstructGraph = { id: "construct.human.russian" as ConstructGraph["id"], episodeId: "episode.human.russian" as ConstructGraph["episodeId"], forceVector: {}, nodes: [], edges: [], artifacts: [] };
      const inventions = planInventions({ requestText: text, requestedAuthority: "creative", samplingDisabled: true, creativeRequestFrame: frame,
        languageMemory: runtime, languageMemoryState: state, evidence: [], dialogueState: updateDialogueState({ requestText: text }), field,
        graph: { nodes: [], edges: [], hyperedges: [], bounded: true, query: {} }, construct: base });
      const entailment = createSemanticEntailmentEngine({ idFactory: ids, hasher }).check({ text, evidence: [], nodes: [], field, createdAt: 1 });
      const candidates = createCandidateEngine().generate({ requestText: text, requestedAuthority: "creative", field, entailment, evidence: [], inventionCandidates: inventions,
        proofAnswer: "", learningNeeds: [], ccr: createCcrEngine().run({ text, evidence: [], nodes: [], edges: [], field, entailment }) });
      const selected = candidates.candidates.find(candidate => candidate.kind === "creative-candidate")!;
      expect(selected).toBeDefined();
      const invention = inventions.find(candidate => candidate.id === jsonRecord(selected.audit).constructId)!;
      const mouth = createMouth({ languageMemory: runtime, correctionMemory: createCorrectionMemory({ idFactory: ids, hasher }), hashText: value => hasher.digestHex(value) });
      const spoken = await mouth.speak({ requestText: text, requestedAuthority: "creative", creativeRequestFrame: frame, field, entailment, evidence: [], languageMemory: state,
        languageProfile: profile, construct: { ...base, nodes: [inventionConstructNode(invention)] }, selectedCandidate: selected });
      expect(spoken.realizationAvailability.status).toBe("realized");
      expect(spoken.evidenceRefs).toEqual([]);
      expect(/\p{Script=Latin}/u.test(spoken.text)).toBe(false);
      expect(spoken.text).toContain("маленькие зеленые мужички");
      expect(spoken.text).toContain("своими новыми друзьями");
      if (text === request) expect(spoken.text.replace(/\s+/gu, " ")).toBe(human.turns[1]!.surface.replace(/\s+/gu, " "));
      else {
        const expected = replyWithReviewedProperty({ declaration: references, reply: human.turns[1]!.surface, replyStart: human.turns[1]!.startCodePoint, value: "Кварц" });
        expect(spoken.text.replace(/\s+/gu, " ")).toBe(expected.replace(/\s+/gu, " "));
        expect(spoken.text.match(/Кварц/gu)).toHaveLength(6);
        expect(spoken.text).not.toContain("Спанч");
      }
    }
    const revoked = createLanguageMemoryRuntime({ hasher }).hydrate({ models: [], patterns, constructionEvidence: [] });
    expect(revoked.creativeEventCompatibilityModels).toEqual([]);
  });
});
