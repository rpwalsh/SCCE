import { spawn } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const temporaryPaths: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryPaths.splice(0).map(candidate => rm(candidate, { recursive: true, force: true })));
});

describe("runtime load gate", () => {
  it("measures a bounded concurrent turn workload against a loopback server", async () => {
    const server = createServer((request, response) => {
      response.setHeader("content-type", "application/json");
      if (request.url === "/api/ready") {
        response.end(JSON.stringify({ ok: true, runtime: "fixture" }));
        return;
      }
      if (request.url === "/api/turn?full=1" && request.method === "POST") {
        response.end(JSON.stringify({ answer: "fixture answer", evidence: [] }));
        return;
      }
      response.statusCode = 404;
      response.end(JSON.stringify({ error: "not found" }));
    });
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolve);
    });
    try {
      const address = server.address();
      if (!address || typeof address === "string") throw new Error("fixture server has no TCP address");
      const directory = await mkdtemp(path.join(tmpdir(), "scce-load-gate-"));
      temporaryPaths.push(directory);
      const prompts = path.join(directory, "prompts.json");
      await writeFile(prompts, `${JSON.stringify([{ id: "fixture.prompt", text: "fixture prompt" }])}\n`, "utf8");

      const result = await run([
        "tools/runtime-load-gate.mjs",
        "--prompts", prompts,
        "--workload-id", " fixture.loopback.e\u0301.v1 ",
        "--server-url", `http://127.0.0.1:${address.port}`,
        "--requests", "8",
        "--concurrency", "2",
        "--max-p95-ms", "5000"
      ]);

      expect(result.code).toBe(0);
      expect(result.stderr).toBe("");
      const report = JSON.parse(result.stdout) as Record<string, unknown>;
      expect(report.schema).toBe("scce.runtime_load_report.v1");
      expect(report.ok).toBe(true);
      expect(report.requests).toBe(8);
      expect(report.successes).toBe(8);
      expect(report.failedRequests).toBe(0);
      expect(report.terminationReason).toBe("request_cap_reached");
      expect(report.gateFailures).toEqual([]);
      expect(report.workload).toMatchObject({
        workloadId: "fixture.loopback.\u00e9.v1",
        workloadHash: expect.stringMatching(/^sha256:[0-9a-f]{64}$/u)
      });
      expect(report.claimBoundary).toBe("local_client_observation_not_independent_capacity_attestation");
      expect(report.successfulRequestLatencyEstimateMs).toMatchObject({
        populationCount: 8,
        sampleCount: 8,
        estimator: "all_successful_requests"
      });
    } finally {
      await new Promise<void>(resolve => server.close(() => resolve()));
    }
  });

  it("refuses a 2xx readiness payload that does not explicitly report ok", async () => {
    let turnRequests = 0;
    const server = createServer((request, response) => {
      response.setHeader("content-type", "application/json");
      if (request.url === "/api/ready") {
        response.end("{}");
        return;
      }
      if (request.url === "/api/turn?full=1") turnRequests += 1;
      response.end(JSON.stringify({ answer: "should not run" }));
    });
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolve);
    });
    try {
      const address = server.address();
      if (!address || typeof address === "string") throw new Error("fixture server has no TCP address");
      const directory = await mkdtemp(path.join(tmpdir(), "scce-load-gate-not-ready-"));
      temporaryPaths.push(directory);
      const prompts = path.join(directory, "prompts.json");
      await writeFile(prompts, `${JSON.stringify([{ id: "fixture.prompt", text: "fixture prompt" }])}\n`, "utf8");

      const result = await run([
        "tools/runtime-load-gate.mjs",
        "--prompts", prompts,
        "--workload-id", "fixture.not-ready.v1",
        "--server-url", `http://127.0.0.1:${address.port}`,
        "--requests", "1"
      ]);

      expect(result.code).not.toBe(0);
      expect(result.stderr).toMatch(/server is not ready/u);
      expect(turnRequests).toBe(0);
    } finally {
      await new Promise<void>(resolve => server.close(() => resolve()));
    }
  });

  it("fails a duration run when the request cap is exhausted first", async () => {
    const server = createServer((request, response) => {
      response.setHeader("content-type", "application/json");
      if (request.url === "/api/ready") response.end(JSON.stringify({ ok: true }));
      else response.end(JSON.stringify({ answer: "fast fixture" }));
    });
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolve);
    });
    try {
      const address = server.address();
      if (!address || typeof address === "string") throw new Error("fixture server has no TCP address");
      const directory = await mkdtemp(path.join(tmpdir(), "scce-load-gate-duration-"));
      temporaryPaths.push(directory);
      const prompts = path.join(directory, "prompts.json");
      await writeFile(prompts, JSON.stringify(["fixture prompt"]), "utf8");

      const result = await run([
        "tools/runtime-load-gate.mjs",
        "--prompts", prompts,
        "--workload-id", "fixture.duration-cap.v1",
        "--server-url", `http://127.0.0.1:${address.port}`,
        "--requests", "1",
        "--duration-seconds", "2"
      ]);

      expect(result.code).toBe(1);
      expect(result.stderr).toBe("");
      const report = JSON.parse(result.stdout) as Record<string, unknown>;
      expect(report.terminationReason).toBe("request_cap_reached");
      expect(report.ok).toBe(false);
      expect(report.gateFailures).toEqual([expect.stringMatching(/request cap 1 reached before requested duration 2s elapsed/u)]);
    } finally {
      await new Promise<void>(resolve => server.close(() => resolve()));
    }
  });

  it("rejects a prompt input before reading beyond its byte bound", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "scce-load-gate-prompt-bound-"));
    temporaryPaths.push(directory);
    const prompts = path.join(directory, "prompts.json");
    await writeFile(prompts, Buffer.alloc(8 * 1024 * 1024 + 1, 0x20));

    const result = await run([
      "tools/runtime-load-gate.mjs",
      "--prompts", prompts,
      "--workload-id", "fixture.prompt-bound.v1",
      "--requests", "1"
    ]);

    expect(result.code).not.toBe(0);
    expect(result.stderr).toMatch(/prompt input exceeds 8388608 bytes/u);
  });

  it("bounds response bodies and counts an oversized 2xx response as a failure", async () => {
    const server = createServer((request, response) => {
      response.setHeader("content-type", "application/json");
      if (request.url === "/api/ready") {
        response.end(JSON.stringify({ ok: true }));
        return;
      }
      response.end(Buffer.alloc(8 * 1024 * 1024 + 1, 0x20));
    });
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolve);
    });
    try {
      const address = server.address();
      if (!address || typeof address === "string") throw new Error("fixture server has no TCP address");
      const directory = await mkdtemp(path.join(tmpdir(), "scce-load-gate-response-bound-"));
      temporaryPaths.push(directory);
      const prompts = path.join(directory, "prompts.json");
      await writeFile(prompts, JSON.stringify(["fixture prompt"]), "utf8");

      const result = await run([
        "tools/runtime-load-gate.mjs",
        "--prompts", prompts,
        "--workload-id", "fixture.response-bound.v1",
        "--server-url", `http://127.0.0.1:${address.port}`,
        "--requests", "1",
        "--max-error-rate", "1"
      ]);

      expect(result.code).toBe(1);
      expect(result.stderr).toBe("");
      const report = JSON.parse(result.stdout) as Record<string, unknown>;
      expect(report.requests).toBe(1);
      expect(report.successes).toBe(0);
      expect(report.failedRequests).toBe(1);
      expect(report.errorCounts).toEqual({ response_body_too_large: 1 });
      expect(report.gateFailures).toContain("no successful requests completed");
    } finally {
      await new Promise<void>(resolve => server.close(() => resolve()));
    }
  });
});

function run(args: string[]): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, args, {
      cwd: process.cwd(),
      env: process.env,
      shell: false,
      windowsHide: true
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", chunk => { stdout += chunk.toString(); });
    child.stderr.on("data", chunk => { stderr += chunk.toString(); });
    child.once("error", reject);
    child.once("close", code => resolve({ code, stdout, stderr }));
  });
}
