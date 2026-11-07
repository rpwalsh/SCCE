// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
import { describe, expect, it, vi } from "vitest";
import { listHeldSources, reviewHeldSource } from "../learning-review.js";
import type { QuarantineSource } from "../storage.js";
import type { IngestInput, IngestResult } from "../types.js";

function reviewFixture() {
  const quarantined = new Map<string, QuarantineSource>();
  const spans: Array<{ id: string; sourceVersionId: string; text: string; status: string; title?: string }> = [];
  const storage = {
    blobs: { get: async () => Buffer.from("Pump alpha runs at 42 psi.") },
    quarantine: {
      put: async (source: QuarantineSource) => { quarantined.set(source.id, source); },
      get: async (id: string) => quarantined.get(id) ?? null,
      listPending: async () => [...quarantined.values()].filter(source => source.decision === "pending"),
      markDecision: async (id: string, decision: { decision: "promoted" | "rejected" }) => { const source = quarantined.get(id)!; quarantined.set(id, { ...source, decision: decision.decision }); }
    },
    evidence: {
      sourceVersionById: async () => ({ sourceId: "s1", sourceVersionId: "sv1", canonicalUri: "https://example.invalid/pump", namespace: "runtime-acquisition", contentHash: "h", mediaType: "text/plain", metadata: {}, sourceTrust: {}, observedAt: 1, byteLength: 26 }),
      searchEvidence: async (query: { sourceVersionId?: string; status?: string }) => spans
        .filter(span => span.sourceVersionId === query.sourceVersionId && (query.status === "any" || span.status === (query.status ?? "promoted")))
        .map(span => ({ span, score: 1, reason: "fixture" })),
      promoteEvidence: async (ids: string[]) => { let n = 0; for (const span of spans) if (ids.includes(span.id) && span.status !== "promoted") { span.status = "promoted"; n++; } return n; }
    }
  };
  const held: QuarantineSource = { id: "sv1:admission", sourceId: "s1" as never, sourceVersionId: "sv1" as never, uri: "https://example.invalid/pump", contentHash: "h" as never, mediaType: "text/html", fetchedAt: 1, trustVector: {}, permissionVector: { sourceAdmission: { sourceClass: "runtime_web", intendedUse: "direct_evidence", promotionAuthority: "review" } }, decision: "pending" };
  quarantined.set(held.id, held);
  spans.push({ id: "e1", sourceVersionId: "sv1", text: "Pump alpha runs at 42 psi.", status: "quarantined", title: "Pump alpha" }, { id: "e2", sourceVersionId: "sv1", text: "It was installed in 2019.", status: "quarantined" });
  const ingest = vi.fn(async (_input: IngestInput) => {
    for (const span of spans) span.status = "promoted";
    return { evidence: spans.length, events: [{ typeId: "SourcePromoted", payload: { sourceVersionId: "sv1" } }] } as unknown as IngestResult;
  });
  return { storage: storage as never, spans, quarantined, activation: { ingest } };
}

describe("learning review", () => {
  it("lists held sources with a readable preview of the quarantined material", async () => {
    const { storage } = reviewFixture();
    const held = await listHeldSources(storage);
    expect(held).toHaveLength(1);
    expect(held[0]).toMatchObject({ id: "sv1:admission", uri: "https://example.invalid/pump", title: "Pump alpha", evidenceCount: 2 });
    expect(held[0]!.preview).toBe("Pump alpha runs at 42 psi. It was installed in 2019.");
  });

  it("promotes every quarantined span of a source the owner confirms, and refuses a second decision", async () => {
    const { storage, spans, activation } = reviewFixture();
    const review = await reviewHeldSource(storage, { id: "sv1:admission", decision: "promoted", now: 5 }, activation);
    expect(activation.ingest).toHaveBeenCalledWith(expect.objectContaining({ namespace: "runtime-acquisition", sourceAdmission: { sourceClass: "runtime_web", intendedUse: "direct_evidence", promotionAuthority: "owner" } }));
    expect(review).toMatchObject({ decision: "promoted", promotedEvidence: 2 });
    expect(spans.every(span => span.status === "promoted")).toBe(true);
    expect(await listHeldSources(storage)).toEqual([]);
    await expect(reviewHeldSource(storage, { id: "sv1:admission", decision: "rejected" })).rejects.toThrow(/already promoted/u);
  });

  it("does not mark a promotion complete when canonical ingestion did not admit the exact held source", async () => {
    const { storage, quarantined } = reviewFixture();
    const activation = { ingest: async () => ({ evidence: 0, events: [] } as unknown as IngestResult) };
    await expect(reviewHeldSource(storage, { id: "sv1:admission", decision: "promoted" }, activation)).rejects.toThrow(/did not pass canonical admission/);
    expect(quarantined.get("sv1:admission")!.decision).toBe("pending");
  });

  it("leaves rejected material quarantined", async () => {
    const { storage, spans } = reviewFixture();
    const review = await reviewHeldSource(storage, { id: "sv1:admission", decision: "rejected", reason: "not true" });
    expect(review.promotedEvidence).toBe(0);
    expect(spans.every(span => span.status === "quarantined")).toBe(true);
    await expect(reviewHeldSource(storage, { id: "missing", decision: "rejected" })).rejects.toThrow(/not found/u);
  });
});
