import { describe, expect, it } from "vitest";
import { createHasher } from "../primitives.js";
import { RETRIEVAL_RANK_FEATURE_SCHEMA_V1, retrievalRankFeatureVector } from "../retrieval-rank-features.js";
import { createFtrlProximalRanker } from "../sparse-ranking.js";
import { FTRL_GRAPH_NODE_RANK_TASK_CLASS, buildShadowRetrievalFeatures, computeFtrlShadowRanking, type FtrlShadowCandidate } from "../sparse-ranking-shadow.js";
import type { SparseRankingCheckpoint, SparseRankingModelStore } from "../sparse-ranking-lifecycle.js";
import type { EvidenceSpan, GraphNode } from "../types.js";

describe("FTRL shadow retrieval ranking", () => {
  it("builds real, bounded features from BM25 score, node signals and evidence trust -- never fabricated when absent", () => {
    const node = graphNode("node.a", { alpha: 0.8, features: ["f1", "f2"], evidenceIds: ["evidence.a"] });
    const features = buildShadowRetrievalFeatures({
      bm25Score: 3,
      topBm25Score: 6,
      queryFeatures: ["f1", "f3"],
      node,
      evidence: [evidenceSpan("evidence.a", 0.7)]
    });
    expect(features.schema).toBe(RETRIEVAL_RANK_FEATURE_SCHEMA_V1);
    expect(features.bm25Normalized).toBeCloseTo(0.5);
    expect(features.queryNodeOverlap).toBeCloseTo(0.5);
    expect(features.alpha).toBeCloseTo(0.8);
    expect(features.evidenceMass).toBeCloseTo(0.8);
    expect(features.directEvidence).toBe(1);
    expect(features.sourceTrust).toBeCloseTo(0.7);
    // Not yet computed at the flat BM25 seed-frontier stage -- real 0, not a guess.
    expect(features.contradictionMass).toBe(0);
    expect(features.graphDistance).toBe(0);
  });

  it("reports zero source trust and no direct evidence when a node carries neither, rather than defaulting to a nonzero guess", () => {
    const node = graphNode("node.b", { alpha: 0.4, features: [], evidenceIds: [] });
    const features = buildShadowRetrievalFeatures({ bm25Score: 1, topBm25Score: 1, queryFeatures: [], node, evidence: [] });
    expect(features.sourceTrust).toBe(0);
    expect(features.directEvidence).toBe(0);
    expect(features.queryNodeOverlap).toBe(0);
  });

  it("computes no shadow ranking when no store is configured", async () => {
    const result = await computeFtrlShadowRanking({
      store: undefined,
      hasher: createHasher(),
      queryFeatures: ["f1"],
      candidates: [candidate("node.a", 3)]
    });
    expect(result).toBeUndefined();
  });

  it("computes no shadow ranking when the store has no active checkpoint for this task/schema", async () => {
    const store = fakeStore(undefined);
    const result = await computeFtrlShadowRanking({
      store,
      hasher: createHasher(),
      queryFeatures: ["f1"],
      candidates: [candidate("node.a", 3)]
    });
    expect(result).toBeUndefined();
    expect(store.requestedTaskClass).toBe(FTRL_GRAPH_NODE_RANK_TASK_CLASS);
    expect(store.requestedFeatureSchemaId).toBe(RETRIEVAL_RANK_FEATURE_SCHEMA_V1);
  });

  it("ranks candidates by real FTRL score against an active checkpoint and reports top-K agreement with BM25, without reordering the caller's BM25 list", async () => {
    const hasher = createHasher();
    const trainer = createFtrlProximalRanker({ modelId: "model.shadow", featureSchemaId: RETRIEVAL_RANK_FEATURE_SCHEMA_V1 });
    // Train a real preference: high-alpha, directly-evidenced candidates should outrank low-alpha, unevidenced ones.
    const strong = graphNode("node.strong", { alpha: 0.95, features: ["f1"], evidenceIds: ["evidence.strong"] });
    const weak = graphNode("node.weak", { alpha: 0.05, features: [], evidenceIds: [] });
    const strongVector = shadowVector(hasher, strong, [evidenceSpan("evidence.strong", 0.9)], 1, 1, ["f1"]);
    const weakVector = shadowVector(hasher, weak, [], 1, 1, ["f1"]);
    for (let i = 0; i < 25; i++) trainer.updatePair({ preferred: strongVector, rejected: weakVector });
    const checkpoint = checkpointFrom(trainer.snapshot());
    const store = fakeStore(checkpoint);

    const bm25Candidates: FtrlShadowCandidate[] = [
      candidateFromNode(weak, 5, [evidenceSpan("evidence.weak", 0)]),
      candidateFromNode(strong, 2, [evidenceSpan("evidence.strong", 0.9)])
    ];
    const shadow = await computeFtrlShadowRanking({ store, hasher, queryFeatures: ["f1"], candidates: bm25Candidates });

    expect(shadow).toBeDefined();
    expect(shadow!.modelId).toBe("model.shadow");
    expect(shadow!.candidates).toBe(2);
    // BM25 order preserved exactly (bm25Rank matches input order) -- shadow never reorders the caller's list.
    expect(shadow!.ranked.map(entry => entry.nodeId)).toEqual(["node.weak", "node.strong"]);
    expect(shadow!.ranked.map(entry => entry.bm25Rank)).toEqual([0, 1]);
    const strongEntry = shadow!.ranked.find(entry => entry.nodeId === "node.strong")!;
    const weakEntry = shadow!.ranked.find(entry => entry.nodeId === "node.weak")!;
    expect(strongEntry.ftrlScore).toBeGreaterThan(weakEntry.ftrlScore);
    expect(strongEntry.ftrlRank).toBeLessThan(weakEntry.ftrlRank);
    // With only 2 candidates the top-2 sets are identical regardless of order,
    // so topAgreement is trivially 1 here -- the reordering itself (asserted
    // above via ftrlRank) is what proves the shadow ranking diverged from BM25.
    expect(shadow!.topAgreement).toBe(1);
  });
});

function candidate(nodeId: string, bm25Score: number): FtrlShadowCandidate {
  return candidateFromNode(graphNode(nodeId, { alpha: 0.5, features: [], evidenceIds: [] }), bm25Score, []);
}

function candidateFromNode(node: GraphNode, bm25Score: number, evidence: readonly EvidenceSpan[]): FtrlShadowCandidate {
  return { nodeId: String(node.id), bm25Score, node, evidence };
}

function shadowVector(hasher: ReturnType<typeof createHasher>, node: GraphNode, evidence: readonly EvidenceSpan[], bm25Score: number, topBm25Score: number, queryFeatures: readonly string[]) {
  return retrievalRankFeatureVector(
    buildShadowRetrievalFeatures({ bm25Score, topBm25Score, queryFeatures, node, evidence }),
    hasher
  );
}

function checkpointFrom(state: ReturnType<ReturnType<typeof createFtrlProximalRanker>["snapshot"]>): SparseRankingCheckpoint {
  return {
    modelId: state.modelId,
    taskClass: FTRL_GRAPH_NODE_RANK_TASK_CLASS,
    featureSchemaId: state.featureSchemaId,
    lifecycle: "active",
    state,
    trainingWindow: { firstExampleAt: 0, lastExampleAt: 1 },
    examplesSeen: state.examplesSeen,
    createdAt: 1,
    informationLabel: {
      exportClass: "public",
      tenantId: "fixture-tenant",
      principals: [],
      compartments: [],
      mergePolicy: "isolated"
    } as SparseRankingCheckpoint["informationLabel"]
  };
}

function fakeStore(checkpoint: SparseRankingCheckpoint | undefined): SparseRankingModelStore & { requestedTaskClass?: string; requestedFeatureSchemaId?: string } {
  const store = {
    requestedTaskClass: undefined as string | undefined,
    requestedFeatureSchemaId: undefined as string | undefined,
    async readActive(taskClass: string, featureSchemaId: string) {
      store.requestedTaskClass = taskClass;
      store.requestedFeatureSchemaId = featureSchemaId;
      return checkpoint;
    },
    async putCheckpoint() {},
    async activate() {},
    async rollback() {}
  };
  return store;
}

function graphNode(id: string, input: { alpha: number; features: string[]; evidenceIds: string[] }): GraphNode {
  return {
    id: id as GraphNode["id"],
    typeId: "type.test" as GraphNode["typeId"],
    representation: {},
    alpha: input.alpha,
    evidenceIds: input.evidenceIds as GraphNode["evidenceIds"],
    features: input.features,
    createdAt: 1,
    updatedAt: 1,
    metadata: {}
  };
}

function evidenceSpan(id: string, trust: number): EvidenceSpan {
  return {
    id: id as EvidenceSpan["id"],
    sourceId: `source.${id}` as EvidenceSpan["sourceId"],
    sourceVersionId: `source-version.${id}` as EvidenceSpan["sourceVersionId"],
    chunkId: `chunk.${id}` as EvidenceSpan["chunkId"],
    contentHash: `hash.${id}` as EvidenceSpan["contentHash"],
    mediaType: "text/plain",
    byteStart: 0,
    byteEnd: 0,
    charStart: 0,
    charEnd: 0,
    text: "",
    textPreview: "",
    languageHints: {},
    scriptHints: {},
    trustVector: { trust },
    provenance: {},
    features: [],
    status: "promoted",
    alpha: 0.5,
    observedAt: 1
  };
}
