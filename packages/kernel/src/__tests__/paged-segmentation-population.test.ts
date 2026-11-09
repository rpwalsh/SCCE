// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
import { expect, it } from "vitest";
import { BOUNDARY_FEATURE_ORDER, compileBoundaryStatistics, scoreBoundaryState, type BoundaryFeatureVector, type BoundarySufficientStatistics } from "../boundary-estimator.js";
import { learnSegmentationPopulations, boundaryMixtureForStatistics } from "../segmentation-population.js";
import { learnPagedSegmentationPopulations, validatePagedSegmentationInference } from "../paged-segmentation-population.js";
import type { BoundaryStatisticsCursor, CorpusSegmentationDocumentCursor } from "../corpus-segmentation-cursor.js";
import { fixtureSegmentationScratch } from "./fixtures/corpus-segmentation-scratch.js";
import { createHasher } from "../primitives.js";

const hasher = createHasher();
const joined = { ...Object.fromEntries(BOUNDARY_FEATURE_ORDER.map(key => [key, 0])), localTransitionEntropy: 0.5, repeatedContextSupport: 0.5 } as unknown as BoundaryFeatureVector;
const spaced = { ...joined, whitespaceAdjacent: 1, crossDocumentRecurrence: 0.5, predictiveCompressionGain: 0.4,
  stableSubstitutionSupport: 0.2, exactPhraseRecurrence: 0.5, constructionReuse: 0.2 };
function data() {
  return Array.from({ length: 20 }, (_, index) => {
    const documentId = `doc.${index < 10 ? "a" : "b"}.${String(index).padStart(2, "0")}`;
    return { documentId, sourceFamilyId: documentId, statistics: compileBoundaryStatistics({ populationId: "population.test", sourceDocumentIds: [documentId], hasher,
      observations: [spaced, joined].map((features, vector) => ({ sourceDocumentId: documentId, features,
        positiveMass: (index < 10) === (vector === 0) ? 120 : 1, negativeMass: (index < 10) === (vector === 0) ? 1 : 120,
        supervision: "independent_anchor" as const, signalKind: "external_anchor" as const, signalId: `${documentId}.${vector}` })) }) };
  });
}
function cursor(statistics: BoundarySufficientStatistics, pageRows: number): BoundaryStatisticsCursor {
  const { rows, sourceDocumentIds, ...header } = statistics;
  return { header: { ...header, rowCount: rows.length, sourceInventory: { id: hasher.digestHex(JSON.stringify(sourceDocumentIds)), count: sourceDocumentIds.length } },
    async *rows() { for (let index = 0; index < rows.length; index += pageRows) yield rows.slice(index, index + pageRows); },
    async *sourceDocuments() { yield sourceDocumentIds; } };
}
function source(documents: ReturnType<typeof data>, pageRows: number): CorpusSegmentationDocumentCursor {
  const metadata = documents.map((document, ordinal) => ({ ordinal, documentId: document.documentId, sourceFamilyId: document.sourceFamilyId,
    statistics: cursor(document.statistics, pageRows).header }));
  return { documentCount: metadata.length, sourceInventory: { id: hasher.digestHex(JSON.stringify(metadata.map(row => row.documentId).sort())), count: metadata.length },
    scratch: fixtureSegmentationScratch(pageRows),
    async *documents() { for (let index = metadata.length; index > 0; index -= pageRows) yield metadata.slice(Math.max(0, index - pageRows), index).reverse(); },
    statistics(document) { const row = documents[document.ordinal]; if (!row || row.documentId !== document.documentId) throw new Error("fixture ownership changed"); return cursor(row.statistics, pageRows); } };
}

it.each([{ pageRows: 1, collisions: false }, { pageRows: 3, collisions: false }, { pageRows: 2, collisions: true }])("retains real heldout population selection and inference on $pageRows-row spill pages (collisions=$collisions)", async ({ pageRows, collisions }) => {
  const documents = data();
  const fitHasher = { ...hasher, digestHex(input: string | Uint8Array) { return collisions && typeof input === "string" && input.startsWith("segmentation-population-") ? "0".repeat(64) : hasher.digestHex(input); } };
  const expected = learnSegmentationPopulations({ rootPopulationId: "population.test", documents, maxPopulations: 2, hasher: fitHasher });
  const measured = await learnPagedSegmentationPopulations({ rootPopulationId: "population.test", source: source(documents, pageRows), namespace: "fit",
    featureContextId: "context.owned", maxPopulations: 2, hasher: fitHasher });
  expect(measured.model.selection).toEqual(Object.fromEntries(Object.entries(expected.selection).filter(([key]) => ["sourceFamilyDisjoint", "selectedPopulationCount",
    "baselineDescriptionNats", "selectedDescriptionNats", "mdlGainNats", "finalEvaluationNats", "candidates"].includes(key))));
  expect(measured.model.selection.selectedPopulationCount).toBe(collisions ? 1 : 2);
  expect(measured.model.populations.map(row => row.prior)).toEqual(expected.populations.map(row => row.prior));
  expect(measured.model.populations.map(row => [row.estimator.weights, row.estimator.intercept, row.estimator.calibration.slope, row.estimator.calibration.intercept]))
    .toEqual(expected.populations.map(row => [row.estimator.weights, row.estimator.intercept, row.estimator.calibration.slope, row.estimator.calibration.intercept]));
  expect(measured.model.collapseGuard.map(({ leftPopulationId: _left, rightPopulationId: _right, ...values }) => values))
    .toEqual(expected.collapseGuard.map(({ leftPopulationId: _left, rightPopulationId: _right, ...values }) => values));
  const actualMixture = boundaryMixtureForStatistics(measured.model, "unseen.\u732b", documents[0]!.statistics, hasher);
  const expectedMixture = boundaryMixtureForStatistics(expected, "unseen.\u732b", documents[0]!.statistics, hasher);
  expect(scoreBoundaryState(actualMixture, spaced)).toBe(scoreBoundaryState(expectedMixture, spaced));
  expect(scoreBoundaryState(actualMixture, joined)).toBe(scoreBoundaryState(expectedMixture, joined));
  expect(validatePagedSegmentationInference(JSON.parse(JSON.stringify(measured.model)))).toEqual(measured.model);
  const tampered = JSON.parse(JSON.stringify(measured.model)); tampered.populations[0].estimator.weights[0] += 0.01;
  expect(() => validatePagedSegmentationInference(tampered)).toThrow("digest changed");
  expect("assignments" in measured.model).toBe(false);
  expect("assignmentIndex" in measured.model).toBe(false);
});

it("refuses incomplete or repeated owned document inventories before fitting", async () => {
  const documents = data().slice(0, 4); const incomplete = source(documents, 1); incomplete.documentCount++;
  await expect(learnPagedSegmentationPopulations({ rootPopulationId: "population.test", source: incomplete, namespace: "fit", featureContextId: "context.owned" }))
    .rejects.toThrow("inventory changed");
  const duplicate = source(documents, 2); const read = duplicate.documents;
  duplicate.documents = async function*() { for await (const page of read()) yield page.map(document => ({ ...document, ordinal: 0 })); };
  await expect(learnPagedSegmentationPopulations({ rootPopulationId: "population.test", source: duplicate, namespace: "fit", featureContextId: "context.owned" }))
    .rejects.toThrow("ownership repeats");
});
