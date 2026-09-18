// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
//
// Page -> ink -> glyphs -> words -> lines, with no trained model and no tuned constant: every threshold is an
// Otsu split of a histogram the image itself produced (intensity, component area, gap width).

/**
 * How a grapheme is read off the page. A connected component is not a grapheme in most of the world's scripts,
 * and it fails in both directions at once: CJK and Hangul put several disconnected strokes in one square cell,
 * so a component is too little, while Arabic joins its letters cursively and Devanagari hangs a whole word from
 * one headline, so a component is too much.
 *
 * Both are the same operation. "cells" assigns the ink to the lattice the script is set on and takes each cell
 * as a grapheme, which merges the strokes of a CJK character and cuts a joined Arabic or Devanagari word apart
 * without either being a rule about those scripts. "marks" takes the components as they are. Neither is assumed.
 */
export type PageGrouping = "marks" | "cells";

/** Grayscale raster, row-major, 0..255. */
export interface GrayImage {
  readonly width: number;
  readonly height: number;
  readonly data: ArrayLike<number>;
}

export interface OtsuSplit {
  /** Values <= cut are the low class. */
  readonly cut: number;
  /** Between-class variance as a fraction of total variance: how genuinely two-class the data is. */
  readonly separability: number;
}

export interface InkMask {
  readonly width: number;
  readonly height: number;
  readonly ink: Uint8Array;
  /** True when the marked class was the brighter one (light text on dark ground), decided by measured sparsity. */
  readonly inkIsBright: boolean;
  readonly intensitySeparability: number;
  readonly strokeWidth: number;
}

export interface GlyphComponent {
  readonly x0: number;
  readonly y0: number;
  readonly x1: number;
  readonly y1: number;
  readonly area: number;
  readonly centroidX: number;
  readonly centroidY: number;
  /** The component's own ink, cropped to its bounding box: exactly what a shape signature consumes. */
  readonly raster: ReadonlyArray<ReadonlyArray<number>>;
  /**
   * The ink placed in its whole lattice cell, when this grapheme came from a cell. Identity must be read from
   * this and not from the ink's own bounding box: two characters built from the same strokes at different
   * heights in the cell normalise to the same box and would otherwise be one sign.
   */
  readonly cellRaster?: ReadonlyArray<ReadonlyArray<number>>;
}

export interface PageWord {
  readonly glyphs: readonly GlyphComponent[];
}

export interface PageLine {
  readonly words: readonly PageWord[];
}

export interface PageLayout {
  readonly skewRadians: number;
  readonly lines: readonly PageLine[];
  /** Components measured as too small to be marks, kept rather than silently dropped. */
  readonly speckles: readonly GlyphComponent[];
  /** The extent split that separated marks from specks, and how two-class the extents really were. */
  readonly scaleSplit: OtsuSplit & { readonly accepted: boolean };
  /** Cells a mark can resolve across and down: measured glyph extent over measured stroke width. */
  readonly glyphGrid: { readonly cols: number; readonly rows: number };
  /** Which reading of "one mark" this layout was built on. */
  readonly grouping: PageGrouping;
  /** Lattice pitch when graphemes were grouped into cells; 0 otherwise. */
  readonly cellPitch: number;
  /**
   * How decisively the marks fell into lines. This is the page's own evidence for which axis the writing runs
   * along: on the wrong axis the marks do not separate into bands at all and the whole page reads as one line.
   */
  readonly lineSplit: { readonly accepted: boolean; readonly margin: number; readonly count: number };
  /** The commonest number of marks in a lattice cell. Above one, a cell genuinely holds several strokes. */
  readonly cellOccupancy: number;
  /**
   * How unevenly sized this grouping's graphemes are, as the summed coefficient of variation of their widths
   * and heights. A script sets its graphemes on a common scale, so the grouping that reads them correctly is
   * the one whose sizes agree -- and that is measurable without knowing any language.
   */
  readonly extentDispersion: number;
  /**
   * Whether the page is really set on a lattice at all. Lattice cells come out uniformly sized whatever the
   * image was, so size agreement alone would hand every noisy photograph a lattice; this says the lattice was
   * found rather than imposed.
   */
  readonly latticeCredible: boolean;
  /**
   * How many bands of writing the page's own row periodicity implies, over the rows that carry ink. This is the
   * page saying how many lines it has, independently of any grouping, so a grouping can be checked against it.
   */
  readonly expectedLines: number;
  readonly mask: InkMask;
}

/** The image with rows and columns exchanged: columns of text become lines of text, read by the same code. */
export function transposeImage(image: GrayImage): GrayImage {
  const data = new Uint8Array(image.width * image.height);
  for (let y = 0; y < image.height; y++) {
    for (let x = 0; x < image.width; x++) data[x * image.height + y] = image.data[y * image.width + x]!;
  }
  return { width: image.height, height: image.width, data };
}

/** Otsu's split over an intensity histogram: the threshold maximizing between-class variance. */
export function otsuHistogramSplit(histogram: ArrayLike<number>): OtsuSplit {
  let total = 0;
  let sum = 0;
  for (let i = 0; i < histogram.length; i++) {
    total += histogram[i]!;
    sum += i * histogram[i]!;
  }
  if (total <= 0) return { cut: 0, separability: 0 };
  const mean = sum / total;
  let variance = 0;
  for (let i = 0; i < histogram.length; i++) variance += histogram[i]! * (i - mean) ** 2;
  variance /= total;

  let weightLow = 0;
  let sumLow = 0;
  let best = -1;
  let bestCut = 0;
  for (let t = 0; t < histogram.length; t++) {
    weightLow += histogram[t]!;
    sumLow += t * histogram[t]!;
    if (weightLow === 0) continue;
    const weightHigh = total - weightLow;
    if (weightHigh === 0) break;
    const meanLow = sumLow / weightLow;
    const meanHigh = (sum - sumLow) / weightHigh;
    const between = (weightLow / total) * (weightHigh / total) * (meanLow - meanHigh) ** 2;
    if (between > best) {
      best = between;
      bestCut = t;
    }
  }
  return { cut: bestCut, separability: variance > 0 ? Math.max(0, best) / variance : 0 };
}

/**
 * Otsu's split over raw values with no binning: candidate cuts are the gaps between distinct observed values, so
 * the result depends on the data alone and never on a bin count. This is the workhorse for areas and gaps.
 */
export function otsuValueSplit(values: readonly number[]): OtsuSplit {
  const sorted = [...values].sort((a, b) => a - b);
  const n = sorted.length;
  if (n === 0) return { cut: 0, separability: 0 };
  if (n === 1) return { cut: sorted[0]!, separability: 0 };
  const total = sorted.reduce((a, b) => a + b, 0);
  const mean = total / n;
  let variance = 0;
  for (const v of sorted) variance += (v - mean) ** 2;
  variance /= n;

  let sumLow = 0;
  let best = -1;
  let bestCut = sorted[0]!;
  for (let i = 0; i < n - 1; i++) {
    sumLow += sorted[i]!;
    if (sorted[i + 1]! === sorted[i]!) continue;
    const weightLow = i + 1;
    const weightHigh = n - weightLow;
    const meanLow = sumLow / weightLow;
    const meanHigh = (total - sumLow) / weightHigh;
    const between = (weightLow / n) * (weightHigh / n) * (meanLow - meanHigh) ** 2;
    if (between > best) {
      best = between;
      bestCut = (sorted[i]! + sorted[i + 1]!) / 2;
    }
  }
  return { cut: bestCut, separability: variance > 0 ? Math.max(0, best) / variance : 0 };
}

export interface VoidCut {
  /** Values at or below this belong to the near population. */
  readonly cut: number;
  /** Width of the void the cut sits in. */
  readonly gap: number;
  readonly accepted: boolean;
}

/**
 * Split a population of distances at the void that stands wider than the whole spread of values beneath it: the
 * nearest thing of the other kind must be further off than the entire range of variation within one kind.
 *
 * This is the rule that survives distributions of this shape, and it took several wrong ones to find. Otsu's
 * split cuts INSIDE a widely spread far population -- between-sign merge distances span an order of magnitude,
 * and so do the gaps between blocks on a page, so Otsu lands among them and welds the two nearest together. A
 * running mean collapses to zero the moment two things are identical. Weighting by class size penalises the
 * correct void, because the far population is always the small one. The smallest positive value is the
 * measurement's own quantum and regularises the near-identical end.
 *
 * `values` must be sorted ascending.
 */
export function populationVoidCut(values: readonly number[]): VoidCut {
  const last = values.length ? values[values.length - 1]! : 0;
  const quantum = values.find(value => value > 0) ?? 0;
  if (quantum <= 0 || values.length < 2) return { cut: last, gap: 0, accepted: false };

  let bestRatio = 0;
  let bestIndex = -1;
  for (let i = 1; i < values.length; i++) {
    const width = values[i]! - values[i - 1]!;
    if (width <= 0) continue;
    const ratio = width / Math.max(quantum, values[i - 1]! - values[0]!);
    if (ratio > bestRatio) {
      bestRatio = ratio;
      bestIndex = i;
    }
  }
  if (bestIndex > 0 && bestRatio > 1) {
    return { cut: values[bestIndex - 1]!, gap: values[bestIndex]! - values[bestIndex - 1]!, accepted: true };
  }
  return { cut: last, gap: 0, accepted: false };
}

function histogramOf(image: GrayImage, x0: number, y0: number, x1: number, y1: number): Float64Array {
  const histogram = new Float64Array(256);
  for (let y = y0; y < y1; y++) {
    const row = y * image.width;
    for (let x = x0; x < x1; x++) {
      const v = image.data[row + x]!;
      histogram[v < 0 ? 0 : v > 255 ? 255 : v | 0]! += 1;
    }
  }
  return histogram;
}

/** Median foreground run length along rows and columns: the mark's measured stroke width. */
export function measureStrokeWidth(ink: Uint8Array, width: number, height: number): number {
  const runs: number[] = [];
  const scan = (length: number, outer: number, at: (o: number, i: number) => number) => {
    for (let o = 0; o < outer; o++) {
      let run = 0;
      for (let i = 0; i < length; i++) {
        if (at(o, i)) run += 1;
        else {
          if (run > 0) runs.push(run);
          run = 0;
        }
      }
      if (run > 0) runs.push(run);
    }
  };
  scan(width, height, (y, x) => ink[y * width + x]!);
  scan(height, width, (x, y) => ink[y * width + x]!);
  if (!runs.length) return 0;
  runs.sort((a, b) => a - b);
  return runs[runs.length >> 1]!;
}

/**
 * Binarize by local Otsu on a grid whose cell size comes from the measured glyph scale, with the thresholds
 * bilinearly interpolated so cell edges leave no seam. Cells whose own histogram is less two-class than the
 * measured median cell fall back to the global threshold, which is what keeps blank paper from inventing marks.
 * Polarity is measured, not assumed: the sparser intensity class is the marked one, so light-on-dark works too.
 */
export function binarize(image: GrayImage): InkMask {
  const { width, height } = image;
  const global = otsuHistogramSplit(histogramOf(image, 0, 0, width, height));

  let countLow = 0;
  for (let i = 0; i < width * height; i++) if (image.data[i]! <= global.cut) countLow += 1;
  const inkIsBright = countLow > width * height - countLow;

  const coarse = new Uint8Array(width * height);
  for (let i = 0; i < width * height; i++) {
    const low = image.data[i]! <= global.cut;
    coarse[i] = (inkIsBright ? !low : low) ? 1 : 0;
  }

  // Cell must span more than one mark for a local histogram to hold both classes at all.
  const scale = medianComponentHeight(coarse, width, height);
  const cell = Math.max(2, scale * 2);
  const cellsX = Math.max(1, Math.ceil(width / cell));
  const cellsY = Math.max(1, Math.ceil(height / cell));

  const cuts = new Float64Array(cellsX * cellsY);
  for (let cy = 0; cy < cellsY; cy++) {
    for (let cx = 0; cx < cellsX; cx++) {
      const x0 = cx * cell;
      const y0 = cy * cell;
      const x1 = Math.min(width, x0 + cell);
      const y1 = Math.min(height, y0 + cell);
      // Adapt only where the global pass already found something: local Otsu on blank paper would split its
      // noise in half and turn half the page to ink. Faint marks below the page's own contrast stay missed.
      let coarseInk = 0;
      for (let y = y0; y < y1 && !coarseInk; y++) {
        for (let x = x0; x < x1; x++) if (coarse[y * width + x]) { coarseInk = 1; break; }
      }
      cuts[cy * cellsX + cx] = coarseInk
        ? otsuHistogramSplit(histogramOf(image, x0, y0, x1, y1)).cut
        : global.cut;
    }
  }

  const ink = new Uint8Array(width * height);
  for (let y = 0; y < height; y++) {
    const fy = Math.min(cellsY - 1, Math.max(0, (y - cell / 2) / cell));
    const y0 = Math.floor(fy);
    const y1 = Math.min(cellsY - 1, y0 + 1);
    const wy = fy - y0;
    for (let x = 0; x < width; x++) {
      const fx = Math.min(cellsX - 1, Math.max(0, (x - cell / 2) / cell));
      const x0 = Math.floor(fx);
      const x1 = Math.min(cellsX - 1, x0 + 1);
      const wx = fx - x0;
      const threshold =
        cuts[y0 * cellsX + x0]! * (1 - wx) * (1 - wy) +
        cuts[y0 * cellsX + x1]! * wx * (1 - wy) +
        cuts[y1 * cellsX + x0]! * (1 - wx) * wy +
        cuts[y1 * cellsX + x1]! * wx * wy;
      const low = image.data[y * width + x]! <= threshold;
      ink[y * width + x] = (inkIsBright ? !low : low) ? 1 : 0;
    }
  }

  return {
    width,
    height,
    ink,
    inkIsBright,
    intensitySeparability: global.separability,
    strokeWidth: measureStrokeWidth(ink, width, height)
  };
}

/** Eight-connected components by union-find, in two passes. */
export function connectedComponents(ink: Uint8Array, width: number, height: number): GlyphComponent[] {
  const labels = new Int32Array(width * height).fill(-1);
  const parent: number[] = [];
  const find = (a: number): number => {
    let root = a;
    while (parent[root] !== root) root = parent[root]!;
    while (parent[a] !== root) {
      const next = parent[a]!;
      parent[a] = root;
      a = next;
    }
    return root;
  };
  const union = (a: number, b: number) => {
    const ra = find(a);
    const rb = find(b);
    if (ra !== rb) parent[Math.max(ra, rb)] = Math.min(ra, rb);
  };

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const at = y * width + x;
      if (!ink[at]) continue;
      let label = -1;
      for (const [dx, dy] of [[-1, 0], [-1, -1], [0, -1], [1, -1]] as const) {
        const nx = x + dx;
        const ny = y + dy;
        if (nx < 0 || ny < 0 || nx >= width) continue;
        const neighbour = labels[ny * width + nx]!;
        if (neighbour < 0) continue;
        if (label < 0) label = neighbour;
        else union(label, neighbour);
      }
      if (label < 0) {
        label = parent.length;
        parent.push(label);
      }
      labels[at] = label;
    }
  }

  const bounds = new Map<number, { x0: number; y0: number; x1: number; y1: number; area: number; sx: number; sy: number }>();
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const raw = labels[y * width + x]!;
      if (raw < 0) continue;
      const root = find(raw);
      const box = bounds.get(root);
      if (!box) bounds.set(root, { x0: x, y0: y, x1: x, y1: y, area: 1, sx: x, sy: y });
      else {
        if (x < box.x0) box.x0 = x;
        if (x > box.x1) box.x1 = x;
        if (y < box.y0) box.y0 = y;
        if (y > box.y1) box.y1 = y;
        box.area += 1;
        box.sx += x;
        box.sy += y;
      }
      labels[y * width + x] = root;
    }
  }

  const components: GlyphComponent[] = [];
  for (const [root, box] of bounds) {
    const w = box.x1 - box.x0 + 1;
    const h = box.y1 - box.y0 + 1;
    const raster: number[][] = Array.from({ length: h }, () => new Array<number>(w).fill(0));
    for (let y = box.y0; y <= box.y1; y++) {
      for (let x = box.x0; x <= box.x1; x++) {
        if (labels[y * width + x] === root) raster[y - box.y0]![x - box.x0] = 1;
      }
    }
    components.push({
      x0: box.x0, y0: box.y0, x1: box.x1, y1: box.y1,
      area: box.area,
      centroidX: box.sx / box.area,
      centroidY: box.sy / box.area,
      raster
    });
  }
  components.sort((a, b) => a.y0 - b.y0 || a.x0 - b.x0);
  return components;
}

function medianComponentHeight(ink: Uint8Array, width: number, height: number): number {
  const heights = connectedComponents(ink, width, height).map(c => c.y1 - c.y0 + 1);
  if (!heights.length) return 0;
  heights.sort((a, b) => a - b);
  return heights[heights.length >> 1]!;
}

/**
 * Page skew as the rotation that packs the marks into the tightest lines: for each candidate angle the glyph
 * centroids are projected across the writing direction and binned, and the angle whose projection is most
 * concentrated wins. Unlike the ink's principal axis -- which measures the shape of the text block, not the
 * direction of its baselines -- this reads the baselines themselves. The angular step is the rotation that
 * drifts one stroke width across the page, so the resolution is the page's own, and ties prefer no rotation.
 */
export function estimateSkew(components: readonly GlyphComponent[], strokeWidth: number, pageWidth: number): number {
  if (components.length < 2) return 0;
  const resolution = Math.max(1, strokeWidth);
  const step = resolution / Math.max(1, pageWidth);
  const limit = Math.floor(Math.PI / 4 / step);
  let best = -1;
  let bestAngle = 0;
  for (let k = -limit; k <= limit; k++) {
    const angle = k * step;
    const sin = Math.sin(angle);
    const cos = Math.cos(angle);
    const bins = new Map<number, number>();
    for (const c of components) {
      const bin = Math.round((c.centroidX * sin + c.centroidY * cos) / resolution);
      bins.set(bin, (bins.get(bin) ?? 0) + 1);
    }
    let energy = 0;
    for (const count of bins.values()) energy += count * count;
    if (energy > best || (energy === best && Math.abs(angle) < Math.abs(bestAngle))) {
      best = energy;
      bestAngle = angle;
    }
  }
  return bestAngle;
}

/**
 * Otsu's cut over `values`, accepted only when the two classes stand apart by at least `minMargin` -- itself a
 * quantity measured off the page. Otsu always returns a cut, so this is what separates a real two-population
 * split from slicing one population down the middle.
 */
function acceptedSplit(values: readonly number[], minMargin: number): OtsuSplit & { accepted: boolean } {
  const split = otsuValueSplit(values);
  const low = values.filter(v => v <= split.cut);
  const high = values.filter(v => v > split.cut);
  if (!low.length || !high.length) return { ...split, accepted: false };
  return { ...split, accepted: Math.min(...high) - Math.max(...low) >= minMargin };
}

export function mergeGlyphComponents(a: GlyphComponent, b: GlyphComponent): GlyphComponent {
  const x0 = Math.min(a.x0, b.x0);
  const y0 = Math.min(a.y0, b.y0);
  const x1 = Math.max(a.x1, b.x1);
  const y1 = Math.max(a.y1, b.y1);
  const raster: number[][] = Array.from({ length: y1 - y0 + 1 }, () => new Array<number>(x1 - x0 + 1).fill(0));
  for (const part of [a, b]) {
    for (let y = 0; y < part.raster.length; y++) {
      const row = part.raster[y]!;
      for (let x = 0; x < row.length; x++) {
        if (row[x]! > 0) raster[part.y0 - y0 + y]![part.x0 - x0 + x] = 1;
      }
    }
  }
  const area = a.area + b.area;
  return {
    x0, y0, x1, y1, area,
    centroidX: (a.centroidX * a.area + b.centroidX * b.area) / area,
    centroidY: (a.centroidY * a.area + b.centroidY * b.area) / area,
    raster
  };
}

/**
 * Attach small components to the mark they belong to. A component below the writing's own scale is not
 * automatically noise: it is an Arabic dot, a European accent, a Devanagari matra, a stroke of a CJK character.
 * Arabic distinguishes several letters by dots alone, so discarding these would destroy the script rather than
 * clean it. A small component joins the overlapping mark nearest it vertically; one that overlaps no mark at all
 * has nothing to belong to, and only then is it reported as a speck.
 */
function attachMarks(
  marks: readonly GlyphComponent[],
  small: readonly GlyphComponent[],
  stroke: number
): { marks: GlyphComponent[]; specks: GlyphComponent[] } {
  const grown = [...marks];
  const specks: GlyphComponent[] = [];
  for (const mark of small) {
    // Thinner than the pen that drew the page, a component is not a mark of the script at all: no hand or press
    // lays down a line thinner than its own stroke. The test is on the MINOR dimension, because a stroke is
    // long and thin -- a letter's stem is one pen wide and many long, while sensor speckle is a pixel or a
    // three-pixel run one pixel thick. Without the bound a stray run touching a glyph joins it and shifts the
    // whole normalised profile, which measured on a colour capture collapsed the inventory to a single sign.
    if (Math.min(mark.x1 - mark.x0 + 1, mark.y1 - mark.y0 + 1) < stroke) {
      specks.push(mark);
      continue;
    }
    let pick = -1;
    let nearest = Number.POSITIVE_INFINITY;
    for (let i = 0; i < grown.length; i++) {
      const candidate = grown[i]!;
      if (mark.x0 > candidate.x1 || candidate.x0 > mark.x1) continue;
      // A mark's own dot or accent sits within a pen-width of it. Without that bound the nearest mark in the
      // column wins however far off it is, so a speck of sensor noise in the gap between two lines attaches to
      // the line above and stretches its glyph down into the gap. Measured on a colour capture, that took the
      // typical glyph from 21 pixels tall to 27 and collapsed the whole inventory to one sign.
      const clearance = Math.max(0, candidate.y0 - mark.y1 - 1, mark.y0 - candidate.y1 - 1);
      if (clearance > stroke) continue;
      const distance = Math.abs(candidate.centroidY - mark.centroidY);
      if (distance < nearest) {
        nearest = distance;
        pick = i;
      }
    }
    if (pick < 0) specks.push(mark);
    else grown[pick] = mergeGlyphComponents(grown[pick]!, mark);
  }
  grown.sort((a, b) => a.y0 - b.y0 || a.x0 - b.x0);
  return { marks: grown, specks };
}

interface GapGrouping {
  readonly groups: number[][];
  readonly accepted: boolean;
  readonly margin: number;
}

/** Split a run of items at their large gaps, keeping it whole when the gaps are one population. */
function groupByGaps(gaps: readonly number[], minMargin: number): GapGrouping {
  const items = gaps.length + 1;
  const whole = (margin: number) => ({ groups: [[...Array(items).keys()]], accepted: false, margin });
  if (gaps.length === 0) return whole(0);
  const low = gaps.filter(g => g <= otsuValueSplit(gaps).cut);
  const high = gaps.filter(g => g > otsuValueSplit(gaps).cut);
  const margin = low.length && high.length ? Math.min(...high) - Math.max(...low) : 0;
  const split = acceptedSplit(gaps, minMargin);
  if (!split.accepted) return whole(margin);
  const groups: number[][] = [[0]];
  for (let i = 1; i < items; i++) {
    if (gaps[i - 1]! > split.cut) groups.push([i]);
    else groups[groups.length - 1]!.push(i);
  }
  return { groups, accepted: true, margin };
}

/**
 * The advance of a monospaced script, as the period of its own ink. The column ink profile of cell-set writing
 * repeats at the advance, so its autocorrelation peaks there and at every multiple; the period returned is the
 * smallest peak whose multiples land on the strongest one, which is what keeps an octave of the true advance
 * from being taken for it. The baseline it must clear is the mean autocorrelation, measured, not chosen.
 *
 * Measured extent cannot serve here: a stroke spans its cell but the advance also carries the gap to the next
 * one, so extent under-reads the pitch and the lattice drifts a whole cell across a line.
 */
export function dominantPitch(ink: Uint8Array, width: number, height: number): number {
  const profile = new Float64Array(width);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) if (ink[y * width + x]) profile[x]! += 1;
  }
  return periodOfProfile(profile);
}

/** The line advance, from the same measurement taken down the page instead of across it. */
export function dominantLinePitch(ink: Uint8Array, width: number, height: number): number {
  const profile = new Float64Array(height);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) if (ink[y * width + x]) profile[y]! += 1;
  }
  return periodOfProfile(profile);
}

function periodOfProfile(profile: Float64Array): number {
  const length = profile.length;
  const maxLag = Math.floor(length / 2);
  if (maxLag < 4) return 0;

  let mean = 0;
  for (let i = 0; i < length; i++) mean += profile[i]!;
  mean /= length;
  const centred = new Float64Array(length);
  for (let i = 0; i < length; i++) centred[i] = profile[i]! - mean;

  const correlation = new Float64Array(maxLag + 1);
  for (let lag = 2; lag <= maxLag; lag++) {
    let sum = 0;
    for (let i = 0; i + lag < length; i++) sum += centred[i]! * centred[i + lag]!;
    correlation[lag] = sum / (length - lag);
  }

  // Every harmonic of the advance is a peak, so the strongest peak is usually a multiple of the advance and not
  // the advance itself. The peaks are split into strong and weak by Otsu -- the same split used everywhere else
  // here -- and the advance is the greatest common divisor of the strong ones, which is what collapses a whole
  // harmonic series onto its fundamental without any tolerance being chosen.
  const peaks: { lag: number; value: number }[] = [];
  for (let lag = 3; lag < maxLag; lag++) {
    if (correlation[lag]! >= correlation[lag - 1]! && correlation[lag]! >= correlation[lag + 1]!) {
      peaks.push({ lag, value: correlation[lag]! });
    }
  }
  if (!peaks.length) return 0;

  const split = otsuValueSplit(peaks.map(p => p.value));
  const strong = peaks.filter(p => p.value > split.cut);
  if (!strong.length) return 0;

  let pitch = strong[0]!.lag;
  for (const peak of strong) pitch = greatestCommonDivisor(pitch, peak.lag);
  // The fundamental must itself be one of the strong peaks; otherwise a stray peak has collapsed the divisor.
  const weakest = Math.min(...strong.map(p => p.value));
  if (pitch < 2 || pitch > maxLag || correlation[pitch]! < weakest) {
    return strong.reduce((best, p) => (p.value > best.value ? p : best), strong[0]!).lag;
  }
  return pitch;
}

function greatestCommonDivisor(a: number, b: number): number {
  let x = Math.abs(Math.round(a));
  let y = Math.abs(Math.round(b));
  while (y > 0) {
    const t = x % y;
    x = y;
    y = t;
  }
  return x;
}

/**
 * Group components onto the square lattice the writing sits on, and merge everything sharing a cell into one
 * grapheme. The pitch is the median of the components' own long extents, because a stroke of a square script
 * spans its cell; the lattice phase is chosen to minimise the components straddling a cell boundary. This runs
 * before lines exist on purpose -- a CJK line cannot be found from strokes, whose heights carry no line scale.
 */
function coefficientOfVariation(values: readonly number[]): number {
  if (values.length < 2) return 0;
  const mean = values.reduce((a, b) => a + b, 0) / values.length;
  if (mean <= 0) return 0;
  let variance = 0;
  for (const value of values) variance += (value - mean) ** 2;
  return Math.sqrt(variance / values.length) / mean;
}

function extentDispersionOf(graphemes: readonly GlyphComponent[]): number {
  return coefficientOfVariation(graphemes.map(g => g.x1 - g.x0 + 1))
    + coefficientOfVariation(graphemes.map(g => g.y1 - g.y0 + 1));
}

/**
 * Take each cell of the script's own lattice as one grapheme, by assigning the ink itself rather than whole
 * components. Strokes sharing a cell come together; a component spanning several cells is cut between them.
 *
 * The lattice phase across a line is chosen by the one principle that holds for every script: a script is a
 * CLOSED INVENTORY, so the phase that cuts it correctly is the phase that yields the fewest distinct graphemes.
 * Cutting a hair off makes every cell hold the tail of one letter and the head of the next, and the inventory
 * swells from letters to letter PAIRS -- measured here as 24 signs where there were 8. Placing the boundary
 * where the ink is thinnest cannot find it: a cursive script set solid has no thin column at the boundary at
 * all. Down the page the boundary does fall in real blank space between lines, so least ink settles it there.
 *
 * This runs before lines exist on purpose: a CJK line cannot be found from strokes, whose heights carry no line
 * scale, and an Arabic line cannot be found from word blobs.
 */
function latticeGraphemes(
  mask: InkMask,
  pitchX: number,
  pitchY: number,
  stroke: number
): { graphemes: GlyphComponent[]; occupancy: number; credible: boolean } {
  const { ink, width, height } = mask;
  const stepX = Math.max(1, Math.round(pitchX));
  const stepY = Math.max(1, Math.round(pitchY));
  if (stepX <= 1 || stepY <= 1) return { graphemes: [], occupancy: 1, credible: false };

  let offsetY = 0;
  let leastInk = Number.POSITIVE_INFINITY;
  for (let offset = 0; offset < stepY; offset++) {
    let total = 0;
    for (let y = offset; y < height; y += stepY) {
      for (let x = 0; x < width; x++) total += ink[y * width + x]!;
    }
    if (total < leastInk) {
      leastInk = total;
      offsetY = offset;
    }
  }

  // Is the page set on a lattice at all? A real one leaves its boundaries in blank space, so the best phase
  // carries far less ink than a typical one. The phases themselves are the null: when the boundary could fall
  // anywhere for all the difference it makes, there is no lattice. Measured, blank paper's best phase carries
  // 90 per cent of the average column against 0 to 42 per cent for written pages, and it is not an outlier
  // among phases at all. A cell must also be wider than the stroke that drew the marks in it.
  const boundaryInkPerPhase: number[] = [];
  for (let offset = 0; offset < stepX; offset++) {
    let total = 0;
    let columns = 0;
    for (let x = offset; x < width; x += stepX) {
      columns += 1;
      for (let y = 0; y < height; y++) total += ink[y * width + x]!;
    }
    boundaryInkPerPhase.push(columns ? total / columns : 0);
  }
  const phaseMean = boundaryInkPerPhase.reduce((a, b) => a + b, 0) / Math.max(1, boundaryInkPerPhase.length);
  let phaseVariance = 0;
  for (const value of boundaryInkPerPhase) phaseVariance += (value - phaseMean) ** 2;
  const phaseSpread = Math.sqrt(phaseVariance / Math.max(1, boundaryInkPerPhase.length));
  const quietest = Math.min(...boundaryInkPerPhase);
  const credible = stepX > Math.max(1, stroke) && phaseMean - quietest > phaseSpread;

  // One cheap pass per candidate phase: how many DISTINCT graphemes does it produce? The signature is the cell's
  // ink at the resolution the stroke can resolve, so two cells count as one sign when they carry the same mark.
  const signatureCols = Math.max(1, Math.round(stepX / Math.max(1, stroke)));
  const signatureRows = Math.max(1, Math.round(stepY / Math.max(1, stroke)));
  let offsetX = 0;
  let fewestDistinct = Number.POSITIVE_INFINITY;
  for (let offset = 0; offset < stepX; offset++) {
    const seen = new Map<string, number[]>();
    for (let y = 0; y < height; y++) {
      const cy = Math.floor((y - offsetY) / stepY);
      for (let x = 0; x < width; x++) {
        if (!ink[y * width + x]) continue;
        const cx = Math.floor((x - offset) / stepX);
        const key = `${cx},${cy}`;
        let cell = seen.get(key);
        if (!cell) {
          cell = new Array<number>(signatureCols * signatureRows).fill(0);
          seen.set(key, cell);
        }
        const sx = Math.min(signatureCols - 1, Math.floor(((x - offset - cx * stepX) * signatureCols) / stepX));
        const sy = Math.min(signatureRows - 1, Math.floor(((y - offsetY - cy * stepY) * signatureRows) / stepY));
        cell[sy * signatureCols + sx]! += 1;
      }
    }
    const distinct = new Set<string>();
    for (const cell of seen.values()) distinct.add(cell.map(v => (v > 0 ? 1 : 0)).join(""));
    if (distinct.size < fewestDistinct) {
      fewestDistinct = distinct.size;
      offsetX = offset;
    }
  }

  const cells = new Map<string, { x0: number; y0: number; x1: number; y1: number; area: number; sx: number; sy: number; cx: number; cy: number }>();
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if (!ink[y * width + x]) continue;
      const cx = Math.floor((x - offsetX) / stepX);
      const cy = Math.floor((y - offsetY) / stepY);
      const key = `${cx},${cy}`;
      const held = cells.get(key);
      if (!held) cells.set(key, { x0: x, y0: y, x1: x, y1: y, area: 1, sx: x, sy: y, cx, cy });
      else {
        if (x < held.x0) held.x0 = x;
        if (x > held.x1) held.x1 = x;
        if (y < held.y0) held.y0 = y;
        if (y > held.y1) held.y1 = y;
        held.area += 1;
        held.sx += x;
        held.sy += y;
      }
    }
  }

  const graphemes: GlyphComponent[] = [];
  for (const box of cells.values()) {
    const frameX = offsetX + box.cx * stepX;
    const frameY = offsetY + box.cy * stepY;
    const cellRaster: number[][] = Array.from({ length: stepY }, () => new Array<number>(stepX).fill(0));
    const raster: number[][] = Array.from(
      { length: box.y1 - box.y0 + 1 },
      () => new Array<number>(box.x1 - box.x0 + 1).fill(0)
    );
    for (let y = Math.max(0, frameY); y < Math.min(height, frameY + stepY); y++) {
      for (let x = Math.max(0, frameX); x < Math.min(width, frameX + stepX); x++) {
        if (!ink[y * width + x]) continue;
        cellRaster[y - frameY]![x - frameX] = 1;
        if (y >= box.y0 && y <= box.y1 && x >= box.x0 && x <= box.x1) raster[y - box.y0]![x - box.x0] = 1;
      }
    }
    graphemes.push({
      x0: box.x0, y0: box.y0, x1: box.x1, y1: box.y1,
      area: box.area,
      centroidX: box.sx / box.area,
      centroidY: box.sy / box.area,
      raster,
      cellRaster
    });
  }
  graphemes.sort((a, b) => a.y0 - b.y0 || a.x0 - b.x0);

  const counts = new Map<number, number>();
  for (const grapheme of graphemes) {
    const spanned = Math.max(1, Math.round((grapheme.x1 - grapheme.x0 + 1) / Math.max(1, stepX)));
    counts.set(spanned, (counts.get(spanned) ?? 0) + 1);
  }
  let occupancy = 1;
  let commonest = -1;
  for (const [size, howMany] of counts) {
    if (howMany > commonest) {
      commonest = howMany;
      occupancy = size;
    }
  }
  return { graphemes, occupancy, credible };
}

/**
 * Full layout of a page. Skew is removed in centroid space rather than by resampling pixels: the glyph rasters
 * stay exactly as captured, and a rotation-invariant shape signature reads a skewed mark correctly anyway.
 */
export function analyzePage(image: GrayImage, options: { grouping?: PageGrouping } = {}): PageLayout {
  const mask = binarize(image);
  const all = connectedComponents(mask.ink, mask.width, mask.height);
  const stroke = Math.max(1, mask.strokeWidth);

  // Specks are rejected by EXTENT, not area: marks share the scale of the hand or press that made them, while
  // area varies with how dense a letter is -- an area split throws away the thin letters. Two scales are only
  // distinguishable when they differ by more than the stroke that drew them.
  const extentOf = (c: GlyphComponent) => Math.max(c.x1 - c.x0 + 1, c.y1 - c.y0 + 1);
  const scaleSplit = acceptedSplit(all.map(extentOf), stroke);
  const attached = scaleSplit.accepted
    ? attachMarks(
      all.filter(c => extentOf(c) > scaleSplit.cut),
      all.filter(c => extentOf(c) <= scaleSplit.cut),
      stroke
    )
    : { marks: [...all], specks: [] as GlyphComponent[] };
  const marks = attached.marks;
  const speckles = attached.specks;

  const grouping = options.grouping ?? "marks";
  const extents = marks.map(extentOf).sort((a, b) => a - b);
  // The page's own row periodicity over the rows that carry ink: how many bands of writing there are.
  const linePeriod = dominantLinePitch(mask.ink, mask.width, mask.height);
  let firstInkRow = -1;
  let lastInkRow = -1;
  for (let y = 0; y < mask.height; y++) {
    let any = false;
    for (let x = 0; x < mask.width && !any; x++) if (mask.ink[y * mask.width + x]) any = true;
    if (!any) continue;
    if (firstInkRow < 0) firstInkRow = y;
    lastInkRow = y;
  }
  const inkRows = firstInkRow < 0 ? 0 : lastInkRow - firstInkRow + 1;
  const expectedLines = linePeriod > 1 && inkRows > 0 ? Math.max(1, Math.round(inkRows / linePeriod)) : 0;

  const fallback = extents.length ? extents[extents.length >> 1]! : 0;
  const acrossPitch = grouping === "cells" ? dominantPitch(mask.ink, mask.width, mask.height) : 0;
  const downPitch = grouping === "cells" ? dominantLinePitch(mask.ink, mask.width, mask.height) : 0;
  const cellPitch = grouping !== "cells" ? 0 : (acrossPitch > 1 ? acrossPitch : fallback);
  const cellStepY = downPitch > 1 ? downPitch : fallback;
  const lattice = grouping === "cells"
    ? latticeGraphemes(mask, cellPitch, cellStepY, stroke)
    : { graphemes: marks as GlyphComponent[], occupancy: 1, credible: false };
  const graphemes = lattice.graphemes.length ? lattice.graphemes : (marks as GlyphComponent[]);

  const correction = estimateSkew(graphemes, stroke, mask.width);
  const cos = Math.cos(correction);
  const sin = Math.sin(correction);
  const placed = graphemes.map(c => ({
    component: c,
    x: c.centroidX * cos - c.centroidY * sin,
    y: c.centroidX * sin + c.centroidY * cos
  }));

  const heights = graphemes.map(c => c.y1 - c.y0 + 1).sort((a, b) => a - b);
  const glyphHeight = heights.length ? heights[heights.length >> 1]! : 0;
  const widths = graphemes.map(c => c.x1 - c.x0 + 1).sort((a, b) => a - b);
  const glyphWidth = widths.length ? widths[widths.length >> 1]! : 0;
  const glyphGrid = grouping === "cells" && cellPitch > 1 && cellStepY > 1
    ? {
      cols: Math.max(1, Math.round(cellPitch / stroke)),
      rows: Math.max(1, Math.round(cellStepY / stroke))
    }
    : {
      cols: Math.max(1, Math.round(glyphWidth / stroke)),
      rows: Math.max(1, Math.round(glyphHeight / stroke))
    };

  placed.sort((a, b) => a.y - b.y);
  // An image with no ink has no lines. Gap grouping always returns one group, so without this a blank capture
  // would index a grapheme that is not there.
  const lineGrouping = placed.length
    ? groupByGaps(placed.slice(1).map((p, i) => p.y - placed[i]!.y), glyphHeight)
    : { groups: [] as number[][], accepted: false, margin: 0 };

  const lines: PageLine[] = [];
  for (const group of lineGrouping.groups) {
    const inLine = group.map(i => placed[i]!).sort((a, b) => a.x - b.x);
    const gaps = inLine.slice(1).map((p, i) => p.component.x0 - inLine[i]!.component.x1 - 1);
    const wordGroups = groupByGaps(gaps, stroke).groups;
    lines.push({ words: wordGroups.map(w => ({ glyphs: w.map(i => inLine[i]!.component) })) });
  }

  // Reported skew is the page's own tilt: the negation of the rotation that corrects it.
  return {
    skewRadians: -correction,
    lines,
    speckles,
    scaleSplit,
    glyphGrid,
    grouping,
    cellPitch,
    lineSplit: { accepted: lineGrouping.accepted, margin: lineGrouping.margin, count: lines.length },
    cellOccupancy: lattice.occupancy,
    extentDispersion: extentDispersionOf(graphemes),
    latticeCredible: lattice.credible,
    expectedLines,
    mask
  };
}
