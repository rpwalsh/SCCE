// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
import { expect, it } from "vitest";
import { generalizeContextualQaSources, interpretContextualQaSourceGeneralization, type ContextualQaSourceWindow } from "../contextual-qa-source-generalization.js";

function window(id: string, owner: string, modifier: string, answer: string): ContextualQaSourceWindow {
  const surface = `${owner} zôr ${modifier} vö ${answer}.`;
  const start = [...surface.slice(0, surface.indexOf(answer))].length;
  return { id, surface, protectedSpans: [{ slotIndex: 0, startCodePoint: 0, endCodePoint: [...owner].length },
    { slotIndex: 1, startCodePoint: start, endCodePoint: start + [...answer].length }] };
}

it("learns finite source-only variation without changing protected answer or copied-owner roles", () => {
  const fit = [window("a", "港🧭", "öpa", "701"), window("b", "星", "nüva", "912")];
  const model = generalizeContextualQaSources({ fit })!;
  expect(model).toBeDefined();
  expect(model.sourceOnlyRoles).toHaveLength(1);
  expect(model.sourceOnlyRoles[0]!.observedValues).toEqual(["nüva", "öpa"]);
  for (const row of model.fit) {
    const source = fit.find(item => item.id === row.id)!;
    expect(row.sourceOnlySpans).toHaveLength(1);
    const span = row.sourceOnlySpans[0]!;
    expect([...source.surface].slice(span.startCodePoint, span.endCodePoint).join(""))
      .toBe(row.id === "a" ? "öpa" : "nüva");
  }
  const held = window("new", "新港🧭", "öpa", "1107");
  expect(interpretContextualQaSourceGeneralization({ model, ...held })).toBeDefined();
  const unseen = window("unseen", "新港🧭", "not", "1107");
  expect(interpretContextualQaSourceGeneralization({ model, ...unseen })).toBeUndefined();
});

it("preserves lexical relation islands between multiple independent source-only roles", () => {
  const fit = [window("a", "A", "small city in eastern", "701"), window("b", "B", "large town in western", "912")];
  const model = generalizeContextualQaSources({ fit })!;
  expect(model).toBeDefined();
  expect(model.parts.filter(part => typeof part === "string").join("")).toContain("in");
  const held = window("new", "C", "small city in western", "1307");
  expect(interpretContextualQaSourceGeneralization({ model, ...held })).toBeDefined();
  const wrong = window("wrong", "C", "small city outside western", "1307");
  expect(interpretContextualQaSourceGeneralization({ model, ...wrong })).toBeUndefined();
});

it("never uses held-out text to extend a learned modifier class", () => {
  const fit = [window("a", "A", "north", "701"), window("b", "B", "south", "912")];
  const model = generalizeContextualQaSources({ fit })!;
  const before = JSON.stringify(model);
  expect(interpretContextualQaSourceGeneralization({ model, ...window("new", "C", "east", "1307") })).toBeUndefined();
  expect(JSON.stringify(model)).toBe(before);
  const reordered = generalizeContextualQaSources({ fit: [...fit].reverse() })!;
  expect(reordered.parts).toEqual(model.parts);
  expect(reordered.sourceOnlyRoles).toEqual(model.sourceOnlyRoles);
});

it("can represent a uniquely bounded open role for independent held-out qualification", () => {
  const fit = [window("a", "A", "north", "701"), window("b", "B", "south", "912")];
  const model = generalizeContextualQaSources({ fit, sourceOnlySurfaceClass: "open" })!;
  expect(model.sourceOnlyRoles).toMatchObject([{ surfaceClass: "open" }]);
  expect(interpretContextualQaSourceGeneralization({ model, ...window("new", "C", "east", "1307") })).toBeDefined();
  expect(interpretContextualQaSourceGeneralization({ model, ...{ ...window("wrong", "C", "east", "1307"), surface: "C outside east 1307." } })).toBeUndefined();
});

it("preserves observed symbolic relation literals without a language-specific alphabet", () => {
  const fit = [window("a", "港🧭", "öpa", "701"), window("b", "星", "nüva", "912")]
    .map(row => ({ ...row, surface: row.surface.replace("zôr", "⟿⟿⟿").replace("vö", "⊚⊚") }));
  expect(generalizeContextualQaSources({ fit })).toBeDefined();
});

it("represents uniquely bounded optional spans while rejecting overlapping ownership and a missing measurable boundary", () => {
  const a = window("a", "A", "north", "701"), b = window("b", "B", "", "912");
  const optional = generalizeContextualQaSources({ fit: [a, b] });
  expect(optional).toBeDefined();
  expect(optional!.sourceOnlyRoles).toMatchObject([{ observedValues: ["", "north"] }]);
  expect(optional!.fit.find(row => row.id === "b")!.sourceOnlySpans).toEqual([]);
  expect(interpretContextualQaSourceGeneralization({ model: optional!, ...a })).toBeDefined();
  expect(interpretContextualQaSourceGeneralization({ model: optional!, ...b })).toBeDefined();
  expect(generalizeContextualQaSources({ fit: [a, { ...a }] })).toBeUndefined();
  expect(generalizeContextualQaSources({ fit: [{ ...a, protectedSpans: [{ slotIndex: 0, startCodePoint: 0, endCodePoint: 9 }, { slotIndex: 1, startCodePoint: 1, endCodePoint: 3 }] }] })).toBeUndefined();
  expect(generalizeContextualQaSources({ fit: [{ id: "empty-relation", surface: "A701", protectedSpans: [{ slotIndex: 0, startCodePoint: 0, endCodePoint: 1 }, { slotIndex: 1, startCodePoint: 1, endCodePoint: 4 }] }] })).toBeUndefined();
});

it("rejects two complete finite parses rather than selecting a convenient role boundary", () => {
  const row = { id: "a", surface: "A xab Y", protectedSpans: [{ slotIndex: 0, startCodePoint: 0, endCodePoint: 1 }, { slotIndex: 1, startCodePoint: 6, endCodePoint: 7 }] };
  const model = { parts: [{ slotIndex: 0 }, " ", { slotIndex: 2 }, { slotIndex: 3 }, " ", { slotIndex: 1 }],
    sourceOnlyRoles: [{ slotIndex: 2, surfaceClass: "observed" as const, observedValues: ["x", "xa"] },
      { slotIndex: 3, surfaceClass: "observed" as const, observedValues: ["ab", "b"] }] };
  expect(interpretContextualQaSourceGeneralization({ model, ...row })).toBeUndefined();
});
