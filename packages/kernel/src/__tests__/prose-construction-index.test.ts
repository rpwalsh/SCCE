// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
import { describe, expect, it, vi } from "vitest";
import * as entityMatcher from "../kernel-answer-primitives.js";
import { createLanguageInductionEngine, type GraphBoundConstruction } from "../language-induction.js";
import { createHasher } from "../primitives.js";
import { proseRelations } from "../prose-relation-channel.js";
import { splitSurfaceSentences } from "../surface-linguistics.js";

const normalize = (text: string) => text.replace(/\s+/gu, " ").trim().toLocaleLowerCase();

/** Exhaustive previous selector: compare full results, including ordering and exact source surfaces. */
function exhaustive(text: string, constructions: readonly GraphBoundConstruction[]) {
  return splitSurfaceSentences(text).flatMap(sentence => {
    const relations = constructions.flatMap(construction => {
      const source = construction.slots.filter(slot => slot.relationDirection === "source").flatMap(slot => slot.observedFillers);
      const target = construction.slots.filter(slot => slot.relationDirection === "target").flatMap(slot => slot.observedFillers);
      return proseRelations(sentence, { entitySurfaces: [...source, ...target] }).filter(relation =>
        relation.predicateSurface === normalize(construction.predicate)
        && source.map(normalize).includes(normalize(relation.subject.surface)) && target.map(normalize).includes(normalize(relation.object.surface)));
    });
    return [...new Map(relations.map(relation => [JSON.stringify([relation.subject, relation.predicateSurface, relation.object]), relation])).values()];
  });
}

describe("observed construction predicate index", () => {
  it("prepares each real construction once and scans only predicates present as full lexical units", () => {
    const model = createLanguageInductionEngine({ hasher: createHasher() }).induce({ documents: [{ id: "observed-slots", evidenceIds: ["evidence.slots" as never],
      text: "ada visited london. ada visited paris. eve visited london. eve visited paris." }] });
    const actual = model.graphBoundConstructions.find(row => row.predicate === "visited")!;
    expect(actual).toBeDefined();
    let slotReads = 0;
    const constructions = [actual, ...Array.from({ length: 80 }, (_, index) => ({ ...actual, id: `inactive.${index}`, predicate: `inactive${index}` }))]
      .map(row => Object.defineProperty({ ...row }, "slots", { get: () => { slotReads++; return row.slots; } }));
    const text = "ada visited london. eve visited paris. ada revisited london. eve visitedparis london.";
    const scan = vi.spyOn(entityMatcher, "surfaceEntityRuns");
    try {
      const relations = proseRelations(text, { entityConstructions: constructions });
      expect(relations.map(row => [row.subject.surface, row.predicateSurface, row.object.surface])).toEqual([
        ["ada", "visited", "london"], ["eve", "visited", "paris"]
      ]);
      expect(slotReads).toBe(constructions.length);
      expect(scan).toHaveBeenCalledTimes(6); // Four ordinary sentence scans and two active construction scans.
    } finally { scan.mockRestore(); }
  });

  it("preserves exhaustive results for multiword, uncased, compatibility-Unicode and duplicate predicates", () => {
    const construction = (predicate: string, source: string[], target: string[]): GraphBoundConstruction => ({
      id: `fixture.${predicate}`, frameId: `frame.${predicate}`, predicate, predicateSemanticRole: "predicate", support: 1, evidenceIds: [],
      slots: [{ roleId: "arg0", semanticRole: "entity", relation: "has_predicate", relationDirection: "source", observedFillers: source },
        { roleId: "arg1", semanticRole: "entity", relation: "acts_on", relationDirection: "target", observedFillers: target }]
    });
    const constructions = [construction("worked with", ["ada"], ["eve"]), construction("встретила", ["мара"], ["киру"]),
      construction("ｖｉｓｉｔｅｄ", ["ada"], ["london"]), construction("worked with", ["ada"], ["eve"])];
    const text = "ADA worked with EVE. мара встретила киру. ada ｖｉｓｉｔｅｄ london. eve worked with ada. ada reworked with eve. ada worked without eve.";
    const expected = exhaustive(text, constructions);
    expect(expected).toHaveLength(3);
    expect(proseRelations(text, { entityConstructions: constructions })).toEqual(expected);
    expect(proseRelations(text, { entityConstructions: [...constructions].reverse() })).toEqual(exhaustive(text, [...constructions].reverse()));
  });
});
