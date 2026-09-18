// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
import { describe, expect, it } from "vitest";
import {
  canonicalConstruction,
  groupIntoConstructions,
  readConstructions,
  relationBetween,
  type PlacedSign
} from "../visual-construction-graph.js";

// The claim: an arrangement of signs is an object in its own right, and two instances of the same arrangement
// are recognisable as the same however large they are drawn or wherever they sit. That is what a string cannot
// represent and what an Egyptian quadrat, a Maya glyph block and an Aztec composition require.

const at = (sign: number, x0: number, y0: number, x1: number, y1: number): PlacedSign => ({ sign, x0, y0, x1, y1 });

/** The same quadrat -- sign 1 over sign 2, with sign 3 beside them -- placed and scaled differently. */
const quadrat = (x: number, y: number, scale: number): PlacedSign[] => [
  at(1, x, y, x + 9 * scale, y + 4 * scale),
  at(2, x, y + 5 * scale, x + 9 * scale, y + 9 * scale),
  at(3, x + 11 * scale, y, x + 20 * scale, y + 9 * scale)
];

describe("an arrangement of signs as an object, not a string", () => {
  it("reads the relation between two signs against their own size, not a fixed tolerance", () => {
    expect(relationBetween(at(1, 0, 0, 9, 9), at(2, 20, 0, 29, 9))).toBe("LEFT_OF");
    expect(relationBetween(at(1, 0, 0, 9, 9), at(2, 0, 20, 9, 29))).toBe("ABOVE");
    // A sign wholly within another is INSIDE it, and the other CONTAINS it -- not merely overlapping.
    expect(relationBetween(at(1, 3, 3, 6, 6), at(2, 0, 0, 20, 20))).toBe("INSIDE");
    expect(relationBetween(at(2, 0, 0, 20, 20), at(1, 3, 3, 6, 6))).toBe("CONTAINS");
    // Sharing both axes almost completely is an alignment, which is a claim about neither order.
    expect(relationBetween(at(1, 0, 0, 9, 9), at(2, 0, 0, 9, 9))).toBe("ALIGNED_WITH");
    // Stacked but sharing the column: still ABOVE, because the column is shared and the rows are not.
    expect(relationBetween(at(1, 0, 0, 9, 4), at(2, 0, 5, 9, 9))).toBe("ABOVE");
  });

  it("gives the same construction the same key at any size and any position on the page", () => {
    const small = canonicalConstruction(quadrat(0, 0, 1));
    const shifted = canonicalConstruction(quadrat(500, 300, 1));
    const large = canonicalConstruction(quadrat(17, 41, 7));
    // Position and scale carry no information about which construction this is, so they are not in the key.
    expect(shifted.key).toBe(small.key);
    expect(large.key).toBe(small.key);
    expect(small.key).not.toBe("");
  });

  it("gives a different key to the same signs arranged differently", () => {
    const stacked = canonicalConstruction(quadrat(0, 0, 1));
    // The same three signs in a row instead of two-over-one-beside: a different construction entirely.
    const inARow = canonicalConstruction([
      at(1, 0, 0, 9, 9),
      at(2, 11, 0, 20, 9),
      at(3, 22, 0, 31, 9)
    ]);
    expect(inARow.key).not.toBe(stacked.key);
    // And nesting is different again.
    const nested = canonicalConstruction([
      at(1, 0, 0, 30, 30),
      at(2, 5, 5, 12, 12),
      at(3, 18, 18, 25, 25)
    ]);
    expect(nested.key).not.toBe(stacked.key);
    expect(nested.edges.some(edge => edge.relation === "CONTAINS" || edge.relation === "INSIDE")).toBe(true);
  });

  it("gathers signs into blocks by the gaps that separate blocks", () => {
    // Three quadrats along a line, each tight inside and well clear of its neighbours.
    const page = [...quadrat(0, 0, 1), ...quadrat(60, 0, 1), ...quadrat(120, 0, 1)];
    const groups = groupIntoConstructions(page);
    expect(groups).toHaveLength(3);
    for (const group of groups) expect(group).toHaveLength(3);
  });

  it("keeps evenly spaced signs as one group rather than inventing blocks", () => {
    // A line of signs at a single spacing is not a page of blocks, and there is nothing to separate.
    const line: PlacedSign[] = [];
    for (let i = 0; i < 8; i++) line.push(at(i, i * 14, 0, i * 14 + 9, 9));
    expect(groupIntoConstructions(line)).toHaveLength(1);
  });

  it("counts how often each arrangement recurs, which is what description length needs", () => {
    // The same quadrat twice at different scales, and a different arrangement once.
    const page = [
      ...quadrat(0, 0, 1),
      ...quadrat(60, 0, 2),
      at(1, 400, 0, 409, 9), at(2, 411, 0, 420, 9), at(3, 422, 0, 431, 9)
    ];
    const inventory = readConstructions(page);
    expect(inventory.constructions).toHaveLength(3);
    const counts = [...inventory.occurrences.values()].sort((a, b) => b - a);
    // The repeated arrangement is counted as recurring even though the two instances differ in size.
    expect(counts).toEqual([2, 1]);
  });

  it("handles an empty page and a single sign without inventing structure", () => {
    expect(groupIntoConstructions([])).toHaveLength(0);
    expect(canonicalConstruction([]).key).toBe("");
    const alone = canonicalConstruction([at(4, 0, 0, 9, 9)]);
    expect(alone.signs).toHaveLength(1);
    expect(alone.edges).toHaveLength(0);
  });
});
