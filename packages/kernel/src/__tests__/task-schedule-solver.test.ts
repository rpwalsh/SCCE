import { describe, expect, it } from "vitest";
import { solveTaskSchedule, verifyTaskScheduleOrder, type SchedulableTask } from "../task-schedule-solver.js";

describe("task schedule solver (plan items 173-174, precedence scheduling)", () => {
  it("produces a schedule that satisfies every dependency edge exactly, for a diamond-shaped DAG", () => {
    const tasks: SchedulableTask[] = [
      { id: "build", dependencyIds: [] },
      { id: "test-unit", dependencyIds: ["build"] },
      { id: "test-integration", dependencyIds: ["build"] },
      { id: "release", dependencyIds: ["test-unit", "test-integration"] }
    ];

    const result = solveTaskSchedule(tasks);
    expect(result.status).toBe("scheduled");
    if (result.status === "scheduled") {
      expect(verifyTaskScheduleOrder(tasks, result.order)).toBe(true);
      expect(result.order[0]).toBe("build");
      expect(result.order[result.order.length - 1]).toBe("release");
    }
  });

  it("is deterministic: the same input always compiles to the same order", () => {
    const tasks: SchedulableTask[] = [
      { id: "c", dependencyIds: ["a", "b"] },
      { id: "a", dependencyIds: [] },
      { id: "b", dependencyIds: [] },
      { id: "d", dependencyIds: ["c"] }
    ];
    const first = solveTaskSchedule(tasks);
    const second = solveTaskSchedule(tasks);
    expect(first).toEqual(second);
  });

  it("detects a real cycle and reports its actual members rather than a generic failure", () => {
    const tasks: SchedulableTask[] = [
      { id: "x", dependencyIds: ["z"] },
      { id: "y", dependencyIds: ["x"] },
      { id: "z", dependencyIds: ["y"] }
    ];
    const result = solveTaskSchedule(tasks);
    expect(result.status).toBe("infeasible");
    if (result.status === "infeasible") {
      expect(result.reason).toBe("cycle");
      expect(new Set(result.cycle)).toEqual(new Set(["x", "y", "z"]));
    }
  });

  it("detects a cycle that coexists with an unrelated, independently schedulable component", () => {
    const tasks: SchedulableTask[] = [
      { id: "independent", dependencyIds: [] },
      { id: "p", dependencyIds: ["q"] },
      { id: "q", dependencyIds: ["p"] }
    ];
    const result = solveTaskSchedule(tasks);
    expect(result.status).toBe("infeasible");
    if (result.status === "infeasible") expect(new Set(result.cycle)).toEqual(new Set(["p", "q"]));
  });

  it("detects a direct self-dependency as a one-element cycle", () => {
    const tasks: SchedulableTask[] = [{ id: "self", dependencyIds: ["self"] }];
    const result = solveTaskSchedule(tasks);
    expect(result.status).toBe("infeasible");
    if (result.status === "infeasible") expect(result.cycle).toEqual(["self"]);
  });

  it("rejects a task that declares a dependency on an unknown task id", () => {
    const tasks: SchedulableTask[] = [{ id: "a", dependencyIds: ["missing"] }];
    expect(() => solveTaskSchedule(tasks)).toThrow(/unknown task/);
  });

  it("verifyTaskScheduleOrder rejects an order that violates a real dependency, not just a malformed one", () => {
    const tasks: SchedulableTask[] = [
      { id: "a", dependencyIds: [] },
      { id: "b", dependencyIds: ["a"] }
    ];
    expect(verifyTaskScheduleOrder(tasks, ["b", "a"])).toBe(false);
    expect(verifyTaskScheduleOrder(tasks, ["a", "b"])).toBe(true);
    expect(verifyTaskScheduleOrder(tasks, ["a"])).toBe(false);
    expect(verifyTaskScheduleOrder(tasks, ["a", "a"])).toBe(false);
  });

  it("round-trips correctly across every valid topological order of a wider synthetic DAG (bounded exhaustive check)", () => {
    // 6 tasks, a real branching structure with more than one legal order --
    // proves the solver's chosen order is *a* valid solution, and that
    // verifyTaskScheduleOrder correctly accepts every other valid
    // permutation too, not just the one the solver happens to produce.
    const tasks: SchedulableTask[] = [
      { id: "t1", dependencyIds: [] },
      { id: "t2", dependencyIds: [] },
      { id: "t3", dependencyIds: ["t1"] },
      { id: "t4", dependencyIds: ["t1", "t2"] },
      { id: "t5", dependencyIds: ["t3"] },
      { id: "t6", dependencyIds: ["t4", "t5"] }
    ];
    const result = solveTaskSchedule(tasks);
    expect(result.status).toBe("scheduled");
    if (result.status !== "scheduled") return;
    expect(verifyTaskScheduleOrder(tasks, result.order)).toBe(true);

    for (const permutation of permutations(result.order)) {
      const expected = isTopologicallyValid(tasks, permutation);
      expect(verifyTaskScheduleOrder(tasks, permutation)).toBe(expected);
    }
  });
});

function isTopologicallyValid(tasks: readonly SchedulableTask[], order: readonly string[]): boolean {
  const position = new Map(order.map((id, index) => [id, index]));
  return tasks.every(task => task.dependencyIds.every(dependencyId => position.get(dependencyId)! < position.get(task.id)!));
}

function permutations<T>(items: readonly T[]): T[][] {
  if (items.length <= 1) return [[...items]];
  const [first, ...rest] = items;
  const restPermutations = permutations(rest);
  const out: T[][] = [];
  for (const permutation of restPermutations) {
    for (let index = 0; index <= permutation.length; index++) {
      out.push([...permutation.slice(0, index), first as T, ...permutation.slice(index)]);
    }
  }
  return out;
}
