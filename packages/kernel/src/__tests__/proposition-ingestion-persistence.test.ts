// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
import { describe, expect, it } from "vitest";

import { createEventFactory } from "../events.js";
import { createIdFactory } from "../ids.js";
import { createIngestionRuntime } from "../ingestion-runtime.js";
import { createLanguageMemoryRuntime } from "../language-memory-runtime.js";
import { createLanguageAcquisitionEngine } from "../language.js";
import { createClock, createHasher } from "../primitives.js";
import { PROPOSITION_GRAPH_NODE_SCHEMA } from "../semantic-proof-system.js";
import type { ScceKernelDeps } from "../storage.js";
import type { EvidenceSpan, GraphNode, ScceEvent, SourceVersion } from "../types.js";

// The proposition writer is exercised here through the real ingestion runtime rather than through the graph builder
// it lives in, because a node that never reaches storage.graph.upsertNodes is not persistence. This is the seam the
// corpus importer and the ingestion runtime share, so what this test observes is what a real ingest would store.
describe("propositions reach storage through ingestion", () => {
  async function ingest(text: string) {
    const clock = createClock({ fixedTime: 1_700_000_000_000, stepMs: 1 });
    const hasher = createHasher();
    const idFactory = createIdFactory({ clock, hasher, deterministicReplay: true, namespace: "proposition-ingest" });
    const upsertedNodes: GraphNode[] = [];
    const events: ScceEvent[] = [];
    const sourceVersions: SourceVersion[] = [];
    const evidence: EvidenceSpan[] = [];
    const informationLabel = {
      tenantId: "fixture.tenant",
      principals: ["fixture.owner"],
      compartments: ["fixture.ingestion"],
      exportClass: "restricted" as const,
      mergePolicy: "isolated" as const
    };

    const deps = {
      maxChunkBytes: 4096,
      informationAccess: {
        tenantId: "fixture.tenant",
        principalId: "fixture.owner",
        compartments: ["fixture.ingestion"],
        maximumExportClass: "restricted"
      },
      sourceInformationLabel: informationLabel,
      storage: {
        transaction: async <T>(operation: () => Promise<T>) => operation(),
        blobs: { put: async (content: Uint8Array) => idFactory.contentHash(content) },
        evidence: {
          putSourceVersion: async (source: SourceVersion) => { sourceVersions.push(source); },
          putEvidenceSpans: async (spans: EvidenceSpan[]) => { evidence.push(...spans); },
          getEvidenceBatch: async (ids: readonly EvidenceSpan["id"][]) => {
            const wanted = new Set(ids.map(String));
            return evidence.filter(span => wanted.has(String(span.id)));
          }
        },
        events: { readRange: async () => [] },
        quarantine: { put: async () => undefined },
        ingestion: { put: async () => undefined },
        model: { putLanguageProfiles: async () => undefined },
        graph: {
          upsertNodes: async (nodes: GraphNode[]) => { upsertedNodes.push(...nodes); },
          upsertEdges: async () => undefined,
          upsertHyperedges: async () => undefined
        },
        languageMemory: {
          putNgramObservationsBatch: async () => undefined,
          putNgramModels: async () => undefined,
          putLanguageUnits: async () => undefined,
          putLanguagePatterns: async () => undefined,
          putSemanticFrames: async () => undefined
        }
      }
    } as unknown as ScceKernelDeps;

    const runtime = createIngestionRuntime({
      deps,
      clock,
      hasher,
      idFactory,
      eventFactory: createEventFactory({ idFactory, clock, hasher }),
      language: createLanguageAcquisitionEngine({ idFactory }),
      languageMemoryRuntime: createLanguageMemoryRuntime({ idFactory, hasher }),
      append: async (event: ScceEvent) => { events.push(event); return event; },
      onKernelStateMutation: () => undefined
    });

    await runtime.ingest({
      uri: "inline://proposition-ingest",
      namespace: "fixture",
      mediaType: "text/plain",
      content: text,
      sourceAdmission: {
        sourceClass: "owner_local",
        intendedUse: "direct_evidence",
        promotionAuthority: "owner"
      },
      sourceTrust: {
        identity: 1,
        integrity: 1,
        parserReliability: 1,
        directness: 1,
        authority: 1,
        freshness: 1,
        independenceGroup: "fixture:proposition-ingest",
        accessScope: "owner_private",
        licenseStatus: "owner_authorized"
      }
    });

    const propositions = upsertedNodes.filter(node => {
      const representation = node.representation;
      return Boolean(representation)
        && typeof representation === "object"
        && !Array.isArray(representation)
        && (representation as Record<string, unknown>).schema === PROPOSITION_GRAPH_NODE_SCHEMA;
    });
    return { upsertedNodes, propositions, evidence };
  }

  it("stores a proposition node for prose, carrying its measured value as a constraint", async () => {
    const { propositions, upsertedNodes } = await ingest("Xylor-7 decomposes at 417 degrees Celsius.");

    expect(upsertedNodes.length).toBeGreaterThan(0);
    expect(propositions.length).toBeGreaterThan(0);
    const values = propositions.flatMap(node =>
      ((node.representation as Record<string, unknown>).constraints as Array<{ value: { value?: number } }>)
        .map(constraint => constraint.value?.value));
    expect(values).toContain(417);
  });

  it("binds every stored proposition to the evidence that states it", async () => {
    const { propositions, evidence } = await ingest("Xylor-7 decomposes at 417 degrees Celsius.");
    const evidenceIds = new Set(evidence.map(span => String(span.id)));

    expect(propositions.every(node => node.evidenceIds.length > 0)).toBe(true);
    expect(propositions.every(node => node.evidenceIds.every(id => evidenceIds.has(String(id))))).toBe(true);
  });

  it("keeps the identifier whole, so no measurement is invented from its suffix", async () => {
    // "Xylor-7" read as the word "xylor" and the number 7 produced a second constraint of 7 with the unit
    // "decomposes". A stored proposition carrying a value the source never stated is worse than no proposition.
    const { propositions } = await ingest("Xylor-7 decomposes at 417 degrees Celsius.");
    const units = propositions.flatMap(node =>
      ((node.representation as Record<string, unknown>).constraints as Array<{ value: { unit?: string } }>)
        .map(constraint => constraint.value?.unit));

    expect(units).not.toContain("decomposes");
  });
});
