// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
import { expect, it } from "vitest";
import { BOUNDARY_FEATURE_ORDER, compileBoundaryStatistics, fitBoundaryEstimator, boundaryNegativeLogLikelihood, scoreBoundary,
  type BoundaryFeatureVector, type BoundarySufficientStatistics } from "../boundary-estimator.js";
import { fitPagedBoundaryEstimator, pagedBoundaryNegativeLogLikelihood } from "../paged-boundary-estimator.js";
import type { BoundaryStatisticsCursor } from "../corpus-segmentation-cursor.js";
import { createHasher } from "../primitives.js";

const hasher = createHasher();
function statistics(owner: string): BoundarySufficientStatistics {
  return compileBoundaryStatistics({ populationId: "population.opaque", hasher, sourceDocumentIds: [owner],
    observations: Array.from({ length: 19 }, (_, index) => ({ sourceDocumentId: owner, signalId: `${owner}.${index}`,
      features: Object.fromEntries(BOUNDARY_FEATURE_ORDER.map((key, feature) => [key, ((index * 13 + feature * 7) % 19) / 19])) as unknown as BoundaryFeatureVector,
      positiveMass: (index % 7) / 4, negativeMass: (index % 5) / 3,
      supervision: "independent_anchor" as const, signalKind: "external_anchor" as const })) });
}

function cursor(statistics: BoundarySufficientStatistics, pageRows: number): BoundaryStatisticsCursor {
  const { rows, sourceDocumentIds, ...header } = statistics;
  return { header: { ...header, rowCount: rows.length, sourceInventory: { id: hasher.digestHex(JSON.stringify(sourceDocumentIds)), count: sourceDocumentIds.length } },
    async *rows() { for (let index = 0; index < rows.length; index += pageRows) yield rows.slice(index, index + pageRows); },
    async *sourceDocuments() { for (let index = 0; index < sourceDocumentIds.length; index += pageRows) yield sourceDocumentIds.slice(index, index + pageRows); } };
}

it.each([1, 3, 17])("fits and calibrates bit-identically over replayable %i-row pages", async pageRows => {
  const training = statistics("owned.\u732b"); const heldout = statistics("owned.e\u0301");
  const expected = fitBoundaryEstimator({ statistics: training, calibrationStatistics: heldout, calibrationShards: [heldout], hasher });
  const measured = await fitPagedBoundaryEstimator({ statistics: cursor(training, pageRows), calibrationStatistics: cursor(heldout, pageRows),
    calibrationShards: async function*() { yield cursor(heldout, pageRows); }, hasher });
  expect(measured.weights).toEqual(expected.weights);
  expect(measured.intercept).toBe(expected.intercept);
  expect(measured.training).toEqual(expected.training);
  const { heldoutSourceDocumentIds: _ids, ...expectedCalibration } = expected.calibration;
  const { heldoutSourceInventory: inventory, ...actualCalibration } = measured.calibration;
  expect(actualCalibration).toEqual(expectedCalibration);
  expect(inventory).toEqual(cursor(heldout, pageRows).header.sourceInventory);
  expect(await pagedBoundaryNegativeLogLikelihood(measured, cursor(training, pageRows))).toEqual(boundaryNegativeLogLikelihood(expected, training));
  const features = Object.fromEntries(BOUNDARY_FEATURE_ORDER.map((key, index) => [key, index / BOUNDARY_FEATURE_ORDER.length])) as unknown as BoundaryFeatureVector;
  expect(scoreBoundary(measured, features)).toBe(scoreBoundary(expected, features));
});

it("rejects overlapping or incomplete canonical snapshots rather than fitting their prefix", async () => {
  const training = statistics("source.same");
  await expect(fitPagedBoundaryEstimator({ statistics: cursor(training, 3), calibrationStatistics: cursor(training, 1) })).rejects.toThrow("overlap");
  const incomplete = cursor(training, 3);
  incomplete.header.rowCount++;
  await expect(fitPagedBoundaryEstimator({ statistics: incomplete })).rejects.toThrow("inventory changed");
  const reordered = cursor(training, 3);
  reordered.rows = async function*() { yield [...training.rows].reverse(); };
  await expect(fitPagedBoundaryEstimator({ statistics: reordered })).rejects.toThrow("not canonical");
});
