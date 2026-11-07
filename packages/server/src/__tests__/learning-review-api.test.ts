// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
import { createServer } from "node:http";
import { afterEach, describe, expect, it, vi } from "vitest";
import { handleRequest, type ApiContext } from "../routes.js";

const servers: ReturnType<typeof createServer>[] = [];
afterEach(async () => { for (const server of servers.splice(0)) await new Promise(resolve => server.close(resolve)); });

function storageFixture() {
  const quarantined = new Map<string, { id: string; sourceId: string; sourceVersionId: string; uri: string; mediaType: string; fetchedAt: number; decision: string; permissionVector: unknown }>();
  quarantined.set("sv1:admission", { id: "sv1:admission", sourceId: "s1", sourceVersionId: "sv1", uri: "https://example.invalid/pump", mediaType: "text/html", fetchedAt: 1, decision: "pending", permissionVector: { sourceAdmission: { sourceClass: "runtime_web", intendedUse: "direct_evidence", promotionAuthority: "review" } } });
  const spans = [{ id: "e1", sourceVersionId: "sv1", text: "Pump alpha runs at 42 psi.", status: "quarantined", title: "Pump alpha" }];
  return {
    spans,
    kernel: { ingest: vi.fn(async () => {
      for (const span of spans) span.status = "promoted";
      return { evidence: spans.length, events: [{ typeId: "SourcePromoted", payload: { sourceVersionId: "sv1" } }] };
    }) },
    storage: {
      blobs: { get: async () => Buffer.from("Pump alpha runs at 42 psi.") },
      quarantine: {
        get: async (id: string) => quarantined.get(id) ?? null,
        listPending: async () => [...quarantined.values()].filter(item => item.decision === "pending"),
        markDecision: async (id: string, decision: { decision: string }) => { quarantined.set(id, { ...quarantined.get(id)!, decision: decision.decision }); }
      },
      evidence: {
        sourceVersionById: async () => ({ sourceId: "s1", sourceVersionId: "sv1", canonicalUri: "https://example.invalid/pump", namespace: "runtime-acquisition", contentHash: "h", mediaType: "text/plain", metadata: {}, sourceTrust: {}, observedAt: 1, byteLength: 26 }),
        searchEvidence: async (query: { sourceVersionId?: string; status?: string }) => spans.filter(span => span.sourceVersionId === query.sourceVersionId && span.status === query.status).map(span => ({ span, score: 1, reason: "fixture" })),
        promoteEvidence: async (ids: string[]) => { let n = 0; for (const span of spans) if (ids.includes(span.id)) { span.status = "promoted"; n++; } return n; }
      }
    }
  };
}

async function start(storage: unknown, kernel?: unknown): Promise<string> {
  const context = {
    runtime: { storage, kernel },
    config: { server: { url: "http://127.0.0.1:0" } },
    maxBodyBytes: 1_000_000,
    startupReadiness: { snapshot: () => ({ phase: "ready" as const, complete: true }) }
  } as unknown as ApiContext;
  const server = createServer((req, res) => { void handleRequest(req, res, context); });
  servers.push(server);
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("no address");
  return `http://127.0.0.1:${address.port}`;
}

async function call(url: string, method: "GET" | "POST", body?: unknown): Promise<{ status: number; body: Record<string, unknown> }> {
  const response = await fetch(url, { method, headers: { "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await response.text();
  return { status: response.status, body: text ? JSON.parse(text) as Record<string, unknown> : {} };
}

describe("learning review API", () => {
  it("lists held material with a preview and promotes it on the owner's confirmation", async () => {
    const fixture = storageFixture();
    const url = await start(fixture.storage, fixture.kernel);
    const held = await call(`${url}/api/learning/held`, "GET");
    expect(held.status).toBe(200);
    expect(held.body.held).toMatchObject([{ id: "sv1:admission", uri: "https://example.invalid/pump", preview: "Pump alpha runs at 42 psi.", evidenceCount: 1 }]);
    const review = await call(`${url}/api/learning/review`, "POST", { id: "sv1:admission", decision: "promoted" });
    expect(review.status).toBe(200);
    expect(review.body.review).toMatchObject({ decision: "promoted", promotedEvidence: 1 });
    expect(fixture.spans[0]!.status).toBe("promoted");
    expect(fixture.kernel.ingest).toHaveBeenCalledOnce();
    expect((await call(`${url}/api/learning/review`, "POST", { id: "sv1:admission", decision: "rejected" })).status).toBe(409);
    expect((await call(`${url}/api/learning/review`, "POST", { id: "nope", decision: "rejected" })).status).toBe(404);
    expect((await call(`${url}/api/learning/review`, "POST", { id: "sv1:admission", decision: "maybe" })).status).toBe(400);
  });
});
