import {
  addDocumentPlanNode,
  childrenOf,
  type AddDocumentPlanNodeInput,
  type DocumentPlan,
  type DocumentPlanNode
} from "./document-plan.js";

/**
 * Plan items 227-228. Graph-preserving document revision
 * (move/merge/split/delete/insert/rewrite) built on a generic, exact
 * structural diff between a plan's before/after state -- rather than a
 * bespoke "inverse" hand-written per operation kind, which is where a
 * real inverse-operation implementation most often quietly drifts out of
 * sync with the forward one. Because every revision function here computes
 * its patch via `diffDocumentPlans`, reversibility is a property of the
 * diff mechanism itself, checked once, rather than re-proven per operation.
 */

export interface DocumentRevisionPatch {
  /** Full snapshots of nodes present before the revision and absent after -- restored verbatim by the inverse. */
  removed: DocumentPlanNode[];
  /** Full snapshots of nodes absent before and present after -- removed verbatim by the inverse. */
  added: DocumentPlanNode[];
  /** Nodes present in both, with differing content -- inverse restores `before`. */
  changed: Array<{ before: DocumentPlanNode; after: DocumentPlanNode }>;
}

function nodeEqual(left: DocumentPlanNode, right: DocumentPlanNode): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

export function diffDocumentPlans(before: DocumentPlan, after: DocumentPlan): DocumentRevisionPatch {
  const removed = Object.values(before.nodes).filter(node => !after.nodes[node.id]);
  const added = Object.values(after.nodes).filter(node => !before.nodes[node.id]);
  const changed = Object.values(before.nodes)
    .filter(node => after.nodes[node.id] && !nodeEqual(node, after.nodes[node.id]!))
    .map(node => ({ before: node, after: after.nodes[node.id]! }));
  return {
    removed: removed.sort((left, right) => left.id.localeCompare(right.id)),
    added: added.sort((left, right) => left.id.localeCompare(right.id)),
    changed: changed.sort((left, right) => left.before.id.localeCompare(right.before.id))
  };
}

export function applyDocumentRevisionPatch(plan: DocumentPlan, patch: DocumentRevisionPatch): DocumentPlan {
  const nodes = { ...plan.nodes };
  for (const node of patch.removed) delete nodes[node.id];
  for (const node of patch.added) nodes[node.id] = node;
  for (const change of patch.changed) nodes[change.after.id] = change.after;
  return { nodes };
}

/** The exact reverse of a patch -- applying it undoes the original revision, node for node. */
export function invertDocumentRevisionPatch(patch: DocumentRevisionPatch): DocumentRevisionPatch {
  return {
    removed: patch.added,
    added: patch.removed,
    changed: patch.changed.map(change => ({ before: change.after, after: change.before }))
  };
}

export interface DocumentRevisionResult {
  plan: DocumentPlan;
  patch: DocumentRevisionPatch;
}

function revise(before: DocumentPlan, buildAfter: (plan: DocumentPlan) => DocumentPlan): DocumentRevisionResult {
  const after = buildAfter(before);
  return { plan: after, patch: diffDocumentPlans(before, after) };
}

/** Every node id any node in the plan references, cites, or rhetorically depends on. */
function referencedNodeIds(plan: DocumentPlan): Set<string> {
  const ids = new Set<string>();
  for (const node of Object.values(plan.nodes)) {
    for (const id of node.referenceIds) ids.add(id);
    for (const id of node.rhetoricalDependsOnIds) ids.add(id);
  }
  return ids;
}

export function insertDocumentPlanNode(plan: DocumentPlan, input: AddDocumentPlanNodeInput): DocumentRevisionResult {
  return revise(plan, current => addDocumentPlanNode(current, input));
}

export function rewriteDocumentPlanNodeContent(plan: DocumentPlan, nodeId: string, newContent: string): DocumentRevisionResult {
  if (!plan.nodes[nodeId]) throw new Error(`unknown document plan node: ${nodeId}`);
  return revise(plan, current => ({ nodes: { ...current.nodes, [nodeId]: { ...current.nodes[nodeId]!, content: newContent } } }));
}

export function moveDocumentPlanNode(
  plan: DocumentPlan,
  nodeId: string,
  destination: { parentId?: string; order: number }
): DocumentRevisionResult {
  const node = plan.nodes[nodeId];
  if (!node) throw new Error(`unknown document plan node: ${nodeId}`);
  if (destination.parentId !== undefined && !plan.nodes[destination.parentId]) {
    throw new Error(`cannot move ${nodeId}: unknown destination parent ${destination.parentId}`);
  }
  return revise(plan, current => ({
    nodes: {
      ...current.nodes,
      [nodeId]: {
        ...current.nodes[nodeId]!,
        ...(destination.parentId !== undefined ? { parentId: destination.parentId } : { parentId: undefined }),
        order: destination.order
      }
    }
  }));
}

/**
 * Refuses to delete a node still cited/referenced/rhetorically depended on
 * by another node, or one with children -- this is exactly what
 * "maintaining references, citations, argument dependencies" means in
 * practice: a deletion that would silently orphan a citation is rejected,
 * not performed and then discovered broken later. Callers that genuinely
 * want to delete a referenced node must first re-point or remove the
 * referencing nodes' own references (a separate, explicit revision).
 */
export function deleteDocumentPlanNode(plan: DocumentPlan, nodeId: string): DocumentRevisionResult {
  if (!plan.nodes[nodeId]) throw new Error(`unknown document plan node: ${nodeId}`);
  if (childrenOf(plan, nodeId).length) throw new Error(`cannot delete ${nodeId}: it still has children`);
  const referencedBy = referencedNodeIds(plan);
  if (referencedBy.has(nodeId)) throw new Error(`cannot delete ${nodeId}: still referenced or rhetorically depended on by another node`);
  return revise(plan, current => {
    const nodes = { ...current.nodes };
    delete nodes[nodeId];
    return { nodes };
  });
}

/**
 * Combines two or more sibling nodes' content into one new node, removing
 * the sources -- their combined `requiredCoverageIds`/`referenceIds` carry
 * over so nothing they covered or cited is silently dropped.
 */
export function mergeDocumentPlanNodes(
  plan: DocumentPlan,
  input: { sourceNodeIds: readonly string[]; mergedNodeId: string; mergedContent: string; mergedGoal: string }
): DocumentRevisionResult {
  const sources = input.sourceNodeIds.map(id => {
    const node = plan.nodes[id];
    if (!node) throw new Error(`cannot merge: unknown node ${id}`);
    return node;
  });
  if (sources.length < 2) throw new Error("merging requires at least two source nodes");
  const parentIds = new Set(sources.map(node => node.parentId));
  if (parentIds.size > 1) throw new Error("cannot merge nodes with different parents");
  const referencedBy = referencedNodeIds(plan);
  for (const source of sources) {
    if (referencedBy.has(source.id)) throw new Error(`cannot merge: ${source.id} is still referenced by another node`);
  }
  return revise(plan, current => {
    const nodes = { ...current.nodes };
    for (const source of sources) delete nodes[source.id];
    const first = sources[0]!;
    nodes[input.mergedNodeId] = {
      id: input.mergedNodeId,
      kind: first.kind,
      ...(first.parentId !== undefined ? { parentId: first.parentId } : {}),
      order: Math.min(...sources.map(node => node.order)),
      goal: input.mergedGoal,
      requiredCoverageIds: [...new Set(sources.flatMap(node => node.requiredCoverageIds))],
      referenceIds: [...new Set(sources.flatMap(node => node.referenceIds))],
      rhetoricalDependsOnIds: [...new Set(sources.flatMap(node => node.rhetoricalDependsOnIds))],
      satisfiedCoverageIds: [...new Set(sources.flatMap(node => node.satisfiedCoverageIds))],
      completed: sources.every(node => node.completed),
      content: input.mergedContent
    };
    return { nodes };
  });
}

/** The inverse shape of merge: one node's content and coverage are distributed across newly declared nodes, and the original is removed. */
export function splitDocumentPlanNode(
  plan: DocumentPlan,
  input: { sourceNodeId: string; intoNodes: readonly (AddDocumentPlanNodeInput & { content?: string })[] }
): DocumentRevisionResult {
  const source = plan.nodes[input.sourceNodeId];
  if (!source) throw new Error(`cannot split: unknown node ${input.sourceNodeId}`);
  if (input.intoNodes.length < 2) throw new Error("splitting requires at least two destination nodes");
  const referencedBy = referencedNodeIds(plan);
  if (referencedBy.has(source.id)) throw new Error(`cannot split: ${source.id} is still referenced by another node`);
  return revise(plan, current => {
    let next: DocumentPlan = { nodes: { ...current.nodes } };
    delete next.nodes[source.id];
    for (const spec of input.intoNodes) {
      next = addDocumentPlanNode(next, spec);
      if (spec.content !== undefined) next = { nodes: { ...next.nodes, [spec.id]: { ...next.nodes[spec.id]!, content: spec.content } } };
    }
    return next;
  });
}

/**
 * The human-facing section numbering, derived fresh from current sibling
 * order every time rather than stored -- so numbering is never "stale"
 * after a revision, by construction, instead of requiring every revision
 * function to remember to update a persisted number.
 */
export function documentPlanSectionNumbers(plan: DocumentPlan, parentId?: string, prefix: string[] = []): Map<string, string> {
  const numbers = new Map<string, string>();
  const siblings = Object.values(plan.nodes)
    .filter(node => node.parentId === parentId)
    .sort((left, right) => left.order - right.order || left.id.localeCompare(right.id));
  siblings.forEach((node, index) => {
    const path = [...prefix, String(index + 1)];
    numbers.set(node.id, path.join("."));
    for (const [childId, childNumber] of documentPlanSectionNumbers(plan, node.id, path)) numbers.set(childId, childNumber);
  });
  return numbers;
}
