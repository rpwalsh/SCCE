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
    await capture(["set", "realization.provider", "ollama"]);
    expect(JSON.parse(readFileSync(configPath, "utf8")).realization.provider).toBe("ollama");
    expect(await capture(["get", "realization.provider"])).toBe("\"ollama\"\n");
    expect(await capture(["list"])).toContain("realization.provider = \"ollama\"");
  });

  it("rejects unknown subcommands and keys instead of entering the wizard", async () => {
    await expect(runSettingsCommand(configPath, ["bogus"])).rejects.toThrow(/usage/u);
    await expect(runSettingsCommand(configPath, ["get", "nope.key"])).rejects.toThrow(/unknown setting/u);
  });
});

describe("settings fields", () => {
  it("validates the local model-server host as loopback and the API endpoint as https", () => {
    const ollama = SETTINGS_FIELDS.find(field => field.key === "realization.ollama.host")!;
    expect(ollama.validate?.("http://localhost:11434")).toBeUndefined();
    expect(ollama.validate?.("http://127.0.0.1:11434")).toBeUndefined();
    expect(ollama.validate?.("http://example.com:11434")).toMatch(/loopback/u);
    expect(ollama.validate?.("not a url")).toMatch(/URL/u);
    const api = SETTINGS_FIELDS.find(field => field.key === "realization.apiProvider.endpoint")!;
    expect(api.validate?.("https://example.invalid/v1")).toBeUndefined();
    expect(api.validate?.("http://example.invalid/v1")).toMatch(/https/u);
  });

  it("never offers an API key field: keys come from an env var name only", () => {
    expect(SETTINGS_FIELDS.some(field => /apiKey$/u.test(field.key))).toBe(false);
    expect(SETTINGS_FIELDS.some(field => field.key === "realization.apiProvider.apiKeyEnv")).toBe(true);
  });

  it("resolves the model directory from either gated feature, else ./models", () => {
    expect(modelDirectoryFor({ realization: { constrainedDecoding: { enabled: true, modelId: "m", modelDir: "/a" } } } as never)).toBe("/a");
    expect(modelDirectoryFor({ ingestion: { visual: { embeddings: { enabled: true, modelId: "m", modelDir: "/b" } } } } as never)).toBe("/b");
    expect(modelDirectoryFor({} as never)).toMatch(/models$/u);
  });
});
