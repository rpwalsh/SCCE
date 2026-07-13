import { createHash } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  reviewedPatchIntegritySummary,
  verifyAppliedPatchMatchesPlan,
  verifyAppliedWorkspaceState
} from "../patch-integrity.js";
import type {
  AppliedWorkspacePatch,
  PatchHash,
  ReviewedPatchOperation,
  ReviewedPatchPlan
} from "../patch-protocol.js";

const temporaryRoots: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});

describe("VS Code reviewed patch integrity", () => {
  it("binds every ordered receipt mutation exactly to the reviewed operation", () => {
    const plan = fixturePlan([
      { kind: "create", path: "src/a.ts", content: "created\n" },
      { kind: "replace", path: "src/b.ts", before: "before\n", content: "after\n" },
      { kind: "delete", path: "src/c.ts", before: "deleted\n" }
    ]);
    const applied = fixtureApplied(plan);
    expect(verifyAppliedPatchMatchesPlan(applied, plan)).toBe(applied);
  });

  it("rejects partial, reordered, or otherwise mismatched receipt mutations", () => {
    const plan = fixturePlan([
      { kind: "create", path: "src/a.ts", content: "created\n" },
      { kind: "replace", path: "src/b.ts", before: "before\n", content: "after\n" }
    ]);

    const partial = fixtureApplied(plan);
    partial.receipt.mutations.pop();
    expect(() => verifyAppliedPatchMatchesPlan(partial, plan)).toThrow(/mutation count/u);

    const reordered = fixtureApplied(plan);
    const first = reordered.receipt.mutations[0]!;
    const second = reordered.receipt.mutations[1]!;
    reordered.receipt.mutations = [{ ...second, operationIndex: 0 }, { ...first, operationIndex: 1 }];
    expect(() => verifyAppliedPatchMatchesPlan(reordered, plan)).toThrow(/path does not match/u);

    const wrongIndex = fixtureApplied(plan);
    wrongIndex.receipt.mutations[0]!.operationIndex = 1;
    expect(() => verifyAppliedPatchMatchesPlan(wrongIndex, plan)).toThrow(/operation index/u);

    const wrongPath = fixtureApplied(plan);
    wrongPath.receipt.mutations[0]!.path = "src/other.ts";
    expect(() => verifyAppliedPatchMatchesPlan(wrongPath, plan)).toThrow(/path does not match/u);

    const wrongKind = fixtureApplied(plan);
    wrongKind.receipt.mutations[0]!.kind = "replace";
    expect(() => verifyAppliedPatchMatchesPlan(wrongKind, plan)).toThrow(/kind does not match/u);

    const wrongBefore = fixtureApplied(plan);
    wrongBefore.receipt.mutations[0]!.beforeContentHash = sha256("unexpected-before");
    expect(() => verifyAppliedPatchMatchesPlan(wrongBefore, plan)).toThrow(/before-content hash/u);

    const wrongAfter = fixtureApplied(plan);
    wrongAfter.receipt.mutations[0]!.afterContentHash = sha256("unexpected-after");
    expect(() => verifyAppliedPatchMatchesPlan(wrongAfter, plan)).toThrow(/after-content hash/u);
  });

  it("re-reads all affected paths, verifies after hashes, and confirms deletions", async () => {
    const root = await temporaryRoot();
    await mkdir(join(root, "src"));
    await writeFile(join(root, "src", "a.ts"), "created\n", "utf8");
    await writeFile(join(root, "src", "b.ts"), "after\n", "utf8");
    const plan = fixturePlan([
      { kind: "create", path: "src/a.ts", content: "created\n" },
      { kind: "replace", path: "src/b.ts", before: "before\n", content: "after\n" },
      { kind: "delete", path: "src/c.ts", before: "deleted\n" }
    ]);

    await expect(verifyAppliedWorkspaceState(root, plan)).resolves.toBeUndefined();

    await writeFile(join(root, "src", "b.ts"), "tampered\n", "utf8");
    await expect(verifyAppliedWorkspaceState(root, plan)).rejects.toThrow(/content hash.*src\/b\.ts/u);
  });

  it("rejects missing post-apply files and delete targets that still exist", async () => {
    const root = await temporaryRoot();
    await mkdir(join(root, "src"));
    const createPlan = fixturePlan([{ kind: "create", path: "src/a.ts", content: "created\n" }]);
    await expect(verifyAppliedWorkspaceState(root, createPlan)).rejects.toThrow(/target is missing.*src\/a\.ts/u);

    await writeFile(join(root, "src", "c.ts"), "deleted\n", "utf8");
    const deletePlan = fixturePlan([{ kind: "delete", path: "src/c.ts", before: "deleted\n" }]);
    await expect(verifyAppliedWorkspaceState(root, deletePlan)).rejects.toThrow(/delete target still exists.*src\/c\.ts/u);
  });

  it("summarizes operation kinds and the rollback scope", () => {
    const plan = fixturePlan([
      { kind: "create", path: "src/a.ts", content: "created\n" },
      { kind: "replace", path: "src/b.ts", before: "before\n", content: "after\n" },
      { kind: "delete", path: "src/c.ts", before: "deleted\n" }
    ]);
    expect(reviewedPatchIntegritySummary(plan)).toBe([
      "Operations: create=1, replace=1, delete=1",
      "Rollback scope: atomic-per-file-with-verified-transaction-rollback"
    ].join("\n"));
  });
});

type FixtureOperation =
  | { kind: "create"; path: string; content: string }
  | { kind: "replace"; path: string; before: string; content: string }
  | { kind: "delete"; path: string; before: string };

function fixturePlan(inputs: FixtureOperation[]): ReviewedPatchPlan {
  const operations = inputs.map<ReviewedPatchOperation>(input => {
    if (input.kind === "create") {
      return { kind: "create", path: input.path, beforeContentHash: null, afterContentHash: sha256(input.content), content: input.content };
    }
    if (input.kind === "replace") {
      return { kind: "replace", path: input.path, beforeContentHash: sha256(input.before), afterContentHash: sha256(input.content), content: input.content };
    }
    return { kind: "delete", path: input.path, beforeContentHash: sha256(input.before), afterContentHash: null };
  }).sort((left, right) => left.path.localeCompare(right.path));
  const payload = { schemaVersion: "yopp.patch-transaction-plan.v1" as const, operations };
  return { ...payload, planHash: sha256(JSON.stringify(canonical(payload))) };
}

function fixtureApplied(plan: ReviewedPatchPlan): AppliedWorkspacePatch {
  const mutations = plan.operations.map((operation, operationIndex) => ({
    schemaVersion: "yopp.patch-mutation-receipt.v1" as const,
    planHash: plan.planHash,
    operationIndex,
    kind: operation.kind,
    path: operation.path,
    beforeContentHash: operation.beforeContentHash,
    afterContentHash: operation.afterContentHash,
    mutationHash: sha256(`mutation-${operationIndex}`)
  }));
  return {
    schemaVersion: "yopp.workspace-patch-response.v1",
    workspaceId: "workspace-1",
    validationPolicyId: "trusted-host-pnpm-validate.v1",
    receipt: {
      schemaVersion: "yopp.patch-transaction-receipt.v1",
      transactionScope: "atomic-per-file-with-verified-transaction-rollback",
      planHash: plan.planHash,
      validation: null,
      mutations,
      receiptHash: sha256("receipt")
    }
  };
}

async function temporaryRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "scce-vscode-integrity-"));
  temporaryRoots.push(root);
  return root;
}

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.keys(value as Record<string, unknown>).sort().map(key => [key, canonical((value as Record<string, unknown>)[key])]));
  }
  return value;
}

function sha256(value: string): PatchHash {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}
