import { clamp01 } from "./primitives.js";
import {
  RETRIEVAL_RANK_FEATURE_SCHEMA_V1,
  retrievalRankFeatureVector,
  retrievalRankFeaturesV1,
  type RetrievalRankFeaturesV1
} from "./retrieval-rank-features.js";
import { createFtrlProximalRanker } from "./sparse-ranking.js";
import type { SparseRankingCheckpoint, SparseRankingModelStore } from "./sparse-ranking-lifecycle.js";
import type { EvidenceSpan, GraphNode, Hasher } from "./types.js";

/** Task class this shadow ranker reranks within (Part A finding 9, stage 2). No other retrieval task shares its active model. */
export const FTRL_GRAPH_NODE_RANK_TASK_CLASS = "graph.node_rank.v1";

const SHADOW_CANDIDATE_LIMIT = 24;

export interface FtrlShadowCandidate {
  nodeId: string;
  bm25Score: number;
  node: GraphNode;
  evidence: readonly EvidenceSpan[];
}

export interface FtrlShadowRankedEntry {
  nodeId: string;
  bm25Rank: number;
  ftrlScore: number;
  ftrlRank: number;
}

export interface FtrlShadowRanking {
  modelId: string;
  candidates: number;
  ranked: FtrlShadowRankedEntry[];
  /** Fraction of the top-min(5,n) BM25 candidates that also appear in the top-min(5,n) FTRL candidates. 1 = full agreement, 0 = full disagreement. Never fed back into production selection -- shadow-only. */
  topAgreement: number;
}

/**
 * Builds the canonical retrieval-rank feature record for one candidate from
 * only signals already resolved during this turn's own retrieval (BM25
 * score, node alpha/evidence, evidence trust) -- never from the current
 * turn's proof/certification outcome (that would be label leakage: see
 * retrieval-rank-features.ts). `graphDistance` and `contradictionMass` are
 * real 0 values here, not fabricated placeholders: this candidate set is the
 * flat BM25-ranked seed frontier, before hop expansion or a contradiction
 * pass has run against it.
 */
export function buildShadowRetrievalFeatures(input: {
  bm25Score: number;
  topBm25Score: number;
  queryFeatures: readonly string[];
  node: GraphNode;
  evidence: readonly EvidenceSpan[];
}): RetrievalRankFeaturesV1 {
  const nodeFeatures = new Set(input.node.features);
  const overlap = input.queryFeatures.length
    ? input.queryFeatures.filter(feature => nodeFeatures.has(feature)).length / input.queryFeatures.length
    : 0;
  const trustValues = input.evidence
    .map(span => trustScalar(span.trustVector))
    .filter((value): value is number => value !== undefined);
  const sourceTrust = trustValues.length ? trustValues.reduce((sum, value) => sum + value, 0) / trustValues.length : 0;
  return retrievalRankFeaturesV1({
    queryNodeOverlap: overlap,
    bm25Normalized: input.topBm25Score > 0 ? input.bm25Score / input.topBm25Score : 0,
    evidenceMass: input.node.alpha,
    directEvidence: input.node.evidenceIds.length > 0,
    contradictionMass: 0,
    graphDistance: 0,
    alpha: input.node.alpha,
    sourceTrust
  });
}

function trustScalar(trustVector: EvidenceSpan["trustVector"]): number | undefined {
  if (!trustVector || typeof trustVector !== "object" || Array.isArray(trustVector)) return undefined;
  const value = (trustVector as Record<string, unknown>).trust;
  return typeof value === "number" && Number.isFinite(value) ? clamp01(value) : undefined;
}

/**
 * Shadow-mode FTRL rerank of a bounded BM25 candidate set (Part A finding 9,
 * stage 2). Computes an FTRL ranking alongside BM25 for comparison and
 * eventual held-out evaluation -- it never changes which candidates the
 * caller actually uses. Returns undefined when no active checkpoint exists
 * for this task/feature-schema pair: shadow ranking is simply not computed,
 * never approximated or fabricated.
 */
export async function computeFtrlShadowRanking(input: {
  store: SparseRankingModelStore | undefined;
  hasher: Hasher;
  queryFeatures: readonly string[];
  candidates: readonly FtrlShadowCandidate[];
}): Promise<FtrlShadowRanking | undefined> {
  if (!input.store || !input.candidates.length) return undefined;
  const checkpoint = await input.store.readActive(FTRL_GRAPH_NODE_RANK_TASK_CLASS, RETRIEVAL_RANK_FEATURE_SCHEMA_V1);
  if (!checkpoint) return undefined;
  return rankWithCheckpoint(checkpoint, input.hasher, input.queryFeatures, input.candidates);
}

function rankWithCheckpoint(
  checkpoint: SparseRankingCheckpoint,
  hasher: Hasher,
  queryFeatures: readonly string[],
  candidates: readonly FtrlShadowCandidate[]
): FtrlShadowRanking {
  const ranker = createFtrlProximalRanker({
    modelId: checkpoint.modelId,
    featureSchemaId: checkpoint.featureSchemaId,
    state: checkpoint.state
  });
  const bounded = candidates.slice(0, SHADOW_CANDIDATE_LIMIT);
  const topBm25Score = bounded.reduce((max, candidate) => Math.max(max, candidate.bm25Score), 0);
  const scored = bounded.map((candidate, bm25Rank) => {
    const features = buildShadowRetrievalFeatures({
      bm25Score: candidate.bm25Score,
      topBm25Score,
      queryFeatures,
      node: candidate.node,
      evidence: candidate.evidence
    });
    const vector = retrievalRankFeatureVector(features, hasher);
    return { nodeId: candidate.nodeId, bm25Rank, ftrlScore: ranker.score(vector).rawScore };
  });
  const ranked = [...scored]
    .sort((left, right) => right.ftrlScore - left.ftrlScore || left.bm25Rank - right.bm25Rank)
    .map((entry, ftrlRank) => ({ ...entry, ftrlRank }));
  const rankedByNodeId = new Map(ranked.map(entry => [entry.nodeId, entry]));
  const topK = Math.min(5, ranked.length);
  const bm25Top = new Set(bounded.slice(0, topK).map(candidate => candidate.nodeId));
  const ftrlTop = new Set(ranked.slice(0, topK).map(entry => entry.nodeId));
  const agreementCount = [...bm25Top].filter(nodeId => ftrlTop.has(nodeId)).length;
  return {
    modelId: checkpoint.modelId,
    candidates: bounded.length,
    ranked: bounded.map((candidate, bm25Rank) => {
      const entry = rankedByNodeId.get(candidate.nodeId);
      return { nodeId: candidate.nodeId, bm25Rank, ftrlScore: entry?.ftrlScore ?? 0, ftrlRank: entry?.ftrlRank ?? bm25Rank };
    }),
    topAgreement: topK > 0 ? agreementCount / topK : 0
  };
}
