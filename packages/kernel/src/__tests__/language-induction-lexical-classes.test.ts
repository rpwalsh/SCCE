import { describe, expect, it } from "vitest";
import { createHasher, createLanguageInductionEngine } from "../index.js";

describe("language induction -- distributional lexical-class induction (Part B step 4)", () => {
  const hasher = createHasher();

  it("clusters Latin words that are substitutable across shared left/right context slots", () => {
    const engine = createLanguageInductionEngine({ hasher, vocabularyLimit: 512 });
    const text = "the cat sat. the dog sat. the cat ran. the dog ran. the cat sat. the dog ran.";

    const model = engine.induce({ documents: [{ id: "doc.en", text }] });

    const petClass = model.lexicalClasses.find(cls =>
      cls.members.some(member => member.symbol === "cat") && cls.members.some(member => member.symbol === "dog")
    );
    expect(petClass).toBeDefined();
    expect(petClass!.cohesion).toBeGreaterThan(0);
    expect(petClass!.contextSupport).toBeGreaterThan(0);
    expect(petClass!.exampleContexts.length).toBeGreaterThan(0);
    expect(petClass!.exampleContexts.every(context => context.includes(" "))).toBe(true);
    expect(petClass!.id).toContain("lexclass_");
    for (const member of petClass!.members) {
      expect(member.scriptId).toBe("script:Latn");
      expect(member.count).toBeGreaterThanOrEqual(3);
    }
  });

  it("clusters real multi-character Chinese words from substitutable contexts instead of shattering them into single Han characters", () => {
    const engine = createLanguageInductionEngine({ hasher, vocabularyLimit: 512 });
    // "I go [Beijing/Shanghai]", subject/destination varied across six unspaced
    // sentences so each destination word accumulates real support (>=3
    // occurrences) across multiple distinct, partly-overlapping context slots.
    const text = "我去北京。他去上海。我们去北京。我去上海。他去北京。我们去上海。";

    const model = engine.induce({ documents: [{ id: "doc.zh", text }] });

    const cityClass = model.lexicalClasses.find(cls =>
      cls.members.some(member => member.symbol === "北京") && cls.members.some(member => member.symbol === "上海")
    );
    expect(cityClass).toBeDefined();
    // The whole point of building this on segmentation v2 rather than
    // symbolizeData(): members must be the real multi-character lexical
    // words, not individual Han graphemes.
    for (const member of cityClass!.members) {
      expect([...member.symbol].length).toBeGreaterThan(1);
      expect(member.scriptId).toBe("script:Hani");
    }
    expect(cityClass!.cohesion).toBeGreaterThan(0);
  });

  it("does not fabricate classes when no word repeats enough to provide real substitution evidence", () => {
    const engine = createLanguageInductionEngine({ hasher, vocabularyLimit: 512 });
    const text = "alpha bravo charlie delta echo foxtrot golf hotel.";

    const model = engine.induce({ documents: [{ id: "doc.sparse", text }] });

    expect(model.lexicalClasses).toEqual([]);
  });

  it("keeps lexical-class induction additive: syntax templates and n-grams are unaffected", () => {
    const engineBefore = createLanguageInductionEngine({ hasher, vocabularyLimit: 512 });
    const text = "the cat sat. the dog sat. the cat ran. the dog ran.";
    const model = engineBefore.induce({ documents: [{ id: "doc.regress", text }] });

    expect(model.ngrams.length).toBeGreaterThan(0);
    expect(model.syntaxTemplates.length).toBeGreaterThan(0);
    expect(Array.isArray(model.lexicalClasses)).toBe(true);
  });
});
