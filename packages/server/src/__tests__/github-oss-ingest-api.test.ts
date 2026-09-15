// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
import { createServer } from "node:http";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { GithubOssAcquisitionReport } from "@scce/adapters-node";
import { handleRequest, ROUTES, type ApiContext } from "../routes.js";

const servers: ReturnType<typeof createServer>[] = [];
const commitSha = "a".repeat(40);

beforeEach(() => vi.stubEnv("SCCE_ALLOW_AUTOMATIC_WEB", "1"));

afterEach(async () => {
  vi.unstubAllEnvs();
  await Promise.all(servers.splice(0).map(server => new Promise<void>(resolve => server.close(() => resolve()))));
});

function report(): GithubOssAcquisitionReport {
  return {
    schema: "scce.githubOssAcquisition.v1",
    remoteUrl: "https://github.com/example/project.git",
    commitSha,
    bounds: { maxFiles: 2000, maxFileBytes: 1_000_000, maxTotalBytes: 50_000_000, maxDepth: 12 },
    files: [{ path: "README.md", byteLength: 7, contentHash: "b".repeat(64) }],
    totalBytes: 7,
    provenance: { remoteUrl: "https://github.com/example/project.git", commitSha, snapshotHash: "c".repeat(64), fileHashes: {} },
    training: {
      schema: "scce.ossCorpusTrainReport.v1",
      rootPath: "C:/temporary/snapshot",
      docsTrained: 1,
      codeTrained: 0,
      filesSkipped: Array.from({ length: 129 }, (_, index) => ({ path: `skip-${index}.txt`, reason: "unsupported" })),
      totals: { oss_docs: {}, oss_code: {} },
      reports: [],
      stoppedByHeapSafetyBound: false,
      heapMiBAtExit: 42
    }
  } as unknown as GithubOssAcquisitionReport;
}

async function startFixture(acquire: NonNullable<ApiContext["githubOssAcquisition"]>): Promise<string> {
  const context = {
    runtime: { storage: {} },
    config: { server: { url: "http://127.0.0.1:0" }, security: {} },
    maxBodyBytes: 1_000_000,
    githubOssAcquisition: acquire,
    startupReadiness: { snapshot: () => ({ phase: "ready" as const, complete: true }) }
  } as unknown as ApiContext;
  const server = createServer((request, response) => { void handleRequest(request, response, context); });
  servers.push(server);
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("fixture server has no address");
  return `http://127.0.0.1:${address.port}`;
}

describe("public GitHub OSS ingest API", () => {
  it("returns an offline refusal before calling the acquisition seam when the env opt-in is absent", async () => {
    vi.unstubAllEnvs();
    let calls = 0;
    const url = await startFixture(async () => { calls += 1; return report(); });
    const response = await fetch(`${url}/api/ingest/github`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ remoteUrl: "https://github.com/example/project", commitSha })
    });
    expect(response.status).toBe(403);
    expect(await response.text()).toMatch(/public network acquisition refused/iu);
    expect(calls).toBe(0);
  });

  it("registers one strict operation and returns a bounded receipt through the canonical adapter seam", async () => {
    expect(ROUTES).toContainEqual({ method: "POST", path: "/api/ingest/github", label: "public GitHub OSS ingest", mutates: true, requiresDb: true });
    let calls = 0;
    const url = await startFixture(async input => {
      calls += 1;
      expect(input.remoteUrl).toBe("https://github.com/example/project.git");
      expect(input.commitSha).toBe(commitSha);
      return report();
    });
    const response = await fetch(`${url}/api/ingest/github`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ remoteUrl: "https://github.com/example/project", commitSha })
    });
    const body = await response.json() as Record<string, any>;
    expect(response.status).toBe(200);
    expect(calls).toBe(1);
    expect(body.schema).toBe("scce.githubOssIngestReceipt.v1");
    expect(body.snapshot).toEqual({ fileCount: 1, totalBytes: 7, snapshotHash: "c".repeat(64) });
    expect(body.training.skippedCount).toBe(129);
    expect(body.training.skipped).toHaveLength(128);
    expect(body.training.skippedTruncated).toBe(true);
    expect(body.training.reports).toBeUndefined();
  });

  it("rejects branch URLs, non-exact commits, and extra execution controls before acquisition", async () => {
    let calls = 0;
    const url = await startFixture(async () => { calls += 1; return report(); });
    for (const body of [
      { remoteUrl: "https://github.com/example/project/tree/main", commitSha },
      { remoteUrl: "https://github.com/example/project", commitSha: `${commitSha} ` },
      { remoteUrl: "https://github.com/example/project", commitSha, gitExecutable: "powershell" }
    ]) {
      const response = await fetch(`${url}/api/ingest/github`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body)
      });
      expect(response.status).toBe(400);
    }
    expect(calls).toBe(0);
  });

  it("streams accepted and bounded result frames when requested", async () => {
    let calls = 0;
    const url = await startFixture(async () => { calls += 1; return report(); });
    const response = await fetch(`${url}/api/ingest/github?stream=1`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ remoteUrl: "https://github.com/example/project", commitSha })
    });
    const frames = (await response.text()).trim().split("\n").map(line => JSON.parse(line) as Record<string, any>);
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("application/x-ndjson");
    expect(frames.map(frame => frame.type)).toEqual(["accepted", "result"]);
    expect(frames[1]?.receipt.training.skipped).toHaveLength(128);
    expect(calls).toBe(1);
  });
});
