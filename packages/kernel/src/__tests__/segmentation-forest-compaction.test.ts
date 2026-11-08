// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
import { expect, it } from "vitest";
import { buildSegmentationForest, resumeSegmentationForest, type SegmentationForestBuildInput, type SegmentationForestUnit } from "../segmentation-forest.js";
import { createHasher } from "../primitives.js";

const hasher = createHasher();
const digest = (value: unknown) => hasher.digestHex(JSON.stringify(value, (_key, entry: unknown) => typeof entry === "number"
  && (!Number.isFinite(entry) || Object.is(entry, -0)) ? `number:${Object.is(entry, -0) ? "-0" : String(entry)}` : entry));
const unit = (id: string, start: number, end: number, base = false): SegmentationForestUnit => ({ id,
  kind: base ? "grapheme" : "candidate", overlapClass: base ? "base_partition" : "segmentation_alternative",
  graphemeStart: start, graphemeEnd: end, recurrenceCount: 1, predictability: 0,
  boundaryBefore: { boundaryProbability: start === 0 ? 1 : 0.5 }, boundaryAfter: { boundaryProbability: 0.5 } });

function input(seed: number, pathLimit: number, collisions = false): SegmentationForestBuildInput {
  const units = Array.from({ length: 8 }, (_, index) => unit(`字.g${index}`, index, index + 1, true));
  for (let start = 0; start < 8; start++) for (let width = 2; width <= 4 && start + width <= 8; width++) {
    for (let variant = 0; variant < 3; variant++) units.push(unit(`ψ.${start}.${width}.${variant}`, start, start + width));
  }
  units.push(unit("zero-length", 2, 2));
  return { latticeId: `lattice.compaction.${seed}.${pathLimit}.${collisions}`, estimatorId: "estimator.compaction", units, pathLimit,
    descriptionEnergyByUnitId: Object.fromEntries(units.map((entry, index) => [entry.id, ((index * 13 + seed * 7) % 11 - 5) / 7 + (index % 3) * 1e-15])),
    hasher: collisions ? { ...hasher, digestHex(value) {
      return typeof value === "string" && value.includes("\u001f") && !value.endsWith(".1") ? "c".repeat(64) : hasher.digestHex(value);
    } } : hasher };
}

it("preserves complete forests across retained prefixes, quantized ties, and colliding path keys", () => {
  const outputs = [];
  for (const seed of [0, 1, 5]) for (const limit of [1, 2, 4, 16, 32]) for (const collisions of [false, true]) {
    const spec = input(seed, limit, collisions);
    const original = structuredClone(spec.units);
    const after = buildSegmentationForest(spec);
    expect(spec.units).toEqual(original);
    outputs.push(after);
  }
  expect(digest(outputs)).toBe("f82a2bcca0da6752d73e3b77922cd0d86c04b6b905592493a443bc12b15bba4d");
});

it("keeps the earlier exact-tie representative but replaces a late strictly better duplicate", () => {
  const units = [unit("g0", 0, 1, true), unit("g1", 1, 2, true), unit("direct.a", 0, 2), unit("direct.b", 0, 2)];
  const collisionHasher = { ...hasher, digestHex(value: string | Uint8Array) {
    return typeof value === "string" && value.includes("\u001f") ? "d".repeat(64) : hasher.digestHex(value);
  } };
  const outputs = [0, 50].map(cost => {
    const spec = { latticeId: "lattice.duplicates", estimatorId: "estimator.duplicates", units, pathLimit: 4,
      descriptionEnergyByUnitId: { "direct.a": cost, "direct.b": cost }, hasher: collisionHasher };
    return buildSegmentationForest(spec);
  });
  expect(outputs[0]!.paths[0]!.unitIds).toEqual(["direct.a"]);
  expect(outputs[1]!.paths[0]!.unitIds).toEqual(["g0", "g1"]);
  expect(digest(outputs)).toBe("07129583f519f0d95acb90ee088f601d9cd2ee264fb72c07ecfcd4b9cfa730ba");
});

it("preserves the existing comparator's extreme finite, overflow, NaN, and negative-zero behavior", () => {
  const outputs = [Number.MAX_VALUE, -Number.MAX_VALUE, Number.MIN_VALUE, -0].map(cost => {
    const spec: SegmentationForestBuildInput = { latticeId: "lattice.extreme", estimatorId: "estimator.extreme",
      units: [unit("g0", 0, 1, true), unit("g1", 1, 2, true), unit("g2", 2, 3, true), unit("direct", 0, 3), unit("pair", 0, 2)], pathLimit: 4,
      descriptionEnergyByUnitId: { g0: cost, g1: -cost, direct: -cost, pair: cost }, hasher };
    return buildSegmentationForest(spec);
  });
  expect(outputs.some(forest => forest.paths.some(path => Number.isNaN(path.energy)))).toBe(true);
  expect(digest(outputs)).toBe("eb788e94c8681a2a9779e3fa7549144a0959f997ac375822a6926861435f131d");
});

it("preserves bounded resume tokens and complete expanded forests", () => {
  const spec = input(3, 2);
  spec.limits = { maxArcsPerCoordinate: 2, maxOutgoingAlternatives: 2, maxResidualPosteriorMass: 0 };
  const previous = buildSegmentationForest(spec);
  expect(previous.completion).toBe("resumable");
  const expanded = { ...spec, pathLimit: 32, limits: { ...spec.limits, maxArcsPerCoordinate: 128, maxOutgoingAlternatives: 64, maxRetainedDerivations: 32 } };
  const resumed = resumeSegmentationForest({ previous, resumeToken: previous.resumeState!.token, build: expanded });
  expect(digest([previous, resumed])).toBe("6b664271d72d3d67fe8121267450c6b5b322e3d9a7c8f624cf686fc3ebbe06c8");
});

it("does not copy retained DP prefixes into a fresh sliced array for each incoming arc", () => {
  const slice = Array.prototype.slice;
  let prefixCopies = 0;
  Array.prototype.slice = function(this: unknown[], start?: number, end?: number) {
    const first = this[0] as { pathKey?: unknown; parent?: unknown } | undefined;
    if (first && typeof first === "object" && typeof first.pathKey === "string" && "parent" in first) prefixCopies++;
    return Reflect.apply(slice, this, [start, end]);
  };
  try { buildSegmentationForest(input(4, 16)); }
  finally { Array.prototype.slice = slice; }
  expect(prefixCopies).toBe(0);
});
