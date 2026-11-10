// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
import { describe, expect, it, vi } from "vitest";
import { createLanguageInductionEngine } from "../language-induction.js";
import { exportSegmentationAdjacencyFactors } from "../segmentation-forest.js";
import { createSegmentationAdjacencyQuery } from "../segmentation-adjacency-factors.js";
import { canonicalGraphemeSegmenter } from "../normalization-contract.js";
import * as latticeModule from "../surface-lattice.js";
import { canonicalStringify, createHasher } from "../primitives.js";

describe("source-owned segmentation retention without a boundary predictor", () => {
  it("preserves the complete existing non-JOIN learned payload including diagnostic probabilities", () => {
    const model = createLanguageInductionEngine().induce({ documents: [
      { id: "fixture.a", text: "the cat sat. the dog sat. the cat ran. the dog ran." },
      { id: "fixture.b", text: "猫が走る。猫が眠る。" }
    ] });
    const { id: _id, segmentationDocuments: _graphs, audit, ...fields } = model;
    // Complete old payload from independently executed 1051115e, omitting only
    // the replaced JOIN product and its identity/audit identifiers.
    expect(createHasher().digestHex(canonicalStringify({ ...fields, audit })))
      .toBe("7f49aa96842dfb4648e42d187ac557feec21cebcc3f85a5bce5847ce1e26988c");
  });
  it("retains every ordered full-DAG arc, exact energy, normalizer and source coordinate without copying source text", () => {
    const build = latticeModule.buildSurfaceLattice, built: ReturnType<typeof build>[] = [];
    const spy = vi.spyOn(latticeModule, "buildSurfaceLattice").mockImplementation(input => {
      const lattice = build(input); built.push(lattice); return lattice;
    });
    try {
      const documents = [
        { id: "window.a", text: "猫が走る。猫が眠る。", sourceVersionId: "version.a" as never, evidenceIds: ["evidence.a" as never],
          sourceWindow: { ownerDocumentId: "evidence.a", startUtf16: 13, endUtf16: 25 } },
        { id: "window.b", text: "কি কা। কি কা।", sourceVersionId: "version.b" as never, evidenceIds: ["evidence.b" as never] },
        { id: "window.c", text: "é 👩‍👩‍👧‍👦 é 👩‍👩‍👧‍👦." }
      ];
      documents[0]!.sourceWindow!.endUtf16 = 13 + documents[0]!.text.length;
      const model = createLanguageInductionEngine().induce({ documents });
      expect(spy).toHaveBeenCalledTimes(documents.length);
      expect(model).not.toHaveProperty("joinProgram");
      expect(model.audit).not.toHaveProperty("joinProgramId");
      expect(model.segmentationDocuments).toHaveLength(documents.length);
      for (let i = 0; i < documents.length; i++) {
        const source = documents[i]!, lattice = built[i]!, retained = model.segmentationDocuments[i]!;
        expect(retained.graph).toEqual(exportSegmentationAdjacencyFactors(lattice.segmentationForest).factors);
        expect(retained.normalizationContract).toEqual(lattice.normalizationContract);
        expect(retained.sourceVersionId).toEqual(source.sourceVersionId);
        expect(retained.evidenceIds).toEqual(source.evidenceIds ?? []);
        expect(retained.sourceWindow).toEqual(source.sourceWindow ?? { ownerDocumentId: source.id, startUtf16: 0, endUtf16: source.text.length });
        expect(retained).not.toHaveProperty("text"); expect(retained).not.toHaveProperty("units");
        const boundaries = [...canonicalGraphemeSegmenter().segment(source.text)].map(value => value.index); boundaries.push(source.text.length);
        const bounds = new Map((retained.unitUtf16Bounds ?? []).map(([arc, start, end]) => [arc, [start, end]]));
        const exported = exportSegmentationAdjacencyFactors(lattice.segmentationForest);
        const units = new Map(lattice.units.map(unit => [unit.id, unit]));
        exported.unitIds.forEach((id, arc) => {
          const [start, end] = retained.graph.arcs[arc]!, unit = units.get(id)!;
          expect(bounds.get(arc) ?? [boundaries[start], boundaries[end]]).toEqual([unit.utf16Start, unit.utf16End]);
        });
        const bearing = new Set(retained.graph.arcs.map((_, index) => index));
        expect([...createSegmentationAdjacencyQuery(retained.graph, bearing).pairs()])
          .toEqual([...createSegmentationAdjacencyQuery(exported.factors, bearing).pairs()]);
      }
      expect(createLanguageInductionEngine().induce({ documents })).toEqual(model);
    } finally { spy.mockRestore(); }
  });
});
