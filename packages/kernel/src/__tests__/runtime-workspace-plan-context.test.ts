import { describe, expect, it } from "vitest";
import { createPatchTransactionPlan } from "../patch-transaction.js";
import { runtimeWorkspacePlanContext } from "../runtime-workspace-plan-context.js";
import { toJsonValue } from "../primitives.js";

describe("runtime workspace plan context", () => {
  it("binds a verified plan and derives routing only from the structured plan", () => {
    const plan = createPatchTransactionPlan({
      operations: [{ kind: "replace", path: "src/index.ts", baseContentHash: "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", content: "export const value = 2;\n" }]
    });
    const metadata = toJsonValue({ runtime: { workspacePlans: [plan] } });

    const first = runtimeWorkspacePlanContext(metadata, "surface one");
    const second = runtimeWorkspacePlanContext(metadata, "поверхность два");

    expect(first.plans).toEqual([plan]);
    expect(first.explicitRequirements.map(row => [row.dimension, row.value])).toEqual(
      second.explicitRequirements.map(row => [row.dimension, row.value])
    );
    expect(first.audit).toMatchObject({
      planHashes: [plan.planHash],
      authorizationGranted: false,
      executionState: "not_executed",
      requestSurfaceRoutingUsed: false
    });
  });

  it("rejects a plan whose content-addressed identity was altered", () => {
    const plan = createPatchTransactionPlan({
      operations: [{ kind: "create", path: "src/new.ts", content: "export const value = 1;\n" }]
    });
    const altered = { ...plan, planHash: "sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb" };
    expect(() => runtimeWorkspacePlanContext(toJsonValue({ runtime: { workspacePlans: [altered] } }), "x"))
      .toThrow("patch transaction plan hash or derived content hashes are invalid");
  });
});
