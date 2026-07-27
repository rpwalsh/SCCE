import { describe, expect, it } from "vitest";
import {
  buildSegmentationForest,
  createHasher,
  resumeSegmentationForest,
  type SegmentationForestUnit
} from "../index.js";

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

    expect(forest.schema).toBe("scce.segmentation_forest.v2");
    expect(forest.paths).toHaveLength(4);
    expect(forest.paths[0]!.unitIds).toEqual(["u012"]);
    expect(forest.retainedPosteriorMass).toBeGreaterThan(0);
    expect(forest.retainedPosteriorMass).toBeLessThanOrEqual(1);
    expect(forest.paths.reduce((sum, path) => sum + path.posterior, 0))
      .toBeCloseTo(forest.retainedPosteriorMass, 10);
    expect(forest.retainedPosteriorMass + forest.omittedPosteriorMass).toBeCloseTo(1, 10);
    expect(forest.paths.every(path =>
      path.energyTrace.total === path.energy
      && Math.abs(
        path.energyTrace.boundary
        + path.energyTrace.continuation
        + path.energyTrace.anchor
        + path.energyTrace.description
        + path.energyTrace.population
        + path.energyTrace.semanticContext
        - path.energyTrace.total
      ) < 1e-9)).toBe(true);
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

  it("preserves a real ambiguity until semantic context resolves it", () => {
    const units = [
      unit("g0", 0, 1, "base_partition"),
      unit("g1", 1, 2, "base_partition"),
      unit("u01", 0, 2, "segmentation_alternative")
    ].map(candidate => ({
      ...candidate,
      boundaryBefore: { boundaryProbability: candidate.graphemeStart === 0 ? 1 : 0.5 },
      boundaryAfter: { boundaryProbability: candidate.graphemeEnd === 2 ? 1 : 0.5 }
    }));
    const ambiguous = buildSegmentationForest({
      latticeId: "lattice.ambiguous",
      estimatorId: "estimator.ambiguous",
      units,
      pathLimit: 2,
      limits: { maxResidualPosteriorMass: 0 },
      hasher: createHasher()
    });
    expect(ambiguous.paths).toHaveLength(2);
    expect(ambiguous.paths[0]!.posterior).toBeCloseTo(0.5, 10);
    expect(ambiguous.paths[1]!.posterior).toBeCloseTo(0.5, 10);

    const resolved = buildSegmentationForest({
      latticeId: "lattice.ambiguous",
      estimatorId: "estimator.ambiguous",
      units,
      pathLimit: 2,
      limits: { maxResidualPosteriorMass: 0 },
      semanticContextEnergyByUnitId: { u01: 3 },
      hasher: createHasher()
    });
    expect(resolved.paths).toHaveLength(2);
    expect(resolved.paths[0]!.unitIds).toEqual(["g0", "g1"]);
    expect(resolved.paths[0]!.posterior).toBeGreaterThan(0.9);
    expect(resolved.paths[1]!.energyTrace.semanticContext).toBe(3);
  });

  it("bounds arcs, states, derivations, residual mass, and construction depth without renormalizing", () => {
    const units = [
      unit("g0", 0, 1, "base_partition"),
      unit("g1", 1, 2, "base_partition"),
      unit("g2", 2, 3, "base_partition"),
      unit("u01.a", 0, 2, "segmentation_alternative"),
      unit("u01.b", 0, 2, "segmentation_alternative"),
      unit("u012", 0, 3, "segmentation_alternative"),
      unit("u12", 1, 3, "segmentation_alternative")
    ];
    const bounded = buildSegmentationForest({
      latticeId: "lattice.bounded",
      estimatorId: "estimator.bounded",
      units,
      pathLimit: 8,
      limits: {
        maxArcsPerCoordinate: 2,
        maxOutgoingAlternatives: 2,
        maxTotalStates: 4,
        maxRetainedDerivations: 1,
        maxResidualPosteriorMass: 0.01,
        maxConstructionDepth: 1
      },
      hasher: createHasher()
    });

    expect(bounded.paths).toHaveLength(1);
    expect(bounded.paths[0]!.unitIds).toEqual(["g0", "g1", "g2"]);
    expect(bounded.retainedPosteriorMass).toBeLessThan(1);
    expect(bounded.retainedPosteriorMass + bounded.omittedPosteriorMass).toBeCloseTo(1, 10);
    expect(bounded.prunedArcPosteriorMass).toBeGreaterThan(0);
    expect(bounded.completion).toBe("resumable");
    expect(bounded.resumeState?.token).toMatch(/^segmentation_resume\./);
    expect(bounded.resumeState?.reasonIds).toEqual(expect.arrayContaining([
      "segmentation.limit.arcs",
      "segmentation.limit.construction_depth",
      "segmentation.limit.retained_derivations",
      "segmentation.limit.residual_posterior_mass"
    ]));

    const resumed = resumeSegmentationForest({
      previous: bounded,
      resumeToken: bounded.resumeState!.token,
      build: {
        latticeId: "lattice.bounded",
        estimatorId: "estimator.bounded",
        units,
        pathLimit: 8,
        limits: {
          maxArcsPerCoordinate: 8,
          maxOutgoingAlternatives: 8,
          maxTotalStates: 64,
          maxRetainedDerivations: 8,
          maxResidualPosteriorMass: 0,
          maxConstructionDepth: 8
        },
        hasher: createHasher()
      }
    });
    expect(resumed.paths.length).toBeGreaterThan(bounded.paths.length);
    expect(resumed.retainedPosteriorMass).toBeGreaterThan(bounded.retainedPosteriorMass);
    expect(resumed.omittedPosteriorMass).toBeLessThan(bounded.omittedPosteriorMass);
  });
});
