// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
import { describe, expect, it, vi } from "vitest";
import { createLanguageInductionEngine } from "../language-induction.js";
import { canonicalStringify, createHasher } from "../primitives.js";
import { createSegmentationAdjacencyQuery } from "../segmentation-adjacency-factors.js";
import { replaySemanticInductionFactors } from "../semantic-induction-factors.js";
import {
  sourceSegmentationArcObservation,
  sourceSegmentationSurfaceBearingArcIndices
} from "../source-segmentation-witness.js";
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
      { id: "fixture.alpha", evidenceIds: ["evidence.alpha" as never], text: "the cat sat. the dog sat. the cat ran. the dog ran. the cat sat. the dog ran." },
      { id: "fixture.beta", evidenceIds: ["evidence.beta" as never], text: "a fox slept. a wolf slept. a fox walked. a wolf walked. a fox slept. a wolf walked." }
    ];
    const hasher = createHasher();
    const build = vi.spyOn(surfaceLattice, "buildSurfaceLattice");
    try {
      const engine = createLanguageInductionEngine({ hasher });
      const first = engine.induce({ documents });
      expect(build).toHaveBeenCalledTimes(documents.length);
      const { id: _modelId, segmentationWitness: _segmentationWitness, semanticInductionFactors: sufficientFacts, audit: fullAudit, ...nonSegmentation } = first;
      const { segmentationWitnessId: _witnessId, segmentationWitnessPopulationIds: _populationIds, ...audit } = fullAudit as Record<string, unknown>;
      // Independently learned fields stay pinned while the source witness representation evolves.
      expect(hasher.digestHex(canonicalStringify({ ...nonSegmentation, audit }))).toBe("85fedc2dc7a91a97c43cbd85c13e83cdd14a5a4f4a335e7704a16f1b75f08fe5");
      expect(sufficientFacts).toBeDefined();
      const semanticReplay = replaySemanticInductionFactors({ factors: sufficientFacts, hasher });
      expect(semanticReplay.semanticFrames).toEqual(first.semanticFrames);
      expect(semanticReplay.graphBoundConstructions).toEqual(first.graphBoundConstructions);
      expect(semanticReplay.relationHypothesisModel).toEqual(first.relationHypothesisModel);
      const witnessedDocuments = first.segmentationWitness.populations.flatMap(population => population.documents);
      expect(witnessedDocuments.map(document => document.documentId).sort()).toEqual(documents.map(document => document.id).sort());
      let fullAdjacencyMass = 0;
      const retainedPosteriorMass = witnessedDocuments.reduce((sum, document) =>
        sum + document.lattice.segmentationForest.retainedPosteriorMass, 0);
      for (const document of witnessedDocuments) {
        expect(Object.keys(document.fullDag.factors).sort()).toEqual(["arcs", "nodeCount", "schema"]);
        expect(document.lattice.segmentationForest.retainedPathCount).toBeGreaterThan(0);
        expect(document.lattice.segmentationForest.retainedPathDigest).toMatch(/^[a-f0-9]{64}$/u);
        const bearing = new Set(sourceSegmentationSurfaceBearingArcIndices(document));
        for (const pair of createSegmentationAdjacencyQuery(document.fullDag.factors, bearing).pairs()) {
          fullAdjacencyMass += pair.posterior;
          const left = sourceSegmentationArcObservation(document, pair.leftArcIndex);
          const right = sourceSegmentationArcObservation(document, pair.rightArcIndex);
          expect(document.text.slice(left.utf16End, right.utf16Start)).toBe(documents.find(row => row.id === document.documentId)!.text.slice(left.utf16End, right.utf16Start));
          expect([...new Set([...left.evidenceIds, ...right.evidenceIds])].length).toBeGreaterThan(0);
        }
      }
      expect(fullAdjacencyMass).toBeGreaterThan(retainedPosteriorMass);
      const replay = engine.induce({ documents });
      expect(replay).toEqual(first);
      expect(build).toHaveBeenCalledTimes(2 * documents.length);
    } finally {
      build.mockRestore();
    }
  });
});
