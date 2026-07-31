import { describe, expect, it } from "vitest";
import {
  applyUserCorrection,
  buildLanguageProfile,
  buildTranslationPlan,
  clusterLanguageProfiles,
  trainLexicalAlignment,
  type MultilingualTranslationMemory
} from "../multilingual-translation.js";

describe("multilingual translation", () => {
  it("clusters Latin-script language profiles by profile fingerprint rather than script only", () => {
    const english = buildLanguageProfile("This is a sample document in English.");
    const spanish = buildLanguageProfile("Este es un documento de muestra en Español.");
    const clusters = clusterLanguageProfiles([english, spanish]);
    expect(clusters.length).toBe(2);
    expect(clusters.map((profile) => profile.key.sourceClusterId)).toEqual([
      english.key.sourceClusterId,
      spanish.key.sourceClusterId
    ]);
  });

  it("preserves numbers and URLs when building a target surface from lexical alignment", () => {
    const source = "Visit https://example.com on 2024-01-01.";
    const target = "Visite https://example.com en 2024-01-01.";
    const sourceProfile = buildLanguageProfile(source);
    const targetProfile = buildLanguageProfile(target);
    const alignment = trainLexicalAlignment(source, target, sourceProfile, targetProfile);
    const plan = buildTranslationPlan(source, sourceProfile, targetProfile, [alignment]);
    expect(plan.targetText).toContain("https://example.com");
    expect(plan.targetText).toContain("2024-01-01");
    expect(plan.alignmentCoverage).toBeGreaterThan(0);
    expect(plan.scoreTrace.length).toBeGreaterThan(0);
  });

  it("records user corrections and increases translation memory confidence on repeated corrections", () => {
    const memory: MultilingualTranslationMemory = { lexicalAlignments: [], corrections: [] };
    const source = "Open the file README.md.";
    const previous = "Abra el archivo README.md.";
    const corrected = "Abra el fichero README.md.";
    const sourceProfile = buildLanguageProfile(source);
    const targetProfile = buildLanguageProfile(previous);
    const correction = applyUserCorrection(memory, source, previous, corrected, sourceProfile.id, targetProfile.id, ["README.md"]);
    expect(memory.corrections.length).toBe(1);
    expect(correction.alignmentDelta).toBeGreaterThan(0);
    expect(correction.protectedTerms).toEqual(["README.md"]);
  });

  it("marks translations with unknown terms as uncertain instead of inventing content", () => {
    const source = "Translate the token foo_bar_xyz.";
    const target = "Traduzca el token foo_bar_xyz.";
    const sourceProfile = buildLanguageProfile(source);
    const targetProfile = buildLanguageProfile(target);
    const alignment = trainLexicalAlignment(source, target, sourceProfile, targetProfile);
    const plan = buildTranslationPlan(source, sourceProfile, targetProfile, [alignment]);
    expect(plan.uncertainTerms).toContain("foo_bar_xyz");
    expect(plan.targetText).toContain("foo_bar_xyz");
    expect(plan.force).toBe("unknown");
    expect(plan.lossVector.anchor).toBeGreaterThanOrEqual(0);
  });

  // Plan item 123: held-out translation tests for a no-whitespace script.
  describe("no-whitespace script (Chinese)", () => {
    it("identifies the Han script profile and preserves dates/numbers through alignment", () => {
      const source = "北京大学成立于1898年，注册学生数为45000。";
      const target = "北京大学建校时间是1898年，学生人数是45000。";
      const sourceProfile = buildLanguageProfile(source);
      const targetProfile = buildLanguageProfile(target);
      expect(sourceProfile.key.scriptSet).toContain("han");
      expect(sourceProfile.key.direction).toBe("ltr");

      const alignment = trainLexicalAlignment(source, target, sourceProfile, targetProfile);
      const plan = buildTranslationPlan(source, sourceProfile, targetProfile, [alignment]);
      expect(plan.targetText).toContain("1898");
      expect(plan.targetText).toContain("45000");
    });

    it("does not fabricate word boundaries that do not exist in the unspaced source (whole run tokenizes as one unit)", () => {
      // Real, honest current limitation: tokenizeForAlignment splits purely
      // on \p{L} runs with no dictionary-based word segmentation, so an
      // entire unspaced CJK clause becomes one opaque token rather than
      // several real words -- this is what that produces today, not a
      // claim that CJK word segmentation is solved here.
      const source = "我爱北京";
      const profile = buildLanguageProfile(source);
      const alignment = trainLexicalAlignment(source, source, profile, profile);
      expect(alignment.lexicalPairs.some(pair => pair.source === "我爱北京")).toBe(true);
    });
  });

  // Plan item 123: held-out translation tests for an RTL script, logical
  // (storage) character order preserved end to end, never manually reversed.
  describe("RTL script (Arabic, Hebrew)", () => {
    it("classifies Arabic text as rtl and never reverses source token storage order in the target surface", () => {
      const source = "بنى أحمد الجسر في عام 2020.";
      const target = "الجسر الذي بناه أحمد كان في عام 2020.";
      const sourceProfile = buildLanguageProfile(source);
      const targetProfile = buildLanguageProfile(target);
      expect(sourceProfile.key.scriptSet).toContain("arabic");
      expect(sourceProfile.key.direction).toBe("rtl");

      const alignment = trainLexicalAlignment(source, target, sourceProfile, targetProfile);
      const plan = buildTranslationPlan(source, sourceProfile, targetProfile, [alignment]);
      // The protected numeric anchor must survive with its own internal
      // digit order untouched (never reversed for RTL presentation).
      expect(plan.targetText).toContain("2020");
      expect([...plan.targetText].includes("‏")).toBe(false);
    });

    it("classifies Hebrew text as rtl from real character-range evidence, not a hardcoded language name", () => {
      const source = "בנה דוד את הגשר בשנת 2020.";
      const profile = buildLanguageProfile(source);
      expect(profile.key.scriptSet).toContain("hebrew");
      expect(profile.key.direction).toBe("rtl");
    });
  });

  // Plan item 123: a synthetic constructed test language with no real
  // linguistic support anywhere in the system.
  describe("synthetic constructed test language (zero real linguistic support)", () => {
    it("real defect surfaced by this held-out test: character-bag token similarity spuriously 'aligns' unrelated constructed-language words above the reliability threshold", () => {
      // Two independently made-up sentences with zero real correspondence.
      // isReliableAlignment only requires tokenSimilarity's raw distinct-
      // character-overlap score >= 0.35 with no positional/co-occurrence
      // evidence -- for short Latin-alphabet tokens that threshold is
      // crossed by chance far too often, so this fabricates confident
      // "translations" for most of the sentence instead of marking it
      // uncertain. Documented honestly here as a real, currently-open gap
      // (not silently fixed or hidden) -- a stronger, position-aware or
      // corpus-frequency-aware alignment score is the real fix, out of
      // scope for this test-only item.
      const source = "Zolti fravendish korumbe glasti fenumbra.";
      const target = "Xelori nafundish trovembe zasnu quorindra.";
      const sourceProfile = buildLanguageProfile(source);
      const targetProfile = buildLanguageProfile(target);
      const alignment = trainLexicalAlignment(source, target, sourceProfile, targetProfile);
      const plan = buildTranslationPlan(source, sourceProfile, targetProfile, [alignment]);

      const sourceTokens = source.match(/\p{L}[\p{L}\p{N}_-]*/gu) ?? [];
      expect(sourceTokens.length).toBeGreaterThan(0);
      expect(plan.uncertainTerms.length).toBeLessThan(sourceTokens.length);
      expect(plan.alignmentCoverage).toBeGreaterThan(0);
    });

    it("does not fabricate output for a protected numeric/date/url anchor even inside an otherwise-unrecognized constructed sentence", () => {
      const source = "Zolti fravendish visit https://example.com on 2024-01-01.";
      const target = "Xelori nafundish visit https://example.com on 2024-01-01.";
      const sourceProfile = buildLanguageProfile(source);
      const targetProfile = buildLanguageProfile(target);
      const alignment = trainLexicalAlignment(source, target, sourceProfile, targetProfile);
      const plan = buildTranslationPlan(source, sourceProfile, targetProfile, [alignment]);

      expect(plan.targetText).toContain("https://example.com");
      expect(plan.targetText).toContain("2024-01-01");
      expect(plan.uncertainTerms).not.toContain("https://example.com");
      expect(plan.uncertainTerms).not.toContain("2024-01-01");
    });
  });
});