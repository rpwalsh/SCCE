import { describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { parseReviewedPatchPlan, parseWorkspacePatchAttempt } from "../patch-protocol.js";

describe("VS Code reviewed patch protocol", () => {
  it("accepts the kernel's canonical plan and independently verifies its hashes", () => {
    const plan = fixturePlan([
      { kind: "create", path: "src/b.ts", content: "new" },
      { kind: "replace", path: "src/a.ts", before: "before", content: "after" }
    ]);
    expect(parseReviewedPatchPlan(plan)).toEqual(plan);
  });

  it("rejects content edits, plan-hash edits, unsafe paths, and unknown fields", () => {
    const plan = fixturePlan([{ kind: "create", path: "src/a.ts", content: "new" }]);
    expect(() => parseReviewedPatchPlan({ ...plan, operations: [{ ...plan.operations[0], content: "edited" }] })).toThrow(/content hash/u);
    expect(() => parseReviewedPatchPlan({ ...plan, planHash: `sha256:${"0".repeat(64)}` })).toThrow(/does not match planHash/u);
    expect(() => parseReviewedPatchPlan({ ...plan, operations: [{ ...plan.operations[0], path: "../a.ts" }] })).toThrow(/unsafe segment/u);
    expect(() => parseReviewedPatchPlan({ ...plan, executable: "powershell" })).toThrow(/fields are invalid/u);
  });

  it("strictly distinguishes pending approval from a matching receipt shape", () => {
    expect(parseWorkspacePatchAttempt({
      ok: false,
      pendingApproval: {
        planId: "approval-1",
        capabilityId: "workspace.patch.apply",
        fingerprint: "a".repeat(64),
        reason: "operator-approval-required",
        createdAt: 1
      },
      session: {}
    })).toMatchObject({ ok: false, pendingApproval: { planId: "approval-1" } });
    expect(() => parseWorkspacePatchAttempt({ ok: false, pendingApproval: { planId: "approval-1", capabilityId: "other" }, session: {} })).toThrow();
  });
});

function fixturePlan(inputs: Array<{ kind: "create"; path: string; content: string } | { kind: "replace"; path: string; before: string; content: string }>) {
  const operations = inputs.map(input => input.kind === "create"
    ? { kind: "create", path: input.path, beforeContentHash: null, afterContentHash: sha256(input.content), content: input.content }
    : { kind: "replace", path: input.path, beforeContentHash: sha256(input.before), afterContentHash: sha256(input.content), content: input.content })
    .sort((left, right) => left.path.localeCompare(right.path));
  const payload = { schemaVersion: "yopp.patch-transaction-plan.v1", operations };
  return { ...payload, planHash: sha256(JSON.stringify(canonical(payload))) };
}

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object") return Object.fromEntries(Object.keys(value as Record<string, unknown>).sort().map(key => [key, canonical((value as Record<string, unknown>)[key])]));
  return value;
}

function sha256(value: string): `sha256:${string}` {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}
