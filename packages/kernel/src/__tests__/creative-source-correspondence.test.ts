// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
import { beforeAll, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { compileLanguageTrainingBatch } from "../language-training-batch.js";
import { createLanguageMemoryRuntime, scopeLanguageMemoryStateToLanguage } from "../language-memory-runtime.js";
import { compileCreativeRequestFrameFromCompatibilityModels, creativeEventCompatibilityDecision, creativeEventRoleDecision, creativeEventCompatibilityModelsFromPatterns } from "../creative-event-compatibility.js";
import { createLanguageAcquisitionEngine } from "../language.js";
import { createClock, createHasher } from "../primitives.js";
import { createIdFactory } from "../ids.js";
import { createAlphaFieldEngine } from "../field.js";
import { planInventions } from "../invention-planner.js";
import { updateDialogueState } from "../dialogue-pragmatics.js";
import { compileCreativeSourceCorrespondences } from "../creative-source-correspondence.js";
import { segmentUnicodeSurfaceV2 } from "../unicode-segmentation-v2.js";
import type { EvidenceSpan } from "../types.js";
import type { TranscriptTurn } from "../dialogue-communicative-act-learning.js";
import type { CreativeEventCompatibilityModel } from "../creative-event-compatibility.js";
import { createMouth } from "../mouth.js";
import { createCorrectionMemory } from "../correction-memory.js";
import { createSemanticEntailmentEngine } from "../entailment.js";
import { inventionConstructNode } from "../prediction.js";
import { createCandidateEngine } from "../candidate.js";
import { createCcrEngine } from "../ccr.js";
import { jsonRecord } from "../kernel-answer-primitives.js";
import { projectRequestAuthority } from "../request-authority.js";
import { deriveTurnRequirementField } from "../turn-requirements.js";
import type { ConstructGraph } from "../types.js";
import { creativeReferenceTestAnnotation, replyWithReviewedProperty } from "./fixtures/creative-reference-test-annotations.js";
const humanPair = JSON.parse(readFileSync(new URL("./fixtures/dolly-human-creative-pair.json", import.meta.url), "utf8")) as { text: string; turns: TranscriptTurn[] };

const hasher = createHasher();
const ids = createIdFactory({ hasher, clock: createClock({ fixedTime: 1 }), deterministicReplay: true, namespace: "human-source-correspondence" });

function witness(text: string): EvidenceSpan {
  const sourceVersionId = ids.sourceVersionId(text);
  const contentHash = ids.contentHash(text);
  return { id: ids.evidenceId({ sourceVersionId, byteStart: 0, byteEnd: Buffer.byteLength(text), spanHash: contentHash }),
    sourceId: ids.sourceId("dialogue", "fixture://pinned-dolly/192"), sourceVersionId,
    chunkId: ids.chunkId({ sourceVersionId, byteStart: 0, byteEnd: Buffer.byteLength(text), chunkHash: contentHash }), contentHash,
    mediaType: "text/plain", byteStart: 0, byteEnd: Buffer.byteLength(text), charStart: 0, charEnd: [...text].length,
    text, textPreview: text, languageHints: {}, scriptHints: {}, trustVector: {}, provenance: {}, features: [], status: "promoted", alpha: 1, observedAt: 1 };
}

describe("declared human creative source correspondence", () => {
  const evidence = [witness(humanPair.text)];
  const runtime = createLanguageMemoryRuntime({ hasher, idFactory: ids });
  let patterns: ReturnType<typeof compileLanguageTrainingBatch>["patterns"];
  const restart = (premises: EvidenceSpan[] = evidence, rows = patterns) => runtime.hydrate({ models: [], patterns: JSON.parse(JSON.stringify(rows)), constructionEvidence: premises });
  beforeAll(() => {
    const sourceVersionId = evidence[0]!.sourceVersionId;
    const profile = createLanguageAcquisitionEngine({ idFactory: ids }).acquire({ sourceVersionId, text: humanPair.text, createdAt: 1 });
    patterns = compileLanguageTrainingBatch({ runtime, hasher, batch: { streamId: "fixture://human", sourceSystem: "dialogue", profile, sourceVersionId,
      text: humanPair.text, evidence, transcriptTurns: humanPair.turns as TranscriptTurn[], createdAt: 1, retainNgramObservations: false } }).patterns;
  });

  it("reads each source once for all correspondence witnesses and rechecks changed source text", () => {
    const state = restart();
    const expected = state.creativeEventCompatibilityModels;
    const events = state.importedConstructionBundles.flatMap(bundle => bundle.creativeEvents ?? []);
    const observed = patterns.filter(pattern => (pattern.patternJson as { reliability?: string }).reliability === "source_observed");
    expect(expected.length).toBeGreaterThan(0);
    const iterate = String.prototype[Symbol.iterator];
    let sourceScans = 0;
    const eventFind = vi.spyOn(events, "find");
    const eventSome = vi.spyOn(events, "some");
    const iterator = vi.spyOn(String.prototype, Symbol.iterator).mockImplementation(function(this: string) {
      if (String(this) === humanPair.text) sourceScans++;
      return iterate.call(this);
    });
    try {
      expect(creativeEventCompatibilityModelsFromPatterns(observed, { evidence, events, hasher })).toEqual(expected);
      expect(sourceScans).toBe(1);
      expect(eventFind).not.toHaveBeenCalled();
      expect(eventSome).not.toHaveBeenCalled();
    } finally { iterator.mockRestore(); eventFind.mockRestore(); eventSome.mockRestore(); }
    expect(creativeEventCompatibilityModelsFromPatterns(observed, { evidence: evidence.map(span => ({ ...span, text: `#${span.text.slice(1)}` })), events, hasher })).toEqual([]);
    const eventId = expected.flatMap(model => model.sourceObservations ?? [])[0]!.eventId;
    const event = events.find(row => row.id === eventId)!;
    expect(creativeEventCompatibilityModelsFromPatterns(observed, { evidence, events: [{ ...event, evidenceId: "evidence.foreign" }, ...events], hasher })).toEqual(expected);
    expect(creativeEventCompatibilityModelsFromPatterns(observed, { evidence: [{ ...evidence[0]!, sourceId: "source.foreign" as never }, ...evidence], events, hasher })).toEqual([]);
  });

  it("refuses a selected declared human reply when its speech grammar is missing", async () => {
    const state = restart(evidence, patterns.filter(pattern => !String(jsonRecord(jsonRecord(pattern.patternJson).bundle).bindingId ?? "").startsWith("source.creative.utterance.")));
    const request = humanPair.turns[0]!.surface;
    const sourceFrame = compileCreativeRequestFrameFromCompatibilityModels({ requestText: request, models: state.creativeEventCompatibilityModels, hasher })!;
    const points = [...request];
    for (const [index, argument] of [...sourceFrame.arguments.entries()].reverse()) points.splice(argument.span.charStart, argument.span.charEnd - argument.span.charStart, `qzeta${index}`);
    const fresh = points.join("");
    const frame = compileCreativeRequestFrameFromCompatibilityModels({ requestText: fresh, models: state.creativeEventCompatibilityModels, hasher })!;
    const scoped = scopeLanguageMemoryStateToLanguage(state, "language.observed", { profile: () => "language.observed", corpus: () => "language.observed" });
    const field = createAlphaFieldEngine().activate({ text: fresh, nodes: [], edges: [], hyperedges: [] });
    const base: ConstructGraph = { id: "construct.source.observed" as ConstructGraph["id"], episodeId: "episode.source.observed" as ConstructGraph["episodeId"], forceVector: {}, nodes: [], edges: [], artifacts: [] };
    const planned = planInventions({ requestText: fresh, requestedAuthority: "creative", samplingDisabled: true, creativeRequestFrame: frame,
      languageMemory: runtime, languageMemoryState: scoped, evidence: [], dialogueState: updateDialogueState({ requestText: fresh }), field,
      graph: { nodes: [], edges: [], hyperedges: [], bounded: true, query: {} }, construct: base });
    const entailment = createSemanticEntailmentEngine({ idFactory: ids, hasher }).check({ text: fresh, evidence: [], nodes: [], field, createdAt: 1 });
    const candidates = createCandidateEngine().generate({ requestText: fresh, requestedAuthority: "creative", field, entailment, evidence: [], inventionCandidates: planned,
      proofAnswer: "", learningNeeds: [], ccr: createCcrEngine().run({ text: fresh, evidence: [], nodes: [], edges: [], field, entailment }) });
    const selected = candidates.candidates.find(candidate => candidate.kind === "creative-candidate")!;
    const invention = planned.find(construct => construct.id === jsonRecord(selected.audit).constructId)!;
    const semanticPlan = jsonRecord(jsonRecord(invention.trace).structuralSemanticPlan);
    const events = (Array.isArray(semanticPlan.events) ? semanticPlan.events : []).map(jsonRecord);
    expect(events.length).toBeGreaterThanOrEqual(4);
    const first = events.find(row => scoped.importedConstructionBundles.find(bundle => bundle.id === row.bundleId)?.creativeEvents?.some(event => event.id === row.eventId && event.sourceLabel === "run"))!;
    expect(first).toBeDefined();
    const sourceEvent = scoped.importedConstructionBundles.find(bundle => bundle.id === first.bundleId)!.creativeEvents!.find(event => event.id === first.eventId)!;
    expect(sourceEvent.sourceLabel).toBe("run");
    const profile = createLanguageAcquisitionEngine({ idFactory: ids }).acquire({ sourceVersionId: evidence[0]!.sourceVersionId, text: humanPair.text, createdAt: 1 });
    const mouth = createMouth({ languageMemory: runtime, correctionMemory: createCorrectionMemory({ idFactory: ids, hasher }), hashText: text => hasher.digestHex(text) });
    const spoken = await mouth.speak({ requestText: fresh, requestedAuthority: "creative", creativeRequestFrame: frame, field, entailment,
      evidence: [], languageMemory: scoped, languageProfile: profile, construct: { ...base, nodes: [inventionConstructNode(invention)] }, selectedCandidate: selected });
    const structural = jsonRecord(jsonRecord(spoken.realizationTrace.languageMemory).structuralCreative);
    expect(structural).toMatchObject({ failClosed: true, selectionBound: true, selectedEventCount: events.length,
      selectedBundleIds: semanticPlan.sourceBundleIds,
      decision: { status: "rejected", reasonId: "selected_source_utterance_speech_grammar_refused",
        selectedConstructionForm: { kind: "declared_source_reply" }, realizedEventCount: 0 } });
    expect(spoken.text).toBe("");
    expect(spoken.evidenceRefs).toEqual([]);
  });

  it("realizes all and only annotated participant properties while preserving homonymous room senses after a cold restart", async () => {
    const request = humanPair.turns[0]!.surface;
    const reply = humanPair.turns[1]!.surface;
    const sourceFrame = compileCreativeRequestFrameFromCompatibilityModels({ requestText: request, models: restart().creativeEventCompatibilityModels, hasher })!;
    const room = sourceFrame.arguments.find(argument => argument.span.text === "room")!;
    expect(room).toBeDefined();
    const points = [...request];
    points.splice(room.span.charStart, room.span.charEnd - room.span.charStart, "κάλυ月");
    const fresh = points.join("");
    expect(humanPair.text).not.toContain("κάλυ月");
    const declaration = creativeReferenceTestAnnotation("dolly-human-creative-pair.json", humanPair.text, hasher);
    const annotated = compileLanguageTrainingBatch({ runtime, hasher, batch: { streamId: "fixture://human", sourceSystem: "dialogue",
      profile: createLanguageAcquisitionEngine({ idFactory: ids }).acquire({ sourceVersionId: evidence[0]!.sourceVersionId, text: humanPair.text, createdAt: 1 }),
      sourceVersionId: evidence[0]!.sourceVersionId, text: humanPair.text, evidence, transcriptTurns: humanPair.turns, sourceReferenceBindings: declaration,
      createdAt: 1, retainNgramObservations: false } }).patterns;
    for (const [text, rows, available] of [[request, patterns, true], [fresh, annotated, true], [request, annotated, true], [fresh, patterns, false]] as const) {
      const cold = createLanguageMemoryRuntime({ hasher, idFactory: ids });
      const restored = cold.hydrate({ models: [], patterns: JSON.parse(JSON.stringify(rows)), constructionEvidence: evidence });
      const frame = compileCreativeRequestFrameFromCompatibilityModels({ requestText: text, models: restored.creativeEventCompatibilityModels, hasher })!;
      const scoped = scopeLanguageMemoryStateToLanguage(restored, "language.observed", { profile: () => "language.observed", corpus: () => "language.observed" });
      const field = createAlphaFieldEngine().activate({ text, nodes: [], edges: [], hyperedges: [] });
      const base: ConstructGraph = { id: "construct.source.utterance" as ConstructGraph["id"], episodeId: "episode.source.utterance" as ConstructGraph["episodeId"], forceVector: {}, nodes: [], edges: [], artifacts: [] };
      const planned = planInventions({ requestText: text, requestedAuthority: "creative", samplingDisabled: true, creativeRequestFrame: frame,
        languageMemory: cold, languageMemoryState: scoped, evidence: [], dialogueState: updateDialogueState({ requestText: text }), field,
        graph: { nodes: [], edges: [], hyperedges: [], bounded: true, query: {} }, construct: base });
      const entailment = createSemanticEntailmentEngine({ idFactory: ids, hasher }).check({ text, evidence: [], nodes: [], field, createdAt: 1 });
      const candidates = createCandidateEngine().generate({ requestText: text, requestedAuthority: "creative", field, entailment, evidence: [], inventionCandidates: planned,
        proofAnswer: "", learningNeeds: [], ccr: createCcrEngine().run({ text, evidence: [], nodes: [], edges: [], field, entailment }) });
      const selected = candidates.candidates.find(candidate => candidate.kind === "creative-candidate")!;
      const invention = planned.find(construct => construct.id === jsonRecord(selected.audit).constructId)!;
      const profile = createLanguageAcquisitionEngine({ idFactory: ids }).acquire({ sourceVersionId: evidence[0]!.sourceVersionId, text: humanPair.text, createdAt: 1 });
      const mouth = createMouth({ languageMemory: cold, correctionMemory: createCorrectionMemory({ idFactory: ids, hasher }), hashText: text => hasher.digestHex(text) });
      const spoken = await mouth.speak({ requestText: text, requestedAuthority: "creative", creativeRequestFrame: frame, field, entailment,
        evidence: [], languageMemory: scoped, languageProfile: profile, construct: { ...base, nodes: [inventionConstructNode(invention)] }, selectedCandidate: selected });
      if (!available) { expect(spoken.realizationAvailability.status).toBe("realization_unavailable"); continue; }
      expect(spoken.realizationAvailability.status).toBe("realized");
      expect(spoken.text).toContain("It was going to be a long day.");
      expect(spoken.text).toContain("Time to call her brother-in-law to thank him for letting Stella visit.");
      expect(spoken.text.length).toBeGreaterThan(reply.length / 2);
      expect(spoken.text).not.toContain("Write a short story");
      expect(spoken.evidenceRefs).toEqual([]);
      if (text === fresh) {
        const expected = replyWithReviewedProperty({ declaration, reply, replyStart: humanPair.turns[1]!.startCodePoint, value: "κάλυ月" });
        expect(spoken.text.replace(/\s+/gu, " ")).toBe(expected.replace(/\s+/gu, " "));
        expect(spoken.text.match(/κάλυ月/gu)).toHaveLength(2);
        expect(spoken.text).toContain("laundry room");
        expect(spoken.text).toContain("bedroom");
        expect(spoken.text).not.toContain("small room");
        expect(spoken.text).not.toContain("middle of the room");
      }
      else expect(spoken.text.replace(/\s+/gu, " ")).toBe(reply.replace(/\s+/gu, " "));
    }
  });

  it("learns an exact request template and binds fresh opaque fillers after source-owned restart", () => {
    const state = restart();
    const models = state.creativeEventCompatibilityModels;
    expect(models.some(model => model.reliability === "source_observed")).toBe(true);
    const request = humanPair.turns[0]!.surface;
    const frame = compileCreativeRequestFrameFromCompatibilityModels({ requestText: request, models, hasher });
    expect(frame).toBeDefined();
    const points = [...request];
    const replacements = frame!.arguments.map((argument, index) => ({ ...argument.span, value: `κάλυ${index}月` }));
    for (const replacement of [...replacements].sort((a, b) => b.charStart - a.charStart)) points.splice(replacement.charStart, replacement.charEnd - replacement.charStart, replacement.value);
    const fresh = points.join("");
    const bound = compileCreativeRequestFrameFromCompatibilityModels({ requestText: fresh, models, hasher });
    expect(bound?.arguments.map(role => role.span.text)).toEqual(replacements.map(row => row.value));
    const events = state.importedConstructionBundles.flatMap(bundle => bundle.creativeEvents ?? []);
    const admitted = events.flatMap(event => { const decision = creativeEventCompatibilityDecision(models, bound!, event); return decision ? [{ event, decision }] : []; });
    expect(admitted.length).toBeGreaterThan(0);
    expect(admitted.every(row => row.decision.qualification === "source_observed")).toBe(true);
    expect(admitted.some(({ event }) => bound!.arguments.some(role => event.argumentFrame.bindings.some(port =>
      (port.roleId === "scce.role.patient" || port.roleId === "scce.role.complement")
      && creativeEventRoleDecision(models, bound!, role.roleId, port.roleId, event)?.qualification === "source_observed")))).toBe(true);
    const serialized = JSON.stringify(models);
    expect(serialized).not.toContain('"posterior"');
    expect(serialized).not.toContain('"calibrationId"');
    expect(serialized).not.toContain('"minimumRolePosterior"');
    const scoped = scopeLanguageMemoryStateToLanguage(state, "language.observed", { profile: () => "language.observed", corpus: () => "language.observed" });
    const planned = planInventions({ requestText: fresh, requestedAuthority: "creative", samplingDisabled: true, creativeRequestFrame: bound,
      languageMemory: runtime, languageMemoryState: scoped, evidence: [], dialogueState: updateDialogueState({ requestText: fresh }),
      field: createAlphaFieldEngine().activate({ text: fresh, nodes: [], edges: [], hyperedges: [] }),
      graph: { nodes: [], edges: [], hyperedges: [], bounded: true, query: {} },
      construct: { id: "construct.source.observed" as never, episodeId: "episode.source.observed" as never, forceVector: {}, nodes: [], edges: [], artifacts: [] } });
    const structural = planned.flatMap(construct => ((construct.trace as any).proposalRealization?.structuralEventPlan ?? []));
    expect(structural.length).toBeGreaterThanOrEqual(4);
    expect(structural.some(event => event.requestRoleBindings.some((binding: any) => replacements.some(row => row.value === binding.requestSpan.text)))).toBe(true);
    expect(structural.every(event => event.compatibilityQualification === "source_observed" && event.compatibilityCalibrationId === undefined && event.compatibilityThreshold === undefined)).toBe(true);
    expect(planned.every(construct => construct.proofStatusId === "proof.status.generated_not_evidence" && construct.basisEvidenceIds.length === 0)).toBe(true);
  });

  it("carries observed source intent without trusting cloned or changed request frames or overriding the owner", () => {
    const state = restart();
    const request = humanPair.turns[0]!.surface;
    const frame = compileCreativeRequestFrameFromCompatibilityModels({ requestText: request, models: state.creativeEventCompatibilityModels, hasher })!;
    const requirementField = deriveTurnRequirementField({ requestText: request });
    const baseline = projectRequestAuthority({ requirementField });
    const observed = projectRequestAuthority({ requirementField, sourceRequestFrame: frame });
    expect(observed.requestedAuthority).toBe("creative");
    expect(jsonRecord(observed.trace).selectionSource).toBe("source_observed_request_construction");
    expect(projectRequestAuthority({ requirementField, sourceRequestFrame: frame, explicitAuthority: "factual" }).requestedAuthority).toBe("factual");
    expect(projectRequestAuthority({ requirementField, sourceRequestFrame: frame, typedProgramBehaviorRequirementIds: ["owner.behavior"] }).requestedAuthority).toBe("program");
    expect(projectRequestAuthority({ requirementField, sourceRequestFrame: JSON.parse(JSON.stringify(frame)) }).requestedAuthority).toBe(baseline.requestedAuthority);
    frame.arguments[0]!.roleId = "role.foreign";
    expect(projectRequestAuthority({ requirementField, sourceRequestFrame: frame }).requestedAuthority).toBe(baseline.requestedAuthority);
  });

  it("refuses ambiguous source links, repeated request values and fabricated calibration metadata", () => {
    const state = restart();
    const events = state.importedConstructionBundles.flatMap(bundle => bundle.creativeEvents ?? []);
    const model = state.creativeEventCompatibilityModels[0]!;
    const compile = (turns: TranscriptTurn[]) => compileCreativeSourceCorrespondences({ turns, evidence, events, hasher, profileId: events[0]!.profileId, updatedAt: 1 });
    expect(compile([...humanPair.turns, humanPair.turns[0]!] as TranscriptTurn[])).toEqual([]);
    expect(compile(humanPair.turns.map(turn => ({ ...turn, ...(turn.replyToTurnIndex !== undefined ? { commitmentScope: "external" } : {}) })) as TranscriptTurn[])).toEqual([]);
    for (const row of model.sourceObservations ?? []) for (const binding of row.bindings) {
      const value = [...row.request.surface].slice(binding.requestStart, binding.requestEnd).join("");
      const units = segmentUnicodeSurfaceV2(row.request.surface).lexicalSegments;
      const target = segmentUnicodeSurfaceV2(value).lexicalSegments.map(unit => unit.normalized);
      expect(units.filter((_, index) => target.every((unit, offset) => units[index + offset]?.normalized === unit))).toHaveLength(1);
    }
    const rawModel = patterns.find(pattern => (pattern.patternJson as any).reliability === "source_observed")!;
    for (const patch of [{ calibrationId: "invented" }, { reliability: "calibrated", calibrationId: "invented", minimumAdmissiblePosterior: 0, minimumRolePosterior: 0 },
      { version: "obsolete.compiler" }]) {
      const mutated = patterns.map(pattern => pattern.id === rawModel.id ? { ...pattern, patternJson: { ...(pattern.patternJson as object), ...patch } as never } : pattern);
      expect(restart(evidence, mutated).creativeEventCompatibilityModels).toEqual([]);
    }
    expect(restart(evidence, patterns.map(pattern => pattern.id === rawModel.id ? { ...pattern, evidenceIds: ["evidence.foreign" as never] } : pattern))
      .creativeEventCompatibilityModels).toEqual([]);
    expect(compileCreativeRequestFrameFromCompatibilityModels({ requestText: humanPair.turns[0]!.surface, models: JSON.parse(JSON.stringify([model])), hasher })).toBeUndefined();
    const request = humanPair.turns[0]!.surface;
    const frame = compileCreativeRequestFrameFromCompatibilityModels({ requestText: request, models: [model], hasher })!;
    const adjacent = frame.arguments.find((role, index) => frame.arguments[index + 1]
      && [...request].slice(role.span.charEnd, frame.arguments[index + 1]!.span.charStart).join("").trim() === "");
    expect(adjacent).toBeDefined();
    const points = [...request];
    points.splice(adjacent!.span.charStart, adjacent!.span.charEnd - adjacent!.span.charStart, "κάλυ μήνα");
    expect(compileCreativeRequestFrameFromCompatibilityModels({ requestText: points.join(""), models: [model], hasher })).toBeUndefined();
  });

  it("preserves explicit calibrated rejection over an observed correspondence", () => {
    const state = restart();
    const models = state.creativeEventCompatibilityModels;
    const frame = compileCreativeRequestFrameFromCompatibilityModels({ requestText: humanPair.turns[0]!.surface, models, hasher })!;
    const event = state.importedConstructionBundles.flatMap(bundle => bundle.creativeEvents ?? []).find(event =>
      creativeEventCompatibilityDecision(models, frame, event)?.qualification === "source_observed")!;
    const calibrated: CreativeEventCompatibilityModel = { schema: "scce.creative_event_compatibility_model.v1", id: "explicit.calibrated.outcome", version: "1",
      requestCompilerId: frame.compilerId, eventCompilerId: event.compilerId, calibrationId: "explicit.calibration", reliability: "calibrated",
      minimumAdmissiblePosterior: 0.5, minimumRolePosterior: 0.5,
      eventCompatibilities: [{ requestFrameId: frame.sourceActivationIds[0]!, eventRelationId: event.relationId, posterior: 0, support: 1, sourceActivationIds: [] }],
      roleCompatibilities: [] };
    expect(creativeEventCompatibilityDecision([...models, calibrated], frame, event)).toMatchObject({ posterior: 0, threshold: 0.5, calibrationId: "explicit.calibration" });
    const port = event.argumentFrame.bindings[0];
    if (port?.roleId === "scce.role.patient" || port?.roleId === "scce.role.complement") {
      expect(creativeEventRoleDecision([...models, calibrated], frame, frame.arguments[0]!.roleId, port.roleId, event)).toBeUndefined();
    }
  });

  it("preserves opaque-role controls under a synthetic bijective non-Latin renaming", () => {
    const vocabulary = new Map<string, string>();
    const rename = (text: string) => {
      const points = [...text];
      for (const unit of [...segmentUnicodeSurfaceV2(text).lexicalSegments].reverse()) {
        let name = vocabulary.get(unit.normalized);
        if (!name) {
          let index = vocabulary.size;
          name = "ж";
          do { name += String.fromCodePoint(0x430 + index % 32); index = Math.floor(index / 32); } while (index);
          vocabulary.set(unit.normalized, name);
        }
        points.splice(unit.codePointStart, unit.codePointEnd - unit.codePointStart, name);
      }
      return points.join("");
    };
    let cursor = 0;
    const turns = humanPair.turns.map(turn => { const surface = rename(turn.surface); const startCodePoint = cursor;
      cursor += [...surface].length + 1; return { ...turn, surface, startCodePoint, endCodePoint: cursor - 1 }; }) as TranscriptTurn[];
    const text = turns.map(turn => turn.surface).join("\n");
    const premise = witness(text);
    const profile = createLanguageAcquisitionEngine({ idFactory: ids }).acquire({ sourceVersionId: premise.sourceVersionId, text, createdAt: 1 });
    const compiled = compileLanguageTrainingBatch({ runtime, hasher, batch: { streamId: "fixture://renamed-source", sourceSystem: "dialogue", profile,
      sourceVersionId: premise.sourceVersionId, text, evidence: [premise], transcriptTurns: turns, createdAt: 1, retainNgramObservations: false } });
    const state = runtime.hydrate({ models: [], patterns: JSON.parse(JSON.stringify(compiled.patterns)), constructionEvidence: [premise] });
    const frame = compileCreativeRequestFrameFromCompatibilityModels({ requestText: turns[0]!.surface, models: state.creativeEventCompatibilityModels, hasher });
    expect(frame?.arguments.length).toBeGreaterThan(0);
    expect(frame!.arguments.every(role => !/\p{Script=Latin}/u.test(role.span.text))).toBe(true);
  });

  it("refuses removed, altered, foreign-owned or unpromoted source premises", () => {
    for (const premises of [[], [{ ...evidence[0]!, sourceId: "source.foreign" as never }], [{ ...evidence[0]!, text: evidence[0]!.text.replace("room", "xxxx") }],
      [{ ...evidence[0]!, status: "candidate" as never }]]) {
      const state = restart(premises);
      expect(state.creativeEventCompatibilityModels.filter(model => model.reliability === "source_observed")).toEqual([]);
    }
  });
});
