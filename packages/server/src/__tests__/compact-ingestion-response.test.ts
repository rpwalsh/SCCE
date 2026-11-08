// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
import { createServer } from "node:http";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { IngestInput, IngestResult, JsonValue, ScceEvent } from "@scce/kernel";
import { handleRequest, type ApiContext } from "../routes.js";

const servers: ReturnType<typeof createServer>[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map(server => new Promise<void>(resolve => server.close(() => resolve()))));
});

const admission = { sourceClass: "owner_local", intendedUse: "direct_evidence", promotionAuthority: "owner" } as const;
const sourceTrust = { identity: 1, integrity: 1, parserReliability: 1, directness: 1, authority: 1,
  freshness: 1, independenceGroup: "owner:compact-ingest", accessScope: "owner_private", licenseStatus: "owner_authorized" } as const;

function resultFixture(): IngestResult {
  const event = (typeId: string, payload: JsonValue, ordinal: number): ScceEvent => ({
    id: `event:${ordinal}` as ScceEvent["id"], episodeId: "episode:ingest" as ScceEvent["episodeId"],
    typeId: typeId as ScceEvent["typeId"], t: ordinal, payload,
    parents: ordinal ? [`event:${ordinal - 1}` as ScceEvent["id"]] : [], hash: `complete-event-hash:${ordinal}`
  });
  return {
    episodeId: "episode:ingest" as IngestResult["episodeId"], files: 1, sources: 2, evidence: 1,
    promotedEvidenceIds: ["evidence:exact" as NonNullable<IngestResult["promotedEvidenceIds"]>[number]],
    graphNodes: 36, graphEdges: 8, graphHyperedges: 1, languageProfiles: 0,
    relationCandidates: 2, promotedRelations: 1, relationPromotionModelId: "promotion:owned",
    opaqueRoleModelId: "roles:owned", roleSurfaceOrderModelId: "order:owned",
    typedObservations: { document: 1 }, observationRoutes: { graph: 1 }, skipped: [],
    events: [
      event("OwnerAsked", { ingest: "owner://document", metadata: { provenance: "x".repeat(3 * 1024 * 1024) } }, 0),
      event("SourceObserved", { sourceId: "source:owned", uri: "owner://document", namespace: "owner-private" }, 1),
      event("SourceVersionObserved", { sourceVersionId: "source-version:original", contentHash: "sha256:original", byteLength: 135, role: "original" }, 2),
      event("SourceVersionObserved", { sourceVersionId: "source-version:derivative", contentHash: "sha256:derivative", byteLength: 130,
        role: "evidence-derivative", derivedFromSourceVersionId: "source-version:original", transformId: "extract:exact" }, 3),
      event("SourcePromoted", { sourceVersionId: "source-version:derivative", context: admission, sourceTrust,
        activeInfluence: { graph: true, language: false }, disposition: "promote", evidenceActions: [{ evidenceId: "evidence:exact", action: "promote" }] }, 4),
      event("GraphUpdated", { provenance: { oversizedDiagnostic: "y".repeat(1024 * 1024) } }, 5)
    ]
  };
}

async function fixture(result: IngestResult) {
  const ingest = vi.fn(async (_input: IngestInput) => result);
  const context = { runtime: { storage: {}, kernel: { ingest } }, config: { server: { url: "http://127.0.0.1:0" }, security: {} },
    maxBodyBytes: 1024 * 1024, startupReadiness: { snapshot: () => ({ phase: "ready", complete: true }) } } as unknown as ApiContext;
  const server = createServer((request, response) => { void handleRequest(request, response, context); });
  servers.push(server);
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("fixture address missing");
  return { ingest, url: `http://127.0.0.1:${address.port}` };
}

describe("ordinary ingestion response receipts", () => {
  it("keeps exact source, admission and event identities while large diagnostics require explicit full detail", async () => {
    const original = resultFixture();
    const originalSnapshot = JSON.stringify(original);
    const { ingest, url } = await fixture(original);
    const input = { uri: "owner://document", namespace: "owner-private", mediaType: "text/plain", content: "An owned fact.", sourceAdmission: admission, sourceTrust };
    const request = { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(input) };
    const response = await fetch(`${url}/api/ingest`, request);
    expect(response.status).toBe(200);
    const bytes = await response.text();
    expect(Buffer.byteLength(bytes)).toBeLessThan(16 * 1024);
    const compact = JSON.parse(bytes);
    const { events, ...counts } = original;
    expect(compact).toMatchObject(counts);
    expect(compact.responseView).toEqual({ schema: "scce.ingest_response.v1", detail: "receipt", fullQuery: "full=1" });
    expect(compact.events).toHaveLength(events.length);
    for (const [index, event] of events.entries()) {
      const { payload, ...envelope } = event;
      const { payload: projected, payloadView, ...received } = compact.events[index];
      expect(received).toEqual(envelope);
      expect(payloadView).toBe("receipt");
      if (event.typeId === "SourceObserved" || event.typeId === "SourceVersionObserved") expect(projected).toEqual(payload);
    }
    expect(compact.events[4].payload).toMatchObject({ context: admission, sourceTrust, activeInfluence: { graph: true, language: false }, disposition: "promote" });
    const full = await fetch(`${url}/api/ingest?full=1`, request);
    expect(full.status).toBe(200);
    const fullBytes = await full.text();
    expect(Buffer.byteLength(fullBytes)).toBeGreaterThan(2 * 1024 * 1024);
    expect(JSON.parse(fullBytes)).toEqual(original);
    expect(ingest).toHaveBeenCalledTimes(2);
    expect(ingest.mock.calls[0]).toEqual(ingest.mock.calls[1]);
    expect(ingest.mock.calls[0]?.[0]).toEqual(input);
    expect(JSON.stringify(original)).toBe(originalSnapshot);
  });

  it("preserves the codebase ingest request and counters in receipt and full views", async () => {
    const original = resultFixture();
    const { ingest, url } = await fixture(original);
    const request = { method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ path: "workspace/source", metadata: { ownerTag: "exact-source" } }) };
    const receipt = await fetch(`${url}/api/codebase/ingest`, request);
    expect(receipt.status).toBe(200);
    const bytes = await receipt.text();
    expect(Buffer.byteLength(bytes)).toBeLessThan(16 * 1024);
    const projected = JSON.parse(bytes);
    expect(projected).toMatchObject({ files: original.files, sources: original.sources, evidence: original.evidence,
      promotedEvidenceIds: original.promotedEvidenceIds, graphNodes: original.graphNodes,
      graphEdges: original.graphEdges, graphHyperedges: original.graphHyperedges, languageProfiles: 0, skipped: [] });
    const full = await fetch(`${url}/api/codebase/ingest?full=1`, request);
    expect(full.status).toBe(200);
    expect(await full.json()).toEqual(original);
    expect(ingest.mock.calls[0]).toEqual(ingest.mock.calls[1]);
    expect(ingest.mock.calls[0]?.[0]).toEqual({ path: "workspace/source", sourceAdmission: admission,
      sourceTrust: { ...sourceTrust, parserReliability: 0.94, freshness: 0.98, independenceGroup: "owner-local-codebase" },
      metadata: { ownerTag: "exact-source", sourceKind: "developer_intelligence", ingestionLane: "codebase" } });
  });
});
