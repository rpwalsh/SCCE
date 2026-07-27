import { describe, expect, it } from "vitest";
import {
  EMPTY_WORKING_MEMORY,
  abandonWorkingMemoryEntry,
  expireWorkingMemoryEntries,
  promoteWorkingMemoryEntry,
  putWorkingMemoryEntry,
  workingMemoryEntriesForTask,
  type WorkingMemoryState
} from "../working-memory.js";

function withHypothesis(state: WorkingMemoryState, id: string, overrides: Partial<Parameters<typeof putWorkingMemoryEntry>[1]> = {}) {
  return putWorkingMemoryEntry(state, {
    id,
    taskId: "task.fixture",
    type: "hypothesis",
    createdBy: "operator.fixture",
    confidence: 0.6,
    payload: { note: id },
    createdAt: 1_000,
    ...overrides
  });
}

describe("working memory (plan items 156-157)", () => {
  it("scopes entries by task and keeps them ordered by creation", () => {
    let state = withHypothesis(EMPTY_WORKING_MEMORY, "wm.1", { createdAt: 2 });
    state = withHypothesis(state, "wm.2", { createdAt: 1 });
    state = putWorkingMemoryEntry(state, {
      id: "wm.other-task",
      taskId: "task.other",
      type: "observation",
      createdBy: "operator.fixture",
      confidence: 0.9,
      payload: {},
      createdAt: 0
    });

    const entries = workingMemoryEntriesForTask(state, "task.fixture");
    expect(entries.map(entry => entry.id)).toEqual(["wm.2", "wm.1"]);
  });

  it("abandoning a hypothesis makes it disappear entirely, along with anything derived from it", () => {
    let state = withHypothesis(EMPTY_WORKING_MEMORY, "wm.root");
    state = withHypothesis(state, "wm.child", { dependsOnEntryIds: ["wm.root"] });
    state = withHypothesis(state, "wm.grandchild", { dependsOnEntryIds: ["wm.child"] });
    state = withHypothesis(state, "wm.unrelated");

    state = abandonWorkingMemoryEntry(state, "wm.root");

    expect(state.entries["wm.root"]).toBeUndefined();
    expect(state.entries["wm.child"]).toBeUndefined();
    expect(state.entries["wm.grandchild"]).toBeUndefined();
    expect(state.entries["wm.unrelated"]).toBeDefined();
  });

  it("a promoted entry retains its full derivation and survives expiry that would remove a provisional entry", () => {
    let state = withHypothesis(EMPTY_WORKING_MEMORY, "wm.promoted", { expiresAt: 1_500 });
    state = withHypothesis(state, "wm.provisional", { expiresAt: 1_500 });
    state = promoteWorkingMemoryEntry(state, "wm.promoted", {
      derivation: { steps: ["observed X", "combined with Y", "concluded Z"] },
      promotedAt: 1_200
    });

    const { state: afterExpiry, expiredIds } = expireWorkingMemoryEntries(state, 2_000);

    expect(expiredIds).toEqual(["wm.provisional"]);
    expect(afterExpiry.entries["wm.provisional"]).toBeUndefined();
    const promoted = afterExpiry.entries["wm.promoted"];
    expect(promoted).toBeDefined();
    expect(promoted?.promotionStatus).toBe("promoted");
    expect(promoted?.derivation).toEqual({ steps: ["observed X", "combined with Y", "concluded Z"] });
  });

  it("a provisional entry with no expiresAt is never swept by expiry", () => {
    const state = withHypothesis(EMPTY_WORKING_MEMORY, "wm.durable-scratch");
    const { state: afterExpiry, expiredIds } = expireWorkingMemoryEntries(state, Number.MAX_SAFE_INTEGER);
    expect(expiredIds).toEqual([]);
    expect(afterExpiry.entries["wm.durable-scratch"]).toBeDefined();
  });

  it("rejects an entry that declares a dependency on an entry that doesn't exist", () => {
    expect(() => withHypothesis(EMPTY_WORKING_MEMORY, "wm.broken", { dependsOnEntryIds: ["wm.missing"] }))
      .toThrow(/unknown entries/);
  });

  it("cannot promote an already-abandoned entry -- it was removed, not tagged, so promote sees it as unknown", () => {
    let state = withHypothesis(EMPTY_WORKING_MEMORY, "wm.a");
    state = abandonWorkingMemoryEntry(state, "wm.a");
    expect(() => promoteWorkingMemoryEntry(state, "wm.a", { derivation: {}, promotedAt: 2 }))
      .toThrow(/unknown working memory entry/);
  });
});
