// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
//
// A joined script set on a regular advance can be cut on its lattice. A joined script whose letters are of
// different widths -- which is most real cursive, and most real Devanagari -- has no single advance to cut on,
// so the lattice has nothing to hold onto and a whole word arrives as one mark.
//
// Such a word is cut instead where it is WEAKEST: the columns carrying least ink. In a cursive hand those are
// the thin joins between letters; under a Devanagari headline they are the columns where only the headline
// crosses and no letter body stands. Nothing here knows which script it is looking at, and no threshold is
// chosen: a column is a candidate when it carries less ink than the typical column of that same mark, cuts are
// taken at the local minima among those, and two cuts may not fall closer together than the pen is wide --
// because a piece narrower than the stroke that drew it is not a letter.
//
// This is deliberately a separate reading of the page rather than a replacement for the lattice. Which one is
// right is decided by which produces an inventory that actually recurs, since a script is a closed inventory
// and a pile of word-blobs is not.

import type { GlyphComponent } from "./visual-page-analysis.js";

/** Columns of a mark, relative to its own left edge, where the mark is weakest. */
export function weakCutColumns(component: GlyphComponent, stroke: number): number[] {
  const raster = component.raster;
  const height = raster.length;
  const width = height ? raster[0]!.length : 0;
  if (width < 3 || height < 1) return [];

  const ink = new Array<number>(width).fill(0);
  for (let y = 0; y < height; y++) {
    const row = raster[y]!;
    for (let x = 0; x < width; x++) if (row[x]! > 0) ink[x]! += 1;
  }

  // The typical column of this mark. A candidate cut carries less ink than that.
  const ordered = [...ink].sort((a, b) => a - b);
  const typical = ordered[ordered.length >> 1]!;
  const spacing = Math.max(1, Math.round(stroke));

  const cuts: number[] = [];
  for (let x = 1; x < width - 1; x++) {
    if (ink[x]! >= typical) continue;
    // A local minimum: no column beside it is thinner, so the cut falls at the narrowest point of the join.
    if (ink[x]! > ink[x - 1]! || ink[x]! > ink[x + 1]!) continue;
    // Never nearer to the last cut, or to either edge, than the pen is wide.
    if (cuts.length && x - cuts[cuts.length - 1]! < spacing) continue;
    if (x < spacing || width - x <= spacing) continue;
    cuts.push(x);
  }
  return cuts;
}

/**
 * Cut one mark at its weak columns, returning the pieces in reading order. A mark with no weak column comes
 * back whole, which is what should happen to a letter that was never joined to anything.
 */
export function cutAtWeakColumns(component: GlyphComponent, stroke: number): GlyphComponent[] {
  const cuts = weakCutColumns(component, stroke);
  if (!cuts.length) return [component];

  const raster = component.raster;
  const height = raster.length;
  const width = height ? raster[0]!.length : 0;
  const bounds = [0, ...cuts, width];
  const pieces: GlyphComponent[] = [];

  for (let i = 0; i < bounds.length - 1; i++) {
    const from = bounds[i]!;
    const to = bounds[i + 1]!;
    if (to <= from) continue;

    // The piece's own ink, and its own box within the slice: a slice may be taller or shorter than the whole.
    let top = height;
    let bottom = -1;
    let left = to;
    let right = from - 1;
    let area = 0;
    let sumX = 0;
    let sumY = 0;
    for (let y = 0; y < height; y++) {
      const row = raster[y]!;
      for (let x = from; x < to; x++) {
        if (row[x]! <= 0) continue;
        area += 1;
        sumX += x;
        sumY += y;
        if (y < top) top = y;
        if (y > bottom) bottom = y;
        if (x < left) left = x;
        if (x > right) right = x;
      }
    }
    if (area === 0) continue;

    const sliced: number[][] = Array.from(
      { length: bottom - top + 1 },
      () => new Array<number>(right - left + 1).fill(0)
    );
    for (let y = top; y <= bottom; y++) {
      const row = raster[y]!;
      for (let x = left; x <= right; x++) if (row[x]! > 0) sliced[y - top]![x - left] = 1;
    }

    pieces.push({
      x0: component.x0 + left,
      y0: component.y0 + top,
      x1: component.x0 + right,
      y1: component.y0 + bottom,
      area,
      centroidX: component.x0 + sumX / area,
      centroidY: component.y0 + sumY / area,
      raster: sliced
    });
  }
  return pieces.length ? pieces : [component];
}

/**
 * Cut every mark that is wider than it is tall. A mark taller than it is wide is a letter, however cursive the
 * hand; one much wider than the line is tall is several letters joined, whatever script it belongs to. That
 * comparison is against the mark's own height, so it carries no number of ours.
 */
export function cutJoinedMarks(marks: readonly GlyphComponent[], stroke: number): GlyphComponent[] {
  const pieces: GlyphComponent[] = [];
  for (const mark of marks) {
    const width = mark.x1 - mark.x0 + 1;
    const height = mark.y1 - mark.y0 + 1;
    if (width <= height) {
      pieces.push(mark);
      continue;
    }
    pieces.push(...cutAtWeakColumns(mark, stroke));
  }
  pieces.sort((a, b) => a.y0 - b.y0 || a.x0 - b.x0);
  return pieces;
}
