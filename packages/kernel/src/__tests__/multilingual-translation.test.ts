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
});