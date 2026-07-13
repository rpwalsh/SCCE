import { describe, expect, it } from "vitest";
import { analyzeGraph } from "../graph-analytics.js";
import { assessTransitionSpectralGap, spectralGapFromTransition } from "../math.js";
import type { GraphEdge, GraphNode, GraphSlice } from "../types.js";

describe("transition spectral-gap truthfulness", () => {
  it("computes the absolute gap through the reversible discriminant", () => {
    const assessment = assessTransitionSpectralGap([
      [0.8, 0.2],
      [0.4, 0.6]
    ]);

    expect(assessment.available).toBe(true);
    expect(assessment.assumptions).toEqual({ square: true, rowStochastic: true, irreducible: true, aperiodic: true, reversible: true });
    expect(assessment.stationaryDistribution[0]).toBeCloseTo(2 / 3, 10);
    expect(assessment.stationaryDistribution[1]).toBeCloseTo(1 / 3, 10);
    expect(assessment.spectralGap).toBeCloseTo(0.6, 8);
    expect(spectralGapFromTransition([[0.8, 0.2], [0.4, 0.6]])).toBeCloseTo(0.6, 8);
  });

  it("does not symmetrize a non-reversible directed chain into a claimed gap", () => {
    const directed = [
      [0.1, 0.9, 0],
      [0, 0.1, 0.9],
      [0.9, 0, 0.1]
    ];
    const assessment = assessTransitionSpectralGap(directed);

    expect(assessment.available).toBe(false);
    expect(assessment.reason).toBe("not_reversible");
    expect(assessment.assumptions).toEqual({ square: true, rowStochastic: true, irreducible: true, aperiodic: true, reversible: false });
    expect(spectralGapFromTransition(directed)).toBe(0);
  });

  it("reports invalid, reducible, and periodic chains as unavailable without a positive floor", () => {
    expect(assessTransitionSpectralGap([[0.4, 0.4], [0.5, 0.5]]).reason).toBe("not_row_stochastic");
    expect(assessTransitionSpectralGap([[1, 0], [0, 1]]).reason).toBe("not_irreducible");
    expect(assessTransitionSpectralGap([[0, 1], [1, 0]]).reason).toBe("not_aperiodic");
    expect(spectralGapFromTransition([[0, 1], [1, 0]])).toBe(0);
  });

  it("marks graph analytics gap unavailable instead of issuing a false slow-mixing warning", () => {
    const slice = directedCycleSlice();
    const report = analyzeGraph(slice);

    expect(report.spectral.spectralGapAvailable).toBe(false);
    expect(report.spectral.spectralGapReason).toBe("not_reversible");
    expect(report.risks.some(risk => risk.id === "transition-gap-unavailable")).toBe(true);
    expect(report.risks.some(risk => risk.id === "slow-mixing")).toBe(false);
  });
});

function directedCycleSlice(): GraphSlice {
  const nodes: GraphNode[] = ["a", "b", "c"].map(id => ({
    id: id as never,
    typeId: "type:test" as never,
    representation: id,
    alpha: 1,
    evidenceIds: [],
    features: [id],
    createdAt: 1,
    updatedAt: 1,
    metadata: {}
  }));
  const links: Array<[string, string, number]> = [["a", "a", 0.1], ["a", "b", 0.9], ["b", "b", 0.1], ["b", "c", 0.9], ["c", "c", 0.1], ["c", "a", 0.9]];
  const edges: GraphEdge[] = links.map(([source, target, weight], index) => ({
    id: `edge:${index}` as never,
    source: source as never,
    target: target as never,
    relationId: "relation:test" as never,
    alpha: 1,
    weight,
    temporalScope: { validFrom: 1 },
    evidenceIds: [],
    createdAt: 1,
    updatedAt: 1,
    metadata: {}
  }));
  return { nodes, edges, hyperedges: [], bounded: true, query: {} };
}
