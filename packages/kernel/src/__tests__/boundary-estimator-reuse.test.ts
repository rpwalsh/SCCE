// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
import { readFileSync, writeFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import * as boundary from "../boundary-estimator.js";
import { createLanguageInductionEngine } from "../language-induction.js";
import { sourceInductionBatches } from "../source-window-induction.js";
import { createHasher } from "../primitives.js";

describe("boundary fitting repeated-work equivalence", () => {
  it("does not rebuild descent views or fixed calibration logits on every iteration", () => {
    const order = boundary.compileBoundaryStatistics({ populationId: "work", observations: [] }).featureOrder;
    const statistics = (source: string) => boundary.compileBoundaryStatistics({ populationId: "work", sourceDocumentIds: [source],
      observations: Array.from({ length: 20 }, (_, row) => ({ sourceDocumentId: source,
        features: Object.fromEntries(order.map((feature, index) => [feature, ((index + row) % 7) / 7])) as unknown as boundary.BoundaryFeatureVector,
        positiveMass: row + 1, negativeMass: 21 - row, supervision: "independent_anchor" as const,
        signalKind: "external_anchor" as const, signalId: `${source}.${row}` })) });
    const training = statistics("train");
    const heldout = statistics("heldout");
    const views = vi.spyOn(Float64Array.prototype, "subarray");
    const maps = heldout.rows.map(row => vi.spyOn(row.featuresFixed, "map"));
    try {
      const model = boundary.fitBoundaryEstimator({ statistics: training, calibrationStatistics: heldout, calibrationShards: [heldout] });
      expect(views).not.toHaveBeenCalled();
      expect(maps.reduce((total, map) => total + map.mock.calls.length, 0)).toBe(heldout.rows.length * 3);
      const mutable = { ...model, featureOrder: [...model.featureOrder] };
      const features = Object.fromEntries(order.map(feature => [feature, 0.5])) as unknown as boundary.BoundaryFeatureVector;
      expect(Number.isFinite(boundary.scoreBoundary(mutable, features))).toBe(true);
      mutable.featureOrder[0] = "forged";
      expect(() => boundary.scoreBoundary(mutable, features)).toThrow("incompatible");
    } finally { views.mockRestore(); for (const map of maps) map.mockRestore(); }
  });

  it("keeps the batched likelihood identical to public per-row calibrated scoring", () => {
    const order = boundary.compileBoundaryStatistics({ populationId: "likelihood", observations: [] }).featureOrder;
    const statistics = boundary.compileBoundaryStatistics({ populationId: "likelihood", sourceDocumentIds: ["observed"], observations: [0, 1, 2].map(row => ({
      sourceDocumentId: "observed", features: Object.fromEntries(order.map((feature, index) => [feature, ((index + row) % 3) / 3])) as unknown as boundary.BoundaryFeatureVector,
      positiveMass: row + 1, negativeMass: 4 - row, supervision: "independent_anchor" as const, signalKind: "external_anchor" as const, signalId: `observed.${row}` })) });
    const model = boundary.fitBoundaryEstimator({ statistics });
    let loss = 0;
    let mass = 0;
    for (const row of statistics.rows) {
      const features = Object.fromEntries(order.map((feature, index) => [feature, row.featuresFixed[index]! / statistics.scale])) as unknown as boundary.BoundaryFeatureVector;
      const predicted = Math.min(1 - 1e-12, Math.max(1e-12, boundary.scoreBoundary(model, features)));
      const positive = row.positiveMass / 1024;
      const negative = row.negativeMass / 1024;
      loss += -positive * Math.log(predicted) - negative * Math.log(1 - predicted);
      mass += positive + negative;
    }
    const quantize = (value: number) => Math.round(value * 1e12) / 1e12;
    expect(boundary.boundaryNegativeLogLikelihood(model, statistics)).toEqual({ negativeLogLikelihood: quantize(loss), mass: quantize(mass), averageLogLoss: quantize(loss / Math.max(1, mass)) });
  });

  it("preserves the actual Alice estimator, heldout calibration and downstream model identities", () => {
    const text = readFileSync(new URL("./fixtures/alice-acquisition-excerpt.txt", import.meta.url), "utf8").replace(/\r\n/gu, "\n");
    expect(text.length).toBe(19_000);
    const hasher = createHasher();
    const fit = boundary.fitBoundaryEstimator;
    const fitted: boundary.BoundaryEstimatorModel[] = [];
    let fittingMs = 0;
    const spy = vi.spyOn(boundary, "fitBoundaryEstimator").mockImplementation(input => {
      const start = performance.now();
      const model = fit(input);
      fittingMs += performance.now() - start;
      fitted.push(model);
      return model;
    });
    const start = performance.now();
    try {
      const documents = [{ id: "alice.actual-source.19k", text }];
      const outputs = [...sourceInductionBatches(documents, hasher)].map(batch => {
        const model = createLanguageInductionEngine({ hasher }).induce({ documents: batch.documents });
        return { id: model.id, boundaryEstimator: model.boundaryEstimator, statisticsId: model.boundaryStatistics.id,
          joinProgramId: model.joinProgram.id, relationModelId: model.relationHypothesisModel.id,
          frameIds: model.semanticFrames.map(frame => frame.id), constructionIds: model.graphBoundConstructions.map(construction => construction.id) };
      });
      const elapsedMs = performance.now() - start;
      const result = { inputDigest: hasher.digestHex(text), outputs, fitted };
      const reference = JSON.parse(readFileSync(new URL("./fixtures/boundary-alice-19k-reference.json", import.meta.url), "utf8"));
      expect(result.inputDigest).toBe(reference.inputDigest);
      expect(fitted.length).toBe(reference.fits);
      expect(outputs.length).toBe(reference.outputModels);
      expect(hasher.digestHex(JSON.stringify(result))).toBe(reference.resultDigest);
      writeFileSync(".tmp-boundary-alice-result.json", JSON.stringify(result, null, 2));
      writeFileSync(".tmp-boundary-alice-timing.json", JSON.stringify({ elapsedMs, fittingMs, fits: fitted.length,
        peakRssKiB: process.resourceUsage().maxRSS }, null, 2));
      process.stdout.write(`\nAlice 19k total=${elapsedMs.toFixed(1)}ms boundary-fit=${fittingMs.toFixed(1)}ms fits=${fitted.length}\n`);
      expect(outputs.length).toBeGreaterThan(1);
      expect(fitted.length).toBeGreaterThan(1);
    } finally { spy.mockRestore(); }
  });
});
