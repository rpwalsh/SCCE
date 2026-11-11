// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
import { readFileSync } from "node:fs";
import { expect, it } from "vitest";
import { validateDeclaredTranscriptSource } from "../dialogue-communicative-act-learning.js";
import { createUniversalCreativeEventConstructionCompiler, CREATIVE_EVENT_CONSTRUCTION_PATTERN_SCHEMA,
  LANGUAGE_CONSTRUCTION_PATTERN_SCHEMA } from "../language-construction-memory.js";
import { compileLanguageTrainingBatch } from "../language-training-batch.js";
import { createLanguageMemoryRuntime } from "../language-memory-runtime.js";
import { createLanguageAcquisitionEngine } from "../language.js";
import { compileCreativeRequestFrameFromCompatibilityModels } from "../creative-event-compatibility.js";
import { compileCreativeEventSpeechGrammarPatterns, createCreativeEventSpeechGrammarIndex } from "../creative-event-speech-grammar.js";
import { canonicalStringify, createClock, createHasher } from "../primitives.js";
import { createIdFactory } from "../ids.js";
import type { EvidenceSpan } from "../types.js";

it("persists every bounded page through the shared batch and learns reply correspondences beyond its first page", () => {
  const human = validateDeclaredTranscriptSource(JSON.parse(readFileSync(new URL("./fixtures/dolly-human-creative-pair.json", import.meta.url), "utf8")))!;
  const hasher = createHasher();
  const ids = createIdFactory({ hasher, clock: createClock({ fixedTime: 1 }), deterministicReplay: true, namespace: "creative-page-batch" });
  const sourceVersionId = ids.sourceVersionId(human.text), contentHash = ids.contentHash(human.text);
  const evidence: EvidenceSpan = { id: ids.evidenceId({ sourceVersionId, byteStart: 0, byteEnd: Buffer.byteLength(human.text), spanHash: contentHash }),
    sourceId: ids.sourceId("dialogue", "fixture://pinned-pair-192"), sourceVersionId,
    chunkId: ids.chunkId({ sourceVersionId, byteStart: 0, byteEnd: Buffer.byteLength(human.text), chunkHash: contentHash }), contentHash,
    mediaType: "text/plain", byteStart: 0, byteEnd: Buffer.byteLength(human.text), charStart: 0, charEnd: [...human.text].length,
    text: human.text, textPreview: human.text, languageHints: {}, scriptHints: {}, trustVector: {}, provenance: {}, features: [], status: "promoted", alpha: 1, observedAt: 1 };
  const profile = createLanguageAcquisitionEngine({ idFactory: ids }).acquire({ sourceVersionId, text: human.text, createdAt: 1 });
  const compiler = createUniversalCreativeEventConstructionCompiler();
  const compiled = compileLanguageTrainingBatch({ runtime: createLanguageMemoryRuntime({ hasher, idFactory: ids }), hasher,
    creativeEventCompiler: { id: compiler.id, compile: input => compiler.compile({ ...input, maxEvents: 8 }) },
    batch: { streamId: "fixture://page-batch", sourceSystem: "dialogue", profile, sourceVersionId, text: human.text, evidence: [evidence],
      transcriptTurns: human.turns, artifactScope: "construction_only", createdAt: 1 } });
  const pages = compiled.constructionPatterns.filter(pattern => (pattern.patternJson as { schema?: string }).schema === CREATIVE_EVENT_CONSTRUCTION_PATTERN_SCHEMA);
  expect(pages.length).toBeGreaterThan(1);
  expect(pages.every(pattern => (pattern.patternJson as any).bundle.events.length <= 8)).toBe(true);
  expect(compiled.patterns.some(pattern => (pattern.patternJson as { schema?: string }).schema === "scce.creative_event_source_coverage.v1")).toBe(true);
  const state = createLanguageMemoryRuntime({ hasher }).hydrate({ models: [], patterns: JSON.parse(JSON.stringify(compiled.patterns)), constructionEvidence: [evidence] });
  expect(state.importedConstructionBundles.filter(bundle => bundle.creativeEvents?.length).length).toBe(pages.length);
  const events = state.importedConstructionBundles.flatMap(bundle => bundle.creativeEvents ?? []);
  const speech = createCreativeEventSpeechGrammarIndex(state.importedConstructionBundles);
  expect(events.length).toBeGreaterThan(0);
  const missingSpeech = events.filter(event => speech.forEvent(event).length === 0);
  expect({ total: events.length, witnessed: events.length - missingSpeech.length, missing: missingSpeech.map(event => ({ id: event.id,
    sentence: [event.argumentFrame.sourceSentenceStartCodePoint, event.argumentFrame.sourceSentenceEndCodePoint],
    label: [event.labelStartCodePoint, event.labelEndCodePoint], sourceLabel: event.sourceLabel,
    observedLabel: [...evidence.text].slice(event.labelStartCodePoint, event.labelEndCodePoint).join(""),
    ports: event.argumentFrame.bindings.length })) }).toEqual({ total: events.length, witnessed: events.length, missing: [] });
  const firstWitness = speech.forEvent(events[0]!)[0]!;
  const deterministicIndex = createCreativeEventSpeechGrammarIndex([
    { ...firstWitness.bundle, id: "bundle.a" },
    { ...firstWitness.bundle, id: "bundle.Z" }
  ]);
  expect(deterministicIndex.forEvent(events[0]!).map(row => row.bundle.id)).toEqual(["bundle.Z", "bundle.a"]);
  const speechPatterns = compiled.patterns.filter(pattern => {
    const row = pattern.patternJson as { schema?: string; bundle?: { bindingId?: string } };
    return row.schema === LANGUAGE_CONSTRUCTION_PATTERN_SCHEMA && row.bundle?.bindingId?.startsWith("surface.creative_event.speech.");
  });
  const speechBundles = state.importedConstructionBundles.filter(bundle => bundle.sourceExamples.length > 0
    && bundle.bindingId.startsWith("surface.creative_event.speech."));
  const publication = compileCreativeEventSpeechGrammarPatterns({ eventBundles: state.importedConstructionBundles.filter(bundle => bundle.creativeEvents?.length),
    profileId: profile.id, evidence: [evidence], hasher, updatedAt: 1 });
  expect(publication.candidateCount).toBe(events.length);
  expect(publication.compiledCount).toBe(events.length);
  expect(publication.rejectionCodes).toEqual([]);
  expect(publication.patterns.map(pattern => pattern.id)).toEqual(speechPatterns.map(pattern => pattern.id));
  const firstEventBundle = state.importedConstructionBundles.find(bundle =>
    bundle.creativeEvents?.some(event => event.id === events[0]!.id))!;
  expect(() => compileCreativeEventSpeechGrammarPatterns({
    eventBundles: [{
      ...firstEventBundle,
      creativeEvents: [
        events[0]!,
        { ...events[0]!, sourceLabel: `${events[0]!.sourceLabel} conflict` }
      ]
    }],
    profileId: profile.id,
    evidence: [evidence],
    hasher,
    updatedAt: 1
  })).toThrow(`conflicting duplicate event id ${events[0]!.id}`);
  expect(speechPatterns.length).toBe(speechBundles.length);
  expect(speechBundles.length).toBeLessThan(events.length);
  expect(speechBundles.every(bundle => bundle.sourceExamples.length > 0 && bundle.sourceExamples.length <= 256)).toBe(true);
  expect(speechBundles.reduce((sum, bundle) => sum + bundle.sourceExamples.length, 0)).toBe(events.length);
  if (process.env.SCCE_REPORT_CREATIVE_PUBLICATION === "1") process.stdout.write(JSON.stringify({
    schema: "scce.creative_event.speech_grammar_fixture_measurement.v1",
    events: events.length,
    eventPagePatterns: pages.length,
    speechPatterns: speechPatterns.length,
    durableSpeechPatternCanonicalBytes: Buffer.byteLength(canonicalStringify(speechPatterns)),
    decodedSpeechBundleCanonicalBytes: Buffer.byteLength(canonicalStringify(speechBundles))
  }) + "\n");
  const frame = compileCreativeRequestFrameFromCompatibilityModels({ requestText: human.turns[0]!.surface, models: state.creativeEventCompatibilityModels, hasher });
  expect(frame?.arguments.length).toBeGreaterThan(0);
  expect(state.creativeEventCompatibilityModels.some(model => model.sourceObservations?.some(row => row.reply.start === human.turns[1]!.startCodePoint))).toBe(true);

  // An event page alone is cognitive event data, not an executable language
  // capability. The separately published evidence-owned grammar is required.
  const eventOnly = createLanguageMemoryRuntime({ hasher }).hydrate({ models: [], patterns: JSON.parse(JSON.stringify(pages)), constructionEvidence: [evidence] });
  const eventOnlyEvents = eventOnly.importedConstructionBundles.flatMap(bundle => bundle.creativeEvents ?? []);
  const noSpeech = createCreativeEventSpeechGrammarIndex(eventOnly.importedConstructionBundles);
  expect(eventOnlyEvents.length).toBe(events.length);
  expect(eventOnlyEvents.every(event => noSpeech.forEvent(event).length === 0)).toBe(true);

  const revoked = createLanguageMemoryRuntime({ hasher }).hydrate({ models: [], patterns: JSON.parse(JSON.stringify(compiled.patterns)),
    constructionEvidence: [{ ...evidence, status: "quarantined" }] });
  expect(revoked.importedConstructionBundles.flatMap(bundle => bundle.creativeEvents ?? [])).toEqual([]);
  expect(revoked.creativeEventCompatibilityModels).toEqual([]);
});
