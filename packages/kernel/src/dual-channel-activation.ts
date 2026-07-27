import { personalizedRandomWalkWithRestart, type RelationTransitionPolicy } from "./ppf.js";
import type { GraphEdge, GraphNode, NodeId } from "./types.js";

/**
 * Plan items 150-152. Positive and contradiction evidence are activated
 * through two entirely separate PPR runs over `ppf.ts`'s existing
 * personalized-random-walk implementation -- never summed or subtracted
 * into one signed scalar. "No signed-mass cancellation" (item 150) is
 * therefore a property of this module's structure, not a rule it has to
 * remember to enforce at combination time: there is no code path anywhere
 * here that computes `positive - contradiction`.
 *
 * Reservation (item 151) then guarantees a small set of node classes --
 * exact anchors, open obligations, any node carrying real contradiction
 * mass, and the leading alternative(s) -- a slot in the final ranked
 * output regardless of how their raw positive-channel mass alone would
 * have ranked them. This is the real mechanism behind item 152: a
 * high-frequency, high-positive-mass cluster of fluent structures cannot
 * push a low-frequency but real contradictory fact out of the output,
 * because that fact's reservation is independent of its positive rank.
 */

export interface DualChannelActivationInput {
  nodes: readonly GraphNode[];
  positiveEdges: readonly GraphEdge[];
  contradictionEdges: readonly GraphEdge[];
  personalization: readonly { nodeId: NodeId; weight: number }[];
  relationPolicies: readonly RelationTransitionPolicy[];
  restartProbability?: number;
}

export interface DualChannelActivationResult {
  positiveMass: Map<string, number>;
  contradictionMass: Map<string, number>;
}

export function computeDualChannelActivation(input: DualChannelActivationInput): DualChannelActivationResult {
  const shared = {
    nodes: input.nodes,
    personalization: input.personalization,
    relationPolicies: input.relationPolicies,
    ...(input.restartProbability !== undefined ? { restartProbability: input.restartProbability } : {})
  };
  const positive = personalizedRandomWalkWithRestart({ ...shared, edges: input.positiveEdges });
  const contradiction = personalizedRandomWalkWithRestart({ ...shared, edges: input.contradictionEdges });
  return {
    positiveMass: new Map(positive.map(entry => [String(entry.nodeId), entry.mass])),
    contradictionMass: new Map(contradiction.map(entry => [String(entry.nodeId), entry.mass]))
  };
}

export interface ReservationInput {
  exactAnchorIds?: readonly string[];
  obligationIds?: readonly string[];
  leadingAlternativeIds?: readonly string[];
  budget: number;
}

export interface RankedActivationNode {
  nodeId: string;
  positiveMass: number;
  contradictionMass: number;
  reserved: boolean;
  reservationReasons: string[];
}

/**
 * Ranks every node by positive-channel mass, then guarantees a slot for
 * every reserved node (regardless of its positive rank), truncated to
 * `budget` -- but reserved nodes are never truncated away themselves, so
 * a genuine reservation can legitimately widen the effective output past
 * a naive top-`budget` cut when there are more reserved nodes than the
 * budget alone would have included.
 */
export function rankWithReservations(
  result: DualChannelActivationResult,
  input: ReservationInput
): RankedActivationNode[] {
  const exactAnchors = new Set(input.exactAnchorIds ?? []);
  const obligations = new Set(input.obligationIds ?? []);
  const leadingAlternatives = new Set(input.leadingAlternativeIds ?? []);
  const allNodeIds = new Set([...result.positiveMass.keys(), ...result.contradictionMass.keys()]);

  const nodes: RankedActivationNode[] = [...allNodeIds].map(nodeId => {
    const contradictionMass = result.contradictionMass.get(nodeId) ?? 0;
    const reasons: string[] = [];
    if (exactAnchors.has(nodeId)) reasons.push("exact_anchor");
    if (obligations.has(nodeId)) reasons.push("open_obligation");
    if (contradictionMass > 0) reasons.push("real_contradiction_mass");
    if (leadingAlternatives.has(nodeId)) reasons.push("leading_alternative");
    return {
      nodeId,
      positiveMass: result.positiveMass.get(nodeId) ?? 0,
      contradictionMass,
      reserved: reasons.length > 0,
      reservationReasons: reasons
    };
  });

  nodes.sort((left, right) => right.positiveMass - left.positiveMass || left.nodeId.localeCompare(right.nodeId));

  const reserved = nodes.filter(node => node.reserved);
  const unreserved = nodes.filter(node => !node.reserved);
  const reservedIds = new Set(reserved.map(node => node.nodeId));
  const remainingBudget = Math.max(0, input.budget - reserved.length);
  const filledFromUnreserved = unreserved.slice(0, remainingBudget);

  return [...reserved, ...filledFromUnreserved]
    .filter((node, index, all) => all.findIndex(candidate => candidate.nodeId === node.nodeId) === index)
    .sort((left, right) => {
      const leftReserved = reservedIds.has(left.nodeId) ? 0 : 1;
      const rightReserved = reservedIds.has(right.nodeId) ? 0 : 1;
      return leftReserved - rightReserved || right.positiveMass - left.positiveMass || left.nodeId.localeCompare(right.nodeId);
    });
}
