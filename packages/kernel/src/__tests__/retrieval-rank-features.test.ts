import { describe, expect, it } from "vitest";
import { RETRIEVAL_RANK_FEATURE_SCHEMA_V1, retrievalRankFeatureVector, retrievalRankFeaturesV1 } from "../retrieval-rank-features.js";
import { createFtrlProximalRanker } from "../sparse-ranking.js";
import { createClock, createHasher } from "../primitives.js";

describe("retrieval rank feature contract v1", () => {
  it("clamps every field into [0, 1] and stamps the schema tag", () => {
    const features = retrievalRankFeaturesV1({
      queryNodeOverlap: 1.4,
      bm25Normalized: -0.2,
      evidenceMass: 0.5,
      directEvidence: true,
      contradictionMass: 2,
      graphDistance: 0.3,
      alpha: 0.9,
      sourceTrust: 0.6
    });

    expect(features).toMatchObject({
      schema: RETRIEVAL_RANK_FEATURE_SCHEMA_V1,
      queryNodeOverlap: 1,
      bm25Normalized: 0,
      contradictionMass: 1,
      directEvidence: 1
    });
  });

  it("produces a sparse vector an FTRL ranker can score and learn from under this schema id", () => {
    const hasher = createHasher();
    const ranker = createFtrlProximalRanker({
      modelId: "model.fixture",
      featureSchemaId: RETRIEVAL_RANK_FEATURE_SCHEMA_V1,
      clock: createClock({ fixedTime: 1_000, stepMs: 1 })
    });

    const strong = retrievalRankFeatureVector(retrievalRankFeaturesV1({
      queryNodeOverlap: 0.9,
      bm25Normalized: 0.9,
      evidenceMass: 0.8,
      directEvidence: true,
      contradictionMass: 0,
      graphDistance: 0.1,
      alpha: 0.9,
      sourceTrust: 0.9
    }), hasher);
    const weak = retrievalRankFeatureVector(retrievalRankFeaturesV1({
      queryNodeOverlap: 0.1,
      bm25Normalized: 0.1,
      evidenceMass: 0.1,
      directEvidence: false,
      contradictionMass: 0.8,
      graphDistance: 0.9,
      alpha: 0.1,
      sourceTrust: 0.1
    }), hasher);

    const before = ranker.score(strong).rawScore;
    for (let i = 0; i < 25; i += 1) ranker.updatePair({ preferred: strong, rejected: weak });
    const after = ranker.score(strong).rawScore;

    expect(after).toBeGreaterThan(before);
    expect(ranker.score(strong).rawScore).toBeGreaterThan(ranker.score(weak).rawScore);
  });

  it("omits zero-valued features from the sparse vector rather than storing explicit zeros", () => {
    const hasher = createHasher();
    const vector = retrievalRankFeatureVector(retrievalRankFeaturesV1({
      queryNodeOverlap: 0,
      bm25Normalized: 0,
      evidenceMass: 0,
      directEvidence: false,
      contradictionMass: 0,
      graphDistance: 0,
      alpha: 0.5,
      sourceTrust: 0
    }), hasher);

    expect(vector.entries).toHaveLength(1);
  });
});
