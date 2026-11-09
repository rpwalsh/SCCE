// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
import { getFixtureLanguagePatternProjection, replaceFixtureLanguagePatternProjection } from "../../../kernel/src/__tests__/language-pattern-projection-fixture.js";
import { describe, expect, it, vi } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { canonicalTemporalCoordinates, createHasher, createIngestStageTracer, validatePooledLanguageProfileOwnership, type LanguageProfile, type SourceInductionBatchExecution } from "@scce/kernel";
import { createWikipediaInputManifest } from "../wikipedia-input-manifest.js";
import { createWikipediaV3Ingestor } from "../wikipedia-v3-ingestor.js";
import { corpusSegmentationInputRecipe } from "../corpus-segmentation-producer.js";
import { rawCorpusSegmentationFixture } from "../../../kernel/src/__tests__/fixtures/raw-corpus-segmentation.js";
import * as boundary from "../../../kernel/src/boundary-estimator.js";
import * as population from "../../../kernel/src/segmentation-population.js";
import * as sourceExecution from "../source-induction-execution.js";
import { createSourceInductionWorkerSession } from "../source-induction-worker-session.js";
import * as stageTrace from "../ingest-stage-trace-sink.js";

describe("Wikipedia shard graph dependency validation", () => {
  it.each([{ global: false, workers: false }, { global: true, workers: false }, { global: false, workers: true }])("commits prepared training before persisting its projected graph additions (%j)", async ({ global, workers }) => {
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
      const trace = createIngestStageTracer({ record: () => {} });
      vi.spyOn(stageTrace, "ingestStageTracer").mockReturnValue(trace);
      const executionReceipts: sourceExecution.SourceInductionExecutionReceipt[] = [];
      const executionPolicy: sourceExecution.SourceInductionWorkerExecution = { backend: "node_workers.v1", workers: 1,
        workerHeapMb: 32, maxNodeRssBytes: 16 * 1024 ** 3, abortGraceMs: 1000 };
      if (workers) vi.spyOn(sourceExecution, "runSourceInductionExecution").mockImplementation(async <T>(input: {
        policy: sourceExecution.SourceInductionWorkerExecution; run(execution: SourceInductionBatchExecution): Promise<T>;
      }) => {
        let preparedBatches = 0, inducedBatches = 0;
        const execution: SourceInductionBatchExecution = { concurrency: 1, close: async () => {}, async open(job) {
          preparedBatches++;
          const session = createSourceInductionWorkerSession(structuredClone(job));
          return { jobDigest: job.jobDigest, preparations: session.preparations,
            verify: async corpus => session.verify(corpus), induce: async () => { inducedBatches++; return session.induce(); },
            close: async () => session.close() };
        } };
        const result = await input.run(execution);
        if (!preparedBatches) return { result };
        const receipt: sourceExecution.SourceInductionExecutionReceipt = { schema: "scce.source_induction_execution.v1",
          declaration: input.policy, bundleDigest: `fixture.phase.${executionReceipts.length}`, workersStarted: 1,
          preparedBatches, inducedBatches, peakNodeRssBytes: 123456, rssSamplingIntervalMs: 100 };
        executionReceipts.push(receipt);
        return { result, receipt };
      });
      let transactionDepth = 0;
      const transactionDepthAt: number[] = [];
      const graphRows = { nodes: new Map<string, any>(), edges: new Map<string, any>(), hyperedges: new Map<string, any>() };
      const hasher = createHasher();
      let persistedProfile: LanguageProfile | undefined;
      const corpus = global ? await rawCorpusSegmentationFixture() : undefined;
      const declaration = corpus ? { scope: { informationLabel: { tenantId: "scce.public.corpus", principals: [], compartments: [], exportClass: "public" as const, mergePolicy: "same_owner" as const },
        sourceSystems: ["wikipedia"] }, recipeId: corpusSegmentationInputRecipe(4096), normalizationContractId: corpus.model.normalizationContractId,
        bounds: { pageRows: 3, maxPageBytes: 65536 } } : undefined;
      const active = vi.fn(async () => corpus ? ({ inference: corpus.model, loader: corpus.loader }) : null);
      const fit = vi.spyOn(boundary, "fitBoundaryEstimator"), learn = vi.spyOn(population, "learnSegmentationPopulations");
      const storage = {
        ...(corpus ? { corpusSegmentation: { readActive: active } } : {}),
        transaction: async (fn: () => Promise<unknown>) => { transactionDepth++; try { return await fn(); } finally { transactionDepth--; } },
        events: { append: async (event: any) => { if (event.typeId === "SymbolPatternLearned") { order.push("training.commit"); transactionDepthAt.push(transactionDepth); } }, readRange: async () => [] },
        evidence: { listEvidenceBackedSourceVersions: async () => [], getEvidenceBatch: async () => [] },
        model: { listLanguageProfiles: async () => [], putLanguageProfile: async (profile: LanguageProfile) => { persistedProfile = profile; } },
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
        config: { runtime: { tempRoot: root, corpusSegmentation: declaration, ...(workers ? { sourceInductionExecution: executionPolicy } : {}),
          corpora: { wikipedia: { ngramShardChars: 100_000, ngramMaxOrder: 2, ngramVocabularyLimit: 32 } } } } as any });
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
          provenance: { sourceFamilyId: workers ? sourceId : "wikimedia:wikipedia", sourceVersionId, byteRange: [0, byteLength], charRange: [0, codePointLength] },
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
      let committedExecutions: unknown;
      const result = await (ingestor as any).ingestLanguageShard(samples, "wikipedia://fixture/shard", "episode.fixture", inputManifest,
        async (trained: any) => { committedExecutions = trained.sourceInductionExecutions; order.push("checkpoint.commit"); transactionDepthAt.push(transactionDepth); });

      expect(result.promotedRelations).toBeGreaterThan(0);
      expect(result.graphHyperedges).toBeGreaterThan(0);
      expect(result.ngramModels).toBeGreaterThan(0);
      expect(result.languagePatterns).toBeGreaterThan(0);
      expect(persistedProfile).toBeDefined();
      expect(validatePooledLanguageProfileOwnership(persistedProfile!, hasher)?.parents).toEqual(samples.map(sample => String(sample.sourceVersionId)).sort());
      expect(order).toContain("graph.hyperedges");
      expect(order.indexOf("training.commit")).toBeGreaterThan(-1);
      expect(order.indexOf("training.commit")).toBeLessThan(order.findIndex(item => item.startsWith("graph.")));
      expect(order.indexOf("checkpoint.commit")).toBeGreaterThan(order.indexOf("graph.hyperedges"));
      expect(transactionDepthAt.every(depth => depth > 0)).toBe(true);
      expect(transactionDepth).toBe(0);
      if (workers) {
        expect(executionReceipts).toHaveLength(2);
        expect(result.sourceInductionExecutions).toEqual({ shardUri: "wikipedia://fixture/shard",
          prewarm: executionReceipts[0], training: executionReceipts[1] });
        expect(committedExecutions).toEqual(result.sourceInductionExecutions);
        for (const [index, phase] of ["prewarm", "training"].entries()) expect(trace.drain()).toContainEqual(expect.objectContaining({
          stage: `language.source-induction-execution.${phase}`, counters: { workersStarted: 1,
            preparedBatches: executionReceipts[index]!.preparedBatches, inducedBatches: executionReceipts[index]!.inducedBatches, peakNodeRssBytes: 123456 }
        }));
      } else expect(result.sourceInductionExecutions).toBeUndefined();
      if (global) { expect(active).toHaveBeenCalled(); expect(fit).not.toHaveBeenCalled(); expect(learn).not.toHaveBeenCalled(); }
      else expect(active).not.toHaveBeenCalled();
    } finally {
      vi.restoreAllMocks();
      await rm(root, { recursive: true, force: true });
    }
  });
});
