import { describe, expect, it } from "vitest";
import {
  EMPTY_TASK_DECOMPOSITION,
  addTaskDecompositionNode,
  completeTaskDecompositionNode,
  schedulableSubtasks,
  unsatisfiedRequiredPostconditions,
  type TaskDecompositionGraph
} from "../hierarchical-task-decomposition.js";
import { solveTaskSchedule, verifyTaskScheduleOrder } from "../task-schedule-solver.js";

function buildReleaseGraph(): TaskDecompositionGraph {
  let graph = addTaskDecompositionNode(EMPTY_TASK_DECOMPOSITION, {
    id: "release",
    postconditions: ["built", "tested"],
    cost: 0,
    risk: 0.6
  });
  graph = addTaskDecompositionNode(graph, {
    id: "release.build",
    parentId: "release",
    postconditions: ["built"],
    cost: 5,
    risk: 0.1
  });
  graph = addTaskDecompositionNode(graph, {
    id: "release.test",
    parentId: "release",
    precedesRequiresIds: ["release.build"],
    preconditions: ["built"],
    postconditions: ["tested"],
    cost: 3,
    risk: 0.2
  });
  return graph;
}

describe("hierarchical task decomposition (plan items 158-159)", () => {
  it("carries prec/pre/post/cost/risk per node", () => {
    const graph = buildReleaseGraph();
    const build = graph.nodes["release.build"]!;
    const test = graph.nodes["release.test"]!;
    expect(test.precedesRequiresIds).toEqual(["release.build"]);
    expect(test.preconditions).toEqual(["built"]);
    expect(build.cost).toBe(5);
    expect(test.risk).toBe(0.2);
  });

  it("cannot mark a parent complete while a child task is not yet complete", () => {
    const graph = buildReleaseGraph();
    expect(() => completeTaskDecompositionNode(graph, { nodeId: "release", satisfiedConditionIds: [] }))
      .toThrow(/child task\(s\) not yet complete/);
  });

  it("a child cannot complete by claiming an unrelated condition instead of its own required postcondition -- so a parent can never inherit a false completion", () => {
    let graph = buildReleaseGraph();
    graph = completeTaskDecompositionNode(graph, { nodeId: "release.build", satisfiedConditionIds: ["built"] });
    // release.test's own postcondition is "tested" -- claiming an unrelated
    // condition instead must not let it (or, transitively, its parent)
    // slip through as complete.
    expect(() => completeTaskDecompositionNode(graph, { nodeId: "release.test", satisfiedConditionIds: ["unrelated-condition"] }))
      .toThrow(/tested/);
    // release.test genuinely never completed, so release still correctly
    // reports it as an incomplete child, not a false-postcondition parent.
    expect(() => completeTaskDecompositionNode(graph, { nodeId: "release", satisfiedConditionIds: [] }))
      .toThrow(/child task\(s\) not yet complete/);
  });

  it("a parent's required postcondition that no child ever establishes blocks completion even once every child is done", () => {
    let graph = addTaskDecompositionNode(EMPTY_TASK_DECOMPOSITION, {
      id: "parent",
      postconditions: ["deployed"],
      cost: 0,
      risk: 0
    });
    graph = addTaskDecompositionNode(graph, {
      id: "parent.child",
      parentId: "parent",
      postconditions: ["built"],
      cost: 1,
      risk: 0
    });
    graph = completeTaskDecompositionNode(graph, { nodeId: "parent.child", satisfiedConditionIds: ["built"] });
    expect(unsatisfiedRequiredPostconditions(graph, "parent")).toEqual(["deployed"]);
    expect(() => completeTaskDecompositionNode(graph, { nodeId: "parent", satisfiedConditionIds: [] }))
      .toThrow(/deployed/);
  });

  it("completes the parent once every child is done and every required postcondition is genuinely established", () => {
    let graph = buildReleaseGraph();
    graph = completeTaskDecompositionNode(graph, { nodeId: "release.build", satisfiedConditionIds: ["built"] });
    graph = completeTaskDecompositionNode(graph, { nodeId: "release.test", satisfiedConditionIds: ["tested"] });
    expect(unsatisfiedRequiredPostconditions(graph, "release")).toEqual([]);
    graph = completeTaskDecompositionNode(graph, { nodeId: "release", satisfiedConditionIds: [] });
    expect(graph.nodes["release"]!.completed).toBe(true);
  });

  it("cannot complete an already-completed node", () => {
    let graph = buildReleaseGraph();
    graph = completeTaskDecompositionNode(graph, { nodeId: "release.build", satisfiedConditionIds: ["built"] });
    expect(() => completeTaskDecompositionNode(graph, { nodeId: "release.build", satisfiedConditionIds: ["built"] }))
      .toThrow(/already completed/);
  });

  it("rejects a node declaring an unknown parent or an unknown precedence requirement", () => {
    expect(() => addTaskDecompositionNode(EMPTY_TASK_DECOMPOSITION, { id: "orphan", parentId: "missing", cost: 0, risk: 0 }))
      .toThrow(/unknown parent/);
    expect(() => addTaskDecompositionNode(EMPTY_TASK_DECOMPOSITION, { id: "a", precedesRequiresIds: ["missing"], cost: 0, risk: 0 }))
      .toThrow(/requires unknown node/);
  });

  it("its precedence structure is real input for task-schedule-solver.ts, not a parallel/duplicated scheduler", () => {
    const graph = buildReleaseGraph();
    const subtasks = schedulableSubtasks(graph);
    const result = solveTaskSchedule(subtasks);
    expect(result.status).toBe("scheduled");
    if (result.status === "scheduled") {
      expect(verifyTaskScheduleOrder(subtasks, result.order)).toBe(true);
      expect(result.order.indexOf("release.build")).toBeLessThan(result.order.indexOf("release.test"));
    }
  });
});
