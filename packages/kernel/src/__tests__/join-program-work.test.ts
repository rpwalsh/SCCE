// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
import { describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { buildSurfaceLattice } from "../surface-lattice.js";
import { compileJoinProgram } from "../join-program.js";
import * as primitives from "../primitives.js";

describe("join training work", () => {
  it("serializes each fresh event coordinate once per compile and preserves the complete authentic model", () => {
    const source = JSON.parse(readFileSync(new URL("./fixtures/dolly-human-window-160-193.json", import.meta.url), "utf8")) as { turns: Array<{ surface: string }> };
    const text = source.turns[0]!.surface;
    const hasher = primitives.createHasher();
    const documentId = "authentic-dolly-instruction", evidenceId = "evidence.authentic-small-dolly";
    const lattice = buildSurfaceLattice({ documentId, text, evidenceIds: [evidenceId], hasher });
    const byId = new Map(lattice.units.map(unit => [unit.id, unit]));
    const eventCoordinates = lattice.segmentationForest.paths.reduce((total, path) => {
      const units = path.unitIds.map(id => byId.get(id)!).filter(unit => unit.surface.length > 0 && !/^\s+$/u.test(unit.surface) && !/^\p{Control}+$/u.test(unit.surface));
      return total + Math.max(0, units.length - 1);
    }, 0);
    const join = Array.prototype.join;
    let coordinateKeys = 0;
    const serializing = vi.spyOn(Array.prototype, "join").mockImplementation(function(this: unknown[], separator?: string) {
      if (separator === "\u001f" && this.length === 8 && this[0] === evidenceId && typeof this[3] === "number") coordinateKeys++;
      return join.call(this, separator);
    });
    try {
      const compile = () => compileJoinProgram({ populationId: "population.proof", documents: [{ documentId, text, lattice }], hasher });
      const first = compile();
      expect(coordinateKeys).toBe(eventCoordinates);
      expect(hasher.digestHex(primitives.canonicalStringify(first))).toBe("190bc218cf92347840987fb1a4b4c6dd7bc0b1441ec1fffd761461a57b52532f");
      coordinateKeys = 0;
      expect(compile()).toEqual(first);
      expect(coordinateKeys).toBe(eventCoordinates);
    } finally { serializing.mockRestore(); }
  });
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
