/**
 * Plan items 158-159. A typed hierarchical task-decomposition DAG:
 * precedence (`prec`), preconditions (`pre`), postconditions (`post`),
 * cost, and risk per node -- distinct from `task-schedule-solver.ts`'s
 * flat precedence scheduling (which this can use once a task's
 * subtasks are known, see `schedulableSubtasks` below) and from
 * `working-memory.ts`'s scratch state (a decomposition node is a real
 * plan-graph fact, not provisional reasoning). The one property this
 * module exists to guarantee: a parent task can never be marked complete
 * while any required child postcondition is still unsatisfied.
 */

export interface TaskDecompositionNode {
  id: string;
  parentId?: string;
  /** Other nodes (any parent) whose completion this node requires before it may start -- the `prec` relation. */
  precedesRequiresIds: string[];
  /** Conditions that must already hold before this node may be marked complete, independent of children -- `pre`. */
  preconditions: string[];
  /** Conditions this node's completion is claimed to establish -- `post`. */
  postconditions: string[];
  cost: number;
  risk: number;
  satisfiedConditionIds: string[];
  completed: boolean;
}

export interface TaskDecompositionGraph {
  nodes: Record<string, TaskDecompositionNode>;
}

export const EMPTY_TASK_DECOMPOSITION: TaskDecompositionGraph = { nodes: {} };

export interface AddTaskDecompositionNodeInput {
  id: string;
  parentId?: string;
  precedesRequiresIds?: readonly string[];
  preconditions?: readonly string[];
  postconditions?: readonly string[];
  cost: number;
  risk: number;
}

export function addTaskDecompositionNode(
  graph: TaskDecompositionGraph,
  input: AddTaskDecompositionNodeInput
): TaskDecompositionGraph {
  if (graph.nodes[input.id]) throw new Error(`task decomposition node already exists: ${input.id}`);
  if (input.parentId !== undefined && !graph.nodes[input.parentId]) {
    throw new Error(`task decomposition node ${input.id} declares unknown parent: ${input.parentId}`);
  }
  for (const requiredId of input.precedesRequiresIds ?? []) {
    if (!graph.nodes[requiredId]) throw new Error(`task decomposition node ${input.id} requires unknown node: ${requiredId}`);
  }
  const node: TaskDecompositionNode = {
    id: input.id,
    ...(input.parentId !== undefined ? { parentId: input.parentId } : {}),
    precedesRequiresIds: [...(input.precedesRequiresIds ?? [])],
    preconditions: [...(input.preconditions ?? [])],
    postconditions: [...(input.postconditions ?? [])],
    cost: input.cost,
    risk: input.risk,
    satisfiedConditionIds: [],
    completed: false
  };
  return { nodes: { ...graph.nodes, [node.id]: node } };
}

export function childrenOf(graph: TaskDecompositionGraph, parentId: string): TaskDecompositionNode[] {
  return Object.values(graph.nodes)
    .filter(node => node.parentId === parentId)
    .sort((left, right) => left.id.localeCompare(right.id));
}

/**
 * Which of `nodeId`'s own required postconditions are not yet satisfied by
 * itself or, transitively, by every one of its children's postconditions.
 * A node's completion claim is only as good as the conditions it and its
 * subtree actually established.
 */
export function unsatisfiedRequiredPostconditions(graph: TaskDecompositionGraph, nodeId: string): string[] {
  const node = graph.nodes[nodeId];
  if (!node) throw new Error(`unknown task decomposition node: ${nodeId}`);
  const established = new Set(node.satisfiedConditionIds);
  for (const child of childrenOf(graph, nodeId)) {
    for (const conditionId of child.satisfiedConditionIds) established.add(conditionId);
  }
  return node.postconditions.filter(conditionId => !established.has(conditionId));
}

export interface CompleteTaskDecompositionNodeInput {
  nodeId: string;
  satisfiedConditionIds: readonly string[];
}

/**
 * Marks a node complete only if every one of its own required
 * postconditions is actually established (by itself or by its children) --
 * a parent cannot be marked complete while a required child postcondition
 * remains unsatisfied (plan item 159).
 */
export function completeTaskDecompositionNode(
  graph: TaskDecompositionGraph,
  input: CompleteTaskDecompositionNodeInput
): TaskDecompositionGraph {
  const node = graph.nodes[input.nodeId];
  if (!node) throw new Error(`unknown task decomposition node: ${input.nodeId}`);
  if (node.completed) throw new Error(`task decomposition node already completed: ${input.nodeId}`);
  const incomplete = childrenOf(graph, input.nodeId).filter(child => !child.completed);
  if (incomplete.length) {
    throw new Error(`cannot complete ${input.nodeId}: child task(s) not yet complete: ${incomplete.map(child => child.id).join(", ")}`);
  }
  const updatedNode: TaskDecompositionNode = {
    ...node,
    satisfiedConditionIds: [...new Set([...node.satisfiedConditionIds, ...input.satisfiedConditionIds])]
  };
  const withConditions: TaskDecompositionGraph = { nodes: { ...graph.nodes, [node.id]: updatedNode } };
  const stillUnsatisfied = unsatisfiedRequiredPostconditions(withConditions, input.nodeId);
  if (stillUnsatisfied.length) {
    throw new Error(`cannot complete ${input.nodeId}: required postcondition(s) not satisfied: ${stillUnsatisfied.join(", ")}`);
  }
  return { nodes: { ...withConditions.nodes, [node.id]: { ...updatedNode, completed: true } } };
}

/** The subset of a decomposition graph shaped for task-schedule-solver.ts's precedence scheduler. */
export function schedulableSubtasks(graph: TaskDecompositionGraph): Array<{ id: string; dependencyIds: readonly string[] }> {
  return Object.values(graph.nodes)
    .map(node => ({ id: node.id, dependencyIds: node.precedesRequiresIds }))
    .sort((left, right) => left.id.localeCompare(right.id));
}
