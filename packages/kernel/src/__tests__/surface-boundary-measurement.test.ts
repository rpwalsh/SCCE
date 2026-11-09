// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
import { afterEach, expect, it, vi } from "vitest";
import * as surfaces from "../surface-lattice.js";
import * as forests from "../segmentation-forest.js";
import { compileBoundaryStatistics, fitBoundaryEstimator } from "../boundary-estimator.js";
import { createLanguageInductionEngine } from "../language-induction.js";
import { canonicalStringify, createHasher } from "../primitives.js";

afterEach(() => vi.restoreAllMocks());

it.each([false, true])("measures the identical partition and sufficient statistics without path materialization (collisions=%s)", collisions => {
  const base = createHasher();
  let paths = 0;
  const hasher = { ...base, digestHex(input: string | Uint8Array) {
    const pathIdentity = typeof input === "string" && input.includes("\u001fsurface_arc.");
    if (pathIdentity) paths++;
    return collisions && pathIdentity ? "0".repeat(64) : base.digestHex(input);
  } };
  const inputs = ["\u732b e\u0301 \ud83d\udc69\u200d\ud83d\udd2c. oma vela, oma neri.", "oma vela. \u041a\u043e\u0442 \u0438 \u732b."]
    .map((text, index) => ({ documentId: `document.${index}`, text, hasher }));
  const measured = inputs.map(surfaces.measureSurfaceBoundaries);
  expect(paths).toBe(0);
  const full = inputs.map(surfaces.buildSurfaceLattice);
  expect(paths).toBeGreaterThan(0);
  expect(measured.map(row => row.units)).toEqual(full.map(row => row.units));
  expect(measured.map(row => row.boundaryMeasurement.boundaryMarginals)).toEqual(full.map(row => row.segmentationForest.boundaryMarginals));
  expect(measured.every(row => !("segmentationForest" in row) && row.boundaryMeasurement.id.startsWith("segmentation_measurement."))).toBe(true);
  const anchors = [{ documentId: "document.0", sourceId: "source.anchor", positionGrapheme: 2, outcome: "boundary" as const, confidence: 1,
    signalKind: "structured_anchor" as const }];
  const oldObservations = surfaces.collectBoundaryTrainingObservations({ lattices: full, anchors });
  const newObservations = surfaces.collectBoundaryTrainingObservations({ lattices: measured, anchors });
  expect(newObservations.map(({ signalId, ...row }) => row)).toEqual(oldObservations.map(({ signalId, ...row }) => row));
  for (const input of inputs) {
    const compile = (observations: typeof oldObservations) => compileBoundaryStatistics({ populationId: "population.fixture", hasher,
      sourceDocumentIds: [input.documentId], observations: observations.filter(row => row.sourceDocumentId === input.documentId) });
    expect(compile(newObservations)).toEqual(compile(oldObservations));
  }
  const context = surfaces.compileBoundaryFeatureContext({ lattices: full, hasher });
  expect(surfaces.compileBoundaryFeatureContext({ lattices: measured, hasher })).toEqual(context);
  const estimator = fitBoundaryEstimator({ statistics: compileBoundaryStatistics({ populationId: "population.fitted", hasher,
    observations: oldObservations, sourceDocumentIds: inputs.map(input => input.documentId) }), hasher });
  const contextualOptions = { ...inputs[0]!, boundaryEstimator: estimator, boundaryFeatureContext: context };
  const contextualMeasurement = surfaces.measureSurfaceBoundaries(contextualOptions);
  const contextualFull = surfaces.buildSurfaceLattice(contextualOptions);
  expect(contextualMeasurement.units).toEqual(contextualFull.units);
  expect(contextualMeasurement.boundaryMeasurement.boundaryMarginals).toEqual(contextualFull.segmentationForest.boundaryMarginals);
  const original = canonicalStringify(measured[0]);
  measured[0]!.units[0]!.surface = "poison";
  expect(canonicalStringify(surfaces.measureSurfaceBoundaries(inputs[0]!))).toBe(original);
  if (!collisions) expect(surfaces.measureSurfaceBoundaries({ ...inputs[0]!, text: `${inputs[0]!.text} changed` }).boundaryMeasurement.id)
    .not.toBe(measured[0]!.boundaryMeasurement.id);
});

it("retains the entire induced model when the original full-forest bootstrap is replaced", () => {
  const hasher = createHasher();
  const documents = ["oma vela. oma neri. \u732b e\u0301.", "oma neri. oma vela. \ud83d\udc69\u200d\ud83d\udd2c."]
    .map((text, index) => ({ id: `owned.${index}`, text }));
  const fullForests = vi.spyOn(forests, "buildSegmentationForest");
  const measured = createLanguageInductionEngine({ hasher }).induce({ documents });
  expect(fullForests).toHaveBeenCalledTimes(documents.length);
  fullForests.mockClear();
  const original = vi.spyOn(surfaces, "measureSurfaceBoundaries").mockImplementation(options => {
    const full = surfaces.buildSurfaceLattice(options);
    return { schema: "scce.surface_boundary_measurement.v1", id: full.id, documentId: full.documentId, units: full.units,
      boundaryMeasurement: { schema: "scce.segmentation_boundary_measurement.v1", id: full.segmentationForest.id,
        latticeId: full.id, estimatorId: full.segmentationForest.estimatorId, normalizationContractId: full.normalizationContract.id,
        graphemeCount: full.segmentationForest.graphemeCount, partitionLogZ: full.segmentationForest.partitionLogZ,
        boundaryMarginals: full.segmentationForest.boundaryMarginals } };
  });
  expect(createLanguageInductionEngine({ hasher }).induce({ documents })).toEqual(measured);
  expect(fullForests).toHaveBeenCalledTimes(documents.length * 2);
  expect(original).toHaveBeenCalledTimes(documents.length);
});
