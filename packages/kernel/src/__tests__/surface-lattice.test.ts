import { describe, expect, it } from "vitest";
import {
  buildSurfaceLattice,
  canonicalSurfaceSequence,
  collectBoundaryTrainingObservations,
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

    expect(lattice.schema).toBe("scce.surface_lattice.v3");
    expect(lattice.units.some(unit => unit.kind === "grapheme" && unit.surface === "猫")).toBe(true);
    expect(lattice.units.some(unit => unit.proposalSources.includes("lexical") && unit.surface.includes("dog"))).toBe(true);
    expect(lattice.units.some(unit => unit.proposalSources.includes("numeric") && unit.surface === "7")).toBe(true);
    expect(lattice.units.some(unit => unit.proposalSources.includes("code_symbol") && unit.surface === "code_symbol42")).toBe(true);
    for (const unit of lattice.units) {
      expect(text.slice(unit.utf16Start, unit.utf16End)).toBe(unit.surface);
      expect(Buffer.from(text, "utf8").subarray(unit.byteStart, unit.byteEnd).toString("utf8")).toBe(unit.surface);
      expect(unit.evidenceIds).toEqual(["evidence.mixed"]);
      expect(unit.boundaryBefore.boundaryProbability).toBe(0.5);
      expect(unit.boundaryAfter.boundaryProbability).toBe(0.5);
      expect(unit.boundaryBefore.estimatorId).toBe("boundary_estimator.untrained-neutral.v1");
    }
    expect(lattice.edges.some(edge => edge.kind === "sequence")).toBe(true);
    expect(lattice.segmentationForest.schema).toBe("scce.segmentation_forest.v2");
    expect(lattice.segmentationForest.paths.length).toBeGreaterThan(0);
    expect(JSON.stringify(lattice.audit)).toContain("untrained_neutral");
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

  it("keeps repeated sequence units as exact source spans and exposes a posterior-ranked canonical sequence", () => {
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
    expect(lattice.segmentationForest.paths.length).toBeGreaterThan(1);
    expect(lattice.segmentationForest.retainedPosteriorMass).toBeGreaterThan(0);
    expect(lattice.segmentationForest.retainedPosteriorMass).toBeLessThanOrEqual(1);
  });

  it("quotients duplicate detector proposals without multiplying occurrence mass", () => {
    const lattice = buildSurfaceLattice({
      documentId: "doc.duplicate-proposals",
      text: "7",
      evidenceIds: ["evidence.duplicate-proposals"],
      hasher
    });
    const exact = lattice.units.filter(unit =>
      unit.byteStart === 0 && unit.byteEnd === 1 && unit.surface === "7");

    expect(exact).toHaveLength(1);
    expect(exact[0]!.proposalSources).toEqual(expect.arrayContaining([
      "grapheme",
      "lexical",
      "numeric"
    ]));
    expect(JSON.stringify(lattice.audit)).toContain("duplicateProposalsCollapsed");
  });

  it("separates occurrence identity from shared unit-class identity", () => {
    const lattice = buildSurfaceLattice({
      documentId: "doc.repeated-class",
      text: "cat cat",
      evidenceIds: ["evidence.repeated-class"],
      hasher
    });
    const cats = lattice.units
      .filter(unit => unit.proposalSources.includes("lexical") && unit.normalized === "cat")
      .sort((left, right) => left.byteStart - right.byteStart);

    expect(cats).toHaveLength(2);
    expect(cats[0]!.occurrenceId).not.toBe(cats[1]!.occurrenceId);
    expect(cats[0]!.unitClassId).toBe(cats[1]!.unitClassId);
    expect(cats[0]!.byteStart).not.toBe(cats[1]!.byteStart);
  });

  it("uses cross-document anchors and packed marginals without detector labels", () => {
    const lattices = [
      buildSurfaceLattice({ documentId: "doc.anchor.a", text: "red blue", hasher }),
      buildSurfaceLattice({ documentId: "doc.anchor.b", text: "red blue", hasher }),
      buildSurfaceLattice({ documentId: "doc.latent", text: "独特文字列", hasher })
    ];
    const observations = collectBoundaryTrainingObservations({ lattices });
    const anchored = observations.filter(row => row.supervision === "independent_anchor");
    const latent = observations.filter(row => row.supervision === "latent_marginal");

    expect(anchored.length).toBeGreaterThan(0);
    expect(anchored.some(row => row.signalKind === "exact_repeated_phrase")).toBe(true);
    expect(latent.length).toBeGreaterThan(0);
    expect(latent.every(row => row.signalKind === "packed_forest_marginal")).toBe(true);
    expect(observations.every(row =>
      !row.signalId.includes("candidate_detector")
      && !row.signalId.includes("bootstrap_endpoint"))).toBe(true);
  });
});
