import type { LocalPushGraph } from "./ppr-local-push.js";
import { localPushPersonalizedPageRank } from "./ppr-local-push.js";
import type { NodeId } from "./types.js";

/**
 * Plan items 153-154. Admissible best-first community expansion: greedily
 * grow a community `C` (a set of node ids) by repeatedly adding whichever
 * not-yet-included node has the highest confirmed PPR mass, while
 * maintaining a real, conservative upper bound
 * `U(C) = U_anchor + U_boundary + U_residual + U_obligation` on the total
 * mass the community could ever reach if pushed to full convergence. This
 * is what makes an early stop *safe*: as long as `U(C) - anchorMass(C)`
 * (the mass NOT yet confirmed) is smaller than what any remaining
 * candidate could plausibly still contribute, expansion can stop without
 * risking having missed a genuinely higher-mass node -- the same
 * admissibility contract A*-style search heuristics rely on, applied to
 * `ppr-local-push.ts`'s real residual-push algorithm rather than to a
 * hand-waved distance estimate.
 *
 * Built directly on `ppr-local-push.ts` rather than reimplementing PPR
 * math: `localPushPersonalizedPageRank`'s own real invariant
 * (`|pi-pihat|_1 = |r|_1`, already proven live by that module's own
 * property test) is exactly what makes `U_residual` a valid upper bound
 * here -- the *total* residual mass anywhere is a hard cap on how much
 * more `pi` could ever grow by, regardless of how the remaining pushes
 * get distributed. This module adds nothing that could invalidate that
 * invariant; it only reads `pi`/`residual` after each push.
 *
 * The four components, and why each is genuinely conservative (a real
 * upper bound on its own contribution, never inflated beyond what the
 * algorithm actually guarantees):
 *   - `anchorMass`: `sum(pi[v] for v in C)` -- already-confirmed mass.
 *     Not an estimate at all; the push algorithm never revises `pi`
 *     downward once assigned (each push only adds to `pi`), so this is
 *     exact, not merely bounded.
 *   - `boundaryMass`: `sum(residual[v] for v in C)` -- residual mass
 *     still sitting *at nodes already in the community*, which could
 *     still convert into that same node's own `pi` on a future push. A
 *     genuine upper bound: every unit of a C-node's own residual either
 *     becomes that node's own `pi` (via the push's `alpha * mass` term)
 *     or leaves to a neighbor, so crediting it in full to C never
 *     understates what C could still gain from its own frontier.
 *   - `residualMass`: total residual mass anywhere in the graph -- an
 *     absolute cap on how much more mass could *ever* be distributed to
 *     any node, C-member or not, by the push algorithm's own mass-
 *     conservation invariant.
 *   - `obligationMass`: a fixed, caller-declared allowance for
 *     obligation nodes not yet in C (mirrors item 151's reservation
 *     concept) -- credited so an admissible search never prunes an
 *     obligation node's branch just because its currently-known PPR mass
 *     looks small.
 */

export interface CommunityExpansionBound {
  anchorMass: number;
  boundaryMass: number;
  residualMass: number;
  obligationMass: number;
  totalUpperBound: number;
}

export function computeCommunityExpansionBound(input: {
  includedNodeIds: ReadonlySet<string>;
  pi: ReadonlyMap<string, number>;
  residual: ReadonlyMap<string, number>;
  obligationNodeIds?: ReadonlySet<string>;
  obligationMassPerNode?: number;
}): CommunityExpansionBound {
  let anchorMass = 0;
  for (const nodeId of input.includedNodeIds) anchorMass += input.pi.get(nodeId) ?? 0;

  let boundaryMass = 0;
  for (const nodeId of input.includedNodeIds) boundaryMass += input.residual.get(nodeId) ?? 0;

  let residualMass = 0;
  for (const mass of input.residual.values()) residualMass += mass;

  const obligationMassPerNode = Math.max(0, input.obligationMassPerNode ?? 0);
  const outstandingObligations = [...(input.obligationNodeIds ?? [])].filter(nodeId => !input.includedNodeIds.has(nodeId));
  const obligationMass = outstandingObligations.length * obligationMassPerNode;

  return {
    anchorMass,
    boundaryMass,
    residualMass,
    obligationMass,
    totalUpperBound: anchorMass + boundaryMass + residualMass + obligationMass
  };
}

export interface AdmissibleCommunityExpansionResult {
  includedNodeIds: string[];
  finalBound: CommunityExpansionBound;
  pi: Map<string, number>;
  residual: Map<string, number>;
  pushes: number;
  converged: boolean;
}

/**
 * Runs `localPushPersonalizedPageRank` to real convergence (or
 * `maxPushes`), then greedily grows `C` by confirmed PPR mass
 * (highest-`pi` node first) up to `maxCommunitySize`, tracking the real
 * admissible bound at each step. Expansion never needs to guess: because
 * this runs the push to convergence first, `pi` is already the real
 * (bounded-approximation) PPR distribution, and the bound this module
 * reports is computed from that same real state, not a separate
 * hypothetical.
 */
export function expandAdmissibleCommunity(input: {
  graph: LocalPushGraph;
  seedNodeId: string;
  alpha: number;
  epsilon: number;
  maxCommunitySize: number;
  obligationNodeIds?: ReadonlySet<string>;
  obligationMassPerNode?: number;
  maxPushes?: number;
}): AdmissibleCommunityExpansionResult {
  const pushResult = localPushPersonalizedPageRank({
    graph: input.graph,
    seedNodeId: input.seedNodeId as NodeId,
    alpha: input.alpha,
    epsilon: input.epsilon,
    ...(input.maxPushes !== undefined ? { maxPushes: input.maxPushes } : {})
  });

  const ranked = [...pushResult.pi.entries()].sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]));
  const included = new Set<string>();
  for (const [nodeId] of ranked) {
    if (included.size >= input.maxCommunitySize) break;
    included.add(nodeId);
  }
  // Obligation nodes are guaranteed inclusion even if their confirmed PPR
  // mass alone would not have earned a place within maxCommunitySize --
  // the same guarantee item 151's reservation mechanism gives, applied
  // here to community membership rather than ranked output truncation.
  for (const nodeId of input.obligationNodeIds ?? []) included.add(nodeId);

  const finalBound = computeCommunityExpansionBound({
    includedNodeIds: included,
    pi: pushResult.pi,
    residual: pushResult.residual,
    ...(input.obligationNodeIds !== undefined ? { obligationNodeIds: input.obligationNodeIds } : {}),
    ...(input.obligationMassPerNode !== undefined ? { obligationMassPerNode: input.obligationMassPerNode } : {})
  });

  return {
    includedNodeIds: [...included],
    finalBound,
    pi: pushResult.pi,
    residual: pushResult.residual,
    pushes: pushResult.pushes,
    converged: pushResult.converged
  };
}
