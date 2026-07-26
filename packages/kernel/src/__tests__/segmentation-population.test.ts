import { describe, expect, it } from "vitest";
import {
  boundaryMixtureForDocument,
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
    expect(model.selection.mdlGainNats).toBeGreaterThan(0);
    expect(model.populations.every(population => population.documentIds.length >= 2)).toBe(true);
    const familyA = boundaryMixtureForDocument(model, "doc.a.01", hasher);
    const familyB = boundaryMixtureForDocument(model, "doc.b.11", hasher);
    expect(scoreBoundaryState(familyA, spaced)).toBeGreaterThan(scoreBoundaryState(familyA, joined));
    expect(scoreBoundaryState(familyB, spaced)).toBeLessThan(scoreBoundaryState(familyB, joined));
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
});
