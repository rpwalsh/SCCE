import type { TaskDecompositionGraph, TaskDecompositionNode } from "./hierarchical-task-decomposition.js";

/**
 * Plan items 180-181. Replanning after a meaningful observation, built
 * directly on `hierarchical-task-decomposition.ts`'s real typed DAG
 * (items 158-159) rather than a separate plan representation: a
 * "meaningful observation" here is real evidence that some previously-
 * assumed condition no longer holds. Reuses every completed node whose
 * own preconditions and claimed postconditions are *not* touched by the
 * observation -- real completed work is never redone just because
 * something unrelated changed. A node whose own precondition is
 * invalidated, complete or not, is genuinely blocked from executing
 * until that condition is re-established, never silently allowed through.
 */

export interface ReplanObservation {
  /** Condition ids a real new observation has invalidated -- no longer true, even though some node's plan assumed they were. */
  invalidatedConditionIds: readonly string[];
}

export interface ReplanResult {
  graph: TaskDecompositionGraph;
  /** Previously-completed nodes whose own preconditions and claimed postconditions are untouched by this observation -- real work, reused, not restarted. */
  reusedNodeIds: string[];
  /** Previously-completed nodes reset to incomplete because the observation invalidated something they depended on or claimed. */
  invalidatedNodeIds: string[];
  /** Nodes (complete or not) that cannot execute right now because a real precondition they need is currently invalidated. */
  blockedNodeIds: string[];
}

export function replan(graph: TaskDecompositionGraph, observation: ReplanObservation): ReplanResult {
  const invalidated = new Set(observation.invalidatedConditionIds);
  const reused: string[] = [];
  const invalidatedNodeIds: string[] = [];
  const nodes: Record<string, TaskDecompositionNode> = { ...graph.nodes };

  for (const node of Object.values(graph.nodes)) {
    if (!node.completed) continue;
    const preconditionsStillHold = node.preconditions.every(conditionId => !invalidated.has(conditionId));
    const claimedPostconditionsStillHold = node.satisfiedConditionIds.every(conditionId => !invalidated.has(conditionId));
    if (preconditionsStillHold && claimedPostconditionsStillHold) {
      reused.push(node.id);
      continue;
    }
    invalidatedNodeIds.push(node.id);
    nodes[node.id] = {
      ...node,
      completed: false,
      satisfiedConditionIds: node.satisfiedConditionIds.filter(conditionId => !invalidated.has(conditionId))
    };
  }

  const updatedGraph: TaskDecompositionGraph = { nodes };
  const blockedNodeIds = Object.values(updatedGraph.nodes)
    .filter(node => !node.completed && node.preconditions.some(conditionId => invalidated.has(conditionId)))
    .map(node => node.id)
    .sort();

  return {
    graph: updatedGraph,
    reusedNodeIds: reused.sort(),
    invalidatedNodeIds: invalidatedNodeIds.sort(),
    blockedNodeIds
  };
}

/**
 * Plan item 181's real, direct check: whether `nodeId` may execute given
 * the currently-held (real, observed-true) condition set. A node whose
 * own precondition is not in that set is refused outright, never allowed
 * through on an assumption that it probably still holds.
 */
export function nodeCanExecute(
  graph: TaskDecompositionGraph,
  nodeId: string,
  currentlyHeldConditionIds: ReadonlySet<string>
): { allowed: boolean; reason?: string } {
  const node = graph.nodes[nodeId];
  if (!node) throw new Error(`unknown task decomposition node: ${nodeId}`);
  if (node.completed) return { allowed: false, reason: "already completed" };
  const unmet = node.preconditions.filter(conditionId => !currentlyHeldConditionIds.has(conditionId));
  if (unmet.length > 0) {
    return { allowed: false, reason: `precondition(s) no longer held: ${unmet.join(", ")}` };
  }
  return { allowed: true };
}
