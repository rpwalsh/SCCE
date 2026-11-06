// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
import { createServer } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import { handleRequest, type ApiContext } from "../routes.js";
import { createRuntimeStartupReadiness } from "../startup.js";

const servers: ReturnType<typeof createServer>[] = [];
const pagesOrigin = "https://demo.example.pages.dev";
const token = "local-test-token";

afterEach(async () => {
  await Promise.all(servers.splice(0).map(server => new Promise<void>(resolve => server.close(() => resolve()))));
});

describe("static Pages loopback connector", () => {
  it("answers allowed private-network preflights without enabling credentialed requests", async () => {
    const url = await startFixture();
    const response = await fetch(`${url}/api/ready`, {
      method: "OPTIONS",
      headers: {
        origin: pagesOrigin,
        "access-control-request-method": "POST",
        "access-control-request-headers": "authorization,content-type",
        "access-control-request-private-network": "true"
      }
    });

    expect(response.status).toBe(204);
    expect(response.headers.get("access-control-allow-origin")).toBe(pagesOrigin);
    expect(response.headers.get("access-control-allow-private-network")).toBe("true");
    expect(response.headers.get("access-control-allow-credentials")).toBeNull();
    expect(response.headers.get("access-control-allow-headers")).toContain("authorization");
  });

  it("requires bearer authentication for every Pages-origin API request, including readiness", async () => {
    const url = await startFixture();
    const denied = await fetch(`${url}/api/ready`, { headers: { origin: pagesOrigin } });
    expect(denied.status).toBe(401);
    expect(denied.headers.get("access-control-allow-origin")).toBe(pagesOrigin);

    const allowed = await fetch(`${url}/api/manifest`, {
      headers: { origin: pagesOrigin, authorization: `Bearer ${token}` }
    });
    expect(allowed.status).toBe(200);
    expect(allowed.headers.get("access-control-allow-origin")).toBe(pagesOrigin);
    expect(allowed.headers.get("access-control-allow-credentials")).toBeNull();
  });

  it("rejects unconfigured origins and keeps CORS disabled by default", async () => {
    const url = await startFixture([]);
    const response = await fetch(`${url}/api/manifest`, {
      headers: { origin: pagesOrigin, authorization: `Bearer ${token}` }
    });
    expect(response.status).toBe(403);
    expect(response.headers.get("access-control-allow-origin")).toBeNull();
  });

  it("keeps the server-hosted same-origin workbench path unchanged", async () => {
    const url = await startFixture([]);
    const response = await fetch(`${url}/api/manifest`, { headers: { origin: url } });
    expect(response.status).toBe(200);
    expect(response.headers.get("access-control-allow-origin")).toBeNull();
  });
});

async function startFixture(pagesOrigins: readonly string[] = [pagesOrigin]): Promise<string> {
  const context = {
    runtime: { storage: {} },
    config: { server: { url: "http://127.0.0.1:0" }, security: { apiBearerToken: token } },
    pagesOrigins,
    startupReadiness: createRuntimeStartupReadiness()
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
  if (!address || typeof address === "string") throw new Error("server has no TCP address");
  return `http://127.0.0.1:${address.port}`;
}
