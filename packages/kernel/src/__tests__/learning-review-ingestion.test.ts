// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
import { describe, expect, it } from "vitest";
import { createScceKernel } from "../kernel.js";
import { createClock, createHasher, toJsonValue } from "../primitives.js";
import { reviewHeldSource } from "../learning-review.js";
import { storageFixtureForEvaluation } from "./evidence-promotion-evaluation-fixture.js";
import type { QuarantineSource, ScceKernelDeps } from "../storage.js";
import type { ContentHash, EvidenceSpan, GraphEdge, GraphNode, Hyperedge, SourceVersion } from "../types.js";

describe("owner-reviewed knowledge activation", () => {
  it.each([false, true])("replays the canonical source into graph and subsequent retrieval without changing identity (derivative=%s)", async derivative => {
    const evidence: EvidenceSpan[] = [];
    const { storage } = storageFixtureForEvaluation({ evidence, clockNow: () => 100 });
    const versions = new Map<string, SourceVersion>();
    const held = new Map<string, QuarantineSource>();
    const blobs = new Map<string, Uint8Array>();
    const nodes = new Map<string, GraphNode>();
    const edges = new Map<string, GraphEdge>();
    const hyperedges = new Map<string, Hyperedge>();
    const hasher = createHasher();
    storage.blobs = {
      put: async bytes => { const hash = `sha256_${hasher.digestHex(bytes)}` as ContentHash; blobs.set(hash, bytes); return hash; },
      get: async hash => { const bytes = blobs.get(hash); if (!bytes) throw new Error("missing source bytes"); return bytes; },
      exists: async hash => blobs.has(hash)
    };
    storage.evidence.putSourceVersion = async source => { versions.set(String(source.sourceVersionId), source); };
    storage.evidence.sourceVersionById = async id => versions.get(String(id)) ?? null;
    storage.evidence.sourceVersionsForEvidence = async ids => [...versions.values()].filter(source => evidence.some(span => ids.includes(span.id) && span.sourceVersionId === source.sourceVersionId));
    storage.evidence.putEvidenceSpan = async span => { const prior = evidence.findIndex(row => row.id === span.id); if (prior < 0) evidence.push(span); else evidence[prior] = span; };
    storage.evidence.searchEvidence = async query => evidence.filter(span => (!query.sourceVersionId || span.sourceVersionId === query.sourceVersionId) && (query.status === "any" || span.status === (query.status ?? "promoted"))).map(span => ({ span, score: 1, reason: "owned status" }));
    storage.evidence.promoteEvidence = async ids => { for (const span of evidence) if (ids.includes(span.id)) span.status = "promoted"; return ids.length; };
    storage.quarantine = {
      put: async item => { held.set(item.id, item); }, get: async id => held.get(id) ?? null,
      listPending: async () => [...held.values()].filter(item => item.decision === "pending"),
      markDecision: async (id, decision) => { held.set(id, { ...held.get(id)!, decision: decision.decision, decisionJson: toJsonValue(decision) }); }
    };
    storage.graph.upsertNode = async node => { nodes.set(String(node.id), node); };
    storage.graph.upsertEdge = async edge => { edges.set(String(edge.id), edge); };
    storage.graph.upsertHyperedge = async edge => { hyperedges.set(String(edge.id), edge); };
    storage.graph.getSlice = async query => ({ bounded: true, query: query ?? {}, nodes: [...nodes.values()], edges: [...edges.values()], hyperedges: [...hyperedges.values()] });
    storage.userModelClaims = { putClaim: async () => undefined, listClaims: async () => [] };
    storage.taskResumption = { putSnapshot: async () => undefined, getLatestSnapshot: async () => null };
    const deps = { storage, files: { streamPath: async function* () {} }, buildTest: { run: async () => ({ ok: true, commands: [], output: "", diagnostics: [] }) },
      clock: createClock({ fixedTime: 100, stepMs: 1 }), namespace: "held-learning", deterministicReplay: true,
      informationAccess: { tenantId: "owner", principalId: "owner", compartments: [], maximumExportClass: "restricted" },
      sourceInformationLabel: { tenantId: "owner", principals: ["owner"], compartments: [], exportClass: "restricted", mergePolicy: "isolated" }
    } as unknown as ScceKernelDeps;
    const kernel = createScceKernel(deps);
    const text = "Pump alpha pressure is 42 psi.";
    const request = "Pump alpha pressure";
    const before = await kernel.turn({ text: request, requestedAuthority: "factual" });
    expect(before.evidence).toEqual([]);
    await kernel.ingest({ uri: "fixture://pump-alpha", namespace: "runtime-acquisition", mediaType: derivative ? "application/pdf" : "text/plain", content: derivative ? new Uint8Array([1, 2, 3]) : text,
      ...(derivative ? { evidenceDerivative: { bytes: Buffer.from(text), text, kind: "extracted-text" as const, transformId: "fixture.extract", originalCoordinateSpace: "extracted-text-utf8" as const, redactionMap: [] } } : {}),
      sourceAdmission: { sourceClass: "runtime_web", intendedUse: "direct_evidence", promotionAuthority: "review" },
      sourceTrust: { identity: 1, integrity: 1, parserReliability: 1, directness: 1, authority: 1, freshness: 1, independenceGroup: "pump", accessScope: "public", licenseStatus: "unknown" }
    });
    expect(nodes.size).toBe(0);
    expect(evidence.every(span => span.status === "quarantined")).toBe(true);
    expect((await kernel.turn({ text: request, requestedAuthority: "factual" })).evidence).toEqual([]);
    const sourceIds = [...versions.keys()].sort();
    const evidenceIds = evidence.map(span => span.id);
    const item = [...held.values()].find(row => row.decision === "pending")!;
    await reviewHeldSource(storage, { id: item.id, decision: "promoted" }, kernel);
    expect(nodes.size).toBeGreaterThan(0);
    expect([...versions.keys()].sort()).toEqual(sourceIds);
    expect(evidence.map(span => span.id)).toEqual(evidenceIds);
    expect(evidence.every(span => span.status === "promoted")).toBe(true);
    expect(await storage.languageMemory.listNgramModels()).toEqual([]);
    const activatedGraphSize = [nodes.size, edges.size, hyperedges.size];
    const after = await kernel.turn({ text: request, requestedAuthority: "factual" });
    expect(after.evidence.map(span => span.id)).toEqual(evidenceIds);
    expect(after.evidence.map(span => span.text)).toEqual([text]);
    const restarted = createScceKernel({ ...deps, clock: createClock({ fixedTime: 1000, stepMs: 1 }) });
    const recalled = await restarted.turn({ text: request, requestedAuthority: "factual" });
    expect(recalled.evidence.map(span => span.id)).toEqual(evidenceIds);
    expect(recalled.evidence.map(span => span.text)).toEqual([text]);
    await expect(reviewHeldSource(storage, { id: item.id, decision: "promoted" }, restarted)).rejects.toThrow(/already promoted/);
    expect([nodes.size, edges.size, hyperedges.size]).toEqual(activatedGraphSize);
  });
});
