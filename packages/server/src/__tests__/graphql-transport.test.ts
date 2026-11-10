// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
import { createServer, request as httpRequest, type Server } from "node:http";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { EpisodeId, ScceEvent, ScceStorage } from "@scce/kernel";
import { createLocalGraphqlHandler, compileLocalOperations } from "../graphql-transport.js";
import { localNodeId, type LocalGraphqlServices } from "../graphql-schema.js";
import { TurnTaskRegistry } from "../turn-task-registry.js";
import { TurnApplication } from "../turn-application.js";
import { handleRequest, type ApiContext } from "../routes.js";

const documents = {
  Status: "query Status { runtime { protocolVersion generation phase ready } }",
  Reserve: "mutation Reserve { reserveTurn(input: {}) { task { id status persistence } } }",
  Start: "mutation Start($id: ID!, $text: String!) { startTurn(input: {operationId: $id, text: $text}) { task { id status } } }",
  Cancel: "mutation Cancel($id: ID!) { cancelTurn(input: {taskId: $id}) { task { id status persistence } } }",
  Task: "query Task($id: ID!, $first: Int!, $after: String) { turnTask(id: $id) { id status result { id answer error } frames(first: $first, after: $after) { edges { cursor node { id sequence kind } } pageInfo { hasNextPage endCursor } } } }",
  Nodes: "query Nodes($ids: [ID!]!) { nodes(ids: $ids) { id ... on EvidenceSpan { byteStart sourceVersion { id canonicalUri } } } }",
  Updates: "subscription Updates($id: ID!, $after: Int!) { turnTaskUpdated(id: $id, afterSequence: $after) { id status frames(first: 50) { edges { node { id sequence } } } result { id answer } } }"
};
const servers: Server[] = [];
afterEach(async () => { await Promise.all(servers.splice(0).map(server => new Promise<void>(resolve => { server.closeAllConnections(); server.close(() => resolve()); }))); });
async function fixture() {
  const events: ScceEvent[] = [];
  const storage = { events: {
    append: async (event: ScceEvent) => { events.push(structuredClone(event)); },
    readEpisode: async (id: EpisodeId) => structuredClone(events.filter(event => event.episodeId === id))
  }, evidence: {
    getEvidenceBatch: vi.fn(async (ids: string[]) => ids.map(id => ({ id, status: id === "revoked" ? "quarantined" : "promoted", byteStart: 12, sourceVersionId: "source" }))),
    sourceVersionById: vi.fn(async () => ({ canonicalUri: "local:notes" }))
  } } as unknown as ScceStorage;
  const registry = new TurnTaskRegistry(storage);
  const execute = vi.fn(async () => ({ status: 200, value: { answer: "한국어 🧭" } }));
  const services: LocalGraphqlServices = { scope: "test-state", generation: "host-generation", storage,
    readiness: () => ({ phase: "ready", ok: true }), turns: new TurnApplication({ scope: "test-state", registry, execute }) };
  const handler = createLocalGraphqlHandler(services, documents);
  const server = createServer(async (req, res) => {
    const parts: Buffer[] = []; for await (const part of req) parts.push(part);
    await handler(req, res, JSON.parse(Buffer.concat(parts).toString()), "request-test");
  });
  servers.push(server); await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const address = server.address(); if (!address || typeof address === "string") throw new Error("no address");
  const url = `http://127.0.0.1:${address.port}`;
  const call = async (operationName: string, variables = {}, extra = {}) => {
    const response = await fetch(url, { method: "POST", body: JSON.stringify({ protocolVersion: "scce.graphql.v1", operationName, generation: services.generation, variables, ...extra }) });
    return { response, value: await response.json() as any };
  };
  return { call, services, registry, execute, storage, url };
}
describe("registered local GraphQL transport", () => {
  it("retains the native origin, JSON-body, byte and loopback-host boundary", async () => {
    const context = { runtime: {}, config: { security: {} }, maxBodyBytes: 128 } as unknown as ApiContext;
    const server = createServer((req, res) => { void handleRequest(req, res, context); });
    servers.push(server); await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    const address = server.address(); if (!address || typeof address === "string") throw new Error("no address");
    const url = `http://127.0.0.1:${address.port}/api/graphql`;
    const deniedOrigin = await fetch(url, { method: "POST", headers: { origin: "https://untrusted.example", "content-type": "application/json" }, body: "{}" });
    expect(deniedOrigin.status).toBe(403);
    const deniedHost = await new Promise<number | undefined>((resolve, reject) => {
      const request = httpRequest(url, { method: "POST", headers: { host: "untrusted.example", "content-type": "application/json" } }, response => { response.resume(); resolve(response.statusCode); });
      request.on("error", reject); request.end("{}");
    });
    expect(deniedHost).toBe(403);
    expect((await fetch(url, { method: "POST", body: "{}" })).status).toBe(415);
    expect((await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ text: "x".repeat(256) }) })).status).toBe(413);
  });
  it("runs a typed command, refetches exactly, and rejects conflicting retries", async () => {
    const { call, execute } = await fixture();
    const reserved = await call("Reserve"), id = reserved.value.data.reserveTurn.task.id;
    expect(reserved.value.data.reserveTurn.task.persistence).toBe("durable");
    expect(reserved.value.extensions).toMatchObject({ protocolVersion: "scce.graphql.v1", requestId: "request-test" });
    await Promise.all([call("Start", { id, text: "request" }), call("Start", { id, text: "request" })]);
    await vi.waitFor(async () => expect((await call("Task", { id, first: 1 })).value.data.turnTask.result.answer).toBe("한국어 🧭"));
    expect(execute).toHaveBeenCalledTimes(1);
    const conflict = await call("Start", { id, text: "changed" });
    expect(conflict.value.errors[0].extensions.code).toBe("CONFLICT");
    expect((await call("Task", { id: localNodeId("other-state", "TurnTask", "unknown"), first: 1 })).value.errors[0].extensions.code).toBe("BAD_ID");
  });

  it("binds cursors to the task and host generation and bounds pages", async () => {
    const { call, services, registry } = await fixture();
    const a = await services.turns.reserve(), b = await services.turns.reserve();
    registry.append(a.taskId, { type: "progress", phase: "next" }); await registry.drain(a.taskId);
    const id = localNodeId(services.scope, "TurnTask", a.taskId);
    const first = (await call("Task", { id, first: 1 })).value.data.turnTask.frames;
    expect(first.pageInfo.hasNextPage).toBe(true);
    const next = (await call("Task", { id, first: 1, after: first.pageInfo.endCursor })).value.data.turnTask.frames;
    expect(next.edges[0].node.sequence).toBe(2);
    const wrong = await call("Task", { id: localNodeId(services.scope, "TurnTask", b.taskId), first: 1, after: first.pageInfo.endCursor });
    expect(wrong.value.errors[0].extensions.code).toBe("INVALID_CURSOR");
    expect((await call("Task", { id, first: 100000 })).value.errors[0].extensions.code).toBe("RESOURCE_LIMIT");
  });

  it("batches duplicate evidence IDs in order and excludes unpromoted spans", async () => {
    const { call, services, storage } = await fixture();
    const visible = localNodeId(services.scope, "EvidenceSpan", "visible"), hidden = localNodeId(services.scope, "EvidenceSpan", "revoked");
    const result = await call("Nodes", { ids: [visible, hidden, visible] });
    expect(result.value.data.nodes.map((node: any) => node?.id ?? null)).toEqual([visible, null, visible]);
    expect(storage.evidence.getEvidenceBatch).toHaveBeenCalledTimes(1);
    expect(storage.evidence.sourceVersionById).toHaveBeenCalledTimes(1);
    expect((await call("Nodes", { ids: Array(65).fill(visible) })).value.errors[0].extensions.code).toBe("RESOURCE_LIMIT");
  });

  it("rejects arbitrary documents, unknown envelopes, and stale generations before executing", async () => {
    const { call, execute } = await fixture();
    expect((await call("Reserve", {}, { query: "mutation { reserveTurn(input: {}) { clientMutationId } }" })).value.errors[0].extensions.code).toBe("BAD_ENVELOPE");
    expect((await call("Reserve", {}, { generation: "old-host" })).value.errors[0].extensions.code).toBe("STALE_GENERATION");
    expect((await call("Unknown")).value.errors[0].extensions.code).toBe("UNKNOWN_OPERATION");
    expect((await call("Reserve", {}, { generation: undefined })).value.errors[0].extensions.code).toBe("STALE_GENERATION");
    expect(execute).not.toHaveBeenCalled();
    expect(() => compileLocalOperations({ Bad: "query Bad { runtime { nope } }" })).toThrow("nope");
    expect(() => compileLocalOperations({ Bad: "mutation Bad { a: reserveTurn(input: {}) { clientMutationId } b: reserveTurn(input: {}) { clientMutationId } }" })).toThrow("one command");
  });

  it("streams durable replay from an exact sequence and completes on a terminal task", async () => {
    const { services, registry, url } = await fixture();
    const task = await services.turns.reserve(); registry.append(task.taskId, { type: "result", status: 200, value: { answer: "done" } }); await registry.drain(task.taskId);
    const response = await fetch(url, { method: "POST", headers: { accept: "text/event-stream" }, body: JSON.stringify({
      protocolVersion: "scce.graphql.v1", operationName: "Updates", generation: services.generation,
      variables: { id: localNodeId(services.scope, "TurnTask", task.taskId), after: 1 }
    }) });
    const text = await response.text();
    expect(response.headers.get("content-type")).toContain("text/event-stream");
    expect(text).toContain('"sequence":2'); expect(text).not.toContain('"sequence":1');
    expect(text).toContain('"answer":"done"'); expect(text).toContain("event: complete");
  });
});
