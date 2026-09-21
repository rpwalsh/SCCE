// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
import { describe, expect, it, vi } from "vitest";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { canonicalTemporalCoordinates } from "@scce/kernel";
import { createWikipediaInputManifest } from "../wikipedia-input-manifest.js";
import { createWikipediaV3Ingestor } from "../wikipedia-v3-ingestor.js";
import * as corpusTrainer from "../language-corpus-trainer.js";

describe("Wikipedia alignment target guard", () => {
  it("skips sparse alignment when a single source family has no promoted hyperedges", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "scce-wiki-alignment-guard-"));
    const tracePath = path.join(root, "ingest-trace.ndjson");
    const dumpPath = path.join(root, "dump.bz2");
    const indexPath = path.join(root, "index.txt");
    const previousTrace = process.env.SCCE_INGEST_TRACE;
    await writeFile(dumpPath, "fixture-dump");
    await writeFile(indexPath, "0:1:Fixture\n");
    try {
      const inputManifest = await createWikipediaInputManifest({
        dumpPath,
        indexPath,
        cacheDir: path.join(root, "cache"),
        normalizationIdentity: "fixture-normalizer",
        compilerIdentity: "fixture-compiler",
        semanticConfig: { purpose: "alignment-guard-test" }
      });
      const graphCalls: string[] = [];
      const storage = {
        transaction: async (fn: () => Promise<unknown>) => fn(),
        events: {
          append: vi.fn(async () => {}),
          readRange: vi.fn(async () => [])
        },
        relationObservations: {
          sourceFamilyCountsForSeeds: vi.fn(async () => new Map()),
          list: vi.fn(async () => []),
          put: vi.fn(async () => {})
        },
        graph: {
          upsertNodes: vi.fn(async () => { graphCalls.push("nodes"); }),
          upsertEdges: vi.fn(async () => { graphCalls.push("edges"); }),
          upsertHyperedges: vi.fn(async () => { graphCalls.push("hyperedges"); })
        },
        languageMemory: { putLanguagePatterns: vi.fn(async () => {}) }
      } as any;
      const ingestor = createWikipediaV3Ingestor({
        storage,
        config: { runtime: { tempRoot: root, corpora: { wikipedia: { ngramShardChars: 100_000 } } } } as any
      });
      const candidate = {
        schema: "scce.semantic_candidate.v2",
        id: "candidate.fixture",
        kind: "link",
        channel: "source_declared_structured",
        relationSeedId: "relation_seed.fixture",
        sourceId: "source.fixture",
        sourceVersionId: "source_version.fixture",
        participants: [
          { portId: "subject", value: "subject.fixture", valueKind: "anchor_surface", realization: "observed" },
          { portId: "object", value: "object.fixture", valueKind: "target_ref", realization: "observed" }
        ],
        qualifiers: {},
        evidenceIds: ["evidence.fixture"],
        temporalCoordinates: canonicalTemporalCoordinates({ observedTime: 1 }),
        support: 1,
        provenance: {
          exactEvidenceIds: ["evidence.fixture"],
          extractionChannel: "source_declared_structured",
          anchors: [],
          assumptions: [],
          transformations: [],
          alternativeInterpretations: [],
          sourceIndependence: { independentSourceCount: 1, dependencyGroupIds: ["wikimedia:wikipedia"], estimate: 1 },
          producer: { modelId: "fixture", snapshotId: "fixture" },
          admissionState: "proposed",
          normalizationContractId: "fixture",
          participantIdentityIds: []
        }
      } as any;
      vi.spyOn(corpusTrainer, "prepareLanguageCorpusTraining").mockResolvedValue({
        inputBinding: "fixture",
        graphSnapshotDigest: "fixture"
      } as any);
      vi.spyOn(corpusTrainer, "commitLanguageCorpusTraining").mockResolvedValue({
        languageProfiles: 1,
        ngramObservations: 0,
        ngramModels: 1,
        languageUnits: 0,
        languagePatterns: 0,
        semanticFrames: 0,
        warnings: []
      } as any);
      process.env.SCCE_INGEST_TRACE = tracePath;
      const evidence = {
        id: "evidence.fixture",
        sourceId: "source.fixture",
        sourceVersionId: "page.version",
        chunkId: "chunk.fixture",
        contentHash: "sha256:fixture",
        mediaType: "text/plain",
        byteStart: 0,
        byteEnd: Buffer.byteLength("A small fixture page."),
        charStart: 0,
        charEnd: "A small fixture page.".length,
        text: "A small fixture page.",
        textPreview: "A small fixture page.",
        languageHints: {},
        scriptHints: {},
        trustVector: {},
        provenance: {},
        features: [],
        status: "promoted",
        alpha: 0.9,
        observedAt: 1
      } as any;
      const result = await (ingestor as any).ingestLanguageShard([{
        sourceVersionId: "page.version",
        title: "Fixture",
        text: "A small fixture page.",
        evidence: [evidence],
        languageAliases: [],
        semanticCandidates: [candidate],
        createdAt: 1
      }], "wikipedia://fixture/shard", "episode.fixture", inputManifest, async () => {});

      expect(result.relationCandidates).toBe(1);
      expect(result.promotedRelations).toBe(0);
      expect(result.graphHyperedges).toBe(0);
      expect(graphCalls).toEqual([]);
      expect(storage.events.readRange).not.toHaveBeenCalled();
      expect(storage.events.append.mock.calls.flat().some((event: any) =>
        event?.typeId === "SparseAlignmentCandidatesCompiled" || event?.type === "SparseAlignmentCandidatesCompiled"
      )).toBe(false);
      expect((await readFile(tracePath, "utf8"))).toContain("relation.alignment.skip.no-promoted-hyperedges");
    } finally {
      vi.restoreAllMocks();
      if (previousTrace === undefined) delete process.env.SCCE_INGEST_TRACE;
      else process.env.SCCE_INGEST_TRACE = previousTrace;
      await rm(root, { recursive: true, force: true });
    }
  });
});
