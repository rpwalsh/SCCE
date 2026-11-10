// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
import { afterEach, expect, it, vi } from "vitest";
import * as boundary from "../boundary-estimator.js";
import * as populations from "../segmentation-population.js";
import * as induction from "../language-induction.js";
import { prepareCorpusSegmentationMeasurement, corpusSegmentationContextSliceDigest } from "../surface-lattice.js";
import { compileSourceInductionWindowsFromCorpus, sourceInductionBatches } from "../source-window-induction.js";
import { prepareConstructionInductionFromCorpus, preparedLanguageInductionProducts } from "../graph-surface-alignment.js";
import { rawCorpusSegmentationFixture } from "./fixtures/raw-corpus-segmentation.js";
import type { InducedLanguageMemoryModel } from "../language-induction-memory.js";

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); });

it("measures unseen raw source with corpus context and routes it without refitting or a population-zero default", async () => {
  const { hasher, model, loader } = await rawCorpusSegmentationFixture();
  const document = { id: "source.unseen", text: "oma neri. \u732b e\u0301 \ud83d\udc69\u200d\ud83d\udd2c. oma vela." };
  const preparation = prepareCorpusSegmentationMeasurement({ documentId: document.id, text: document.text, hasher });
  const verified = await loader.resolve([preparation]);
  const fit = vi.spyOn(boundary, "fitBoundaryEstimator"); const learn = vi.spyOn(populations, "learnSegmentationPopulations");
  const own = vi.spyOn(populations, "boundaryMixtureForStatistics"); const assigned = vi.spyOn(populations, "boundaryMixtureForDocument");
  const result = induction.createLanguageInductionEngine({ hasher }).induce({ documents: [document], verifiedCorpusSegmentation: verified });
  expect(fit).not.toHaveBeenCalled(); expect(learn).not.toHaveBeenCalled(); expect(assigned).not.toHaveBeenCalled();
  expect(own).toHaveBeenCalledTimes(2);
  expect(result.segmentationPopulations.id).toBe(model.id);
  expect(result.boundaryStatistics.sourceDocumentIds).toEqual([document.id]);
  expect(result.segmentationDocuments.map(value => value.documentId)).toEqual([document.id]);
  expect(result.segmentationDocuments[0]!.graph.arcs.length).toBeGreaterThan(0);
  expect(result.symbolCount).toBeGreaterThan(0);
  expect(result.audit).toHaveProperty("corpusSegmentationSnapshotId", model.sourceInventory.id);
});

it("loads only one complete Unicode window batch at a time and scopes every cached product to its snapshot", async () => {
  const { hasher, loader } = await rawCorpusSegmentationFixture();
  vi.stubEnv("SCCE_INDUCTION_CHAR_BUDGET", "96"); vi.stubEnv("SCCE_INDUCTION_DOC_CHAR_CAP", "48");
  const documents = [{ id: "source.long", text: "oma vela. \u732b e\u0301 \ud83d\udc69\u200d\ud83d\udd2c. ".repeat(12) }];
  const batches = [...sourceInductionBatches(documents, hasher)];
  const sizes = new Map(batches.flatMap(batch => batch.documents).map(document => [document.id, document.text.length]));
  let loaded = 0;
  const bounded = { ...loader, async resolve(preparations: Parameters<typeof loader.resolve>[0]) {
    loaded++; expect(preparations.reduce((total, item) => total + sizes.get(item.documentId)!, 0)).toBeLessThanOrEqual(96);
    return loader.resolve(preparations);
  } };
  const modelCache = new Map<string, InducedLanguageMemoryModel>();
  const first = await compileSourceInductionWindowsFromCorpus({ documents, hasher, corpusLoader: bounded, modelCache });
  expect(loaded).toBe(batches.length);
  expect(first.coverage.coveredUtf16Length).toBe(documents[0]!.text.length);
  const create = vi.spyOn(induction, "createLanguageInductionEngine");
  const second = await compileSourceInductionWindowsFromCorpus({ documents, hasher, corpusLoader: bounded, modelCache });
  expect(create).not.toHaveBeenCalled(); expect(second).toEqual(first);
  const prepared = await prepareConstructionInductionFromCorpus({ documents, hasher, corpusLoader: loader });
  const values = preparedLanguageInductionProducts({ documents, hasher, prepared });
  expect(values.models).toEqual(first.models);
  const replay = await prepareConstructionInductionFromCorpus({ documents, hasher, corpusLoader: loader, prepared });
  expect(replay).toBe(prepared);
  await expect(prepareConstructionInductionFromCorpus({ documents: [{ ...documents[0]!, text: `${documents[0]!.text} changed` }], hasher, corpusLoader: loader, prepared }))
    .rejects.toThrow("inputs changed");
});

it("refuses stale, reconstructed, or incomplete measurement/context bindings", async () => {
  const { hasher, loader } = await rawCorpusSegmentationFixture();
  const document = { id: "source.unseen", text: "oma vela. \u732b e\u0301." };
  const preparation = prepareCorpusSegmentationMeasurement({ documentId: document.id, text: document.text, hasher });
  const engine = induction.createLanguageInductionEngine({ hasher });
  const verified = await loader.resolve([preparation]);
  expect(() => engine.induce({ documents: [{ ...document, text: `${document.text} changed` }], verifiedCorpusSegmentation: verified })).toThrow("inputs changed");
  expect(() => engine.induce({ documents: [document], verifiedCorpusSegmentation: { ...verified, slices: [{ ...verified.slices[0]!, preparation: { ...preparation } }] } })).toThrow("inputs changed");
  const missing = await loader.resolve([preparation]);
  const slice = missing.slices[0]!.contextSlice;
  delete slice.featureContext.documentCountBySurfaceFormClass[preparation.requiredClassIds[0]!];
  const { valueDigest: _old, ...binding } = slice.binding;
  slice.binding.valueDigest = corpusSegmentationContextSliceDigest({ featureContext: slice.featureContext, binding }, hasher);
  expect(() => engine.induce({ documents: [document], verifiedCorpusSegmentation: missing })).toThrow("key scope");
});
