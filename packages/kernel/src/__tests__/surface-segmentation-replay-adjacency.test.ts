// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
import { describe, expect, it } from "vitest";
import { createHasher } from "../primitives.js";
import { buildSurfaceLattice, exportSurfaceSegmentationReplayRecipe, replaySurfaceSegmentationAdjacency } from "../surface-lattice.js";
import { exportSegmentationAdjacencyFactors } from "../segmentation-forest.js";

describe("exact source adjacency replay without unused forest materialization", () => {
  it.each(["", "Observed source: one two one.\nSecond line.", "界 👩‍💻 e\u0301\u0000한국어 العربية"])("retains every full-DAG coordinate and IEEE energy for %j", text => {
    const hasher = createHasher();
    const options = { documentId: "document.replay", sourceFamilyId: "family.replay", sourceVersionId: "version.replay",
      evidenceIds: ["evidence.replay"], text, maxUnits: 256, captureSegmentationReplay: true, hasher };
    const full = buildSurfaceLattice(options);
    const expected = exportSegmentationAdjacencyFactors(full.segmentationForest).factors;
    const recipe = JSON.parse(JSON.stringify(exportSurfaceSegmentationReplayRecipe(full)));
    let materializedPathHashes = 0;
    const replayHasher = { ...hasher, digestHex(value: string | Uint8Array) {
      if (typeof value === "string" && value.startsWith("{")) {
        const parsed = JSON.parse(value);
        if (Object.hasOwn(parsed, "unitIds") && Object.hasOwn(parsed, "energyTrace")) materializedPathHashes++;
      }
      return hasher.digestHex(value);
    } };
    const actual = replaySurfaceSegmentationAdjacency({ ...options, normalizationContract: full.normalizationContract, recipe, hasher: replayHasher });
    expect(actual.nodeCount).toBe(expected.nodeCount);
    expect(actual.arcs).toHaveLength(expected.arcs.length);
    actual.arcs.forEach((arc, index) => arc.forEach((value, coordinate) => expect(Object.is(value, expected.arcs[index]![coordinate])).toBe(true)));
    expect(materializedPathHashes).toBe(0);
    expect(buildSurfaceLattice(options)).toEqual(full);
    expect(() => replaySurfaceSegmentationAdjacency({ ...options, text: `${text}changed`, normalizationContract: full.normalizationContract, recipe })).toThrow(/topology or energy/);
  });
});
