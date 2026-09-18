// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
//
// A line of writing is not always straight. Handwriting drifts, a spray can follows the arm's arc, a page
// photographed off a curved book bends in the middle. One angle cannot describe any of those, and a page whose
// baseline curves by more than a glyph's height stops falling into bands at all -- which is the measurement the
// eye uses to find its lines, so the page becomes unreadable for a reason that has nothing to do with its
// marks.
//
// So the baseline is fitted as a FIELD, y = f(x), rather than estimated as a rotation. The fit is a piecewise
// linear path over knots, by iteratively reweighted least squares so that a few marks far off the line -- a
// descender, a speck, a mark from the line above -- cannot drag it. Marks are then measured against their own
// local baseline instead of a global one.
//
// How bendy the field is allowed to be is not chosen. Knot counts are tried and scored by BIC, which charges
// each knot against the residuals it buys, so a straight page gets a straight field and only a page that
// really curves pays for the bends. A field is used at all only where it makes the marks fall into bands more
// decisively than a single angle does.

/** A mark's position along the writing and across it. */
export interface BaselinePoint {
  readonly along: number;
  readonly across: number;
}

export interface BaselineField {
  /** Knot positions along the writing, ascending. */
  readonly knots: readonly number[];
  /** The field's height at each knot. */
  readonly heights: readonly number[];
  /** Residual spread after the fit: how tightly the marks sit on it. */
  readonly spread: number;
  /** BIC of this fit, which is what chose the number of knots. */
  readonly bic: number;
}

/** The field's height at a point, linear between knots and flat beyond the ends. */
export function baselineAt(field: BaselineField, along: number): number {
  const { knots, heights } = field;
  if (!knots.length) return 0;
  if (along <= knots[0]!) return heights[0]!;
  if (along >= knots[knots.length - 1]!) return heights[heights.length - 1]!;
  for (let i = 1; i < knots.length; i++) {
    if (along > knots[i]!) continue;
    const span = knots[i]! - knots[i - 1]!;
    if (span <= 0) return heights[i]!;
    const t = (along - knots[i - 1]!) / span;
    return heights[i - 1]! * (1 - t) + heights[i]! * t;
  }
  return heights[heights.length - 1]!;
}

/** Basis weights of a point over the knots: linear interpolation expressed as a sparse row. */
function basisOf(knots: readonly number[], along: number): { left: number; right: number; weight: number } {
  if (along <= knots[0]!) return { left: 0, right: 0, weight: 1 };
  const last = knots.length - 1;
  if (along >= knots[last]!) return { left: last, right: last, weight: 1 };
  for (let i = 1; i < knots.length; i++) {
    if (along > knots[i]!) continue;
    const span = knots[i]! - knots[i - 1]!;
    const t = span > 0 ? (along - knots[i - 1]!) / span : 0;
    return { left: i - 1, right: i, weight: 1 - t };
  }
  return { left: last, right: last, weight: 1 };
}

/**
 * Fit heights at fixed knots by iteratively reweighted least squares. Each iteration solves the weighted normal
 * equations for a tridiagonal system -- which is what linear interpolation over ordered knots gives -- then
 * reweights each mark by how far it sits from the fit, so outliers stop pulling on it.
 */
function fitHeights(points: readonly BaselinePoint[], knots: readonly number[], rounds = 4): number[] {
  const n = knots.length;
  const heights = new Array<number>(n).fill(0);
  let weights = points.map(() => 1);

  for (let round = 0; round < rounds; round++) {
    // Normal equations for a tridiagonal system, assembled from the two basis weights each point touches.
    const diagonal = new Float64Array(n);
    const upper = new Float64Array(n);
    const rhs = new Float64Array(n);
    points.forEach((point, index) => {
      const { left, right, weight } = basisOf(knots, point.along);
      const w = weights[index]!;
      const a = weight;
      const b = 1 - weight;
      diagonal[left]! += w * a * a;
      diagonal[right]! += w * b * b;
      if (left !== right) upper[left]! += w * a * b;
      rhs[left]! += w * a * point.across;
      rhs[right]! += w * b * point.across;
    });
    // A knot no mark reaches keeps its neighbour's height rather than dividing by zero.
    for (let i = 0; i < n; i++) if (diagonal[i]! <= 0) diagonal[i] = 1e-9;

    // Thomas algorithm for the symmetric tridiagonal solve.
    const c = new Float64Array(n);
    const d = new Float64Array(n);
    c[0] = upper[0]! / diagonal[0]!;
    d[0] = rhs[0]! / diagonal[0]!;
    for (let i = 1; i < n; i++) {
      const denominator = diagonal[i]! - upper[i - 1]! * c[i - 1]!;
      const safe = Math.abs(denominator) < 1e-12 ? 1e-12 : denominator;
      c[i] = (i + 1 < n ? upper[i]! : 0) / safe;
      d[i] = (rhs[i]! - upper[i - 1]! * d[i - 1]!) / safe;
    }
    heights[n - 1] = d[n - 1]!;
    for (let i = n - 2; i >= 0; i--) heights[i] = d[i]! - c[i]! * heights[i + 1]!;

    // Reweight: a mark one robust spread off the fit counts half, two off counts a quarter.
    const field: BaselineField = { knots, heights, spread: 0, bic: 0 };
    const residuals = points.map(point => Math.abs(point.across - baselineAt(field, point.along)));
    const ordered = [...residuals].sort((a, b) => a - b);
    const median = ordered[ordered.length >> 1] ?? 0;
    const scale = Math.max(1e-6, median);
    weights = residuals.map(residual => 1 / (1 + (residual / scale) ** 2));
  }
  return heights;
}

function scoreField(points: readonly BaselinePoint[], knots: readonly number[]): BaselineField {
  const heights = fitHeights(points, knots);
  const field: BaselineField = { knots, heights, spread: 0, bic: 0 };
  let sum = 0;
  for (const point of points) sum += (point.across - baselineAt(field, point.along)) ** 2;
  const n = Math.max(1, points.length);
  const spread = Math.sqrt(sum / n);
  // BIC charges each knot against the residuals it bought, so bends are paid for rather than assumed.
  const bic = n * Math.log(Math.max(1e-12, sum / n)) + knots.length * Math.log(n);
  return { knots, heights, spread, bic };
}

/**
 * Fit the baseline field of one band of marks, choosing how bendy it may be by BIC. One knot is a flat line and
 * two is a straight tilt, so a straight page costs nothing extra; more knots are admitted only where the
 * residuals they buy outweigh what they cost.
 */
export function fitBaselineField(points: readonly BaselinePoint[], maxKnots = 8): BaselineField {
  if (points.length < 2) {
    const across = points.length ? points[0]!.across : 0;
    return { knots: [0], heights: [across], spread: 0, bic: 0 };
  }
  const lowest = Math.min(...points.map(point => point.along));
  const highest = Math.max(...points.map(point => point.along));
  if (!(highest > lowest)) {
    const mean = points.reduce((sum, point) => sum + point.across, 0) / points.length;
    return { knots: [lowest], heights: [mean], spread: 0, bic: 0 };
  }

  // A knot needs marks to stand on: never more knots than there are marks to support them.
  const ceiling = Math.max(1, Math.min(maxKnots, Math.floor(points.length / 3)));
  let best: BaselineField | undefined;
  for (let count = 1; count <= ceiling; count++) {
    const knots = count === 1
      ? [(lowest + highest) / 2]
      : Array.from({ length: count }, (_, i) => lowest + ((highest - lowest) * i) / (count - 1));
    const field = scoreField(points, knots);
    if (!best || field.bic < best.bic) best = field;
  }
  return best!;
}

/** Marks measured against their own local baseline: what makes a curved page fall into bands. */
export function straighten(points: readonly BaselinePoint[], field: BaselineField): number[] {
  return points.map(point => point.across - baselineAt(field, point.along));
}

/**
 * Estimate the curvature every line on the page shares, without knowing where the lines are. Marks are binned
 * along the writing, and each bin's spread of positions across it is cross-correlated with the bin before,
 * which says how far the whole set of lines has shifted between them. Cumulating those shifts gives the field's
 * shape up to a constant, and the constant does not matter because bands are found by their gaps.
 *
 * This is what breaks the circularity. A field fitted to all the marks at once returns their mean and says
 * nothing; a field fitted per line needs the lines, which is what the field is for. Correlating bins needs
 * neither: it measures how the page moves, not where its lines are.
 */
export function estimateSharedCurvature(
  points: readonly BaselinePoint[],
  binWidth: number,
  maxShift: number
): BaselineField {
  if (points.length < 4 || binWidth <= 0) return { knots: [0], heights: [0], spread: 0, bic: 0 };
  const lowest = Math.min(...points.map(point => point.along));
  const highest = Math.max(...points.map(point => point.along));
  const bins = Math.max(2, Math.ceil((highest - lowest) / binWidth));
  if (bins < 2) return { knots: [0], heights: [0], spread: 0, bic: 0 };

  const lowestAcross = Math.min(...points.map(point => point.across));
  const highestAcross = Math.max(...points.map(point => point.across));
  const height = Math.max(2, Math.ceil(highestAcross - lowestAcross) + 1);
  const shift = Math.max(1, Math.round(maxShift));

  const profiles: Float64Array[] = Array.from({ length: bins }, () => new Float64Array(height));
  for (const point of points) {
    const bin = Math.min(bins - 1, Math.floor((point.along - lowest) / binWidth));
    const at = Math.min(height - 1, Math.max(0, Math.round(point.across - lowestAcross)));
    profiles[bin]![at]! += 1;
  }

  const offsets = new Array<number>(bins).fill(0);
  for (let bin = 1; bin < bins; bin++) {
    const previous = profiles[bin - 1]!;
    const current = profiles[bin]!;
    let best = -1;
    let bestShift = 0;
    for (let candidate = -shift; candidate <= shift; candidate++) {
      let score = 0;
      for (let at = 0; at < height; at++) {
        const other = at + candidate;
        if (other < 0 || other >= height) continue;
        score += previous[at]! * current[other]!;
      }
      // Ties prefer no movement, so a bin with nothing to say does not invent a bend.
      if (score > best || (score === best && Math.abs(candidate) < Math.abs(bestShift))) {
        best = score;
        bestShift = candidate;
      }
    }
    offsets[bin] = offsets[bin - 1]! + bestShift;
  }

  const knots = Array.from({ length: bins }, (_, bin) => lowest + binWidth * (bin + 0.5));
  const field: BaselineField = { knots, heights: offsets, spread: 0, bic: 0 };
  let sum = 0;
  for (const point of points) {
    const residual = point.across - baselineAt(field, point.along);
    sum += residual * residual;
  }
  return { knots, heights: offsets, spread: Math.sqrt(sum / points.length), bic: 0 };
}
