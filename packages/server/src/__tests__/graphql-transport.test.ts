// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
import { createServer, request as httpRequest, type Server } from "node:http";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SourceLearningApplication, type EpisodeId, type LearnSourceCommand, type LearnSourceResult, type ScceEvent, type ScceStorage } from "@scce/kernel";
import { createLocalGraphqlHandler, compileLocalOperations } from "../graphql-transport.js";
import { localNodeId, type LocalGraphqlServices } from "../graphql-schema.js";
import { TurnTaskRegistry } from "../turn-task-registry.js";
import { TurnApplication } from "../turn-application.js";
import { handleRequest, type ApiContext } from "../routes.js";
import { SourceApplication } from "../source-application.js";

const documents = {
  Status: "query Status { runtime { protocolVersion generation phase ready } }",
  Reserve: "mutation Reserve { reserveTurn(input: {}) { task { id status persistence } } }",
  Start: "mutation Start($id: ID!, $text: String!) { startTurn(input: {operationId: $id, text: $text}) { task { id status } } }",
  Cancel: "mutation Cancel($id: ID!) { cancelTurn(input: {taskId: $id}) { task { id status persistence } } }",
  Task: "query Task($id: ID!, $first: Int!, $after: String) { turnTask(id: $id) { id status result { id answer error value detail evidence { id sourceId textPreview provenance } guardFlags { sourceBacked } } frames(first: $first, after: $after) { edges { cursor node { id sequence kind status detail value assistantForce } } pageInfo { hasNextPage endCursor } } } }",
  Nodes: "query Nodes($ids: [ID!]!) { nodes(ids: $ids) { id ... on EvidenceSpan { byteStart sourceVersion { id canonicalUri } } } }",
  Sources: "query Sources($first: Int!, $after: String) { sources(first: $first, after: $after) { edges { cursor node { id sourceId namespace canonicalUri promotedSpanCount } } pageInfo { hasNextPage hasPreviousPage endCursor } } }",
  Learn: "mutation Learn($input: LearnSourceInput!) { learnSource(input: $input) { source { id sourceId canonicalUri byteLength } evidenceId languageProfileId clientMutationId } }",
  VscodeRead: "query VscodeRead { vscodeWorkspaceStatus { workspace { id rootPath updatedAt } sources { path } } }",
  VscodeWrite: "mutation VscodeWrite($input: VscodePathCommandInput!) { vscodeWorkspaceInitialize(input: $input) { workspace { id rootPath updatedAt } clientMutationId } }",
  VscodeTypedWrite: "mutation VscodeTypedWrite($input: VscodePathCommandInput!) { vscodeWorkspaceIngest(input: $input) { schema importBatchId ingested unchanged changed missing failed unsupported clientMutationId } }",
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
    sourceVersionById: vi.fn(async (id: string) => ({ sourceId: `source:${id}`, sourceVersionId: id, namespace: "test", canonicalUri: `local:${id}`, contentHash: `hash:${id}`, mediaType: "text/plain", byteLength: 12, observedAt: 1, sourceTrust: {}, metadata: {} })),
    listEvidenceBackedSourceVersions: vi.fn(async ({ afterSourceVersionId, limit }: { afterSourceVersionId?: string; limit: number }) => ["a", "b", "c"].filter(id => !afterSourceVersionId || id > afterSourceVersionId).slice(0, limit).map((id, index) => ({ sourceVersionId: id, contentHash: `hash:${id}`, canonicalUri: `local:${id}`, byteLength: 12, maxAlpha: 0.9 - index * 0.1, promotedSpanCount: index + 1 })))
  } } as unknown as ScceStorage;
  const registry = new TurnTaskRegistry(storage);
  const execute = vi.fn(async () => ({ status: 200, value: { answer: "한국어 🧭",
    evidence: [{ id: "evidence-1", sourceId: "source-1", textPreview: "proof", provenance: { byteStart: 4 } }],
    guardFlags: { sourceBacked: true } } }));
  const learnSource = vi.fn(async (command: LearnSourceCommand): Promise<LearnSourceResult> => ({
    source: { sourceId: "source:learned", sourceVersionId: "version:learned", namespace: command.namespace, canonicalUri: command.canonicalUri,
      contentHash: "sha256:learned", mediaType: command.mediaType, byteLength: command.sourceBytes.byteLength, observedAt: 1, sourceTrust: {}, metadata: {} } as LearnSourceResult["source"],
    evidenceId: "evidence:learned", languageProfileId: "profile:learned"
  }));
  const services: LocalGraphqlServices = { scope: "test-state", generation: "host-generation", storage,
    sources: new SourceApplication(storage, new SourceLearningApplication({ learnSource })),
    vscode: {
      ready: async () => ({}), projectSummary: async () => ({}),
      workspaceStatus: vi.fn(async () => ({ workspace: { id: "workspace.test", rootPath: "C:\\repo", updatedAt: 1 }, sources: [] })),
      learningCurriculum: async () => ({}), heldSources: async () => ({}), settings: async () => ({}), models: async () => ({}),
      codeValidationPolicies: async () => ({}),
      workspaceInitialize: vi.fn(async () => ({ id: "workspace.test", rootPath: "C:\\repo", updatedAt: 1 })),
      workspaceIngest: vi.fn(async () => ({ schema: "scce.workspace.ingest.v1", importBatchId: "batch-1", ingested: 3,
        unchanged: 2, changed: 1, missing: 0, failed: 0, unsupported: 0, workspace: {}, project: {} })),
      workspaceAsk: async () => ({}), workspaceCodingPatchPlan: async () => ({}),
      workspacePatch: async () => ({}), learningPursue: async () => ({}), reviewHeldSource: async () => ({}), approvePlan: async () => ({}),
      rejectPlan: async () => ({}), updateSetting: async () => ({}), downloadModel: async () => ({}), removeModel: async () => ({}), editCode: async () => ({})
    },
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
  return { call, services, registry, execute, learnSource, storage, url };
}
describe("registered local GraphQL transport", () => {
  it("retains the native origin, JSON-body, byte and loopback-host boundary", async () => {
    const context = { runtime: {}, config: { security: {} }, maxBodyBytes: 128 } as unknown as ApiContext;
    const server = createServer((req, res) => { void handleRequest(req, res, context); });
    servers.push(server); await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    const address = server.address(); if (!address || typeof address === "string") throw new Error("no address");
    const url = `http://127.0.0.1:${address.port}/api/graphql`;
    const root = await fetch(`http://127.0.0.1:${address.port}/`, { redirect: "manual" });
    expect(root.status).toBe(307);
    expect(root.headers.get("location")).toBe("/workbench/");
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
    await vi.waitFor(async () => expect((await call("Task", { id, first: 1 })).value.data.turnTask.result).toMatchObject({
      answer: "한국어 🧭",
      value: { answer: "한국어 🧭", evidence: [{ id: "evidence-1" }], guardFlags: { sourceBacked: true } },
      evidence: [{ id: "evidence-1", sourceId: "source-1", textPreview: "proof", provenance: { byteStart: 4 } }],
      guardFlags: { sourceBacked: true }
    }));
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

  it("pages the durable source inventory with generation-bound cursors", async () => {
    const { call } = await fixture();
    const first = (await call("Sources", { first: 2 })).value.data.sources;
    expect(first.edges.map((edge: any) => edge.node.canonicalUri)).toEqual(["local:a", "local:b"]);
    expect(first.pageInfo).toMatchObject({ hasNextPage: true, hasPreviousPage: false });
    const next = (await call("Sources", { first: 2, after: first.pageInfo.endCursor })).value.data.sources;
    expect(next.edges.map((edge: any) => edge.node.canonicalUri)).toEqual(["local:c"]);
    expect(next.pageInfo).toMatchObject({ hasNextPage: false, hasPreviousPage: true });
    expect((await call("Sources", { first: 51 })).value.errors[0].extensions.code).toBe("RESOURCE_LIMIT");
  });

  it("decodes exact source bytes through the shared typed learning command", async () => {
    const { call, learnSource } = await fixture();
    const text = "The Meridian Observatory opened in 1912.";
    const input = { operationId: "source-op-123456", namespace: "owner", canonicalUri: "urn:test:meridian", mediaType: "text/plain",
      bytesBase64: Buffer.from(text, "utf8").toString("base64"), title: "Meridian Observatory", observedAt: 100, clientMutationId: "client-source" };
    const learned = (await call("Learn", { input })).value.data.learnSource;
    expect(learned).toMatchObject({ source: { sourceId: "source:learned", canonicalUri: input.canonicalUri, byteLength: Buffer.byteLength(text) },
      languageProfileId: "profile:learned", clientMutationId: "client-source" });
    expect(learnSource).toHaveBeenCalledWith(expect.objectContaining({ sourceBytes: new Uint8Array(Buffer.from(text)), title: input.title }));
    const invalid = await call("Learn", { input: { ...input, operationId: "source-op-654321", bytesBase64: "not-base64" } });
    expect(invalid.value.errors[0].extensions.code).toBe("BAD_INPUT");
  });

  it("dispatches registered VS Code fields through the application service and preserves Relay correlation", async () => {
    const { call, services } = await fixture();
    expect((await call("VscodeRead")).value.data.vscodeWorkspaceStatus).toMatchObject({ workspace: { id: "workspace.test" }, sources: [] });
    const input = { operationId: "2a6f3fd3-f4d7-4d08-9cf5-6ad6a840a120", path: "C:\\repo", clientMutationId: "client-1" };
    const result = (await call("VscodeWrite", { input })).value.data.vscodeWorkspaceInitialize;
    expect(result).toEqual({ workspace: { id: "workspace.test", rootPath: "C:\\repo", updatedAt: 1 }, clientMutationId: "client-1" });
    expect(services.vscode.workspaceStatus).toHaveBeenCalledWith();
    expect(services.vscode.workspaceInitialize).toHaveBeenCalledWith(input.operationId, "C:\\repo");

    const typedInput = { ...input, operationId: "3b7e4fc4-a59d-4aa8-bf95-937f2676a20f", clientMutationId: "client-2" };
    expect((await call("VscodeTypedWrite", { input: typedInput })).value.data.vscodeWorkspaceIngest).toEqual({
      schema: "scce.workspace.ingest.v1", importBatchId: "batch-1", ingested: 3, unchanged: 2, changed: 1,
      missing: 0, failed: 0, unsupported: 0, clientMutationId: "client-2"
    });
    expect(services.vscode.workspaceIngest).toHaveBeenCalledWith(typedInput.operationId, "C:\\repo");
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
