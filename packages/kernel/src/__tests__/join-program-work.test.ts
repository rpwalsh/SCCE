// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
import { describe, expect, it, vi } from "vitest";
import { buildSurfaceLattice } from "../surface-lattice.js";
import { compileJoinProgram } from "../join-program.js";
import * as primitives from "../primitives.js";

describe("join training work", () => {
  it("hashes repeated join surfaces once while retaining exact coordinates", () => {
    const hasher = primitives.createHasher();
    const text = "alpha beta alpha beta alpha beta alpha beta";
    const lattice = buildSurfaceLattice({ documentId: "fixture", text, evidenceIds: ["evidence.fixture"], hasher });
    let spaceHashes = 0;
    const factory = vi.spyOn(primitives, "createHasher").mockImplementation(() => ({
      ...hasher,
      digestHex(value) { if (value === " ") spaceHashes++; return hasher.digestHex(value); }
    }));
    try {
      const program = compileJoinProgram({ populationId: "population.fixture", documents: [{ documentId: "fixture", text, lattice }], hasher });
      const spaces = Object.values(program.exactIndex).flat().filter(choice => choice.surface === " ");
      expect(spaces.length).toBeGreaterThan(0);
      expect(spaces.every(choice => choice.evidenceCoordinates.every(coordinate => coordinate.exactSurfaceHash === hasher.digestHex(" ")))).toBe(true);
      expect(spaceHashes).toBe(1);
    } finally {
      factory.mockRestore();
    }
  });
});
