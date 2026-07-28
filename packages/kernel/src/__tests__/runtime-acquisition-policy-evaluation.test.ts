import { describe, expect, it } from "vitest";
import { recordConnectorDispatchPolicyEvaluation } from "../runtime-acquisition.js";
import { normalizeInformationLabel } from "../information-flow.js";
import { createHasher } from "../primitives.js";
import type { ScceKernelDeps } from "../storage.js";
import type { PolicyEvaluation } from "../policy-evolution.js";

describe("recordConnectorDispatchPolicyEvaluation's information label", () => {
  // A real production bug: this label used to be
  // { principals: [], exportClass: "internal", ... }, which
  // normalizeInformationLabel rejects (a non-public label requires at
  // least one principal) -- so every later READ of the row this wrote
  // crashed, not just the write. Regression-guards both branches.
  it("degrades to public when no principalId is configured, instead of writing a label that fails its own validation", async () => {
    let captured: PolicyEvaluation | undefined;
    const deps = {
      storage: { policyEvolution: { putEvaluation: async (evaluation: PolicyEvaluation) => { captured = evaluation; } } },
      policy: undefined,
      informationAccess: undefined
    } as unknown as ScceKernelDeps;

    await recordConnectorDispatchPolicyEvaluation({
      deps,
      hasher: createHasher(),
      disposition: "succeeded",
      windowRef: "event:fixture-1",
      createdAt: 1_000
    });

    expect(captured).toBeDefined();
    expect(() => normalizeInformationLabel(captured!.informationLabel)).not.toThrow();
    expect(captured!.informationLabel.exportClass).toBe("public");
  });

  it("stays internal, scoped to the configured principal, when informationAccess.principalId is set", async () => {
    let captured: PolicyEvaluation | undefined;
    const deps = {
      storage: { policyEvolution: { putEvaluation: async (evaluation: PolicyEvaluation) => { captured = evaluation; } } },
      policy: undefined,
      informationAccess: { tenantId: "tenant.fixture", principalId: "owner.fixture", compartments: [], maximumExportClass: "restricted" }
    } as unknown as ScceKernelDeps;

    await recordConnectorDispatchPolicyEvaluation({
      deps,
      hasher: createHasher(),
      disposition: "failed",
      windowRef: "event:fixture-2",
      createdAt: 2_000
    });

    expect(captured).toBeDefined();
    expect(() => normalizeInformationLabel(captured!.informationLabel)).not.toThrow();
    expect(captured!.informationLabel.exportClass).toBe("internal");
    expect(captured!.informationLabel.principals).toEqual(["owner.fixture"]);
  });

  it("does nothing when no policyEvolution store is configured (storage is optional)", async () => {
    const deps = { storage: {}, policy: undefined, informationAccess: undefined } as unknown as ScceKernelDeps;
    await expect(recordConnectorDispatchPolicyEvaluation({
      deps,
      hasher: createHasher(),
      disposition: "indeterminate",
      windowRef: "event:fixture-3",
      createdAt: 3_000
    })).resolves.toBeUndefined();
  });
});
