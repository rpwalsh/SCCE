// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
//
// What a camera hands you is not a page. It is the page times the light that fell on it, in whatever colour the
// ink and the paper happen to be. Both are modelled here rather than assumed away, and both are measured.
//
//   Illumination:  I = R * L,  so  log I = log R + log L
//
// The reflectance R carries the marks and the illumination L varies slowly, so L is estimated by closing the
// image over a window taken from the measured glyph size -- a window wider than a mark erases marks and leaves
// the light -- and the marks are read off log I - log L. This replaces adapting only where a global threshold
// already saw ink, which cannot see faint marks and invents marks in shadow, where blank paper is darker than
// ink was in the light.
//
//   Colour: the best 1-D contrast axis is the one that separates ink from paper, whatever hue they are.
//
// Fixed luminosity coefficients are a guess about the ink, and a wrong one whenever ink and paper differ in hue
// more than in brightness. The axis is found instead by Fisher's criterion, J(w) = wT SB w / wT SW w, with the
// two classes bootstrapped by Otsu on the leading principal component and then refined. No coefficient is ours.

import type { GrayImage } from "./visual-page-analysis.js";
import { dominantLinePitch, measureStrokeWidth, otsuHistogramSplit } from "./visual-page-analysis.js";

/** Interleaved RGB, row-major, 0..255. */
export interface ColorImage {
  readonly width: number;
  readonly height: number;
  readonly data: ArrayLike<number>;
}

/** Sliding-window maximum over one axis, via a monotonic deque: O(n) whatever the window. */
function slidingExtreme(
  values: Float64Array,
  width: number,
  height: number,
  window: number,
  horizontal: boolean,
  wantMax: boolean
): Float64Array {
  const out = new Float64Array(values.length);
  const span = horizontal ? width : height;
  const other = horizontal ? height : width;
  const radius = Math.max(0, Math.floor(window / 2));
  const at = (outer: number, index: number) => (horizontal ? outer * width + index : index * width + outer);
  const deque = new Int32Array(span);

  for (let outer = 0; outer < other; outer++) {
    let head = 0;
    let tail = 0;
    for (let index = 0; index < span + radius; index++) {
      if (index < span) {
        const value = values[at(outer, index)]!;
        while (tail > head) {
          const back = values[at(outer, deque[tail - 1]!)]!;
          if (wantMax ? back <= value : back >= value) tail -= 1;
          else break;
        }
        deque[tail++] = index;
      }
      const centre = index - radius;
      if (centre < 0) continue;
      while (deque[head]! < centre - radius) head += 1;
      out[at(outer, centre)] = values[at(outer, deque[head]!)]!;
    }
  }
  return out;
}

/** Grayscale morphological closing: a window wider than a mark removes marks and keeps the background. */
function closing(values: Float64Array, width: number, height: number, window: number): Float64Array {
  const dilatedX = slidingExtreme(values, width, height, window, true, true);
  const dilated = slidingExtreme(dilatedX, width, height, window, false, true);
  const erodedX = slidingExtreme(dilated, width, height, window, true, false);
  return slidingExtreme(erodedX, width, height, window, false, false);
}

/** Separable box blur, so the estimated light is smooth rather than blocky. */
function blur(values: Float64Array, width: number, height: number, window: number): Float64Array {
  const radius = Math.max(1, Math.floor(window / 2));
  const pass = (source: Float64Array, horizontal: boolean) => {
    const out = new Float64Array(source.length);
    const span = horizontal ? width : height;
    const other = horizontal ? height : width;
    const at = (outer: number, index: number) => (horizontal ? outer * width + index : index * width + outer);
    for (let outer = 0; outer < other; outer++) {
      let total = 0;
      let count = 0;
      for (let index = 0; index <= Math.min(radius, span - 1); index++) {
        total += source[at(outer, index)]!;
        count += 1;
      }
      for (let index = 0; index < span; index++) {
        out[at(outer, index)] = total / Math.max(1, count);
        const leaving = index - radius;
        const entering = index + radius + 1;
        if (leaving >= 0) {
          total -= source[at(outer, leaving)]!;
          count -= 1;
        }
        if (entering < span) {
          total += source[at(outer, entering)]!;
          count += 1;
        }
      }
    }
    return out;
  };
  return pass(pass(values, true), false);
}

/**
 * The closing window the page calls for. It has to exceed the largest mark and stay well under the scale the
 * light varies over, and the line advance is exactly that: a line is taller than any mark in it.
 *
 * The obvious measurement -- the longest run of ink under a global threshold -- is circular here and fails on
 * the page this function exists for. Where the light falls off, a global threshold calls the shadowed paper ink
 * and every row becomes one enormous run: measured 165 pixels on a page whose marks are 21, which closes over
 * the text and the gradient alike. The line advance comes from the periodicity of the row projection instead,
 * which the written part of the page supplies however flooded the rest is.
 */
function closingWindow(image: GrayImage): number {
  const { width, height } = image;
  const histogram = new Float64Array(256);
  for (let i = 0; i < width * height; i++) {
    const v = image.data[i]!;
    histogram[v < 0 ? 0 : v > 255 ? 255 : v | 0]! += 1;
  }
  const split = otsuHistogramSplit(histogram);
  let dark = 0;
  for (let i = 0; i < width * height; i++) if (image.data[i]! <= split.cut) dark += 1;
  const inkIsDark = dark <= width * height - dark;

  const coarse = new Uint8Array(width * height);
  for (let i = 0; i < coarse.length; i++) {
    const low = image.data[i]! <= split.cut;
    coarse[i] = (inkIsDark ? low : !low) ? 1 : 0;
  }

  const stroke = Math.max(1, measureStrokeWidth(coarse, width, height));
  const pitch = dominantLinePitch(coarse, width, height);
  const ceiling = Math.max(3, Math.floor(Math.min(width, height) / 2));
  // Two advances, not one. A window of exactly one advance can sit straddling two lines of text, leaving the
  // estimated light modulated by the rows it was meant to erase; measured, that pulled the inter-line gap dark
  // enough to bridge a glyph on one line to a glyph on the next. Two guarantee clean paper wherever it sits --
  // the same reason a local threshold's cell has to span more than one mark.
  const window = pitch > stroke ? pitch * 2 : stroke * 4 + 1;
  return Math.max(3, Math.min(ceiling, window));
}

export interface FlattenedImage extends GrayImage {
  /** The closing window the page's own marks called for. */
  readonly scale: number;
}

/**
 * Divide out the light. The illumination is estimated by closing the log image over a window measured from the
 * page's own marks and smoothing it, then the reflectance is what remains. A page lit unevenly enough that its
 * paper in shadow is darker than its ink in the light becomes readable, and blank shadow stops inventing marks.
 */
export function flattenIllumination(image: GrayImage): FlattenedImage {
  const { width, height } = image;
  const scale = closingWindow(image);
  const logImage = new Float64Array(width * height);
  for (let i = 0; i < logImage.length; i++) logImage[i] = Math.log(1 + Math.max(0, image.data[i]!));

  const light = blur(closing(logImage, width, height, scale), width, height, scale);
  const reflectance = new Float64Array(width * height);
  let lowest = Number.POSITIVE_INFINITY;
  let highest = Number.NEGATIVE_INFINITY;
  for (let i = 0; i < reflectance.length; i++) {
    const value = logImage[i]! - light[i]!;
    reflectance[i] = value;
    if (value < lowest) lowest = value;
    if (value > highest) highest = value;
  }

  const data = new Uint8Array(width * height);
  const range = highest - lowest;
  for (let i = 0; i < data.length; i++) {
    data[i] = range > 0 ? Math.round((255 * (reflectance[i]! - lowest)) / range) : 255;
  }
  return { width, height, data, scale };
}

function invert3(m: readonly number[]): number[] | undefined {
  const [a, b, c, d, e, f, g, h, i] = m as [number, number, number, number, number, number, number, number, number];
  const det = a * (e * i - f * h) - b * (d * i - f * g) + c * (d * h - e * g);
  if (!Number.isFinite(det) || Math.abs(det) < 1e-12) return undefined;
  return [
    (e * i - f * h) / det, (c * h - b * i) / det, (b * f - c * e) / det,
    (f * g - d * i) / det, (a * i - c * g) / det, (c * d - a * f) / det,
    (d * h - e * g) / det, (b * g - a * h) / det, (a * e - b * d) / det
  ];
}

export interface ColorProjection extends GrayImage {
  /** The axis in RGB that separated ink from paper, unit length. */
  readonly axis: readonly [number, number, number];
  /** Fisher's ratio achieved on that axis: between-class over within-class scatter. */
  readonly separation: number;
}

/**
 * Project colour onto the one axis that best separates its two populations, by Fisher's criterion. The classes
 * are bootstrapped by Otsu on the leading principal component and then refined, so nothing is assumed about
 * what colour ink is. Ink and paper that differ in hue but not in brightness -- which fixed luminosity
 * coefficients erase completely -- separate here.
 */
export function projectColor(image: ColorImage): ColorProjection {
  const { width, height } = image;
  const pixels = width * height;
  const channel = (i: number, c: number) => image.data[i * 3 + c]!;

  const mean = [0, 0, 0];
  for (let i = 0; i < pixels; i++) for (let c = 0; c < 3; c++) mean[c]! += channel(i, c);
  for (let c = 0; c < 3; c++) mean[c]! /= Math.max(1, pixels);

  const covariance = new Array<number>(9).fill(0);
  for (let i = 0; i < pixels; i++) {
    const d = [channel(i, 0) - mean[0]!, channel(i, 1) - mean[1]!, channel(i, 2) - mean[2]!];
    for (let a = 0; a < 3; a++) for (let b = 0; b < 3; b++) covariance[a * 3 + b]! += d[a]! * d[b]!;
  }
  for (let k = 0; k < 9; k++) covariance[k]! /= Math.max(1, pixels);

  // Leading principal component by power iteration: the first guess at where the contrast lives. It is started
  // from each basis direction as well as the grey one and the strongest result kept, because a single start can
  // sit exactly orthogonal to the only direction the data varies in and collapse to zero. Two flat colours do
  // precisely that: their covariance is rank one along ink minus paper, and the grey start is orthogonal to it.
  let axis: number[] = [1, 0, 0];
  let strongest = -1;
  for (const start of [[1, 0, 0], [0, 1, 0], [0, 0, 1], [1, 1, 1]]) {
    let candidate = [...start];
    for (let step = 0; step < 64; step++) {
      const next = [0, 0, 0];
      for (let a = 0; a < 3; a++) for (let b = 0; b < 3; b++) next[a]! += covariance[a * 3 + b]! * candidate[b]!;
      const norm = Math.hypot(next[0]!, next[1]!, next[2]!);
      if (!(norm > 0)) break;
      candidate = next.map(v => v / norm);
    }
    let rayleigh = 0;
    for (let a = 0; a < 3; a++) for (let b = 0; b < 3; b++) rayleigh += candidate[a]! * covariance[a * 3 + b]! * candidate[b]!;
    if (rayleigh > strongest) {
      strongest = rayleigh;
      axis = candidate;
    }
  }

  const project = (direction: readonly number[]) => {
    const values = new Float64Array(pixels);
    let lowest = Number.POSITIVE_INFINITY;
    let highest = Number.NEGATIVE_INFINITY;
    for (let i = 0; i < pixels; i++) {
      const value = direction[0]! * channel(i, 0) + direction[1]! * channel(i, 1) + direction[2]! * channel(i, 2);
      values[i] = value;
      if (value < lowest) lowest = value;
      if (value > highest) highest = value;
    }
    return { values, lowest, highest };
  };

  let separation = 0;
  for (let round = 0; round < 8; round++) {
    const { values, lowest, highest } = project(axis);
    const range = highest - lowest;
    const histogram = new Float64Array(256);
    const bin = (value: number) => (range > 0 ? Math.min(255, Math.max(0, Math.round((255 * (value - lowest)) / range))) : 0);
    for (let i = 0; i < pixels; i++) histogram[bin(values[i]!)]! += 1;
    const cut = otsuHistogramSplit(histogram).cut;

    const sums = [new Array<number>(3).fill(0), new Array<number>(3).fill(0)];
    const counts = [0, 0];
    const label = new Uint8Array(pixels);
    for (let i = 0; i < pixels; i++) {
      const side = bin(values[i]!) <= cut ? 0 : 1;
      label[i] = side;
      counts[side]! += 1;
      for (let c = 0; c < 3; c++) sums[side]![c]! += channel(i, c);
    }
    if (!counts[0] || !counts[1]) break;
    const means = sums.map((sum, side) => sum.map(v => v / counts[side]!));

    const within = new Array<number>(9).fill(0);
    for (let i = 0; i < pixels; i++) {
      const side = label[i]!;
      const d = [channel(i, 0) - means[side]![0]!, channel(i, 1) - means[side]![1]!, channel(i, 2) - means[side]![2]!];
      for (let a = 0; a < 3; a++) for (let b = 0; b < 3; b++) within[a * 3 + b]! += d[a]! * d[b]!;
    }
    for (let k = 0; k < 9; k++) within[k]! /= Math.max(1, pixels);
    const delta = [means[1]![0]! - means[0]![0]!, means[1]![1]! - means[0]![1]!, means[1]![2]! - means[0]![2]!];

    // A ridge keeps the inverse defined where a channel carries no variation. It is scaled by the separation
    // being measured, not by an absolute floor, so the fully degenerate case still resolves: two flat colours
    // have no within-class scatter at all, and there the best axis is simply the line between them.
    let trace = 0;
    for (let a = 0; a < 3; a++) trace += within[a * 3 + a]!;
    const spread = Math.hypot(delta[0]!, delta[1]!, delta[2]!);
    const ridge = Math.max(trace / 3, spread * spread, 1) * 1e-9;
    for (let a = 0; a < 3; a++) within[a * 3 + a]! += ridge;

    const inverse = invert3(within);
    const next = [0, 0, 0];
    if (inverse) {
      for (let a = 0; a < 3; a++) for (let b = 0; b < 3; b++) next[a]! += inverse[a * 3 + b]! * delta[b]!;
    } else {
      for (let a = 0; a < 3; a++) next[a] = delta[a]!;
    }
    const norm = Math.hypot(next[0]!, next[1]!, next[2]!);
    if (!(norm > 0)) break;
    const refined = next.map(v => v / norm);

    // Fisher's ratio on the refined axis, which is what "best" means here.
    let between = 0;
    for (let a = 0; a < 3; a++) between += refined[a]! * delta[a]!;
    let scatter = 0;
    for (let a = 0; a < 3; a++) for (let b = 0; b < 3; b++) scatter += refined[a]! * within[a * 3 + b]! * refined[b]!;
    const ratio = (between * between) / Math.max(ridge, scatter);
    const converged = refined.every((v, k) => Math.abs(v - axis[k]!) < 1e-9);
    axis = refined;
    separation = ratio;
    if (converged) break;
  }

  const { values, lowest, highest } = project(axis);
  const range = highest - lowest;
  const data = new Uint8Array(pixels);
  for (let i = 0; i < pixels; i++) {
    data[i] = range > 0 ? Math.round((255 * (values[i]! - lowest)) / range) : 128;
  }
  return {
    width,
    height,
    data,
    axis: [axis[0]!, axis[1]!, axis[2]!],
    separation
  };
}
