/**
 * Plan item 97. Discontinuous construction support (interleave/move):
 * a construction realized as multiple, possibly out-of-order surface
 * spans rather than one contiguous span --
 * `reversible-construction.ts`'s `ReversibleConstructionSurfaceSlot`
 * assumes a single contiguous `sourceUtf16Start`/`sourceUtf16End`, which
 * cannot represent this. Additive here rather than changing that type.
 */

export interface DiscontinuousSurfaceSpan {
  id: string;
  /** Logical reading order within the construction -- independent of byte position, which is what makes this discontinuous/movable. */
  order: number;
  utf16Start: number;
  utf16End: number;
  portIds: string[];
}

export interface DiscontinuousConstruction {
  id: string;
  spans: DiscontinuousSurfaceSpan[];
}

export interface DiscontinuousConstructionValidation {
  valid: boolean;
  reasons: string[];
}

/**
 * Real structural validity checks: no two spans may overlap in byte
 * range (each source byte belongs to at most one span -- overlap would
 * mean the same source material is claimed by two different port
 * bindings), no span may have start >= end, and no two spans may share
 * the same logical order (an ambiguous reading order is not a legal
 * discontinuous construction).
 */
export function validateDiscontinuousConstruction(construction: DiscontinuousConstruction): DiscontinuousConstructionValidation {
  const reasons: string[] = [];
  const orders = new Set<number>();
  for (const span of construction.spans) {
    if (span.utf16Start >= span.utf16End) reasons.push(`span ${span.id} has non-positive length`);
    if (orders.has(span.order)) reasons.push(`duplicate logical order ${span.order} (span ${span.id})`);
    orders.add(span.order);
  }
  const sortedByStart = [...construction.spans].sort((left, right) => left.utf16Start - right.utf16Start);
  for (let i = 1; i < sortedByStart.length; i++) {
    const previous = sortedByStart[i - 1]!;
    const current = sortedByStart[i]!;
    if (current.utf16Start < previous.utf16End) {
      reasons.push(`spans ${previous.id} and ${current.id} overlap in byte range`);
    }
  }
  return { valid: reasons.length === 0, reasons };
}

/**
 * Reassembles the construction's logical (reading-order) surface text
 * from real source text and each span's own byte coordinates -- ordered
 * by `order`, not by byte position, which is exactly what makes this
 * different from `reversible-construction.ts`'s contiguous-span
 * reconstruction.
 */
export function reassembleLogicalSurface(construction: DiscontinuousConstruction, sourceText: string): string {
  const validation = validateDiscontinuousConstruction(construction);
  if (!validation.valid) throw new Error(`cannot reassemble an invalid discontinuous construction: ${validation.reasons.join("; ")}`);
  return [...construction.spans]
    .sort((left, right) => left.order - right.order)
    .map(span => sourceText.slice(span.utf16Start, span.utf16End))
    .join(" ");
}

/**
 * Moves a span to a new logical position -- the real "move" transform
 * for a discontinuous construction. Only the `order` field changes; byte
 * coordinates and port bindings are preserved exactly, and the result is
 * re-validated (a move that collides with another span's order is
 * refused, not silently accepted).
 */
export function moveSpan(construction: DiscontinuousConstruction, spanId: string, newOrder: number): DiscontinuousConstruction {
  const span = construction.spans.find(candidate => candidate.id === spanId);
  if (!span) throw new Error(`unknown span: ${spanId}`);
  const moved: DiscontinuousConstruction = {
    id: construction.id,
    spans: construction.spans.map(candidate => candidate.id === spanId ? { ...candidate, order: newOrder } : candidate)
  };
  const validation = validateDiscontinuousConstruction(moved);
  if (!validation.valid) throw new Error(`move refused: ${validation.reasons.join("; ")}`);
  return moved;
}

/**
 * Interleaves two constructions' spans into one combined logical order
 * (e.g. "not X but Y" interleaving a negation construction's spans with a
 * contrast construction's spans) -- both inputs' own byte coordinates and
 * port bindings are preserved unchanged; only a fresh, gap-free logical
 * order is assigned across the union, alternating by whichever input
 * still has spans remaining in its own original order.
 */
export function interleaveConstructions(
  first: DiscontinuousConstruction,
  second: DiscontinuousConstruction,
  combinedId: string
): DiscontinuousConstruction {
  const firstSorted = [...first.spans].sort((left, right) => left.order - right.order);
  const secondSorted = [...second.spans].sort((left, right) => left.order - right.order);
  const combined: DiscontinuousSurfaceSpan[] = [];
  let order = 0;
  let i = 0;
  let j = 0;
  while (i < firstSorted.length || j < secondSorted.length) {
    if (i < firstSorted.length) combined.push({ ...firstSorted[i]!, order: order++ });
    i += 1;
    if (j < secondSorted.length) combined.push({ ...secondSorted[j]!, order: order++ });
    j += 1;
  }
  const result: DiscontinuousConstruction = { id: combinedId, spans: combined };
  const validation = validateDiscontinuousConstruction(result);
  if (!validation.valid) throw new Error(`interleave refused: ${validation.reasons.join("; ")}`);
  return result;
}
