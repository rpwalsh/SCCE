import { describe, expect, it } from "vitest";
import { addTaskDecompositionNode, completeTaskDecompositionNode, EMPTY_TASK_DECOMPOSITION } from "../hierarchical-task-decomposition.js";
import { nodeCanExecute, replan } from "../task-replanning.js";

// Plan items 180-181. Real replanning built on the existing typed task-
// decomposition DAG (items 158-159) -- not a separate plan model.

function graphWithTwoIndependentCompletedTasks() {
  let graph = EMPTY_TASK_DECOMPOSITION;
  graph = addTaskDecompositionNode(graph, { id: "fetch_data", preconditions: ["network_available"], postconditions: ["data_fetched"], cost: 1, risk: 0.1 });
  graph = addTaskDecompositionNode(graph, { id: "write_report", preconditions: ["disk_writable"], postconditions: ["report_written"], cost: 1, risk: 0.1 });
  graph = completeTaskDecompositionNode(graph, { nodeId: "fetch_data", satisfiedConditionIds: ["data_fetched"] });
  graph = completeTaskDecompositionNode(graph, { nodeId: "write_report", satisfiedConditionIds: ["report_written"] });
  return graph;
}

describe("replan (plan item 180)", () => {
  it("reuses a completed task whose preconditions and claimed postconditions are untouched by the observation -- real work is never restarted for an unrelated change", () => {
    const graph = graphWithTwoIndependentCompletedTasks();
    const result = replan(graph, { invalidatedConditionIds: ["disk_writable"] });
    expect(result.reusedNodeIds).toEqual(["fetch_data"]);
    expect(result.invalidatedNodeIds).toEqual(["write_report"]);
    expect(result.graph.nodes.fetch_data!.completed).toBe(true);
    expect(result.graph.nodes.write_report!.completed).toBe(false);
  });

  it("invalidating a claimed postcondition (not just a precondition) also resets the node -- the work it claimed to have done is no longer trustworthy", () => {
    const graph = graphWithTwoIndependentCompletedTasks();
    const result = replan(graph, { invalidatedConditionIds: ["data_fetched"] });
    expect(result.invalidatedNodeIds).toEqual(["fetch_data"]);
    expect(result.reusedNodeIds).toEqual(["write_report"]);
    expect(result.graph.nodes.fetch_data!.satisfiedConditionIds).not.toContain("data_fetched");
  });

  it("an observation invalidating nothing real reuses every completed node", () => {
    const graph = graphWithTwoIndependentCompletedTasks();
    const result = replan(graph, { invalidatedConditionIds: ["unrelated_condition"] });
    expect(result.reusedNodeIds.sort()).toEqual(["fetch_data", "write_report"]);
    expect(result.invalidatedNodeIds).toEqual([]);
  });

  it("a not-yet-completed node whose precondition is invalidated is real and correctly reported as blocked", () => {
    let graph = EMPTY_TASK_DECOMPOSITION;
    graph = addTaskDecompositionNode(graph, { id: "deploy", preconditions: ["tests_passed"], postconditions: ["deployed"], cost: 1, risk: 0.4 });
    const result = replan(graph, { invalidatedConditionIds: ["tests_passed"] });
    expect(result.blockedNodeIds).toEqual(["deploy"]);
  });
});

describe("nodeCanExecute (plan item 181)", () => {
  it("a step whose precondition no longer holds after replanning cannot execute", () => {
    let graph = EMPTY_TASK_DECOMPOSITION;
    graph = addTaskDecompositionNode(graph, { id: "deploy", preconditions: ["tests_passed"], postconditions: ["deployed"], cost: 1, risk: 0.4 });
    const before = nodeCanExecute(graph, "deploy", new Set(["tests_passed"]));
    expect(before.allowed).toBe(true);

    const { graph: replanned } = replan(graph, { invalidatedConditionIds: ["tests_passed"] });
    const after = nodeCanExecute(replanned, "deploy", new Set());
    expect(after.allowed).toBe(false);
    expect(after.reason).toContain("tests_passed");
  });

  it("an already-completed node is refused for real execution, not silently re-run", () => {
    const graph = graphWithTwoIndependentCompletedTasks();
    const result = nodeCanExecute(graph, "fetch_data", new Set(["network_available"]));
    expect(result.allowed).toBe(false);
    expect(result.reason).toBe("already completed");
  });

  it("throws on an unknown node id rather than silently reporting it as blocked", () => {
    expect(() => nodeCanExecute(EMPTY_TASK_DECOMPOSITION, "ghost", new Set())).toThrow();
  });

  it("a node with multiple preconditions, only one of which currently holds, is still refused -- every precondition is required, not just some", () => {
    let graph = EMPTY_TASK_DECOMPOSITION;
    graph = addTaskDecompositionNode(graph, { id: "release", preconditions: ["tests_passed", "review_approved"], postconditions: ["released"], cost: 1, risk: 0.6 });
    const result = nodeCanExecute(graph, "release", new Set(["tests_passed"]));
    expect(result.allowed).toBe(false);
    expect(result.reason).toContain("review_approved");
  });
});
