import { describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import {
  parseReviewedPatchPlan,
  parseWorkspaceCodingPatchPlanResult,
  parseWorkspacePatchAttempt,
  parseWorkspaceStatus,
  type WorkspaceCodingPatchPlanRequest
} from "../patch-protocol.js";

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
    const nulContent = "new\0content";
    expect(() => parseReviewedPatchPlan(fixturePlan([{ kind: "create", path: "src/nul.ts", content: nulContent }]))).toThrow(/NUL/u);
    expect(() => parseReviewedPatchPlan({ ...plan, executable: "powershell" })).toThrow(/fields are invalid/u);
    const unordered = fixturePlan([
      { kind: "create", path: "src/a.ts", content: "a" },
      { kind: "create", path: "src/b.ts", content: "b" }
    ]);
    expect(() => parseReviewedPatchPlan({ ...unordered, operations: [...unordered.operations].reverse(), planHash: sha256(JSON.stringify(canonical({ schemaVersion: unordered.schemaVersion, operations: [...unordered.operations].reverse() }))) })).toThrow(/canonical path order/u);
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

  it("extracts normalized durable source paths and requires a revision timestamp", () => {
    expect(parseWorkspaceStatus({
      workspace: { id: "workspace-1", rootPath: "C:\\repo", updatedAt: 10, metadata: {} },
      sources: [{ path: "src/z.ts", byteLength: 1 }, { path: "src/a.ts", byteLength: 2 }]
    })).toEqual({
      workspace: { id: "workspace-1", rootPath: "C:\\repo", updatedAt: 10 },
      sources: [{ path: "src/a.ts" }, { path: "src/z.ts" }]
    });
    expect(() => parseWorkspaceStatus({ workspace: { id: "workspace-1", rootPath: "C:\\repo" }, sources: [] })).toThrow(/updatedAt/u);
    expect(() => parseWorkspaceStatus({ workspace: { id: "workspace-1", rootPath: "C:\\repo", updatedAt: 10 }, sources: [{ path: "../outside.ts" }] })).toThrow(/unsafe/u);
    expect(() => parseWorkspaceStatus({ workspace: null, sources: [] })).toThrow(/initialize and ingest/u);
  });

  it("parses only a request-bound, unauthorized selected compiler plan", () => {
    const request = fixtureCodingRequest();
    const generation = fixtureCodingGeneration(request);
    const parsed = parseWorkspaceCodingPatchPlanResult(generation, request);
    expect(parsed).toMatchObject({ kind: "selected", diagnosticCode: 6133, plan: { planHash: generation.plan.planHash } });
    expect(() => parseWorkspaceCodingPatchPlanResult({ ...generation, command: "pnpm test" }, request)).toThrow(/fields are invalid/u);
    expect(() => parseWorkspaceCodingPatchPlanResult({
      ...generation,
      authorization: { required: true, granted: true, capabilityId: "workspace.patch.apply" }
    }, request)).toThrow(/unauthorized/u);
    expect(() => parseWorkspaceCodingPatchPlanResult({
      ...generation,
      execution: { state: "executed", receipt: {} }
    }, request)).toThrow(/state/u);
    expect(() => parseWorkspaceCodingPatchPlanResult({
      ...generation,
      constraintGraph: { ...generation.constraintGraph, requestId: "another-request" }
    }, request)).toThrow(/another request/u);
  });

  it("parses an unresolved compiler result without producing a plan", () => {
    const request = fixtureCodingRequest();
    const result = parseWorkspaceCodingPatchPlanResult({
      schemaVersion: "scce.workspace.compiler_patch_plan.v1",
      statusId: "scce.workspace.compiler_patch.unresolved.v1",
      workspaceId: request.workspaceId,
      revisionId: "revision-1",
      revisionHash: sha256("revision-1"),
      requestId: request.requestId,
      requestedPaths: request.requestedPaths,
      reasonIds: ["scce.workspace.compiler_patch.unresolved.compiler_lane_absent.v1"],
      observedCompilerLaneCount: 0,
      selection: null,
      plan: null,
      execution: { state: "not_executed", receipt: null }
    }, request);
    expect(result).toEqual(expect.objectContaining({
      kind: "unresolved",
      reasonIds: ["scce.workspace.compiler_patch.unresolved.compiler_lane_absent.v1"]
    }));
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

function fixtureCodingRequest(): WorkspaceCodingPatchPlanRequest {
  return {
    schemaVersion: "scce.workspace-coding-patch-plan-request.v1",
    workspaceId: "workspace-1",
    expectedWorkspaceUpdatedAt: 10,
    requestId: "request-1",
    requestText: "Add the verified value export.",
    requestedPaths: ["src/new.ts"],
    diagnosticCodes: [6133],
    validationPlan: {
      validatorId: "trusted-host-pnpm-validate.v1",
      checks: ["compiler", "typecheck", "tests"]
    }
  };
}

function fixtureCodingGeneration(request: WorkspaceCodingPatchPlanRequest) {
  const revisionId = "revision-1";
  const revisionHash = sha256("revision-1");
  const plan = fixturePlan([{ kind: "create", path: "src/new.ts", content: "export const value = 2;\n" }]);
  const diagnosticIdentity = "diagnostic-6133";
  const diagnosticNodeId = "diagnostic-node-6133";
  const graphId = "constraint-graph-1";
  return {
    schemaVersion: "scce.workspace.compiler_patch_plan.v1",
    statusId: "scce.workspace.compiler_patch.selected.v1",
    workspaceId: request.workspaceId,
    revisionId,
    revisionHash,
    constraintGraph: {
      schema: "scce.workspace.task_constraint_graph.v1",
      id: graphId,
      workspaceRevision: { workspaceId: request.workspaceId, revisionId, revisionHash },
      requestId: request.requestId,
      nodes: [
        { id: "request-node", kindId: "scce.task.request.v1", subjectId: request.requestId, metadata: { requestedPaths: request.requestedPaths } },
        { id: diagnosticNodeId, kindId: "scce.program.diagnostic.v1", subjectId: diagnosticIdentity, metadata: { compilerCode: 6133, diagnosticIdentity } }
      ],
      diagnosticNodeIds: [diagnosticNodeId],
      execution: { state: "not_executed" }
    },
    selection: {
      schema: "scce.workspace.transformation_family_selection.v1",
      graphId,
      selected: {
        familyId: "repair.family.typescript.code_action.v1",
        candidateId: "candidate-1",
        diagnosticIdentity,
        codeFixIdentity: "code-fix-1",
        diagnosticNodeId,
        patchPlan: plan,
        execution: { state: "not_executed" }
      },
      execution: { state: "not_executed" }
    },
    plan,
    validationPlan: request.validationPlan,
    authorization: { required: true, granted: false, capabilityId: "workspace.patch.apply" },
    execution: { state: "not_executed", receipt: null }
  };
}

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object") return Object.fromEntries(Object.keys(value as Record<string, unknown>).sort().map(key => [key, canonical((value as Record<string, unknown>)[key])]));
  return value;
}

function sha256(value: string): `sha256:${string}` {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}
