// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
import { createServer } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import { createCapabilityRegistry, createConnectorCapabilityOperations, createRuntimeCapabilities, DEFAULT_POLICY, type ConnectorPort } from "@scce/kernel";
import { capabilityRuntimeFixture } from "../../../kernel/src/__tests__/fixtures/capability-runtime.js";
import { handleRequest, type ApiContext } from "../routes.js";

// Route consent and durable dispatch must both precede the provider effect.

const servers: ReturnType<typeof createServer>[] = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map(server => new Promise<void>(resolve => server.close(() => resolve()))));
});

function fakeApprovals(approvedCapabilityIds: Set<string>) {
  return {
    isApproved: (input: { capabilityId: string }) => approvedCapabilityIds.has(input.capabilityId),
    requestApproval: (input: { capabilityId: string; input: unknown; reason: string }) => ({ capabilityId: input.capabilityId, reason: input.reason, requestedAt: 0 }),
    snapshot: () => ({ pending: [] })
  };
}

async function startFixture(input: { approvedCapabilityIds?: Set<string>; connectors: Record<string, (...args: never[]) => Promise<unknown>> }): Promise<string> {
  const durable = capabilityRuntimeFixture();
  const executive = durable.executive();
  const capabilities = createRuntimeCapabilities({ executive, blobs: durable.blobs,
    operations: createConnectorCapabilityOperations({ connectors: input.connectors as unknown as ConnectorPort, blobs: durable.blobs,
      capabilities: createCapabilityRegistry({ telephone: true }).all() }) });
  const context = {
    runtime: {
      approvals: fakeApprovals(input.approvedCapabilityIds ?? new Set()),
      connectors: input.connectors,
      executive,
      capabilities
    },
    config: { server: { url: "http://127.0.0.1:0" }, policy: DEFAULT_POLICY, security: { informationAccess: { principalId: "owner.test" } } },
    startupReadiness: { snapshot: () => ({ phase: "ready" as const, complete: true }) }
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

async function post(url: string, path: string, payload: unknown): Promise<{ status: number; body: Record<string, unknown> }> {
  const response = await fetch(`${url}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload)
  });
  return { status: response.status, body: await response.json() as Record<string, unknown> };
}

describe("telephone call route fails closed on authorization denial", () => {
  it("denies without ever invoking the connector, then genuinely proceeds once approved", async () => {
    let calls = 0;
    const connectors = { telephoneCall: async () => { calls++; return { sid: "CA_fake", status: "queued" }; } };
    const body = { to: "+15551234567", twiml: "<Response><Say>Hello</Say></Response>" };

    const deniedUrl = await startFixture({ connectors });
    const denied = await post(deniedUrl, "/api/connectors/telephone/call", body);
    expect(denied.status).toBe(202);
    expect(denied.body.ok).toBe(false);
    expect(calls).toBe(0);

    const approvedUrl = await startFixture({ connectors, approvedCapabilityIds: new Set(["telephone.call"]) });
    const allowed = await post(approvedUrl, "/api/connectors/telephone/call", body);
    expect(allowed.status, JSON.stringify(allowed.body)).toBe(200);
    expect(calls).toBe(1);
  });
});
