// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
import { describe, expect, it } from "vitest";
import { exampleSurfaces, selectConstructionGrammarByDescriptionLength } from "../construction-grammar-selection.js";
import type { PairedAntiUnifiedConstruction } from "../paired-anti-unification.js";

function paired(id: string, literal: string, fills: string[], trailing = "."): PairedAntiUnifiedConstruction {
  const sources = fills.map((_, index) => `${id}.source.${index}`);
  return {
    id,
    sourceConstructionIds: sources,
    surfaceProgram: {
      parts: [
        { kind: "slot", id: "slot.subject", mode: "variable", fixedSurface: null, graphVariableIds: ["v.subject"], observedSurfaces: fills,
          examples: fills.map((fill, index) => ({ constructionId: sources[index]!, sourceFamilyId: `family.${index}`, observedSurface: fill, graphTargetIds: [] })) },
        { kind: "literal", surface: literal },
        { kind: "literal", surface: trailing }
      ],
      variableSlotIds: ["slot.subject"]
    }
  } as unknown as PairedAntiUnifiedConstruction;
}

describe("construction grammar selection by description length", () => {
  it("keeps a construction whose shared material repeats across sources and prunes one that never compresses", () => {
    const shared = paired("c.shared", " was an English mathematician and writer", ["Ada Lovelace", "Mary Somerville", "George Boole", "Charles Babbage"]);
    const singleton = paired("c.single", " ", ["An entirely idiosyncratic sentence that no other source repeats in any form"], "");
    const result = selectConstructionGrammarByDescriptionLength({ constructions: [shared, singleton] });
    expect(result.selection.retainedConstructionIds).toEqual(["c.shared"]);
    expect(result.selection.pruned.map(row => row.constructionId)).toEqual(["c.single"]);
    expect(result.selection.score.constructionCount).toBe(1);
  });

  it("rebuilds every source's surface from the program and its own fills", () => {
    const construction = paired("c.two", " writes", ["Ada", "Mary"]);
    expect(exampleSurfaces(construction)).toEqual(["Ada writes.", "Mary writes."]);
  });
});
