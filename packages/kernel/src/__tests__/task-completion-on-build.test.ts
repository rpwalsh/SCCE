// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
import { describe, expect, it } from "vitest";
import { addTaskDecompositionNode, completeTaskDecompositionNode, EMPTY_TASK_DECOMPOSITION } from "../hierarchical-task-decomposition.js";
import { nodeCanExecute } from "../task-replanning.js";

describe("completing a task node the build proved", () => {
  it("refuses a node whose preconditions are not held and completes the one whose are", () => {
    const graph = addTaskDecompositionNode(
      addTaskDecompositionNode(EMPTY_TASK_DECOMPOSITION, {
        id: "task.build",
        preconditions: [],
        postconditions: ["condition.build"],
        cost: 1,
        risk: 0
      }),
      {
        id: "task.ship",
        preconditions: ["condition.reviewed"],
        postconditions: ["condition.shipped"],
        cost: 1,
        risk: 0
      }
    );

    expect(nodeCanExecute(graph, "task.build", new Set()).allowed).toBe(true);
    const blocked = nodeCanExecute(graph, "task.ship", new Set());
    expect(blocked.allowed).toBe(false);
    expect(blocked.reason).toContain("condition.reviewed");

    const completed = completeTaskDecompositionNode(graph, {
      nodeId: "task.build",
      satisfiedConditionIds: ["condition.build"]
    });
    expect(completed.nodes["task.build"]?.completed).toBe(true);
    expect(nodeCanExecute(completed, "task.build", new Set()).allowed).toBe(false);
  });
});
