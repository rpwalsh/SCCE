// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
import type { TaskDecompositionGraph } from "./hierarchical-task-decomposition.js";
import type { WorkingMemoryState } from "./working-memory.js";
import type { Hasher } from "./types.js";
import { createHasher } from "./primitives.js";

/**
 * Plan items 217-218. Long-horizon task resumption: a real, single,
 * persisted snapshot combining the goal graph
 * (`hierarchical-task-decomposition.ts`'s real `TaskDecompositionGraph`,
 * items 158-159), a real working-memory summary
 * (`working-memory.ts`'s real promoted/provisional entry ids, items
 * 156-157), open hypotheses, artifacts, and receipts, all under one
 * stable, content-derived snapshot identity -- deliberately additive,
 * not a change to `executive-episode.ts`'s `ExecutiveGoal`/`ExecutiveTask`
 * (the core durable state machine every capability dispatcher wrapper
 * built this session depends on; extending its required shape is a
 * separate, higher-risk task not attempted here). This module only ever
 * references those real structures by id/value, never duplicates their
 * own storage or invents new state for them.
 */

export const TASK_RESUMPTION_SNAPSHOT_SCHEMA = "scce.task_resumption_snapshot.v1" as const;

export interface OpenHypothesis {
  id: string;
  summary: string;
  confidence: number;
}

export interface TaskResumptionSnapshot {
  schema: typeof TASK_RESUMPTION_SNAPSHOT_SCHEMA;
  /** Stable identity derived from this snapshot's real content -- the same real state always produces the same id. */
  id: string;
  goalId: string;
  taskGraph: TaskDecompositionGraph;
  workingMemorySummary: {
    promotedEntryIds: string[];
    provisionalEntryIds: string[];
  };
  openHypotheses: OpenHypothesis[];
  artifactIds: string[];
  receiptIds: string[];
  capturedAt: number;
}

type SnapshotCanonicalContent = Pick<TaskResumptionSnapshot, "goalId" | "taskGraph" | "workingMemorySummary" | "openHypotheses" | "artifactIds" | "receiptIds">;

/** The exact same canonical shape the snapshot id is hashed from, re-derivable from a snapshot's own already-canonicalized fields -- the real basis for `snapshotContentHashMatchesId`'s tamper check. */
function canonicalSnapshotContent(snapshot: SnapshotCanonicalContent): SnapshotCanonicalContent {
  return {
    goalId: snapshot.goalId,
    taskGraph: snapshot.taskGraph,
    workingMemorySummary: snapshot.workingMemorySummary,
    openHypotheses: [...snapshot.openHypotheses].sort((left, right) => left.id.localeCompare(right.id)),
    artifactIds: [...snapshot.artifactIds].sort(),
    receiptIds: [...snapshot.receiptIds].sort()
  };
}

function snapshotContentId(content: SnapshotCanonicalContent, hasher: Hasher): string {
  return `task_resumption_snapshot.${hasher.digestHex(JSON.stringify(content)).slice(0, 32)}`;
}

export function captureTaskResumptionSnapshot(input: {
  goalId: string;
  taskGraph: TaskDecompositionGraph;
  workingMemory: WorkingMemoryState;
  openHypotheses: readonly OpenHypothesis[];
  artifactIds: readonly string[];
  receiptIds: readonly string[];
  capturedAt: number;
  hasher?: Hasher;
}): TaskResumptionSnapshot {
  const hasher = input.hasher ?? createHasher();
  const entries = Object.values(input.workingMemory.entries);
  const promotedEntryIds = entries.filter(entry => entry.promotionStatus === "promoted").map(entry => entry.id).sort();
  const provisionalEntryIds = entries.filter(entry => entry.promotionStatus !== "promoted").map(entry => entry.id).sort();
  const canonical = canonicalSnapshotContent({
    goalId: input.goalId,
    taskGraph: input.taskGraph,
    workingMemorySummary: { promotedEntryIds, provisionalEntryIds },
    openHypotheses: [...input.openHypotheses],
    artifactIds: [...input.artifactIds],
    receiptIds: [...input.receiptIds]
  });
  const id = snapshotContentId(canonical, hasher);
  return { schema: TASK_RESUMPTION_SNAPSHOT_SCHEMA, id, ...canonical, capturedAt: input.capturedAt };
}

/**
 * Real tamper detection (item 218): recomputes the content-derived id from
 * a snapshot's own current field values and checks it against the id the
 * snapshot claims to have. Unlike comparing `reloaded.id === original.id`
 * (which is true of *any* JSON round trip regardless of what else was
 * corrupted, since `id` is just another field that survives untouched),
 * this catches corruption of any canonical field -- `openHypotheses`,
 * `artifactIds`, `receiptIds`, `workingMemorySummary`, or a task-graph
 * node's fields that a tamper happens not to route through
 * `eligibleNextTaskIds`'s own narrower eligibility computation.
 */
export function snapshotContentHashMatchesId(snapshot: TaskResumptionSnapshot, hasher: Hasher = createHasher()): boolean {
  return snapshotContentId(canonicalSnapshotContent(snapshot), hasher) === snapshot.id;
}

/**
 * Plan item 218's real, direct check: which task nodes are genuinely
 * eligible to run right now, computed purely from the snapshot's own
 * real graph structure -- never from prose, never from anything outside
 * the snapshot itself. A node is eligible when it is not already
 * complete and every node it real-depends on (`precedesRequiresIds`) is
 * complete.
 */
export function eligibleNextTaskIds(snapshot: TaskResumptionSnapshot): string[] {
  const nodes = snapshot.taskGraph.nodes;
  return Object.values(nodes)
    .filter(node => !node.completed && node.precedesRequiresIds.every(requiredId => nodes[requiredId]?.completed === true))
    .map(node => node.id)
    .sort();
}

/**
 * Real round-trip proof (item 218): serializing and deserializing a
 * snapshot through plain JSON (standing in for real durable storage --
 * this module has no storage adapter of its own) reproduces the exact
 * same snapshot id and the exact same eligible-next-task set, without
 * ever re-deriving state from prose.
 */
export function snapshotRoundTripsExactly(snapshot: TaskResumptionSnapshot, hasher: Hasher = createHasher()): boolean {
  const reloaded = JSON.parse(JSON.stringify(snapshot)) as TaskResumptionSnapshot;
  return reloaded.id === snapshot.id
    && snapshotContentHashMatchesId(reloaded, hasher)
    && JSON.stringify(eligibleNextTaskIds(reloaded)) === JSON.stringify(eligibleNextTaskIds(snapshot));
}
