// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
import { createServer } from "node:http";
import { describe, expect, it } from "vitest";
import { ApprovalSession } from "../../../adapters-node/src/approval-session.js";
import { createCapabilityRegistry, createConnectorCapabilityOperations, createRuntimeCapabilities, DEFAULT_POLICY,
  type ConnectorPort, type JsonValue } from "@scce/kernel";
import { capabilityRuntimeFixture } from "../../../kernel/src/__tests__/fixtures/capability-runtime.js";
import { handleRequest, type ApiContext } from "../routes.js";

describe("connector HTTP operations use the shared cognitive runtime", () => {
  it("approves, executes, restarts, and replays drafts, sends, and calls through one executor catalog", async () => {
    const durable = capabilityRuntimeFixture();
    const calls: string[] = [];
    const approvals = new ApprovalSession();
    const connectors = {
      async outlookCreateDraft(input: { approved?: boolean }) { expect(input.approved).toBe(true); calls.push("draft"); return { id: "draft.1", changeKey: "version.1" }; },
      async outlookSendDraft(id: string, approved: boolean) { expect(approved).toBe(true); calls.push("send"); return { id, sent: true, receipt: "sent.1" }; },
      async telephoneCall(to: string, twiml: string, approved: boolean) { expect(approved).toBe(true); calls.push("call"); return { sid: "call.1", to, twiml, status: "queued" }; }
    } as unknown as ConnectorPort;
    const restart = () => createRuntimeCapabilities({ executive: durable.executive(), blobs: durable.blobs,
      operations: createConnectorCapabilityOperations({ connectors, blobs: durable.blobs,
        capabilities: createCapabilityRegistry({ outlook: true, telephone: true }).all() }) });
    const context = { runtime: { approvals, connectors, capabilities: restart() },
      config: { server: { url: "http://127.0.0.1:0" }, policy: DEFAULT_POLICY, security: { informationAccess: { principalId: "owner.api" } } },
      startupReadiness: { snapshot: () => ({ phase: "ready", complete: true }) } } as unknown as ApiContext;
    const server = createServer((req, res) => { void handleRequest(req, res, context); });
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("no local test listener");
    const base = `http://127.0.0.1:${address.port}`;
    const post = (route: string, body: JsonValue, operationId = "operation.1") => fetch(`${base}${route}`, {
      method: "POST", headers: { "content-type": "application/json", "idempotency-key": operationId }, body: JSON.stringify(body)
    });
    const cases: Array<{ path: string; capability: string; input: JsonValue; result: JsonValue }> = [
      { path: "/api/connectors/outlook/draft", capability: "outlook.create_draft", input: { to: ["person@example.invalid"], subject: "Observation", body: "旗の資料" }, result: { id: "draft.1", changeKey: "version.1" } },
      { path: "/api/connectors/outlook/send", capability: "outlook.send_mail", input: { messageId: "draft.1" }, result: { id: "draft.1", sent: true, receipt: "sent.1" } },
      { path: "/api/connectors/telephone/call", capability: "telephone.call", input: { to: "+15551234567", twiml: "<Response/>" }, result: { sid: "call.1", to: "+15551234567", twiml: "<Response/>", status: "queued" } }
    ];
    try {
      for (const row of cases) {
        const pending = await post(row.path, row.input);
        expect(pending.status).toBe(202);
        const approval = (await pending.json()).pendingApproval;
        expect(approval.capabilityId).toBe(row.capability);
        expect(calls).toHaveLength(cases.indexOf(row));
        await post("/api/session/approve", { planId: approval.planId });
        const first = await post(row.path, row.input);
        const firstBody = await first.json();
        expect(first.status, JSON.stringify(firstBody)).toBe(200);
        expect(firstBody).toEqual(row.result);
        context.runtime.capabilities = restart();
        const replay = await post(row.path, row.input);
        expect(replay.status).toBe(200);
        expect(await replay.json()).toEqual(row.result);
      }
      expect(calls).toEqual(["draft", "send", "call"]);
      const changed = await post("/api/connectors/telephone/call", cases[2]!.input, "operation.deliberate.second.call");
      expect(changed.status).toBe(200);
      expect(calls).toEqual(["draft", "send", "call", "call"]);
      context.runtime.capabilities = undefined as unknown as ApiContext["runtime"]["capabilities"];
      expect((await post("/api/connectors/telephone/call", cases[2]!.input)).status).toBe(500);
      expect(calls).toHaveLength(4);
    } finally { await new Promise(resolve => server.close(resolve)); }
  });
});
