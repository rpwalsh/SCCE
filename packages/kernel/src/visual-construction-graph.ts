// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
//
// Some writing is not a line of signs. An Egyptian quadrat packs two or three signs into a square block, a Maya
// glyph block nests a main sign with affixes around it, and an Aztec composition puts one sign inside another.
// Flattening those to a string throws away the arrangement, and the arrangement is the grammar.
//
// A group of signs is represented here as a typed spatial graph: the signs are the nodes and the edges say how
// they sit -- LEFT_OF, ABOVE, INSIDE, OVERLAPS, ALIGNED_WITH. What makes the representation useful is that it
// CANONICALISES: two instances of the same construction, drawn at different sizes on different parts of the
// page by different hands, produce the same key, because the key is built from the relations and the signs, not
// from any coordinate. That is what lets a construction be counted, and counting is what lets description
// length decide whether it is one unit (see visual-unit-induction).
//
// Every relation is decided against the group's own measured scale, never a fixed tolerance in pixels.

import { clusterByDistance } from "./visual-sign-inventory.js";

/** A sign placed on the page: its identity and the box it occupies. */
export interface PlacedSign {
  readonly sign: number;
  readonly x0: number;
  readonly y0: number;
  readonly x1: number;
  readonly y1: number;
}

export type SpatialRelation = "LEFT_OF" | "ABOVE" | "INSIDE" | "CONTAINS" | "OVERLAPS" | "ALIGNED_WITH";

export interface SpatialEdge {
  /** Index into the construction's signs. */
  readonly from: number;
  readonly to: number;
  readonly relation: SpatialRelation;
}

export interface Construction {
  /** Signs in canonical order: the order the key is built in, not reading order. */
  readonly signs: readonly PlacedSign[];
  readonly edges: readonly SpatialEdge[];
  /**
   * Identical for two instances of the same arrangement of the same signs, whatever their size or position.
   * Two constructions are the same construction exactly when their keys match.
   */
  readonly key: string;
}

const width = (sign: PlacedSign) => sign.x1 - sign.x0 + 1;
const height = (sign: PlacedSign) => sign.y1 - sign.y0 + 1;
const area = (sign: PlacedSign) => width(sign) * height(sign);

function overlap(lowA: number, highA: number, lowB: number, highB: number): number {
  return Math.max(0, Math.min(highA, highB) - Math.max(lowA, lowB) + 1);
}

/**
 * The relation between two placed signs, decided against the smaller one's own size rather than any fixed
 * tolerance. Containment is checked first because a sign inside another is also, uselessly, above and left of
 * parts of it; separation on an axis is preferred to overlap because it is the stronger statement.
 */
export function relationBetween(a: PlacedSign, b: PlacedSign): SpatialRelation {
  const insideB = a.x0 >= b.x0 && a.x1 <= b.x1 && a.y0 >= b.y0 && a.y1 <= b.y1;
  const insideA = b.x0 >= a.x0 && b.x1 <= a.x1 && b.y0 >= a.y0 && b.y1 <= a.y1;
  if (insideB && !insideA) return "INSIDE";
  if (insideA && !insideB) return "CONTAINS";

  const horizontalOverlap = overlap(a.x0, a.x1, b.x0, b.x1);
  const verticalOverlap = overlap(a.y0, a.y1, b.y0, b.y1);
  const smallestWidth = Math.min(width(a), width(b));
  const smallestHeight = Math.min(height(a), height(b));

  // Clear of each other on an axis: the relation is that separation.
  if (horizontalOverlap === 0) return a.x1 < b.x0 ? "LEFT_OF" : "OVERLAPS";
  if (verticalOverlap === 0) return a.y1 < b.y0 ? "ABOVE" : "OVERLAPS";

  // Sharing an axis almost completely while separated on the other: a column or a row of the block.
  const sharesColumn = horizontalOverlap >= smallestWidth;
  const sharesRow = verticalOverlap >= smallestHeight;
  if (sharesColumn && !sharesRow) return a.y0 < b.y0 ? "ABOVE" : "OVERLAPS";
  if (sharesRow && !sharesColumn) return a.x0 < b.x0 ? "LEFT_OF" : "OVERLAPS";
  if (sharesRow && sharesColumn) return "ALIGNED_WITH";
  return "OVERLAPS";
}

/**
 * Canonicalise a group of placed signs into a construction. Nodes are ordered by sign identity first and by
 * their relative place within the group second, both measured off the group's own bounding box, so the order --
 * and therefore the key -- does not depend on where the group sits or how big it is. Ties in sign identity and
 * position are broken by relative area, and any that remain leave the order as found, which is deterministic.
 */
export function canonicalConstruction(group: readonly PlacedSign[]): Construction {
  if (!group.length) return { signs: [], edges: [], key: "" };

  const left = Math.min(...group.map(s => s.x0));
  const top = Math.min(...group.map(s => s.y0));
  const right = Math.max(...group.map(s => s.x1));
  const bottom = Math.max(...group.map(s => s.y1));
  const spanX = Math.max(1, right - left + 1);
  const spanY = Math.max(1, bottom - top + 1);
  const blockArea = spanX * spanY;

  // Relative place and size within the group, quantised at the resolution the group itself can resolve: with n
  // signs, placements finer than 1/(2n) of the block are not distinguishable arrangements.
  const grain = Math.max(2, group.length * 2);
  const quantise = (value: number) => Math.round(value * grain);
  const describe = (sign: PlacedSign) => ({
    sign: sign.sign,
    qx: quantise((sign.x0 - left) / spanX),
    qy: quantise((sign.y0 - top) / spanY),
    qa: quantise(area(sign) / blockArea)
  });

  const ordered = group
    .map((sign, index) => ({ sign, index, at: describe(sign) }))
    .sort((a, b) =>
      a.at.sign - b.at.sign
      || a.at.qy - b.at.qy
      || a.at.qx - b.at.qx
      || b.at.qa - a.at.qa
      || a.index - b.index);

  const signs = ordered.map(entry => entry.sign);
  const edges: SpatialEdge[] = [];
  for (let i = 0; i < signs.length; i++) {
    for (let j = i + 1; j < signs.length; j++) {
      edges.push({ from: i, to: j, relation: relationBetween(signs[i]!, signs[j]!) });
    }
  }

  const nodeKey = ordered.map(entry => `${entry.at.sign}@${entry.at.qy},${entry.at.qx}`).join(" ");
  const edgeKey = edges.map(edge => `${edge.from}-${edge.relation}-${edge.to}`).join(" ");
  return { signs, edges, key: `${nodeKey}|${edgeKey}` };
}

/**
 * Gather placed signs into spatial groups, by joining any two whose separation is smaller than the gaps that
 * separate groups -- the same question the page asks of lines and words, asked in two dimensions.
 */
export function groupIntoConstructions(signs: readonly PlacedSign[]): PlacedSign[][] {
  if (signs.length < 2) return signs.length ? [[...signs]] : [];

  const separation = (a: PlacedSign, b: PlacedSign) => {
    const dx = Math.max(0, Math.max(a.x0 - b.x1, b.x0 - a.x1) - 1);
    const dy = Math.max(0, Math.max(a.y0 - b.y1, b.y0 - a.y1) - 1);
    return Math.hypot(dx, dy);
  };

  // Single-link over the minimal connections, not over every pair. Applied to all pairs the void rule sees the
  // redundant long gaps -- block one to block three as well as block one to block two -- and the widest
  // relative void falls among those, joining neighbouring blocks. A spanning tree keeps only the nearest
  // connection between any two groups, which is why the sign inventory cuts its dendrogram the same way.
  const clustering = clusterByDistance(signs.length, (a, b) => separation(signs[a]!, signs[b]!));
  return clustering.groups.map(group => group.map(index => signs[index]!));
}

export interface ConstructionInventory {
  readonly constructions: readonly Construction[];
  /** How often each construction key occurs, so description length can decide whether it is one unit. */
  readonly occurrences: ReadonlyMap<string, number>;
}

/** Group a page's placed signs into constructions and count how often each arrangement recurs. */
export function readConstructions(signs: readonly PlacedSign[]): ConstructionInventory {
  const constructions = groupIntoConstructions(signs).map(canonicalConstruction);
  const occurrences = new Map<string, number>();
  for (const construction of constructions) {
    occurrences.set(construction.key, (occurrences.get(construction.key) ?? 0) + 1);
  }
  return { constructions, occurrences };
}
