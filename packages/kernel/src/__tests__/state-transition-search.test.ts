import { describe, expect, it } from "vitest";
import {
  evaluateStateTransitionScenario,
  searchStateTransitions,
  type StateTransitionScenario
} from "../state-transition-search.js";

describe("state transition search", () => {
  it("induces generic association, lookup, overwrite, and dissociation behavior", () => {
    const result = searchStateTransitions([
      scenario("put-get", [{ operationId: "op.alpha", arguments: ["a", 1] }, { operationId: "op.beta", arguments: ["a"] }], 1),
      scenario("overwrite", [{ operationId: "op.alpha", arguments: ["a", 1] }, { operationId: "op.alpha", arguments: ["a", 2] }, { operationId: "op.beta", arguments: ["a"] }], 2),
      scenario("delete", [{ operationId: "op.alpha", arguments: ["a", 3] }, { operationId: "op.gamma", arguments: ["a"] }, { operationId: "op.beta", arguments: ["a"] }], undefined),
      scenario("other-key", [{ operationId: "op.alpha", arguments: ["a", 4] }, { operationId: "op.beta", arguments: ["b"] }], undefined)
    ]);
    const selected = result.selected[0]!;

    expect(selected.operatorAssignments).toEqual({ "op.alpha": "associate", "op.beta": "lookup", "op.gamma": "dissociate" });
    expect(selected.predictedFitIds).toEqual(["delete", "other-key", "overwrite", "put-get"]);
    expect(selected.heldoutIds).toEqual([]);
    expect(selected.transitionIr).toEqual(expect.arrayContaining([
      { kind: "associate", operationId: "op.alpha", keyArgumentIndex: 0, valueArgumentIndex: 1 },
      { kind: "lookup", operationId: "op.beta", keyArgumentIndex: 0 },
      { kind: "dissociate", operationId: "op.gamma", keyArgumentIndex: 0 }
    ]));
    expect(evaluateStateTransitionScenario(selected, scenario("heldout", [{ operationId: "op.alpha", arguments: ["a", 9] }, { operationId: "op.beta", arguments: ["a"] }], 9))).toBe(9);
  });

  it("does not allow a held-out expected result to affect identity or ranking", () => {
    const fit = [
      scenario("fit.put-get", [{ operationId: "write", arguments: ["k", "v"] }, { operationId: "read", arguments: ["k"] }], "v"),
      scenario("fit.missing", [{ operationId: "read", arguments: ["missing"] }], undefined)
    ];
    const first = searchStateTransitions([...fit, heldout("held", [{ operationId: "write", arguments: ["x", "y"] }, { operationId: "read", arguments: ["x"] }], "y")]);
    const second = searchStateTransitions([...fit, heldout("held", [{ operationId: "write", arguments: ["x", "y"] }, { operationId: "read", arguments: ["x"] }], "corrupted")]);
    expect(first.selected).toHaveLength(1);
    expect(first.selected[0]!.predictedFitIds).toEqual(["fit.missing", "fit.put-get"]);
    expect(second).toEqual(first);
  });

  it("composes a causal put/get/delete module and reserves a held-out trace", () => {
    const fit = [
      scenario("fit.put-get", [{ operationId: "put", arguments: ["a", 1] }, { operationId: "get", arguments: ["a"] }], 1),
      scenario("fit.overwrite", [{ operationId: "put", arguments: ["a", 1] }, { operationId: "put", arguments: ["a", 2] }, { operationId: "get", arguments: ["a"] }], 2),
      scenario("fit.delete", [{ operationId: "put", arguments: ["a", 3] }, { operationId: "delete", arguments: ["a"] }, { operationId: "get", arguments: ["a"] }], null),
      scenario("fit.missing", [{ operationId: "get", arguments: ["missing"] }], null)
    ];
    const heldOutTrace = [{ operationId: "put", arguments: ["held", { value: 7 }] }, { operationId: "get", arguments: ["held"] }] as const;
    const first = searchStateTransitions([...fit, heldout("held-out", heldOutTrace, { value: 7 })]);
    const changed = searchStateTransitions([...fit, heldout("held-out", heldOutTrace, null)]);
    const selected = first.selected[0]!;

    expect(selected.operatorAssignments).toEqual({ put: "associate", get: "lookup", delete: "dissociate" });
    expect(selected.predictedFitIds).toEqual(["fit.delete", "fit.missing", "fit.overwrite", "fit.put-get"]);
    expect(selected.heldoutIds).toEqual(["held-out"]);
    expect(evaluateStateTransitionScenario(selected, {
      id: "held-out",
      invocations: heldOutTrace,
      expectedResult: { value: 7 },
      verificationRole: "held_out"
    })).toEqual({ value: 7 });
    expect(changed).toEqual(first);
  });
});

function scenario(id: string, invocations: StateTransitionScenario["invocations"], expectedResult: unknown): StateTransitionScenario {
  return { id, invocations, expectedResult, verificationRole: "fit" };
}

function heldout(id: string, invocations: StateTransitionScenario["invocations"], expectedResult: unknown): StateTransitionScenario {
  return { id, invocations, expectedResult, verificationRole: "held_out" };
}
