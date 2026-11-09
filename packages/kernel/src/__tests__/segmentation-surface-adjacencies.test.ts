// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
import { describe, expect, it } from "vitest";
import { buildSegmentationForest, segmentationSurfaceAdjacencies, type SegmentationForestUnit } from "../segmentation-forest.js";

function unit(id: string, start: number, end: number, base = false): SegmentationForestUnit {
  return { id, kind: base ? "grapheme" : "candidate", overlapClass: base ? "base_partition" : "segmentation_alternative",
    graphemeStart: start, graphemeEnd: end, recurrenceCount: 1, predictability: 0,
    boundaryBefore: { boundaryProbability: start % 2 === 0 ? 1 : 0.5 },
    boundaryAfter: { boundaryProbability: end % 2 === 0 ? 1 : 0.5 } };
}
const key = (left: string, right: string) => JSON.stringify([left, right]);

describe("complete-DAG surface adjacency marginals", () => {
  it("matches exhaustive covers with Unicode surface units and alternative whitespace/control bridges", () => {
    const surfaces = new Map([ ["cat", "猫"], ["space", " "], ["tab", "\t"], ["control", "\u0000"],
      ["emoji", "👩‍🔬"], ["accent", "é"], ["space-tab", " \t"], ["tab-control", "\t\u0000"],
      ["gap", " \t\u0000"], ["cat-space", "猫 "], ["ending", "👩‍🔬é"], ["whole", "猫 \t\u0000👩‍🔬é"] ]);
    const units = [unit("cat", 0, 1, true), unit("space", 1, 2, true), unit("tab", 2, 3, true),
      unit("control", 3, 4, true), unit("emoji", 4, 5, true), unit("accent", 5, 6, true),
      unit("space-tab", 1, 3), unit("tab-control", 2, 4), unit("gap", 1, 4), unit("cat-space", 0, 2),
      unit("ending", 4, 6), unit("whole", 0, 6)];
    const bearing = new Set([...surfaces].filter(([, surface]) => surface.length > 0 && !/^\s+$/u.test(surface) && !/^\p{Control}+$/u.test(surface)).map(([id]) => id));
    const input = { latticeId: "unicode-gaps", estimatorId: "proof", units, pathLimit: 1024,
      descriptionEnergyByUnitId: { whole: 0.7, gap: 0.2 }, anchorEnergyByUnitId: { ending: 0.3 } };
    const forest = buildSegmentationForest(input);
    expect(forest.omittedPosteriorMass).toBeCloseTo(0, 10);
    const expected = new Map<string, number>();
    for (const path of forest.paths) {
      const ids = path.unitIds.filter(id => bearing.has(id));
      for (let index = 1; index < ids.length; index++) {
        const pair = key(ids[index - 1]!, ids[index]!);
        expected.set(pair, (expected.get(pair) ?? 0) + path.posterior);
      }
    }
    const actual = [...segmentationSurfaceAdjacencies(forest, bearing)];
    expect(actual).toHaveLength(expected.size);
    for (const pair of actual) expect(pair.posterior).toBeCloseTo(expected.get(key(pair.leftUnitId, pair.rightUnitId))!, 10);
    expect(actual.some(pair => pair.leftUnitId === "cat" && pair.rightUnitId === "emoji")).toBe(true);
    expect(actual.every(pair => pair.leftUnitId !== "whole" && pair.rightUnitId !== "whole")).toBe(true);
    const limited = buildSegmentationForest({ ...input, pathLimit: 1, limits: { maxOutgoingAlternatives: 1, maxArcsPerCoordinate: 1 } });
    expect(limited.omittedPosteriorMass).toBeGreaterThan(0);
    expect([...segmentationSurfaceAdjacencies(limited, bearing)]).toEqual(actual);
    units[0]!.id = "mutated";
    units[0]!.graphemeEnd = 6;
    expect([...segmentationSurfaceAdjacencies(forest, bearing)]).toEqual(actual);
    expect([...segmentationSurfaceAdjacencies(forest, new Set())]).toEqual([]);
  });

  it("retains positive local evidence when every materialized full-path posterior rounds to zero", () => {
    const blocks = 41;
    const units = Array.from({ length: blocks }, (_, index) => [unit(`left.${index}`, index * 2, index * 2 + 1, true),
      unit(`right.${index}`, index * 2 + 1, index * 2 + 2, true), unit(`whole.${index}`, index * 2, index * 2 + 2)]).flat();
    const forest = buildSegmentationForest({ latticeId: "independent-binary-blocks", estimatorId: "proof", units, pathLimit: 16 });
    expect(forest.paths).toHaveLength(16);
    expect(forest.paths.every(path => path.posterior === 0)).toBe(true);
    expect(forest.retainedPosteriorMass).toBe(0);
    const pairs = [...segmentationSurfaceAdjacencies(forest, new Set(units.map(value => value.id)))];
    expect(pairs.find(pair => pair.leftUnitId === "left.0" && pair.rightUnitId === "right.0")!.posterior).toBeCloseTo(0.5, 10);
    expect(pairs.reduce((sum, pair) => sum + pair.posterior, 0)).toBeCloseTo(blocks * 1.5 - 1, 9);
    expect(forest.omittedPosteriorMass).toBe(1);
  });

  it("counts no joins for leading, trailing, or entirely nonbearing runs", () => {
    const forest = buildSegmentationForest({ latticeId: "outer-gaps", estimatorId: "proof",
      units: [unit("leading-control", 0, 1, true), unit("left", 1, 2, true), unit("gap", 2, 3, true),
        unit("right", 3, 4, true), unit("trailing-space", 4, 5, true)] });
    const pairs = [...segmentationSurfaceAdjacencies(forest, new Set(["left", "right"]))];
    expect(pairs).toHaveLength(1);
    expect(pairs[0]).toMatchObject({ leftUnitId: "left", rightUnitId: "right" });
    expect(pairs[0]!.posterior).toBeCloseTo(1, 10);
    expect([...segmentationSurfaceAdjacencies(forest, new Set(["left"]))]).toEqual([]);
    expect([...segmentationSurfaceAdjacencies(forest, new Set())]).toEqual([]);
  });

  it("rejects detached forest summaries instead of treating retained paths as complete evidence", () => {
    const forest = buildSegmentationForest({ latticeId: "canonical", estimatorId: "proof", units: [unit("one", 0, 1, true)] });
    expect(() => segmentationSurfaceAdjacencies({ ...forest }, new Set(["one"]))).toThrow("canonical full-DAG adjacency measure");
    expect(() => segmentationSurfaceAdjacencies(JSON.parse(JSON.stringify(forest)), new Set(["one"]))).toThrow("canonical full-DAG adjacency measure");
    expect(JSON.stringify(forest)).not.toContain("full_dag_measure");
  });
});
