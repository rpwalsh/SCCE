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

/**
 * Everything a target's type says about it.
 *
 * The four-case lookup read four of a target's twelve fields and ignored the relation it belongs to, the role
 * and port it fills, the kind of value it carries, the participant it names and the incidence that produced it.
 * Two targets filling the same role of the same relation were exactly as far apart as two with nothing whatever
 * in common, which is a statement about what the lookup could express and not about the graph.
 */
function typedFeatures(target: SparseAlignmentTarget): string[] {
  const out = [`kind:${target.kind}`, `relation:${target.relationId}`, `relationNode:${target.relationNodeId}`, `hyperedge:${target.hyperedgeId}`];
  if (target.roleId) out.push(`role:${target.roleId}`);
  if (target.portId) out.push(`port:${target.portId}`);
  if (target.valueKind) out.push(`valueKind:${target.valueKind}`);
  if (target.participantNodeId) out.push(`participant:${target.participantNodeId}`);
  if (target.incidenceId) out.push(`incidence:${target.incidenceId}`);
  if (target.realization) out.push(`realization:${target.realization}`);
  return out;
}

export interface GraphTargetGeometry {
  /** Distance in [0, 1]; 0 is the same target and 1 is unrelated within the radius searched. */
  distance(left: SparseAlignmentTarget, right: SparseAlignmentTarget): number;
  /** What the walk found, for the audit that reports whether the metric discriminated at all. */
  audit(): {
    targets: number;
    radius: number;
    walks: number;
    resolvedBeyondOneHop: number;
    resolvedByType: number;
    typeFeatures: number;
  };
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

  // How much each type feature is worth, from how rare it is among the targets in play.
  //
  // A weight has to come from somewhere and the alternative to measuring it is picking it, which is what the
  // four constants were. A feature every target carries distinguishes nothing and earns nothing; one carried by
  // a handful is what actually separates them. This is inverse document frequency over the target set, so the
  // weights are a property of the graph slice being aligned rather than of anyone's judgement.
  const featureCounts = new Map<string, number>();
  const featuresById = new Map<string, string[]>();
  for (const target of all) {
    const features = typedFeatures(target);
    featuresById.set(target.id, features);
    for (const feature of features) featureCounts.set(feature, (featureCounts.get(feature) ?? 0) + 1);
  }
  const featureWeight = (feature: string): number =>
    Math.log(1 + all.length / Math.max(1, featureCounts.get(feature) ?? 1));

  /** One minus the share of type weight two targets hold in common: a weighted Jaccard over their features. */
  const typedDistance = (left: SparseAlignmentTarget, right: SparseAlignmentTarget): number => {
    const leftFeatures = featuresById.get(left.id) ?? typedFeatures(left);
    const rightFeatures = new Set(featuresById.get(right.id) ?? typedFeatures(right));
    let shared = 0;
    let union = 0;
    const seen = new Set<string>();
    for (const feature of leftFeatures) {
      seen.add(feature);
      const weight = featureWeight(feature);
      union += weight;
      if (rightFeatures.has(feature)) shared += weight;
    }
    for (const feature of rightFeatures) {
      if (seen.has(feature)) continue;
      union += featureWeight(feature);
    }
    return union > 0 ? Math.max(0, Math.min(1, 1 - shared / union)) : 1;
  };

  const walked = new Map<string, Map<string, number>>();
  let walks = 0;
  let resolvedBeyondOneHop = 0;
  let resolvedByType = 0;

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
      // Three readings of the same pair, and the nearest wins.
      //
      // What a target is and where it sits are different kinds of proximity and either is evidence: two targets
      // filling one role of one relation are close however far apart the incidence walk puts them, and two
      // adjacent in the walk are close whatever their types. Taking the smallest also makes this monotone
      // against the lookup it replaces -- the old cases are still floors, so no pair is coarser than before and
      // the 99.7% that used to be flat 1 can only come down.
      const lookup = left.relationNodeId === right.relationNodeId
        ? (left.kind !== right.kind ? SAME_RELATION_DIFFERENT_KIND : SAME_RELATION_SAME_KIND)
        : left.hyperedgeId === right.hyperedgeId ? SAME_HYPEREDGE : 1;
      if (lookup <= SAME_HYPEREDGE) return lookup;
      const hops = hopsFrom(left.id).get(right.id);
      const walkDistance = hops === undefined
        ? 1
        : Math.min(1, SAME_HYPEREDGE + (1 - SAME_HYPEREDGE) * (hops - 1) / bounded);
      if (hops !== undefined) resolvedBeyondOneHop++;
      const typed = typedDistance(left, right);
      if (typed < 1) resolvedByType++;
      return Math.min(lookup, walkDistance, typed);
    },
    audit: () => ({
      targets: all.length,
      radius: bounded,
      walks,
      resolvedBeyondOneHop,
      resolvedByType,
      typeFeatures: featureCounts.size
    })
  };
}

function index(into: Map<string, string[]>, key: string | undefined, id: string): void {
  if (!key) return;
  const bucket = into.get(key);
  if (bucket) bucket.push(id);
  else into.set(key, [id]);
}
