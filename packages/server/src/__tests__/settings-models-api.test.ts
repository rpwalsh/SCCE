// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
import { createServer } from "node:http";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { handleRequest, type ApiContext } from "../routes.js";

const servers: ReturnType<typeof createServer>[] = [];
const dirs: string[] = [];
afterEach(async () => {
  for (const server of servers.splice(0)) await new Promise(resolve => server.close(resolve));
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
});

async function startFixture(): Promise<{ url: string; configPath: string; modelDir: string }> {
  const dir = await mkdtemp(path.join(tmpdir(), "scce-settings-api-"));
  dirs.push(dir);
  const configPath = path.join(dir, "scce.config.json");
  const modelDir = path.join(dir, "models");
  await writeFile(configPath, JSON.stringify({ server: { url: "http://127.0.0.1:0" }, ingestion: { visual: { embeddings: { enabled: false, modelId: "", modelDir } } } }, null, 2));
  const context = {
    runtime: {},
    config: { server: { url: "http://127.0.0.1:0" }, ingestion: { visual: { embeddings: { enabled: false, modelId: "", modelDir } } } },
    configPath,
    maxBodyBytes: 1_000_000,
    startupReadiness: { snapshot: () => ({ phase: "ready" as const, complete: true }) }
  } as unknown as ApiContext;
  const server = createServer((req, res) => { void handleRequest(req, res, context); });
  servers.push(server);
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("no address");
  return { url: `http://127.0.0.1:${address.port}`, configPath, modelDir };
}

async function call(url: string, method: "GET" | "POST", body?: unknown): Promise<{ status: number; body: Record<string, unknown> }> {
  const response = await fetch(url, { method, headers: { "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await response.text();
  return { status: response.status, body: text ? JSON.parse(text) as Record<string, unknown> : {} };
}

describe("settings and models API", () => {
  it("serves the shared settings schema with current values", async () => {
    const { url } = await startFixture();
    const response = await call(`${url}/api/settings`, "GET");
    expect(response.status).toBe(200);
    const fields = response.body.fields as Array<{ key: string; value: unknown; label: string }>;
    expect(fields.find(field => field.key === "ingestion.visual.embeddings.enabled")?.value).toBe(false);
    expect(fields.some(field => /realization|apiKey|ollama/u.test(field.key))).toBe(false);
  });

  it("writes a validated setting back to the config file and flags a restart", async () => {
    const { url, configPath } = await startFixture();
    const ok = await call(`${url}/api/settings`, "POST", { key: "ingestion.observation.screen", value: "true" });
    expect(ok.status).toBe(200);
    expect(ok.body.restartRequired).toBe(true);
    const written = JSON.parse(await readFile(configPath, "utf8")) as { ingestion: { observation: { screen: boolean } } };
    expect(written.ingestion.observation.screen).toBe(true);
    const unknown = await call(`${url}/api/settings`, "POST", { key: "security.apiBearerToken", value: "x" });
    expect(unknown.status).toBeGreaterThanOrEqual(400);
  });

  it("lists local models from the configured directory (empty when none) and refuses malformed download ids", async () => {
    const { url, modelDir } = await startFixture();
    const list = await call(`${url}/api/models`, "GET");
    expect(list.status).toBe(200);
    expect(list.body.modelDir).toBe(path.resolve(modelDir));
    expect(list.body.models).toEqual([]);
    const bad = await call(`${url}/api/models/download`, "POST", { modelId: "../etc" });
    expect(bad.status).toBe(400);
  });
});
