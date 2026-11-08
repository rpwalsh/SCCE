// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
import { describe, expect, it, vi } from "vitest";
import { createLanguageInductionEngine } from "../language-induction.js";
import { canonicalStringify, createHasher } from "../primitives.js";
import * as surfaceLattice from "../surface-lattice.js";

describe("induction bootstrap lexical reuse", () => {
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
