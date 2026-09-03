import { createServer } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import { handleRequest, type ApiContext } from "../routes.js";

const servers: ReturnType<typeof createServer>[] = [];
afterEach(async () => { for (const server of servers.splice(0)) await new Promise(resolve => server.close(resolve)); });

function storageFixture() {
  const quarantined = new Map<string, { id: string; sourceVersionId: string; uri: string; mediaType: string; fetchedAt: number; decision: string }>();
  quarantined.set("sv1:admission", { id: "sv1:admission", sourceVersionId: "sv1", uri: "https://example.invalid/pump", mediaType: "text/html", fetchedAt: 1, decision: "pending" });
  const spans = [{ id: "e1", sourceVersionId: "sv1", text: "Pump alpha runs at 42 psi.", status: "quarantined", title: "Pump alpha" }];
  return {
    spans,
    storage: {
      quarantine: {
        get: async (id: string) => quarantined.get(id) ?? null,
        listPending: async () => [...quarantined.values()].filter(item => item.decision === "pending"),
        markDecision: async (id: string, decision: { decision: string }) => { quarantined.set(id, { ...quarantined.get(id)!, decision: decision.decision }); }
      },
      evidence: {
        searchEvidence: async (query: { sourceVersionId?: string; status?: string }) => spans.filter(span => span.sourceVersionId === query.sourceVersionId && span.status === query.status).map(span => ({ span, score: 1, reason: "fixture" })),
        promoteEvidence: async (ids: string[]) => { let n = 0; for (const span of spans) if (ids.includes(span.id)) { span.status = "promoted"; n++; } return n; }
      }
    }
  };
}

async function start(storage: unknown): Promise<string> {
  const context = {
    runtime: { storage },
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
    const url = await start(fixture.storage);
    const held = await call(`${url}/api/learning/held`, "GET");
    expect(held.status).toBe(200);
    expect(held.body.held).toMatchObject([{ id: "sv1:admission", uri: "https://example.invalid/pump", preview: "Pump alpha runs at 42 psi.", evidenceCount: 1 }]);
    const review = await call(`${url}/api/learning/review`, "POST", { id: "sv1:admission", decision: "promoted" });
    expect(review.status).toBe(200);
    expect(review.body.review).toMatchObject({ decision: "promoted", promotedEvidence: 1 });
    expect(fixture.spans[0]!.status).toBe("promoted");
    expect((await call(`${url}/api/learning/review`, "POST", { id: "sv1:admission", decision: "rejected" })).status).toBe(409);
    expect((await call(`${url}/api/learning/review`, "POST", { id: "nope", decision: "rejected" })).status).toBe(404);
    expect((await call(`${url}/api/learning/review`, "POST", { id: "sv1:admission", decision: "maybe" })).status).toBe(400);
  });
});
