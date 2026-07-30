import { describe, expect, it } from "vitest";
import { taskDecompositionForBlueprintOperations, type CodeEditOperation } from "../index.js";

function operation(overrides: Partial<CodeEditOperation> & Pick<CodeEditOperation, "id" | "kind" | "path">): CodeEditOperation {
  return {
    language: "typescript",
    intent: "fixture",
    preconditions: [],
    postconditions: [],
    evidenceIds: [],
    confidence: 0.8,
    risk: 0.1,
    ...overrides
  };
}

describe("taskDecompositionForBlueprintOperations", () => {
  it("requires a same-path create to complete before a verify, and a verify before a delete", () => {
    const create = operation({ id: "op.create", kind: "create", path: "src/a.ts", preconditions: ["graph.available"], postconditions: ["file.created"] });
    const verify = operation({ id: "op.verify", kind: "verify", path: "src/a.ts", preconditions: ["file.created"], postconditions: ["file.verified"] });
    const del = operation({ id: "op.delete", kind: "delete", path: "src/a.ts", preconditions: ["file.verified"], postconditions: ["file.removed"] });

    const graph = taskDecompositionForBlueprintOperations("root", [del, verify, create]);

    expect(graph.nodes["op.create"]?.precedesRequiresIds).toEqual([]);
    expect(graph.nodes["op.verify"]?.precedesRequiresIds).toEqual(["op.create"]);
    expect(graph.nodes["op.delete"]?.precedesRequiresIds).toEqual(["op.create", "op.verify"]);
  });

  it("does not require operations on a different path to complete first", () => {
    const createA = operation({ id: "op.a.create", kind: "create", path: "src/a.ts" });
    const createB = operation({ id: "op.b.create", kind: "create", path: "src/b.ts" });
    const verifyB = operation({ id: "op.b.verify", kind: "verify", path: "src/b.ts" });

    const graph = taskDecompositionForBlueprintOperations("root", [createA, createB, verifyB]);

    expect(graph.nodes["op.b.verify"]?.precedesRequiresIds).toEqual(["op.b.create"]);
    expect(graph.nodes["op.b.verify"]?.precedesRequiresIds).not.toContain("op.a.create");
  });

  it("never requires anything for an explain operation, since it only documents and never mutates", () => {
    const create = operation({ id: "op.create", kind: "create", path: "src/a.ts" });
    const explain = operation({ id: "op.explain", kind: "explain", path: "src/a.ts" });

    const graph = taskDecompositionForBlueprintOperations("root", [create, explain]);

    expect(graph.nodes["op.explain"]?.precedesRequiresIds).toEqual([]);
  });

  it("preserves each operation's own real preconditions/postconditions/risk on its node", () => {
    const create = operation({ id: "op.create", kind: "create", path: "src/a.ts", preconditions: ["p1"], postconditions: ["q1"], risk: 0.42 });

    const graph = taskDecompositionForBlueprintOperations("root", [create]);

    expect(graph.nodes["op.create"]).toMatchObject({ preconditions: ["p1"], postconditions: ["q1"], risk: 0.42, parentId: "root" });
  });

  it("de-duplicates repeated operation ids instead of throwing", () => {
    const create = operation({ id: "op.create", kind: "create", path: "src/a.ts" });

    expect(() => taskDecompositionForBlueprintOperations("root", [create, create])).not.toThrow();
  });

  it("builds a valid root node even for an empty operations list", () => {
    const graph = taskDecompositionForBlueprintOperations("root", []);
    expect(graph.nodes["root"]).toMatchObject({ cost: 0, risk: 0 });
  });
});
