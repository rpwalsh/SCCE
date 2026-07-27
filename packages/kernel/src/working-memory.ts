import type { JsonValue } from "./types.js";

/**
 * Plan items 156-157. Typed, task-scoped working memory (`W_t`), kept
 * explicitly separate from canonical brain state (evidence, graph, language
 * memory): entries here are provisional scratch state a reasoning process
 * built up while working on one task, not durable knowledge. An abandoned
 * hypothesis must disappear entirely (not linger as a low-confidence
 * canonical fact); a promoted result must retain its full derivation so a
 * later reader can see exactly how it was produced, not just its final
 * value. This module is pure (state in, state out) to match this
 * package's dominant convention for typed model state elsewhere
 * (segmentation-population.ts, boundary-estimator.ts, etc.) rather than a
 * stateful class -- callers own persistence/scoping.
 */

export type WorkingMemoryEntryId = string;

export type WorkingMemoryEntryType =
  | "hypothesis"
  | "intermediate_result"
  | "observation"
  | "plan_fragment"
  | "open_question";

/**
 * There is deliberately no "abandoned" status: an abandoned entry is
 * removed by `abandonWorkingMemoryEntry` rather than tagged, so a stale
 * abandoned entry can never linger in a scan of task state (see that
 * function's doc comment). A promotion attempt against an abandoned id
 * therefore fails with the same "unknown entry" error as any other
 * nonexistent id, not a distinct "already abandoned" error.
 */
export type WorkingMemoryPromotionStatus = "provisional" | "promoted";

export interface WorkingMemoryEntry {
  id: WorkingMemoryEntryId;
  taskId: string;
  type: WorkingMemoryEntryType;
  /** Which operator/process/reasoning step created this entry -- for provenance, not authorization. */
  createdBy: string;
  /** Other working-memory entries this one was derived from or depends on. */
  dependsOnEntryIds: WorkingMemoryEntryId[];
  confidence: number;
  payload: JsonValue;
  createdAt: number;
  /** Provisional entries older than this are eligible for expiry; promoted entries are immune regardless of this field. */
  expiresAt?: number;
  promotionStatus: WorkingMemoryPromotionStatus;
  /** Populated only once promoted -- the full reasoning trail, not just the final value. */
  derivation?: JsonValue;
  promotedAt?: number;
}

export interface WorkingMemoryState {
  entries: Record<WorkingMemoryEntryId, WorkingMemoryEntry>;
}

export const EMPTY_WORKING_MEMORY: WorkingMemoryState = { entries: {} };

export interface PutWorkingMemoryEntryInput {
  id: WorkingMemoryEntryId;
  taskId: string;
  type: WorkingMemoryEntryType;
  createdBy: string;
  dependsOnEntryIds?: readonly WorkingMemoryEntryId[];
  confidence: number;
  payload: JsonValue;
  createdAt: number;
  expiresAt?: number;
}

export function putWorkingMemoryEntry(
  state: WorkingMemoryState,
  input: PutWorkingMemoryEntryInput
): WorkingMemoryState {
  const unknownDependencies = (input.dependsOnEntryIds ?? []).filter(id => !state.entries[id]);
  if (unknownDependencies.length) {
    throw new Error(`working memory entry ${input.id} depends on unknown entries: ${unknownDependencies.join(", ")}`);
  }
  const entry: WorkingMemoryEntry = {
    id: input.id,
    taskId: input.taskId,
    type: input.type,
    createdBy: input.createdBy,
    dependsOnEntryIds: [...(input.dependsOnEntryIds ?? [])],
    confidence: input.confidence,
    payload: input.payload,
    createdAt: input.createdAt,
    ...(input.expiresAt !== undefined ? { expiresAt: input.expiresAt } : {}),
    promotionStatus: "provisional"
  };
  return { entries: { ...state.entries, [entry.id]: entry } };
}

/**
 * Marks an entry as durably retained with its full derivation trail.
 * Promoted entries are never removed by `expireWorkingMemoryEntries`,
 * matching the plan's requirement that promoted results survive while
 * everything else that was merely provisional does not.
 */
export function promoteWorkingMemoryEntry(
  state: WorkingMemoryState,
  id: WorkingMemoryEntryId,
  input: { derivation: JsonValue; promotedAt: number }
): WorkingMemoryState {
  const entry = state.entries[id];
  if (!entry) throw new Error(`cannot promote unknown working memory entry: ${id}`);
  return {
    entries: {
      ...state.entries,
      [id]: {
        ...entry,
        promotionStatus: "promoted",
        derivation: input.derivation,
        promotedAt: input.promotedAt
      }
    }
  };
}

/**
 * Removes an entry entirely -- an abandoned hypothesis must disappear, not
 * linger tagged "abandoned" where it could still pollute a later scan of
 * task state. Also removes any entry that depended on it, transitively,
 * for the same reason: a conclusion built on a withdrawn hypothesis is
 * itself no longer supported.
 */
export function abandonWorkingMemoryEntry(
  state: WorkingMemoryState,
  id: WorkingMemoryEntryId
): WorkingMemoryState {
  if (!state.entries[id]) return state;
  const toRemove = new Set<WorkingMemoryEntryId>([id]);
  let grew = true;
  while (grew) {
    grew = false;
    for (const entry of Object.values(state.entries)) {
      if (toRemove.has(entry.id)) continue;
      if (entry.dependsOnEntryIds.some(dependencyId => toRemove.has(dependencyId))) {
        toRemove.add(entry.id);
        grew = true;
      }
    }
  }
  const entries = { ...state.entries };
  for (const removeId of toRemove) delete entries[removeId];
  return { entries };
}

/** Removes provisional entries past their `expiresAt`; promoted entries are immune regardless of age. */
export function expireWorkingMemoryEntries(
  state: WorkingMemoryState,
  now: number
): { state: WorkingMemoryState; expiredIds: WorkingMemoryEntryId[] } {
  const expiredIds: WorkingMemoryEntryId[] = [];
  const entries = { ...state.entries };
  for (const entry of Object.values(state.entries)) {
    if (entry.promotionStatus === "promoted") continue;
    if (entry.expiresAt === undefined || entry.expiresAt > now) continue;
    delete entries[entry.id];
    expiredIds.push(entry.id);
  }
  return { state: { entries }, expiredIds: expiredIds.sort() };
}

export function workingMemoryEntriesForTask(
  state: WorkingMemoryState,
  taskId: string
): WorkingMemoryEntry[] {
  return Object.values(state.entries)
    .filter(entry => entry.taskId === taskId)
    .sort((left, right) => left.createdAt - right.createdAt || left.id.localeCompare(right.id));
}
