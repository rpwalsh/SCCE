/**
 * Plan items 148-149. Local residual PPR push (Andersen-Chung-Lang,
 * "Local Graph Partitioning using PageRank Vectors", 2006) -- an additive,
 * separate algorithm from `ppf.ts`'s global sparse power iteration. That
 * module resolves a full `GraphNode`/`GraphEdge`/`RelationTransitionPolicy`
 * graph and iterates the *whole* transition operator to convergence; this
 * module explores only a bounded local neighborhood around a seed, at the
 * cost of taking an already-resolved directed weighted adjacency as input
 * (relation-policy resolution -- direction, learned inverses -- is
 * `ppf.ts`'s concern, not duplicated here).
 *
 * `ppf.ts`'s own `residualL1` diagnostic field is an unrelated notion: it
 * is the algebraic/Bellman-style residual of the *global* power iteration
 * (`|r_(k+1) - r_k|`, how close successive full iterates are), not this
 * module's per-node PPR-push residual (`r[u]`, literally undistributed
 * probability mass still sitting at node `u`). Do not conflate the two:
 * this module never reads or writes `ppf.ts`'s `residualL1`.
 */

import type { NodeId } from "./types.js";

export interface LocalPushEdge {
  from: NodeId;
  to: NodeId;
  weight: number;
}

export interface LocalPushGraph {
  nodes: readonly NodeId[];
  edges: readonly LocalPushEdge[];
}

export interface LocalPushInput {
  graph: LocalPushGraph;
  seedNodeId: NodeId;
  /** Teleport probability. Must be in (0, 1]. */
  alpha: number;
  /** A node is pushed once its residual mass (per unit out-degree, or total for a dangling node) exceeds this. */
  epsilon: number;
  maxPushes?: number;
}

export interface LocalPushResult {
  /** Approximate PPR mass, keyed by node id (only nodes that ever received nonzero mass are present). */
  pi: Map<string, number>;
  /** Remaining undistributed residual mass, keyed by node id. */
  residual: Map<string, number>;
  pushes: number;
  converged: boolean;
}

const DEFAULT_MAX_PUSHES = 1_000_000;

export function localPushPersonalizedPageRank(input: LocalPushInput): LocalPushResult {
  if (!(input.alpha > 0 && input.alpha <= 1)) throw new Error("alpha must be in (0, 1]");
  if (!(input.epsilon > 0)) throw new Error("epsilon must be positive");
  const outEdges = new Map<string, LocalPushEdge[]>();
  for (const edge of input.graph.edges) {
    if (!(edge.weight > 0)) throw new Error(`edge ${String(edge.from)}->${String(edge.to)} must have positive weight`);
    const bucket = outEdges.get(String(edge.from)) ?? [];
    bucket.push(edge);
    outEdges.set(String(edge.from), bucket);
  }
  const outDegree = new Map<string, number>();
  for (const [from, edges] of outEdges) outDegree.set(from, edges.reduce((sum, edge) => sum + edge.weight, 0));

  const pi = new Map<string, number>();
  const residual = new Map<string, number>([[String(input.seedNodeId), 1]]);
  const maxPushes = input.maxPushes ?? DEFAULT_MAX_PUSHES;

  let pushes = 0;
  let converged = false;
  while (pushes < maxPushes) {
    const candidate = mostPushableNode(residual, outDegree, input.epsilon);
    if (!candidate) { converged = true; break; }
    push(candidate, String(input.seedNodeId), input.alpha, outEdges, outDegree, pi, residual);
    pushes += 1;
  }

  return { pi, residual, pushes, converged };
}

function mostPushableNode(
  residual: ReadonlyMap<string, number>,
  outDegree: ReadonlyMap<string, number>,
  epsilon: number
): string | undefined {
  let best: string | undefined;
  let bestScore = epsilon;
  for (const [nodeId, mass] of residual) {
    if (mass <= 0) continue;
    const degree = outDegree.get(nodeId) ?? 0;
    // A dangling node's whole residual is "pushable" mass (there is no
    // out-degree to normalize by); compare it directly against epsilon
    // rather than dividing by zero.
    const score = degree > 0 ? mass / degree : mass;
    if (score > bestScore) { best = nodeId; bestScore = score; }
  }
  return best;
}

function push(
  nodeId: string,
  seedNodeId: string,
  alpha: number,
  outEdges: ReadonlyMap<string, LocalPushEdge[]>,
  outDegree: ReadonlyMap<string, number>,
  pi: Map<string, number>,
  residual: Map<string, number>
): void {
  const mass = residual.get(nodeId) ?? 0;
  const degree = outDegree.get(nodeId) ?? 0;
  pi.set(nodeId, (pi.get(nodeId) ?? 0) + alpha * mass);
  const continuing = (1 - alpha) * mass;
  if (degree <= 0) {
    // Dangling node: there is no out-edge to carry the non-teleported
    // share, so -- matching ppf.ts's own convention ("dangling rows
    // transition to the normalized personalization distribution") -- it is
    // re-injected as residual at the seed rather than silently dropped.
    // Losing it here would break the mass-conservation property this
    // algorithm exists to guarantee (the `|pi-pihat|_1 = |r|_1` invariant
    // only holds if every unit of removed residual lands somewhere).
    residual.set(seedNodeId, (residual.get(seedNodeId) ?? 0) + continuing);
    residual.set(nodeId, 0);
    return;
  }
  for (const edge of outEdges.get(nodeId) ?? []) {
    const share = continuing * (edge.weight / degree);
    const key = String(edge.to);
    residual.set(key, (residual.get(key) ?? 0) + share);
  }
  residual.set(nodeId, 0);
}
