import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, test } from "vitest";
import { createPatchTransactionPlan, hashPatchContent } from "@scce/kernel";
import { runStructuredPatchValidation, type StructuredPatchValidationPolicy } from "../structured-patch-validation.js";
import { executeWorkspacePatchTransaction, WorkspacePatchTransactionError, type WorkspacePatchValidationView } from "../workspace-patch-transaction.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});

describe("structured patch validation", () => {
  test("runs argv-only validation against patched staged content before commit", async () => {
    const root = await fixture();
    await writeFile(join(root, "value.txt"), "before", "utf8");
    const plan = createPatchTransactionPlan({
      operations: [{ kind: "replace", path: "value.txt", baseContentHash: hashPatchContent("before"), content: "after" }]
    });
    const receipt = await executeWorkspacePatchTransaction({
      workspaceRoot: root,
      plan,
      validate: view => runStructuredPatchValidation({
        workspaceRoot: root,
        validationView: view,
        policy: policy([
          {
            executable: process.execPath,
            argv: ["-e", "const fs=require('node:fs');if(fs.readFileSync('value.txt','utf8')!=='after')process.exit(7);process.stdout.write('saw-staged-patch')"]
          }
        ])
      })
    });

    expect(await readFile(join(root, "value.txt"), "utf8")).toBe("after");
    expect(receipt.validation?.validatorId).toBe("fixture-policy.v1");
    expect(receipt.validation?.evidenceHash).toMatch(/^sha256:[0-9a-f]{64}$/);
    await expect(readFile(join(root, ".yopp-validation"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  test("a failed command prevents mutation", async () => {
    const root = await fixture();
    await writeFile(join(root, "value.txt"), "before", "utf8");
    const plan = createPatchTransactionPlan({
      operations: [{ kind: "replace", path: "value.txt", baseContentHash: hashPatchContent("before"), content: "after" }]
    });
    const failure = await capture(executeWorkspacePatchTransaction({
      workspaceRoot: root,
      plan,
      validate: view => runStructuredPatchValidation({
        workspaceRoot: root,
        validationView: view,
        policy: policy([{ executable: process.execPath, argv: ["-e", "process.stderr.write('no');process.exit(9)"] }])
      })
    }));

    expect(failure).toBeInstanceOf(WorkspacePatchTransactionError);
    expect((failure as WorkspacePatchTransactionError).code).toBe("VALIDATION_FAILED");
    expect(await readFile(join(root, "value.txt"), "utf8")).toBe("before");
    await expect(readFile(join(root, ".yopp-validation"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  test("terminates commands at timeout and output bounds and cleans both stages", async () => {
    const root = await fixture();
    const plan = createPatchTransactionPlan({ operations: [{ kind: "create", path: "new.txt", content: "new" }] });
    const view = validationView(plan);

    const timed = await runStructuredPatchValidation({
      workspaceRoot: root,
      validationView: view,
      policy: policy([{ executable: process.execPath, argv: ["-e", "setTimeout(()=>{},10000)"] }], { timeoutMs: 100 })
    });
    expect(timed.ok).toBe(false);
    expect(evidence(timed).commands[0]?.timedOut).toBe(true);
    expect(evidence(timed).execution).toEqual({
      providerId: "trusted-host-process.v1",
      boundary: "trusted-host",
      backend: "node-child-process",
      verificationLevel: "local-process-executed"
    });

    const bounded = await runStructuredPatchValidation({
      workspaceRoot: root,
      validationView: view,
      policy: policy([{ executable: process.execPath, argv: ["-e", "process.stdout.write('x'.repeat(20000))"] }], { maxOutputBytes: 1024 })
    });
    expect(bounded.ok).toBe(false);
    expect(evidence(bounded).commands[0]?.outputLimitExceeded).toBe(true);
    expect(Buffer.byteLength(evidence(bounded).commands[0]?.stdout ?? "")).toBeLessThanOrEqual(1024);
    await expect(readFile(join(root, ".yopp-validation"))).rejects.toMatchObject({ code: "ENOENT" });
  });
});

async function fixture(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "yopp-structured-validation-"));
  roots.push(root);
  return root;
}

function policy(
  commands: StructuredPatchValidationPolicy["commands"],
  overrides: Partial<StructuredPatchValidationPolicy> = {}
): StructuredPatchValidationPolicy {
  return {
    schemaVersion: "yopp.patch-validation-policy.v1",
    id: "fixture-policy.v1",
    commands,
    timeoutMs: 5000,
    maxOutputBytes: 16 * 1024,
    maxWorkspaceFiles: 100,
    maxWorkspaceBytes: 1024 * 1024,
    ...overrides
  };
}

function validationView(plan: ReturnType<typeof createPatchTransactionPlan>): WorkspacePatchValidationView {
  return {
    plan,
    async readFile(path) {
      return path === "new.txt" ? new TextEncoder().encode("new") : undefined;
    },
    async readText(path) {
      return path === "new.txt" ? "new" : undefined;
    }
  };
}

function evidence(result: Awaited<ReturnType<typeof runStructuredPatchValidation>>) {
  return result.evidence as {
    execution: { providerId: string; boundary: string; backend: string; verificationLevel: string };
    commands: Array<{ timedOut: boolean; outputLimitExceeded: boolean; stdout: string }>;
  };
}

async function capture(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
    return undefined;
  } catch (error) {
    return error;
  }
}
