import { describe, expect, test } from "vitest";
import { validateConfig, type ScceRuntimeConfig } from "../config.js";

describe("patch validation runtime configuration", () => {
  test("defaults to trusted-host validation", () => {
    expect(() => validateConfig(config(), "fixture")).not.toThrow();
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
