// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import * as induction from "../language-induction.js";
import { createUniversalCreativeEventConstructionCompiler, CREATIVE_EVENT_CONSTRUCTION_PATTERN_SCHEMA, compileUniversalCreativeEventConstructionPattern } from "../language-construction-memory.js";
import { prepareConstructionInduction, sourceLanguageInductionDocuments } from "../graph-surface-alignment.js";
import { compileCreativeSourceCorrespondences } from "../creative-source-correspondence.js";
import { createLanguageMemoryRuntime } from "../language-memory-runtime.js";
import { createLanguageAcquisitionEngine } from "../language.js";
import { validateDeclaredTranscriptSource } from "../dialogue-communicative-act-learning.js";
import { compileCreativeRequestFrameFromCompatibilityModels, creativeEventCompatibilityDecision } from "../creative-event-compatibility.js";
import { createClock, createHasher } from "../primitives.js";
import { createIdFactory } from "../ids.js";
import type { EvidenceSpan } from "../types.js";

const human = validateDeclaredTranscriptSource(JSON.parse(readFileSync(new URL("./fixtures/dolly-human-window-160-193.json", import.meta.url), "utf8")))!;

describe("complete bounded creative source-event coverage", () => {
  it("reuses all prepared windows and rebinds a real late human pair after every page is persisted", () => {
    const hasher = createHasher();
    const ids = createIdFactory({ hasher, clock: createClock({ fixedTime: 1 }), deterministicReplay: true, namespace: "late-human-source" });
    const sourceVersionId = ids.sourceVersionId(human.text), contentHash = ids.contentHash(human.text);
    const evidence: EvidenceSpan = { id: ids.evidenceId({ sourceVersionId, byteStart: 0, byteEnd: Buffer.byteLength(human.text), spanHash: contentHash }),
      sourceId: ids.sourceId("dialogue", "fixture://pinned-dolly/through-193"), sourceVersionId,
      chunkId: ids.chunkId({ sourceVersionId, byteStart: 0, byteEnd: Buffer.byteLength(human.text), chunkHash: contentHash }), contentHash,
      mediaType: "text/plain", byteStart: 0, byteEnd: Buffer.byteLength(human.text), charStart: 0, charEnd: [...human.text].length,
      text: human.text, textPreview: human.text, languageHints: {}, scriptHints: {}, trustVector: {}, provenance: {}, features: [], status: "promoted", alpha: 1, observedAt: 1 };
    const profile = createLanguageAcquisitionEngine({ idFactory: ids }).acquire({ sourceVersionId, text: human.text, createdAt: 1 });
    const engine = vi.spyOn(induction, "createLanguageInductionEngine");
    try {
      const prepared = prepareConstructionInduction({ documents: sourceLanguageInductionDocuments([evidence]), hasher });
      const calls = engine.mock.calls.length;
      const compiler = createUniversalCreativeEventConstructionCompiler();
      const input = { profileId: profile.id, evidence: [evidence], hasher, updatedAt: 1, preparedInduction: prepared };
      const bounded = compileUniversalCreativeEventConstructionPattern(input);
      const complete = compiler.compile(input);
      expect(engine).toHaveBeenCalledTimes(calls);
      expect(complete.status).toBe("compiled");
      if (complete.status !== "compiled" || bounded.status !== "compiled") return;
      const pages = complete.patterns?.filter(pattern => (pattern.patternJson as { schema?: string }).schema === CREATIVE_EVENT_CONSTRUCTION_PATTERN_SCHEMA) ?? [complete.pattern];
      const teacher = human.turns.at(-2)!;
      expect(bounded.bundle.creativeEvents?.every(event => event.sourceOrdinal < teacher.startCodePoint)).toBe(true);
      expect(pages.length).toBeGreaterThan(1);
      const events = complete.bundles!.flatMap(bundle => bundle.creativeEvents ?? []);
      expect(new Set(events.map(event => event.id)).size).toBe(events.length);
      expect(complete.bundles!.every(bundle => (bundle.creativeEvents?.length ?? 0) >= 4 && (bundle.creativeEvents?.length ?? 0) <= 768)).toBe(true);
      expect(events.some(event => event.sourceOrdinal > teacher.endCodePoint)).toBe(true);
      const repeatedIds = (() => { const repeated = compiler.compile(input); return repeated.status === "compiled" ? repeated.patterns?.map(pattern => pattern.id) : []; })();
      expect(repeatedIds).toEqual(complete.patterns!.map(pattern => pattern.id));
      expect(complete.coverage).toMatchObject({ complete: true, observedEvents: events.length,
        sourceInduction: { complete: true, inputUtf16Length: human.text.length, coveredUtf16Length: human.text.length } });
      expect(engine).toHaveBeenCalledTimes(calls);
      const correspondence = compileCreativeSourceCorrespondences({ turns: human.turns, evidence: [evidence], events, hasher, profileId: profile.id, updatedAt: 1 });
      expect(engine).toHaveBeenCalledTimes(calls);
      const restored = createLanguageMemoryRuntime({ hasher }).hydrate({ models: [], patterns: JSON.parse(JSON.stringify([...complete.patterns!, ...correspondence])), constructionEvidence: [evidence] });
      const model = restored.creativeEventCompatibilityModels.find(model => model.sourceObservations?.some(row => row.request.surface === teacher.surface));
      expect(model).toBeDefined();
      const frame = compileCreativeRequestFrameFromCompatibilityModels({ requestText: teacher.surface, models: [model!], hasher });
      expect(frame?.arguments.length).toBeGreaterThan(0);
      const slot = frame!.arguments[0]!.span;
      const points = [...teacher.surface];
      points.splice(slot.charStart, slot.charEnd - slot.charStart, "κάλυ月");
      const fresh = compileCreativeRequestFrameFromCompatibilityModels({ requestText: points.join(""), models: [model!], hasher });
      expect(fresh?.arguments[0]?.span.text).toBe("κάλυ月");
      const lateEvents = restored.importedConstructionBundles.flatMap(bundle => bundle.creativeEvents ?? []).filter(event => event.sourceOrdinal > teacher.endCodePoint);
      expect(lateEvents.some(event => creativeEventCompatibilityDecision([model!], fresh!, event)?.qualification === "source_observed")).toBe(true);
      const altered = { ...evidence, text: evidence.text.slice(0, -1) + "?" };
      const invalid = createLanguageMemoryRuntime({ hasher }).hydrate({ models: [], patterns: JSON.parse(JSON.stringify(pages)), constructionEvidence: [altered] });
      const sourcePage = (pages.at(-1)!.patternJson as any).bundle.sourcePage;
      const lastWindow = sourcePage.windows.at(-1);
      const tailStart = [...human.text.slice(0, lastWindow.startUtf16)].length;
      expect(invalid.importedConstructionBundles.flatMap(bundle => bundle.creativeEvents ?? []).every(event => event.sourceOrdinal < tailStart)).toBe(true);
      expect(invalid.importedConstructionBundles.length).toBeGreaterThan(0);
    } finally { engine.mockRestore(); }
  }, 120_000);
});
