// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
import { describe, expect, it, vi } from "vitest";
import { buildSegmentationForest, exportSegmentationAdjacencyFactors, segmentationSurfaceAdjacencies, type SegmentationForestUnit } from "../segmentation-forest.js";
import { createSegmentationAdjacencyQuery, validateSegmentationAdjacencyFactors } from "../segmentation-adjacency-factors.js";

function unit(id: string, start: number, end: number, base = false): SegmentationForestUnit {
  return { id, kind: base ? "grapheme" : "candidate", overlapClass: base ? "base_partition" : "segmentation_alternative",
    graphemeStart: start, graphemeEnd: end, recurrenceCount: 1, predictability: 0,
    boundaryBefore: { boundaryProbability: start % 2 === 0 ? 1 : 0.5 }, boundaryAfter: { boundaryProbability: end % 2 === 0 ? 1 : 0.5 } };
}

describe("portable segmentation adjacency factors", () => {
  it("restores exact query mass from primitive factors without persisting any pair table", () => {
    const units = [unit("left", 0, 1, true), unit("space", 1, 2, true), unit("control", 2, 3, true), unit("right", 3, 4, true),
      unit("gap", 1, 3), unit("whole", 0, 4)];
    const forest = buildSegmentationForest({ latticeId: "portable-gaps", estimatorId: "proof", units, pathLimit: 32 });
    const { factors, unitIds } = exportSegmentationAdjacencyFactors(forest);
    const restored: unknown = JSON.parse(JSON.stringify(factors));
    validateSegmentationAdjacencyFactors(restored);
    expect(Object.keys(restored).sort()).toEqual(["schema", "nodeCount", "arcs"].sort());
    expect(restored.arcs).toHaveLength(units.length);
    expect(restored.nodeCount).toBe(5);
    const bearingIds = new Set(["left", "right", "whole"]), bearing = new Set(unitIds.flatMap((id, index) => bearingIds.has(id) ? [index] : []));
    const query = createSegmentationAdjacencyQuery(restored, bearing);
    expect([...query.pairs()].map(pair => ({ leftUnitId: unitIds[pair.leftArcIndex], rightUnitId: unitIds[pair.rightArcIndex], posterior: pair.posterior })))
      .toEqual([...segmentationSurfaceAdjacencies(forest, bearingIds)]);
    const left = unitIds.indexOf("left"), right = unitIds.indexOf("right");
    expect([...query.pairs({ leftArcIndices: new Set([left]), rightArcIndices: new Set([right]) })])
      .toEqual([...query.pairs()].filter(pair => pair.leftArcIndex === left && pair.rightArcIndex === right));
    const corrupt = JSON.parse(JSON.stringify(factors)); corrupt.nodeCount = 1;
    expect(() => validateSegmentationAdjacencyFactors(corrupt)).toThrow("invalid segmentation adjacency factors");
    const changedEnergy = JSON.parse(JSON.stringify(factors)); changedEnergy.arcs[0][2] = Number.NaN;
    expect(() => validateSegmentationAdjacencyFactors(changedEnergy)).toThrow("invalid segmentation adjacency factors");
    const beforeMutation = [...query.pairs()];
    const mutableArc = restored.arcs[0] as unknown as number[];
    mutableArc[2] = mutableArc[2]! + 1;
    restored.nodeCount += 1;
    expect([...query.pairs()]).toEqual(beforeMutation);
  });

  it("directly visits requested left candidates and keeps all other bearing arcs as bridge stops", () => {
    const blocks = 410;
    const units = Array.from({ length: blocks }, (_, index) => [unit(`left.${index}`, index * 2, index * 2 + 1, true),
      unit(`right.${index}`, index * 2 + 1, index * 2 + 2, true), unit(`whole.${index}`, index * 2, index * 2 + 2)]).flat();
    const forest = buildSegmentationForest({ latticeId: "many-unqueried-contexts", estimatorId: "proof", units, pathLimit: 1 });
    const { factors, unitIds } = exportSegmentationAdjacencyFactors(forest);
    const query = createSegmentationAdjacencyQuery(factors, new Set(unitIds.map((_, index) => index)));
    const left = unitIds.indexOf("left.0"), right = unitIds.indexOf("right.0");
    const has = Set.prototype.has;
    let visits = 0;
    const spy = vi.spyOn(Set.prototype, "has").mockImplementation(function(this: Set<unknown>, value: unknown) { visits++; return has.call(this, value); });
    let pairs;
    try { pairs = [...query.pairs({ leftArcIndices: new Set([left]), rightArcIndices: new Set([right]) })]; }
    finally { spy.mockRestore(); }
    expect(pairs).toHaveLength(1);
    expect(pairs![0]!.posterior).toBeCloseTo(0.5, 9);
    expect(visits).toBeLessThan(10);
    expect([...query.pairs({ leftArcIndices: new Set([left]), rightArcIndices: new Set([unitIds.indexOf("left.1")]) })]).toEqual([]);
    expect(factors.arcs).toHaveLength(blocks * 3);
    expect(factors.nodeCount).toBe(blocks * 2 + 1);
  });
});
