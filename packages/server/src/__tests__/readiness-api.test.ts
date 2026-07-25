import { createServer } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import { handleRequest, type ApiContext } from "../routes.js";
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

  it("returns ready only after warmup and exact Postgres status both succeed", async () => {
    const readiness = createRuntimeStartupReadiness();
    readiness.begin();
    readiness.complete();
    const url = await startFixture(readiness);

    expect(await getReady(url)).toMatchObject({
      status: 200,
      body: {
        ok: true,
        exactCounts: true,
        warmup: { phase: "ready", complete: true },
        postgres: { countSemantics: "postgres_exact_table_counts" }
      }
    });
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
      body: { ok: true, exactCounts: true, warmup: { phase: "disabled", complete: false } }
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
    const url = await startFixture(readiness, { ok: false, countSemantics: "postgres_exact_table_counts", tableCounts: {} });

    expect(await getReady(url)).toMatchObject({ status: 503, body: { ok: false, warmup: { phase: "disabled" } } });
  });
});

async function startFixture(
  startupReadiness: RuntimeStartupReadinessController,
  status: Record<string, unknown> = {
    ok: true,
    countSemantics: "postgres_exact_table_counts",
    tableCounts: { evidence_spans: 1 }
  }
): Promise<string> {
  const context = {
    runtime: { storage: { status: async () => status } },
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

async function getReady(url: string): Promise<{ status: number; body: Record<string, unknown> }> {
  const response = await fetch(`${url}/api/ready`);
  return { status: response.status, body: await response.json() as Record<string, unknown> };
}
