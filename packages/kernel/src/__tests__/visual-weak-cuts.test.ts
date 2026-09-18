// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
import { describe, expect, it } from "vitest";
import { cutAtWeakColumns, cutJoinedMarks, weakCutColumns } from "../visual-weak-cuts.js";
import type { GlyphComponent } from "../visual-page-analysis.js";

// A joined script set on a regular advance is cut on its lattice. One whose letters differ in width -- most
// real cursive, most real Devanagari -- has no advance to cut on, so it is cut where it is WEAKEST instead:
// the columns carrying least ink, which are the thin joins between letters. Nothing here knows which script it
// is looking at and no threshold is chosen.

function markOf(rows: readonly string[], x0 = 0, y0 = 0): GlyphComponent {
  const raster = rows.map(row => [...row].map(ch => (ch === "#" ? 1 : 0)));
  let area = 0;
  let sumX = 0;
  let sumY = 0;
  raster.forEach((row, y) => row.forEach((ink, x) => {
    if (!ink) return;
    area += 1;
    sumX += x;
    sumY += y;
  }));
  return {
    x0,
    y0,
    x1: x0 + (rows[0]!.length - 1),
    y1: y0 + (rows.length - 1),
    area,
    centroidX: x0 + sumX / Math.max(1, area),
    centroidY: y0 + sumY / Math.max(1, area),
    raster
  };
}

describe("cutting a joined mark where it is weakest", () => {
  it("finds the thin join between two letters and nothing else", () => {
    // Two bodies under one continuous headline. Column 4 carries only the headline: that is the join.
    const word = markOf([
      "#########",
      "###...###",
      "###...###",
      "###...###",
      "###...###"
    ]);
    const cuts = weakCutColumns(word, 1);
    expect(cuts).toContain(4);
    // The bodies themselves are not cut: their columns carry more than the typical column of the mark.
    expect(cuts.every(cut => cut >= 3 && cut <= 5)).toBe(true);
  });

  it("cuts the word into its pieces, each carrying its own ink and its own box", () => {
    const word = markOf([
      "#########",
      "###...###",
      "###...###",
      "###...###",
      "###...###"
    ], 100, 50);
    // A three-pixel pen: the three adjacent thin columns are one join, not three, so one cut is taken.
    const pieces = cutAtWeakColumns(word, 3);
    expect(pieces).toHaveLength(2);
    // Absolute positions are kept, so a piece can still be placed on the page it came from.
    expect(pieces[0]!.x0).toBe(100);
    expect(pieces[1]!.x1).toBe(108);
    // The ink is conserved: cutting moves nothing and loses nothing.
    expect(pieces[0]!.area + pieces[1]!.area).toBe(word.area);
  });

  it("leaves a mark whole when it has no weak column", () => {
    const solid = markOf(["###", "###", "###", "###"]);
    expect(weakCutColumns(solid, 1)).toHaveLength(0);
    expect(cutAtWeakColumns(solid, 1)).toHaveLength(1);
  });

  it("will not cut two pieces closer together than the pen is wide", () => {
    // Three thin columns in a row. With a three-pixel pen only one cut may be taken among them, because a
    // piece narrower than the stroke that drew it is not a letter.
    const word = markOf([
      "###########",
      "####...####",
      "####...####",
      "####...####"
    ]);
    const cuts = weakCutColumns(word, 3);
    for (let i = 1; i < cuts.length; i++) expect(cuts[i]! - cuts[i - 1]!).toBeGreaterThanOrEqual(3);
  });

  it("cuts only marks wider than they are tall, since a tall mark is a letter", () => {
    // A letter: taller than wide, however cursive the hand. Left alone.
    const letter = markOf(["##.", "#.#", "###", "#.#", "#.#", "#.#"]);
    expect(cutJoinedMarks([letter], 1)).toHaveLength(1);
    // A word: much wider than tall. Cut.
    const word = markOf(["#########", "###...###", "###...###"]);
    expect(cutJoinedMarks([word], 1).length).toBeGreaterThan(1);
  });

  it("returns the pieces in reading order", () => {
    const word = markOf(["#############", "###...###.###", "###...###.###"]);
    const pieces = cutJoinedMarks([word], 1);
    for (let i = 1; i < pieces.length; i++) {
      expect(pieces[i]!.x0).toBeGreaterThanOrEqual(pieces[i - 1]!.x0);
    }
  });
});
