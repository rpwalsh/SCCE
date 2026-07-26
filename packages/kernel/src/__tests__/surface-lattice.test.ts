import { describe, expect, it } from "vitest";
import {
  buildSurfaceLattice,
  canonicalSurfaceSequence,
  createHasher,
  validateSurfaceLattice
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

    expect(lattice.schema).toBe("scce.surface_lattice.v2");
    expect(lattice.units.some(unit => unit.kind === "grapheme" && unit.surface === "猫")).toBe(true);
    expect(lattice.units.some(unit => unit.kind === "lexical" && unit.surface.includes("dog"))).toBe(true);
    expect(lattice.units.some(unit => unit.kind === "numeric" && unit.surface === "7")).toBe(true);
    expect(lattice.units.some(unit => unit.kind === "code_symbol" && unit.surface === "code_symbol42")).toBe(true);
    for (const unit of lattice.units) {
      expect(text.slice(unit.utf16Start, unit.utf16End)).toBe(unit.surface);
      expect(Buffer.from(text, "utf8").subarray(unit.byteStart, unit.byteEnd).toString("utf8")).toBe(unit.surface);
      expect(unit.evidenceIds).toEqual(["evidence.mixed"]);
      expect(unit.boundaryBefore.bootstrapBoundaryProbability).toBeGreaterThanOrEqual(0);
      expect(unit.boundaryAfter.bootstrapBoundaryProbability).toBeLessThanOrEqual(1);
    }
    expect(lattice.edges.some(edge => edge.kind === "sequence")).toBe(true);
    expect(JSON.stringify(lattice.audit)).toContain("bootstrap_surface_lattice_boundary_v2");
    expect(validateSurfaceLattice(lattice, text)).toEqual({ valid: true, issues: [] });
  });

  it("retains exact bytes and a complete grapheme partition under a unit cap", () => {
    const samples = [
      "e\u0301 👩🏽‍💻\u0000\r\n",
      "العربية हिन्दी ภาษาไทย",
      "🇺🇳क्‍षि中文かな한글",
      "<table><tr><td>A|B</td></tr></table>\tC",
      "\"quoted\" 2026-07-25 1,234.50%"
    ];
    for (const [index, text] of samples.entries()) {
      const lattice = buildSurfaceLattice({
        documentId: `doc.unicode.${index}`,
        text,
        hasher,
        maxUnits: 1,
        maxEdges: 1
      });
      const validation = validateSurfaceLattice(lattice, text);
      expect(validation, validation.issues.join(",")).toEqual({ valid: true, issues: [] });
      const base = lattice.units
        .filter(unit => unit.kind === "grapheme")
        .sort((left, right) => left.utf16Start - right.utf16Start);
      expect(base.map(unit => unit.surface).join("")).toBe(text);
      expect(base.length).toBe([...new Intl.Segmenter(undefined, { granularity: "grapheme" }).segment(text)].length);
      expect(lattice.edges.filter(edge => edge.kind === "sequence").length).toBeGreaterThanOrEqual(Math.max(0, base.length - 1));
    }
  });

  it("retains overlapping phrase, date, quote, markup, and table hypotheses", () => {
    const text = "<p>On 2026-07-25, \"red blue\" won.</p>\nname|score\nAda|7";
    const lattice = buildSurfaceLattice({
      documentId: "doc.structures",
      text,
      evidenceIds: ["evidence.structures"],
      hasher,
      maxEdges: 20_000
    });
    const kinds = new Set(lattice.units.map(unit => unit.kind));
    expect([...kinds]).toEqual(expect.arrayContaining([
      "phrase_candidate",
      "date",
      "quote",
      "markup_structure",
      "table_cell"
    ]));
    expect(lattice.edges.some(edge => edge.kind === "licensed_overlap")).toBe(true);
  });

  it("keeps repeated sequence units as exact source spans and exposes one canonical sequence", () => {
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
    const canonical = canonicalSurfaceSequence(lattice);
    expect(canonical.length).toBeGreaterThan(0);
    expect(canonical.every((unit, index) => index === 0 || canonical[index - 1]!.utf16Start <= unit.utf16Start)).toBe(true);
  });
});
