import { solveTaskSchedule, verifyTaskScheduleOrder } from "./task-schedule-solver.js";

/**
 * Plan items 221-222. A hierarchical document planner (document/section/
 * subsection/paragraph goals) with coverage, sibling order, reference, and
 * rhetorical-dependency tracking -- reusing task-schedule-solver.ts for the
 * real precedence problem (`rhetoricalDependsOnIds`) rather than a
 * parallel/duplicated scheduler, the same pattern
 * hierarchical-task-decomposition.ts already established. The property
 * this module exists to guarantee: resuming or revising at a section
 * boundary never touches an already-completed section's content.
 */

export type DocumentPlanNodeKind = "document" | "section" | "subsection" | "paragraph";

export interface DocumentPlanNode {
  id: string;
  kind: DocumentPlanNodeKind;
  parentId?: string;
  order: number;
  goal: string;
  requiredCoverageIds: string[];
  referenceIds: string[];
  rhetoricalDependsOnIds: string[];
  satisfiedCoverageIds: string[];
  completed: boolean;
  content?: string;
}

export interface DocumentPlan {
  nodes: Record<string, DocumentPlanNode>;
}

export const EMPTY_DOCUMENT_PLAN: DocumentPlan = { nodes: {} };

export interface AddDocumentPlanNodeInput {
  id: string;
  kind: DocumentPlanNodeKind;
  parentId?: string;
  order: number;
  goal: string;
  requiredCoverageIds?: readonly string[];
  referenceIds?: readonly string[];
  rhetoricalDependsOnIds?: readonly string[];
}

export function addDocumentPlanNode(plan: DocumentPlan, input: AddDocumentPlanNodeInput): DocumentPlan {
  if (plan.nodes[input.id]) throw new Error(`document plan node already exists: ${input.id}`);
  if (input.parentId !== undefined && !plan.nodes[input.parentId]) {
    throw new Error(`document plan node ${input.id} declares unknown parent: ${input.parentId}`);
  }
  for (const dependencyId of input.rhetoricalDependsOnIds ?? []) {
    if (!plan.nodes[dependencyId]) throw new Error(`document plan node ${input.id} depends on unknown node: ${dependencyId}`);
  }
  const node: DocumentPlanNode = {
    id: input.id,
    kind: input.kind,
    ...(input.parentId !== undefined ? { parentId: input.parentId } : {}),
    order: input.order,
    goal: input.goal,
    requiredCoverageIds: [...(input.requiredCoverageIds ?? [])],
    referenceIds: [...(input.referenceIds ?? [])],
    rhetoricalDependsOnIds: [...(input.rhetoricalDependsOnIds ?? [])],
    satisfiedCoverageIds: [],
    completed: false
  };
  return { nodes: { ...plan.nodes, [node.id]: node } };
}

export function childrenOf(plan: DocumentPlan, parentId: string): DocumentPlanNode[] {
  return Object.values(plan.nodes)
    .filter(node => node.parentId === parentId)
    .sort((left, right) => left.order - right.order || left.id.localeCompare(right.id));
}

/** The rhetorical-dependency ordering, real input for task-schedule-solver.ts. */
export function rhetoricalOrder(plan: DocumentPlan): string[] {
  const subtasks = Object.values(plan.nodes)
    .map(node => ({ id: node.id, dependencyIds: node.rhetoricalDependsOnIds }))
    .sort((left, right) => left.id.localeCompare(right.id));
  const result = solveTaskSchedule(subtasks);
  if (result.status === "infeasible") {
    throw new Error(`document plan has a rhetorical-dependency cycle: ${result.cycle.join(" -> ")}`);
  }
  if (!verifyTaskScheduleOrder(subtasks, result.order)) {
    throw new Error("document plan rhetorical order failed its own round-trip verification");
  }
  return result.order;
}

/**
 * Every incomplete *leaf* node (a container node's own completion is a
 * rollup of its children's real generated content, not separate
 * generative work of its own) whose rhetorical dependencies are already
 * satisfied -- exactly the set of work resuming/revising this plan needs
 * to do next. Completed nodes are never included, and this function never
 * reads or copies a completed node's `content` -- resuming genuinely
 * cannot rebuild it, because nothing here ever touches it.
 */
export function pendingDocumentPlanNodes(plan: DocumentPlan): DocumentPlanNode[] {
  const order = rhetoricalOrder(plan);
  const completed = new Set(Object.values(plan.nodes).filter(node => node.completed).map(node => node.id));
  const hasChildren = new Set(Object.values(plan.nodes).flatMap(node => node.parentId ? [node.parentId] : []));
  return order
    .map(id => plan.nodes[id]!)
    .filter(node =>
      !node.completed
      && !hasChildren.has(node.id)
      && node.rhetoricalDependsOnIds.every(dependencyId => completed.has(dependencyId)));
}

export interface CompleteDocumentPlanNodeInput {
  nodeId: string;
  content: string;
  satisfiedCoverageIds: readonly string[];
}

export function completeDocumentPlanNode(plan: DocumentPlan, input: CompleteDocumentPlanNodeInput): DocumentPlan {
  const node = plan.nodes[input.nodeId];
  if (!node) throw new Error(`unknown document plan node: ${input.nodeId}`);
  if (node.completed) throw new Error(`document plan node already completed: ${input.nodeId}`);
  const unmetDependencies = node.rhetoricalDependsOnIds.filter(dependencyId => !plan.nodes[dependencyId]?.completed);
  if (unmetDependencies.length) {
    throw new Error(`cannot complete ${input.nodeId}: rhetorical dependencies not yet satisfied: ${unmetDependencies.join(", ")}`);
  }
  const satisfied = new Set([...node.satisfiedCoverageIds, ...input.satisfiedCoverageIds]);
  const unmetCoverage = node.requiredCoverageIds.filter(coverageId => !satisfied.has(coverageId));
  if (unmetCoverage.length) {
    throw new Error(`cannot complete ${input.nodeId}: required coverage not satisfied: ${unmetCoverage.join(", ")}`);
  }
  return {
    nodes: {
      ...plan.nodes,
      [node.id]: {
        ...node,
        satisfiedCoverageIds: [...satisfied],
        completed: true,
        content: input.content
      }
    }
  };
}
