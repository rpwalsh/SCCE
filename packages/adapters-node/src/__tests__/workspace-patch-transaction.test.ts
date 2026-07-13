import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import {
  PATCH_TRANSACTION_PLAN_SCHEMA,
  PATCH_TRANSACTION_RECEIPT_SCHEMA,
  PATCH_TRANSACTION_SCOPE,
  canonicalStringify,
  createPatchTransactionPlan,
  hashPatchContent,
  type PatchTransactionPlan
} from "@scce/kernel";
import { executeWorkspacePatchTransaction, WorkspacePatchTransactionError } from "../workspace-patch-transaction.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});

describe("workspace patch transaction", () => {
  it("commits staged content and returns exact deterministic immutable receipts", async () => {
    const root = await workspace();
    await writeFile(join(root, "source.ts"), "export const value = 1;\n", "utf8");
    const before = hashPatchContent("export const value = 1;\n");
    const after = hashPatchContent("export const value = 2;\n");
    const plan = createPatchTransactionPlan({ operations: [{
      kind: "replace",
      path: "source.ts",
      baseContentHash: before,
      content: "export const value = 2;\n"
    }] });

    const receipt = await executeWorkspacePatchTransaction({
      workspaceRoot: root,
      plan,
      async validate(view) {
        return {
          ok: (await view.readText("source.ts")) === "export const value = 2;\n",
          validatorId: "validator.targeted.source-value.v1",
          evidence: { stagedHash: after, check: "value-is-two" }
        };
      }
    });

    const planPayload = {
      schemaVersion: PATCH_TRANSACTION_PLAN_SCHEMA,
      operations: [{ kind: "replace", path: "source.ts", beforeContentHash: before, afterContentHash: after, content: "export const value = 2;\n" }]
    };
    const expectedPlanHash = shaCanonical(planPayload);
    const validation = {
      validatorId: "validator.targeted.source-value.v1",
      evidenceHash: shaCanonical({ stagedHash: after, check: "value-is-two" })
    };
    const mutationPayload = {
      schemaVersion: "yopp.patch-mutation-receipt.v1",
      planHash: expectedPlanHash,
      operationIndex: 0,
      kind: "replace",
      path: "source.ts",
      beforeContentHash: before,
      afterContentHash: after
    };
    const mutation = { ...mutationPayload, mutationHash: shaCanonical(mutationPayload) };
    const receiptPayload = {
      schemaVersion: PATCH_TRANSACTION_RECEIPT_SCHEMA,
      transactionScope: PATCH_TRANSACTION_SCOPE,
      planHash: expectedPlanHash,
      validation,
      mutations: [mutation]
    };
    expect(plan.planHash).toBe(expectedPlanHash);
    expect(receipt).toEqual({ ...receiptPayload, receiptHash: shaCanonical(receiptPayload) });
    expect(Object.isFrozen(receipt)).toBe(true);
    expect(Object.isFrozen(receipt.mutations)).toBe(true);
    expect(Object.isFrozen(receipt.mutations[0])).toBe(true);
    expect(await readFile(join(root, "source.ts"), "utf8")).toBe("export const value = 2;\n");
    expect((await readdir(root)).filter(name => name.includes(".yopp-"))).toEqual([]);
  });

  it("applies unambiguous create and delete operations", async () => {
    const root = await workspace();
    await writeFile(join(root, "obsolete.ts"), "obsolete\n", "utf8");
    const plan = createPatchTransactionPlan({ operations: [
      { kind: "delete", path: "obsolete.ts", baseContentHash: hashPatchContent("obsolete\n") },
      { kind: "create", path: "created.ts", content: "created\n" }
    ] });

    const receipt = await executeWorkspacePatchTransaction({ workspaceRoot: root, plan });

    expect(receipt.mutations.map(item => ({ kind: item.kind, path: item.path }))).toEqual([
      { kind: "create", path: "created.ts" },
      { kind: "delete", path: "obsolete.ts" }
    ]);
    expect(await readFile(join(root, "created.ts"), "utf8")).toBe("created\n");
    await expect(readFile(join(root, "obsolete.ts"), "utf8")).rejects.toMatchObject({ code: "ENOENT" });
    expect((await readdir(root)).filter(name => name.includes(".yopp-"))).toEqual([]);
  });

  it("refuses compare-and-set drift immediately before commit", async () => {
    const root = await workspace();
    const target = join(root, "source.ts");
    await writeFile(target, "base\n", "utf8");
    const plan = createPatchTransactionPlan({ operations: [{
      kind: "replace",
      path: "source.ts",
      baseContentHash: hashPatchContent("base\n"),
      content: "planned\n"
    }] });

    const error = await captureError(executeWorkspacePatchTransaction({
      workspaceRoot: root,
      plan,
      async validate() {
        await writeFile(target, "concurrent edit\n", "utf8");
        return { ok: true, validatorId: "validator.drift-fixture.v1", evidence: { staged: true } };
      }
    }));

    expect(error).toBeInstanceOf(WorkspacePatchTransactionError);
    expect((error as WorkspacePatchTransactionError).code).toBe("DRIFT_DETECTED");
    expect((error as WorkspacePatchTransactionError).rollback).toEqual({ attemptedPaths: [], restoredPaths: [], failures: [] });
    expect(await readFile(target, "utf8")).toBe("concurrent edit\n");
    expect((await readdir(root)).filter(name => name.includes(".yopp-"))).toEqual([]);
  });

  it("refuses traversal and a symbolic-link parent escape", async () => {
    expect(() => createPatchTransactionPlan({ operations: [{ kind: "create", path: "../escape.ts", content: "escaped\n" }] }))
      .toThrow(/unsafe segment/);

    const root = await workspace();
    const outside = await workspace();
    const linkPath = join(root, "linked");
    await symlink(outside, linkPath, process.platform === "win32" ? "junction" : "dir");
    const plan = createPatchTransactionPlan({ operations: [{ kind: "create", path: "linked/escape.ts", content: "escaped\n" }] });
    const error = await captureError(executeWorkspacePatchTransaction({ workspaceRoot: root, plan }));

    expect(error).toBeInstanceOf(WorkspacePatchTransactionError);
    expect((error as WorkspacePatchTransactionError).code).toBe("SYMLINK_REFUSED");
    await expect(readFile(join(outside, "escape.ts"), "utf8")).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("rolls back earlier atomic file replacements when a later commit step fails", async () => {
    const root = await workspace();
    await writeFile(join(root, "a.ts"), "a0\n", "utf8");
    await writeFile(join(root, "b.ts"), "b0\n", "utf8");
    const plan = createPatchTransactionPlan({ operations: [
      { kind: "replace", path: "a.ts", baseContentHash: hashPatchContent("a0\n"), content: "a1\n" },
      { kind: "replace", path: "b.ts", baseContentHash: hashPatchContent("b0\n"), content: "b1\n" }
    ] });

    const error = await captureError(executeWorkspacePatchTransaction({
      workspaceRoot: root,
      plan,
      testFailpoint(event) {
        if (event.phase === "beforeApply" && event.operationIndex === 1) throw new Error("fixture commit failure");
      }
    }));

    expect(error).toBeInstanceOf(WorkspacePatchTransactionError);
    expect((error as WorkspacePatchTransactionError).code).toBe("COMMIT_FAILED");
    expect((error as WorkspacePatchTransactionError).rollback).toEqual({
      attemptedPaths: ["a.ts"],
      restoredPaths: ["a.ts"],
      failures: []
    });
    expect(await readFile(join(root, "a.ts"), "utf8")).toBe("a0\n");
    expect(await readFile(join(root, "b.ts"), "utf8")).toBe("b0\n");
    expect((await readdir(root)).filter(name => name.includes(".yopp-"))).toEqual([]);
  });

  it("preserves existing assertion files byte-for-byte and commits nothing when one is targeted", async () => {
    const root = await workspace();
    await mkdir(join(root, "src"));
    await mkdir(join(root, "tests"));
    const sourceBefore = "export const count = 12;\n";
    const assertionBefore = "assert.equal(count, 17);\n";
    await writeFile(join(root, "src", "count.ts"), sourceBefore, "utf8");
    await writeFile(join(root, "tests", "count.test.ts"), assertionBefore, "utf8");
    const plan = createPatchTransactionPlan({ operations: [
      { kind: "replace", path: "src/count.ts", baseContentHash: hashPatchContent(sourceBefore), content: "export const count = 17;\n" },
      { kind: "replace", path: "tests/count.test.ts", baseContentHash: hashPatchContent(assertionBefore), content: "assert.ok(count >= 0);\n" }
    ] });

    const error = await captureError(executeWorkspacePatchTransaction({ workspaceRoot: root, plan }));

    expect(error).toBeInstanceOf(WorkspacePatchTransactionError);
    expect((error as WorkspacePatchTransactionError).code).toBe("ASSERTION_FILE_PROTECTED");
    expect(await readFile(join(root, "src", "count.ts"), "utf8")).toBe(sourceBefore);
    expect(await readFile(join(root, "tests", "count.test.ts"), "utf8")).toBe(assertionBefore);
  });

  it("refuses a forged or mutated plan before filesystem access", async () => {
    const root = await workspace();
    const legitimate = createPatchTransactionPlan({ operations: [{ kind: "create", path: "safe.ts", content: "safe\n" }] });
    const forged = {
      ...legitimate,
      operations: [{ ...legitimate.operations[0], content: "forged\n" }]
    } as PatchTransactionPlan;

    const error = await captureError(executeWorkspacePatchTransaction({ workspaceRoot: root, plan: forged }));

    expect(error).toBeInstanceOf(WorkspacePatchTransactionError);
    expect((error as WorkspacePatchTransactionError).code).toBe("INVALID_PLAN");
    await expect(readFile(join(root, "safe.ts"), "utf8")).rejects.toMatchObject({ code: "ENOENT" });
  });
});

async function workspace(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "yopp-patch-transaction-"));
  roots.push(root);
  return root;
}

function shaCanonical(value: unknown): `sha256:${string}` {
  return `sha256:${createHash("sha256").update(canonicalStringify(value), "utf8").digest("hex")}`;
}

async function captureError(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
    throw new Error("expected transaction to fail");
  } catch (error) {
    return error;
  }
}
