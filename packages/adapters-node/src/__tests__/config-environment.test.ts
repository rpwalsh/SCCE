import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, test, vi } from "vitest";
import { readScceRuntimeConfig, type ScceRuntimeConfig } from "../config.js";

describe("runtime configuration environment overrides", () => {
  afterEach(() => vi.unstubAllEnvs());

  test("takes the database connection URL from SCCE_DATABASE_URL without changing the config file", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "scce-config-environment-"));
    const configPath = path.join(root, "scce.config.json");
    const fileUrl = "postgresql://localhost:5432/scce";
    const environmentUrl = "postgresql://fixture:fixture@127.0.0.1:5432/scce";
    await writeFile(configPath, JSON.stringify(config(fileUrl)), "utf8");
    vi.stubEnv("SCCE_DATABASE_URL", environmentUrl);

    try {
      const loaded = await readScceRuntimeConfig(configPath);
      expect(loaded.database.url).toBe(environmentUrl);
      expect(JSON.parse(await readFile(configPath, "utf8")).database.url).toBe(fileUrl);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

function config(databaseUrl: string): ScceRuntimeConfig {
  return {
    server: { url: "http://127.0.0.1:3873", host: "127.0.0.1" },
    database: { url: databaseUrl, schema: "scce" },
    runtime: {
      workspaceRoot: ".",
      tempRoot: ".tmp",
      maxFileBytes: 1024,
      maxChunkBytes: 512,
      allowedRoots: ["."],
      excludedPaths: [],
      tools: {}
    },
    connectors: {},
    security: fixtureInformationSecurity(),
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

function fixtureInformationSecurity(): NonNullable<ScceRuntimeConfig["security"]> {
  return {
    informationAccess: { tenantId: "fixture", principalId: "owner", compartments: ["test"], maximumExportClass: "restricted" },
    defaultSourceInformationLabel: { tenantId: "fixture", principals: ["owner"], compartments: ["test"], exportClass: "restricted", mergePolicy: "isolated" }
  };
}
