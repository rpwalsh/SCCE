import { describe, expect, it } from "vitest";
import { createLatentConceptLearner, createWeightedFeatureSketchLearner, featureSketchProjection, featureSketchSupportShare } from "../latent.js";
import { createHasher } from "../primitives.js";
import type { GraphNode, LatentConcept } from "../types.js";

describe("weighted feature sketch learner", () => {
  it("labels weighted feature support and hash projection without claiming explained variance", () => {
    const learner = createWeightedFeatureSketchLearner({ hasher: createHasher() });
    const sketches = learner.learn([
      node("a", 1, ["shared", "left", "left"]),
      node("b", 0.5, ["shared", "right"])
    ], 4);

    expect(sketches.map(sketch => sketch.features[0])).toEqual(["shared", "left", "right"]);
    expect(sketches[0]?.method).toBe("weighted_feature_frequency_hash_projection.v1");
    expect(sketches[0]?.supportShare).toBeCloseTo(0.5, 12);
    expect(sketches[1]?.supportShare).toBeCloseTo(1 / 3, 12);
    expect(sketches[2]?.supportShare).toBeCloseTo(1 / 6, 12);
    expect(sketches.reduce((sum, sketch) => sum + sketch.supportShare, 0)).toBeCloseTo(1, 12);
    expect(sketches[0]?.varianceShare).toBe(sketches[0]?.supportShare);
    expect(sketches[0]?.basis).toEqual(sketches[0]?.projection);
    expect(sketches[0]?.projectionVariance).toBeGreaterThanOrEqual(0);
  });

  it("keeps the historical factory and persisted shape as explicit compatibility paths", () => {
    const oldFactory = createLatentConceptLearner({ hasher: createHasher() });
    expect(oldFactory.learn([node("a", 1, ["x"])], 1)[0]?.method).toBe("weighted_feature_frequency_hash_projection.v1");

    const persisted: LatentConcept = { id: "old", features: ["x"], basis: [0.25], varianceShare: 0.4 };
    expect(featureSketchSupportShare(persisted)).toBe(0);
    expect(featureSketchProjection(persisted)).toEqual([0.25]);
  });
});

function node(id: string, alpha: number, features: string[]): GraphNode {
  return {
    id: id as never,
    typeId: "type:test" as never,
    representation: id,
    alpha,
    evidenceIds: [],
    features,
    createdAt: 1,
    updatedAt: 1,
    metadata: {}
  };
}
