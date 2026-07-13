import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createPatchTransactionPlan, hashPatchContent } from "@scce/kernel";
import {
  DEFAULT_WORKSPACE_PATCH_VALIDATION_POLICY_ID,
  DOCKER_WORKSPACE_PATCH_VALIDATION_POLICY_ID,
  ROUTES,
  WORKSPACE_PATCH_REQUEST_SCHEMA,
  executeWorkspacePatchApiRequest,
  parseWorkspacePatchRequest,
  serverPatchValidationPolicy,
  serverPatchValidationRuntime,
  workspacePatchValidationApprovalBinding
} from "../routes.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});

describe("workspace patch API contract", () => {
  const plan = createPatchTransactionPlan({ operations: [{ kind: "create", path: "src/new.ts", content: "export const value = 1;\n" }] });

  it("registers one authenticated mutating database route and accepts only the content-addressed request contract", () => {
    expect(ROUTES).toContainEqual({
      method: "POST",
      path: "/api/workspace/patch",
      label: "workspace patch transaction",
      mutates: true,
      requiresDb: true
    });
    expect(parseWorkspacePatchRequest({
      schemaVersion: WORKSPACE_PATCH_REQUEST_SCHEMA,
      workspaceId: "workspace-1",
      plan,
      validationPolicyId: DEFAULT_WORKSPACE_PATCH_VALIDATION_POLICY_ID
    })).toEqual({
      schemaVersion: WORKSPACE_PATCH_REQUEST_SCHEMA,
      workspaceId: "workspace-1",
      plan,
      validationPolicyId: DEFAULT_WORKSPACE_PATCH_VALIDATION_POLICY_ID
    });
  });

  it("rejects client roots, command lines, unknown fields, and edited plan content", () => {
    const base = {
      schemaVersion: WORKSPACE_PATCH_REQUEST_SCHEMA,
      workspaceId: "workspace-1",
      plan,
      validationPolicyId: DEFAULT_WORKSPACE_PATCH_VALIDATION_POLICY_ID
    };
    expect(() => parseWorkspacePatchRequest({ ...base, workspaceRoot: "C:/escape" })).toThrow(/unexpected: workspaceRoot/u);
    expect(() => parseWorkspacePatchRequest({ ...base, executable: "powershell" })).toThrow(/unexpected: executable/u);
    expect(() => parseWorkspacePatchRequest({
      ...base,
      plan: { ...plan, operations: [{ ...plan.operations[0], content: "edited" }] }
    })).toThrow(/invalid content-addressed patch plan/u);
  });

  it("maps the registered policy to a server-owned shell-free pnpm validation command", () => {
    const config = { runtime: { tools: { pnpm: "pnpm-local" } } } as Parameters<typeof serverPatchValidationPolicy>[0];
    expect(serverPatchValidationPolicy(config, DEFAULT_WORKSPACE_PATCH_VALIDATION_POLICY_ID)).toMatchObject({
      id: DEFAULT_WORKSPACE_PATCH_VALIDATION_POLICY_ID,
      commands: [
        { executable: "pnpm-local", argv: ["install", "--offline", "--frozen-lockfile", "--ignore-scripts"], cwd: "." },
        { executable: "pnpm-local", argv: ["validate"], cwd: "." }
      ]
    });
    expect(() => serverPatchValidationPolicy(config, "client-command.v1")).toThrow(/unknown workspace patch validation policy/u);

    const platformDefault = serverPatchValidationPolicy({ runtime: { tools: { pnpm: "pnpm" } } } as Parameters<typeof serverPatchValidationPolicy>[0], DEFAULT_WORKSPACE_PATCH_VALIDATION_POLICY_ID);
    if (process.platform === "win32") {
      expect(platformDefault.commands[0]).toMatchObject({ executable: process.execPath, cwd: "." });
      expect(platformDefault.commands[1]?.argv.at(-1)).toBe("validate");
      expect(platformDefault.commands[0]?.argv[0]).toMatch(/corepack[\\/]dist[\\/]pnpm\.js$/u);
    } else {
      expect(platformDefault.commands[1]).toEqual({ executable: "pnpm", argv: ["validate"], cwd: "." });
    }
  });

  it("runs the server boundary against staged patched bytes and returns a matching receipt", async () => {
    const root = await mkdtemp(join(tmpdir(), "yopp-patch-api-"));
    roots.push(root);
    await writeFile(join(root, "value.txt"), "before", "utf8");
    const replacePlan = createPatchTransactionPlan({
      operations: [{ kind: "replace", path: "value.txt", baseContentHash: hashPatchContent("before"), content: "after" }]
    });
    const request = parseWorkspacePatchRequest({
      schemaVersion: WORKSPACE_PATCH_REQUEST_SCHEMA,
      workspaceId: "workspace-1",
      plan: replacePlan,
      validationPolicyId: DEFAULT_WORKSPACE_PATCH_VALIDATION_POLICY_ID
    });
    const response = await executeWorkspacePatchApiRequest({
      request,
      workspace: { id: "workspace-1", rootPath: root },
      allowedRoots: [root],
      policy: {
        schemaVersion: "yopp.patch-validation-policy.v1",
        id: DEFAULT_WORKSPACE_PATCH_VALIDATION_POLICY_ID,
        commands: [{ executable: process.execPath, argv: ["-e", "const fs=require('node:fs');if(fs.readFileSync('value.txt','utf8')!=='after')process.exit(9)"] }],
        timeoutMs: 5_000,
        maxOutputBytes: 16 * 1024,
        maxWorkspaceFiles: 100,
        maxWorkspaceBytes: 1024 * 1024
      }
    });

    expect(await readFile(join(root, "value.txt"), "utf8")).toBe("after");
    expect(response).toMatchObject({
      schemaVersion: "yopp.workspace-patch-response.v1",
      workspaceId: "workspace-1",
      validationPolicyId: DEFAULT_WORKSPACE_PATCH_VALIDATION_POLICY_ID,
      receipt: { planHash: replacePlan.planHash, validation: { validatorId: DEFAULT_WORKSPACE_PATCH_VALIDATION_POLICY_ID } }
    });
  });

  it("selects Docker only from validated server configuration and keeps the request policy shell-free", () => {
    const trusted = { runtime: { tools: {}, patchValidation: { provider: "trusted-host" } } } as Parameters<typeof serverPatchValidationRuntime>[0];
    expect(serverPatchValidationRuntime(trusted)).toBeUndefined();

    const docker = serverPatchValidationRuntime({
      runtime: {
        tools: {},
        patchValidation: {
          provider: "docker",
          docker: {
            image: `registry.example/scce-validator@sha256:${"a".repeat(64)}`,
            rootPackagePath: "package.json",
            lockfilePath: "pnpm-lock.yaml",
            dependencyInputPaths: ["package.json", "pnpm-lock.yaml"]
          }
        }
      }
    } as Parameters<typeof serverPatchValidationRuntime>[0]);
    expect(docker?.provider).toMatchObject({ id: "docker-cli-sandbox.v1", boundary: "os-sandbox" });
    expect(docker?.resolvePolicy(DOCKER_WORKSPACE_PATCH_VALIDATION_POLICY_ID)).toMatchObject({
      commands: [{ executable: "corepack", argv: ["pnpm", "validate"], cwd: "." }]
    });
    const dockerPolicy = docker?.resolvePolicy(DOCKER_WORKSPACE_PATCH_VALIDATION_POLICY_ID);
    if (!docker || !dockerPolicy) throw new Error("Docker validation runtime fixture was not created");
    const approvalBinding = workspacePatchValidationApprovalBinding(dockerPolicy, docker.provider);
    expect(approvalBinding).toMatch(/^sha256:[0-9a-f]{64}$/u);
    const changedImage = serverPatchValidationRuntime({
      runtime: {
        tools: {},
        patchValidation: {
          provider: "docker",
          docker: {
            image: `registry.example/scce-validator@sha256:${"b".repeat(64)}`,
            rootPackagePath: "package.json",
            lockfilePath: "pnpm-lock.yaml",
            dependencyInputPaths: ["package.json", "pnpm-lock.yaml"]
          }
        }
      }
    } as Parameters<typeof serverPatchValidationRuntime>[0]);
    if (!changedImage) throw new Error("Changed Docker validation runtime fixture was not created");
    expect(workspacePatchValidationApprovalBinding(dockerPolicy, changedImage.provider)).not.toBe(approvalBinding);
    expect(() => docker?.resolvePolicy("request-selected-provider.v1")).toThrow(/unknown Docker workspace patch validation policy/u);
  });

  it("accepts a server-owned isolated provider without exposing provider selection in the request", async () => {
    const root = await mkdtemp(join(tmpdir(), "scce-patch-provider-api-"));
    roots.push(root);
    await mkdir(join(root, "src"));
    const request = parseWorkspacePatchRequest({
      schemaVersion: WORKSPACE_PATCH_REQUEST_SCHEMA,
      workspaceId: "workspace-1",
      plan,
      validationPolicyId: DEFAULT_WORKSPACE_PATCH_VALIDATION_POLICY_ID
    });
    let providerCalls = 0;
    await executeWorkspacePatchApiRequest({
      request,
      workspace: { id: "workspace-1", rootPath: root },
      allowedRoots: [root],
      policy: {
        schemaVersion: "yopp.patch-validation-policy.v1",
        id: DEFAULT_WORKSPACE_PATCH_VALIDATION_POLICY_ID,
        commands: [{ executable: "fixture", argv: [] }],
        timeoutMs: 5_000,
        maxOutputBytes: 16 * 1024,
        maxWorkspaceFiles: 100,
        maxWorkspaceBytes: 1024 * 1024
      },
      provider: {
        id: "remote-provider-fixture.v1",
        boundary: "os-sandbox",
        async execute(input) {
          providerCalls += 1;
          expect(await readFile(join(input.stageRoot, "src", "new.ts"), "utf8")).toBe("export const value = 1;\n");
          return {
            ok: true,
            execution: {
              providerId: "remote-provider-fixture.v1",
              boundary: "os-sandbox",
              backend: "test-double",
              verificationLevel: "implementation-only"
            },
            commands: [{
              index: 0,
              executable: "fixture",
              argv: [],
              cwd: ".",
              code: 0,
              signal: null,
              timedOut: false,
              outputLimitExceeded: false,
              durationMs: 1,
              stdout: "",
              stderr: "",
              stdoutHash: `sha256:${"0".repeat(64)}`,
              stderrHash: `sha256:${"0".repeat(64)}`
            }]
          };
        }
      }
    });

    expect(providerCalls).toBe(1);
    expect(await readFile(join(root, "src", "new.ts"), "utf8")).toBe("export const value = 1;\n");
  });
});
