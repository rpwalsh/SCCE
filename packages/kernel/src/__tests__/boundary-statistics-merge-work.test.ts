// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
import { describe, expect, it, vi } from "vitest";
import { compileBoundaryStatistics, mergeBoundaryStatistics, type BoundaryFeatureVector, type BoundaryObservation } from "../boundary-estimator.js";

describe("exact boundary statistics merge work", () => {
  it("reads source lists once and preserves anchored and latent masses, audit, and identity", () => {
    const populationId = "population.merge-work";
    const featureOrder = compileBoundaryStatistics({ populationId, observations: [] }).featureOrder;
    const features = Object.fromEntries(featureOrder.map((feature, index) => [feature, index % 2])) as unknown as BoundaryFeatureVector;
    const observation = (sourceDocumentId: string, latent: boolean, positiveMass: number, negativeMass: number): BoundaryObservation => ({
      sourceDocumentId, features, positiveMass, negativeMass, supervision: latent ? "latent_marginal" : "independent_anchor",
      signalKind: latent ? "packed_forest_marginal" : "external_anchor", signalId: `${sourceDocumentId}.${latent}`
    });
    const shards = [
      compileBoundaryStatistics({ populationId, sourceDocumentIds: ["doc.a"], observations: [observation("doc.a", false, 2, 3), observation("doc.a", true, 1, 4)] }),
      compileBoundaryStatistics({ populationId, sourceDocumentIds: ["doc.b"], observations: [observation("doc.b", false, 5, 7), observation("doc.b", true, 3, 8)] })
    ];
    const unchanged = structuredClone(shards);
    const key = shards[0]!.rows[0]!.key;
    const expected = compileBoundaryStatistics({ populationId: "population.target", sourceDocumentIds: ["doc.a", "doc.b"], observations: [
      { ...observation("doc.a", false, 7, 10), signalId: `merged.anchor.${key}` },
      { ...observation("doc.a", true, 4, 12), signalId: `merged.latent.${key}` }
    ] });
    const sourceLists = vi.spyOn(shards, "flatMap");
    try {
      expect(mergeBoundaryStatistics(shards, undefined, "population.target")).toEqual(expected);
      expect(sourceLists).toHaveBeenCalledTimes(1);
      expect(shards).toEqual(unchanged);
    } finally { sourceLists.mockRestore(); }
  });
  it("retains normalization collisions and supervision validation when merging stored rows", () => {
    const populationId = "population.stored-merge";
    const featureOrder = compileBoundaryStatistics({ populationId, observations: [] }).featureOrder;
    const features = (value: number) => Object.fromEntries(featureOrder.map(feature => [feature, value])) as unknown as BoundaryFeatureVector;
    const anchored = (signalId: string, value: number, positiveMass: number): BoundaryObservation => ({ sourceDocumentId: "doc.owned", features: features(value),
      positiveMass, negativeMass: 1, supervision: "independent_anchor", signalKind: "external_anchor", signalId });
    const shards = [0, 1].map(value => compileBoundaryStatistics({ populationId, sourceDocumentIds: ["doc.owned"], observations: [anchored(`anchor.${value}`, value, value + 1)] }));
    const keys = shards.map(shard => shard.rows[0]!.key);
    shards[0]!.rows[0]!.featuresFixed.fill(shards[0]!.scale);
    shards[1]!.rows[0]!.featuresFixed.fill(shards[1]!.scale * 2);
    const expected = compileBoundaryStatistics({ populationId, sourceDocumentIds: ["doc.owned"], observations: keys.map((key, index) => anchored(`merged.anchor.${key}`, 1, index + 1)) });
    expect(mergeBoundaryStatistics(shards)).toEqual(expected);
    const invalidSource = structuredClone(shards);
    invalidSource[0]!.sourceDocumentIds = [""];
    expect(() => mergeBoundaryStatistics(invalidSource)).toThrow("requires sourceDocumentId");
    const invalidSignal = structuredClone(shards);
    invalidSignal[0]!.rows[0]!.key = "candidate_detector.forged";
    expect(() => mergeBoundaryStatistics(invalidSignal)).toThrow("cannot supervise");
  });
});
