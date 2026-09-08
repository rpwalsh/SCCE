// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
import type { SparseAlignmentTarget } from "./sparse-alignment-candidates.js";

/**
 * How far apart two graph targets are, measured on the graph rather than looked up in four cases.
 *
 * The fused transport's structural term compares a surface distance against a graph distance, so what the graph
 * contributes to an alignment is exactly the information in that metric. A four-case lookup -- same target, same
 * relation node, same hyperedge, otherwise one -- carries almost none of it. Measured over 800,000 target pairs
 * from a live graph of 44,892 hyperedges:
 *
 *     distance 0.20        2,016   0.25%
 *     distance 0.25          242   0.03%
 *     distance 1.00      797,742  99.72%
 *
 * Three values ever taken, a standard deviation of 0.042 on a unit metric, and 99.7% of pairs identical. Against
 * a constant the structural term reduces to a function of surface distance alone: the graph half of a fused
 * transport contributing nothing, while costing what it costs to compute.
 *
 * What is missing is not precision at short range -- those cases are right, and are kept exactly as they were --
 * but any gradient beyond it. Two targets three hops apart and two targets in unrelated components are the same
 * number, so nothing in the transport can prefer the near one. Hop distance over the incidence graph restores
 * that at a cost the transport can afford: targets are connected when they share a node or a hyperedge, and a
 * bounded breadth-first walk from each source gives the rest.
 *
 * The bound is what keeps this affordable and is honest about what it means: beyond the radius, distance is 1
 * because the walk stopped looking, not because the targets are known to be unrelated.
 */

/** How far the walk looks before calling a pair unrelated. */
export const GRAPH_TARGET_GEOMETRY_RADIUS = 4;

/** Same relation node in different roles: the tightest relation between distinct targets. */
const SAME_RELATION_DIFFERENT_KIND = 0.1;
/** Same relation node in the same role. */
const SAME_RELATION_SAME_KIND = 0.2;
/** Different relation nodes participating in one hyperedge. */
const SAME_HYPEREDGE = 0.25;

export interface GraphTargetGeometry {
  /** Distance in [0, 1]; 0 is the same target and 1 is unrelated within the radius searched. */
  distance(left: SparseAlignmentTarget, right: SparseAlignmentTarget): number;
  /** What the walk found, for the audit that reports whether the metric discriminated at all. */
  audit(): { targets: number; radius: number; walks: number; resolvedBeyondOneHop: number };
}

/**
 * A geometry over one bounded set of targets.
 *
 * Built per transport call from the targets that call will compare, so the walk stays inside material already in
 * memory and costs nothing on a graph nobody asked about. Results are memoised per source, because a transport
 * compares each source against many neighbours and the walk that answers one answers all of them.
 */
export function createGraphTargetGeometry(
  targets: Iterable<SparseAlignmentTarget>,
  radius: number = GRAPH_TARGET_GEOMETRY_RADIUS
): GraphTargetGeometry {
  const bounded = Math.max(1, Math.min(8, Math.floor(radius)));
  const all = [...targets];
  const byRelationNode = new Map<string, string[]>();
  const byHyperedge = new Map<string, string[]>();
  const byId = new Map<string, SparseAlignmentTarget>();
  for (const target of all) {
    byId.set(target.id, target);
    index(byRelationNode, target.relationNodeId, target.id);
    index(byHyperedge, target.hyperedgeId, target.id);
  }

  const walked = new Map<string, Map<string, number>>();
  let walks = 0;
  let resolvedBeyondOneHop = 0;

  /** Hop counts from one target outward, to the radius. Computed once per source and reused. */
  const hopsFrom = (sourceId: string): Map<string, number> => {
    const cached = walked.get(sourceId);
    if (cached) return cached;
    const hops = new Map<string, number>([[sourceId, 0]]);
    let frontier = [sourceId];
    for (let depth = 1; depth <= bounded && frontier.length; depth++) {
      const next: string[] = [];
      for (const id of frontier) {
        const target = byId.get(id);
        if (!target) continue;
        for (const neighbour of [
          ...(byRelationNode.get(target.relationNodeId) ?? []),
          ...(byHyperedge.get(target.hyperedgeId) ?? [])
        ]) {
          if (hops.has(neighbour)) continue;
          hops.set(neighbour, depth);
          next.push(neighbour);
        }
      }
      frontier = next;
    }
    walks++;
    walked.set(sourceId, hops);
    return hops;
  };

  return {
    distance(left, right) {
      if (left.id === right.id) return 0;
      // The short-range cases are exactly as they were: correct, and cheaper than a walk.
      if (left.relationNodeId === right.relationNodeId) {
        return left.kind !== right.kind ? SAME_RELATION_DIFFERENT_KIND : SAME_RELATION_SAME_KIND;
      }
      if (left.hyperedgeId === right.hyperedgeId) return SAME_HYPEREDGE;
      const hops = hopsFrom(left.id).get(right.id);
      if (hops === undefined) return 1;
      resolvedBeyondOneHop++;
      // Everything a walk can reach sits between the one-hop cases and unrelated, spread by how far it is.
      return Math.min(1, SAME_HYPEREDGE + (1 - SAME_HYPEREDGE) * (hops - 1) / bounded);
    },
    audit: () => ({ targets: all.length, radius: bounded, walks, resolvedBeyondOneHop })
  };
}

function index(into: Map<string, string[]>, key: string | undefined, id: string): void {
  if (!key) return;
  const bucket = into.get(key);
  if (bucket) bucket.push(id);
  else into.set(key, [id]);
}
