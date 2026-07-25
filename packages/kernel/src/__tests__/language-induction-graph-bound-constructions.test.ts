import { describe, expect, it } from "vitest";
import { createHasher, createLanguageInductionEngine } from "../index.js";

describe("language induction -- graph-bound variable-bearing construction induction (Part B step 6)", () => {
  const hasher = createHasher();

  it("binds a semantic frame's arg0 slot to the real semantic-graph relation vocabulary and a real induced lexical class", () => {
    const engine = createLanguageInductionEngine({ hasher, vocabularyLimit: 512 });
    // "cat"/"dog" are distributionally substitutable subjects (varying
    // determiner "the"/"a" gives each >=2 distinct, fully-overlapping context
    // slots, forming a real LexicalClass exactly as in the step-4 tests).
    // The fixed transitive frame "<det> <subj> chased <det> <obj>" reliably
    // selects "chased" as the frame predicate every time (long, centered
    // word beats the short, frequent determiner/subject/object candidates).
    const text = [
      "the cat chased the mouse.",
      "a cat chased the mouse.",
      "the cat chased the ball.",
      "a cat chased the ball.",
      "the dog chased the mouse.",
      "a dog chased the mouse.",
      "the dog chased the ball.",
      "a dog chased the ball."
    ].join(" ");

    const model = engine.induce({ documents: [{ id: "doc.frame", text }] });

    const frame = model.semanticFrames.find(item => item.predicate === "chased");
    expect(frame).toBeDefined();

    const pluralClass = model.lexicalClasses.find(cls =>
      cls.members.some(member => member.symbol === "cat") && cls.members.some(member => member.symbol === "dog")
    );
    expect(pluralClass).toBeDefined();

    const construction = model.graphBoundConstructions.find(item => item.frameId === frame!.id);
    expect(construction).toBeDefined();
    expect(construction!.predicate).toBe("chased");
    expect(construction!.predicateSemanticRole).toBe("predicate");
    expect(construction!.id).toContain("graphconstruct_");

    const arg0Slot = construction!.slots.find(slot => slot.roleId === "arg0");
    expect(arg0Slot).toBeDefined();
    expect(arg0Slot!.semanticRole).toBe("entity");
    // Mirrors semantic-graph.ts's relationFor(): entity -> predicate is "has_predicate".
    expect(arg0Slot!.relation).toBe("has_predicate");
    expect(arg0Slot!.relationDirection).toBe("source");
    expect(arg0Slot!.observedFillers).toContain("cat");
    expect(arg0Slot!.observedFillers).toContain("dog");
    // The whole point: this slot is variable-bearing because a real,
    // independently-induced lexical class (not an assumption) explains it.
    expect(arg0Slot!.lexicalClassId).toBe(pluralClass!.id);
    expect(arg0Slot!.classCoverage).toBeGreaterThan(0);
    expect(arg0Slot!.classCoverage).toBeLessThanOrEqual(1);

    const arg1Slot = construction!.slots.find(slot => slot.roleId === "arg1");
    expect(arg1Slot).toBeDefined();
    // Mirrors relationFor(): predicate -> entity is "acts_on".
    expect(arg1Slot!.relation).toBe("acts_on");
    expect(arg1Slot!.relationDirection).toBe("target");
  });

  it("does not fabricate a lexicalClassId when a slot's fillers have no real induced-class evidence", () => {
    const engine = createLanguageInductionEngine({ hasher, vocabularyLimit: 512 });
    const text = "the cat sat.";

    const model = engine.induce({ documents: [{ id: "doc.sparse", text }] });

    expect(model.lexicalClasses).toEqual([]);
    for (const construction of model.graphBoundConstructions) {
      for (const slot of construction.slots) {
        expect(slot.lexicalClassId).toBeUndefined();
        expect(slot.classCoverage).toBeUndefined();
      }
    }
  });

  it("keeps graph-bound construction induction additive: semantic frames and lexical classes are unaffected", () => {
    const engine = createLanguageInductionEngine({ hasher, vocabularyLimit: 512 });
    const text = ["the cat chased the mouse.", "a dog chased the ball.", "the cat chased the ball.", "a dog chased the mouse."].join(" ");

    const model = engine.induce({ documents: [{ id: "doc.additive", text }] });

    expect(model.semanticFrames.length).toBeGreaterThan(0);
    expect(Array.isArray(model.graphBoundConstructions)).toBe(true);
    for (const construction of model.graphBoundConstructions) {
      expect(model.semanticFrames.some(frame => frame.id === construction.frameId)).toBe(true);
      for (const slot of construction.slots) {
        if (slot.lexicalClassId) expect(model.lexicalClasses.some(cls => cls.id === slot.lexicalClassId)).toBe(true);
      }
    }
  });
});
