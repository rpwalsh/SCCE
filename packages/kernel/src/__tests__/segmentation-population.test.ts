import { describe, expect, it } from "vitest";
import {
  buildSurfaceLattice,
  boundaryMixtureForDocument,
  collectBoundaryTrainingObservations,
  compileBoundaryStatistics,
  createHasher,
  learnSegmentationPopulations,
  scoreBoundaryState,
  type BoundaryFeatureVector
} from "../index.js";

const spaced: BoundaryFeatureVector = {
  whitespaceAdjacent: 1,
  punctuationAdjacent: 0,
  lineBreakAdjacent: 0,
  scriptTransition: 0,
  structuralBoundary: 0,
  localTransitionEntropy: 0.5,
  repeatedContextSupport: 0.5,
  crossDocumentRecurrence: 0.5,
  predictiveCompressionGain: 0.4,
  stableSubstitutionSupport: 0.2,
  exactPhraseRecurrence: 0.5,
  constructionReuse: 0.2
};

const joined: BoundaryFeatureVector = {
  whitespaceAdjacent: 0,
  punctuationAdjacent: 0,
  lineBreakAdjacent: 0,
  scriptTransition: 0,
  structuralBoundary: 0,
  localTransitionEntropy: 0.5,
  repeatedContextSupport: 0.5,
  crossDocumentRecurrence: 0,
  predictiveCompressionGain: 0,
  stableSubstitutionSupport: 0,
  exactPhraseRecurrence: 0,
  constructionReuse: 0
};

describe("segmentation population induction", () => {
  it("selects a non-collapsed corpus-derived mixture only when held-out MDL improves", () => {
    const hasher = createHasher();
    const documents = Array.from({ length: 20 }, (_, index) => {
      const family = index < 10 ? "a" : "b";
      const prefersSpaced = family === "a";
      const documentId = `doc.${family}.${String(index).padStart(2, "0")}`;
      return {
        documentId,
        statistics: compileBoundaryStatistics({
          populationId: "population.test",
          sourceDocumentIds: [documentId],
          observations: [
            {
              sourceDocumentId: documentId,
              features: spaced,
              positiveMass: prefersSpaced ? 120 : 1,
              negativeMass: prefersSpaced ? 1 : 120,
              supervision: "independent_anchor",
              signalKind: "external_anchor",
              signalId: `${documentId}.spaced`
            },
            {
              sourceDocumentId: documentId,
              features: joined,
              positiveMass: prefersSpaced ? 1 : 120,
              negativeMass: prefersSpaced ? 120 : 1,
              supervision: "independent_anchor",
              signalKind: "external_anchor",
              signalId: `${documentId}.joined`
            }
          ],
          hasher
        })
      };
    });

    const model = learnSegmentationPopulations({
      rootPopulationId: "population.test",
      documents,
      maxPopulations: 4,
      hasher
    });

    expect(model.selection.holdoutDocumentIds.length).toBeGreaterThan(0);
    expect(model.selection.selectedPopulationCount).toBe(2);
    expect(model.selection.candidates.find(candidate =>
      candidate.populations === 1)?.mergeBlocked).toBe(true);
    expect(model.populations.every(population => population.documentIds.length >= 2)).toBe(true);
    const familyA = boundaryMixtureForDocument(model, "doc.a.01", hasher);
    const familyB = boundaryMixtureForDocument(model, "doc.b.11", hasher);
    expect(scoreBoundaryState(familyA, spaced)).toBeGreaterThan(scoreBoundaryState(familyA, joined));
    expect(scoreBoundaryState(familyB, spaced)).toBeLessThan(scoreBoundaryState(familyB, joined));
    const assignment = model.assignments.find(row => row.documentId === "doc.a.01")!;
    const logWeights = assignment.posterior.map(row => {
      const prior = model.populations.find(population => population.id === row.populationId)!.prior;
      return Math.log(prior) - row.negativeLogLikelihood;
    });
    const maximum = Math.max(...logWeights);
    const denominator = logWeights.reduce((sum, value) =>
      sum + Math.exp(value - maximum), 0);
    assignment.posterior.forEach((row, index) => {
      expect(row.probability).toBeCloseTo(
        Math.exp(logWeights[index]! - maximum) / denominator,
        10
      );
    });
  });

  it("is invariant to input document order", () => {
    const hasher = createHasher();
    const documents = ["a", "b", "c", "d"].map((id, index) => ({
      documentId: `doc.${id}`,
      statistics: compileBoundaryStatistics({
        populationId: "population.stable",
        sourceDocumentIds: [`doc.${id}`],
        observations: [{
          sourceDocumentId: `doc.${id}`,
          features: index % 2 ? spaced : joined,
          positiveMass: 4,
          negativeMass: 1,
          supervision: "independent_anchor",
          signalKind: "external_anchor",
          signalId: `doc.${id}.anchor`
        }],
        hasher
      })
    }));
    const left = learnSegmentationPopulations({
      rootPopulationId: "population.stable",
      documents,
      hasher
    });
    const right = learnSegmentationPopulations({
      rootPopulationId: "population.stable",
      documents: [...documents].reverse(),
      hasher
    });
    expect(left).toEqual(right);
  });

  it("does not merge a rare coherent population into a much larger population", () => {
    const hasher = createHasher();
    const documents = Array.from({ length: 50 }, (_, index) => {
      const rare = index >= 40;
      const documentId = `doc.opaque.${String(index).padStart(2, "0")}`;
      return {
        documentId,
        statistics: compileBoundaryStatistics({
          populationId: "population.rare-guard",
          sourceDocumentIds: [documentId],
          observations: [{
            sourceDocumentId: documentId,
            features: rare ? joined : spaced,
            positiveMass: rare ? 1 : 80,
            negativeMass: rare ? 80 : 1,
            supervision: "independent_anchor",
            signalKind: "external_anchor",
            signalId: `${documentId}.anchor`
          }],
          hasher
        })
      };
    });
    const model = learnSegmentationPopulations({
      rootPopulationId: "population.rare-guard",
      documents,
      maxPopulations: 2,
      hasher
    });

    expect(model.selection.selectedPopulationCount).toBe(2);
    expect(model.selection.candidates.find(candidate =>
      candidate.populations === 1)?.mergeBlocked).toBe(true);
    expect(model.populations.map(population => population.documentIds.length).sort((a, b) => a - b))
      .toEqual([10, 40]);
  });

  it("learns through one script-neutral path without language-name inputs", () => {
    const hasher = createHasher();
    const surfaces = [
      "the river bends",
      "النهر ينحني",
      "강이 굽는다",
      "河流弯曲",
      "let value = 함수(값)",
      "◈◆◇ ◈◆◇"
    ];
    const lattices = surfaces.map((text, index) =>
      buildSurfaceLattice({
        documentId: `doc.surface.${index}`,
        text,
        hasher
      }));
    const observations = collectBoundaryTrainingObservations({ lattices });
    const documents = lattices.map(lattice => ({
      documentId: lattice.documentId,
      statistics: compileBoundaryStatistics({
        populationId: "population.script-neutral",
        observations: observations.filter(row =>
          row.sourceDocumentId === lattice.documentId),
        sourceDocumentIds: [lattice.documentId],
        hasher
      })
    }));
    const model = learnSegmentationPopulations({
      rootPopulationId: "population.script-neutral",
      documents,
      maxPopulations: 2,
      hasher
    });
    const audit = JSON.stringify(model.audit);

    expect(model.assignments).toHaveLength(surfaces.length);
    expect(audit).toContain("\"scriptMetadataUsed\":false");
    expect(audit).not.toMatch(/English|Arabic|Korean|Chinese/);
  });
});
