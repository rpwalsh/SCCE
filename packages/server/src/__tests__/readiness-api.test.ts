// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
import { createServer } from "node:http";
import { afterEach, describe, expect, it, vi } from "vitest";
import { handleRequest, primePostgresStatus, type ApiContext } from "../routes.js";
import { createRuntimeStartupReadiness, type RuntimeStartupReadinessController } from "../startup.js";

const servers: ReturnType<typeof createServer>[] = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map(server => new Promise<void>(resolve => server.close(() => resolve()))));
});

describe("server readiness API", () => {
  it("returns 503 until warmup completes and exposes background warmup failure", async () => {
    const readiness = createRuntimeStartupReadiness();
    const url = await startFixture(readiness);

    expect(await getReady(url)).toMatchObject({ status: 503, body: { ok: false, warmup: { phase: "pending", complete: false } } });

    readiness.begin();
    expect(await getReady(url)).toMatchObject({ status: 503, body: { ok: false, warmup: { phase: "running", complete: false } } });

    readiness.fail(new Error("fixture warmup failed"));
    expect(await getReady(url)).toMatchObject({
      status: 503,
      body: { ok: false, warmup: { phase: "failed", complete: false, error: "fixture warmup failed" } }
    });
  });

  it("returns ready after warmup and current schema metadata succeed without requesting counts", async () => {
    const readiness = createRuntimeStartupReadiness();
    readiness.begin();
    readiness.complete();
    const url = await startFixture(readiness);

    expect(await getReady(url)).toMatchObject({
      status: 200,
      body: {
        ok: true,
        exactCounts: false,
        warmup: { phase: "ready", complete: true },
        postgres: { detail: "readiness", countSemantics: "postgres_schema_readiness" }
      }
    });
  });

  it("uses readiness detail for startup priming and rereads settled metadata instead of serving cached status", async () => {
    const readiness = createRuntimeStartupReadiness();
    readiness.begin();
    readiness.complete();
    let statusCalls = 0;
    const runtime = {
      storage: {
        status: async (options: unknown) => {
          statusCalls += 1;
          expect(options).toEqual({ detail: "readiness" });
          return healthyStatus();
        }
      }
    } as unknown as ApiContext["runtime"];

    await primePostgresStatus(runtime);
    const url = await startFixture(readiness, undefined, runtime);
    expect(await getReady(url)).toMatchObject({ status: 200, body: { ok: true, exactCounts: false } });
    expect(statusCalls).toBe(2);
  });

  it("rejects an estimated Postgres count payload even after warmup", async () => {
    const readiness = createRuntimeStartupReadiness();
    readiness.begin();
    readiness.complete();
    const url = await startFixture(readiness, {
      ok: true,
      countSemantics: "postgres_planner_estimate",
      tableCounts: { evidence_spans: 999999 }
    });

    expect(await getReady(url)).toMatchObject({ status: 503, body: { ok: false, exactCounts: false } });
  });

  it("reports ready when warmup was intentionally disabled and Postgres is otherwise healthy", async () => {
    const readiness = createRuntimeStartupReadiness();
    readiness.disable();
    const url = await startFixture(readiness);

    expect(await getReady(url)).toMatchObject({
      status: 200,
      body: { ok: true, exactCounts: false, warmup: { phase: "disabled", complete: false } }
    });
  });

  it("still blocks readiness while warmup is pending or running, even though disabled would not block", async () => {
    const readiness = createRuntimeStartupReadiness();
    const pendingUrl = await startFixture(readiness);
    expect(await getReady(pendingUrl)).toMatchObject({ status: 503, body: { ok: false, warmup: { phase: "pending" } } });

    readiness.begin();
    const runningUrl = await startFixture(readiness);
    expect(await getReady(runningUrl)).toMatchObject({ status: 503, body: { ok: false, warmup: { phase: "running" } } });
  });

  it("still blocks readiness when a disabled-warmup server's Postgres is unhealthy", async () => {
    const readiness = createRuntimeStartupReadiness();
    readiness.disable();
    const url = await startFixture(readiness, { ...healthyStatus(), ok: false });

    expect(await getReady(url)).toMatchObject({ status: 503, body: { ok: false, warmup: { phase: "disabled" } } });
  });

  it("shares concurrent checks per detail while keeping population presets and exact inspection independent", async () => {
    const readiness = createRuntimeStartupReadiness(); readiness.begin(); readiness.complete();
    const calls: Array<{ detail?: string; population?: string }> = [], releases: Array<() => void> = [];
    let hold = true;
    const runtime = { storage: { status: async (options: { detail?: string; population?: string }) => {
      calls.push(options);
      if (hold) await new Promise<void>(resolve => releases.push(resolve));
      return healthyStatus(options.detail, options.population);
    } } } as unknown as ApiContext["runtime"];
    const url = await startFixture(readiness, undefined, runtime);
    const requests = [getReady(url), getReady(url), getReady(url), getReady(url, "?detail=exact"),
      getReady(url, "?detail=population&population=launch"), getReady(url, "?detail=population&population=questions")];
    await vi.waitFor(() => expect(calls).toHaveLength(4));
    hold = false; releases.splice(0).forEach(release => release());
    const responses = await Promise.all(requests);
    expect(responses.every(response => response.status === 200)).toBe(true);
    expect(responses[3]!.body.exactCounts).toBe(true);
    expect(calls).toEqual(expect.arrayContaining([{ detail: "readiness" }, { detail: "exact" },
      { detail: "population", population: "launch" }, { detail: "population", population: "questions" }]));
    expect(await getReady(url)).toMatchObject({ status: 200 });
    expect(calls).toHaveLength(5);
  });

  it("does not cache a previous success or failure and never queries storage during pending warmup", async () => {
    const readiness = createRuntimeStartupReadiness();
    let calls = 0, ok = true;
    const runtime = { storage: { status: async () => { calls++; return { ...healthyStatus(), ok }; } } } as unknown as ApiContext["runtime"];
    const url = await startFixture(readiness, undefined, runtime);
    expect(await getReady(url)).toMatchObject({ status: 503 });
    readiness.begin();
    expect(await getReady(url)).toMatchObject({ status: 503 });
    expect(calls).toBe(0);
    readiness.complete();
    expect(await getReady(url)).toMatchObject({ status: 200 });
    ok = false;
    expect(await getReady(url)).toMatchObject({ status: 503 });
    ok = true;
    expect(await getReady(url)).toMatchObject({ status: 200 });
    expect(calls).toBe(3);
  });

  it("rejects an unknown detail instead of launching an inspection", async () => {
    const readiness = createRuntimeStartupReadiness(); readiness.begin(); readiness.complete();
    const url = await startFixture(readiness);
    expect(await getReady(url, "?detail=all")).toMatchObject({ status: 400 });
    expect(await getReady(url, "?detail=readiness&population=launch")).toMatchObject({ status: 400 });
    expect(await getReady(url, "?detail=population&population=unknown")).toMatchObject({ status: 400 });
    expect(await getReady(url, "?detail=population&population=")).toMatchObject({ status: 400 });
    expect(await getReady(url, "?detail=readiness&detail=exact")).toMatchObject({ status: 400 });
    expect(await getReady(url, "?detail=population&population=launch&population=questions")).toMatchObject({ status: 400 });
  });
});

function healthyStatus(detail = "readiness", population?: string): Record<string, unknown> {
  return { schema: "scce.postgres.status.v1", ok: true, connected: true, detail,
    countSemantics: detail === "exact" ? "postgres_exact_table_counts" : detail === "population" ? "postgres_bounded_population" : "postgres_schema_readiness",
    ...(detail === "exact" ? { tableCounts: { evidence_spans: 1 } } : detail === "population" ? { population, tablePopulation: {} } : {}) };
}

async function startFixture(
  startupReadiness: RuntimeStartupReadinessController,
  status: Record<string, unknown> = healthyStatus(),
  runtime: ApiContext["runtime"] = { storage: { status: async () => status } } as unknown as ApiContext["runtime"]
): Promise<string> {
  const context = {
    runtime,
    config: { server: { url: "http://127.0.0.1:0" } },
    startupReadiness
  } as unknown as ApiContext;
  const server = createServer((request, response) => {
    void handleRequest(request, response, context);
  });
  servers.push(server);
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("fixture server has no TCP address");
  return `http://127.0.0.1:${address.port}`;
}

async function getReady(url: string, query = ""): Promise<{ status: number; body: Record<string, unknown> }> {
  const response = await fetch(`${url}/api/ready${query}`);
  return { status: response.status, body: await response.json() as Record<string, unknown> };
}
