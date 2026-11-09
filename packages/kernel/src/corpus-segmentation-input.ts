// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
import type { LanguageInductionDocument } from "./language-induction.js";
import type { VerifiedCorpusSegmentation } from "./corpus-segmentation-cursor.js";
import { readPreparedCorpusSegmentationMeasurement, corpusSegmentationContextSliceDigest, type CompiledBoundaryFeatureContext,
  type SurfaceBoundaryMeasurement } from "./surface-lattice.js";
import { validatePagedSegmentationInference } from "./paged-segmentation-population.js";
import { canonicalDigestHex } from "./canonical-json-digest.js";
import type { Hasher } from "./types.js";

export function validateCorpusSegmentationForDocuments(documents: readonly LanguageInductionDocument[], verified: VerifiedCorpusSegmentation, hasher: Hasher): {
  measurements: Map<string, SurfaceBoundaryMeasurement>; featureContext: CompiledBoundaryFeatureContext; inputDigest: string;
} {
  const inference = validatePagedSegmentationInference(verified.populationInference, hasher);
  const slices = new Map(verified.slices.map(slice => [slice.preparation.documentId, slice]));
  if (slices.size !== verified.slices.length || slices.size !== documents.length || !documents.length) throw new Error("corpus segmentation measurement ownership is ambiguous");
  const measurements = new Map<string, SurfaceBoundaryMeasurement>();
  const documentCountBySurfaceFormClass: Record<string, number> = {}; const classCountByBoundaryContext: Record<string, number> = {};
  let first: CompiledBoundaryFeatureContext | undefined;
  for (const doc of documents) {
    if (measurements.has(doc.id)) throw new Error("corpus segmentation document ownership repeats");
    const slice = slices.get(doc.id);
    if (!slice) throw new Error("corpus segmentation measurement is missing");
    const measurement = readPreparedCorpusSegmentationMeasurement(slice.preparation, { documentId: doc.id, text: doc.text,
      sourceVersionId: doc.sourceVersionId, evidenceIds: doc.evidenceIds, hasher });
    const { valueDigest, ...binding } = slice.contextSlice.binding;
    const context = slice.contextSlice.featureContext;
    if (binding.measurementId !== measurement.boundaryMeasurement.id || binding.sourceInventory.id !== inference.sourceInventory.id
      || binding.sourceInventory.count !== inference.sourceInventory.count || binding.snapshotId !== inference.sourceInventory.id
      || binding.contextId !== inference.featureContextId || context.id !== inference.featureContextId
      || binding.normalizationContractId !== inference.normalizationContractId
      || binding.normalizationContractId !== measurement.boundaryMeasurement.normalizationContractId
      || context.schema !== "scce.boundary_feature_context.v1" || context.sourceDocumentCount !== inference.sourceInventory.count
      || valueDigest !== corpusSegmentationContextSliceDigest({ featureContext: context, binding }, hasher)) throw new Error("corpus segmentation snapshot or context slice changed");
    for (const [keys, values, target, maximum] of [
      [slice.preparation.requiredClassIds, context.documentCountBySurfaceFormClass, documentCountBySurfaceFormClass, context.sourceDocumentCount],
      [slice.preparation.requiredContextKeys, context.classCountByBoundaryContext, classCountByBoundaryContext, Number.MAX_SAFE_INTEGER]
    ] as const) {
      if (Object.keys(values).length !== keys.length) throw new Error("corpus context slice has an unexpected key scope");
      for (const key of keys) {
        const value = values[key];
        if (!Object.hasOwn(values, key) || typeof value !== "number" || !Number.isSafeInteger(value) || value < 0 || value > maximum) throw new Error("corpus context slice is missing a verified count");
        if (Object.hasOwn(target, key) && target[key] !== value) throw new Error("corpus context counts contradict one another");
        Object.defineProperty(target, key, { value, enumerable: true, configurable: true, writable: true });
      }
    }
    first ??= context; measurements.set(doc.id, measurement);
  }
  return { measurements, featureContext: { ...first!, documentCountBySurfaceFormClass, classCountByBoundaryContext },
    inputDigest: canonicalDigestHex({ populationInferenceId: inference.id, contextId: inference.featureContextId,
      slices: documents.map(doc => { const slice = slices.get(doc.id)!; return { documentId: doc.id, measurementId: slice.preparation.id, valueDigest: slice.contextSlice.binding.valueDigest }; }) }, hasher) };
}
