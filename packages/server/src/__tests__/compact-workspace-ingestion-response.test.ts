// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
import { createServer } from "node:http";
import { afterEach, expect, it, vi } from "vitest";
import type { IngestResult } from "@scce/kernel";

const { ingest } = vi.hoisted(() => ({ ingest: vi.fn() }));
vi.mock("@scce/adapters-node", async importOriginal => ({
  ...await importOriginal<typeof import("@scce/adapters-node")>(),
  createWorkspaceRuntime: () => ({ ingest })
}));
import { handleRequest, type ApiContext } from "../routes.js";

const servers: ReturnType<typeof createServer>[] = [];
afterEach(async () => {
  ingest.mockReset();
  await Promise.all(servers.splice(0).map(server => new Promise<void>(resolve => server.close(() => resolve()))));
});

it("returns workspace preparation receipts without changing source indexes or nested ingestion ownership", async () => {
  const kernelResult: IngestResult = {
    episodeId: "episode:workspace" as IngestResult["episodeId"], files: 1, sources: 1, evidence: 1,
    promotedEvidenceIds: ["evidence:owned" as NonNullable<IngestResult["promotedEvidenceIds"]>[number]],
    graphNodes: 36, graphEdges: 2, graphHyperedges: 1, languageProfiles: 0,
    relationCandidates: 0, promotedRelations: 0, relationPromotionModelId: "promotion:workspace",
    opaqueRoleModelId: "roles:workspace", roleSurfaceOrderModelId: "order:workspace",
    typedObservations: { code: 1 }, observationRoutes: { graph: 1 }, skipped: [],
    events: [{ id: "event:workspace" as IngestResult["events"][number]["id"],
      episodeId: "episode:workspace" as IngestResult["episodeId"], typeId: "SourceVersionObserved" as IngestResult["events"][number]["typeId"],
      t: 1, hash: "event:original-full-hash", parents: [], payload: { sourceVersionId: "source:owned", contentHash: "sha256:owned",
        role: "original", byteLength: 135, internalDiagnostics: { provenance: "x".repeat(3 * 1024 * 1024) } } }]
  };
  const report = { schema: "scce.workspace.ingest.v1", workspace: { id: "workspace:owned", updatedAt: 42, rootPath: "owner/workspace", metadata: { ownerId: "owner:exact" } },
    importBatchId: "import:owned", ingested: 1, unchanged: 2, changed: 1, missing: 0, failed: 0, unsupported: 1,
    kernelResults: [kernelResult], sources: [{ path: "module.go", sourceVersionId: "source:owned", contentHash: "sha256:owned", ingestionStatus: "ingested" }],
    project: { files: 3, sourceIndexHash: "index:exact" }, sourceContracts: { compiled: 1, revision: "contracts:exact" } };
  ingest.mockResolvedValue(report);
  const context = { runtime: { storage: {} }, config: { security: {} }, maxBodyBytes: 1024 * 1024,
    startupReadiness: { snapshot: () => ({ phase: "ready", complete: true }) } } as unknown as ApiContext;
  const server = createServer((request, response) => { void handleRequest(request, response, context); });
  servers.push(server);
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("fixture address missing");
  const base = `http://127.0.0.1:${address.port}/api/workspace/ingest`;
  const request = { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ path: "owner/workspace" }) };
  const response = await fetch(base, request);
  expect(response.status).toBe(200);
  const bytes = await response.text();
  expect(Buffer.byteLength(bytes)).toBeLessThan(16 * 1024);
  const compact = JSON.parse(bytes);
  const { kernelResults, ...index } = report;
  expect(compact).toMatchObject(index);
  expect(compact.kernelResults[0]).toMatchObject({ ...kernelResult, events: [{ ...kernelResult.events[0],
    payloadView: "receipt", payload: { sourceVersionId: "source:owned", contentHash: "sha256:owned", role: "original", byteLength: 135 } }] });
  expect(compact.responseView).toEqual({ schema: "scce.workspace.ingest_response.v1", detail: "receipt", fullQuery: "full=1" });
  const full = await fetch(`${base}?full=1`, request);
  expect(full.status).toBe(200);
  expect(await full.json()).toEqual(report);
  expect(ingest.mock.calls[0]).toEqual(ingest.mock.calls[1]);
  expect(ingest.mock.calls[0]?.[0]).toBe("owner/workspace");
});
