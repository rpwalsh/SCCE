import { describe, expect, it } from "vitest";
import {
  buildSurfaceLattice,
  createHasher
} from "../index.js";

describe("universal surface lattice", () => {
  const hasher = createHasher();

  it("builds multiscale evidence-offset units without assuming spaces identify words", () => {
    const text = "猫追鼠。dog chased ball.\ncode_symbol42 = 7";
    const lattice = buildSurfaceLattice({
      documentId: "doc.mixed",
      text,
      sourceVersionId: "source.mixed",
      evidenceIds: ["evidence.mixed"],
      hasher
    });

    expect(lattice.schema).toBe("scce.surface_lattice.v1");
    expect(lattice.units.some(unit => unit.kind === "code_point" && unit.surface === "猫")).toBe(true);
    expect(lattice.units.some(unit => unit.kind === "lexical" && unit.surface.includes("dog"))).toBe(true);
    expect(lattice.units.some(unit => unit.kind === "numeric" && unit.surface === "7")).toBe(true);
    expect(lattice.units.some(unit => unit.kind === "code_symbol" && unit.surface === "code_symbol42")).toBe(true);
    for (const unit of lattice.units) {
      expect(text.slice(unit.utf16Start, unit.utf16End)).toBe(unit.surface);
      expect(unit.evidenceIds).toEqual(["evidence.mixed"]);
      expect(unit.boundaryBefore.bootstrapBoundaryProbability).toBeGreaterThanOrEqual(0);
      expect(unit.boundaryAfter.bootstrapBoundaryProbability).toBeLessThanOrEqual(1);
    }
    expect(lattice.edges.some(edge => edge.kind === "sequence")).toBe(true);
    expect(JSON.stringify(lattice.audit)).toContain("bootstrap_surface_lattice_boundary_v1");
  });

  it("keeps repeated sequence units as exact source spans", () => {
    const text = "red blue. red blue.";
    const lattice = buildSurfaceLattice({
      documentId: "doc.repeat",
      text,
      evidenceIds: ["evidence.repeat"],
      hasher
    });

    const repeated = lattice.units.filter(unit => unit.kind === "repeated_sequence");
    expect(repeated.length).toBeGreaterThan(0);
    for (const unit of repeated) {
      expect(text.slice(unit.utf16Start, unit.utf16End)).toBe(unit.surface);
    }
  });
});
