// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
import { describe, expect, it } from "vitest";
import { taskDecompositionGraphFromJson, openHypothesesFromWorkingMemory, taskResumptionSnapshotForTurn, taskResumptionSnapshotFromJson, syncTaskResumptionSnapshotForTurn } from "../task-resumption-turn-request.js";
import { addTaskDecompositionNode, EMPTY_TASK_DECOMPOSITION } from "../hierarchical-task-decomposition.js";
import { EMPTY_WORKING_MEMORY, putWorkingMemoryEntry, promoteWorkingMemoryEntry, type WorkingMemoryEntryId } from "../working-memory.js";
import { toJsonValue, createHasher } from "../primitives.js";
import type { TaskResumptionSnapshotRecord, TaskResumptionSnapshotStore } from "../storage.js";

// Plan items 217-218 live wiring: real deserialization of this turn's
// own already-computed TaskDecompositionGraph (as it actually appears,
// serialized, on ProgramGraph.taskDecomposition) and real open-hypothesis
// derivation from this turn's own live working memory.

describe("taskDecompositionGraphFromJson (real round trip of this turn's own serializer)", () => {
  it("round-trips a real graph through toJsonValue exactly", () => {
    let graph = EMPTY_TASK_DECOMPOSITION;
    graph = addTaskDecompositionNode(graph, { id: "fetch", cost: 1, risk: 0.1, postconditions: ["fetched"] });
    graph = addTaskDecompositionNode(graph, { id: "process", precedesRequiresIds: ["fetch"], cost: 1, risk: 0.2 });
    const roundTripped = taskDecompositionGraphFromJson(toJsonValue(graph));
    expect(roundTripped).toEqual(graph);
  });

  it("returns undefined for undefined input (no task decomposition this turn)", () => {
    expect(taskDecompositionGraphFromJson(undefined)).toBeUndefined();
  });

  it("returns undefined for a structurally malformed graph rather than guessing", () => {
    expect(taskDecompositionGraphFromJson({ nodes: { a: { id: "a" } } })).toBeUndefined();
    expect(taskDecompositionGraphFromJson({ nodes: { a: { id: "b", cost: 1, risk: 0, completed: false, precedesRequiresIds: [], preconditions: [], postconditions: [], satisfiedConditionIds: [] } } })).toBeUndefined();
  });
});

describe("openHypothesesFromWorkingMemory (real derivation, no fabrication)", () => {
  it("includes only provisional hypothesis-type entries, excluding promoted ones and other entry types", () => {
    let wm = EMPTY_WORKING_MEMORY;
    wm = putWorkingMemoryEntry(wm, { id: "wm.1" as WorkingMemoryEntryId, taskId: "t1", type: "hypothesis", createdBy: "test", confidence: 0.4, payload: { note: "maybe X" }, createdAt: 1000 });
    wm = putWorkingMemoryEntry(wm, { id: "wm.2" as WorkingMemoryEntryId, taskId: "t1", type: "hypothesis", createdBy: "test", confidence: 0.9, payload: { note: "confirmed Y" }, createdAt: 1000 });
    wm = promoteWorkingMemoryEntry(wm, "wm.2" as WorkingMemoryEntryId, { derivation: { reason: "confirmed" }, promotedAt: 1500 });
    wm = putWorkingMemoryEntry(wm, { id: "wm.3" as WorkingMemoryEntryId, taskId: "t1", type: "observation", createdBy: "test", confidence: 1, payload: {}, createdAt: 1000 });

    const hypotheses = openHypothesesFromWorkingMemory(wm);
    expect(hypotheses).toHaveLength(1);
    expect(hypotheses[0]!.id).toBe("wm.1");
    expect(hypotheses[0]!.confidence).toBe(0.4);
    expect(hypotheses[0]!.summary).toContain("maybe X");
  });

  it("returns an empty list for empty working memory", () => {
    expect(openHypothesesFromWorkingMemory(EMPTY_WORKING_MEMORY)).toEqual([]);
  });
});

describe("taskResumptionSnapshotForTurn (real end-to-end per-turn wiring)", () => {
  it("returns undefined when this turn has no real task decomposition", () => {
    const result = taskResumptionSnapshotForTurn({
      goalId: "episode.1", taskDecomposition: undefined, workingMemory: EMPTY_WORKING_MEMORY,
      artifactIds: [], receiptIds: [], capturedAt: 1000, hasher: createHasher()
    });
    expect(result).toBeUndefined();
  });

  it("builds a real snapshot when a real task decomposition exists this turn", () => {
    let graph = EMPTY_TASK_DECOMPOSITION;
    graph = addTaskDecompositionNode(graph, { id: "fetch", cost: 1, risk: 0.1 });
    let wm = EMPTY_WORKING_MEMORY;
    wm = putWorkingMemoryEntry(wm, { id: "wm.1" as WorkingMemoryEntryId, taskId: "fetch", type: "hypothesis", createdBy: "test", confidence: 0.5, payload: { note: "still checking" }, createdAt: 1000 });

    const result = taskResumptionSnapshotForTurn({
      goalId: "episode.1", taskDecomposition: toJsonValue(graph), workingMemory: wm,
      artifactIds: ["artifact.1"], receiptIds: ["receipt.1"], capturedAt: 2000, hasher: createHasher()
    });
    expect(result).toBeDefined();
    expect(result!.goalId).toBe("episode.1");
    expect(result!.openHypotheses).toHaveLength(1);
    expect(result!.artifactIds).toEqual(["artifact.1"]);
    expect(result!.id).toMatch(/^task_resumption_snapshot\./);
  });
});

class MemoryTaskResumptionSnapshotStore implements TaskResumptionSnapshotStore {
  private readonly records: TaskResumptionSnapshotRecord[] = [];
  putCalls: TaskResumptionSnapshotRecord[] = [];

  async putSnapshot(record: TaskResumptionSnapshotRecord): Promise<void> {
    this.putCalls.push(record);
    this.records.push(record);
  }

  async getLatestSnapshot(goalId: string): Promise<TaskResumptionSnapshotRecord | null> {
    const matching = this.records.filter(record => record.goalId === goalId);
    return matching.length ? matching.reduce((latest, record) => record.capturedAt > latest.capturedAt ? record : latest) : null;
  }
}

function realGraph() {
  let graph = EMPTY_TASK_DECOMPOSITION;
  graph = addTaskDecompositionNode(graph, { id: "fetch", cost: 1, risk: 0.1 });
  return graph;
}

describe("syncTaskResumptionSnapshotForTurn (real, durable persistence -- items 217-218 live wiring)", () => {
  it("persists a genuinely new snapshot to the real store when this turn has a real task decomposition", async () => {
    const store = new MemoryTaskResumptionSnapshotStore();
    const result = await syncTaskResumptionSnapshotForTurn(store, {
      goalId: "conversation.1", taskDecomposition: toJsonValue(realGraph()), workingMemory: EMPTY_WORKING_MEMORY,
      artifactIds: [], receiptIds: [], capturedAt: 1000, hasher: createHasher()
    });
    expect(result).toBeDefined();
    expect(store.putCalls).toHaveLength(1);
    expect(store.putCalls[0]!.goalId).toBe("conversation.1");
  });

  it("real resumption: a later turn with no fresh task decomposition of its own recovers the conversation's last real persisted snapshot", async () => {
    const store = new MemoryTaskResumptionSnapshotStore();
    const first = await syncTaskResumptionSnapshotForTurn(store, {
      goalId: "conversation.1", taskDecomposition: toJsonValue(realGraph()), workingMemory: EMPTY_WORKING_MEMORY,
      artifactIds: ["artifact.1"], receiptIds: [], capturedAt: 1000, hasher: createHasher()
    });
    // Turn 2: no real task decomposition this turn (e.g. a plain factual
    // question, not code-shaped) -- must still recover turn 1's real
    // persisted snapshot rather than losing it.
    const second = await syncTaskResumptionSnapshotForTurn(store, {
      goalId: "conversation.1", taskDecomposition: undefined, workingMemory: EMPTY_WORKING_MEMORY,
      artifactIds: [], receiptIds: [], capturedAt: 2000, hasher: createHasher()
    });
    expect(second).toEqual(first);
  });

  it("does not resume a different conversation's snapshot -- goalId genuinely partitions real state", async () => {
    const store = new MemoryTaskResumptionSnapshotStore();
    await syncTaskResumptionSnapshotForTurn(store, {
      goalId: "conversation.1", taskDecomposition: toJsonValue(realGraph()), workingMemory: EMPTY_WORKING_MEMORY,
      artifactIds: [], receiptIds: [], capturedAt: 1000, hasher: createHasher()
    });
    const other = await syncTaskResumptionSnapshotForTurn(store, {
      goalId: "conversation.2", taskDecomposition: undefined, workingMemory: EMPTY_WORKING_MEMORY,
      artifactIds: [], receiptIds: [], capturedAt: 2000, hasher: createHasher()
    });
    expect(other).toBeUndefined();
  });

  it("returns undefined when no snapshot was ever persisted for this real conversation and this turn has none of its own", async () => {
    const store = new MemoryTaskResumptionSnapshotStore();
    const result = await syncTaskResumptionSnapshotForTurn(store, {
      goalId: "conversation.new", taskDecomposition: undefined, workingMemory: EMPTY_WORKING_MEMORY,
      artifactIds: [], receiptIds: [], capturedAt: 1000, hasher: createHasher()
    });
    expect(result).toBeUndefined();
  });

  it("CRITICAL fix: a corrupted persisted row is rejected, not trusted via an unchecked cast", async () => {
    const store = new MemoryTaskResumptionSnapshotStore();
    await syncTaskResumptionSnapshotForTurn(store, {
      goalId: "conversation.1", taskDecomposition: toJsonValue(realGraph()), workingMemory: EMPTY_WORKING_MEMORY,
      artifactIds: ["artifact.1"], receiptIds: [], capturedAt: 1000, hasher: createHasher()
    });
    // Simulate a corrupted/tampered row reaching the reload path directly
    // (bypassing syncTaskResumptionSnapshotForTurn's own happy path).
    const corrupted = await store.getLatestSnapshot("conversation.1");
    const tamperedJson = JSON.parse(JSON.stringify(corrupted!.snapshotJson));
    tamperedJson.artifactIds = ["artifact.attacker-substituted"];
    expect(taskResumptionSnapshotFromJson(tamperedJson)).toBeUndefined();
    expect(taskResumptionSnapshotFromJson({ schema: "wrong.schema" })).toBeUndefined();
    expect(taskResumptionSnapshotFromJson(undefined)).toBeUndefined();
  });
});
