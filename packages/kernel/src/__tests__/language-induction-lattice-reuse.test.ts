// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
import { describe, expect, it, vi } from "vitest";
import { createLanguageInductionEngine } from "../language-induction.js";
import { canonicalStringify, createHasher } from "../primitives.js";
import { createSegmentationAdjacencyQuery } from "../segmentation-adjacency-factors.js";
import { joinProgramChoices } from "../join-program.js";
import { replaySemanticInductionFactors } from "../semantic-induction-factors.js";
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
      expect(build).toHaveBeenCalledTimes(documents.length);
      const { id: _modelId, joinProgram: _joinProgram, semanticInductionFactors: sufficientFacts, audit: fullAudit, ...nonJoin } = first;
      const { joinProgramId: _joinId, joinProgramComponentIds: _componentIds, ...audit } = fullAudit as Record<string, unknown>;
      // All non-JOIN fields match the complete pre-repair artifact at 5bd251b1.
      expect(hasher.digestHex(canonicalStringify({ ...nonJoin, audit }))).toBe("ffe1198e627f5885f730a958c4beba285d7b4a34b11e5c0e0e876cb212174a01");
      expect(sufficientFacts).toBeDefined();
      const semanticReplay = replaySemanticInductionFactors({ factors: sufficientFacts, hasher });
      expect(semanticReplay.semanticFrames).toEqual(first.semanticFrames);
      expect(semanticReplay.graphBoundConstructions).toEqual(first.graphBoundConstructions);
      expect(semanticReplay.relationHypothesisModel).toEqual(first.relationHypothesisModel);
      for (const { program } of first.joinProgram.components) {
        expect(program.exactIndex).toEqual({}); expect(program.classIndex).toEqual({});
        const factors = program.localFactors!;
        expect(factors.documents.map(document => document.documentId).sort()).toEqual(documents.map(document => document.id).sort());
        let fullLocalMass = 0;
        for (const document of factors.documents) {
          expect(document.contexts.every(context => context.length === 1)).toBe(true);
          expect(Object.keys(document.graph).sort()).toEqual(["arcs", "nodeCount", "schema"]);
          const bearing = new Set(document.units.flatMap((unit, index) => unit ? [index] : []));
          for (const pair of createSegmentationAdjacencyQuery(document.graph, bearing).pairs()) fullLocalMass += pair.posterior;
        }
        expect(program.observations).toBeCloseTo(fullLocalMass, 10);
        expect(program.conditionedIndex).toEqual({}); expect(program.structuralIndex).toEqual({});
        const retainedPaths = program.globalFactors!.documents.flatMap(document => document.paths);
        expect(program.observations).toBeGreaterThan(retainedPaths.reduce((sum, [posterior]) => sum + posterior, 0));
        expect(retainedPaths.some(([posterior]) => posterior > 0 && posterior < 1)).toBe(true);
        const queried = joinProgramChoices(program, "exact", JSON.stringify(["the", "cat"]));
        expect(queried.length).toBeGreaterThan(0);
        expect(queried.every(choice => choice.count > 0)).toBe(true);
        expect(program.exactIndex).toEqual({});
      }
      const replay = engine.induce({ documents });
      expect(replay).toEqual(first);
      expect(build).toHaveBeenCalledTimes(2 * documents.length);
    } finally {
      build.mockRestore();
    }
  });
});
