// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, test, vi } from "vitest";
import { localConfigOverlayPath, readScceRuntimeConfig, validateConfig, type ScceRuntimeConfig } from "../config.js";
import type { StructuredPatchValidationPolicy } from "../structured-patch-validation.js";

describe("patch validation runtime configuration", () => {
  afterEach(() => vi.unstubAllEnvs());
  test("defaults to trusted-host validation", () => {
    expect(() => validateConfig(config(), "fixture")).not.toThrow();
  });

  test("registers bounded host-owned policies and refuses duplicate, reserved, malformed and unknown fields", () => {
    const policy: StructuredPatchValidationPolicy = { schemaVersion: "scce.patch-validation-policy.v1", id: "project-check.v1", timeoutMs: 5_000,
      maxOutputBytes: 4096, maxWorkspaceFiles: 64, maxWorkspaceBytes: 1_000_000,
      commands: [{ executable: process.execPath, argv: ["--check", "application.cjs"], checkIds: ["compiler"] }] };
    expect(() => validateConfig(config({ policies: [policy] }), "fixture")).not.toThrow();
    expect(() => validateConfig(config({ policies: [policy, policy] }), "fixture")).toThrow(/duplicate policy id/u);
    for (const id of ["trusted-host-pnpm-validate.v1", "docker-pnpm-validate.v1"]) {
      expect(() => validateConfig(config({ policies: [{ ...policy, id }] }), "fixture")).toThrow(/reserved policy id/u);
    }
    for (const invalid of [
      { ...policy, schemaVersion: "unknown" },
      { ...policy, timeoutMs: 0 },
      { ...policy, maxWorkspaceBytes: 0 },
      { ...policy, commands: [{ executable: process.execPath, argv: [], cwd: "../escape" }] },
      { ...policy, commands: [{ executable: process.execPath, argv: [], shell: true }] },
      { ...policy, commands: [{ executable: process.execPath, argv: [], checkIds: ["unknown"] }] },
      { ...policy, commands: [{ executable: process.execPath, argv: [], checkIds: ["tests"] }, { executable: process.execPath, argv: [], checkIds: ["tests"] }] },
      { ...policy, environment: { SECRET: 7 } },
      { ...policy, ignoredTopLevelNames: ["../escape"] },
      { ...policy, provider: "client-selected" }
    ]) expect(() => validateConfig(config({ policies: [invalid] } as never), "fixture")).toThrow(/runtime.patchValidation.policies/u);
    expect(() => validateConfig(config({ policies: {} } as never), "fixture")).toThrow(/policies must be an array/u);
    expect(() => validateConfig(config({ policies: [policy], executable: "client-command" } as never), "fixture")).toThrow(/unexpected fields/u);
  });

  test("loads native project commands from the normal local overlay without modifying the tracked base", async () => {
    vi.stubEnv("SCCE_DATABASE_URL", undefined);
    const root = await mkdtemp(path.join(tmpdir(), "scce-policy-config-"));
    const configPath = path.join(root, "scce.config.json");
    const baseline = JSON.stringify(config());
    const policy: StructuredPatchValidationPolicy = { schemaVersion: "scce.patch-validation-policy.v1", id: "local-native-project.v1", timeoutMs: 5_000,
      maxOutputBytes: 4096, maxWorkspaceFiles: 64, maxWorkspaceBytes: 1_000_000,
      commands: [{ executable: "local-compiler", argv: ["build", "."], checkIds: ["compiler"] }, { executable: "local-tests", argv: [], checkIds: ["tests"] }] };
    try {
      await writeFile(configPath, baseline);
      await writeFile(localConfigOverlayPath(configPath), JSON.stringify({ runtime: { patchValidation: { provider: "trusted-host", policies: [policy] } } }));
      expect((await readScceRuntimeConfig(configPath)).runtime.patchValidation).toEqual({ provider: "trusted-host", policies: [policy] });
      expect(await readFile(configPath, "utf8")).toBe(baseline);
    } finally {
      expect(path.dirname(root)).toBe(path.resolve(tmpdir()));
      expect(path.basename(root)).toMatch(/^scce-policy-config-/u);
      await rm(root, { recursive: true, force: true });
    }
  });

  test("requires a digest-pinned image and exact dependency inputs for Docker opt-in", () => {
    expect(() => validateConfig(config({
      provider: "docker",
      docker: {
        image: "node:20",
        rootPackagePath: "package.json",
        lockfilePath: "pnpm-lock.yaml",
        dependencyInputPaths: ["package.json", "pnpm-lock.yaml"]
      }
    }), "fixture")).toThrow(/image must use a lowercase sha256 digest/u);

    expect(() => validateConfig(config({
      provider: "docker",
      docker: {
        image: `registry.example/scce-validator@sha256:${"a".repeat(64)}`,
        rootPackagePath: "package.json",
        lockfilePath: "pnpm-lock.yaml",
        dependencyInputPaths: ["package.json", "pnpm-lock.yaml"],
        maxHostSnapshotBytes: 64 * 1024 * 1024
      }
    }), "fixture")).not.toThrow();

    expect(() => validateConfig(config({
      provider: "docker",
      docker: {
        image: `registry.example/scce-validator@sha256:${"a".repeat(64)}`,
        rootPackagePath: "package.json",
        lockfilePath: "pnpm-lock.yaml",
        dependencyInputPaths: ["package.json", "pnpm-lock.yaml"],
        maxHostSnapshotBytes: 1024 * 1024 * 1024 + 1
      }
    }), "fixture")).toThrow(/maxHostSnapshotBytes must be an integer/u);

    expect(() => validateConfig(config({
      provider: "docker",
      docker: {
        image: `registry.example/scce-validator@sha256:${"a".repeat(64)}`,
        rootPackagePath: "package.json",
        lockfilePath: "pnpm-lock.yaml",
        dependencyInputPaths: ["package.json", "pnpm-lock.yaml", "src/config.json"]
      }
    }), "fixture")).toThrow(/may contain only manifests/u);
  });
});

function config(patchValidation?: ScceRuntimeConfig["runtime"]["patchValidation"]): ScceRuntimeConfig {
  return {
    server: { url: "http://127.0.0.1:3873", host: "127.0.0.1" },
    database: { url: "postgresql://fixture:fixture@localhost:5432/fixture", schema: "fixture" },
    runtime: {
      workspaceRoot: ".",
      tempRoot: ".tmp",
      maxFileBytes: 1024,
      maxChunkBytes: 512,
      allowedRoots: ["."],
      excludedPaths: [],
      tools: {},
      ...(patchValidation ? { patchValidation } : {})
    },
    connectors: {},
    security: {
      informationAccess: { tenantId: "fixture", principalId: "owner", compartments: ["test"], maximumExportClass: "restricted" },
      defaultSourceInformationLabel: { tenantId: "fixture", principals: ["owner"], compartments: ["test"], exportClass: "restricted", mergePolicy: "isolated" }
    },
    policy: {
      allowMutation: false,
      requireTwoPhaseCommit: true,
      dryRunByDefault: true,
      maxNetworkRequests: 0,
      maxToolCalls: 0,
      maxSpendCents: 0,
      alphaRiskCeiling: 0.5,
      encryptSecretsAtRest: false
    }
  };
}
