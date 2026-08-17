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

  it("uses real induced cross-lingual seed correspondence to prefer the target frame that actually shares the source's content over an otherwise near-identical distractor", () => {
    const target = profile("lang.seed-corroborated", "Latin");
    // Both candidates are structurally near-identical Spanish sentences --
    // they differ only in which number they carry. Only "48291" also occurs
    // in the source text, so only the matching frame gets real cross-lingual
    // corroboration; ordinary embedding/feature similarity alone has no
    // principled way to prefer one over the other.
    const matching = span("evidence.seed-match", "48291 aparece en el informe de ayer.", { language: target.id }, { script: "Latin" });
    matching.sourceVersionId = target.sourceVersionId;
    const distractor = span("evidence.seed-distractor", "99999 aparece en el informe de ayer.", { language: target.id }, { script: "Latin" });
    distractor.sourceVersionId = target.sourceVersionId;

    const plan = engine().plan({
      text: "Invoice number 48291 needs review today.",
      targetLanguage: target.id,
      evidence: [matching, distractor],
      profiles: [target],
      createdAt: 1
    });

    const matchingFrame = plan.targetFrames.find(frame => frame.text.includes("48291"));
    const distractorFrame = plan.targetFrames.find(frame => frame.text.includes("99999"));
    expect(matchingFrame).toBeDefined();
    expect(distractorFrame).toBeDefined();

    const alignment = plan.alignments.find(row => row.targetFrameId);
    expect(alignment).toBeDefined();
    expect(alignment!.targetFrameId).toBe(matchingFrame!.id);
    expect(alignment!.targetFrameId).not.toBe(distractorFrame!.id);
    expect((alignment!.audit as Record<string, JsonValue>).seedOverlap).toBeGreaterThan(0);
  });

  it("substitutes real seed-mapped terms into a bracketed gloss reference instead of leaving it purely source-language, only when a real seed clears the confidence bar", () => {
    const target = profile("lang.gloss-seed", "Latin");
    const evidence = span("evidence.gloss-seed", "48291 aparece en el informe meteorológico de ayer.", { language: target.id }, { script: "Latin" });
    evidence.sourceVersionId = target.sourceVersionId;
    const plan = engine().plan({
      text: "Invoice number 48291 needs review today.",
      targetLanguage: target.id,
      evidence: [evidence],
      profiles: [target],
      createdAt: 1
    });

    const alignment = plan.alignments.find(row => row.targetFrameId)!;
    expect(alignment).toBeDefined();
    if (alignment.force === "gloss") {
      const unit = plan.emission.units.find(row => row.sourceFrameId === alignment.sourceFrameId)!;
      expect(unit.text).toContain("48291");
    }
  });

  it("rejects a translation that drops a real source number, downgrading force to unknown instead of shipping lossy output", () => {
    const evidence = span(
      "evidence.number-drop",
      "The pump alpha unit continues to operate normally today and remains fully stable during the routine test cycle.",
      { language: "lang.number-drop" },
      { script: "Latin" }
    );
    const target = profile("lang.number-drop", "Latin");
    evidence.sourceVersionId = target.sourceVersionId;
    const plan = engine().plan({
      text: "The pump alpha unit continues to operate normally today at 47 units and remains fully stable during the routine test cycle.",
      targetLanguage: target.id,
      evidence: [evidence],
      profiles: [target],
      createdAt: 1
    });

    // The per-frame alignments genuinely resolve with real "direct"/
    // "approximate" force and high preservation (0.76 / 0.68) against real
    // target evidence -- proving this is not the pre-existing "no alignment
    // found" unknown-force path. The target evidence text is a faithful
    // match for everything except the number, which it genuinely lacks.
    expect(plan.alignments.length).toBeGreaterThan(0);
    for (const alignment of plan.alignments) {
      expect(["direct", "approximate"]).toContain(alignment.force);
    }

    // Item 125's gate: a real required number ("47") is missing from the
    // rendered translation, so preservationValidation.valid is false and
    // blockingMissing names it -- and that must actually reject the output
    // (force downgraded to "unknown", emission text emptied) rather than
    // silently shipping the lossy translation.
    expect(plan.construct.preservationValidation.valid).toBe(false);
    expect(plan.construct.preservationValidation.missingNumbers).toContain("47");
    expect(plan.construct.preservationValidation.blockingMissing).toContain("47");
    expect(plan.force).toBe("unknown");
    expect(plan.emission.text).toBe("");
    expect(plan.construct.translatedText).toBe("");
    expect(plan.construct.force).toBe("unknown");
  });

  it("detects a required entity in an uncased non-Latin script the same way it would a capitalized Latin one", () => {
    const koreanEvidence = span("evidence.korean-entity", "세종대왕은 한글을 창제했다.", { language: "lang.korean-entity" }, { script: "Hangul" });
    const koreanTarget = profile("lang.korean-entity", "Hangul");
    koreanEvidence.sourceVersionId = koreanTarget.sourceVersionId;
    const koreanPlan = engine().plan({
      text: "세종대왕은 한글을 창제했다.",
      targetLanguage: koreanTarget.id,
      evidence: [koreanEvidence],
      profiles: [koreanTarget],
      createdAt: 1
    });
    // A Latin-only `[A-Z]` regex would find zero entities in an all-Hangul
    // source -- the real, production script-aware detector (the same
    // hasUncasedNonLatinLetter signal answer-emitter.ts/local-evidence-
    // runtime.ts already use live) must still flag the real named subject.
    expect(koreanPlan.construct.preservationValidation.requiredEntities.length).toBeGreaterThan(0);
    expect(koreanPlan.construct.preservationValidation.requiredEntities.some(term => term.includes("세종대왕"))).toBe(true);
  });

  it("does not treat an ordinary abbreviation like a required code symbol, so it never blocks an otherwise faithful translation", () => {
    const evidence = span(
      "evidence.abbreviation",
      "The pump alpha unit continues to operate normally today within spec and remains fully stable during the routine test cycle.",
      { language: "lang.abbreviation" },
      { script: "Latin" }
    );
    const target = profile("lang.abbreviation", "Latin");
    evidence.sourceVersionId = target.sourceVersionId;
    const plan = engine().plan({
      // Contains "e.g." -- structurally identical in shape to a dotted code
      // identifier, but it is ordinary prose, not something the rendered
      // translation is obligated to reproduce verbatim.
      text: "The pump alpha unit continues to operate normally today, e.g. within spec, and remains fully stable during the routine test cycle.",
      targetLanguage: target.id,
      evidence: [evidence],
      profiles: [target],
      createdAt: 1
    });

    expect(plan.construct.preservationValidation.requiredCodesymbols).not.toContain("e.g.");
    expect(plan.construct.preservationValidation.blockingMissing).toEqual([]);
    expect(plan.construct.preservationValidation.valid).toBe(true);
    expect(plan.force).not.toBe("unknown");
    expect(plan.emission.text.length).toBeGreaterThan(0);
  });

  it("protects a code symbol regardless of its file extension, without relying on a hardcoded extension list", () => {
    const evidence = span(
      "evidence.arbitrary-extension",
      "The pump alpha unit continues to operate normally today and remains fully stable during the routine test cycle.",
      { language: "lang.arbitrary-extension" },
      { script: "Latin" }
    );
    const target = profile("lang.arbitrary-extension", "Latin");
    evidence.sourceVersionId = target.sourceVersionId;
    const plan = engine().plan({
      // ".rb" (Ruby) was never in the old fixed extension allowlist, yet
      // this is exactly as real a code symbol as "config.ts" was.
      text: "The pump alpha unit continues to operate normally today, per deploy.rb, and remains fully stable during the routine test cycle.",
      targetLanguage: target.id,
      evidence: [evidence],
      profiles: [target],
      createdAt: 1
    });

    expect(plan.construct.preservationValidation.requiredCodesymbols).toContain("deploy.rb");
    expect(plan.construct.preservationValidation.missingCodesymbols).toContain("deploy.rb");
    expect(plan.construct.preservationValidation.blockingMissing).toContain("deploy.rb");
    expect(plan.force).toBe("unknown");
    expect(plan.emission.text).toBe("");
  });

  it("protects a leading-dot dotfile (no identifier before the dot at all) the same as an extensioned filename", () => {
    const evidence = span(
      "evidence.dotfile",
      "The pump alpha unit continues to operate normally today and remains fully stable during the routine test cycle.",
      { language: "lang.dotfile" },
      { script: "Latin" }
    );
    const target = profile("lang.dotfile", "Latin");
    evidence.sourceVersionId = target.sourceVersionId;
    const plan = engine().plan({
      text: "The pump alpha unit continues to operate normally today, per .bashrc, and remains fully stable during the routine test cycle.",
      targetLanguage: target.id,
      evidence: [evidence],
      profiles: [target],
      createdAt: 1
    });

    expect(plan.construct.preservationValidation.requiredCodesymbols).toContain(".bashrc");
    expect(plan.construct.preservationValidation.blockingMissing).toContain(".bashrc");
    expect(plan.force).toBe("unknown");
    expect(plan.emission.text).toBe("");
  });

  it("plan item 121: a durable corpus-wide seed substitutes into the gloss even with zero of this request's own target evidence", () => {
    const plan = engine().plan({
      text: "Invoice number 48291 needs review today.",
      targetLanguage: "lang.durable-seed",
      evidence: [],
      profiles: [],
      durableSeeds: [{
        sourceSymbol: "invoice",
        targetSymbol: "factura",
        score: 0.9,
        basis: "shape",
        evidenceIds: []
      }],
      createdAt: 1
    });

    expect(plan.targetFrames.length).toBe(0);
    expect(plan.inducedSeeds.length).toBe(0);
    const glossUnit = plan.emission.units.find(unit => unit.force === "gloss");
    expect(glossUnit).toBeDefined();
    expect(glossUnit!.text.toLowerCase()).toContain("factura");
  });

  it("plan item 121: this request's own freshly-induced seeds are exposed for the caller to persist durably", () => {
    const target = profile("lang.gloss-seed-induced", "Latin");
    const evidence = span("evidence.gloss-seed-induced", "48291 aparece en el informe meteorológico de ayer.", { language: target.id }, { script: "Latin" });
    evidence.sourceVersionId = target.sourceVersionId;
    const plan = engine().plan({
      text: "Invoice number 48291 needs review today.",
      targetLanguage: target.id,
      evidence: [evidence],
      profiles: [target],
      createdAt: 1
    });

    expect(plan.inducedSeeds.length).toBeGreaterThan(0);
    expect(plan.inducedSeeds.some(seed => seed.sourceSymbol === "48291")).toBe(true);
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
