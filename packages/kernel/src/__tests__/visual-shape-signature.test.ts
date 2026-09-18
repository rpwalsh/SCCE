// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
import { describe, expect, it } from "vitest";
import {
  glyphProfile,
  profileDistance,
  shapeDistance,
  shapeSignature,
  windowProfile,
  type GlyphRaster
} from "../visual-shape-signature.js";

// The claim: a glyph is recognized by the SHAPE of its mark -- invariant moments -- not by a trained model. A
// mark reads as the same shape wherever it sits, however big, however turned; a different mark does not. Proven
// on synthetic glyphs, deterministically. This is the model-free foundation of the wall-reader and the OCR that
// would replace Tesseract (which is itself an LSTM, a model SCCE is not supposed to carry).

function raster(lines: string[]): number[][] {
  return lines.map(line => [...line].map(ch => (ch === "#" ? 1 : 0)));
}
// Real glyphs are not 5 pixels wide; at coarse resolution Hu moments cannot separate simple shapes from
// discretization noise. Scaling the pattern up gives the moments enough support to be both stable and
// discriminative -- the same reason a scanner captures a letter at more than a handful of pixels.
function scaleN(r: GlyphRaster, n: number): number[][] {
  const out: number[][] = [];
  for (const row of r) {
    const big = row.flatMap(v => new Array<number>(n).fill(v));
    for (let i = 0; i < n; i++) out.push([...big]);
  }
  return out;
}
function rotate90(r: GlyphRaster): number[][] {
  const h = r.length, w = r[0]!.length;
  const out = Array.from({ length: w }, () => new Array<number>(h).fill(0));
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) out[x]![h - 1 - y] = r[y]![x]!;
  return out;
}
function scale2x(r: GlyphRaster): number[][] {
  const out: number[][] = [];
  for (const row of r) {
    const big = row.flatMap(v => [v, v]);
    out.push([...big], [...big]);
  }
  return out;
}
function pad(r: GlyphRaster, border: number): number[][] {
  const w = r[0]!.length;
  const blank = () => new Array<number>(w + 2 * border).fill(0);
  const out: number[][] = [];
  for (let i = 0; i < border; i++) out.push(blank());
  for (const row of r) out.push([...new Array<number>(border).fill(0), ...row, ...new Array<number>(border).fill(0)]);
  for (let i = 0; i < border; i++) out.push(blank());
  return out;
}

// Three clearly distinct glyphs on the same grid.
const L = scaleN(raster(["#....", "#....", "#....", "#....", "#####"]), 4);
const T = scaleN(raster(["#####", "..#..", "..#..", "..#..", "..#.."]), 4);
const square = scaleN(raster(["#####", "#...#", "#...#", "#...#", "#####"]), 4);

describe("recognizing a glyph by the shape of its mark, no model", () => {
  it("gives the same shape a near-identical signature under rotation, scale, and translation", () => {
    const base = shapeSignature(L);
    const rotated = shapeSignature(rotate90(L));
    const rotatedTwice = shapeSignature(rotate90(rotate90(L)));
    const scaled = shapeSignature(scale2x(L));
    const moved = shapeSignature(pad(L, 3));

    const sameShape = [rotated, rotatedTwice, scaled, moved].map(sig => shapeDistance(base, sig));
    // Every transform of the SAME glyph stays close to the original.
    for (const d of sameShape) expect(d).toBeLessThan(0.5);
  });

  it("separates different glyphs by a clear margin", () => {
    const l = shapeSignature(L);
    const t = shapeSignature(T);
    const sq = shapeSignature(square);
    const differentShape = [shapeDistance(l, t), shapeDistance(l, sq), shapeDistance(t, sq)];
    // The classifier property: every DIFFERENT-shape distance exceeds every SAME-shape distance, so a nearest
    // match on shape signature always picks the right glyph. That is what makes this usable for recognition.
    const worstSame = Math.max(
      shapeDistance(l, shapeSignature(rotate90(L))),
      shapeDistance(l, shapeSignature(rotate90(rotate90(L)))),
      shapeDistance(l, shapeSignature(scale2x(L))),
      shapeDistance(l, shapeSignature(pad(L, 5)))
    );
    for (const d of differentShape) expect(d).toBeGreaterThan(worstSame);
  });

  it("returns no signature for an empty raster, rather than inventing one", () => {
    const empty = shapeSignature(raster(["....."]));
    expect(empty.mass).toBe(0);
    expect(shapeDistance(empty, shapeSignature(L))).toBe(Number.POSITIVE_INFINITY);
  });

  it("is deterministic", () => {
    expect(shapeSignature(T).hu).toEqual(shapeSignature(T).hu);
  });
});

// A second framing for identity, for scripts whose marks vary in size. A bounding box normalises size away,
// which is right where every mark is the same size and wrong where size is what distinguishes them. This one
// takes a window of the writing's own scale centred on the mark's ink, so size is kept and a speck at the
// edge cannot rescale anything. It is not the default: at small cells a fractional centroid jitters, and on a
// page of uniform letters that costs more than it saves.
describe("identity read from a window of the writing's scale rather than the mark's own box", () => {
  const glyph = (rows: string[]) => rows.map(row => [...row].map(ch => (ch === "#" ? 1 : 0)));
  const small = glyph(["##", "##"]);
  const large = glyph(["####", "####", "####", "####"]);

  it("keeps the difference between a small mark and a large one", () => {
    // Fitted to their own boxes these are the same shape and become one sign. The grid has to be no finer than
    // the smaller raster, or it resolves cells that raster cannot fill and the two stop matching for that
    // reason instead.
    const boxedSmall = glyphProfile(small, 2, 2);
    const boxedLarge = glyphProfile(large, 2, 2);
    expect(profileDistance(boxedSmall, boxedLarge)).toBe(0);

    // In a common window they are plainly different marks, which for many scripts they are.
    const windowedSmall = windowProfile(small, 1, 1, 8, 8, 2, 2);
    const windowedLarge = windowProfile(large, 2, 2, 8, 8, 2, 2);
    expect(profileDistance(windowedSmall, windowedLarge)).toBeGreaterThan(0.1);
  });

  it("is unmoved by where the mark sits, since the window follows its ink", () => {
    const padded = glyph(["....", ".##.", ".##.", "...."]);
    const here = windowProfile(small, 1, 1, 8, 8, 2, 2);
    const there = windowProfile(padded, 2, 2, 8, 8, 2, 2);
    expect(profileDistance(here, there)).toBe(0);
  });

  it("returns an empty profile rather than failing on a degenerate window", () => {
    expect(windowProfile(small, 1, 1, 0, 0, 2, 2).density.every(value => value === 0)).toBe(true);
    expect(windowProfile(small, 1, 1, 8, 8, 0, 0).density).toHaveLength(0);
  });
});
