import { describe, expect, it } from "vitest";
import {
  CREATIVE_EVENT_ARGUMENT_FRAME_SCHEMA,
  UNIVERSAL_CREATIVE_EVENT_COMPILER_ID,
  compileUniversalCreativeEventConstructionPattern,
  hydrateLanguageConstructionPatterns
} from "../language-construction-memory.js";
import { createClock, createHasher } from "../primitives.js";
import { createIdFactory } from "../ids.js";
import type { EvidenceSpan, JsonValue, SourceVersionId } from "../types.js";

const hasher = createHasher();
const clock = createClock({ fixedTime: 91_000, stepMs: 1 });
const ids = createIdFactory({ clock, hasher, deterministicReplay: true, namespace: "construction-memory-universal" });

describe("universal creative-event compiler (Part B step 7 -- zero hardcoded language)", () => {
  it("compiles real, evidence-traced events from repeated corpus structure with no per-language rule", () => {
    const text = [
      "cat chased mouse.", "dog chased mouse.", "cat chased ball.", "dog chased ball.",
      "cat chased mouse.", "dog chased ball.", "cat chased ball.", "dog chased mouse."
    ].join(" ");
    const evidence = evidenceSpan("source.univ", text, 0);

    const compiled = compileUniversalCreativeEventConstructionPattern({
      profileId: "profile.univ",
      evidence: [evidence],
      hasher,
      updatedAt: 91_500
    });

    expect(compiled.status).toBe("compiled");
    if (compiled.status !== "compiled") return;
    const hydrated = hydrateLanguageConstructionPatterns({ patterns: [compiled.pattern], evidence: [evidence], hasher });
    expect(hydrated.rejected).toEqual([]);
    const events = hydrated.bundles[0]?.creativeEvents ?? [];
    expect(events.length).toBeGreaterThanOrEqual(4);
    for (const event of events) {
      expect(event.compilerId).toBe(UNIVERSAL_CREATIVE_EVENT_COMPILER_ID);
      expect(event.forms.infinitive).toBe("chased");
      expect(event.argumentFrame.schema).toBe(CREATIVE_EVENT_ARGUMENT_FRAME_SCHEMA);
      expect(event.roleIds).toContain("scce.role.agent");
      // Real, evidence-traced offsets -- every binding's span must reproduce its own recorded surface.
      for (const binding of event.argumentFrame.bindings) {
        expect([...evidence.text].slice(binding.startCodePoint, binding.endCodePoint).join("")).toBe(binding.surface);
      }
    }
    // No source prose is ever embedded verbatim in the durable pattern.
    const persisted = (compiled.pattern.patternJson as Record<string, JsonValue>).bundle as Record<string, JsonValue>;
    expect(JSON.stringify(persisted)).not.toContain("cat chased mouse");
  });

  it("compiles equally well for a non-Latin script corpus with the same code path (no English, no per-language rule)", () => {
    // "cat chased mouse" / "dog chased mouse" analogue in Chinese, unspaced,
    // repeated with the same real-adjacency structure the compiler measures
    // directly from segmentUnicodeSurfaceV2 -- no script-specific branch.
    const text = "猫追老鼠。狗追老鼠。猫追球。狗追球。猫追老鼠。狗追球。猫追球。狗追老鼠。";
    const evidence = evidenceSpan("source.zh", text, 0);

    const compiled = compileUniversalCreativeEventConstructionPattern({
      profileId: "profile.zh",
      evidence: [evidence],
      hasher,
      updatedAt: 91_500
    });

    expect(compiled.status).toBe("compiled");
    if (compiled.status !== "compiled") return;
    const hydrated = hydrateLanguageConstructionPatterns({ patterns: [compiled.pattern], evidence: [evidence], hasher });
    expect(hydrated.rejected).toEqual([]);
    const events = hydrated.bundles[0]?.creativeEvents ?? [];
    expect(events.length).toBeGreaterThanOrEqual(4);
    expect(events.every(event => event.forms.infinitive === "追")).toBe(true);
  });

  it("does not fabricate a patient binding when no real adjacency evidence exists", () => {
    const text = "alpha bravo charlie delta echo foxtrot golf hotel.";
    const evidence = evidenceSpan("source.sparse", text, 0);

    const compiled = compileUniversalCreativeEventConstructionPattern({
      profileId: "profile.sparse",
      evidence: [evidence],
      hasher,
      updatedAt: 91_500
    });

    expect(compiled.status).toBe("rejected");
  });
});

function evidenceSpan(sourceVersionId: string, text: string, charStart: number): EvidenceSpan {
  const bytes = new TextEncoder().encode(text);
  const contentHash = ids.contentHash(bytes);
  const sourceId = ids.sourceId("fixture", `fixture://${sourceVersionId}`);
  return {
    id: ids.evidenceId({ sourceVersionId: sourceVersionId as SourceVersionId, byteStart: 0, byteEnd: bytes.byteLength, spanHash: contentHash }),
    sourceId,
    sourceVersionId: sourceVersionId as SourceVersionId,
    chunkId: ids.chunkId({ sourceVersionId: sourceVersionId as SourceVersionId, byteStart: 0, byteEnd: bytes.byteLength, chunkHash: contentHash }),
    contentHash,
    mediaType: "text/plain",
    byteStart: 0,
    byteEnd: bytes.byteLength,
    charStart,
    charEnd: charStart + [...text].length,
    text,
    textPreview: text,
    languageHints: {},
    scriptHints: {},
    trustVector: { forceClass: "profile_excerpt_evidence" },
    provenance: {},
    features: [],
    status: "promoted",
    alpha: 0.9,
    observedAt: 91_000
  };
}
