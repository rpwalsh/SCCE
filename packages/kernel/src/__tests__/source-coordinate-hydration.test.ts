// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { createUniversalCreativeEventConstructionCompiler, hydrateLanguageConstructionPatterns, CREATIVE_EVENT_CONSTRUCTION_PATTERN_SCHEMA } from "../language-construction-memory.js";
import { createHasher, createClock } from "../primitives.js";
import { createIdFactory } from "../ids.js";
import type { EvidenceSpan } from "../types.js";

describe("owned source coordinate reuse during hydration", () => {
  it("reads the real source once across all event pages and rechecks changed evidence on the next hydration", () => {
    const source = JSON.parse(readFileSync(new URL("./fixtures/dolly-human-creative-pair.json", import.meta.url), "utf8")) as { text: string };
    const hasher = createHasher();
    const ids = createIdFactory({ hasher, clock: createClock({ fixedTime: 1 }), deterministicReplay: true, namespace: "source-coordinate-reuse" });
    const text = source.text, sourceVersionId = ids.sourceVersionId(text), contentHash = ids.contentHash(text);
    const evidence: EvidenceSpan = { id: ids.evidenceId({ sourceVersionId, byteStart: 0, byteEnd: Buffer.byteLength(text), spanHash: contentHash }),
      sourceId: ids.sourceId("dialogue", "fixture://pinned-dolly/coordinate-reuse"), sourceVersionId,
      chunkId: ids.chunkId({ sourceVersionId, byteStart: 0, byteEnd: Buffer.byteLength(text), chunkHash: contentHash }), contentHash,
      mediaType: "text/plain", byteStart: 0, byteEnd: Buffer.byteLength(text), charStart: 0, charEnd: [...text].length,
      text, textPreview: text, languageHints: {}, scriptHints: {}, trustVector: {}, provenance: {}, features: [], status: "promoted", alpha: 1, observedAt: 1 };
    const compiled = createUniversalCreativeEventConstructionCompiler().compile({ profileId: "profile.source-coordinate-reuse", evidence: [evidence], hasher, updatedAt: 1, maxEvents: 64 });
    expect(compiled.status).toBe("compiled");
    if (compiled.status !== "compiled") return;
    const patterns = compiled.patterns ?? [compiled.pattern];
    const pages = patterns.filter(pattern => (pattern.patternJson as { schema?: string }).schema === CREATIVE_EVENT_CONSTRUCTION_PATTERN_SCHEMA);
    expect(pages.length).toBeGreaterThan(1);
    const iterate = String.prototype[Symbol.iterator];
    let sourceScans = 0;
    const iterator = vi.spyOn(String.prototype, Symbol.iterator).mockImplementation(function(this: string) {
      if (String(this) === text) sourceScans++;
      return iterate.call(this);
    });
    try {
      const hydrated = hydrateLanguageConstructionPatterns({ patterns, evidence: [evidence], hasher });
      expect(hydrated.rejected).toEqual([]);
      expect(hydrated.bundles).toHaveLength(pages.length);
      expect(hydrated.bundles.flatMap(bundle => bundle.creativeEvents ?? []).length).toBeGreaterThan(0);
      expect(sourceScans).toBe(1);
    } finally { iterator.mockRestore(); }
    const changed = hydrateLanguageConstructionPatterns({ patterns, evidence: [{ ...evidence, text: `#${text.slice(1)}` }], hasher });
    expect(changed.rejected.length).toBeGreaterThan(0);
  });
});
