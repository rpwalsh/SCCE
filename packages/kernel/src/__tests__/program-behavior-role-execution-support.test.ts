// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
import { describe, expect, it } from "vitest";
import {
  behaviorRoleExecutionGraphInputFromTaskConstraintGraph,
  projectProgramBehaviorRoleExecutionSupport,
  type BehaviorRoleExecutionGraphInput,
  type BehaviorRoleExecutionReceiptInput
} from "../program-behavior-role-execution-support.js";

describe("program behavior role execution support", () => {
  it("extracts construction and command identities from the exact task graph", () => {
    const taskGraph = {
      schema: "scce.workspace.task_constraint_graph.v1",
      id: "graph.exact",
      workspaceRevision: graph().workspaceRevision,
      analyzerRevision: { ...graph().analyzerRevision, compilerContext: null },
      nodes: [{
        id: "node.construction",
        kindId: "scce.program.behavior_role_construction.v1",
        subjectId: "construction.role",
        evidenceSpanIds: ["span.behavior"],
        contentHashes: [],
        metadata: {
          id: "construction.role",
          memberObservationIds: ["observation.b", "observation.a"]
        }
      }, {
        id: "node.command",
        kindId: "scce.task.validation.command.v1",
        subjectId: "command.tests",
        evidenceSpanIds: [],
        contentHashes: [],
        metadata: { commandId: "command.tests", checkId: "tests" }
      }],
      admissibleValidationCommandNodeIds: ["node.command"]
    } as never;
    const extracted = behaviorRoleExecutionGraphInputFromTaskConstraintGraph(taskGraph, [{ checkId: "tests", commandIndex: 1 }]);

    expect(extracted).toMatchObject({
      constructions: [{
        id: "construction.role",
        memberObservationIds: ["observation.a", "observation.b"],
        evidenceSpanIds: ["span.behavior"]
      }],
      validationCommandBindings: [{ commandId: "command.tests", checkId: "tests", commandIndex: 1 }]
    });
    expect(() => behaviorRoleExecutionGraphInputFromTaskConstraintGraph(taskGraph, []))
      .toThrow(/coverage is absent/u);
    expect(() => behaviorRoleExecutionGraphInputFromTaskConstraintGraph(taskGraph, [
      { checkId: "tests", commandIndex: 0 },
      { checkId: "tests", commandIndex: 1 }
    ])).toThrow(/coverage is ambiguous/u);
  });

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
      planHash: hash("a"),
      transactionReceiptHash: hash("b"),
      validationEvidenceHash: hash("c"),
      testExecution: {
        commandIndex: 1,
        commandEvidenceHash: hash("3"),
        graphCommandIds: ["command.tests"]
      }
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

  it("rejects server test execution when the graph has no tests command binding", () => {
    expect(() => projectProgramBehaviorRoleExecutionSupport({
      graph: { ...graph(), validationCommandBindings: [{ commandId: "command.build", checkId: "compiler", commandIndex: 0 }] },
      receipt: receipt([outcome("tests", 0)])
    })).toThrow(/graph-bound tests/u);
  });

  it("rejects a tests receipt from a different policy command", () => {
    expect(() => projectProgramBehaviorRoleExecutionSupport({
      graph: graph(),
      receipt: receipt([outcome("tests", 0)])
    })).toThrow(/does not match/u);
  });
});

function graph(): BehaviorRoleExecutionGraphInput {
  return {
    schema: "scce.workspace.task_constraint_graph.v1",
    id: "graph.exact",
    workspaceRevision: {
      workspaceId: "workspace.exact",
      revisionId: "revision.exact",
      revisionHash: hash("d")
    },
    analyzerRevision: {
      analyzerId: "analyzer.typescript",
      analyzerVersion: "5.8.3",
      semanticRevisionHash: hash("e")
    },
    validationCommandBindings: [
      { commandId: "command.build", checkId: "compiler", commandIndex: 1 },
      { commandId: "command.typecheck", checkId: "typecheck", commandIndex: 1 },
      { commandId: "command.tests", checkId: "tests", commandIndex: 1 }
    ],
    constructions: [{
      id: "construction.role",
      kindId: "scce.program.behavior_role_construction.v1",
      memberObservationIds: ["observation.b", "observation.a"],
      evidenceSpanIds: ["span.behavior"]
    }]
  };
}

function outcome(checkId: "compiler" | "typecheck" | "tests", commandIndex: number) {
  return {
    checkId,
    commandIndex,
    commandEvidenceHash: hash(checkId === "tests" ? "3" : checkId === "compiler" ? "4" : "5"),
    executed: true,
    passed: true
  } as const;
}

function receipt(commandOutcomes: BehaviorRoleExecutionReceiptInput["commandOutcomes"]): BehaviorRoleExecutionReceiptInput {
  return {
    planHash: hash("a"),
    transactionReceiptHash: hash("b"),
    validationEvidenceHash: hash("c"),
    commandOutcomes
  };
}

function hash(character: string): `sha256:${string}` {
  return `sha256:${character.repeat(64)}`;
}
