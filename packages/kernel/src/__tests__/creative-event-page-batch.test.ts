// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
import { readFileSync } from "node:fs";
import { expect, it } from "vitest";
import { validateDeclaredTranscriptSource } from "../dialogue-communicative-act-learning.js";
import { createUniversalCreativeEventConstructionCompiler, CREATIVE_EVENT_CONSTRUCTION_PATTERN_SCHEMA } from "../language-construction-memory.js";
import { compileLanguageTrainingBatch } from "../language-training-batch.js";
import { createLanguageMemoryRuntime } from "../language-memory-runtime.js";
import { createLanguageAcquisitionEngine } from "../language.js";
import { compileCreativeRequestFrameFromCompatibilityModels } from "../creative-event-compatibility.js";
import { createClock, createHasher } from "../primitives.js";
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
  const frame = compileCreativeRequestFrameFromCompatibilityModels({ requestText: human.turns[0]!.surface, models: state.creativeEventCompatibilityModels, hasher });
  expect(frame?.arguments.length).toBeGreaterThan(0);
  expect(state.creativeEventCompatibilityModels.some(model => model.sourceObservations?.some(row => row.reply.start === human.turns[1]!.startCodePoint))).toBe(true);
});
