// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
import { expect, it } from "vitest";
import { compileBoundaryStatistics, type BoundaryFeatureVector } from "../boundary-estimator.js";
import { learnSegmentationPopulations } from "../segmentation-population.js";
import { createHasher } from "../primitives.js";

it("does not rebuild converged population statistics when the final training set is unchanged", () => {
  const base = createHasher();
  let candidateMerges = 0;
  const hasher = { ...base, digestHex(value: string | Uint8Array) {
    if (typeof value === "string" && value.startsWith('{"schema":"scce.boundary_statistics.v2"')) {
      const record = JSON.parse(value) as { populationId: string };
      if (record.populationId === "population.reuse.candidate.1.0") candidateMerges++;
    }
    return base.digestHex(value);
  } };
  const features: BoundaryFeatureVector = { whitespaceAdjacent: 1, punctuationAdjacent: 0,
    lineBreakAdjacent: 0, scriptTransition: 0, structuralBoundary: 0, localTransitionEntropy: 0.5,
    repeatedContextSupport: 0.5, crossDocumentRecurrence: 0.25, predictiveCompressionGain: 0.25,
    stableSubstitutionSupport: 0, exactPhraseRecurrence: 0, constructionReuse: 0 };
  const documents = Array.from({ length: 4 }, (_, index) => {
    const documentId = `document.${index}`;
    return { documentId, sourceFamilyId: "family.shared", statistics: compileBoundaryStatistics({
      populationId: "population.reuse", sourceDocumentIds: [documentId], hasher,
      observations: [{ sourceDocumentId: documentId, features, positiveMass: index + 2, negativeMass: 1,
        supervision: "independent_anchor", signalKind: "external_anchor", signalId: `${documentId}.anchor` }] }) };
  });
  const model = learnSegmentationPopulations({ rootPopulationId: "population.reuse", documents, maxPopulations: 1, hasher });
  expect(base.digestHex(JSON.stringify(model))).toBe("b3c5c05bc7b5f9654bde58180184f5e07b956a11f37769b606dac834c4ac3e38");
  expect(model.populations[0]!.documentIds).toEqual(documents.map(row => row.documentId));
  expect(model.selection.fitDocumentIds).toEqual(documents.map(row => row.documentId));
  expect(model.selection.modelSelectionDocumentIds).toEqual([]);
  expect(model.selection.mergeGuardDocumentIds).toEqual([]);
  expect(candidateMerges).toBe(1);
});
