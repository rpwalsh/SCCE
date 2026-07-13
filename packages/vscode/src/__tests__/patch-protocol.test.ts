import { describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import {
  parseReviewedPatchPlan,
  parseWorkspaceCodingPatchPlanGeneration,
  parseWorkspacePatchAttempt,
  parseWorkspaceStatus,
  verifyWorkspaceCodingPatchPlanGeneration,
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

  it("accepts only an unauthorized, unexecuted coding plan with a matching request trace", () => {
    const request = fixtureCodingRequest();
    const generation = fixtureCodingGeneration(request);
    expect(verifyWorkspaceCodingPatchPlanGeneration(parseWorkspaceCodingPatchPlanGeneration(generation), request).plan.planHash).toBe(generation.plan.planHash);
    expect(() => parseWorkspaceCodingPatchPlanGeneration({ ...generation, command: "pnpm test" })).toThrow(/fields are invalid/u);
    expect(() => parseWorkspaceCodingPatchPlanGeneration({
      ...generation,
      authorization: { required: true, granted: true, capabilityId: "workspace.patch.apply" }
    })).toThrow(/unauthorized/u);
    expect(() => parseWorkspaceCodingPatchPlanGeneration({
      ...generation,
      execution: { state: "executed", receipt: {} }
    })).toThrow(/execution state/u);
    expect(() => verifyWorkspaceCodingPatchPlanGeneration(parseWorkspaceCodingPatchPlanGeneration({
      ...generation,
      programProposalTrace: { ...generation.programProposalTrace, requestHash: `sha256:${"0".repeat(64)}` }
    }), request)).toThrow(/request trace does not match/u);
    expect(() => verifyWorkspaceCodingPatchPlanGeneration(parseWorkspaceCodingPatchPlanGeneration({
      ...generation,
      programProposalTrace: { ...generation.programProposalTrace, selectedArtifactPaths: [] }
    }), request)).toThrow(/selected artifact trace/u);
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
    validationPlan: {
      validatorId: "trusted-host-pnpm-validate.v1",
      checks: ["compiler", "typecheck", "tests"]
    }
  };
}

function fixtureCodingGeneration(request: WorkspaceCodingPatchPlanRequest) {
  const revisionId = "revision-1";
  const revisionHash = sha256("revision-1");
  const evidenceIds = ["evidence-1"];
  const plan = fixturePlan([{ kind: "create", path: "src/new.ts", content: "export const value = 2;\n" }]);
  const requestHash = sha256(JSON.stringify(canonical({
    requestId: request.requestId,
    text: request.requestText,
    requestedPaths: request.requestedPaths,
    evidenceIds,
    revisionId,
    revisionHash
  })));
  return {
    schemaVersion: "yopp.workspace-plan-generation.v1",
    workspaceId: request.workspaceId,
    revisionId,
    revisionHash,
    plan,
    scoreTrace: { schemaVersion: "yopp.workspace-patch-score.v1" },
    safety: { snapshotComplete: true },
    validationPlan: { validatorId: "trusted-host-pnpm-validate.v1", checks: ["compiler", "tests", "typecheck"] },
    authorization: { required: true, granted: false, capabilityId: "workspace.patch.apply" },
    execution: { state: "not_executed", receipt: null },
    rollbackScope: "atomic-per-file-with-verified-transaction-rollback",
    programProposalTrace: {
      schemaVersion: "scce.workspace-program-proposal.trace.v1",
      source: "program-graph-full-file",
      requestId: request.requestId,
      requestHash,
      programId: "program-1",
      sourcePlanIds: ["source-plan-1"],
      evidenceIds,
      requestedPaths: request.requestedPaths,
      derivedDependencyPaths: [],
      selectedArtifactPaths: ["src/new.ts"],
      regressionTestPaths: [],
      verifiedParentDirectoryPaths: ["src"],
      hydrationValidated: true,
      fullFileMaterialized: true
    }
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
