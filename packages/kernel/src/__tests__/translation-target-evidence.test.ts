import { describe, expect, it } from "vitest";
import { createIdFactory } from "../ids.js";
import { createClock, createHasher, featureSet } from "../primitives.js";
import { createTranslationEngine } from "../translation.js";
import type { EvidenceSpan, JsonValue, LanguageProfile } from "../types.js";

describe("translation target evidence admission", () => {
  it("matches an exact target language id while retaining its language profile", () => {
    const evidence = span("evidence.es", "Pump alpha está estable.", { language: "lang.es" }, { script: "Latin" });
    const plan = engine().plan({
      text: "Pump alpha is stable.",
      targetLanguage: "lang.es",
      evidence: [evidence],
      profiles: [profile("lang.es", "Latin")],
      createdAt: 1
    });

    expect(plan.targetFrames.length).toBeGreaterThan(0);
    expect(plan.targetFrames.flatMap(frame => frame.evidenceIds)).toContain(String(evidence.id));
    expect(plan.targetLanguage).toContain("profile:lang.es");
  });

  it("normalizes script case for the profile fallback", () => {
    const evidence = span("evidence.script", "Pump alpha está estable.", {}, { script: "latin" });
    const plan = engine().plan({
      text: "Pump alpha is stable.",
      targetLanguage: "lang.script-fixture",
      evidence: [evidence],
      profiles: [profile("lang.script-fixture", "LaTiN")],
      createdAt: 1
    });

    expect(plan.targetFrames.length).toBeGreaterThan(0);
    expect(plan.targetFrames.flatMap(frame => frame.evidenceIds)).toContain(String(evidence.id));
  });

  it("keeps unresolved target evidence on the unknown plan with gloss alignments", () => {
    const evidence = span("evidence.unmatched", "Pump alpha is stable.", {}, { script: "Latin" });
    const plan = engine().plan({
      text: "Pump alpha is stable.",
      targetLanguage: "lang.unmatched",
      evidence: [evidence],
      profiles: [profile("lang.unmatched", "Cyrl")],
      createdAt: 1
    });

    expect(plan.targetFrames).toHaveLength(0);
    expect(plan.force).toBe("unknown");
    expect(plan.alignments.every(alignment => alignment.force === "gloss")).toBe(true);
    expect(plan.emission.text).toBe("");
  });
});

function engine(): ReturnType<typeof createTranslationEngine> {
  const hasher = createHasher();
  return createTranslationEngine({
    hasher,
    idFactory: createIdFactory({
      clock: createClock({ fixedTime: 1 }),
      hasher,
      deterministicReplay: true
    })
  });
}

function profile(id: string, script: string): LanguageProfile {
  return {
    id,
    sourceVersionId: `source-version.${id}` as LanguageProfile["sourceVersionId"],
    scripts: [{ script, mass: 1 }],
    symbolShapes: [],
    charNgrams: [{ ngram: "est", count: 1 }],
    direction: "ltr",
    entropy: 0.1,
    createdAt: 1
  };
}

function span(id: string, text: string, languageHints: JsonValue, scriptHints: JsonValue): EvidenceSpan {
  return {
    id: id as EvidenceSpan["id"],
    sourceId: `source.${id}` as EvidenceSpan["sourceId"],
    sourceVersionId: `source-version.${id}` as EvidenceSpan["sourceVersionId"],
    chunkId: `chunk.${id}` as EvidenceSpan["chunkId"],
    contentHash: `hash.${id}` as EvidenceSpan["contentHash"],
    mediaType: "text/plain",
    byteStart: 0,
    byteEnd: new TextEncoder().encode(text).byteLength,
    charStart: 0,
    charEnd: text.length,
    text,
    textPreview: text,
    languageHints,
    scriptHints,
    trustVector: { trust: 0.9, forceClass: "direct_evidence" },
    provenance: { source: "translation-target-evidence.test" },
    features: featureSet(text, 256),
    status: "promoted",
    alpha: 0.9,
    observedAt: 1
  };
}
