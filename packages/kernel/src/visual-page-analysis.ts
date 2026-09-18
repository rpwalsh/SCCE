// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
//
// Page -> ink -> glyphs -> words -> lines, with no trained model and no tuned constant: every threshold is an
// Otsu split of a histogram the image itself produced (intensity, component area, gap width).

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
  readonly mask: InkMask;
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

/** Split a run of items at their large gaps, keeping it whole when the gaps are one population. */
function groupByGaps(gaps: readonly number[], minMargin: number): number[][] {
  const items = gaps.length + 1;
  const whole = () => [[...Array(items).keys()]];
  if (gaps.length === 0) return whole();
  const split = acceptedSplit(gaps, minMargin);
  if (!split.accepted) return whole();
  const groups: number[][] = [[0]];
  for (let i = 1; i < items; i++) {
    if (gaps[i - 1]! > split.cut) groups.push([i]);
    else groups[groups.length - 1]!.push(i);
  }
  return groups;
}

/**
 * Full layout of a page. Skew is removed in centroid space rather than by resampling pixels: the glyph rasters
 * stay exactly as captured, and a rotation-invariant shape signature reads a skewed mark correctly anyway.
 */
export function analyzePage(image: GrayImage): PageLayout {
  const mask = binarize(image);
  const all = connectedComponents(mask.ink, mask.width, mask.height);
  const stroke = Math.max(1, mask.strokeWidth);

  // Specks are rejected by EXTENT, not area: marks share the scale of the hand or press that made them, while
  // area varies with how dense a letter is -- an area split throws away the thin letters. Two scales are only
  // distinguishable when they differ by more than the stroke that drew them.
  const extentOf = (c: GlyphComponent) => Math.max(c.x1 - c.x0 + 1, c.y1 - c.y0 + 1);
  const scaleSplit = acceptedSplit(all.map(extentOf), stroke);
  const marks = scaleSplit.accepted ? all.filter(c => extentOf(c) > scaleSplit.cut) : all;
  const speckles = scaleSplit.accepted ? all.filter(c => extentOf(c) <= scaleSplit.cut) : [];

  const correction = estimateSkew(marks, stroke, mask.width);
  const cos = Math.cos(correction);
  const sin = Math.sin(correction);
  const placed = marks.map(c => ({
    component: c,
    x: c.centroidX * cos - c.centroidY * sin,
    y: c.centroidX * sin + c.centroidY * cos
  }));

  const heights = marks.map(c => c.y1 - c.y0 + 1).sort((a, b) => a - b);
  const glyphHeight = heights.length ? heights[heights.length >> 1]! : 0;
  const widths = marks.map(c => c.x1 - c.x0 + 1).sort((a, b) => a - b);
  const glyphWidth = widths.length ? widths[widths.length >> 1]! : 0;
  const glyphGrid = {
    cols: Math.max(1, Math.round(glyphWidth / stroke)),
    rows: Math.max(1, Math.round(glyphHeight / stroke))
  };

  placed.sort((a, b) => a.y - b.y);
  const lineGroups = groupByGaps(placed.slice(1).map((p, i) => p.y - placed[i]!.y), glyphHeight);

  const lines: PageLine[] = [];
  for (const group of lineGroups) {
    const inLine = group.map(i => placed[i]!).sort((a, b) => a.x - b.x);
    const gaps = inLine.slice(1).map((p, i) => p.component.x0 - inLine[i]!.component.x1 - 1);
    const wordGroups = groupByGaps(gaps, stroke);
    lines.push({ words: wordGroups.map(w => ({ glyphs: w.map(i => inLine[i]!.component) })) });
  }

  // Reported skew is the page's own tilt: the negation of the rotation that corrects it.
  return { skewRadians: -correction, lines, speckles, scaleSplit, glyphGrid, mask };
}
