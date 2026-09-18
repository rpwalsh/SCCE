// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
//
// Model-free eyes. A glyph -- a hieroglyph, a printed letter, a carved sign -- is recognized here by the SHAPE
// of its mark, computed as invariant moments, not by a trained classifier. This is the visual analog of how
// SCCE reads text: structure over learned representation. It is the foundation of both the deterministic OCR
// that would replace Tesseract (an LSTM, i.e. a model) and the wall-reader that feeds the structural aligner.
//
// Hu moments are the seven combinations of normalized central image moments that are invariant to translation,
// scale, and rotation (the seventh flips sign under reflection, which is itself useful -- it tells mirror image
// from original). Two marks of the same shape have near-identical Hu vectors regardless of where they sit, how
// big they are, or how they are turned; two different shapes do not. Everything here is measured, auditable,
// and deterministic -- no weights, no training, no black box.

/** A binary raster of a single glyph: values > 0 are ink/foreground. Row-major, rows[y][x]. */
export type GlyphRaster = ReadonlyArray<ReadonlyArray<number>>;

export interface ShapeSignature {
  /** The seven Hu invariants, in order. */
  hu: readonly [number, number, number, number, number, number, number];
  /** Foreground pixel mass; a shape with no ink has no signature. */
  mass: number;
}

interface RawMoments { m00: number; m10: number; m01: number }

function centroid(raster: GlyphRaster): { cx: number; cy: number; mass: number } {
  let m00 = 0, m10 = 0, m01 = 0;
  for (let y = 0; y < raster.length; y++) {
    const row = raster[y]!;
    for (let x = 0; x < row.length; x++) {
      const v = row[x]! > 0 ? 1 : 0;
      if (!v) continue;
      m00 += 1; m10 += x; m01 += y;
    }
  }
  return { cx: m00 ? m10 / m00 : 0, cy: m00 ? m01 / m00 : 0, mass: m00 };
}

/** Central moment mu_pq about the centroid, over the binary foreground. */
function centralMoment(raster: GlyphRaster, p: number, q: number, cx: number, cy: number): number {
  let mu = 0;
  for (let y = 0; y < raster.length; y++) {
    const row = raster[y]!;
    for (let x = 0; x < row.length; x++) {
      if (row[x]! <= 0) continue;
      mu += Math.pow(x - cx, p) * Math.pow(y - cy, q);
    }
  }
  return mu;
}

/**
 * The shape signature of one glyph raster: translation/scale/rotation-invariant Hu moments. Pure. A raster with
 * no foreground returns a zero signature with mass 0, which callers treat as "nothing to recognize".
 */
export function shapeSignature(raster: GlyphRaster): ShapeSignature {
  const { cx, cy, mass } = centroid(raster);
  if (mass <= 0) return { hu: [0, 0, 0, 0, 0, 0, 0], mass: 0 };

  const mu = (p: number, q: number) => centralMoment(raster, p, q, cx, cy);
  const mu00 = mass; // for a binary image mu00 == m00 == foreground count
  // Normalized central moments: eta_pq = mu_pq / mu00^(1 + (p+q)/2), which removes scale.
  const eta = (p: number, q: number) => mu(p, q) / Math.pow(mu00, 1 + (p + q) / 2);

  const n20 = eta(2, 0), n02 = eta(0, 2), n11 = eta(1, 1);
  const n30 = eta(3, 0), n12 = eta(1, 2), n21 = eta(2, 1), n03 = eta(0, 3);

  // The classical Hu (1962) invariants.
  const h1 = n20 + n02;
  const h2 = (n20 - n02) ** 2 + 4 * n11 ** 2;
  const h3 = (n30 - 3 * n12) ** 2 + (3 * n21 - n03) ** 2;
  const h4 = (n30 + n12) ** 2 + (n21 + n03) ** 2;
  const h5 = (n30 - 3 * n12) * (n30 + n12) * ((n30 + n12) ** 2 - 3 * (n21 + n03) ** 2)
    + (3 * n21 - n03) * (n21 + n03) * (3 * (n30 + n12) ** 2 - (n21 + n03) ** 2);
  const h6 = (n20 - n02) * ((n30 + n12) ** 2 - (n21 + n03) ** 2)
    + 4 * n11 * (n30 + n12) * (n21 + n03);
  const h7 = (3 * n21 - n03) * (n30 + n12) * ((n30 + n12) ** 2 - 3 * (n21 + n03) ** 2)
    - (n30 - 3 * n12) * (n21 + n03) * (3 * (n30 + n12) ** 2 - (n21 + n03) ** 2);

  return { hu: [h1, h2, h3, h4, h5, h6, h7], mass };
}

/**
 * Distance between two shapes on their Hu signatures (OpenCV's matchShapes I1). Each moment contributes through
 * the RECIPROCAL of its signed log-magnitude, which is the point: the higher moments are numerically fragile
 * (near-zero, sign-flipping on noise), and taking 1/log makes their large-magnitude logs contribute almost
 * nothing, while the stable low-order moments carry the comparison. Small distance = same shape however placed,
 * scaled, or rotated; large distance = a different shape.
 */
export function shapeDistance(a: ShapeSignature, b: ShapeSignature): number {
  if (a.mass <= 0 || b.mass <= 0) return Number.POSITIVE_INFINITY;
  let distance = 0;
  for (let i = 0; i < 7; i++) {
    const ha = a.hu[i]!;
    const hb = b.hu[i]!;
    if (ha === 0 || hb === 0) continue; // a genuinely zero moment carries no comparable information
    const ma = Math.sign(ha) * Math.log10(Math.abs(ha));
    const mb = Math.sign(hb) * Math.log10(Math.abs(hb));
    if (ma === 0 || mb === 0) continue;
    distance += Math.abs(1 / ma - 1 / mb);
  }
  return distance;
}

/** True when two shapes are the same up to a reflection: the seventh Hu invariant flips sign under mirroring. */
export function shapesAreMirrored(a: ShapeSignature, b: ShapeSignature): boolean {
  return Math.sign(a.hu[6]!) !== Math.sign(b.hu[6]!) && Math.abs(a.hu[6]!) > 1e-9 && Math.abs(b.hu[6]!) > 1e-9;
}
