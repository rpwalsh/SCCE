import { describe, expect, it } from "vitest";
import { buildSegmentationForest, createHasher, type SegmentationForestUnit } from "../index.js";

function unit(
  id: string,
  start: number,
  end: number,
  overlapClass: SegmentationForestUnit["overlapClass"],
  recurrenceCount = 1
): SegmentationForestUnit {
  return {
    id,
    kind: overlapClass === "base_partition" ? "grapheme" : "candidate",
    overlapClass,
    graphemeStart: start,
    graphemeEnd: end,
    recurrenceCount,
    predictability: Math.min(1, recurrenceCount / 10),
    boundaryBefore: { boundaryProbability: start === 0 ? 1 : 0.4 },
    boundaryAfter: { boundaryProbability: end === 3 ? 1 : 0.4 }
  };
}

describe("packed segmentation forest", () => {
  it("returns deterministic k-best exact covers and posterior mass from the complete DAG", () => {
    const units = [
      unit("g0", 0, 1, "base_partition"),
      unit("g1", 1, 2, "base_partition"),
      unit("g2", 2, 3, "base_partition"),
      unit("u01", 0, 2, "segmentation_alternative", 12),
      unit("u12", 1, 3, "segmentation_alternative", 4),
      unit("u012", 0, 3, "segmentation_alternative", 20)
    ];
    const forest = buildSegmentationForest({
      latticeId: "lattice.test",
      estimatorId: "estimator.test",
      units,
      pathLimit: 4,
      hasher: createHasher()
    });

    expect(forest.schema).toBe("scce.segmentation_forest.v1");
    expect(forest.paths).toHaveLength(4);
    expect(forest.paths[0]!.unitIds).toEqual(["u012"]);
    expect(forest.retainedPosteriorMass).toBeGreaterThan(0);
    expect(forest.retainedPosteriorMass).toBeLessThanOrEqual(1);
    expect(forest.paths.reduce((sum, path) => sum + path.posterior, 0))
      .toBeCloseTo(forest.retainedPosteriorMass, 10);
    expect(forest.boundaryMarginals[0]).toEqual({
      positionGrapheme: 0,
      boundaryProbability: 1
    });
    expect(forest.boundaryMarginals.at(-1)).toEqual({
      positionGrapheme: 3,
      boundaryProbability: 1
    });
    expect(forest.boundaryMarginals
      .every(row => row.boundaryProbability >= 0 && row.boundaryProbability <= 1)).toBe(true);
    const byId = new Map(units.map(candidate => [candidate.id, candidate]));
    for (const path of forest.paths) {
      let cursor = 0;
      for (const id of path.unitIds) {
        const candidate = byId.get(id)!;
        expect(candidate.graphemeStart).toBe(cursor);
        cursor = candidate.graphemeEnd;
      }
      expect(cursor).toBe(3);
    }

    const repeated = buildSegmentationForest({
      latticeId: "lattice.test",
      estimatorId: "estimator.test",
      units: [...units].reverse(),
      pathLimit: 4,
      hasher: createHasher()
    });
    expect(repeated).toEqual(forest);

    const changedBootstrapCounts = buildSegmentationForest({
      latticeId: "lattice.test",
      estimatorId: "estimator.test",
      units: units.map(candidate => ({
        ...candidate,
        recurrenceCount: candidate.recurrenceCount * 100,
        predictability: 1 - candidate.predictability
      })),
      pathLimit: 4,
      hasher: createHasher()
    });
    expect(changedBootstrapCounts).toEqual(forest);
  });
});
