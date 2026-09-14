import { describe, expect, it } from "vitest";
import {
  projectProgramBehaviorRoleExecutionSupport,
  type BehaviorRoleExecutionGraphInput,
  type BehaviorRoleExecutionReceiptInput
} from "../program-behavior-role-execution-support.js";

describe("program behavior role execution support", () => {
  it("projects only passing tests execution onto graph-bound structural constructions", () => {
    const result = projectProgramBehaviorRoleExecutionSupport({
      graph: graph(),
      receipt: receipt([
        outcome("compiler", 0),
        outcome("tests", 1)
      ])
    });

    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({
      semanticStatus: "execution_supported_unassigned",
      constructionId: "construction.role",
      memberObservationIds: ["observation.a", "observation.b"],
      graphId: "graph.exact",
      planHash: "sha256:plan",
      transactionReceiptHash: "sha256:receipt",
      validationEvidenceHash: "sha256:evidence",
      testCommandBindings: [{
        commandId: "command.tests",
        commandIndex: 1,
        commandEvidenceHash: "sha256:command-tests"
      }]
    });
  });

  it.each([
    ["build-only", [outcome("compiler", 0)]],
    ["typecheck-only", [outcome("typecheck", 0)]],
    ["failed-tests", [{ ...outcome("tests", 0), passed: false }]],
    ["incomplete-tests", [{ ...outcome("tests", 0), executed: false }]]
  ] as const)("rejects %s validation", (_label, commandOutcomes) => {
    expect(() => projectProgramBehaviorRoleExecutionSupport({ graph: graph(), receipt: receipt(commandOutcomes) }))
      .toThrow();
  });

  it("rejects tests execution when the exact graph has no tests command binding", () => {
    expect(() => projectProgramBehaviorRoleExecutionSupport({
      graph: { ...graph(), validationCommandBindings: [{ commandId: "command.build", checkId: "compiler" }] },
      receipt: receipt([outcome("tests", 0)])
    })).toThrow(/graph-bound tests/u);
  });
});

function graph(): BehaviorRoleExecutionGraphInput {
  return {
    schema: "scce.workspace.task_constraint_graph.v1",
    id: "graph.exact",
    workspaceRevision: {
      workspaceId: "workspace.exact",
      revisionId: "revision.exact",
      revisionHash: "sha256:revision"
    },
    analyzerRevision: {
      analyzerId: "analyzer.typescript",
      analyzerVersion: "5.8.3",
      semanticRevisionHash: "sha256:semantic"
    },
    validationCommandBindings: [
      { commandId: "command.build", checkId: "compiler" },
      { commandId: "command.typecheck", checkId: "typecheck" },
      { commandId: "command.tests", checkId: "tests" }
    ],
    constructions: [{
      id: "construction.role",
      kindId: "scce.program.behavior_role_construction.v1",
      memberObservationIds: ["observation.b", "observation.a"]
    }]
  };
}

function outcome(checkId: "compiler" | "typecheck" | "tests", commandIndex: number) {
  return {
    checkId,
    commandIndex,
    commandEvidenceHash: `sha256:command-${checkId}`,
    executed: true,
    passed: true
  } as const;
}

function receipt(commandOutcomes: BehaviorRoleExecutionReceiptInput["commandOutcomes"]): BehaviorRoleExecutionReceiptInput {
  return {
    planHash: "sha256:plan",
    transactionReceiptHash: "sha256:receipt",
    validationEvidenceHash: "sha256:evidence",
    commandOutcomes
  };
}
