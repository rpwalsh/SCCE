import { describe, expect, it } from "vitest";
import { createIdFactory } from "../ids.js";
import { createClock, createHasher, featureSet } from "../primitives.js";
import { createTranslationEngine } from "../translation.js";
import type { EvidenceSpan, JsonValue, LanguageProfile } from "../types.js";

describe("translation target evidence admission", () => {
  it("matches an exact target language id while retaining its language profile", () => {
    const evidence = span("evidence.es", "Pump alpha está estable.", { language: "lang.es" }, { script: "Latin" });
    const target = profile("lang.es", "Latin");
    evidence.sourceVersionId = target.sourceVersionId;
    const plan = engine().plan({
      text: "Pump alpha is stable.",
      targetLanguage: "lang.es",
      evidence: [evidence],
      profiles: [target],
      createdAt: 1
    });

    expect(plan.targetFrames.length).toBeGreaterThan(0);
    expect(plan.targetFrames.flatMap(frame => frame.evidenceIds)).toContain(String(evidence.id));
    expect(plan.targetLanguage).toBe("lang.es");
    expect(plan.emission.text).toBe(evidence.text);
  });

  it("admits promoted target-language evidence without requiring a language profile", () => {
    const evidence = span("evidence.profileless", "Superficie Exacta.", { language: "lang.profileless" }, { script: "Latin" });
    const plan = engine().plan({
      text: "Exact surface.",
      targetLanguage: "LANG.PROFILELESS",
      evidence: [evidence],
      profiles: [],
      createdAt: 1
    });

    expect(plan.targetProfile).toBeUndefined();
    expect(plan.targetFrames.length).toBeGreaterThan(0);
    expect(plan.targetFrames[0]?.frameJson).toMatchObject({ sourceVersionId: evidence.sourceVersionId });
    expect(plan.targetFrames[0]?.frameJson).not.toHaveProperty("profileId");
  });

  it("rejects quarantined evidence and mismatched language hints", () => {
    const target = profile("lang.admission", "Latin");
    const quarantined = span("evidence.quarantined", "Superficie en cuarentena.", { language: target.id }, { script: "Latin" });
    quarantined.sourceVersionId = target.sourceVersionId;
    quarantined.status = "quarantined";
    const mismatched = span("evidence.mismatched", "Superficie de otra lengua.", { language: "lang.other" }, { script: "Latin" });
    const plan = engine().plan({
      text: "Admission surface.",
      targetLanguage: target.id,
      evidence: [quarantined, mismatched],
      profiles: [target],
      createdAt: 1
    });

    expect(plan.targetFrames).toHaveLength(0);
    expect(plan.force).toBe("unknown");
  });

  it("keeps language-hint evidence source-owned when an unrelated target profile is selected", () => {
    const target = profile("lang.owned", "Latin");
    const evidence = span("evidence.source-owned", "Superficie con propietario de origen.", { language: target.id }, { script: "Latin" });
    const plan = engine().plan({
      text: "Source-owned surface.",
      targetLanguage: target.id,
      evidence: [evidence],
      profiles: [target],
      createdAt: 1
    });

    expect(plan.targetProfile?.id).toBe(target.id);
    expect(plan.targetFrames[0]?.frameJson).toMatchObject({ sourceVersionId: evidence.sourceVersionId });
    expect(plan.targetFrames[0]?.frameJson).not.toHaveProperty("profileId");
  });

  it("preserves exact case and punctuation across multiple target semantic windows", () => {
    const targetText = "Primera Frase conserva MAYÚSCULAS y puntuación. Segunda Frase mantiene CamelCase y el número 42. Tercera Frase termina con Exactitud.";
    const evidence = span("evidence.multi-window", targetText, { language: "lang.multi" }, { script: "Latin" });
    const plan = engine().plan({
      text: "First statement remains exact. Second statement keeps its number 42. Third statement ends clearly.",
      targetLanguage: "lang.multi",
      evidence: [evidence],
      profiles: [],
      createdAt: 1
    });

    expect(plan.targetFrames.map(frame => frame.text)).toEqual([
      "Primera Frase conserva MAYÚSCULAS y puntuación.",
      "Segunda Frase mantiene CamelCase y el número 42.",
      "Tercera Frase termina con Exactitud."
    ]);
    expect(plan.targetFrames.every(frame => targetText.includes(frame.text))).toBe(true);
  });

  it("preserves target surfaces for a no-whitespace script", () => {
    const targetText = "第一の文は静かです。第二の文は明るいです！第三の文も続きます。";
    const evidence = span("evidence.no-whitespace", targetText, { language: "lang.no-whitespace" }, { script: "Hani" });
    const plan = engine().plan({
      text: "The first sentence is quiet. The second is bright. A third continues.",
      targetLanguage: "lang.no-whitespace",
      evidence: [evidence],
      profiles: [],
      createdAt: 1
    });

    expect(plan.targetFrames.map(frame => frame.text)).toEqual([
      "第一の文は静かです。",
      "第二の文は明るいです！",
      "第三の文も続きます。"
    ]);
    expect(plan.targetFrames.map(frame => frame.text).join("")).toBe(targetText);
    expect(plan.targetFrames.every(frame => !frame.text.includes(" "))).toBe(true);
  });

  it("does not admit target evidence from a matching script alone", () => {
    const evidence = span("evidence.script", "Pump alpha está estable.", {}, { script: "latin" });
    const plan = engine().plan({
      text: "Pump alpha is stable.",
      targetLanguage: "lang.script-fixture",
      evidence: [evidence],
      profiles: [profile("lang.script-fixture", "LaTiN")],
      createdAt: 1
    });

    expect(plan.targetFrames).toHaveLength(0);
    expect(plan.force).toBe("unknown");
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

  it("does not arbitrarily select a zero-score target profile", () => {
    const plan = engine().plan({
      text: "Pump alpha is stable.",
      targetLanguage: "opaque.target.absent",
      evidence: [],
      profiles: [profile("opaque.one", "Latin"), profile("opaque.two", "Cyrl")],
      createdAt: 1
    });

    expect(plan.targetProfile).toBeUndefined();
    expect(plan.targetCluster).toBeUndefined();
    expect(plan.targetSelection).toBeUndefined();
    expect(plan.targetLanguage).toBe("opaque.target.absent");
  });

  it("selects an exact source-derived discovered name with evidence", () => {
    const target = profile("opaque.profile", "Latin");
    target.discoveredNames = [{ surface: "Nerali", evidenceRefs: ["evidence.target"], confidence: 0.9 }];
    const evidence = span("evidence.target", "Nerali surface material.", {}, { script: "latin" });
    evidence.sourceVersionId = target.sourceVersionId;
    const plan = engine().plan({
      text: "Surface material.",
      targetLanguage: "nerali",
      evidence: [evidence],
      profiles: [target],
      createdAt: 1
    });

    expect(plan.targetProfile?.id).toBe(target.id);
    expect(plan.targetSelection).toMatchObject({ basis: "evidence_alias", score: 0.9, evidenceRefs: ["evidence.target"] });
    expect(plan.targetFrames.length).toBeGreaterThan(0);
    expect(plan.targetFrames[0]?.frameJson).toMatchObject({ profileId: target.id, sourceVersionId: target.sourceVersionId });
  });

  it("exposes all compatible target-cluster members while preserving the exact requested profile", () => {
    const first = profile("opaque.member-a", "Latin");
    const second = profile("opaque.member-b", "Latin");
    const plan = engine().plan({
      text: "Surface material.",
      targetLanguage: second.id,
      evidence: [],
      profiles: [second, first],
      createdAt: 1
    });

    expect(plan.targetProfile?.id).toBe(second.id);
    expect(plan.targetCluster?.profileIds).toEqual([first.id, second.id]);
  });

  it("resolves an ordinary target alias owned by source metadata without inventing evidence refs", () => {
    const target = profile("opaque.source-alias", "Latin");
    target.discoveredNames = [{
      surface: "nerali-Latn",
      evidenceRefs: [],
      sourceVersionRefs: [target.sourceVersionId],
      confidence: 1
    }];
    const plan = engine().plan({
      text: "Surface material.",
      targetLanguage: "NERALI-latn",
      evidence: [],
      profiles: [target],
      createdAt: 1
    });

    expect(plan.targetProfile?.id).toBe(target.id);
    expect(plan.targetSelection).toMatchObject({
      basis: "source_alias",
      evidenceRefs: [],
      sourceVersionRefs: [target.sourceVersionId]
    });
    expect(plan.targetLanguage).toBe("nerali-latn");
  });

  it("leaves equally supported discovered-name clusters unresolved", () => {
    const first = profile("opaque.first", "Latin");
    const second = profile("opaque.second", "Cyrl");
    first.charNgrams = [{ ngram: "abc", count: 1 }];
    second.charNgrams = [{ ngram: "xyz", count: 1 }];
    first.discoveredNames = [{ surface: "Shared", evidenceRefs: ["evidence.first"], confidence: 0.8 }];
    second.discoveredNames = [{ surface: "Shared", evidenceRefs: ["evidence.second"], confidence: 0.8 }];
    const plan = engine().plan({
      text: "Surface material.",
      targetLanguage: "shared",
      evidence: [],
      profiles: [first, second],
      createdAt: 1
    });

    expect(plan.targetCluster).toBeUndefined();
    expect(plan.targetSelection).toBeUndefined();
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
