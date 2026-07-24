import { describe, expect, it } from "vitest";
import { createClock, createHasher } from "../primitives.js";
import {
  createBm25SparseIndex,
  createFtrlProximalRanker,
  createSparseVector,
  createTypedSparseFeatureId,
  restoreBm25SparseIndex,
  restoreFtrlProximalRanker,
  type SparseFeatureId
} from "../sparse-ranking.js";

describe("typed sparse ranking", () => {
  it("creates opaque source-neutral feature IDs and canonical sparse vectors", () => {
    const hasher = createHasher();
    const first = feature("family.01", "source-derived-value", hasher);
    const replay = feature("family.01", "source-derived-value", hasher);
    const otherFamily = feature("family.02", "source-derived-value", hasher);
    const vector = createSparseVector([
      { id: otherFamily, value: 2 },
      { id: first, value: 1 },
      { id: first, value: 3 }
    ]);

    expect(first).toBe(replay);
    expect(first).not.toBe(otherFamily);
    expect(first).not.toContain("source-derived-value");
    expect(vector.entries).toEqual([
      { id: first, value: 4 },
      { id: otherFamily, value: 2 }
    ].sort((left, right) => left.id.localeCompare(right.id)));
    expect(vector.l1Norm).toBe(6);
    expect(vector.squaredL2Norm).toBe(20);
  });

  it("uses BM25 document frequency and replays the serialized sparse index", () => {
    const hasher = createHasher();
    const common = feature("family.01", "value.01", hasher);
    const rare = feature("family.01", "value.02", hasher);
    const index = createBm25SparseIndex([
      document("node.01", [common, rare]),
      document("node.02", [common]),
      document("node.03", [common])
    ]);
    const query = createSparseVector([
      { id: common, value: 1 },
      { id: rare, value: 1 }
    ]);

    const ranked = index.rank(query);
    const rareTerm = ranked[0]?.terms.find(term => term.featureId === rare);
    const commonTerm = ranked[0]?.terms.find(term => term.featureId === common);

    expect(ranked.map(row => row.documentId)).toEqual(["node.01", "node.02", "node.03"]);
    expect(rareTerm?.documentFrequency).toBe(1);
    expect(commonTerm?.documentFrequency).toBe(3);
    expect(rareTerm!.inverseDocumentFrequency).toBeGreaterThan(commonTerm!.inverseDocumentFrequency);

    const serialized = index.serialize();
    const replay = restoreBm25SparseIndex(serialized);
    expect(replay.serialize()).toBe(serialized);
    expect(replay.rank(query)).toEqual(ranked);
  });

  it("learns pairwise preference online with FTRL-Proximal and marks probability uncalibrated", () => {
    const hasher = createHasher();
    const preferredSignal = feature("rank.schema.01", "signal.01", hasher);
    const rejectedSignal = feature("rank.schema.01", "signal.02", hasher);
    const preferred = createSparseVector([{ id: preferredSignal, value: 1 }]);
    const rejected = createSparseVector([{ id: rejectedSignal, value: 1 }]);
    const ranker = createFtrlProximalRanker({
      modelId: "ranker.01",
      featureSchemaId: "rank.schema.01",
      clock: createClock({ fixedTime: 1_000, stepMs: 5 }),
      hyperparameters: { alpha: 0.5, beta: 1, l1: 0, l2: 0.1 }
    });

    for (let index = 0; index < 24; index += 1) {
      ranker.updatePair({ preferred, rejected });
    }

    expect(ranker.score(preferred).rawScore).toBeGreaterThan(ranker.score(rejected).rawScore);
    expect(ranker.score(preferred).reliability).toBe("uncalibrated");
    expect(ranker.snapshot().examplesSeen).toBe(24);
    expect(ranker.snapshot().updatedAt).toBe(1_120);
  });

  it("serializes FTRL state canonically and replays updates under the same clock", () => {
    const first = trainReplayRanker();
    const second = trainReplayRanker();
    const firstSerialized = first.serialize();
    const secondSerialized = second.serialize();

    expect(secondSerialized).toBe(firstSerialized);

    const restored = restoreFtrlProximalRanker(firstSerialized, {
      modelId: "ranker.replay",
      featureSchemaId: "rank.schema.replay",
      clock: createClock({ fixedTime: 4_000, stepMs: 10 })
    });
    expect(restored.serialize()).toBe(firstSerialized);
    expect(restored.snapshot()).toEqual(first.snapshot());
  });
});

function document(id: string, features: SparseFeatureId[]) {
  return {
    id,
    features: createSparseVector(features.map(featureId => ({ id: featureId, value: 1 })))
  };
}

function feature(familyId: string, value: string, hasher = createHasher()): SparseFeatureId {
  return createTypedSparseFeatureId({ familyId, value, hasher });
}

function trainReplayRanker() {
  const hasher = createHasher();
  const positive = createSparseVector([
    { id: feature("rank.schema.replay", "signal.01", hasher), value: 0.75 },
    { id: feature("rank.schema.replay", "signal.02", hasher), value: 1 }
  ]);
  const negative = createSparseVector([
    { id: feature("rank.schema.replay", "signal.03", hasher), value: 1 }
  ]);
  const ranker = createFtrlProximalRanker({
    modelId: "ranker.replay",
    featureSchemaId: "rank.schema.replay",
    clock: createClock({ fixedTime: 2_000, stepMs: 10 }),
    hyperparameters: { alpha: 0.25, beta: 1, l1: 0.01, l2: 0.5 }
  });
  ranker.updatePair({ preferred: positive, rejected: negative });
  ranker.update({ features: positive, label: 1, weight: 0.5 });
  return ranker;
}
