import type { Hasher } from "./types.js";
import { clamp01 } from "./primitives.js";
import { createSparseVector, createTypedSparseFeatureId, type SparseVector } from "./sparse-ranking.js";

export const RETRIEVAL_RANK_FEATURE_SCHEMA_V1 = "scce.retrieval_rank_features.v1";

/**
 * Canonical, versioned feature contract for FTRL retrieval reranking (Part
 * A finding 9). Every field must be computable from information available
 * *before* the outcome of the current turn -- never from the current
 * turn's own proof/certification result (that would be leakage: the model
 * would learn to reproduce its own admission decision rather than predict
 * genuine relevance). Changing the meaning of a field requires bumping this
 * schema id; a stored `FtrlProximalRankerState` is pinned to the schema id
 * it was trained under (`featureSchemaId`) and `createFtrlProximalRanker`
 * already refuses to restore a state under a mismatched schema.
 */
export interface RetrievalRankFeaturesV1 {
  schema: typeof RETRIEVAL_RANK_FEATURE_SCHEMA_V1;
  /** Fraction of query features also present on the candidate, in [0, 1]. */
  queryNodeOverlap: number;
  /** BM25 score for this candidate, normalized against the top score in the current candidate set, in [0, 1]. */
  bm25Normalized: number;
  /** Aggregate alpha-weighted evidence mass backing the candidate, in [0, 1]. */
  evidenceMass: number;
  /** Whether at least one evidence span directly anchors the candidate (not merely graph-adjacent). */
  directEvidence: 0 | 1;
  /** Aggregate contradiction pressure observed against the candidate, in [0, 1] (higher = more contradicted). */
  contradictionMass: number;
  /** Graph hop distance from the query anchor to the candidate, normalized so closer is smaller, in [0, 1]. */
  graphDistance: number;
  /** The candidate's own alpha (confidence/trust) value, in [0, 1]. */
  alpha: number;
  /** Aggregate source-trust signal for the candidate's backing evidence, in [0, 1]. */
  sourceTrust: number;
}

const FEATURE_FAMILY = "scce.retrieval-rank-feature.v1";
const FEATURE_NAMES: ReadonlyArray<Exclude<keyof RetrievalRankFeaturesV1, "schema">> = [
  "queryNodeOverlap",
  "bm25Normalized",
  "evidenceMass",
  "directEvidence",
  "contradictionMass",
  "graphDistance",
  "alpha",
  "sourceTrust"
];

export function retrievalRankFeaturesV1(input: {
  queryNodeOverlap: number;
  bm25Normalized: number;
  evidenceMass: number;
  directEvidence: boolean;
  contradictionMass: number;
  graphDistance: number;
  alpha: number;
  sourceTrust: number;
}): RetrievalRankFeaturesV1 {
  return {
    schema: RETRIEVAL_RANK_FEATURE_SCHEMA_V1,
    queryNodeOverlap: clamp01(input.queryNodeOverlap),
    bm25Normalized: clamp01(input.bm25Normalized),
    evidenceMass: clamp01(input.evidenceMass),
    directEvidence: input.directEvidence ? 1 : 0,
    contradictionMass: clamp01(input.contradictionMass),
    graphDistance: clamp01(input.graphDistance),
    alpha: clamp01(input.alpha),
    sourceTrust: clamp01(input.sourceTrust)
  };
}

/** Converts a typed feature record into the sparse vector shape FTRL scoring/updates require. */
export function retrievalRankFeatureVector(features: RetrievalRankFeaturesV1, hasher: Hasher): SparseVector {
  return createSparseVector(
    FEATURE_NAMES
      .map(name => ({ name, value: features[name] }))
      .filter(entry => entry.value !== 0)
      .map(entry => ({
        id: createTypedSparseFeatureId({ familyId: FEATURE_FAMILY, value: entry.name, hasher }),
        value: entry.value
      }))
  );
}
