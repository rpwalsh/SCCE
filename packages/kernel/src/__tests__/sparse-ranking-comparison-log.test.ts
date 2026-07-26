import { describe, expect, it } from "vitest";
import { evaluateFtrlHeldOut, type SparseRankingComparisonExample } from "../sparse-ranking-comparison-log.js";
import { createSparseVector, createTypedSparseFeatureId } from "../sparse-ranking.js";
import type { InformationLabel } from "../index.js";

describe("evaluateFtrlHeldOut (plan item 32)", () => {
  const featureX = createTypedSparseFeatureId({ familyId: "test", value: "x" });
  const featureY = createTypedSparseFeatureId({ familyId: "test", value: "y" });
  const good = createSparseVector([{ id: featureX, value: 1 }]);
  const bad = createSparseVector([{ id: featureY, value: 1 }]);

  function example(index: number): SparseRankingComparisonExample {
    return {
      id: `example:${index}`,
      taskClass: "test.task.v1",
      featureSchemaId: "test.schema.v1",
      recordedAt: index,
      candidates: [good, bad],
      preferredIndex: 0,
      weight: 1,
      source: "proof_certification",
      informationLabel: fixtureInformationLabel()
    };
  }

  it("returns undefined when there is not enough data on either side of the split", () => {
    // A single example with holdoutFraction 0.2: floor(1 * 0.8) = 0, so
    // the training side is empty -- there is nothing to train a model
    // on, and evaluating an untrained model would not be a real
    // measurement.
    expect(evaluateFtrlHeldOut({
      examples: [example(0)],
      modelId: "model:test",
      featureSchemaId: "test.schema.v1",
      holdoutFraction: 0.2
    })).toBeUndefined();
    expect(evaluateFtrlHeldOut({
      examples: [],
      modelId: "model:test",
      featureSchemaId: "test.schema.v1",
      holdoutFraction: 0.2
    })).toBeUndefined();
  });

  it("throws for an out-of-range holdout fraction rather than silently clamping it", () => {
    expect(() => evaluateFtrlHeldOut({
      examples: [example(0)],
      modelId: "model:test",
      featureSchemaId: "test.schema.v1",
      holdoutFraction: 0
    })).toThrow();
    expect(() => evaluateFtrlHeldOut({
      examples: [example(0)],
      modelId: "model:test",
      featureSchemaId: "test.schema.v1",
      holdoutFraction: 1
    })).toThrow();
  });

  it("learns a perfectly separable preference from training examples and scores it correctly on held-out examples", () => {
    // 40 identical (up to recordedAt) examples: the "good" candidate
    // (feature X) is always preferred over "bad" (feature Y). Two
    // orthogonal features with a consistent preference direction is a
    // hand-verifiable case: after enough training pairs, X's learned
    // weight must be positive and Y's must be non-positive, so every
    // held-out example's good candidate must outscore its bad one.
    const examples = Array.from({ length: 40 }, (_, index) => example(index));
    const evaluation = evaluateFtrlHeldOut({
      examples,
      modelId: "model:test",
      featureSchemaId: "test.schema.v1",
      holdoutFraction: 0.25,
      kValues: [1, 2]
    });
    expect(evaluation).toBeDefined();
    expect(evaluation!.trainingExampleCount).toBe(30);
    expect(evaluation!.heldOutExampleCount).toBe(10);
    expect(evaluation!.recallAtK[1]).toBe(1);
    expect(evaluation!.recallAtK[2]).toBe(1);
    expect(evaluation!.ndcgAtK[1]).toBe(1);
    expect(evaluation!.pairwiseAccuracy).toBe(1);
  });

  it("gives zero credit under strict pairwise comparison when there is no learnable signal", () => {
    // Two IDENTICAL candidates: updatePair's preferred/rejected
    // difference is the zero vector, so training never moves any
    // weight and every candidate scores exactly 0 forever.
    // pairwiseAccuracy uses a strict ">" comparison, so a genuine tie
    // never counts as correct -- it must be exactly 0, not a faked
    // "chance" 0.5. (recallAtK/ndcgAtK, which rank via a stable sort,
    // would instead reflect the sort's index tie-break; this test only
    // asserts the strict pairwise metric, which has no such artifact.)
    const examples: SparseRankingComparisonExample[] = Array.from({ length: 40 }, (_, index) => ({
      id: `tied:${index}`,
      taskClass: "test.task.v1",
      featureSchemaId: "test.schema.v1",
      recordedAt: index,
      candidates: [good, good],
      preferredIndex: index % 2,
      weight: 1,
      source: "proof_certification",
      informationLabel: fixtureInformationLabel()
    }));
    const evaluation = evaluateFtrlHeldOut({
      examples,
      modelId: "model:test",
      featureSchemaId: "test.schema.v1",
      holdoutFraction: 0.25
    });
    expect(evaluation).toBeDefined();
    expect(evaluation!.pairwiseAccuracy).toBe(0);
  });
});

function fixtureInformationLabel(): InformationLabel {
  return {
    exportClass: "public",
    tenantId: "fixture-tenant",
    principals: [],
    compartments: [],
    mergePolicy: "isolated"
  } as InformationLabel;
}
