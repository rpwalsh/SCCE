import { describe, expect, it } from "vitest";
import { createPatchTransactionPlan } from "@scce/kernel";
import {
  verifiedCompilerPlansForTurn,
  type WorkspaceCodingPatchPlanningResult
} from "../workspace-runtime.js";

describe("workspace compiler turn handoff", () => {
  it("admits only the selected, unauthorized, unexecuted compiler plan", () => {
    const plan = createPatchTransactionPlan({
      operations: [{ kind: "create", path: "src/new.ts", content: "export const value = 1;\n" }]
    });
    const result = selectedResult(plan);

    expect(verifiedCompilerPlansForTurn(result)).toEqual([plan]);
    expect(() => verifiedCompilerPlansForTurn({
      ...result,
      authorization: { ...result.authorization, granted: true }
    } as unknown as WorkspaceCodingPatchPlanningResult)).toThrow("requires absent execution authority");
    expect(() => verifiedCompilerPlansForTurn({
      ...result,
      execution: { state: "not_executed", receipt: { forged: true } }
    } as unknown as WorkspaceCodingPatchPlanningResult)).toThrow("requires an unexecuted plan");
  });

  it("does not turn an unresolved selector result into a plan", () => {
    expect(verifiedCompilerPlansForTurn({
      schema: "scce.workspace.transformation_family_selection.v1",
      selected: null
    } as unknown as WorkspaceCodingPatchPlanningResult)).toEqual([]);
  });
});

function selectedResult(plan: ReturnType<typeof createPatchTransactionPlan>) {
  return {
    schemaVersion: "scce.workspace.compiler_patch_plan.v1",
    statusId: "scce.workspace.compiler_patch.selected.v1",
    plan,
    selection: {
      selected: { patchPlan: plan, execution: { state: "not_executed" } }
    },
    authorization: {
      required: true,
      granted: false,
      capabilityId: "workspace.patch.apply"
    },
    execution: { state: "not_executed", receipt: null }
  } as unknown as Extract<WorkspaceCodingPatchPlanningResult, { statusId: "scce.workspace.compiler_patch.selected.v1" }>;
}
