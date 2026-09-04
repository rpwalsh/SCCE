// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
import type { TaskDecompositionGraph, TaskDecompositionNode } from "./hierarchical-task-decomposition.js";
import type { WorkingMemoryState } from "./working-memory.js";
import type { OpenHypothesis, TaskResumptionSnapshot } from "./task-resumption-snapshot.js";
import { captureTaskResumptionSnapshot, snapshotContentHashMatchesId, TASK_RESUMPTION_SNAPSHOT_SCHEMA } from "./task-resumption-snapshot.js";
import type { TaskResumptionSnapshotStore } from "./storage.js";
import type { Hasher, JsonValue } from "./types.js";
import { createHasher, toJsonValue } from "./primitives.js";

/**
 * Plan items 217-218 live wiring. `production-turn-runtime.ts` already
 * builds a real `TaskDecompositionGraph` for any code-shaped turn
 * (items 158-159, `code-learning.ts`'s `taskDecompositionForBlueprintOperations`)
 * and a real `WorkingMemoryState` for every turn (items 156-157) -- both
 * already-live data, not newly invented here. `ProgramGraph.taskDecomposition`
 * is typed `JsonValue` (already serialized by the time it reaches a
 * `ConstructGraph`), so this module's real job is deserializing it back
 * into the typed `TaskDecompositionGraph` `task-resumption-snapshot.ts`
 * actually needs, with the same careful, reject-rather-than-guess
 * validation this codebase's other metadata/JSON parsers use -- never
 * reimplementing `task-resumption-snapshot.ts`'s own logic.
 *
 * Persistence is real and durable (`deps.storage.taskResumption`, a
 * genuine Postgres-backed store -- see `storage.ts`'s
 * `TaskResumptionSnapshotStore` and `postgres.ts`'s real implementation),
 * keyed by the turn's real, stable `conversationId`
 * (`dialogue-pragmatics.ts`'s `DialogueState.conversationId`) rather than
 * the per-turn `episodeId` (a fresh id every single turn, and so useless
 * as a cross-turn key). This is what makes "resumption" (item 218) real:
 * a later turn in the same conversation that has no fresh task
 * decomposition of its own (i.e. isn't itself code-shaped) still
 * recovers the conversation's last real persisted snapshot, rather than
 * losing it the moment one turn's own construct doesn't happen to
 * rebuild one.
 */

function record(value: JsonValue | undefined): Record<string, JsonValue> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, JsonValue> : undefined;
}

function stringArray(value: JsonValue | undefined): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  return value.every(item => typeof item === "string") ? value as string[] : undefined;
}

/** Real, careful deserialization of `ProgramGraph.taskDecomposition`'s JSON form back into a typed `TaskDecompositionGraph`. Returns `undefined` on any structural mismatch rather than guessing -- this data was produced by this codebase's own real serializer moments earlier in the same turn, so a mismatch means something is genuinely wrong, not that a lenient parse should paper over it. */
export function taskDecompositionGraphFromJson(value: JsonValue | undefined): TaskDecompositionGraph | undefined {
  const parsed = record(value);
  const nodesInput = record(parsed?.nodes);
  if (!nodesInput) return undefined;
  const nodes: Record<string, TaskDecompositionNode> = {};
  for (const [id, raw] of Object.entries(nodesInput)) {
    const node = record(raw);
    if (!node || typeof node.id !== "string" || node.id !== id) return undefined;
    const precedesRequiresIds = stringArray(node.precedesRequiresIds);
    const preconditions = stringArray(node.preconditions);
    const postconditions = stringArray(node.postconditions);
    const satisfiedConditionIds = stringArray(node.satisfiedConditionIds);
    if (!precedesRequiresIds || !preconditions || !postconditions || !satisfiedConditionIds) return undefined;
    if (typeof node.cost !== "number" || typeof node.risk !== "number" || typeof node.completed !== "boolean") return undefined;
    nodes[id] = {
      id: node.id,
      ...(typeof node.parentId === "string" ? { parentId: node.parentId } : {}),
      precedesRequiresIds,
      preconditions,
      postconditions,
      cost: node.cost,
      risk: node.risk,
      satisfiedConditionIds,
      completed: node.completed
    };
  }
  return { nodes };
}

function openHypothesesFromJson(value: JsonValue | undefined): OpenHypothesis[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const hypotheses: OpenHypothesis[] = [];
  for (const raw of value) {
    const item = record(raw);
    if (!item || typeof item.id !== "string" || typeof item.summary !== "string" || typeof item.confidence !== "number") return undefined;
    hypotheses.push({ id: item.id, summary: item.summary, confidence: item.confidence });
  }
  return hypotheses;
}

/**
 * Real, careful deserialization of a persisted `TaskResumptionSnapshot`
 * row's `snapshotJson` back into a typed, structurally-validated
 * snapshot -- never an unchecked cast. A durably-stored row could in
 * principle be a corrupted write, a legacy/incompatible shape, or a
 * genuinely tampered value; this rejects (returns `undefined`, matching
 * this module's own "absent, not fabricated" contract) rather than
 * handing an untrusted shape to the rest of the turn. The final check,
 * `snapshotContentHashMatchesId`, is the real integrity guarantee: the
 * content-derived id the snapshot claims to have must actually match its
 * current content, the same tamper-evidence property
 * `snapshotRoundTripsExactly` proves for an in-memory round trip.
 */
export function taskResumptionSnapshotFromJson(value: JsonValue | undefined, hasher: Hasher = createHasher()): TaskResumptionSnapshot | undefined {
  const parsed = record(value);
  if (!parsed || parsed.schema !== TASK_RESUMPTION_SNAPSHOT_SCHEMA) return undefined;
  if (typeof parsed.id !== "string" || typeof parsed.goalId !== "string" || typeof parsed.capturedAt !== "number") return undefined;
  const taskGraph = taskDecompositionGraphFromJson(parsed.taskGraph);
  if (!taskGraph) return undefined;
  const summary = record(parsed.workingMemorySummary);
  const promotedEntryIds = stringArray(summary?.promotedEntryIds);
  const provisionalEntryIds = stringArray(summary?.provisionalEntryIds);
  if (!promotedEntryIds || !provisionalEntryIds) return undefined;
  const openHypotheses = openHypothesesFromJson(parsed.openHypotheses);
  const artifactIds = stringArray(parsed.artifactIds);
  const receiptIds = stringArray(parsed.receiptIds);
  if (!openHypotheses || !artifactIds || !receiptIds) return undefined;
  const candidate: TaskResumptionSnapshot = {
    schema: TASK_RESUMPTION_SNAPSHOT_SCHEMA,
    id: parsed.id,
    goalId: parsed.goalId,
    taskGraph,
    workingMemorySummary: { promotedEntryIds, provisionalEntryIds },
    openHypotheses,
    artifactIds,
    receiptIds,
    capturedAt: parsed.capturedAt
  };
  return snapshotContentHashMatchesId(candidate, hasher) ? candidate : undefined;
}

/** Real open hypotheses derived directly from this turn's own live working memory -- every real provisional (not-yet-promoted) hypothesis-type entry, never a separate fabricated list. A hypothesis promoted to the winning candidate is, by definition, no longer "open." */
export function openHypothesesFromWorkingMemory(workingMemory: WorkingMemoryState): OpenHypothesis[] {
  return Object.values(workingMemory.entries)
    .filter(entry => entry.type === "hypothesis" && entry.promotionStatus === "provisional")
    .map(entry => ({ id: String(entry.id), summary: JSON.stringify(entry.payload).slice(0, 280), confidence: entry.confidence }))
    .sort((left, right) => left.id.localeCompare(right.id));
}

/**
 * The real per-turn wiring: builds a real `TaskResumptionSnapshot` from
 * this turn's own already-computed task decomposition and working
 * memory. Returns `undefined` -- absent, not fabricated -- when this
 * turn has no real task decomposition (any turn that isn't code-shaped),
 * matching `repoCognition`'s own "absent when the real input isn't
 * there" contract elsewhere in this file.
 */
export function taskResumptionSnapshotForTurn(input: {
  goalId: string;
  taskDecomposition: JsonValue | undefined;
  workingMemory: WorkingMemoryState;
  artifactIds: readonly string[];
  receiptIds: readonly string[];
  capturedAt: number;
  hasher: Hasher;
}): TaskResumptionSnapshot | undefined {
  const taskGraph = taskDecompositionGraphFromJson(input.taskDecomposition);
  if (!taskGraph) return undefined;
  return captureTaskResumptionSnapshot({
    goalId: input.goalId,
    taskGraph,
    workingMemory: input.workingMemory,
    openHypotheses: openHypothesesFromWorkingMemory(input.workingMemory),
    artifactIds: input.artifactIds,
    receiptIds: input.receiptIds,
    capturedAt: input.capturedAt,
    hasher: input.hasher
  });
}

/**
 * The real per-turn sync (items 217-218). If this turn has a fresh real
 * task decomposition, builds and durably persists a new snapshot for
 * real, keyed by `goalId` (a real, stable `conversationId`). If this
 * turn has none, real resumption: returns the conversation's last real
 * persisted snapshot instead of leaving the turn with nothing -- the
 * concrete behavior item 218 asks for ("reloading a persisted task state
 * ... produces the same eligible next actions").
 */
export async function syncTaskResumptionSnapshotForTurn(
  store: TaskResumptionSnapshotStore,
  input: {
    goalId: string;
    taskDecomposition: JsonValue | undefined;
    workingMemory: WorkingMemoryState;
    artifactIds: readonly string[];
    receiptIds: readonly string[];
    capturedAt: number;
    hasher: Hasher;
  }
): Promise<TaskResumptionSnapshot | undefined> {
  const freshSnapshot = taskResumptionSnapshotForTurn(input);
  if (freshSnapshot) {
    await store.putSnapshot({
      id: freshSnapshot.id,
      goalId: freshSnapshot.goalId,
      snapshotJson: toJsonValue(freshSnapshot),
      capturedAt: freshSnapshot.capturedAt
    });
    return freshSnapshot;
  }
  const latest = await store.getLatestSnapshot(input.goalId);
  return latest ? taskResumptionSnapshotFromJson(latest.snapshotJson, input.hasher) : undefined;
}
