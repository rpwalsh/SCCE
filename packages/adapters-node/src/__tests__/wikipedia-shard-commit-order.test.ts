// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
import { getFixtureLanguagePatternProjection, replaceFixtureLanguagePatternProjection } from "../../../kernel/src/__tests__/language-pattern-projection-fixture.js";
import { describe, expect, it } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { canonicalTemporalCoordinates, createHasher } from "@scce/kernel";
import { createWikipediaInputManifest } from "../wikipedia-input-manifest.js";
import { createWikipediaV3Ingestor } from "../wikipedia-v3-ingestor.js";

describe("Wikipedia shard graph dependency validation", () => {
  it("commits prepared training before persisting its projected graph additions", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "scce-wiki-shard-commit-order-"));
    const dumpPath = path.join(root, "dump.bz2");
    const indexPath = path.join(root, "index.txt");
    await writeFile(dumpPath, "fixture-dump");
    await writeFile(indexPath, "0:1:Fixture\n");
    try {
      const inputManifest = await createWikipediaInputManifest({ dumpPath, indexPath,
        cacheDir: path.join(root, "cache"), normalizationIdentity: "fixture-normalizer",
        compilerIdentity: "fixture-compiler", semanticConfig: { purpose: "shard-commit-order" } });
      const order: string[] = [];
      let transactionDepth = 0;
      const transactionDepthAt: number[] = [];
      const graphRows = { nodes: new Map<string, any>(), edges: new Map<string, any>(), hyperedges: new Map<string, any>() };
      const hasher = createHasher();
      const storage = {
        transaction: async (fn: () => Promise<unknown>) => { transactionDepth++; try { return await fn(); } finally { transactionDepth--; } },
        events: { append: async (event: any) => { if (event.typeId === "SymbolPatternLearned") { order.push("training.commit"); transactionDepthAt.push(transactionDepth); } }, readRange: async () => [] },
        evidence: { listEvidenceBackedSourceVersions: async () => [], getEvidenceBatch: async () => [] },
        model: { listLanguageProfiles: async () => [], putLanguageProfile: async () => {} },
        relationObservations: { sourceFamilyCountsForSeeds: async () => new Map(), list: async () => [], put: async () => {} },
        graph: {
          getSlice: async (query: any) => ({ bounded: true, query, nodes: [...graphRows.nodes.values()], edges: [...graphRows.edges.values()],
            hyperedges: [...graphRows.hyperedges.values()]
              .filter(row => row.evidenceIds.some((id: string) => query.evidenceIds?.includes(id)))
              .sort((left, right) => right.updatedAt - left.updatedAt || left.id.localeCompare(right.id)).slice(0, 2) }),
          upsertNodes: async (rows: any[]) => { order.push("graph.nodes"); transactionDepthAt.push(transactionDepth); for (const row of rows) graphRows.nodes.set(row.id, structuredClone(row)); },
          upsertEdges: async (rows: any[]) => { order.push("graph.edges"); transactionDepthAt.push(transactionDepth); for (const row of rows) graphRows.edges.set(row.id, structuredClone(row)); },
          upsertHyperedges: async (rows: any[]) => { order.push("graph.hyperedges"); transactionDepthAt.push(transactionDepth); for (const row of rows) graphRows.hyperedges.set(row.id, structuredClone(row)); }
        },
        languageMemory: {
          putNgramObservationsBatch: async () => {}, putNgramModels: async () => {}, putLanguageUnits: async () => {},
          getLanguagePatternProjection: getFixtureLanguagePatternProjection,
          replaceLanguagePatternProjection: replaceFixtureLanguagePatternProjection,
          putLanguagePatterns: async () => {}, putSemanticFrames: async () => {}
        }
      } as any;
      const ingestor = createWikipediaV3Ingestor({ storage,
        config: { runtime: { tempRoot: root, corpora: { wikipedia: { ngramShardChars: 100_000, ngramMaxOrder: 2, ngramVocabularyLimit: 32 } } } } as any });
      const samples = Array.from({ length: 80 }, (_, index) => {
        const first = index % 2 === 0;
        const evidenceId = `evidence.${index}`;
        const sourceId = `source.${index}`;
        const sourceVersionId = `version.${index}`;
        const text = `Measured fixture statement ${index}.`;
        const byteLength = Buffer.byteLength(text, "utf8");
        const codePointLength = [...text].length;
        const evidence = {
          id: evidenceId, sourceId, sourceVersionId, chunkId: `chunk.${index}`, contentHash: hasher.digestHex(text),
          mediaType: "text/plain", byteStart: 0, byteEnd: byteLength, charStart: 0, charEnd: codePointLength,
          text, textPreview: text,
          status: "promoted", alpha: 1, observedAt: index,
          provenance: { sourceFamilyId: "wikimedia:wikipedia", sourceVersionId, byteRange: [0, byteLength], charRange: [0, codePointLength] },
          informationLabel: { tenantId: "scce.public.corpus", principals: [], compartments: [], exportClass: "public", mergePolicy: "same_owner" }
        } as any;
        const valueKinds = first ? ["anchor_surface", "target_ref"] : ["date_surface", "time_context"];
        const candidate = {
          schema: "scce.semantic_candidate.v2", id: `candidate.${index}`, kind: first ? "link" : "date",
          channel: "source_declared_structured", relationSeedId: first ? "relation_seed.first" : "relation_seed.second",
          sourceId, sourceVersionId,
          participants: valueKinds.map((valueKind, port) => ({ portId: `port.${port}`, value: `${valueKind}.${index}`, valueKind, realization: "observed" })),
          qualifiers: {}, evidenceIds: [evidenceId], temporalCoordinates: canonicalTemporalCoordinates({ observedTime: index }), support: 1,
          provenance: { exactEvidenceIds: [evidenceId], extractionChannel: "source_declared_structured", anchors: [], assumptions: [],
            transformations: [], alternativeInterpretations: [], sourceIndependence: { independentSourceCount: 1,
              dependencyGroupIds: [`source.${index}`], estimate: 1 }, producer: { modelId: "fixture", snapshotId: "fixture.snapshot" },
            admissionState: "proposed", normalizationContractId: "fixture.normalization", participantIdentityIds: [] }
        } as any;
        return { uri: `wikipedia://fixture/page/${index}`, sourceVersionId, title: `Fixture ${index}`, text: evidence.text, evidence: [evidence], languageAliases: [],
          semanticCandidates: [candidate], createdAt: index + 1 };
      });
      for (let index = 0; index < 2; index++) graphRows.hyperedges.set(`prior.${index}`, {
        schema: "scce.hyperedge.v2", id: `prior.${index}`, relationId: `prior.relation.${index}`, participantPorts: [], memberNodeIds: [],
        qualifiers: {}, modality: { extractionChannel: "source_declared_structured" }, evidenceIds: ["evidence.0"], weightVector: {},
        temporalScope: {}, provenanceRefs: [], createdAt: 0, updatedAt: index,
        informationLabel: { tenantId: "scce.public.corpus", principals: [], compartments: [], exportClass: "public", mergePolicy: "same_owner" }
      });
      const result = await (ingestor as any).ingestLanguageShard(samples, "wikipedia://fixture/shard", "episode.fixture", inputManifest,
        async () => { order.push("checkpoint.commit"); transactionDepthAt.push(transactionDepth); });

      expect(result.promotedRelations).toBeGreaterThan(0);
      expect(result.graphHyperedges).toBeGreaterThan(0);
      expect(result.ngramModels).toBeGreaterThan(0);
      expect(result.languagePatterns).toBeGreaterThan(0);
      expect(order).toContain("graph.hyperedges");
      expect(order.indexOf("training.commit")).toBeGreaterThan(-1);
      expect(order.indexOf("training.commit")).toBeLessThan(order.findIndex(item => item.startsWith("graph.")));
      expect(order.indexOf("checkpoint.commit")).toBeGreaterThan(order.indexOf("graph.hyperedges"));
      expect(transactionDepthAt.every(depth => depth > 0)).toBe(true);
      expect(transactionDepth).toBe(0);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
