import { createServer } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import { handleRequest, type ApiContext } from "../routes.js";

// Plan item 208: proves the approval gate in front of each mutating
// Outlook route (draft create, send, calendar create) actually blocks the
// real connector call when not approved, and only lets it through once
// approved -- not that the executive dispatcher itself enforces this (it
// doesn't; approval happens in the HTTP handler before dispatch is ever
// reached).

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
  const context = {
    runtime: {
      approvals: fakeApprovals(input.approvedCapabilityIds ?? new Set()),
      connectors: input.connectors,
      executive: undefined
    },
    config: { server: { url: "http://127.0.0.1:0" }, security: {} },
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

describe("outlook mutating routes fail closed on authorization denial", () => {
  it("draft create: denies without ever invoking the connector, then genuinely proceeds once approved", async () => {
    let calls = 0;
    const connectors = { outlookCreateDraft: async () => { calls++; return { id: "message.1" }; } };
    const body = { to: ["a@example.com"], subject: "hello", body: "text" };

    const deniedUrl = await startFixture({ connectors });
    const denied = await post(deniedUrl, "/api/connectors/outlook/draft", body);
    expect(denied.status).toBe(202);
    expect(denied.body.ok).toBe(false);
    expect(calls).toBe(0);

    const approvedUrl = await startFixture({ connectors, approvedCapabilityIds: new Set(["outlook.create_draft"]) });
    const allowed = await post(approvedUrl, "/api/connectors/outlook/draft", body);
    expect(allowed.status).toBe(200);
    expect(calls).toBe(1);
  });

  it("send: denies without ever invoking the connector, then genuinely proceeds once approved", async () => {
    let calls = 0;
    const connectors = { outlookSendDraft: async () => { calls++; return { id: "message.1", sent: true }; } };
    const body = { messageId: "message.1" };

    const deniedUrl = await startFixture({ connectors });
    const denied = await post(deniedUrl, "/api/connectors/outlook/send", body);
    expect(denied.status).toBe(202);
    expect(calls).toBe(0);

    const approvedUrl = await startFixture({ connectors, approvedCapabilityIds: new Set(["outlook.send_mail"]) });
    const allowed = await post(approvedUrl, "/api/connectors/outlook/send", body);
    expect(allowed.status).toBe(200);
    expect(calls).toBe(1);
  });

  it("calendar create: denies without ever invoking the connector, then genuinely proceeds once approved", async () => {
    let calls = 0;
    const connectors = { outlookCreateCalendarEvent: async () => { calls++; return { id: "event.1" }; } };
    const body = { subject: "standup", start: "2026-08-01T09:00:00Z", end: "2026-08-01T09:15:00Z" };

    const deniedUrl = await startFixture({ connectors });
    const denied = await post(deniedUrl, "/api/connectors/outlook/calendar/create", body);
    expect(denied.status).toBe(202);
    expect(calls).toBe(0);

    const approvedUrl = await startFixture({ connectors, approvedCapabilityIds: new Set(["outlook.create_calendar_event"]) });
    const allowed = await post(approvedUrl, "/api/connectors/outlook/calendar/create", body);
    expect(allowed.status).toBe(200);
    expect(calls).toBe(1);
  });
});
