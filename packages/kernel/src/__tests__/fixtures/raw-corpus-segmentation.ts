// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
import { measureSurfaceBoundaries, compileBoundaryFeatureContext, collectBoundaryTrainingObservations, corpusSegmentationContextSliceDigest } from "../../surface-lattice.js";
import { compileBoundaryStatistics } from "../../boundary-estimator.js";
import { learnPagedSegmentationPopulations } from "../../paged-segmentation-population.js";
import type { BoundaryStatisticsCursor, CorpusSegmentationBatchLoader, CorpusSegmentationDocumentCursor } from "../../corpus-segmentation-cursor.js";
import type { LanguageInductionDocument } from "../../language-induction.js";
import { createHasher } from "../../primitives.js";
import { fixtureSegmentationScratch } from "./corpus-segmentation-scratch.js";

export async function rawCorpusSegmentationFixture() {
  const hasher = createHasher();
  const surfaces = ["oma vela. oma neri.", "oma neri. oma vela.", "\u732b\u304c\u8df3\u3076\u3002\u72ac\u304c\u8d70\u308b\u3002", "\u72ac\u304c\u8d70\u308b\u3002\u732b\u304c\u8df3\u3076\u3002",
    "\u0416\u0443\u043a \u043b\u0435\u0442\u0438\u0442. \u041a\u043e\u0442 \u0431\u0435\u0436\u0438\u0442.", "\u041a\u043e\u0442 \u0431\u0435\u0436\u0438\u0442. \u0416\u0443\u043a \u043b\u0435\u0442\u0438\u0442.", "e\u0301lan visite. ela neri.", "ela neri. e\u0301lan visite."];
  const documents: LanguageInductionDocument[] = surfaces.map((text, index) => ({ id: `source.authored.${index}`, text }));
  const measurements = documents.map(document => measureSurfaceBoundaries({ documentId: document.id, text: document.text, hasher }));
  const context = compileBoundaryFeatureContext({ lattices: measurements, hasher });
  const observations = collectBoundaryTrainingObservations({ lattices: measurements, featureContext: context });
  const statistics = documents.map(document => compileBoundaryStatistics({ populationId: "population.raw", sourceDocumentIds: [document.id], hasher,
    observations: observations.filter(row => row.sourceDocumentId === document.id) }));
  const cursors: BoundaryStatisticsCursor[] = statistics.map(statistics => {
    const { rows, sourceDocumentIds, ...header } = statistics;
    return { header: { ...header, rowCount: rows.length, sourceInventory: { id: hasher.digestHex(JSON.stringify(sourceDocumentIds)), count: sourceDocumentIds.length } },
      async *rows() { for (const row of rows) yield [row]; }, async *sourceDocuments() { yield sourceDocumentIds; } };
  });
  const source: CorpusSegmentationDocumentCursor = { documentCount: documents.length,
    sourceInventory: { id: hasher.digestHex(JSON.stringify(documents)), count: documents.length }, scratch: fixtureSegmentationScratch(3),
    async *documents() { for (let ordinal = 0; ordinal < documents.length; ordinal++) yield [{ ordinal, documentId: documents[ordinal]!.id,
      sourceFamilyId: documents[ordinal]!.id, statistics: cursors[ordinal]!.header }]; },
    statistics(document) { return cursors[document.ordinal]!; } };
  const { model } = await learnPagedSegmentationPopulations({ rootPopulationId: "population.raw", source, namespace: "fixture.fit", featureContextId: context.id, maxPopulations: 2, hasher });
  const loader: CorpusSegmentationBatchLoader = { identity: { id: model.id, featureContextId: model.featureContextId,
    sourceInventory: model.sourceInventory, normalizationContractId: model.normalizationContractId },
    async resolve(preparations) { return { populationInference: model, slices: preparations.map(preparation => {
      const featureContext = { ...context,
        documentCountBySurfaceFormClass: Object.fromEntries(preparation.requiredClassIds.map(key => [key, context.documentCountBySurfaceFormClass[key] ?? 0])),
        classCountByBoundaryContext: Object.fromEntries(preparation.requiredContextKeys.map(key => [key, context.classCountByBoundaryContext[key] ?? 0])) };
      const binding = { measurementId: preparation.id, snapshotId: model.sourceInventory.id, sourceInventory: model.sourceInventory,
        contextId: model.featureContextId, normalizationContractId: model.normalizationContractId };
      return { preparation, contextSlice: { featureContext, binding: { ...binding, valueDigest: corpusSegmentationContextSliceDigest({ featureContext, binding }, hasher) } } };
    }) }; } };
  return { hasher, model, context, loader };
}
