// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
import { describe, expect, it, vi } from "vitest";
import { createLanguageInductionEngine } from "../language-induction.js";
import { canonicalStringify, createHasher } from "../primitives.js";
import * as surfaceLattice from "../surface-lattice.js";

describe("induction bootstrap lexical reuse", () => {
  it("partitions boundary observations without rescanning the complete list for each document", () => {
    const collect = surfaceLattice.collectBoundaryTrainingObservations;
    const scans: Array<{ mockRestore(): void }> = [];
    const collecting = vi.spyOn(surfaceLattice, "collectBoundaryTrainingObservations").mockImplementation(input => {
      const observations = collect(input);
      scans.push(vi.spyOn(observations, "filter"));
      return observations;
    });
    try {
      const model = createLanguageInductionEngine().induce({ documents: [
        { id: "partition.a", text: "猫が飛ぶ。犬が走る。猫が眠る。" },
        { id: "partition.b", text: "Élan visite 東京. Élan visite Paris." }
      ] });
      expect(model.boundaryStatistics.sourceDocumentIds).toEqual(["partition.a", "partition.b"]);
      expect(scans).toHaveLength(1);
      for (const scan of scans) expect(scan).not.toHaveBeenCalled();
    } finally { collecting.mockRestore(); for (const scan of scans) scan.mockRestore(); }
  });
  it("preserves the complete learned artifact and deterministic replay while building each lattice only once", () => {
    const documents = [
      { id: "fixture.alpha", text: "the cat sat. the dog sat. the cat ran. the dog ran. the cat sat. the dog ran." },
      { id: "fixture.beta", text: "a fox slept. a wolf slept. a fox walked. a wolf walked. a fox slept. a wolf walked." }
    ];
    const hasher = createHasher();
    const build = vi.spyOn(surfaceLattice, "buildSurfaceLattice");
    try {
      const engine = createLanguageInductionEngine({ hasher });
      const first = engine.induce({ documents });
      expect(build).toHaveBeenCalledTimes(2 * documents.length);
      // Fingerprint of the complete artifact produced before bootstrap lexical reuse.
      expect(hasher.digestHex(canonicalStringify(first))).toBe("fb5a5f0e12ea871a1e67b622eb2cafda632533f94538052327071b5c624440d0");
      const replay = engine.induce({ documents });
      expect(replay).toEqual(first);
      expect(build).toHaveBeenCalledTimes(4 * documents.length);
    } finally {
      build.mockRestore();
    }
  });
});
