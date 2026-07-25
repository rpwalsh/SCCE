import { describe, expect, it } from "vitest";
import { createHasher, createLanguageInductionEngine } from "../index.js";

describe("language induction -- morphology/agreement-constraint induction (Part B step 5)", () => {
  const hasher = createHasher();

  it("finds real agreement evidence: an induced suffix rule's inflected forms co-occurring in an independently-induced lexical class", () => {
    const engine = createLanguageInductionEngine({ hasher, vocabularyLimit: 512 });
    // "cats"/"dogs" are distributionally substitutable (same "the _ slept/ran"
    // context slots, proving a real lexical class); "birds" only exists to
    // give the "-s" suffix rule its required third stem. The binding under
    // test is the real cross-reference: does the plural suffix's example set
    // land inside the independently-induced class.
    const text = "the cats slept. the dogs slept. the cats ran. the dogs ran. the cats slept. the dogs ran. also birds fly.";

    const model = engine.induce({ documents: [{ id: "doc.agreement", text }] });

    const suffixRule = model.morphology.find(rule => rule.pattern === "STEM+s" && rule.examples.includes("cats") && rule.examples.includes("dogs"));
    expect(suffixRule).toBeDefined();

    const pluralClass = model.lexicalClasses.find(cls =>
      cls.members.some(member => member.symbol === "cats") && cls.members.some(member => member.symbol === "dogs")
    );
    expect(pluralClass).toBeDefined();

    const binding = model.morphologyClassBindings.find(item => item.ruleId === suffixRule!.id && item.lexicalClassId === pluralClass!.id);
    expect(binding).toBeDefined();
    expect(binding!.stemOverlap).toBeGreaterThanOrEqual(2);
    expect(binding!.ruleCoverage).toBeGreaterThan(0);
    expect(binding!.classCoverage).toBeGreaterThan(0);
    expect(binding!.confidence).toBeGreaterThan(0);
    expect(binding!.confidence).toBeLessThanOrEqual(1);
    expect(binding!.id).toContain("morphclass_");
  });

  it("does not fabricate a binding when the class and rule share fewer than two real overlapping forms", () => {
    const engine = createLanguageInductionEngine({ hasher, vocabularyLimit: 512 });
    // Same lexical-class-forming corpus as the step-4 tests, but with no
    // morphological affix pattern present at all (all candidate words are
    // below the length-4 floor `induceMorphology` requires).
    const text = "the cat sat. the dog sat. the cat ran. the dog ran. the cat sat. the dog ran.";

    const model = engine.induce({ documents: [{ id: "doc.no-affix", text }] });

    expect(model.morphology).toEqual([]);
    expect(model.morphologyClassBindings).toEqual([]);
  });

  it("keeps morphology-class binding additive: it does not change morphology rules or lexical classes themselves", () => {
    const engine = createLanguageInductionEngine({ hasher, vocabularyLimit: 512 });
    const text = "the cats slept. the dogs slept. the cats ran. the dogs ran. the cats slept. the dogs ran. also birds fly.";

    const model = engine.induce({ documents: [{ id: "doc.additive", text }] });

    expect(model.morphology.length).toBeGreaterThan(0);
    expect(model.lexicalClasses.length).toBeGreaterThan(0);
    expect(Array.isArray(model.morphologyClassBindings)).toBe(true);
    for (const binding of model.morphologyClassBindings) {
      expect(model.morphology.some(rule => rule.id === binding.ruleId)).toBe(true);
      expect(model.lexicalClasses.some(cls => cls.id === binding.lexicalClassId)).toBe(true);
    }
  });
});
