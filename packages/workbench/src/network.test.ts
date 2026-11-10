// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
import { describe, expect, it, vi } from "vitest";
import { fetchQuery, type GraphQLTaggedNode } from "relay-runtime";
import statusQuery from "./__generated__/WorkbenchRuntimeQuery.graphql";
import { boundedText, createLocalEnvironment, readEvents } from "./network.js";

describe("Relay local transport", () => {
  it("only permits a loopback endpoint and never persists the bearer token", async () => {
    for (const endpoint of ["https://example.com/api/graphql", "http://example.com/api/graphql", "http://127.0.0.1:3873/other", "http://user:password@localhost/api/graphql"]) {
      expect(() => createLocalEnvironment({ endpoint })).toThrow("local SCCE host");
    }
    const fetcher = vi.fn(async () => new Response(JSON.stringify({ data: { runtime: { protocolVersion: "scce.graphql.v1", generation: "host-1", phase: "ready", ready: true } },
      extensions: { protocolVersion: "scce.graphql.v1", generation: "host-1" } })));
    const local = createLocalEnvironment({ endpoint: "http://127.0.0.1:3873/api/graphql", token: "test-only", fetch: fetcher });
    await fetchQuery(local.environment, statusQuery as GraphQLTaggedNode, {}).toPromise();
    const [, options] = fetcher.mock.calls[0] as unknown as [URL, RequestInit];
    expect(options.headers).toMatchObject({ authorization: "Bearer test-only" });
    expect(JSON.parse(String(options.body))).toMatchObject({ protocolVersion: "scce.graphql.v1", operationName: "WorkbenchRuntimeQuery" });
    expect(String(options.body)).not.toContain("test-only"); expect(String(options.body)).not.toContain("query Workbench");
    local.close();
  });

  it("rejects oversized responses and a host-generation change", async () => {
    await expect(boundedText(new Response("abcdef"), 3)).rejects.toThrow("byte budget");
    let generation = "first";
    const local = createLocalEnvironment({ endpoint: "http://localhost:3873/api/graphql", fetch: vi.fn(async () => new Response(JSON.stringify({
      data: { runtime: { protocolVersion: "scce.graphql.v1", generation, phase: "ready", ready: true } }, extensions: { protocolVersion: "scce.graphql.v1", generation }
    }))) });
    await fetchQuery(local.environment, statusQuery, {}, { fetchPolicy: "network-only" }).toPromise();
    generation = "different";
    await expect(fetchQuery(local.environment, statusQuery, {}, { fetchPolicy: "network-only" }).toPromise()).rejects.toThrow("changed");
    local.close();
  });

  it("decodes split UTF-8 subscription frames exactly and rejects a truncated record", async () => {
    const encoded = new TextEncoder().encode('event: next\ndata: {"answer":"한국어 🧭"}\n\nevent: complete\ndata: {}\n\n');
    const stream = new ReadableStream({ start(controller) { for (const byte of encoded) controller.enqueue(Uint8Array.of(byte)); controller.close(); } });
    const records = []; for await (const record of readEvents(new Response(stream))) records.push(record);
    expect(JSON.parse(records[0]!.data).answer).toBe("한국어 🧭"); expect(records[1]!.event).toBe("complete");
    await expect(async () => { for await (const _record of readEvents(new Response("event: next\ndata: {}"))) { /* consume */ } }).rejects.toThrow("Truncated");
  });
});
