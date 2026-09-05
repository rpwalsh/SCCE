// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
import { describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { SETTINGS_FIELDS, modelDirectoryFor, runSettingsCommand } from "../settings-commands.js";

describe("settings subcommands", () => {
  const configPath = path.join(mkdtempSync(path.join(tmpdir(), "scce-settings-")), "scce.config.json");
  writeFileSync(configPath, "{}\n");
  const capture = async (args: string[]) => {
    const lines: string[] = [];
    const original = process.stdout.write;
    process.stdout.write = ((chunk: string) => { lines.push(String(chunk)); return true; }) as typeof process.stdout.write;
    try { await runSettingsCommand(configPath, args); } finally { process.stdout.write = original; }
    return lines.join("");
  };

  it("sets, gets, and lists through the shared schema", async () => {
    await capture(["set", "ingestion.observation.screen", "true"]);
    expect(JSON.parse(readFileSync(configPath, "utf8")).ingestion.observation.screen).toBe(true);
    expect(await capture(["get", "ingestion.observation.screen"])).toBe("true\n");
    expect(await capture(["list"])).toContain("ingestion.observation.screen = true");
  });

  it("rejects unknown subcommands and keys instead of entering the wizard", async () => {
    await expect(runSettingsCommand(configPath, ["bogus"])).rejects.toThrow(/usage/u);
    await expect(runSettingsCommand(configPath, ["get", "nope.key"])).rejects.toThrow(/unknown setting/u);
  });
});

describe("settings fields", () => {
  it("offers no model provider, endpoint, or key field", () => {
    expect(SETTINGS_FIELDS.some(field => /realization|apiKey|ollama/u.test(field.key))).toBe(false);
  });

  it("resolves the model directory from the visual embedder, else ./models", () => {
    expect(modelDirectoryFor({ ingestion: { visual: { embeddings: { enabled: true, modelId: "m", modelDir: "/b" } } } } as never)).toBe("/b");
    expect(modelDirectoryFor({} as never)).toMatch(/models$/u);
  });
});
