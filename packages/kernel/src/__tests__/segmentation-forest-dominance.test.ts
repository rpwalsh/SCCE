// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
import { describe, expect, it } from "vitest";
import { createHasher } from "../primitives.js";
import { buildSegmentationForest, type SegmentationForestUnit } from "../segmentation-forest.js";

function unit(id: string, start: number, end: number, base = false): SegmentationForestUnit {
  return { id, kind: base ? "grapheme" : "candidate", overlapClass: base ? "base_partition" : "segmentation_alternative",
    graphemeStart: start, graphemeEnd: end, recurrenceCount: 1, predictability: 0,
    boundaryBefore: { boundaryProbability: start === 0 ? 1 : 0.5 }, boundaryAfter: { boundaryProbability: 0.5 } };
}

function countingHasher(override?: (input: string) => string | undefined) {
  const base = createHasher();
  const extensions: string[] = [];
  return { extensions, hasher: { ...base, digestHex(input: string | Uint8Array) {
    if (typeof input === "string" && input.includes("\u001f")) {
      extensions.push(input);
      const replacement = override?.(input);
      if (replacement !== undefined) return replacement;
    }
    return base.digestHex(input);
  } } };
}

describe("segmentation forest extension dominance", () => {
  it("avoids hashing strictly dominated extensions while preserving the complete forest", () => {
    const probe = countingHasher();
    const alternatives = Array.from({ length: 24 }, (_, index) => unit(`alternative.${index}`, 0, 3));
    const forest = buildSegmentationForest({ latticeId: "lattice.dominance", estimatorId: "estimator.dominance",
      units: [unit("g0", 0, 1, true), unit("g1", 1, 2, true), unit("g2", 2, 3, true), ...alternatives],
      pathLimit: 2, descriptionEnergyByUnitId: Object.fromEntries(alternatives.map((entry, index) => [entry.id, 10 * index])),
      hasher: probe.hasher });
    expect(createHasher().digestHex(JSON.stringify(forest))).toBe("e4f5acab0da28378b45288d960503f515313d7db571ed95a85165b381e8d3717");
    expect(forest.paths.map(path => path.unitIds)).toEqual([["alternative.0"], ["g0", "g1", "g2"]]);
    expect(probe.extensions).toHaveLength(5);
    expect(probe.extensions.some(input => input.endsWith("\u001falternative.23"))).toBe(false);
  });

  it("hashes every tied energy/depth extension, including energies equal after quantization", () => {
    const probe = countingHasher();
    const alternatives = Array.from({ length: 20 }, (_, index) => unit(`tie.${index}`, 0, 3));
    const forest = buildSegmentationForest({ latticeId: "lattice.ties", estimatorId: "estimator.ties",
      units: [unit("g0", 0, 1, true), unit("g1", 1, 2, true), unit("g2", 2, 3, true), ...alternatives],
      pathLimit: 2, descriptionEnergyByUnitId: Object.fromEntries(alternatives.map((entry, index) => [entry.id, index * 1e-15])),
      hasher: probe.hasher });
    expect(createHasher().digestHex(JSON.stringify(forest))).toBe("e4c1acdad3a1a1d1370ea4f41def0f87e58618b87becdb22a6e6e61053eaee7a");
    for (const alternative of alternatives) expect(probe.extensions.some(input => input.endsWith(`\u001f${alternative.id}`))).toBe(true);
    expect(probe.extensions).toHaveLength(22);
    expect(probe.extensions.some(input => input.endsWith("\u001fg2"))).toBe(false);
  });

  it("derives the bound from distinct retained paths even when path hashes collide", () => {
    const probe = countingHasher(input => input.endsWith("\u001funique") ? undefined : "f".repeat(64));
    const forest = buildSegmentationForest({ latticeId: "lattice.duplicates", estimatorId: "estimator.duplicates",
      units: [unit("g0", 0, 1, true), unit("g1", 1, 2, true), unit("duplicate.a", 0, 2), unit("duplicate.b", 0, 2), unit("unique", 0, 2)],
      pathLimit: 2, descriptionEnergyByUnitId: { "duplicate.a": -1, "duplicate.b": -1, unique: 10 }, hasher: probe.hasher });
    expect(createHasher().digestHex(JSON.stringify(forest))).toBe("56e977b296cfd09bfbb7dad24bb24cc6e0fac09ea7c02ac6035104a3bc46a8f4");
    expect(forest.paths.map(path => path.unitIds)).toEqual([["duplicate.a"], ["unique"]]);
    expect(probe.extensions.some(input => input.endsWith("\u001funique"))).toBe(true);
  });
});
