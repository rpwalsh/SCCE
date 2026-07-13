import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, test } from "vitest";
import { createPatchTransactionPlan } from "@scce/kernel";
import {
  buildDockerSandboxExecInvocation,
  buildDockerSandboxRunInvocation,
  createDockerSandboxPatchValidationProvider
} from "../docker-sandbox-patch-validation.js";
import { runStructuredPatchValidation, type StructuredPatchValidationPolicy } from "../structured-patch-validation.js";
import type { WorkspacePatchValidationView } from "../workspace-patch-transaction.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});

describe("Docker sandbox patch validation", () => {
  test("builds a shell-free, network-disabled, resource-bounded validation invocation", () => {
    const invocation = buildDockerSandboxRunInvocation({
      dockerExecutable: "docker",
      image: `registry.example/scce-validator@sha256:${"a".repeat(64)}`,
      containerName: "scce-validation-fixture",
      cidFile: "C:\\temp\\validation.cid",
      network: "none",
      memoryBytes: 1024 * 1024 * 1024,
      cpus: 2,
      pidsLimit: 256,
      tmpfsBytes: 64 * 1024 * 1024,
      workspaceTmpfsBytes: 512 * 1024 * 1024,
      user: "1000:1000"
    });

    expect(invocation.executable).toBe("docker");
    expect(invocation.argv).toEqual(expect.arrayContaining([
      "--network", "none",
      "--read-only",
      "--cap-drop", "ALL",
      "--security-opt", "no-new-privileges"
    ]));
    expect(invocation.argv).not.toContain("--mount");
    expect(invocation.argv).toContainEqual(expect.stringContaining("/workspace:rw,nosuid,nodev,size=536870912"));

    const exec = buildDockerSandboxExecInvocation({
      dockerExecutable: "docker",
      containerName: "scce-validation-fixture",
      cwd: "packages/kernel",
      command: { executable: "node", argv: ["--test", "a b", "$(literal)"] },
      environment: { CI: "1" }
    });
    expect(exec.argv.slice(-5)).toEqual(["scce-validation-fixture", "node", "--test", "a b", "$(literal)"]);
    expect(exec.argv).toEqual(expect.arrayContaining(["--workdir", "/workspace/packages/kernel", "--env", "CI=1"]));
    expect(exec.argv).not.toContain("sh");
    expect(exec.argv).not.toContain("-c");
  });

  test("refuses mutable image references before contacting Docker", () => {
    expect(() => createDockerSandboxPatchValidationProvider({
      image: "node:20",
      dependencyMaterialization: materialization()
    })).toThrow(/must use a lowercase sha256 digest/u);
  });

  test("enforces the provider-specific host snapshot ceiling before contacting Docker", async () => {
    const root = await fixture();
    const provider = createDockerSandboxPatchValidationProvider({
      image: `registry.example/scce-validator@sha256:${"a".repeat(64)}`,
      dockerExecutable: "missing-docker-fixture",
      maxHostSnapshotBytes: 1,
      dependencyMaterialization: materialization()
    });
    await expect(provider.execute({
      stageRoot: root,
      policy: policy([{ executable: "node", argv: ["--version"] }])
    })).rejects.toThrow(/host snapshot byte limit: 1/u);
  });

  const liveTest = process.env.SCCE_DOCKER_LIVE === "1" ? test : test.skip;
  liveTest("executes patched source in a live network-disabled container and records backend identity", async () => {
    const image = process.env.SCCE_DOCKER_IMAGE;
    if (!image) throw new Error("SCCE_DOCKER_IMAGE is required for the live Docker validation test");
    const root = await fixture();
    const plan = createPatchTransactionPlan({ operations: [{ kind: "create", path: "patched.txt", content: "isolated-value" }] });
    const result = await runStructuredPatchValidation({
      workspaceRoot: root,
      validationView: validationView(plan),
      policy: policy([{ executable: "node", argv: ["-e", "const fs=require('node:fs');if(fs.readFileSync('patched.txt','utf8')!=='isolated-value')process.exit(9);if(fs.readdirSync('/sys/class/net').some(name=>name!=='lo'))process.exit(10);process.stdout.write('isolated-ok')"] }]),
      provider: createDockerSandboxPatchValidationProvider({
        image,
        dependencyMaterialization: materialization(),
        materializationNetwork: "bridge",
        maxHostSnapshotBytes: 1024 * 1024
      })
    });

    expect(result.ok).toBe(true);
    const evidence = result.evidence as {
      execution: {
        verificationLevel: string;
        backendIdentity: Record<string, string>;
        executionId?: string;
      };
      dependencyMaterialization: { sourceOverlayDeferred: boolean; containerId?: string; command: { code: number | null } };
      commands: Array<{ code: number | null; stdout: string }>;
    };
    expect(evidence.execution.verificationLevel).toBe("os-sandbox-executed");
    expect(evidence.execution.executionId).toMatch(/^[0-9a-f]{12,64}$/u);
    expect(evidence.execution.backendIdentity).toMatchObject({
      imageReference: image,
      validationNetwork: "none",
      materializationNetwork: "bridge",
      maxHostSnapshotBytes: String(1024 * 1024)
    });
    expect(Number(evidence.execution.backendIdentity.hostSnapshotByteCount)).toBeGreaterThan(0);
    expect(evidence.execution.backendIdentity.imageId).toMatch(/^sha256:[0-9a-f]{64}$/u);
    expect(evidence.dependencyMaterialization).toMatchObject({ sourceOverlayDeferred: true, command: { code: 0 } });
    expect(evidence.dependencyMaterialization.containerId).toMatch(/^[0-9a-f]{12,64}$/u);
    expect(evidence.commands).toEqual([expect.objectContaining({ code: 0, stdout: "isolated-ok" })]);
    await expect(readFile(join(root, "patched.txt"))).rejects.toMatchObject({ code: "ENOENT" });
    await expect(readFile(join(root, ".yopp-validation"))).rejects.toMatchObject({ code: "ENOENT" });
  }, 180_000);
});

async function fixture(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "scce-docker-validation-"));
  roots.push(root);
  await writeFile(join(root, "package.json"), JSON.stringify({ private: true, packageManager: "pnpm@10.28.2" }), "utf8");
  await writeFile(join(root, "pnpm-lock.yaml"), [
    "lockfileVersion: '9.0'",
    "settings:",
    "  autoInstallPeers: true",
    "  excludeLinksFromLockfile: false",
    "importers:",
    "  .: {}",
    ""
  ].join("\n"), "utf8");
  await writeFile(join(root, "source.txt"), "source-is-not-a-dependency-input", "utf8");
  return root;
}

function materialization() {
  return {
    schemaVersion: "scce.pnpm-frozen-materialization.v1" as const,
    rootPackagePath: "package.json",
    lockfilePath: "pnpm-lock.yaml",
    inputPaths: ["package.json", "pnpm-lock.yaml"]
  };
}

function policy(commands: StructuredPatchValidationPolicy["commands"]): StructuredPatchValidationPolicy {
  return {
    schemaVersion: "yopp.patch-validation-policy.v1",
    id: "docker-live-fixture.v1",
    commands,
    timeoutMs: 120_000,
    maxOutputBytes: 64 * 1024,
    maxWorkspaceFiles: 100,
    maxWorkspaceBytes: 1024 * 1024,
    environment: { CI: "1" }
  };
}

function validationView(plan: ReturnType<typeof createPatchTransactionPlan>): WorkspacePatchValidationView {
  return {
    plan,
    async readFile(path) {
      return path === "patched.txt" ? new TextEncoder().encode("isolated-value") : undefined;
    },
    async readText(path) {
      return path === "patched.txt" ? "isolated-value" : undefined;
    }
  };
}
