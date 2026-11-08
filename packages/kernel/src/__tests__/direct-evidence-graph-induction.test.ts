// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
import { expect, it, vi } from "vitest";
import * as optionalNull from "../optional-null-realization.js";
import { createIngestionRuntime } from "../ingestion-runtime.js";
import { createEventFactory } from "../events.js";
import { createIdFactory } from "../ids.js";
import { createLanguageAcquisitionEngine } from "../language.js";
import { createLanguageMemoryRuntime } from "../language-memory-runtime.js";
import { createClock, createHasher } from "../primitives.js";
import type { ScceKernelDeps } from "../storage.js";
import type { EvidenceSpan, GraphNode, GraphEdge, Hyperedge, SourceVersion, InformationLabel, JsonValue } from "../types.js";
import { storageFixtureForEvaluation } from "./evidence-promotion-evaluation-fixture.js";

const text = "Person_756249b46b treballa al lloc Desk_ead3272c63, a Place_2385000b71. L'extensió telefònica interna de Person_756249b46b és 45387445.";
const owner: InformationLabel = { tenantId: "tenant.source", principals: ["owner.source"], compartments: ["source"], exportClass: "restricted", mergePolicy: "isolated" };
function fixture() {
  const clock = createClock({ fixedTime: 1000, stepMs: 1 }), hasher = createHasher();
  const ids = createIdFactory({ clock, hasher, deterministicReplay: true, namespace: "source.graph" });
  const evidence: EvidenceSpan[] = [], sources: SourceVersion[] = [], nodes: GraphNode[] = [], edges: GraphEdge[] = [], hyperedges: Hyperedge[] = [];
  const languageWrites: string[] = [];
  const { storage, events } = storageFixtureForEvaluation({ evidence, clockNow: () => clock.now() });
  storage.evidence.putSourceVersion = async source => { sources.push(source); };
  storage.evidence.putEvidenceSpans = async rows => { evidence.push(...rows); };
  storage.evidence.putEvidenceSpan = async row => { evidence.push(row); };
  storage.graph.upsertNodes = async rows => { nodes.push(...rows); };
  storage.graph.upsertNode = async row => { nodes.push(row); };
  storage.graph.upsertEdges = async rows => { edges.push(...rows); };
  storage.graph.upsertEdge = async row => { edges.push(row); };
  storage.graph.upsertHyperedges = async rows => { hyperedges.push(...rows); };
  storage.graph.upsertHyperedge = async row => { hyperedges.push(row); };
  storage.model.putLanguageProfiles = async () => { languageWrites.push("profiles"); };
  storage.model.putLanguageProfile = async () => { languageWrites.push("profile"); };
  storage.model.writeModel = async () => { languageWrites.push("model"); };
  for (const key of ["putNgramObservationsBatch", "putNgramModel", "putNgramModels", "putLanguageUnit", "putLanguageUnits", "putLanguagePattern", "putLanguagePatterns", "putSemanticFrame", "putSemanticFrames", "replaceLanguagePatternProjection"] as const) {
    const original = storage.languageMemory[key];
    if (original) Object.assign(storage.languageMemory, { [key]: async (...args: unknown[]) => {
      languageWrites.push(key); return (original as (...args: unknown[]) => Promise<unknown>).apply(storage.languageMemory, args);
    } });
  }
  const deps = { storage, maxChunkBytes: 4096, informationAccess: { tenantId: owner.tenantId, principalId: owner.principals[0], compartments: owner.compartments, maximumExportClass: "restricted" },
    sourceInformationLabel: owner } as unknown as ScceKernelDeps;
  const runtime = createIngestionRuntime({ deps, clock, hasher, idFactory: ids, eventFactory: createEventFactory({ clock, hasher, idFactory: ids }),
    language: createLanguageAcquisitionEngine({ idFactory: ids }), languageMemoryRuntime: createLanguageMemoryRuntime({ idFactory: ids, hasher }),
    append: async event => { events.push(event); return event; }, onKernelStateMutation: () => undefined });
  const ingest = (content = text, intendedUse: "direct_evidence" | "learned_prior" | "quarantine_only" = "direct_evidence", informationLabel = owner) => runtime.ingest({
    uri: "fixture://owned-raw-prose", content, mediaType: "text/plain", namespace: "source.graph", informationLabel,
    sourceAdmission: { sourceClass: "owner_local", intendedUse, promotionAuthority: "owner" },
    sourceTrust: { identity: 1, integrity: 1, parserReliability: 1, directness: 1, authority: 1, freshness: 1,
      independenceGroup: "owned-raw-prose", accessScope: "owner_private", licenseStatus: "owner_authorized" }
  });
  return { ingest, nodes, edges, hyperedges, evidence, sources, events, languageWrites };
}

it("compiles an admitted raw graph-only source through the same induction without any language writes", async () => {
  const direct = fixture(), prior = fixture();
  const directResult = await direct.ingest(), priorResult = await prior.ingest(text, "learned_prior");
  expect(directResult.relationCandidates).toBeGreaterThan(0);
  expect(directResult.relationCandidates).toBe(priorResult.relationCandidates);
  expect(direct.languageWrites).toEqual([]);
  expect(prior.languageWrites).toContain("profiles");
  expect(prior.languageWrites).toContain("putNgramModel");
  expect(direct.evidence.every(span => span.status === "promoted")).toBe(true);
  const sourceEvidence = new Set(direct.evidence.map(span => String(span.id)));
  for (const row of [...direct.nodes, ...direct.edges, ...direct.hyperedges]) {
    expect(row.informationLabel).toEqual(owner);
    expect(row.evidenceIds.every(id => sourceEvidence.has(String(id)))).toBe(true);
  }
  const promotion = direct.events.find(event => event.typeId === "RelationPromotionCompiled")!;
  const decisions = (promotion.payload as Record<string, JsonValue>).decisions as Array<{ promoted: boolean }>;
  expect(decisions.length).toBeGreaterThan(0);
  expect(decisions.every(decision => !decision.promoted)).toBe(true);
});

it("keeps changed source roles bound to their exact new evidence and leaves retracted input inactive", async () => {
  const f = fixture(); await f.ingest();
  const oldEvidence = new Set(f.evidence.map(span => String(span.id))), oldVersion = f.sources.at(-1)!.sourceVersionId;
  const nodeStart = f.nodes.length, evidenceStart = f.evidence.length;
  const changed = text.replace("45387445", "90234117");
  expect((await f.ingest(changed)).relationCandidates).toBeGreaterThan(0);
  expect(f.sources.at(-1)!.sourceVersionId).not.toBe(oldVersion);
  const currentEvidence = new Set(f.evidence.slice(evidenceStart).map(span => String(span.id)));
  expect([...currentEvidence].every(id => !oldEvidence.has(id))).toBe(true);
  expect(f.nodes.slice(nodeStart).every(node => node.evidenceIds.every(id => currentEvidence.has(String(id))))).toBe(true);
  const before = [f.nodes.length, f.edges.length, f.hyperedges.length];
  expect((await f.ingest(changed, "quarantine_only")).relationCandidates).toBe(0);
  expect(f.evidence.at(-1)!.status).toBe("quarantined");
  expect([f.nodes.length, f.edges.length, f.hyperedges.length]).toEqual(before);
  expect(f.languageWrites).toEqual([]);
});

it("rejects foreign owner scope before source or graph persistence", async () => {
  const f = fixture();
  await expect(f.ingest(text, "direct_evidence", { ...owner, tenantId: "tenant.foreign", principals: ["owner.foreign"] })).rejects.toThrow();
  expect(f.sources).toEqual([]); expect(f.nodes).toEqual([]); expect(f.evidence).toEqual([]); expect(f.languageWrites).toEqual([]);
});

it("refuses late language publication even when graph compilation produces a form candidate", async () => {
  const candidate = vi.spyOn(optionalNull, "compileOptionalNullRealizationPatterns").mockReturnValue([{
    id: "fixture.language-permission-sentinel", profileId: "fixture.profile", patternKind: "syntax", support: 1, entropy: 0,
    evidenceIds: [], updatedAt: 1, patternJson: { schema: "fixture.authorization_sentinel" }
  }]);
  try {
    const f = fixture(); await f.ingest();
    expect(candidate).toHaveBeenCalled();
    expect(f.languageWrites).toEqual([]);
  } finally { candidate.mockRestore(); }
});
