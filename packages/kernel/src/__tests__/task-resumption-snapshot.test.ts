import { describe, expect, it } from "vitest";
import { addTaskDecompositionNode, completeTaskDecompositionNode, EMPTY_TASK_DECOMPOSITION } from "../hierarchical-task-decomposition.js";
import { putWorkingMemoryEntry, promoteWorkingMemoryEntry, EMPTY_WORKING_MEMORY } from "../working-memory.js";
import { captureTaskResumptionSnapshot, eligibleNextTaskIds, snapshotContentHashMatchesId, snapshotRoundTripsExactly } from "../task-resumption-snapshot.js";
import { createHasher } from "../primitives.js";

// Plan items 217-218. A real, combined, stably-identified snapshot over
// real existing structures (task graph, working memory), and a real
// round-trip/eligible-next-action proof -- never reconstructed from prose.

function realSnapshot() {
  let graph = EMPTY_TASK_DECOMPOSITION;
  graph = addTaskDecompositionNode(graph, { id: "fetch", preconditions: [], postconditions: ["fetched"], cost: 1, risk: 0.1 });
  graph = addTaskDecompositionNode(graph, { id: "process", precedesRequiresIds: ["fetch"], preconditions: [], postconditions: ["processed"], cost: 1, risk: 0.2 });
  graph = addTaskDecompositionNode(graph, { id: "publish", precedesRequiresIds: ["process"], preconditions: [], postconditions: ["published"], cost: 1, risk: 0.3 });
  graph = completeTaskDecompositionNode(graph, { nodeId: "fetch", satisfiedConditionIds: ["fetched"] });

  let workingMemory = EMPTY_WORKING_MEMORY;
  workingMemory = putWorkingMemoryEntry(workingMemory, { id: "wm.1", taskId: "fetch", type: "observation", createdBy: "test", confidence: 0.9, payload: { note: "fetched real data" }, createdAt: 1000 });
  workingMemory = promoteWorkingMemoryEntry(workingMemory, "wm.1", { derivation: { reason: "confirmed" }, promotedAt: 1500 });
  workingMemory = putWorkingMemoryEntry(workingMemory, { id: "wm.2", taskId: "process", type: "hypothesis", createdBy: "test", confidence: 0.4, payload: { note: "still guessing" }, createdAt: 1600 });

  const hasher = createHasher();
  return captureTaskResumptionSnapshot({
    goalId: "goal.1",
    taskGraph: graph,
    workingMemory,
    openHypotheses: [{ id: "hyp.1", summary: "process might need retry logic", confidence: 0.4 }],
    artifactIds: ["artifact.1"],
    receiptIds: ["receipt.1"],
    capturedAt: 2000,
    hasher
  });
}

describe("captureTaskResumptionSnapshot (plan item 217)", () => {
  it("combines the real goal graph, working-memory summary, hypotheses, artifacts, and receipts under one stable snapshot identity", () => {
    const snapshot = realSnapshot();
    expect(snapshot.goalId).toBe("goal.1");
    expect(snapshot.workingMemorySummary.promotedEntryIds).toEqual(["wm.1"]);
    expect(snapshot.workingMemorySummary.provisionalEntryIds).toEqual(["wm.2"]);
    expect(snapshot.openHypotheses).toHaveLength(1);
    expect(snapshot.artifactIds).toEqual(["artifact.1"]);
    expect(snapshot.receiptIds).toEqual(["receipt.1"]);
    expect(snapshot.id).toMatch(/^task_resumption_snapshot\./);
  });

  it("produces the same real snapshot id for the same real content, deterministically", () => {
    const hasher = createHasher();
    const first = realSnapshot();
    const second = captureTaskResumptionSnapshot({
      goalId: first.goalId,
      taskGraph: first.taskGraph,
      workingMemory: EMPTY_WORKING_MEMORY, // irrelevant here; we pass the already-summarized snapshot's own fields directly below instead
      openHypotheses: first.openHypotheses,
      artifactIds: first.artifactIds,
      receiptIds: first.receiptIds,
      capturedAt: first.capturedAt,
      hasher
    });
    // Re-deriving from the identical real inputs (goal/graph/hypotheses/
    // artifacts/receipts/time) with an empty working memory changes the
    // real content, so ids differ here -- this instead proves the
    // positive case directly below with truly identical inputs.
    expect(second.id).not.toBe(first.id);

    const third = realSnapshot();
    expect(third.id).toBe(first.id);
  });
});

describe("eligibleNextTaskIds (plan item 218)", () => {
  it("computes real eligibility purely from graph structure: a node whose dependency is complete is eligible, one whose dependency is not is not", () => {
    const snapshot = realSnapshot();
    const eligible = eligibleNextTaskIds(snapshot);
    expect(eligible).toEqual(["process"]); // fetch is done; process's dep (fetch) is satisfied; publish's dep (process) is not
  });
});

describe("snapshotRoundTripsExactly (plan item 218: reloading a persisted task state produces the same eligible next actions)", () => {
  it("a snapshot serialized and reloaded (simulating persistence across days) reproduces the exact same id and the exact same eligible-next-action set", () => {
    const snapshot = realSnapshot();
    expect(snapshotRoundTripsExactly(snapshot)).toBe(true);
  });

  it("genuinely detects a real corruption -- a hand-tampered reload does not silently pass", () => {
    const snapshot = realSnapshot();
    const tampered = JSON.parse(JSON.stringify(snapshot));
    tampered.taskGraph.nodes.fetch.completed = false; // simulate real corruption/loss on reload
    expect(tampered.id).toBe(snapshot.id); // the id field itself is untouched by this corruption
    // But the real eligible-next-action set now genuinely differs, because
    // "process" is no longer eligible once "fetch" is reported incomplete.
    expect(JSON.stringify(eligibleNextTaskIds(tampered))).not.toBe(JSON.stringify(eligibleNextTaskIds(snapshot)));
  });

  it("CRITICAL fix: catches a real corruption that eligibleNextTaskIds alone cannot see (artifactIds/openHypotheses/receiptIds never affect graph-structural eligibility)", () => {
    const snapshot = realSnapshot();
    const tampered = JSON.parse(JSON.stringify(snapshot));
    tampered.artifactIds = ["artifact.attacker-substituted"];
    // The old, weaker check compared only reloaded.id === snapshot.id (true
    // here -- the id field itself is never touched) and the eligible-task
    // set (also unaffected by artifactIds) -- so this real corruption used
    // to silently pass. The content-hash check must now catch it.
    expect(tampered.id).toBe(snapshot.id);
    expect(JSON.stringify(eligibleNextTaskIds(tampered))).toBe(JSON.stringify(eligibleNextTaskIds(snapshot)));
    expect(snapshotContentHashMatchesId(tampered)).toBe(false);
    expect(snapshotRoundTripsExactly(tampered)).toBe(false);
  });

  it("snapshotContentHashMatchesId is true for a genuine, untampered snapshot", () => {
    expect(snapshotContentHashMatchesId(realSnapshot())).toBe(true);
  });
});
