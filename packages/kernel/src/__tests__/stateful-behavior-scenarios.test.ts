import { describe, expect, it } from "vitest";
import { parseStatefulBehaviorScenarios } from "../stateful-behavior-scenarios.js";

describe("stateful behavior scenario parser", () => {
  it("extracts ordered state operations and holds out the last scenario", () => {
    const text = [
      "put(key, value); get(key); delete(key)",
      "put(\"a\", 4); get(\"a\") => 4",
      "put(\"a\", 9)\nget(\"a\") => 9",
      "delete(\"a\"); get(\"a\") => null",
      "put(\"b\", {\"n\": 2}); get(\"b\") => {\"n\": 2}"
    ].join("\n");
    const parsed = parseStatefulBehaviorScenarios(text);
    expect(parsed?.declaredCallableIds).toEqual(["delete", "get", "put"]);
    expect(parsed?.scenarios).toHaveLength(4);
    expect(parsed?.scenarios.map(scenario => scenario.verificationRole)).toEqual(["fit", "fit", "fit", "held_out"]);
    expect(parsed?.scenarios[0]?.invocations.map(invocation => [invocation.callableId, invocation.arguments])).toEqual([
      ["put", ["a", 4]], ["get", ["a"]]
    ]);
    expect(parsed?.scenarios[0]?.assertion.invocation).toMatchObject({ callableId: "get", arguments: ["a"] });
    expect(parsed?.scenarios[0]?.assertion.result).toBe(4);
    expect(parsed?.scenarios[3]?.assertion.result).toEqual({ n: 2 });
    expect(parsed?.requestHash).toMatch(/^sha256:[0-9a-f]{64}$/u);
    expect(parsed?.scenarios.every(scenario => /^sha256:[0-9a-f]{64}$/u.test(scenario.sourceHash))).toBe(true);
  });

  it("rejects prose and relations for undeclared callables", () => {
    expect(parseStatefulBehaviorScenarios("Explain get(\"a\") in prose.")).toBeUndefined();
    expect(parseStatefulBehaviorScenarios("foo(\"a\") => 4")).toBeUndefined();
    expect(parseStatefulBehaviorScenarios("get(key); get(\"a\") returns 4")).toBeUndefined();
  });
});
